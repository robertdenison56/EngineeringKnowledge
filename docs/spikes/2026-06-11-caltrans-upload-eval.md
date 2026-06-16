# Caltrans upload-accuracy evaluation (Sonnet-judged)

Date: 2026-06-11 · Corpus: 17 Caltrans District 3 contract documents
(6 plan sets / 597 sheets + 11 spec packages, 3,923 pages) at
`ai-spec-reviewer/District 3`. Scorecard:
`docs/plans/2026-06-11-caltrans-upload-scorecard.json`.

Note: this corpus was previously mislabeled FDOT in the vector-parsing
plan — title blocks read STATE OF CALIFORNIA DEPARTMENT OF TRANSPORTATION,
contract numbers are Caltrans EA format (03-2H4504), counties are
Yolo/Solano/Butte. The committed endwall golden (430-030) *is* FDOT.

## What was run

1. **Mechanical upload pass** — the real pipeline (`buildCandidate` +
   reference-edge resolution) over all 17 documents
   (`scripts/upload-eval.mjs`).
2. **Sonnet judge pass** — 6 representative sheets rendered at 110 DPI;
   one Claude Sonnet agent per sheet compared every parser claim against
   the image and listed misses.
3. **Sonnet describe-flow** (ADR 0005) — 3 sheets described cold by Sonnet
   as the BYO client model; its verbatim annotations checked by the
   grounding gate against the extracted text layer.

## Headline results

| Metric | Before fixes | After fixes |
|---|---|---|
| Documents uploaded (`extracted`, no failures) | 17/17 | 17/17 |
| Title blocks found, plan sets (analyzed pages) | ~0% (1 was a false positive) | 4 sets at 40/40; 21/27; 28/40 |
| Sheet IDs correct on judged sheets | 0/6 | 5/6 (the 6th prints no ID — correct null) |
| Sheet index/total (e.g. 20 of 85) | 0/6 | 6/6 |
| Spec-book title-block false positives (SW-846) | 1 | 0 |
| View labels on judged bent sheet | 1/3 | 3/3 |
| Dimension junk (DMS angles `28°26'20"`, `12'-15` artifacts) | pervasive | eliminated (goldens keep real dims) |
| Scales (incl. `NO SCALE`) on judged sheets | 2/6 sheets | 6/6 |
| Callout bubbles / cross-sheet edges | 0 | 0 — **correct**: these Caltrans civil sheets carry no AIA-style bubbles |
| Ingest speed | — | 0.1–0.2 s/spec book, 2–5 s/plan set |

Sonnet-judged claim precision before fixes was poor on every category
except match lines (correct zeros): title block null on all 6 sheets, a
county-boundary box and signature blocks reported as schedules, curve-data
angles reported as dimensions, one scale read from a neighboring region.

## Fixes shipped from this eval

- `harvestTitleBlock`: Caltrans format — standalone short sheet IDs
  (`L-1`, `U-2`, `X-1`), `SHEET No. / TOTAL SHEETS` integers resolved by
  page-space proximity (the registration-stamp ring scrambles text order),
  dash dates (`6-18-22`); bare sheet-number-shaped strings now require
  corroborating band labels (kills `SW-846`); `SCALE:`/`TOTAL`/`ROUTE`…
  excluded from title candidates.
- `detectDimensions`: degree-minute-second angles stripped before
  matching; feet-inches require inches ≤ 11 and feet ≤ 999; bare inches
  ≤ 96.
- `detectViews`: qualifier labels (`ELEVATION - EXPANSION FACE`,
  `MIRRORED …`), prose stopword guard; `LAYOUT` recognized; `NO SCALE`.
- `detectSchedules`: grids must be ≥ 50% text-filled — county boxes,
  column-line pseudo-grids, and signature blocks drop out.
- `groundAnnotations`: space-blind fallback (token-boundary-safe, ≥ 6
  chars) for letter-spaced CAD text — `ROUTE 505` extracts as
  `R OU TE 505`.

All shipped with regression tests (36 pass, incl. FDOT + District 3
goldens — no regressions on the prior corpus).

## Describe-flow grounding (Sonnet as client model, 110 DPI)

| Sheet | Annotations | Grounded | Dominant ungrounded causes |
|---|---|---|---|
| 2H4504 p2 (L-1 LAYOUT) | 17 | 6 | model misreads (`BY No.` vs printed `Br No.`); stacked text order (`COUNTY YOLO`); legend text absent from layer |
| 3H3904 p30 (BENT 4L) | 19 | 7 | misreads (`REI.` vs `REINF`); special glyphs (¢, ½); title-border text letter-spaced vertically |
| 3H5404 p2 (X-1) | 19 | 8 | fabricated/misread station ranges and `ADT (2020)` vs printed `ADT (2043)` |

Verdict: **the gate is doing its job.** Spot-checks confirmed the
rejections are real misquotes (Sonnet at 110 DPI misreads small text), not
gate bugs — exactly the failure mode ADR 0005 built the gate for. Two real
gate limitations remain: stacked-label word order, and legend/standard-cell
blocks whose text never reaches the PDF text layer. Higher-DPI tiles (the
300 DPI quadrants `ingest_document` already sends) should lift the model's
read accuracy; this eval used the 110 DPI overview only.

## Open gaps, by retrieval impact

1. ~~**Spec packages truncate at the 20k-char `content` cap**~~ — **RESOLVED
   2026-06-15 (ADR 0006, chunk-level retrieval).** Was: 16/17 documents
   truncated, the 494-page spec book searchable only through ~page 12. Now
   each document is chunked per page (490 chunks / ~1.15 MB retained on that
   book), every page searchable and citable, and `save_description` grounds
   against the full text. Verified: a page-51 phrase absent from the preview
   is found and cited to page 51 (scorecard:
   `docs/plans/2026-06-15-caltrans-chunk-scorecard.json`).
2. **Classification**: every document landed as plain `document` —
   Caltrans filenames carry no MasterFormat/sheet patterns. The title
   sheet carries contract number, route, counties; a Caltrans-aware
   harvest could type plan sets vs spec packages and set project metadata.
3. **Tables without full rule grids** (CURVE DATA columns are
   text-aligned, not ruled) come out with wrong column counts; schedule
   detection needs text-alignment columns, not just rules.
4. **Cross-sheet references on civil sheets** are textual
   (`MATCH LINE`-continuations exist in these sets beyond the sampled
   pages; fence/staking callouts use station-offset text) — the
   bubble-circle detector is the wrong shape here; a `SEE SHEET <id>` /
   station-reference pass would create the edges this corpus supports.
5. **Reading order for stacked labels** (`YOLO` over `COUNTY`) scrambles
   short vertical stacks; affects both search snippets and grounding.
