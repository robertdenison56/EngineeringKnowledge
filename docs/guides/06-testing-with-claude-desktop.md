# 6 · Testing EKG end-to-end with Claude Desktop

This guide walks the **whole product loop from Claude Desktop**: ingest a
drawing from chat, have the model describe it, curate it in the workspace app,
query it back with citations, supersede it, and watch the warning appear — all
against one shared database. It exists so a single tester can exercise every
P0 behavior the PRD promises without writing code.

Claude Desktop talks to the gateway over **stdio** (a local MCP server it
spawns itself), which needs no tokens or TLS — the right transport for
single-user testing. The multi-user HTTP transport is covered at the
[end of this guide](#advanced-multi-user-testing-over-http) and in the
[Administration guide](05-admin-guide.md).

## 1 · Build and start the workspace app

```sh
npm install
npm run build
npm run dev --workspace @ekg/web     # app on http://localhost:3000
```

First run seeds `apps/web/.data/ekg.db` with the demo corpus (set
`EKG_SEED_DEMO=0` to start empty instead). Keep the app running — Claude
Desktop and the app will **share this database**: the store runs SQLite in WAL
mode precisely so the app, the gateway, and the ingestion CLI can read and
write it concurrently.

## 2 · Point Claude Desktop at the gateway

Open Claude Desktop → **Settings → Developer → Edit Config**, which opens
`claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add the `ekg` server (adjust `/path/to/EngineeringKnowledge` and your inbox
folder):

```json
{
  "mcpServers": {
    "ekg": {
      "command": "node",
      "args": ["/path/to/EngineeringKnowledge/apps/mcp-server/dist/index.js"],
      "env": {
        "EKG_DB_PATH": "/path/to/EngineeringKnowledge/apps/web/.data/ekg.db",
        "EKG_APP_URL": "http://localhost:3000",
        "EKG_INGEST_ROOT": "/path/to/your/EKG-Inbox",
        "EKG_AUDIT_LOG": "/path/to/EngineeringKnowledge/apps/web/.data/audit.jsonl"
      }
    }
  }
}
```

Restart Claude Desktop; the tools icon should list **ekg** with `search`,
`fetch`, `traverse`, `find_experts`, `get_project_context`,
`propose_knowledge`, `ingest_document`, and `save_description`.

What each variable does:

| Variable | Why it matters for the test |
|---|---|
| `EKG_DB_PATH` | Shares the app's database, so what you curate at `localhost:3000` is exactly what Claude serves — one graph, one review status, one set of permissions. Omit it for a throwaway in-memory demo graph instead. |
| `EKG_APP_URL` | Makes every citation a clickable deep link into the running app. |
| `EKG_INGEST_ROOT` | **Required for path ingestion** (alias `EKG_UPLOAD_ROOT`). Confines `ingest_document` to one folder: relative paths resolve against this root, and anything outside it is refused — which is itself worth testing. Unset, `ingest_document` fails closed on every transport with `ingest_root_not_configured`. |
| `EKG_AUDIT_LOG` | Writes the P0-7 audit trail where the app writes its own, so gateway calls and app curation land in one JSONL you can inspect. When `EKG_DB_PATH` is set it now **defaults to `audit.jsonl` next to the database** — the stdio trail is never silently lost — but setting it explicitly (as here) still overrides. |

> The same stdio server works from Claude Code —
> `claude mcp add ekg --env EKG_DB_PATH=... -- node apps/mcp-server/dist/index.js` —
> see [Getting started](01-getting-started.md).

> **⚠ Project-level `.mcp.json` shadows this config.** If the repository (or any
> project you open in Claude Code / project sessions) declares an `ekg` server in
> its own `.mcp.json`, that entry **shadows** the Desktop config for the same
> server name — including its `env` block. It must carry the same variables:
> omitting `EKG_INGEST_ROOT` there makes `ingest_document` fail closed with
> `ingest_root_not_configured`, and omitting `EKG_AUDIT_LOG` (without
> `EKG_DB_PATH`) can drop the audit trail to stderr. This bit a real test
> session — if a tour step behaves differently in Claude Code than in Desktop,
> check `.mcp.json` first.

## 3 · The test tour

Run these prompts in order in Claude Desktop. Each one exercises a specific
PRD behavior; the *check* column is what must be true.

| # | Ask Claude | What it exercises | Check |
|---|---|---|---|
| 1 | *"How have we detailed curtain-wall firestop conditions, and what went wrong at Riverside?"* | `search` + provenance (P0-8) | Cited answer from the demo graph; the rev. 1 detail comes back **with a superseded warning**, never clean. |
| 2 | *"Who in the firm knows about curtain wall firestops?"* | `find_experts` | James Okafor, **with the authored items as evidence** — never an unsupported name. |
| 3 | *"Brief me on the Riverside project."* | `get_project_context` | Details, specs, standards, lessons, team — each with a deep link into the app. |
| 4 | *"What's our standard detail for post-tensioned transfer slabs?"* | Honest no-results (P0-8) | Claude may **retry once with fewer/simpler keywords** (the `no_results` guidance tells it to), then says the firm graph has **no answer** — it must not substitute general knowledge as firm precedent. If only a partial concept matches, results come back with a `partial_match` flag and say which concept matched, rather than returning nothing. |
| 5 | First copy the sample into your inbox: `cp "services/ingestion/samples/C-102 Drainage Plan (callouts).pdf" "/path/to/your/EKG-Inbox/C-102 Drainage Plan.pdf"`. Then: *"Add C-102 Drainage Plan.pdf from the inbox to our knowledge base and describe it."* | `ingest_document` + ADR 0005/0007/0009 | Queued `unverified`; sheet images render; Claude's description quotes annotations; `save_description` reports which quotes **grounded** and which are flagged. The bare filename works because relative paths resolve against `EKG_INGEST_ROOT` (an absolute path inside the root works too) — but `EKG-Inbox/C-102 Drainage Plan.pdf` does **not**: the folder name is not part of the relative path, so that resolves to a missing file and returns `not_found`. |
| 6 | *"Save this as a lesson learned: on Riverside we found backer rod one size up from joint width prevents sealant slump. Priya figured this out."* | `propose_knowledge` (P1-5) | Queued `unverified`, linked `used-in` Riverside; Claude relays that a curator must verify it. |
| 7 | Open `localhost:3000/curation` | The curation half (P0-9) | Both candidates from #5–6 are in the queue. Verify the lesson; open the C-102 page, check the description and grounding report, verify it too. |
| 8 | Back in Claude: *"What do we know about sealant slump at wide joints?"* | The loop closes | The lesson you just verified comes back, cited, with the app deep link. |
| 9 | In Claude: *"Save this as a design detail: Curtain wall to slab edge firestop detail (rev. 3)."* Verify it at `localhost:3000/curation`. Then in the app open the **rev. 2** firestop detail → **Lifecycle** → **Superseded by…** → pick rev. 3. Back in the **same** chat session, ask #1 again. | Lifecycle + warnings (P0-1, P0-8) via `propose_knowledge` | Rev. 2 now comes back **with a superseded warning pointing at rev. 3**, in the same session, with no restart. (The seed's rev. 1 is already superseded, and the supersede picker only offers verified same-type entities — hence proposing and verifying rev. 3 first.) |
| 10 | *"Add /etc/hosts to our knowledge base."* | `EKG_INGEST_ROOT` confinement | Refused with `path_not_allowed` — the path is outside the ingest root (symlinks and `..` traversal are caught the same way); the gateway is not a general file reader. A file that simply doesn't exist under the root returns `not_found` (with a hint that relative paths resolve against the ingest root), and a disallowed file type returns `unsupported_extension`. |

Then check the trail: `apps/web/.data/audit.jsonl` should contain every
gateway call (transport `stdio`) **and** every curation action you took in the
app (transport `web`), each with tenant, principal, tool, and the items
touched.

## 4 · Resetting between test runs

- **Fresh demo graph**: stop the app, delete `apps/web/.data/` (database,
  uploads, trash, audit), start the app again — it reseeds.
- **Empty graph**: same, but start the app with `EKG_SEED_DEMO=0`.
- The gateway never seeds a persistent database on its own — pointing it at an
  empty file leaves it empty unless you set `EKG_SEED_DEMO=1`.

## Advanced: multi-user testing over HTTP

Everything above is single-user by design. To test **per-user ACL trimming and
tenant isolation** — two callers, one server, different answers — run the
remote transport:

```sh
EKG_TRANSPORT=http EKG_JWT_SECRET=dev-secret \
EKG_DB_PATH=$PWD/apps/web/.data/ekg.db node apps/mcp-server/dist/index.js
```

Mint tokens for different users/tenants with the snippet in the
[Administration guide](05-admin-guide.md#minting-tokens-for-development) and
drive the server with any Streamable-HTTP MCP client (e.g. MCP Inspector, or
the project's own `apps/mcp-server/scripts/smoke-http.mjs` as a reference
client). Claude Desktop's remote **custom connectors** require OAuth on the
server side — the gateway now has that
([OAuth resource-server mode](05-admin-guide.md#production-sso-oauth-21--entra)),
but it needs an Entra tenant behind it, so single-user testing stays on stdio
and token-bearing clients cover the multi-user HTTP path.

---

*Previous: [Administration](05-admin-guide.md) · Up: [Guides](README.md)*
