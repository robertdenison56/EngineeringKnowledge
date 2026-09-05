# caltrans-bench — EKG Research Arc 1

A public, retrieval-grounded benchmark over Caltrans design standards (the
Highway Design Manual, Standard Plans, and Standard Specifications) plus the
Python harness that scores frontier models on it closed-book, with vanilla
RAG, and with EKG's MCP tools. Plan and "done when" criteria live in the
[PRD, Research arcs](../PRD-engineering-knowledge-graph.md#research-arcs).

## Layout

| Path | What |
|---|---|
| `corpus/manifest.json` | Every source PDF: Caltrans URL, edition, revision date, SHA-256, page count. Source of truth. |
| `corpus/raw/` | Downloaded PDFs (gitignored; `caltrans-bench manifest fetch`). |
| `questions/*.jsonl` | Question sets. `smoke.jsonl` is the CI set; see `caltrans_bench/schema.py` for the fields. |
| `caltrans_bench/` | Package: manifest tooling, question schema, deterministic scoring, BM25 RAG baseline, EKG tool source, Inspect task. |
| `scripts/build-ekg-snapshot.sh` | Ingest the manifest corpus into a fresh EKG store and take a verified `ekg-db` backup. |
| `snapshots/` | Pinned EKG databases the `ekg` condition runs against (gitignored). |
| `DATASET_CARD.md` | Hugging Face dataset card draft, including the licensing statement. |
| `tests/` | pytest for scoring, schema, manifest. |

## Quick start

```bash
cd research
uv sync --group dev                    # Python 3.12 env; add --extra dense for sentence-transformers
uv run pytest -q
uv run caltrans-bench manifest fetch   # downloads ~430 MB from dot.ca.gov
uv run caltrans-bench manifest verify  # re-hashes every file against the manifest
uv run caltrans-bench questions validate questions/smoke.jsonl
uv run caltrans-bench smoke            # Inspect task end to end on the mock model
```

Real models go through Inspect directly:

```bash
uv run inspect eval caltrans_bench/task.py -T condition=closed_book --model anthropic/claude-fable-5-1
uv run inspect eval caltrans_bench/task.py -T condition=rag -T k=8 --model openai/gpt-5.5
scripts/build-ekg-snapshot.sh          # once; builds snapshots/ekg-caltrans.db
uv run inspect eval caltrans_bench/task.py -T condition=ekg --model anthropic/claude-fable-5-1
```

## Answer protocol

Every condition is asked to end with `ANSWER: <value or NOT IN DOCUMENT>` and
`CITE: <doc-id> p<page>`. Scoring reads only those lines: numbers are compared
with unit normalization and a per-question tolerance, citations must land on
an anchored page, refusals must say NOT IN DOCUMENT, and short text answers
are matched after normalization. Prose answers that need judgment are the
only place a model grader is used.

## Manifest conventions

Document ids are stable and short (`hdm-chp0200`, `stdspecs-2025`,
`d3-03-3H3904-plans`). Page numbers everywhere are 1-based PDF page indexes,
not printed folios, because that is what a citation checker can verify.
`manifest build` rewrites only the measured fields; edit the curated fields by hand.
