---
pretty_name: Caltrans Design Standards QA (retrieval-grounded)
language:
  - en
license: cc-by-4.0
task_categories:
  - question-answering
tags:
  - civil-engineering
  - aec
  - transportation
  - caltrans
  - retrieval
  - benchmark
size_categories:
  - n<1K
---

# Caltrans Design Standards QA

A retrieval-grounded question set over public Caltrans design standards: the
current Highway Design Manual (7th edition) and the 2025 Standard Plans and
Standard Specifications. Older editions are kept in the corpus manifest for
later edition-trap work but are not question targets in this release. Every answer
carries a source anchor (document id, PDF page, table label), and the answer
is a number, a citation, or a short string wherever possible so scoring is
deterministic. The harness lives at
https://github.com/robertdenison56/EngineeringKnowledge/tree/main/research.

## Buckets

| Bucket | Meaning | Target | In `caltrans-v0.jsonl` (2026-09-05) |
|---|---|---|---|
| `lookup` | one value read from one table or clause | 60 | 113 |
| `multihop` | HDM → Standard Plan sheet or Standard Specifications clause, and within-spec cross-references | 40 | 23 |
| `trap` | unit traps (metric vs. US customary, short tons, psi/MPa); edition traps parked until older editions are in scope | 30 | 15 |
| `refusal` | plausible questions the documents do not answer (values outside a table's range, rows that do not exist) | 30 | 22 |

The lookup surplus will be trimmed to the target when the dev/test split is
frozen; the other buckets are still being filled.

## Record format

One JSON object per line. Fields: `id`, `bucket`, `question`, `answer`,
`answer_type` (`number` · `citation` · `text` · `refusal`), `unit`,
`tolerance`, `aliases`, `anchors` (list of `{doc, page, table, quote}`),
`edition`, `split` (`smoke` · `dev` · `test` · `train`), `notes`.
`page` is the 1-based PDF page index of the file named in the manifest.

## Source documents and licensing

All source documents are Caltrans publications posted on dot.ca.gov (see
`corpus/manifest.json` for the exact URL, edition, revision date, SHA-256,
and page count of each file). Caltrans' Conditions of Use
(https://dot.ca.gov/conditions-of-use) state that information on the site is,
unless otherwise indicated, considered in the public domain and may be
distributed or copied as permitted by law, with third-party copyrighted
material such as photographs excepted.

On that basis:

- The questions, answers, anchors, and this card are released under
  **CC BY 4.0**. Attribution: Robert Denison, Engineering Knowledge Graph
  research arc 1, 2026.
- The source PDFs are **not redistributed** in this dataset. The manifest
  records each file by URL and hash, and `caltrans-bench manifest fetch`
  downloads them from Caltrans directly; `manifest verify` confirms the
  downloaded bytes match the ones the questions were written against. If
  Caltrans revises a file in place, the hash mismatch is the signal to pin a
  new edition rather than silently drift.
- The District 3 contract bid documents (`d3-*`) were downloaded from the
  Caltrans Office Engineer advertised-contracts site in 2022. They are public
  bid documents, but the per-contract archive URLs were not re-verified when
  this manifest was built, so they carry a source note and hash only. They are
  used for the grounding study (Arc 1 step 2), not for the question set.
- The harness code's license is set separately in the repository.

## Scoring protocol

Models end each answer with `ANSWER: <value or NOT IN DOCUMENT>` and
`CITE: <doc-id> p<page>`. Numeric answers are compared after unit
normalization within the question's tolerance; citations must land on an
anchored page; refusals must say NOT IN DOCUMENT; short text is matched after
whitespace and case normalization. Only prose answers use a model grader.

## Limitations

The set covers Caltrans only, not other state DOTs or AASHTO. Anchors point
at PDF pages, so figures whose values are drawn rather than typeset are
under-represented. Edition traps assume the reader is told which edition to
use; ambiguity about "current" is deliberately avoided.
