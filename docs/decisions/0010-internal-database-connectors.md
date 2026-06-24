# ADR 0010: Read-only internal database connectors

Date: 2026-06-23 · Status: Proposed

## Context

Much of a firm's institutional knowledge is not in files — it is in
line-of-business **databases**: PM systems, RFI / change-order logs, an ERP,
a lessons-learned table, a spec registry, an expertise/HR directory. The PRD
already plans structured sources (P0-2 SharePoint, P1-2 Procore/ACC) and the
non-goal is settled: *"we index and link… source systems remain
authoritative"* — we never become the system of record. This ADR adds
internal SQL databases as a **read-only** source, the structured-data sibling
of the document connectors.

Two distinct architectures are possible, and they are not the same product
decision:

- **Ingest-time** — scheduled `SELECT`s map rows → `unverified` candidate
  entities/relationships that flow through the existing curation queue.
- **Query-time** — a live read-only MCP tool runs vetted queries at retrieval
  time for volatile data (current status, open RFIs today).

This must not be confused with the OQ-1 production-graph-engine question
(swapping the graph's *own* backing store). These connectors target *other*
firms' databases as sources, behind the `GraphStore` interface, untouched by
the engine choice.

A hard constraint from the project's stance: the gateway and `@ekg/core` stay
dependency-light (`node:sqlite`, `node:crypto`, no native modules). The user
also requires that **no single SQL engine be baked in** — the connector must
be engine-agnostic.

## Decisions

- **Ship Pattern A (ingest-time) first; defer Pattern B (query-time) to a
  follow-on.** Pattern A rides rails we already proved: it emits the same
  `Candidate { entity, chunks, references }` (`services/ingestion/src/candidate.ts`),
  lands as `reviewStatus: 'unverified'`, flows through the curation workbench,
  and is served by the gateway's existing `search`/`fetch`/`traverse` with
  **no gateway change** and **no new trust model**. The MCP surface stays
  read-only (PRD P2-4). Pattern B adds live per-row permission enforcement and
  an injection surface with no curation gate to catch mistakes — worth it only
  for genuinely volatile data, and scoped in its own ADR when needed.

- **Engine-agnostic via a thin `SqlAdapter` interface; drivers are pluggable
  and lazily loaded.** The connector core speaks only this contract; a registry
  maps an engine name → adapter and `import()`s the driver **only when that
  engine is configured**, so no driver is a hard dependency and the gateway
  pulls in none of them.

  ```ts
  export interface SqlAdapter {
    readonly engine: string;                 // 'sqlite' | 'postgres' | 'mssql' | …
    connect(dsn: string): Promise<SqlConnection>;   // READ-ONLY session
  }
  export interface SqlConnection {
    // Parameterized SELECT only — implementations MUST reject non-SELECT.
    query(sql: string, params?: Record<string, unknown>): Promise<SqlRow[]>;
    close(): Promise<void>;
  }
  export type SqlRow = Record<string, unknown>;
  ```

  Pure-JS drivers (`pg`, `mysql2`, `tedious`/`mssql`) become optional
  peer-style adapters; an Oracle (`oracledb`, native) adapter can live in a
  separate opt-in package without touching the core. The **reference adapter
  is `node:sqlite`** — already a dependency — so a working, zero-new-dep
  read-only SQLite source proves the whole pipeline end to end, exactly as the
  own-code rasterizer (ADR 0009) and the SQLite store kept us dep-free.

- **A declarative mapping config turns rows into the ontology — config, not
  code.** Per query/view: which column is the entity `id` and `type`, which
  become `title`/`summary`/`properties`/`tags`/`aliases`, how to build the
  `provenance.sourceUrl` deep link back into the source system, and how
  foreign keys become `Relationship` edges (`used-in`, `authored-by`,
  `had-issue`, `complies-with`). FK→edge is the high-value step: it is what
  makes `find_experts` and `get_project_context` light up from a flat table.
  This is the data a knowledge-manager wizard collects (PRD P0-9 "ingestion
  setup wizard, no IT").

- **Read-only is enforced defense-in-depth, primarily at the database.**
  (1) The connector authenticates with a **`SELECT`-only account on
  whitelisted `vw_ekg_*` views**, ideally against a read replica — the
  authoritative control. (2) The app runs only mapping-config / named queries,
  never arbitrary SQL. (3) Parameterized statements only, with a statement
  timeout and a row cap. (4) `SET TRANSACTION READ ONLY` / read-only session
  flags where the engine supports them. The adapter rejecting non-`SELECT` is
  a backstop, not the primary guard.

- **Permission mapping is mandatory and fails closed.** The GA gate is *"no
  item retrievable by a user lacking source-system access"* (P0-7). A row maps
  its source-system permission (a security-group GUID column) →
  `acl.allowedPrincipals` (Entra object ids). **A source that cannot express
  permissions must not default to `"*"` (tenant-public)** — it is restricted
  to a named group the admin opts into per source.

- **Incremental, non-destructive sync.** A watermark column
  (`rowversion`/`ModifiedAt`) drives change detection (PRD P0-2); re-ingesting
  an unchanged row preserves a curator's `verified` status (the
  `upsertEntity` chunk-preserve contract already reasons this way), while
  changed content re-enters curation as `unverified`.

- **Where the code lands.** A new `services/ingestion/src/sources/` layer with
  `sql/adapter.ts` (the interface + registry), `sql/sqlite.ts` (reference
  adapter), and `database.ts` (`DatabaseSource` → `Candidate[]`). `cli.ts`
  grows a `--source database --config <map.yaml>` path alongside the folder
  walk. Drivers stay in `@ekg/ingestion` (a service) and never reach
  `apps/mcp-server`.

## Consequences

- Structured firm knowledge becomes first-class with **zero gateway changes**:
  a project row and a drawing sheet are the same kind of citable, ACL-trimmed,
  provenance-bearing entity once ingested. FK-derived edges make the graph
  genuinely richer than file ingestion can.
- The gateway and core stay dependency-free; adding Postgres or SQL Server is
  installing one pure-JS adapter package, and the SQLite reference adapter
  ships working out of the box.
- **Honest limits.** (1) Ingested data is a *snapshot* — staleness is bounded
  by sync cadence; truly live data needs Pattern B. (2) Faithful permission
  mapping depends on the source exposing a usable permission column; where it
  cannot, we trade reach for safety (named-group restriction, admin opt-in).
  (3) The reference adapter proves the pipeline but not production scale —
  large tables need batched/keyset reads and a real sync scheduler, deferred
  with the rest of production hardening.
- Pattern B (query-time federation) is intentionally **not** built here. When
  it is, it gets its own ADR: a catalog of admin-defined named queries (the
  model never writes SQL), live per-row permission enforcement (DB row-level
  security keyed on the passed identity, or post-filter against `caller.principals`),
  and a "live source data, not curated firm knowledge" honesty marker distinct
  from `search` (P0-8). The existing `register()` audit wrapper already covers
  it.
- Sits cleanly beside OQ-1: connectors target the `GraphStore` interface, so
  the production engine decision is unaffected.
