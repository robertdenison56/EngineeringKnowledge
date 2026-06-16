# Spike: Describing what is drafted on engineering plan sheets

Date: 2026-06-10 · Status: Evaluation complete — recommendation below, ADR
when implemented

## Question

ADR 0004 gave us PDF *text-layer* extraction. For drawing sheets that is
not enough: the text layer of a real detail sheet comes out in draw order
(notes reversed, dimensions divorced from the features they dimension,
stacked fractions and symbols mangled — `1:1½` extracts as `2 1 1 : 1`).
Search works; *describing what is drafted on the page* does not. What
parsing approach can accurately describe the drafted content?

## Method

Hands-on test against a real DOT standard-plan sheet — FDOT Index 430-030
"Straight Concrete Endwalls" (born-digital vector PDF, 4 sheets, downloaded
from fdot.gov) — plus a literature/benchmark review (June 2026).

Test: run the shipped pdf.js extraction; rasterize sheet 2 (the
drawing-heavy "Concrete Endwall Details" sheet) at 150 DPI full-page and
300 DPI regional tiles; have a vision-language model (Claude) describe the
drafted content; cross-check every specific claim (labels, dimensions,
callouts) against the extracted text layer.

## Findings

| Approach | Can it describe what's drafted? | Notes |
|---|---|---|
| Text layer (pdf.js — shipped) | **No** | Full string recall (searchable), but draw-order scramble, mangled fractions/symbols, no spatial semantics. Keep as the search index and as the *grounding source* for VLM claims. |
| OCR/layout services (Azure Document Intelligence etc.) | **No** | High-res OCR add-ons handle A1–A3 sheets, strong on tables/key-value; explicitly not drawing-semantic. Also off-prem (same posture concern as embeddings). |
| AEC takeoff products (Togal, Kreo, Sparkel, Trunk Tools) | Partially, as products | Symbol detection tuned for quantity takeoff, sold as platforms, not embeddable parsing APIs for our pipeline. Watch this space; don't buy for description. |
| **General VLM (Claude vision) over rasterized sheets** | **Yes, with guardrails** | See test results below. |

### VLM test results (FDOT 430-030 sheet 2)

- **150 DPI full page**: sheet type, all four views (Plan, Front Elevation,
  Side Elevation, Detail "A"), title block fields (index, sheet 2 of 4,
  FY 2023-24, last revision 11/01/19) all read correctly. Small dimension
  text borderline.
- **300 DPI regional tiles**: every label and dimension legible; spatial
  relationships correctly describable (keyway at the optional construction
  joint, #4 dowel @ 12" centers with 9" embedment, pipe penetration with
  D-or-S opening, 1:1½ side slopes).
- **Grounding cross-check**: every specific the VLM cited was found
  verbatim in the pdf.js text layer — zero hallucinated specifics on this
  sheet. The cross-check is mechanical and cheap, so it can be a pipeline
  gate, not a manual step.

### Benchmark caution (why guardrails are mandatory)

- AECV-Bench (arXiv 2601.04819): multimodal models reach ~0.95 accuracy on
  text-centric drawing tasks but only **0.40–0.55 on symbol counting**
  (doors/windows) — "document assistants, not drawing-literate."
- ArchPlanVQA (J. Comp. Civ. Eng.): general VLMs ~33–38% semantic
  understanding on architectural CAD drawings.
- Hybrid/specialized frameworks do better on narrow tasks (numerical
  extraction F1 0.963 in one manufacturing-drawing pipeline) but are
  research systems, not products we can adopt today.

Conclusion: VLM descriptions of *what views/details/callouts exist and what
the annotations say* are reliable when tiled at adequate DPI and grounded
against the text layer. **Counting symbols and inferring unstated geometry
are not reliable** and must be excluded from what the pipeline asks for.

## Recommended architecture (ingestion stage 2, after ADR 0004)

1. **Rasterize** drawing-class PDFs per page with poppler `pdftoppm`
   (battle-tested on large sheets; native dep confined to the ingestion
   service) — one ~150 DPI overview + 300 DPI quadrant tiles for sheets
   larger than letter size.
2. **Describe** via Claude vision with a structured-output schema:
   sheet number/title/discipline/revision, views present, components and
   materials with their callout text, dimensions *quoted verbatim*, notes,
   and a `coverage`/`uncertain` field. Explicitly instruct: no counts, no
   inferred dimensions, quote — don't paraphrase — identifiers.
3. **Ground** (honesty gate, same philosophy as ADR 0003's lexical gate):
   mechanically verify every quoted dimension/label/spec reference against
   the pdf.js text layer; unmatched claims are dropped or flagged
   `ungrounded`. For scanned sheets there is no text layer to ground
   against — descriptions are marked lower-confidence pending OCR.
4. **Curate**: the description lands on the entity as machine-generated,
   `unverified`, reviewable in the existing workbench — same path as every
   other candidate. The graph never asserts an unreviewed reading of a
   drawing.
5. **Batch**: ingestion is not latency-sensitive — use the Message Batches
   API for 50% off.

### Cost (per 11×17 sheet ≈ overview + 4 tiles ≈ ~13–15k input tokens, ~1k output)

| Model | Per sheet | 600-sheet set | Batched (50%) |
|---|---|---|---|
| Opus 4.8 ($5/$25 per MTok) | ~$0.10 | ~$60 | ~$30 |
| Sonnet 4.6 ($3/$15) | ~$0.06 | ~$36 | ~$18 |
| Haiku 4.5 ($1/$5) | ~$0.02 | ~$12 | ~$6 |

Opus 4.7+ additionally supports high-resolution vision (2576 px long edge,
up to ~4784 tokens/image), which may let one high-res page replace several
tiles — evaluate during implementation. Given the benchmark spread, start
with Opus-tier for the description stage and evaluate downgrades against a
golden sheet set (the retrieval-golden-set pattern from ADR 0003, applied
to descriptions).

## Out of scope / still open

- Quantity takeoff and symbol counting — explicitly excluded (benchmarks).
- Cross-sheet reference resolution (detail bubbles → sheet links) — a
  natural follow-up; the structured schema should capture callout
  references now so links can be built later.
- Per-class quality thresholds still need the design-partner corpus
  (PRD OQ 6); the FDOT standard-plan corpus is a good interim golden set —
  public, born-digital, and representative of real drafting conventions.

## Sources

- FDOT FY 2023-24 Standard Plans, Index 430-030 (test corpus):
  https://www.fdot.gov/design/standardplans/2024/24.shtm
- AECV-Bench: https://arxiv.org/pdf/2601.04819
- ArchPlanVQA: https://ascelibrary.org/doi/10.1061/JCCEE5.CPENG-7571
- Hybrid VLM drawing-parsing framework: https://arxiv.org/abs/2506.17374
- Multi-stage VLM drawing interpretation: https://arxiv.org/abs/2510.21862
- Azure Document Intelligence high-res OCR / limits:
  https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/add-on-capabilities
- LlamaIndex survey of AI for engineering drawings:
  https://www.llamaindex.ai/insights/best-ai-for-engineering-drawings
