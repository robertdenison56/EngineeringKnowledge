# ADR 0008: Parser–vision collaboration on plan-set ingestion

Date: 2026-06-17 · Status: Accepted

## Context

Two independent readers extract knowledge from a drawing sheet: the
deterministic vector parser (Phases A+B — title block, view labels, dimension
inventory, callouts, scales from geometry) and the client vision model (ADR
0005 — a narrative reading of the rendered pixels). They have complementary
blind spots. The parser is exact but literal: it knows there is a view labeled
`SECTION A-A` and a dimension `18'-11"`, but not what they *mean*. The vision
model describes meaning and structure but misreads small text and fabricates
(Caltrans eval, docs/spikes/2026-06-11: `Br No.` → "BY No.", invented station
ranges).

ADR 0007 connected them one way — the parser's facts feed the vision prompt as
ground truth (fusion). But the verification ran one way too: ADR 0005's
grounding gate checked the vision model's annotations only against the **text
layer**. Running the vision flow on this plan set (03-3H3904) exposed the cost:
the model quoted **11/11** of the deterministic dimensions fusion gave it, yet
many showed as *ungrounded* — not because they were wrong, but because the text
layer scrambles stacked fractions and `±` suffixes, and the model appended
descriptive words (`18'-11"± AFTER STRENGTHEN`). The gate was rejecting correct
readings on a formatting technicality.

The directive: **whenever a user ingests plan sets, the parser and the vision
model should collaborate** — both directions, as a standard part of the flow.

## Decisions

- **Grounding has two sources of truth, not one** (`ground.ts`).
  `groundAnnotations(annotations, sourceText, facts?)` confirms an annotation
  if EITHER the document text layer OR the deterministic parser facts (sheet
  number, views, dimensions, callouts, scales) confirm it. A parser fact
  matches when it is a token-aligned substring of the annotation in either
  direction (so `18'-11"` confirms `18'-11"± AFTER`, and `ELEVATION` confirms
  the view label `ELEVATION - EXPANSION FACE`), with a specificity guard so a
  bare `8` can never confirm against `8'-0"`. The honesty contract is intact:
  this *adds* a real evidence source (a second independent extraction), it does
  not relax the gate — fabrications match neither source and stay flagged.
- **`parserConfirmed` is surfaced as the strongest signal.** When two
  independent extractions agree on an annotation, that is higher confidence
  than either alone. The report carries `parserConfirmed` (a subset of
  `grounded`), `save_description` stores it as `descriptionParserConfirmed`,
  and the tool response tells the model how many of its quotes the geometry
  parse independently confirmed.
- **The collaboration is wired into the standard gateway flow, both ways.**
  `ingest_document` already injects fusion facts into the describe prompt
  (parser → vision, ADR 0007); it now also **persists the rendered page's
  `parserFacts` on the entity**, and `save_description` grounds the model's
  annotations against the text layer AND those facts (vision → parser). No new
  tool, no new step for the user — every described sheet gets both directions.
- **Facts can ground a scan with no text layer.** A sheet the parser partially
  read (positioned text but mangled layout) still yields facts; a description
  is now `groundable` against them even when the text-layer check has nothing
  to match. Only a true scan (no facts, no text) stays wholly low-confidence.

## Consequences

- Correct vision readings the text layer mangled are reclaimed. On
  03-3H3904 sheet 26, text-only grounding confirmed 26/52 annotations; adding
  the parser facts lifted it to 29/52, and — the larger signal — **19 of the
  29 grounded annotations were independently confirmed by the geometry parse**,
  i.e. two readers agreed. Sheet 2 (a layout sheet where the parser found no
  dimensions) saw no dimension reclaim — honestly so; collaboration only helps
  where both readers have something to say.
- The curator now sees three tiers per description: parser-confirmed (two
  readers agree — trust), text-grounded only (one source), and ungrounded
  (neither — review). That triage is the point: the queue surfaces exactly
  what needs a human.
- Remaining gap: dimensions only the vision model read — the stacked-fraction
  span dimensions (`118'-4⅛"±`) the parser's regex does not yet capture — stay
  ungrounded. Closing that means deeper dimension extraction in the parser
  (stacked fractions), a follow-up; collaboration already reclaims everything
  both readers find.
- Still open from Phase C: spatial grounding (an annotation must sit in the
  view the description places it in), a fuller structured description schema,
  OCR for scans, and the per-gateway golden-sheet scorecard.
