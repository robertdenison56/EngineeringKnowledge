# Ingestion Pipeline v0 (PRD P0-2, P0-2a)

Walks a folder, classifies each file, and queues **unverified** candidate
entities in the shared SQLite database — they appear in the workspace app's
curation workbench (`/curation`) for review. Nothing reaches the verified
graph without a curator.

```sh
# from the repo root, into the web app's database:
npm run ingest --workspace @ekg/ingestion -- services/ingestion/samples \
  --db apps/web/.data/ekg.db
```

Classification v0 (filename-based, conservative by design):

| Pattern | Type | Anchor |
|---|---|---|
| MasterFormat number (`07 84 00 …`) | `spec-section` | `specSection` |
| Sheet number (`A-501 …`) | `document` | `sheet` |
| `RFI…` | `rfi` | — |
| `Lesson…` | `lesson-learned` | — |
| anything else | `document` | — |

Text files (`.txt`, `.md`) get content summaries. **PDFs get text-layer
extraction via pdf.js** ([ADR 0004](../../docs/decisions/0004-pdf-parsing.md)):
born-digital PDFs ingest their full text (searchable, verifiable in the app);
image-only PDFs (scans) are flagged `parseStatus: needs-ocr` instead of
ingesting garbage — OCR is a follow-up decision. Every PDF candidate carries
`parseStatus` (`extracted` / `needs-ocr` / `parse-failed`) and `pageCount`.

**Vector drawing sheets get CAD-native parsing** (docs/plans/2026-06-10,
Phases A+B): the decoder (`vector.ts`) recovers positioned text, path
primitives, and CAD layer names where the export kept them; `semantics.ts`
derives sheet meaning from that geometry — title block, reading order,
views, dimensions, match lines, schedule tables — with every claim carrying
`{ method: layer|geometry|pattern, confidence, evidence }`. Callout bubbles
(`3/S-501`) and match-line continuations resolve into `references` edges
between sheet entities (`edges.ts`): only a uniquely-claimed target sheet
becomes an edge; unresolved/ambiguous targets are reported in the CLI
summary and kept on the entity as `properties.sheetRefs`.

**Documents are split into chunks for deep retrieval**
([ADR 0006](../../docs/decisions/0006-chunk-level-retrieval.md)). `chunkDocument`
(`chunking.ts`) emits one passage per page (drawings and specs) or windowed
passages (plain text), each with a `{ page, sheet, specSection }` anchor.
`buildCandidate` returns them alongside the entity; pass both to
`store.upsertEntity(entity, chunks)`. The entity keeps a bounded ~20k preview;
the chunks hold the authoritative full text, so a 400-page spec book is
searchable and citable to the page — not truncated at the preview. Text
extraction now covers the whole document (the expensive geometry decode stays
capped at the opening sheets).

The PDF sample fixtures are generated deterministically — regenerate with
`node scripts/make-sample-pdfs.mjs`. Real-corpus goldens run against the
committed FDOT endwall sheet (`test/corpus/`) and, when `EKG_CORPUS_DIR`
points at the District 3 set, against that corpus too. `scripts/upload-eval.mjs`
runs the full pipeline over a corpus folder and reports chunk coverage plus a
deep-page search proof.

The per-file pipeline (`buildCandidate`), drawing-sheet rasterization, and
the description grounding gate are exported as a library — the MCP gateway's
`ingest_document` / `save_description` tools run the same code
([ADR 0005](../../docs/decisions/0005-gateway-ingestion-client-model-description.md)).

Next: confidence-gated OCR for scans; SharePoint/OneDrive OAuth sync replaces
the folder walk; the candidate model and curation flow stay the same.
