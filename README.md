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
| `packages/core` | Ontology, `GraphStore` interface, in-memory dev store, demo seed | P0-1 |
| `apps/mcp-server` | MCP gateway — `search` / `fetch` / `traverse` tools (stdio for now; Streamable HTTP + OAuth next) | P0-3…P0-6 |
| `apps/web` | Knowledge workspace app — dashboard, search/browse, entity pages with graph view (`npm run dev --workspace @ekg/web`) | P0-9 |
| `services/ingestion` | Document ingestion & PDF parsing pipeline (placeholder) | P0-2, P0-2a |
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

## Status

Phase 1 scaffold (see PRD Timeline Considerations). The graph store is an
in-memory implementation behind the `GraphStore` interface while the engine
spike (PRD Open Question 1) is open; the MCP server runs on stdio with a
fixed dev identity until the remote OAuth deployment lands in Phase 2.
