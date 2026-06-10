# Engineering Knowledge Graph (EKG)

A knowledge graph platform for AEC firms: firms ingest and curate engineering
knowledge (projects, design details, specs, standards, lessons learned,
experts), and multiple gateways ground the AI assistants they already use —
**ChatGPT, Claude, and Microsoft 365 Copilot** — in that knowledge, with
provenance on every answer.

Full product definition: [PRD](PRD-engineering-knowledge-graph.md).

## Repository layout

| Path | What it is | PRD |
|---|---|---|
| `packages/core` | Ontology, `GraphStore` interface, shared retrieval semantics, in-memory dev store, demo seed | P0-1 |
| `packages/store-sqlite` | Persistent `GraphStore` on SQLite (`node:sqlite`, no native deps) | OQ 1 reference |
| `apps/mcp-server` | MCP gateway — `search` / `fetch` / `traverse` tools (stdio for now; set `EKG_DB_PATH` to serve the curated database) | P0-3…P0-6 |
| `apps/web` | Knowledge workspace app — dashboard, search/browse, entity pages with graph view, curation workbench, capture form (`npm run dev --workspace @ekg/web`) | P0-9 |
| `services/ingestion` | Ingestion CLI v0 — classify files, queue candidates for curation (PDF text extraction pending OQ 8) | P0-2, P0-2a |
| `docs/decisions` | Architecture decision records | — |

## Getting started

```sh
npm install
npm run build
npm test
```

`npm test` runs the core store tests (ACL trimming, tenant isolation,
superseded-item warnings) and an end-to-end MCP smoke test that spawns the
server and exercises the tools over stdio.

## Try it from Claude Code

```sh
claude mcp add ekg -- node apps/mcp-server/dist/index.js
```

Then ask: *"How have we detailed curtain-wall firestop conditions, and what
went wrong at Riverside?"* — answers come from the seeded demo graph with
citations, and the superseded rev. 1 detail comes back with a warning.

## The full loop

```sh
npm run dev --workspace @ekg/web          # app on :3000, seeds .data/ekg.db
npm run ingest --workspace @ekg/ingestion -- services/ingestion/samples \
  --db apps/web/.data/ekg.db              # queue candidates for review
# review at http://localhost:3000/curation → Verify / Reject
EKG_DB_PATH=$PWD/apps/web/.data/ekg.db node apps/mcp-server/dist/index.js
# the gateway now serves exactly what curators approved
```

## Status

Phase 1 functionally complete (see PRD Timeline Considerations): ontology,
persistent store, ingestion v0, curation workbench, capture form, and the
stdio MCP gateway sharing one database with the app. Open before Phase 2
exit: production graph engine (OQ 1), PDF parsing spike (OQ 8), SharePoint
sync, and the remote transport (Streamable HTTP + OAuth) with real
identity — today's dev caller is fixed.
