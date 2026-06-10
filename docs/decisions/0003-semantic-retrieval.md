# ADR 0003: Hybrid semantic retrieval for engineering documents

Date: 2026-06-09 · Status: Accepted

## Context

Exact AND keyword matching fails engineering vocabulary (safing vs
firestop, fire-stopping vs firestopping, façade vs facade) while pure
vector search blurs the precision identifiers AEC runs on (ASTM E2307,
07 84 00, A-501) and can hallucinate relevance — fatal to the honest
no_results promise (P0-8). Users must also be able to verify any answer
against the exact source document in the app.

## Decisions

- **Hybrid retrieval with a lexical honesty gate.** Three ranked lists —
  shared lexical matcher, SQLite FTS5 BM25, dense cosine similarity —
  fused with reciprocal-rank fusion (k=60). The candidate set is gated by
  the lexical lists (AND across concepts, OR within synonyms): **vectors
  re-rank, they never admit items no concept matched**, so no_results
  stays honest even with embeddings on.
- **Engineering-aware normalization**: diacritic + hyphen stripping, a
  small query-time AEC synonym dictionary (firestop/safing/firestopping,
  spec/specification…), stopword removal for natural-language questions,
  and per-entity `aliases` for item-specific vocabulary.
- **Pluggable `EmbeddingProvider`** (core interface): Voyage and OpenAI
  API adapters plus Ollama for firms that cannot send documents off-prem.
  Selected via `EKG_EMBEDDINGS_PROVIDER`; absent → lexical-only. Vectors
  stored as JSON columns with brute-force cosine — honest about dev scale;
  swap to sqlite-vec/pgvector with the production engine (OQ 1).
- **Golden retrieval set in core** (`GOLDEN_RETRIEVAL`) covering synonyms,
  morphology, diacritics, natural-language questions, and a mandatory
  no-results case. `npm run eval` prints the scorecard; the store test
  suite asserts it, so retrieval regressions fail CI.
- **Exact-document verification**: entities carry `content` (extracted
  source text). It is indexed for retrieval, returned by the MCP `fetch`
  tool, and rendered in the workspace app's entity page; gateway citations
  deep-link to the app entity URL (`EKG_APP_URL`).

## Consequences

- Synonym/diacritic/morphology queries that previously returned "no
  results" now retrieve correctly, with provable recall via the golden set.
- Dense retrieval is a config change, not a code change, and degrades
  gracefully (provider failure → warn once, lexical continues).
- Next steps (separate ADRs when they land): cross-encoder reranking,
  graph-expansion boosts, contextual chunk-level retrieval after the OQ 8
  PDF spike.
