# @ekg/mcp-server

MCP gateway for the AEC Engineering Knowledge Graph. One server grounds
Claude, ChatGPT, and Microsoft 365 Copilot in your firm's engineering
knowledge, with provenance on every result.

Two transports, one tool surface. **stdio** (the default) is the single-user
local path with a fixed dev caller — install, connect an MCP client, evaluate
the tools. **Streamable HTTP** is the remote, multi-user gateway (PRD P0-3):
every request carries a bearer token, so ACL trimming and tenant isolation
(P0-7) follow the actual caller, and every tool call is audited. Identity is a
dev-secret JWT today; OAuth 2.1 + Entra federation is the one remaining step
and swaps only the token verifier — the tools and the rest of the stack stay.

## Install

From a packaged tarball (built with `npm run pack:mcp-server` at the repo
root, output in `release/`):

```sh
npm install -g ekg-mcp-server-0.1.0.tgz
ekg-mcp            # starts the gateway on stdio
```

Or point an MCP client at it directly, e.g. Claude Code:

```sh
claude mcp add ekg -- ekg-mcp
```

## Remote gateway (Streamable HTTP)

Set `EKG_TRANSPORT=http` to serve the gateway over Streamable HTTP at
`POST /mcp`, with an unauthenticated `GET /healthz` liveness probe:

```sh
EKG_TRANSPORT=http \
EKG_JWT_SECRET=<dev-secret> \
EKG_PORT=8787 \
EKG_DB_PATH=$PWD/apps/web/.data/ekg.db \
EKG_AUDIT_LOG=$PWD/audit.jsonl \
  node apps/mcp-server/dist/index.js
```

Every request must present a bearer **JWT** (HS256, signed with
`EKG_JWT_SECRET`) whose claims become the calling identity:

```jsonc
{ "tid": "<tenantId>", "sub": "user:priya", "groups": ["group:engineering"] }
```

The gateway verifies the token, resolves the caller to
`{ tenantId: tid, principals: [sub, ...groups] }`, and trims every result to
what that caller may read — two different tokens hit the same server and see
different knowledge. Missing or invalid tokens get a `401`. This JWT is the
stand-in for the eventual Entra-federated OAuth token: same claim shape, so
that work replaces only the verifier.

`EKG_AUDIT_LOG` points at an append-only JSONL audit trail (PRD P0-7) — one
event per tool call recording who asked (tenant + principal), through which
transport, with which arguments, and which item ids came back. Without it,
events go to stderr so they are never silently dropped.

## Tools

| Tool | Purpose |
|---|---|
| `search` | Search the knowledge graph; results carry provenance, deep links, and warnings on superseded items. Explicit `no_results` state — the model is told never to substitute general knowledge for firm precedent. |
| `fetch` | Full record for an entity, including related entities. |
| `traverse` | Follow typed relationships (`used-in`, `supersedes`, `authored-by`, …) from any entity. |
| `find_experts` | Find the firm's people who hold knowledge on a topic, each with the authored details/specs/lessons that ground the expertise. Explicit `no_results` state — never names someone the graph doesn't support. |
| `get_project_context` | One-call briefing for a project (by id or name): details/documents used, applicable specs, issues and lessons learned, standards complied with, the team, and the client — every item with provenance and a deep link. |
| `ingest_document` | Add a document (`.pdf`, `.md`, `.txt`) as an **unverified** candidate — same pipeline as the ingestion CLI (classification, PDF text-layer extraction, ADR 0004 honesty statuses). Drawing sheets come back with rendered images so the *calling* model can describe them. |
| `save_description` | Store the calling model's sheet description. Quoted annotations are mechanically grounded against the document text layer; ungrounded ones are flagged for curator review (ADR 0005). |

## Ingest from your assistant — your AI subscription does the reading

Users add documents from inside Claude (or any MCP client): *"Add
`P-204 Pump Room Piping.pdf` to our knowledge base."* The gateway queues the
candidate and returns rendered sheet images; the **user's own model** —
running on their existing AI subscription — describes what is drafted and
calls `save_description`. The gateway needs no LLM API key of its own; it
verifies every quoted annotation against the extracted text layer and flags
anything ungrounded. Everything lands `unverified` in the workspace app's
curation queue.

Sheet rendering requires poppler (`brew install poppler` /
`apt-get install poppler-utils`) on the gateway host; without it, documents
still ingest — images are skipped with an explicit note.

## Demo

Ask your connected assistant: *"How have we detailed curtain-wall firestop
conditions, and what went wrong at Riverside?"* The seeded graph returns the
current detail (rev. 2), flags the superseded rev. 1 with a warning, and
links the lesson learned from the failed mockup — citing sheet A-501.
