# Engineering Knowledge Graph (EKG)

A knowledge graph platform for AEC firms: firms ingest and curate engineering
knowledge (projects, design details, specs, standards, lessons learned,
experts), and multiple gateways ground the AI assistants they already use —
**ChatGPT, Claude, and Microsoft 365 Copilot** — in that knowledge, with
provenance on every answer.

Full product definition: [PRD](PRD-engineering-knowledge-graph.md).
How to set up, use, add to, and refine it: [Guides](docs/guides/) (start with
[Getting started](docs/guides/01-getting-started.md)).

## Repository layout

| Path | What it is | PRD |
|---|---|---|
| `packages/core` | Ontology (entities, relationships, document chunks), `GraphStore` interface, shared retrieval semantics, in-memory dev store, demo seed | P0-1 |
| `packages/store-sqlite` | Persistent `GraphStore` on SQLite (`node:sqlite`, no native deps) — entity + chunk-level FTS and embeddings, hybrid retrieval (ADR 0003, 0006) | OQ 1 reference |
| `apps/mcp-server` | MCP gateway — `search` / `fetch` / `traverse` / `find_experts` / `get_project_context` plus `ingest_document` / `save_description`: users add documents from their assistant, and *their* model describes drawing sheets. Runs on stdio (single-user dev) or remote **Streamable HTTP** with per-request JWT identity, per-caller ACL/tenant trimming, and an audit trail (P0-7); set `EKG_DB_PATH` to serve the curated database | P0-2, P0-3…P0-6 |
| `apps/web` | Knowledge workspace app — dashboard, search/browse, entity pages with graph view, curation workbench, capture form (`npm run dev --workspace @ekg/web`) | P0-9 |
| `services/ingestion` | Ingestion CLI v0 — classify files, extract PDF text layers (scans flagged `needs-ocr`), CAD-native vector parsing of drawing sheets (title blocks, views, dimensions, schedules, callouts → cross-sheet `references` edges), queue candidates for curation | P0-2, P0-2a |
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

Users can also ingest **from their assistant** (ADR 0005): ask Claude to
"add this drawing to our knowledge base" — the gateway's `ingest_document`
tool queues it and returns rendered sheet images, the user's own model (on
their existing AI subscription — the gateway has no LLM API key) describes
what is drafted, and `save_description` stores it with every quoted
annotation mechanically grounded against the document text layer. Sheet
rendering is own code (ADR 0009) — no external binary; poppler is only an
optional fallback for scanned/image-only pages.

## Status

Phase 1 functionally complete (see PRD Timeline Considerations): ontology,
persistent store, ingestion v0 with PDF text extraction (ADR 0004 resolves
OQ 8: pdf.js text layers, scans flagged `needs-ocr`), curation workbench,
capture form, and the stdio MCP gateway sharing one database with the app.
Vector drawing sheets get CAD-native parsing (docs/plans/2026-06-10,
Phases A+B shipped): geometry-derived title blocks and reading order,
views/dimensions/match lines/schedules with per-claim evidence, and
callout bubbles resolved into `references` edges — a drawing set becomes
a navigable graph, from both the CLI and the gateway's `ingest_document`.
Long documents are split into per-page/per-section **chunks** (ADR 0006):
the whole document is searchable and embeddable, and every hit cites the
page or spec section, not just the file — a 494-page spec book that was
searchable through ~page 12 now indexes all 490 passages. When the gateway
hands a drawing to a vision model to describe (ADR 0005), it now **fuses**
the deterministic vector facts (sheet number, views, dimensions, callouts,
layers) into the prompt as ground truth (ADR 0007) so the model narrates on
top of facts instead of misreading identifiers from pixels, and **grounds**
the model's annotations against both the text layer and those facts (ADR
0008). Sheet rasterization is **own code** (ADR 0009) — a vector renderer
built on the pdf.js primitives we already parse, so the gateway needs no
external binary (poppler is an optional fallback for scanned pages).
The gateway now ships its **remote transport**: Streamable HTTP with
per-request identity from a bearer JWT, so ACL trimming and tenant isolation
follow the calling token (two tokens hit one server and see different
knowledge), plus an append-only audit trail of every call (P0-7). The richer
P0-3 tools `find_experts` and `get_project_context` round out the surface.
Open before Phase 2 exit: production graph engine (OQ 1), SharePoint sync,
OCR for scanned sets, and OAuth 2.1 + Entra federation on the gateway — the
JWT identity uses the same claim shape, so that work swaps only the token
verifier.
