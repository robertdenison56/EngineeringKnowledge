# ADR 0005: Gateway ingestion with client-model drawing description

Date: 2026-06-10 · Status: Accepted

## Context

Users live in their AI assistant, not in our app — the PRD's central bet.
They should be able to *add* knowledge from there too, not only query it.
And the drawing-description spike (docs/spikes/2026-06-10) showed that
describing what is drafted on a sheet needs a vision model with guardrails.
Running that model server-side would make us an LLM reseller: our API key,
our per-sheet cost, our pricing problem (PRD OQ 5), and a second model
posture to defend besides the gateways themselves.

## Decisions

- **Ingestion is a gateway capability.** `ingest_document` on the MCP
  server runs the exact CLI pipeline — `buildCandidate` is shared code in
  `@ekg/ingestion` (classification, ADR 0004 text-layer extraction, honesty
  statuses) — and queues the same `unverified` candidates for the curation
  workbench. One pipeline, two surfaces.
- **The calling model does the describing — BYO AI subscription.** For
  drawing sheets (sheet-number filenames, scans, or `describe: true`), the
  tool result carries rendered sheet images (poppler `pdftoppm`: 150 DPI
  overview + 300 DPI quadrant tiles, the resolutions validated in the
  spike) plus instructions: describe the views and annotations, quote
  identifiers verbatim, never count symbols or infer unprinted dimensions.
  The user's own assistant — already paid for — reads the sheet and calls
  `save_description`. The gateway holds **no LLM API key**; there is no
  per-sheet inference cost on our side.
- **Grounding gate on save** (`groundAnnotations`): every annotation the
  model claims to have read verbatim is normalized and substring-checked
  against the extracted text layer. Grounded annotations are stored as
  `descriptionAnnotations`; ungrounded ones go to `descriptionUngrounded`
  for curator review and the model is told not to present them as facts.
  Scans have no text layer — the entire description is marked
  low-confidence. Same philosophy as ADR 0003's lexical gate: generated
  content never outranks evidence.
- **Descriptions are machine-generated, unverified, and re-queue the
  entity.** The summary is prefixed `[AI-generated description —
  unverified]`, the full text lives in `properties.drawingDescription`,
  and `reviewStatus` is forced back to `unverified` on every save — a
  description landing on a previously verified entity must be re-curated.
- **Graceful degradation.** No poppler on the gateway host → candidates
  still ingest, images are skipped with an explicit note. Unsupported
  extensions and missing files return structured errors, not crashes.

## Consequences

- A user can drop a drawing into chat conversation flow: ingest → their
  model describes it → grounded description queued → curator verifies →
  the sheet is searchable firm knowledge with provenance. No new billing
  relationship, no server-side model config.
- Description quality now varies with the client model. The grounding gate
  and curation queue bound the damage; the golden-sheet evaluation set
  (spike follow-up) measures it per gateway.
- `pdfjs-dist` moved from bundled to an external runtime dependency of the
  MCP server — its worker does a runtime relative import that esbuild
  bundling breaks.
- The stdio transport reads files from the local machine, which is correct
  for the v0 single-user gateway. The Phase 2 remote transport (Streamable
  HTTP + OAuth) must replace `path` with an upload mechanism and scope
  writes by the resolved caller — flagged there, not solved here.
- Sheets ingested via ChatGPT/Copilot follow the same protocol — tool
  results with images are standard MCP — but their description quality
  gates on those models's drawing literacy (AECV-Bench numbers in the
  spike).
