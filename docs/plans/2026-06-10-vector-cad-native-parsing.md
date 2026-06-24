# Plan: Geometric/CAD-native parsing of vector engineering PDFs

Date: 2026-06-10 · Status: **Phases A+B shipped** (`vector.ts` 2026-06-10,
`semantics.ts` + `references` edges 2026-06-11); **Phase C fusion shipped**
2026-06-16 (ADR 0007). Note: this plan originally reserved "ADR 0006" for
Phase C, but 0006 became chunk-level retrieval — Phase C is **ADR 0007**.

## Goal

Make this the best engineering PDF parser available: for vector PDFs
exported from MicroStation, Civil 3D, and AutoCAD, parse the underlying
**vector primitives** — lines and curves with graphics state, text entities
with coordinates, and layer metadata where it survives — instead of relying
on rasterized pixels. Reconstruct sheet semantics (what is a match line,
what is a dimension, where the title block is, which callouts reference
other sheets) deterministically from geometry, with the raster + VLM path
(ADR 0005) reserved for scans and narrative description.

## Evidence (probed 2026-06-10 against real DOT corpora)

Two corpora probed with `services/ingestion/scripts/corpus-eval.mjs`:
FDOT standard-plan indexes (430-030, 521-001) and the **Caltrans District 3
project corpus** — 17 real contract documents, 3,923 pages, at
`/Volumes/RobertsExternalSSD/repos/ai-spec-reviewer/District 3`
(scorecard: `docs/plans/district3-corpus-scorecard.json`; originally
mislabeled FDOT here — title blocks read STATE OF CALIFORNIA, contract
numbers are Caltrans EA format). Upload-accuracy eval with Sonnet judging:
`docs/spikes/2026-06-11-caltrans-upload-eval.md`, which drove Caltrans
title-block support, dimension/schedule false-positive fixes, and the
letter-spacing-tolerant grounding gate.

| Capability | Finding | Verdict |
|---|---|---|
| Positioned text | Every string carries x/y in every file; plan sets run 1,400–2,500 chars/page | **Always usable** |
| Vector geometry | Plan sets run 2,400–4,100 `constructPath` ops/page with stroke color, width, join state | **Always usable** |
| OCG layer table | 1 of 6 plan sets (03-3H5404) carries **306 MicroStation levels** — `rd_RIGHT-OF-WAY`, `tcd_TRAFFIC-STRIPE`, `border_PROJ-ID-BLOCK-anno`, plus the source DGN filename; the other 5 are flattened. **Phase A discovery:** 03-3H5404's content has zero `BDC`/`/OC` operators — the layer *table* survived but per-primitive *membership* did not, so its level names are document metadata only. Full attribution is proven on authored fixtures and expected from AutoCAD "include layer information" exports. | **Three states in the wild: flattened / table-only / attributed — detect and report** |
| Scans | Zero in the corpus — every file is born-digital | VLM/OCR path is for legacy sets, not this corpus |

Corpus shape: 6 vector drawing sets (597 sheets) and 11 text documents —
spec packages of 336–494 pages each. The path-density split is clean
(>2,000 paths/page for drawings vs <150 for specs), giving a reliable
plans-vs-specs classifier for free. The level names in 03-3H5404 follow the
FDOT CADD standard (discipline-prefixed: `rd_`, `tcd_`, `topo_`,
`border_`), so a small dictionary maps them straight to semantics — e.g.
`border_PROJ-ID-BLOCK-anno` *is* the title block, `rd_RIGHT-OF-WAY` *is*
the ROW line. **Conclusion: geometry + positioned text are the foundation;
layers are a detect-and-exploit enrichment (1-in-6 here), reported honestly
when absent.**

Side finding for the retrieval roadmap: the 300–500-page spec packages blow
far past the current 20k-char `content` cap — they need the chunk-level
retrieval flagged in ADR 0003 to be searchable beyond their opening pages.

## Architecture: a three-tier extraction ladder

Capability-detected per document, each tier adding semantics, none assumed:

- **Tier 0 — text layer** (shipped, ADR 0004): searchable content,
  grounding source.
- **Tier 1 — geometric model** (this plan): positioned text spans + decoded
  path primitives with graphics state, from `pdf.js getOperatorList()`. No
  new dependencies — the operator stream is exposed by the library we
  already ship.
- **Tier 2 — layer attribution** (when OCGs present): each primitive tagged
  with its CAD layer/level name via `/OC` marked-content ranges; NCS/AIA
  and MicroStation level-name dictionaries map layers to semantics.
- **Raster + VLM** (shipped, ADR 0005): scans, and narrative description on
  top of — and checked against — the vector facts.

## Module design (`@ekg/ingestion`)

### `vector.ts` — the decoder (mechanical, no interpretation)

```ts
interface PositionedText {
  str: string; x: number; y: number; width: number; height: number;
  fontSize: number; rotation: number; layer?: string;
}
interface Stroke {
  segments: Segment[];           // lines + Béziers, CTM-resolved page coords
  bbox: BBox; width: number; color: string;
  dashed: boolean; closed: boolean; filled: boolean; layer?: string;
}
interface VectorModel {
  pageWidth: number; pageHeight: number;
  texts: PositionedText[]; strokes: Stroke[];
  layers: string[] | null;       // null = layer info not present (honest)
  capability: { hasTextLayer: boolean; vectorOps: number; layersAvailable: boolean };
}
```

Implementation notes: walk `getOperatorList()` maintaining the
save/restore/transform CTM stack and graphics state; decode `constructPath`
sub-operators into segments; when `beginMarkedContentProps` carries an `/OC`
reference, resolve the OCG name and attribute the enclosed primitives.
pdf.js v6's internal path encoding is not a stable public API — pin the
version and cover the decoder with fixture tests; if it proves brittle,
the fallback is mupdf's WASM build (still no native deps) evaluated in
Phase A only if needed.

### `semantics.ts` — pure functions over the model (each claim carries evidence)

| Semantic | Method (Tier 1 geometry/pattern) | Tier 2 boost (layers) |
|---|---|---|
| **Reading order** | Cluster text into columns/blocks, sort spatially — fixes ADR 0004's draw-order scramble; numbered general notes come out 1…8, not 8…1 | — |
| **Title block** | Heavy border lines bounding the right/bottom page band; harvest sheet number, title, revision, date as structured fields | `*-TTLB` |
| **Views/details** | Labels matching `PLAN / ELEVATION / SECTION / DETAIL "A"` + geometry-density cluster above each label → named view regions | — |
| **Dimensions** | Dimension-text patterns (`1'-6"`, `Ø`, `@ 12" Centers`) + proximity to extension lines and arrowheads (small filled triangles) | `*-ANNO-DIMS` |
| **Callout bubbles** | Circles (4-Bézier loops) enclosing `3/S-501`-style text → **cross-sheet references** | `*-ANNO-SYMB` |
| **Match lines** | Long dashed strokes collinear with `MATCH LINE` text | `G-ANNO-MTLN` |
| **Schedules/tables** | Aligned horizontal/vertical line families → cell grid → text matrix | — |
| **Scale** | `1/4" = 1'-0"` text or graphic scale-bar pattern | — |

Every derived semantic carries `{ evidence: ids of texts/strokes, method:
'layer' | 'geometry' | 'pattern', confidence }` — nothing is asserted
without pointers back to primitives, and the per-document capability report
states which tiers ran. Same honesty contract as ADRs 0003–0005.

## Integration points

1. **`buildCandidate` upgrade**: `content` becomes reading-ordered text
   (better search snippets, far better grounding); the title-block harvest
   sets the sheet anchor and entity title from the *document*, not the
   filename — DOT-style names like `430-030` stop falling through the
   filename classifier.
2. **Cross-sheet callouts → graph edges**: `references` relationships
   between sheet entities. A drawing set becomes a navigable graph — the
   product's core differentiator, and pure win for `traverse`.
3. **VLM fusion (ADR 0007 — shipped)**: `ingest_document` injects the vector
   facts (layer list, detected views, title-block fields, dimension
   inventory) into the describe instructions — the client model narrates
   *on top of* deterministic facts instead of reading everything from pixels.
   Still to come: the grounding gate gains spatial checking — a quoted
   annotation must exist *and* sit in the view the description places it in.
4. **Schedules** stored as structured tables on the entity, searchable.

## Phasing

- **Phase A — decoder + foundation. ✅ Shipped 2026-06-10.**
  `src/vector.ts` (CTM-tracked path decode, text/layer correlation with an
  honest mismatch fallback, XY-cut reading order, title-block harvest with
  plot-stamp rejection), integrated into `buildCandidate` — geometry-derived
  sheet anchors now reach both ingestion surfaces. 19 tests including
  real-corpus goldens (endwall sheet committed at
  `test/corpus/`; District 3 via `EKG_CORPUS_DIR`, skipped when unmounted).
  Capability report distinguishes `layerTable` from `layerAttribution`.
  Original scope, for reference: `vector.ts` (CTM stack, path decode,
  OCG attribution), capability report, reading-ordered `content`,
  title-block harvest into anchors. Fixtures: extend
  `make-sample-pdfs.mjs` to author an OCG-layered sheet (deterministic
  Tier 2 coverage in CI) plus golden tests against the real corpora —
  the standard-plan sheets and the District 3 set, read from
  `EKG_CORPUS_DIR` and skipped when the corpus isn't mounted, so CI passes
  anywhere but the full goldens run on dev machines. Exit tests: endwall
  sheet 2 yields ordered notes, `sheetNumber: 430-030`, `2 of 4`, revision
  `11/01/19` from geometry alone; 03-3H5404 reports 306 levels with
  `border_PROJ-ID-BLOCK-anno` resolvable.
- **Phase B — semantics + graph. ✅ Shipped 2026-06-11.**
  `src/semantics.ts`: dimensions, callout bubbles (4-Bézier circles over
  detail/sheet stacks), match lines, view labels with geometry-cluster
  regions and scales, schedule grids (line families → cell matrix) — every
  claim carries `{ method: layer|geometry|pattern, confidence, evidence }`
  pointing at primitive indexes. Tier 2 layer dictionary
  (`*-ANNO-DIMS`, `*-ANNO-SYMB`, MTLN, `PROJ-ID-BLOCK`) upgrades method
  when attribution survives. `src/edges.ts` resolves callout/match-line
  targets to `references` relationships (new built-in type in
  `@ekg/core`) — conservatively: only a uniquely-claimed sheet number
  becomes an edge; unresolved and ambiguous targets are reported, and
  printed refs stay on the entity as `properties.sheetRefs`. Both
  ingestion surfaces create edges (CLI resolves across batch + store;
  `ingest_document` resolves against the tenant graph). `decodeStrokes:
  'auto'` keeps the operator walk off spec books (page-1 title-block /
  stroke-density probe). Goldens: endwall sheet 2 yields PLAN +
  `DETAIL "A"` and 20+ dimensions (≥half geometry-method, the rest
  honestly pattern); sheet 3's dimension tables surface as 17×30+
  schedule grids; plot-stamp times ("1:55:08 PM") rejected as ratio
  scales. Notes vs. original scope: FDOT standard plans carry no AIA
  callout bubbles (honest zero — `SEE SHEET` match-line text still
  resolves), and `rd_RIGHT-OF-WAY` attribution goldens are moot until an
  attributed corpus exists — Phase A proved 03-3H5404 kept only the layer
  *table* (membership stripped); attribution coverage lives in the
  authored OCG fixture instead.
- **Phase C — fusion. ◑ Partially shipped 2026-06-16 (ADR 0007).**
  `describe.ts` (`extractSheetFacts` / `formatSheetFacts`): the gateway's
  `ingest_document` injects the deterministic vector facts for the rendered
  page — sheet number/title/revision, view labels, scales, dimension
  inventory, callouts, match lines, schedules, attributed CAD layers — into
  the describe instructions as ground truth, so the client model narrates on
  top of facts instead of re-reading identifiers from pixels (directly
  attacks the Caltrans-eval misreads). Facts also returned structured as
  `deterministicFacts`. Still open in Phase C: spatial grounding v2 (an
  annotation must sit in the view the description places it in), a fuller
  structured-output description schema, schedule search, OCR for scans, and
  the per-gateway golden-sheet description scorecard.

## Risks and honest limits

- **Layer info is often stripped** (proven on FDOT) — never a precondition;
  `layersAvailable: false` is a first-class, reported state.
- **Text as outlines**: some export pipelines curve text — no text
  entities at all. Detect (vectorOps high, text empty) and route to the
  raster + VLM path with a `text-as-outlines` note rather than pretending.
- **pdf.js internal op encoding** may shift between majors — pinned
  version, decoder fixture tests, mupdf-WASM fallback identified.
- **Rotated viewports / nested transforms** — CTM math in the decoder,
  rotated-sheet fixture in the test set.
- **Performance**: ~8k paths/page on the heaviest FDOT file decodes
  linearly; not a concern at ingestion cadence.
