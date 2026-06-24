# ADR 0004: PDF text extraction with a text-layer honesty gate

Date: 2026-06-10 · Status: Accepted

## Context

PDFs dominate AEC corpora — spec books, drawing sets, RFIs, submittals —
and Open Question 8 (buy vs. build) gated P0-2a. Ingestion v0 recorded
PDFs as classified-but-unparsed, which was honest but left the most
common document type unsearchable. Two corpus classes behave completely
differently: born-digital PDFs (Bluebeam/CAD/Word exports) carry a real
text layer; scanned legacy sets carry only images, and extracting
"nothing" from them must not be confused with extracting *content*.

## Decisions

- **Build on pdf.js (`pdfjs-dist`, legacy Node build) for text-layer
  extraction, in-process.** Pure JS — no native dependencies, same
  install-anywhere reasoning as `node:sqlite` (ADR 0002). Per-page text
  items leave room for the chunk-level retrieval flagged in ADR 0003 and
  for drawing title-block heuristics later. Document-understanding
  services (Azure Document Intelligence and peers) were rejected for the
  default path: they send documents off-prem — unacceptable as a baseline
  for the same reason the Ollama embedding adapter exists — and the
  text-layer class doesn't need them. Native-dep parsers (poppler,
  mupdf bindings) were rejected for install friction.
- **A text-layer honesty gate**: below an average of 24 characters/page
  (`MIN_CHARS_PER_PAGE`), the document is flagged instead of ingested.
  A stray watermark or page number on a scan must not masquerade as
  content — near-empty `content` silently poisons retrieval and the
  exact-document verification panel (P0-8). Borderline false-flags cost
  a curator one glance in the workbench; the asymmetry drives the gate.
- **`parseStatus` provenance on every PDF candidate**: `extracted`,
  `needs-ocr`, or `parse-failed`, plus `pageCount`, in entity
  `properties`. The CLI reports the needs-ocr count per run. Extracted
  text flows through the existing pipeline: `content` (FTS-indexed,
  shown in the app), summary, and parser tag derivation — content-based
  tags now fire for PDFs.
- **Deterministic fixtures, no PDF library**
  (`services/ingestion/scripts/make-sample-pdfs.mjs`): hand-assembled
  PDFs covering both corpus classes (text-layer spec excerpt, image-only
  scanned sheet) keep the sample corpus reviewable and the tests honest.

## Consequences

- Born-digital PDFs — the bulk of specs, RFIs, and submittals — are now
  searchable and verifiable end-to-end: ingest → curate → cited answer.
- Scans queue as `needs-ocr` rather than vanishing or lying. OCR is an
  explicit follow-up decision: confidence-gated local OCR by default,
  document-understanding services as a per-tenant opt-in for large-format
  drawings — same posture as embeddings providers.
- The per-class quality thresholds the PRD wants (P0-2a acceptance)
  still need the design-partner corpus (OQ 6); the gate mechanism and
  fixture goldens are in place to receive them. OQ 8's buy-vs-build is
  resolved for the text-layer class: build (pdf.js), buy nothing yet.
- `pdfjs-dist` is a heavyweight dependency (~MBs) but is confined to
  `@ekg/ingestion`; gateways and the app are unaffected.
