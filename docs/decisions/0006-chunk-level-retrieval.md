# ADR 0006: Chunk-level retrieval for long documents

Date: 2026-06-15 · Status: Accepted

## Context

Entities carried their extracted text in a single `content` field, capped at
20,000 characters (ADR 0003's verification panel, ADR 0004's extraction). The
Caltrans upload evaluation (docs/spikes/2026-06-11) showed the cost on real
corpora: **16 of 17 documents truncated** — a 494-page spec book was
searchable only through about page 12. The cap was really four different
truncations wearing one number:

- **Storage** — text past 20k was *lost*, never stored.
- **Lexical index** — FTS5 indexed only the preview, so search went blind a
  few pages in.
- **Dense index** — `embeddingText` capped at 2k chars and produced **one
  vector per document**; a single vector cannot represent hundreds of pages.
- **Transport / grounding** — the MCP `fetch` tool and the ADR 0005 grounding
  gate saw only the preview, so a description of page 200 could never ground.

Raising the cap fixes storage and lexical but not citation granularity
(P0-2a wants the page/section, not the file), not dense retrieval, and it
would dump a multi-megabyte blob at the model on `fetch`.

## Decisions

- **Documents are split into chunks — passages owned by the parent entity.**
  A `Chunk` (core) carries `{ ordinal, anchor, heading, text }` and its own
  FTS row and embedding. Chunks are **not entities**: they inherit the
  parent's ACL and review status, and are never curated or traversed on their
  own. A document stays one node in the graph and one curation decision;
  this is why chunks are a child table, not `document-chunk` entities (which
  would flood the workbench with hundreds of per-passage review items).
- **Chunk on the structure already extracted.** PDFs chunk per page — already
  the right size (~1–2k chars) and a natural citation target; the page's
  sheet number (drawings) or detected MasterFormat section (specs) enriches
  the anchor. Plain text windows on paragraph boundaries. Short documents
  stay chunkless — their entity content already holds everything, so the seed
  corpus, capture-form items, and RFIs are unaffected.
- **The entity keeps a bounded preview; chunks hold the authoritative text.**
  `content` is a ≤20k preview for the verification panel and short-document
  full text; no data is lost because the chunks are complete. Text extraction
  now covers the **whole document** (`vector.ts` decouples the cheap
  text/title-block pass, run over all pages, from the expensive geometry
  decode, still capped at 40 pages).
- **Search folds chunk hits into the existing hybrid retrieval, honestly.** A
  new chunk-FTS list requires every query concept to **co-occur in one
  passage** (stricter than the entity gate), rolled up to the parent. Dense
  re-ranks on the best of the entity vector and the entity's chunk vectors.
  The candidate set is still admitted only by an honest gate — a chunk that
  matches all concepts is a legitimate admission of its parent — so the
  no_results promise (P0-8) holds. Each hit carries the matched passage
  (`SearchHit.chunk`) so gateways cite the page/section, not the file.
- **`upsertEntity(entity, chunks?)`: omitted chunks preserve passages.** A
  curation re-upsert that only flips `reviewStatus` must not wipe the
  searchable text; `[]` clears explicitly. `deleteEntity` cascades chunks and
  their FTS rows; `getChunks` returns them permission-trimmed via the parent.
- **Gateway surfaces sections.** `search` results carry the matched section
  and a page/section anchor; `fetch` returns the section index and pulls any
  passage in full by ordinal; `save_description` grounds against the full
  chunk text (the whole document), not the preview — so a description of a
  deep page is now checkable.

## Consequences

- The truncation is eliminated across all four roles. Re-running the Caltrans
  eval (scorecard: `docs/plans/2026-06-15-caltrans-chunk-scorecard.json`):
  the 494-page spec book yields **490 chunks, ~1.15 MB of text retained vs
  the 20k preview**, ingests in ~1.7 s, and a four-word phrase from page 51
  that is absent from the preview is **found and cited to page 51**. Across
  the 17-document corpus every spec book now retains 700k–1.1 MB of
  previously-unsearchable text.
- Side win: text extraction over all pages means title blocks are harvested
  on far more sheets (e.g. 03-3H5404plans 149/179, was 0/40) — the per-page
  pass now reaches the whole set, not the first 40.
- Dense retrieval becomes meaningful for long documents — one vector per
  passage instead of one blurred vector per book. With no embedding provider
  configured, chunk FTS still delivers deep search and citations; dense is
  additive (ADR 0003's graceful degradation).
- The `GraphStore` interface grew `getChunks` and the optional `chunks`
  argument; both stores (SQLite, in-memory) implement them, so the contract
  stays engine-agnostic (OQ 1). Production swaps brute-force chunk cosine for
  sqlite-vec/pgvector with the real engine — flagged there, not solved here.
- Open: cross-passage concept matching is intentionally *not* admitted
  (precision over recall) — a query whose concepts never co-occur in one page
  and aren't in the preview won't match; if real queries need it, a per-
  concept chunk-union gate is the follow-up. The 20k preview cap and the
  40-page geometry-decode budget remain tunable knobs, not hard limits.
