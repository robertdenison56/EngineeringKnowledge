# ADR 0002: Dev persistence, curation model, and ingestion v0

Date: 2026-06-09 · Status: Accepted

## Context

Finishing PRD Phase 1 requires knowledge to survive restarts, a curation
workbench (P0-9), and an ingestion path that feeds it (P0-2) — without
prematurely closing Open Question 1 (graph engine) or Open Question 8
(PDF parsing stack).

## Decisions

- **SQLite (`node:sqlite`) as the dev-grade persistent store** in
  `@ekg/store-sqlite`, behind the unchanged `GraphStore` interface. Zero
  native dependencies (Node ≥ 22 built-in driver). Retrieval semantics live
  in `@ekg/core` shared helpers (`canRead`, `scoreEntityMatch`,
  `warningFor`) so in-memory and SQLite behave identically — the P0-7/P0-8
  contract is code, not convention. This doubles as a working reference for
  the "relational + graph layer" candidate in OQ 1; the production engine
  decision stays open. Candidate filtering runs in process — fine at dev
  scale, not a production retrieval design.
- **Curation model: the queue is `reviewStatus === 'unverified'`.** Capture
  forms and ingestion always create unverified items; only an explicit
  curator Verify promotes them; Reject deletes the entity and cascades its
  relationships (`GraphStore.deleteEntity`). Merge is deferred until
  auto-extraction produces near-duplicates worth merging.
- **Mutations via Next.js server actions**, not a REST API yet. The REST
  retrieval API (PRD solution component 3) arrives with the remote gateway
  work in Phase 2, where authentication exists to protect it.
- **Ingestion v0 is a local-folder CLI** (`@ekg/ingestion`): classify by
  filename (MasterFormat section → spec-section with anchor, sheet numbers
  → document with sheet anchor, RFI/lesson keywords), summarize text
  formats, and record PDFs as classified-but-unparsed with an explicit
  "parsing pending OQ 8" note — honest over garbage. SharePoint OAuth sync
  replaces the folder walk without changing the candidate model.
- **Default web-app database**: `apps/web/.data/ekg.db` (gitignored),
  seeded on first run; `EKG_DB_PATH` overrides, `:memory:` for ephemeral.
  The MCP server accepts the same `EKG_DB_PATH` so the gateway can serve
  exactly what curators approved.

## Consequences

- Curated and ingested knowledge persists across restarts and is shared
  between the app and the gateway via one SQLite file.
- Swapping in the production engine remains a one-package change; the
  contract tests in `store-sqlite` are the template for certifying it.
- The ingestion CLI must be pointed at the web app's database
  (`--db apps/web/.data/ekg.db` from the repo root) — acceptable friction
  for v0, removed when ingestion becomes a service.
