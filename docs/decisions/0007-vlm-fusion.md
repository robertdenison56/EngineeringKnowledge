# ADR 0007: VLM fusion — deterministic facts as ground truth for sheet description

Date: 2026-06-16 · Status: Accepted

## Context

ADR 0005 gave the gateway a BYO-vision describe flow: render a drawing sheet,
hand the pixels to the user's own model, and ground its quoted annotations
against the text layer. The Caltrans evaluation (docs/spikes/2026-06-11)
measured where the model fails — describing sheets cold at 110 DPI, Sonnet
grounded only ~35–42% of its "verbatim" annotations, and the rejections were
real misreads: it read `Br No.` as "BY No.", `ADT (2043)` as "ADT (2020)",
and fabricated station ranges. The grounding gate caught them, but a curator
then has to fix every one.

Meanwhile the vector parser (Phases A+B, ADR 0004 + the vector-parsing plan)
already extracts the very things the model reads worst — the title block,
view labels, dimension strings, callouts, schedules, and CAD layer names —
*deterministically* from the geometry and text layer. Asking the model to
re-derive them from pixels is both wasteful and the source of the errors.

The vector-parsing plan reserved "ADR 0006" for this Phase C work; ADR 0006
was instead taken by chunk-level retrieval, so this lands as **0007**.

## Decisions

- **Fuse deterministic facts into the describe instructions.**
  `extractSheetFacts(data, page)` (`@ekg/ingestion/describe.ts`) decodes the
  rendered page and returns `{ sheetNumber, title, revision, views, scales,
  dimensions, callouts, matchLines, schedules, layers }`; `formatSheetFacts`
  renders them as a "DETERMINISTIC PARSE" block prepended to the describe
  prompt. The model is told to **trust these for identifiers, structure, and
  exact values** and to describe what they mean and what else is drafted —
  narrating *on top of* facts instead of reading them from pixels. The same
  no-counts / no-inferred-dimensions / quote-verbatim rules from ADR 0005
  still apply to everything else.
- **Facts ride with the rendered images, gated on the text layer.** Fusion
  runs only when a page actually rendered (`imagesAttached > 0`) and parsed
  (`parseStatus: extracted`). Scans, text-as-outlines, and spec pages with no
  drawing facts return `null` — the flow proceeds with pixels only, honestly
  unenriched, never blocked. Layer names are surfaced only when per-primitive
  attribution survived (`layerAttribution`), not when just the layer *table*
  did — same honesty contract as Phase A.
- **Facts are also returned structured.** The `ingest_document` result carries
  `deterministicFacts` in its JSON status, so a non-vision client, a logging
  consumer, or the curation UI can use them without parsing the prompt text.
- **Grounding is unchanged and still authoritative.** The fused facts come
  from the text layer, so they ground by construction; the gate continues to
  check every annotation the model returns. Fusion raises the model's input
  quality; it does not weaken the gate (P0-8 honesty preserved).

## Consequences

- The identifiers the model reads worst — sheet number, view names, dimension
  strings — are now supplied as ground truth, so they no longer depend on the
  model resolving small or letter-spaced text from pixels. On the C-102
  fixture the block reads: `Sheet: C-102 "DRAINAGE PLAN AND DETAILS" (sheet 5
  of 12) rev 03/15/24 · Views: SECTION A-A · Dimensions: 12'-6" · Callouts:
  3/S-101 · Schedules: PIPE SCHEDULE` — exactly the facts Sonnet stumbled on
  in the cold eval.
- Description quality still varies with the client model, but its floor rises:
  even a weak reading inherits the correct structure, and the grounding gate
  bounds the rest. The golden-sheet description eval (ADR 0005 follow-up) is
  the place to quantify the lift per gateway.
- **Measured lift (Caltrans 03-3H3904 sheet 30, bent layout, Sonnet @ 150 DPI,
  2026-06-16):** cold described the sheet at **8/18 = 44%** annotations
  grounded; fused at **16/21 = 76%**. The difference was almost entirely
  dimensions — cold *fabricated* `12'-1"`, `14'-5½"` (not on the sheet), while
  fused quoted the parser's `64'-9`, `38'-5`, `13'-2"`, `1'-5"`, all of which
  ground because they came from the text layer. The fused run also recovered
  all three view labels (`PLAN`, `ELEVATION - EXPANSION FACE`, `MIRRORED
  ELEVATION - FIXED FACE`) that the original cold eval got only one of. The
  residual ungrounded items are real labels the gate rejects on formatting
  (the `¢`/`&` centerline glyph, an abbreviated `BOTTOM FLANGE COVER PL.`),
  not hallucinations.
- One extra page decode per describe call (bounded to the rendered page);
  negligible next to the poppler rasterization already in the path.
- Still open from the spike/Phase C: spatial grounding v2 (verify an
  annotation sits in the view the description places it in), a fuller
  structured-output description schema, OCR for scanned sheets, and the
  per-gateway golden-sheet scorecard. Fusion is the highest-leverage piece and
  ships first; the rest are independent follow-ups.
