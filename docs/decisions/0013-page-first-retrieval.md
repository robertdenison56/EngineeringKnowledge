# ADR 0013: Page-first retrieval

Date: 2026-09-11 · Status: Accepted

## Context

ADR 0006 split long documents into passages and let a passage admit its parent,
but only under the same all-concepts gate the entity carries: every query
concept had to co-occur in one passage. Everything else fell through to a
relaxed pass that ranked **documents** by how much of the query their metadata
and bounded `content` preview mentioned.

Both halves fail on the question this product exists to answer. A whole-sentence
question tokenizes into a mean 15.2 concepts on the Caltrans benchmark; exactly
one question in sixty has a passage carrying all of them, so the strict chunk
gate almost never fires. And the preview the relaxed pass reads is the first
20,000 characters — of the 2025 Standard Specifications, that is 5 of 1,411
passages. So the fallback chose a document by its front matter and then went
looking for a page inside it.

Measured over all 388 benchmark questions, single-shot, against the pinned
snapshot: the gateway returned the document holding the answer for 84.8% of
questions and the **page** holding it for 60.8%. Plain BM25 over the same
passages returned the page for 93.8% — 133 questions it found and the gateway
did not, against 5 the other way. The gap was not the corpus (the answering text
is present for 387 of 388 questions) and not the model; it was that nothing in
the pipeline ranked pages.

## Decisions

- **Passages are ranked on their own merits.** `pageMatches` scores passages
  with FTS5's BM25 over an OR of the query's concepts — rare terms dominate,
  which is what makes "Table 201.1" outweigh "design" — takes the top
  `PAGE_SCAN` (200), and rolls them up to their documents. A document enters the
  list at its best-scored passage and cites that passage.
- **Coverage is the gate, and it is the citation floor.** A passage admits its
  parent exactly when it carries enough of the query to be *cited*
  (`coverageFloor`, the floor `bestCitationChunk` already used). One floor, so
  admission and citation cannot disagree, and it degenerates to the all-concepts
  gate at one, two, and three concepts — short precise queries are unchanged.
- **Two bands, and the order between them is a contract.** Every all-concepts
  hit outranks every partial one; the partial band is ordered by how much of the
  query each hit covers (document plus cited passage), under the same
  review-status and role multipliers. This replaces the older "strict and
  relaxed never mix" rule, which bought precision by discarding the answering
  page whenever any document happened to match on its preview.
- **Everything partial is disclosed.** A page-coverage hit carries `partial`
  (what its evidence does not cover) and the coverage that travels with its
  citation, and it never seeds graph-expansion — the P0-8 rules the relaxed pass
  already followed, now applied to a better-founded band.
- **The page pass does not re-rank the exact band.** Fusing it there promoted a
  spec book's dense passage over the firm's own curated detail for "curtain wall
  firestop". Its job is reach, not re-ranking.
- **Default result count drops from ten to five** (`DEFAULT_SEARCH_LIMIT`).
  Ten was right while ranking was weak; with page-first ranking results four
  through ten add 0.7 points of document recall and 0.8 of page recall for about
  half of a response's payload.

## Consequences

- Single-shot retrieval over the 388 questions: document at rank 1 goes 43.6% →
  **89.7%**, document within the returned list 84.8% → **99.0%**, page at rank 1
  31.2% → **76.0%**, page within the list 60.8% → **83.2%**. Against the BM25
  reference (85.1% / 96.9% doc, 68.3% / 90.7% page at 1 and 5) the gateway is now
  ahead at rank 1 on both and behind on page recall across the list — expected,
  since it returns one page per document where BM25 returns five pages.
- End to end on 60 questions (gemma4:31b-cloud, EKG condition): answer accuracy
  80.0% → **90.0%**, citation accuracy 46.7% → **85.0%**, and **22% fewer
  tokens** (19,419 → 15,198 per question) — better ranking pays for itself,
  because the model stops searching again to find what the first search should
  have returned.
- `relax: false` now also turns off the page pass: it is a partial tier, and a
  caller asking for all-concepts hits or nothing still gets exactly that.
- The in-memory store mirrors the contract (admission, disclosure, banding)
  without the BM25 half — it has no index, and its corpus is the seed.
- Cost: one indexed FTS lookup plus coverage checks over at most 200 passages
  per search. Unbounded scans of every passage were never on the table.
- Open: page recall across the list is still below BM25's because of the
  one-page-per-document roll-up. Returning a document's other matching pages
  (as ordinals, not text) is the obvious next step and is not taken here.
