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

## Question sets

| File | What |
|---|---|
| `questions/smoke.jsonl` | 10 questions CI runs on the mock model; anchors only two documents so CI downloads a few MB. |
| `questions/caltrans-v0.jsonl` | The working benchmark set (split `dev` until the dev/test split is frozen). Scope: current HDM chapter files + 2025 Standard Plans and Specifications + DIB 82-06 (designer-framed accessibility questions, ids `dib-*`), plus 100 HDM questions derived from the DIB 78-04 Design Checklist (ids `dib78-*`, anchored to the HDM chapters the checklist cites). |
| `questions/dib78-unused.jsonl` | 143 validated spare questions from the DIB 78-04 checklist pass that duplicate a value or item already in the set; move a line into `caltrans-v0.jsonl` to promote it. |

`caltrans-bench questions stats questions/caltrans-v0.jsonl` prints bucket, answer-type, and document counts.

### Authoring workflow

1. Find the fact: `caltrans-bench corpus grep "<regex>" --docs hdm-chp0300 --pages 1-20` searches the cached
   page text (one hit per page, PDF page numbers); `caltrans-bench corpus page stdspecs-2025 319` prints a page.
2. Write the line: `answer` is the canonical value, `unit` and `tolerance` drive numeric scoring, `aliases`
   widen text matching, and every anchor's `quote` is a short verbatim string from that page. Prefer a quote that
   contains the answer itself. Standard Plans sheet pages are the printed page plus 23.
3. `caltrans-bench questions validate questions/caltrans-v0.jsonl` opens every anchored page and fails the line
   if the quote or table label is not there. Nothing ships unvalidated.
4. Keep the buckets moving toward the target mix in `DATASET_CARD.md` (lookup 60 · multihop 40 · trap 30 · refusal 30).

### Editing in Excel

`questions/caltrans-v0.xlsx` is the same set as an editable workbook: a Questions sheet with dropdowns for bucket,
answer type, split, and document ids, a Docs sheet listing the in-scope documents, a Stats sheet of live counts
against the bucket targets, and a Guide sheet. Add rows in Excel, then bring them back and validate:

```bash
uv run caltrans-bench questions import-xlsx questions/caltrans-v0.xlsx --out questions/caltrans-v0.jsonl
uv run caltrans-bench questions validate questions/caltrans-v0.jsonl
uv run caltrans-bench questions export-xlsx questions/caltrans-v0.jsonl     # regenerate the workbook from JSONL
```

Import refuses to write when a row fails the schema and names the row. The JSONL stays the source of truth.

## Running models through Ollama

Inspect's Ollama provider talks to the local server (`ollama serve`) through its OpenAI-compatible API:

```bash
uv run caltrans-bench smoke --condition rag --model ollama/qwen2.5:0.5b --questions questions/caltrans-v0.jsonl --limit 50
uv run inspect eval caltrans_bench/task.py -T condition=closed_book -T questions=questions/caltrans-v0.jsonl --model ollama/gpt-oss:120b-cloud
uv run inspect view   # browse logs/
```

Any model `ollama list` shows works, cloud-backed ones included.

## Answer protocol

Every condition is asked to end with `ANSWER: <value or NOT IN DOCUMENT>` and
`CITE: <doc-id> p<page>`. Scoring reads only those lines: numbers are compared
with unit normalization (feet-inches, vulgar fractions, ft/m, mph/km/h, psi/MPa)
and a per-question tolerance, citations must land on an anchored page, refusals
must say NOT IN DOCUMENT, and short text answers are matched after
normalization. Prose answers that need judgment are the only place a model
grader is used.

The protocol is strict by default: a reply with no ANSWER line scores 0 and the
`protocol` metric reports how often the line was present. Pass `-T strict=false`
to fall back to the last number in the reply; that mode is lenient enough that a
tiny model echoing retrieved context can score by accident, so use it only for
exploration.

## Manifest conventions

Document ids are stable and short (`hdm-chp0200`, `stdspecs-2025`,
`d3-03-3H3904-plans`). Page numbers everywhere are 1-based PDF page indexes,
not printed folios, because that is what a citation checker can verify.
`manifest build` rewrites only the measured fields; edit the curated fields by hand.
