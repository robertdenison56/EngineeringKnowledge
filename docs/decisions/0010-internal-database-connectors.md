# ADR 0010: Read-only internal database connectors

Date: 2026-06-23 · Status: Proposed

## Context

A lot of firm knowledge lives in databases — PM systems, RFI logs, an ERP, a
lessons-learned table — not just files. We already ingest documents; this adds
internal SQL databases as another **read-only source**. We index and link the
data; the source database stays the system of record.

(Not to be confused with OQ-1, the graph's *own* backing store. These are
*other* databases we read from, behind the `GraphStore` interface.)

## Decisions

- **Treat a database like the file ingester treats a folder.** Rows become
  `unverified` candidate entities, go through the curation queue, and are
  served by the existing gateway tools. Reuses the `Candidate` shape and the
  curation flow — **no gateway changes**.

- **One small adapter interface, so any SQL engine plugs in.** The connector
  speaks only `SqlAdapter` (`connect` → a read-only `query`); a driver loads
  only when its engine is configured, so none is a hard dependency. The first
  adapter is built-in `node:sqlite` — a working connector with **no new
  dependency**. Postgres / SQL Server are pure-JS add-ons later; Oracle (native)
  is an opt-in package.

- **A config maps columns to the ontology — config, not code.** Which column
  is the `id` / `type` / `title`, which become properties and tags, how to
  build the source deep link, and which foreign keys become relationships
  (`used-in`, `authored-by`, `had-issue`).

- **Read-only and permission-safe.** Connect with a SELECT-only account on
  whitelisted views (ideally a read replica) and run only configured queries.
  Map each row's source permissions onto its ACL — and if a source can't
  express permissions, lock it to a named group rather than making it public
  (holds the P0-7 access gate).

- **Live querying is out of scope here.** A query-time tool (for volatile data
  like "open RFIs today") is a later, separate ADR.

## Consequences

- Database rows become citable, permission-trimmed graph entities, and
  foreign-key edges make `find_experts` / `get_project_context` work from
  structured data — not just files.
- Core and gateway stay dependency-free; the SQLite adapter works out of the box.
- Honest limits: ingested data is a snapshot (staleness bounded by sync
  cadence); permission mapping is only as good as the source's permission
  column; the reference adapter proves the pipeline, not production scale.
