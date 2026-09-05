# 5 · Administration

This guide is for the IT / Security Admin (Dana) who deploys EKG for a firm:
running the gateway multi-user, wiring identity and permissions, turning on
audit and semantic retrieval, and connecting the assistants the firm licenses.
It assumes you've read [Getting started](01-getting-started.md).

> **Honesty about build status.** This is the Phase 1 / early Phase 2 build. The
> remote gateway, per-request identity, tenant isolation, ACL trimming, the
> audit trail, OCR for scans (when a local engine is installed), and the
> gateway's **OAuth 2.1 resource-server mode** (Entra-federated token
> verification, [ADR 0011](../decisions/0011-gateway-oauth-entra-federation.md))
> are **implemented and tested**. The Entra app registration + real-tenant
> validation, the workspace app's own SSO sign-in, source-system sync
> (SharePoint/Procore), and the production graph engine are **designed but not
> yet built** — they're called out where relevant. Nothing below implies a
> capability that isn't in the code.

## Deployment topology

EKG is two processes over one database:

```
   AI assistants                        People
 (Claude / ChatGPT /                 (browser)
  M365 Copilot)
        │ MCP over HTTP                   │ HTTPS
        ▼                                 ▼
 ┌──────────────┐                  ┌──────────────┐
 │   gateway    │                  │ workspace app│
 │ apps/mcp-srv │                  │   apps/web   │
 └──────┬───────┘                  └──────┬───────┘
        │           EKG_DB_PATH           │
        └──────────────┬──────────────────┘
                       ▼
              curated SQLite graph
              (one file, one truth)
```

Point both at the **same `EKG_DB_PATH`**. The app is where curators verify; the
gateway serves only what they approved. The SQLite store
([`@ekg/store-sqlite`](../../packages/store-sqlite)) sits behind a
`GraphStore` interface — the production graph engine swaps in behind the same
interface without touching the app or gateway (PRD Open Question 1).

## Running the remote gateway

The stdio transport in [Getting started](01-getting-started.md) is single-user.
For a firm, run the **Streamable HTTP** transport, where every request carries
its own identity:

```sh
EKG_TRANSPORT=http \
EKG_JWT_SECRET=<your-dev-secret> \
EKG_DB_PATH=/srv/ekg/ekg.db \
EKG_AUDIT_LOG=/var/log/ekg/audit.jsonl \
EKG_APP_URL=https://ekg.yourfirm.com \
node apps/mcp-server/dist/index.js
```

- Listens on **`http://localhost:8787/mcp`** by default (`EKG_PORT` to change).
- **Identity config is required** for the HTTP transport — either `EKG_JWT_SECRET`
  (dev tokens, shown here) or the OIDC pair `EKG_OIDC_ISSUER` +
  `EKG_OIDC_AUDIENCE` ([production SSO](#production-sso-oauth-21--entra)). The
  server refuses to start with neither.
- **`GET /healthz`** is an unauthenticated liveness probe for load balancers and
  deploy checks; it returns `{ "status": "ok", … }`. Every other path requires a
  valid token.
- Sessions are stateful: a client initializes once and reuses its session id, but
  **the token is re-verified on every request**, so a session never outlives its
  caller's token validity.

Put this behind your own TLS-terminating reverse proxy; the gateway speaks plain
HTTP and expects to be fronted in production.

## Identity, tenants, and permissions

This is the part that decides whether the product can be bought, so it's worth
understanding precisely.

### Per-request identity from a bearer token

Every MCP request to the HTTP gateway must carry `Authorization: Bearer <jwt>`.
The gateway verifies it and derives the **caller** from its claims — a missing or
bad token is a `401`, never an unscoped read (it fails closed).

The token is an HS256 JWT (signed with `EKG_JWT_SECRET`) with this claim shape:

| Claim | Meaning |
|---|---|
| `tid` | **Tenant id** — scopes every read at the data layer. Required. |
| `sub` | The user principal, e.g. `user:priya`. Required. |
| `groups` | Group principals, e.g. `["group:engineering", "group:legal"]`. In production these are Entra group object ids. |
| `exp` | Expiry (seconds since epoch). Expired tokens are rejected. |

From these, the gateway builds the caller as `{ tenantId: tid, principals: [sub,
…groups] }` and uses it for two enforcement layers on **every** tool call:

- **Tenant isolation** — reads are scoped to `tid`. Two tokens for different
  firms hit the same server and see entirely different graphs.
- **ACL trimming** — each item lists the principals allowed to read it (`*` =
  tenant-public). A user only ever sees items whose ACL intersects their
  principals — so they can't retrieve through an assistant what they couldn't open
  at the source. This is enforced identically in the app and in every gateway.

The HTTP smoke test (`apps/mcp-server/scripts/smoke-http.mjs`) proves this
end-to-end: a façade engineer, the firm's outside counsel, and a user from
another firm hit one server with three tokens and get three different,
correctly-trimmed views.

### Minting tokens for development

The production gateway only **verifies** tokens — your identity provider signs
them. For local/dev testing you can mint one yourself. The signing is plain
HS256 with `node:crypto` (no crypto dependency), matching
[`apps/mcp-server/src/auth.ts`](../../apps/mcp-server/src/auth.ts):

```js
// mint-token.mjs — node mint-token.mjs
import { createHmac } from 'node:crypto';

const SECRET = process.env.EKG_JWT_SECRET ?? 'dev-secret';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

const claims = {
  tid: 'demo-firm',
  sub: 'user:priya',
  groups: ['group:engineering'],
  exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
};

const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const payload = b64(JSON.stringify(claims));
const sig = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
console.log(`${header}.${payload}.${sig}`);
```

Then call the gateway with `Authorization: Bearer <output>`. Change `tid`, `sub`,
and `groups` to test tenant isolation and ACL trimming.

### Production SSO (OAuth 2.1 + Entra)

The dev-secret JWT deliberately uses **the same claim shape a federated Entra
token carries**, so production SSO is a verifier swap, and that swap is now
**built** ([ADR 0011](../decisions/0011-gateway-oauth-entra-federation.md),
[`oidc.ts`](../../apps/mcp-server/src/oidc.ts)). Setting both of these switches
the HTTP gateway into **OAuth 2.1 resource-server mode**:

| Variable | Meaning |
|---|---|
| `EKG_OIDC_ISSUER` | The Entra tenant's issuer URL, e.g. `https://login.microsoftonline.com/<tenant-id>/v2.0`. Token `iss` must match it exactly. |
| `EKG_OIDC_AUDIENCE` | The gateway's resource identifier — the Entra app registration's **Application ID URI** (e.g. `api://ekg-gateway`). Token `aud` must carry it. |
| `EKG_OIDC_JWKS_URI` | Optional. Explicit JWKS URL; otherwise discovered from `<issuer>/.well-known/openid-configuration`. |

In this mode the gateway is a resource server only — it **never mints tokens**
(Entra owns `/authorize`, `/token`, consent, and key rotation), and it:

- serves `GET /.well-known/oauth-protected-resource` (RFC 9728) advertising the
  resource identifier and the authorization server, and points every `401` at it
  via `WWW-Authenticate: Bearer resource_metadata="…"` — which is how an
  OAuth-capable client (the claude.ai org connector) discovers where to send
  users with no out-of-band config;
- verifies **RS256** signatures against the issuer's published JWKS —
  discovered, cached, and refetched when a token names an unseen key (rotation),
  throttled by `EKG_OIDC_JWKS_MIN_REFRESH_MS` (default 60s);
- checks `iss`, `aud`, and `exp`/`nbf` (±300 s skew), then maps claims onto the
  dev shape: tenant ← `tid`, caller ← `oid` (the **stable object id** — Entra's
  `sub` is pairwise per app), groups ← the group object ids.
  `resolveCallerFromAuth`, ACL trimming, tenant isolation, and audit are
  byte-for-byte unchanged;
- **ignores `EKG_JWT_SECRET`** — the dev verifier is never live alongside OIDC,
  and a half-set OIDC config (issuer without audience, or vice versa) refuses to
  start rather than silently downgrading to dev auth.

Write item ACLs against the principals production tokens will actually carry
(Entra object ids), or map groups to your own principal names at ingestion.

**Known limit — group-claim overage:** past ~200 groups Entra omits `groups`
and returns a Microsoft Graph pointer instead. Such a user resolves with only
their own id: they see their items and tenant-public (`*`) ones. Fails
*closed*, not open.

**What remains is deployment, not code:** one Entra **app registration** for
the gateway-as-API — expose a scope (e.g. `mcp.invoke`), set the Application ID
URI (= `EKG_OIDC_AUDIENCE`), and configure the **groups claim** — then a
real-tenant end-to-end run. The verifier itself is proven against a spec-shaped
mock IdP in [`oauth.test.mjs`](../../apps/mcp-server/scripts/oauth.test.mjs):
metadata + challenge discovery, JWKS discovery and key rotation, `oid` mapping
into the audit trail, and nine rejection shapes (wrong audience/issuer,
expiry, `alg:none`, HS256-in-OIDC-mode, unknown or mismatched keys).

## Audit logging

Every gateway tool call emits exactly one audit event, wired at the handler
boundary so no tool can be added without being audited — and every **workspace
app mutation** (verify, reject, restore, edit, ACL change, lifecycle change,
merge, relationship change, capture, upload, settings) emits an event with the
same schema, so one trail covers every surface that can read or change firm
knowledge (PRD P0-7). Set a destination:

```sh
EKG_AUDIT_LOG=/var/log/ekg/audit.jsonl
```

Without it, the gateway defaults to **`audit.jsonl` next to the database** when
`EKG_DB_PATH` is set (so the stdio trail is never silently lost); with no
database configured either, events go to **stderr** (so your host log pipeline
still captures them — they're never silently dropped). An explicit
`EKG_AUDIT_LOG` always wins. Each event is one JSON line:

| Field | Meaning |
|---|---|
| `ts` | ISO 8601 timestamp. |
| `tenantId` | Tenant the caller belongs to. |
| `principal` | The calling user (the token subject). |
| `tool` | Tool invoked, e.g. `search`. |
| `transport` | `http` or `stdio` (gateway) or `web` (workspace-app mutation). |
| `args` | Redacted argument summary (long strings clipped) — enough to know what was asked. |
| `resultIds` | Ids of the entities surfaced to the caller. |
| `outcome` | `ok`, `no_results`, or `error`. |
| `snapshot` | Destructive app actions (reject, merge) carry the removed entity, so a curator mistake is recoverable from the trail. |

This is what satisfies client-confidentiality and insurance audits ("who asked
what, through which gateway, and what came back"), and it's also the richest
**curation signal** available today — mine it for top queries, zero-result
queries, and most-cited items (see
[Curating & refining](04-curating-knowledge.md#where-to-aim-curation-effort)).
The dev sink appends JSONL; production swaps in a tamper-evident store without
touching the call sites.

## Retrieval and storage

### Storage

`EKG_DB_PATH` selects the SQLite database. The app creates and seeds it on first
run; the gateway serves it read-mostly. Use `:memory:` for an ephemeral seeded
store (tests, demos). The file runs in WAL mode, so the app, gateway, and
ingestion CLI can share it; treat the `-wal` and `-shm` sidecars as part of it.

### Upgrades, backups, and restore

The database carries a **schema version** (`PRAGMA user_version`), and every
build knows the version it needs ([ADR 0012](../decisions/0012-schema-versioning-migrations-restore.md)).
Opening a file with a newer build **upgrades it in place** — after writing a
snapshot next to it (`ekg.db.v<from>-<stamp>.backup`) — and logs one
`ekg-store: upgraded ...` line. Opening a file with an *older* build than the
one that last wrote it is **refused**, with the two remedies in the message
(upgrade the software, or restore that snapshot). The same happens for the
full-text index: when a build changes what it indexes, the index is rebuilt
once on the next open.

`ekg-db` (`npm run db -- <command>` from the repo root, or the `ekg-db` bin of
`@ekg/store-sqlite`) is the operator surface. `--db` defaults to `EKG_DB_PATH`.

```sh
npm run db -- status  --db /srv/ekg/ekg.db          # version, pending steps, ledger, row counts, quick check (read-only)
npm run db -- backup  /srv/backups/ekg-$(date +%F).backup --db /srv/ekg/ekg.db
npm run db -- verify  /srv/backups/ekg-2026-09-04.backup    # full integrity check, any file
npm run db -- migrate --db /srv/ekg/ekg.db          # upgrade now (snapshot first) instead of on the next open
npm run db -- restore /srv/backups/ekg-2026-09-04.backup --db /srv/ekg/ekg.db
```

- **Backups are safe while everything is running.** `backup` takes one
  consistent read snapshot (`VACUUM INTO`), never overwrites an existing file,
  and verifies what it wrote before reporting success. Schedule it, and copy
  the file off the box — that part is still yours.
- **Restore is rehearsed, not copied.** `restore` verifies the backup, refuses
  while the app, gateway, or an ingestion run has the file open (**stop them
  first**), snapshots the live file to `ekg.db.pre-restore-<stamp>.backup` so
  the restore is itself reversible, swaps the backup in, migrates it forward
  if it predates the current schema, and verifies the result. Rehearse it on a
  copy before you need it: `restore` into a scratch `--db` path is exactly the
  production sequence.
- **Want upgrades to be a deliberate step?** Set `EKG_DB_MIGRATE=manual` on
  the app, gateway, and ingestion CLI: an existing file that needs upgrading
  then refuses to open until you run `migrate`. New files are still created.
  `EKG_DB_BACKUP_ON_MIGRATE=0` skips the automatic pre-upgrade snapshot (only
  sensible when you take your own immediately before deploying).

### Semantic retrieval (embeddings)

Out of the box, retrieval is **lexical + SQLite FTS5**. Add an embedding provider
to get **hybrid** retrieval (lexical + full-text + dense vectors), which finds
knowledge by meaning, not just keywords:

```sh
EKG_EMBEDDINGS_PROVIDER=voyage      # voyage | openai | ollama
EKG_EMBEDDINGS_MODEL=voyage-3-large # optional override
VOYAGE_API_KEY=...                  # or OPENAI_API_KEY, or EKG_EMBEDDINGS_API_KEY
```

| Provider | Default model | Auth |
|---|---|---|
| `voyage` | `voyage-3-large` | `VOYAGE_API_KEY` (or `EKG_EMBEDDINGS_API_KEY`) |
| `openai` | `text-embedding-3-small` | `OPENAI_API_KEY` (or `EKG_EMBEDDINGS_API_KEY`) |
| `ollama` | `nomic-embed-text` | local, `OLLAMA_HOST` (default `http://localhost:11434`) |

The adapters are fetch-based with zero dependencies. When you configure a
provider for an existing database, the app **backfills vectors** for rows
ingested before a provider was set, so you don't have to re-ingest. The
**Settings → Retrieval & storage** page shows the active mode and store path so
you can confirm what's running. For a fully on-prem deployment, `ollama` keeps
embeddings local with no third-party API.

## Connecting assistants org-wide

The gateway is **one MCP server for all three assistants** — the tool surface is
shared. `search` and `fetch` are named and shaped to meet the ChatGPT connector
spec; `traverse`, `find_experts`, and `get_project_context` round out the
graph-aware surface.

The gateway authenticates **every** request with a bearer JWT
([identity](#identity-tenants-and-permissions)). So *how* you connect an assistant
depends on what that client can carry — and the two paths are genuinely different
in build status, so they're separated honestly below.

### Works today — clients that send a static `Authorization` header

These accept a token you mint (the [dev-token recipe](#minting-tokens-for-development))
and work against the gateway exactly as built:

- **Claude Code (remote)** — register the deployed gateway over HTTP with the
  bearer header:

  ```sh
  claude mcp add ekg --transport http https://ekg.yourfirm.com/mcp \
    --header "Authorization: Bearer <jwt>"
  ```

  (For local single-user dev, use the stdio binary instead, per
  [Getting started](01-getting-started.md).)
- **Claude API MCP connector** — pass the gateway as an `mcp_servers` entry with
  an `authorization_token`; the API forwards it as the bearer header.
- **ChatGPT custom connector / GPT actions** — point a custom connector at the
  gateway URL and put the bearer token in its auth field; `search`/`fetch`
  satisfy the connector contract.
- **The MCP SDK / any client with a custom header** — same path. This is exactly
  what the [end-to-end sign-off](#end-to-end-sign-off) and the `smoke-http.mjs`
  test exercise.

### Admin-managed claude.ai connector (organization-wide)

claude.ai (Team/Enterprise) lets an **Owner** add a custom connector once, for the
whole organization, which members then connect to individually:

1. **Owner / Primary Owner:** *Organization settings → Connectors → Add →
   Custom → Web*, enter the gateway URL (`https://ekg.yourfirm.com/mcp`) and, under
   **Advanced settings**, the OAuth **Client ID / Client Secret**.
2. **Each member:** open their own **Connectors** settings, find the connector
   (labelled *Custom*), and click **Connect** to authenticate. Claude then sees
   only the tools and data that member is allowed — which, for EKG, the gateway's
   per-token ACL and tenant trimming already enforce.

*(claude.ai UI labels follow Anthropic's Help Center and may change.)*

> **Honest status — server side ready; needs an Entra app registration and a
> real-tenant run.** That flow is **OAuth-based**: claude.ai runs an OAuth
> authorization handshake against the server (the MCP authorization spec —
> `/.well-known/oauth-protected-resource`, authorization-server metadata, and
> either Dynamic Client Registration or the Client ID/Secret you paste). The
> gateway **now speaks its side** when
> [OIDC mode](#production-sso-oauth-21--entra) is configured: it serves the
> protected-resource metadata, points every 401 at it, and verifies
> Entra-issued RS256 tokens. What has **not** happened yet is a run against a
> real Entra tenant and claude.ai's production handshake — the implementation
> is proven against a spec-shaped mock IdP
> ([`oauth.test.mjs`](../../apps/mcp-server/scripts/oauth.test.mjs)). Until
> your deployment has the Entra registration wired, the static-header clients
> above (Claude Code remote, the API connector, ChatGPT) work with dev tokens.

- **Microsoft 365 Copilot** — the intended path is deploying the connection from
  the M365 admin center with Entra SSO, so rollout is configuration, not
  development (PRD user story 12). Like the claude.ai org connector, this rides
  the same Entra registration under
  [identity](#production-sso-oauth-21--entra).

Whichever assistant, the behavior is the same: results carry provenance and a
link into the workspace app (`EKG_APP_URL`), stale items carry a warning, and an
empty graph yields an explicit "no firm answer" rather than a generic guess.

## End-to-end sign-off

Before you point assistants at a deployment, prove the remote gateway is live and
correct against the *running* server, not just in CI. `smoke-http.mjs` spawns its
own in-memory demo server; the **sign-off** script
([`scripts/signoff-remote.mjs`](../../apps/mcp-server/scripts/signoff-remote.mjs))
drives a gateway you've **already deployed**, over the same Streamable HTTP +
bearer path a real client uses.

### Run it

```sh
EKG_SIGNOFF_URL=https://ekg.yourfirm.com \
EKG_JWT_SECRET=<the gateway's secret> \
npm run signoff --workspace @ekg/mcp-server
```

| Variable | Purpose |
|---|---|
| `EKG_SIGNOFF_URL` | Gateway base URL (a trailing `/mcp` is accepted). **Required.** |
| `EKG_JWT_SECRET` | The secret the gateway verifies with — lets the script mint its own caller tokens. Required unless `EKG_SIGNOFF_TOKEN` is set. |
| `EKG_SIGNOFF_TOKEN` | A pre-minted bearer JWT, used instead of minting (single-identity checks only). |
| `EKG_SIGNOFF_TENANT` / `EKG_SIGNOFF_SUB` / `EKG_SIGNOFF_GROUPS` | Primary caller claims. Default `demo-firm` / `user:priya` / `group:engineering`. |
| `EKG_SIGNOFF_QUERY` | Query for the generic search check. Default `firestop`. |
| `EKG_SIGNOFF_DEMO=1` | Also run the seeded-graph ACL/tenant proofs — only on a deployment serving the demo graph, and needs `EKG_JWT_SECRET`. |

### What it asserts

On **any** deployment:

- `GET /healthz` is live and unauthenticated.
- An unauthenticated request **and** a bad token are both rejected `401`
  (fail-closed) before any handler runs.
- A valid token initializes a Streamable HTTP session and the gateway serves the
  P0-3 tool surface (`search` / `fetch` / `traverse` / `find_experts` /
  `get_project_context`).
- `search` returns a well-formed envelope, and any results carry provenance + an
  app URL (P0-8).

With `EKG_SIGNOFF_DEMO=1` (seeded graph) it additionally proves identity drives
retrieval: the engineer is ACL-trimmed from the privileged legal memo, a second
token (counsel) **can** read it, and a cross-tenant token retrieves nothing.

It exits non-zero on any failure (skipped checks are fine) and prints a block you
can paste into your release record:

```
==================================================================
  EKG REMOTE GATEWAY — END-TO-END SIGN-OFF
==================================================================
  URL:        https://ekg.yourfirm.com/mcp
  Principal:  user:priya @ demo-firm
  Checked at: 2026-…Z
  Result:     PASS  (10 passed, 0 failed, 0 skipped)
  Audit:      confirm these calls landed in EKG_AUDIT_LOG / your log
              pipeline, attributed to user:priya with transport=http (P0-7).
==================================================================
```

### Finish the loop by hand

The script proves the transport, identity, and trimming; two things are
operator-side because they live outside the gateway process:

- **Audit landing.** Confirm the calls the script just made appear in your
  `EKG_AUDIT_LOG` (or stderr log pipeline), attributed to the principal with
  `transport=http` — that's the [P0-7 trail](#audit-logging).
- **A real assistant round-trip.** Connect one of the [static-header
  clients](#works-today--clients-that-send-a-static-authorization-header) (Claude
  Code remote is quickest) and ask a grounded question; confirm the answer cites
  the graph with a working app link, and that a superseded item comes back *with
  its warning*.

Record the result — URL, date, who signed off, and the PASS block — wherever you
keep release approvals.

## Configuration reference

Every setting is an environment variable — no config file.

| Variable | Used by | Purpose | Default |
|---|---|---|---|
| `EKG_DB_PATH` | app, gateway, ingestion | Curated SQLite database path. `:memory:` = ephemeral seeded. | app: `apps/web/.data/ekg.db`; gateway: in-memory demo |
| `EKG_DB_MIGRATE` | app, gateway, ingestion | `auto` upgrades an older database on open (after a snapshot); `manual` refuses until `ekg-db migrate` is run. New files are initialized either way. | `auto` |
| `EKG_DB_BACKUP_ON_MIGRATE` | app, gateway, ingestion | `0` skips the `<db>.v<from>-<stamp>.backup` snapshot written before an on-open upgrade. | on |
| `EKG_TRANSPORT` | gateway | `stdio` (single-user) or `http` (remote, multi-user). | `stdio` |
| `EKG_JWT_SECRET` | gateway (http) | HS256 secret for verifying dev bearer tokens. **Required for http unless OIDC mode is configured** (then ignored). | — |
| `EKG_OIDC_ISSUER` | gateway (http) | OAuth resource-server mode: expected token `iss` (the Entra tenant issuer URL). Set together with `EKG_OIDC_AUDIENCE` — half-set refuses to start. | unset (dev-secret mode) |
| `EKG_OIDC_AUDIENCE` | gateway (http) | OAuth resource-server mode: expected token `aud` — the gateway's resource identifier (Entra Application ID URI). | unset |
| `EKG_OIDC_JWKS_URI` | gateway (http) | Optional explicit JWKS URL; default discovers it from `<issuer>/.well-known/openid-configuration`. | discovery |
| `EKG_OIDC_JWKS_MIN_REFRESH_MS` | gateway (http) | Throttle on JWKS refetches triggered by unknown key ids (rotation). | `60000` |
| `EKG_PORT` | gateway (http) | Port for the HTTP transport. | `8787` |
| `EKG_AUDIT_LOG` | app, gateway | Append-only JSONL audit file. Unset with `EKG_DB_PATH` set → gateway defaults to `audit.jsonl` next to the database (the stdio trail is never silently lost); unset with no database → stderr. App writes `.data/audit.jsonl`. Setting it explicitly always overrides. | `audit.jsonl` beside `EKG_DB_PATH`, else stderr |
| `EKG_APP_URL` | gateway | Base URL for citation deep links. | `http://localhost:3000` |
| `EKG_INGEST_ROOT` | gateway | **Required for path ingestion** (alias `EKG_UPLOAD_ROOT`). Confines `ingest_document` to one directory tree; relative paths resolve against it, and paths outside it (including via symlinks or `..`) are refused with `path_not_allowed`. Unset → `ingest_document` fails closed on every transport with `ingest_root_not_configured`. | unset (ingestion disabled) |
| `EKG_SEED_DEMO` | app, gateway | App: `0` keeps a fresh database unseeded. Gateway: `1` seeds a fresh persistent DB (never seeds one implicitly). | app seeds, gateway doesn't |
| `EKG_UPLOAD_DIR` | app | Where `/ingest` uploads are stored. | `.data/uploads` |
| `EKG_TRASH_DIR` | app | Where rejected candidates are kept for restore. | `.data/trash` |
| `EKG_EMBEDDINGS_PROVIDER` | app, gateway, store | `voyage` \| `openai` \| `ollama`. Unset → lexical only. | unset |
| `EKG_EMBEDDINGS_MODEL` | store | Model override for the provider. | per-provider default |
| `VOYAGE_API_KEY` / `OPENAI_API_KEY` / `EKG_EMBEDDINGS_API_KEY` | store | API key for the chosen provider. | — |
| `OLLAMA_HOST` | store | Ollama endpoint for local embeddings. | `http://localhost:11434` |

## Security posture & known gaps

- **Enforced today:** per-request identity, tenant isolation, ACL trimming, an
  append-only audit trail, fail-closed auth on the HTTP transport, and no LLM API
  key on the gateway (client models do the reading).
- **You must provide:** TLS termination / reverse proxy, secret management for
  `EKG_JWT_SECRET` and any embedding API keys, log retention for the audit trail,
  and a schedule plus off-box copy for database backups (`ekg-db backup` is the
  safe primitive; see [Upgrades, backups, and restore](#upgrades-backups-and-restore)).
- **Enforced today (continued):** the gateway's OAuth 2.1 resource-server mode —
  RS256/JWKS verification of Entra-federated tokens with RFC 9728 discovery
  ([production SSO](#production-sso-oauth-21--entra)) — validated against a mock
  IdP; a real Entra tenant run is still pending.
- **Not yet built (roadmap):** the Entra app registration + real-tenant
  end-to-end validation, the workspace app's own SSO sign-in, an OAuth mode for
  the sign-off script, SharePoint/OneDrive/Procore ACL-mapped sync, and the
  production graph engine. Wherever the dev-secret JWT is still the identity
  mechanism, treat `EKG_JWT_SECRET` as a real secret and keep token lifetimes
  short.

---

Back to the **[guides index](README.md)**.
