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
ingesting garbage. Every PDF candidate carries `parseStatus`
(`extracted` / `ocr-extracted` / `needs-ocr` / `parse-failed`) and `pageCount`.

**OCR for scans** (`ocr.ts`): image-only PDFs are rasterized and recognized into
a searchable, **groundable** text layer (`parseStatus: ocr-extracted`) — so a
vision model's description of a scanned sheet can be verified against it, not
left ungrounded. The engine posture mirrors poppler: no hard dependency.
`createPageOcr()` prefers `tesseract.js` (pure JS/WASM, `npm i tesseract.js`) and
falls back to a system `tesseract` binary; with neither installed a scan
honestly stays `needs-ocr`. **All three ingestion surfaces wire this
automatically** — the MCP gateway, the folder-walk CLI, and the in-app
`/ingest` upload — so a scan parses identically however it enters; opt out with
`EKG_DISABLE_OCR=1`.

OCR text is **confidence-gated** (P0-2a): each page carries its mean per-word
confidence, pages below `OCR_CONFIDENCE_THRESHOLD` (or whole documents whose
engine can't score confidence) are recorded on `entity.properties.ocr` and the
candidate is flagged `needsReview` for the curation workbench. Machine-read text
is searchable but always lands `unverified` — never silently promoted.

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

**Source connectors + change detection** (`source.ts`, PRD P0-2). Every way a
document enters the graph is one shape: `SourceConnector.list()` enumerates
`SourceItem`s — each with a stable `id`, a content-hash `version`, lazy
`read()`, and a `SourceMeta` (origin system, deep link, author, timestamps, and
**source-system ACL**). `buildCandidate({ source })` stamps that metadata onto
the candidate, so source-system permissions become item ACLs at ingestion
instead of a tenant-public default. `planSync(items, manifest)` is the pure
change-detection core of scheduled sync — it diffs the current listing against
the last manifest into added / changed / unchanged / removed, so "selected
libraries sync on schedule with change detection" is testable without a live
tenant. `FolderConnector` is the reference implementation over a local
directory; the SharePoint/OneDrive OAuth connector is a drop-in `SourceConnector`
(it supplies the Graph driveItem id, etag as `version`, and the Entra-mapped ACL)
— classification, parsing, and curation downstream are unchanged.

**Source-system permissions → item ACLs** (`buildCandidate({ source: { acl }})`).
The workspace upload form and CSV importer capture visibility manually (public,
or restricted to listed principals) today; the SharePoint connector will write
real source ACLs through the same seam (gap G6).

**CSV project-list import** (`csv.ts`, PRD P0-2 "CSV/bulk import for project
lists"). `parseProjectCsv` reads a delimited project register (comma or tab
auto-detected, header matched by name with synonyms, quoted-field aware);
`buildProjectCandidates` turns rows into `project` candidates keyed on project
number so a re-import updates rather than duplicates. Malformed rows are reported,
never guessed. Surfaced in the workspace app at `/ingest` → "Import project list".

Next: ship a bundled OCR engine by default (currently opt-in via tesseract.js /
system tesseract); the SharePoint/OneDrive OAuth connector implements
`SourceConnector` and replaces the folder walk; the candidate model and curation
flow stay the same.
