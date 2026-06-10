# ADR 0001: Initial tech stack and repo shape

Date: 2026-06-09 · Status: Accepted

## Context

Phase 1 of the [PRD](../../PRD-engineering-knowledge-graph.md) needs a graph
core, ingestion, and the workspace app foundation, with the MCP gateway
following immediately (Phase 2). Two PRD open questions intentionally remain
unsettled: the graph storage engine (OQ 1) and the PDF parsing stack (OQ 8).
The scaffold must let work proceed without prejudging them.

## Decision

- **TypeScript monorepo with npm workspaces** (no extra build orchestrator
  yet). The MCP SDK is TypeScript-first, the web app will be React/Next.js,
  and one language across gateway + app + domain model keeps the ontology
  types shared (`@ekg/core`).
- **`GraphStore` interface + in-memory implementation.** All Phase 1 code
  targets the interface; the engine choice (native graph DB vs relational +
  graph layer) is deferred to the OQ 1 spike. ACL/tenant trimming semantics
  are part of the interface contract, not the engine.
- **MCP server starts on stdio with a fixed dev caller.** The tool surface
  (`search`/`fetch`/`traverse`, ChatGPT-connector-compatible shapes, P0-8
  warning/no-results semantics) is the durable contract; transport upgrades
  to Streamable HTTP + OAuth 2.1 in Phase 2 without changing tools.
- **Ingestion service is a placeholder, likely Python**, because the PDF/OCR
  ecosystem (layout models, OCR engines) is strongest there; final shape
  gated on the OQ 8 parser spike.
- **String-union ontology types with an open escape hatch** rather than
  enums, so tenant-defined entity/relationship types (P0-1) need no code
  changes.

## Consequences

- `npm run build` / `npm test` work from a fresh clone with no global tools.
- Swapping the graph engine later touches one package; gateway and app code
  are insulated.
- The demo seed doubles as gateway smoke-test fixtures and a living example
  of the ontology (including a superseded detail and an ACL-restricted
  document, so P0-7/P0-8 behavior is exercised from day one).
- Revisit npm-workspaces-only if build orchestration gets slow (Turborepo is
  a drop-in at that point).
