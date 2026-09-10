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
| `tests/` | pytest for scoring, schema, manifest, the Excel round trip, and the `inspect eval` invocation below (run through the real CLI in a subprocess). |

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

`-T name=value` sets any argument of the `caltrans_bench` task in `caltrans_bench/task.py`: `condition`
(`closed_book`, `rag`, `ekg`), `questions`, `split`, `k`, `retriever`, `ekg_db`, `docs` (comma-separated document
ids to retrieve from), `strict`, and `max_chars` (RAG passes retrieved pages whole; set this only to study a
per-passage cap — the old default of 3,000 characters cut the answer off about half of the pages it retrieved).
Citations are scored on manifest document ids; names the EKG gateway exposes instead (entity ids such as
`ingest:e3673a7430de`, file stems such as `chp0200-092923-a11y`) are mapped back through `doc_aliases` so the
citation metric is comparable across conditions. The answer protocol asks for the checked page to be cited even on
a `NOT IN DOCUMENT` answer; every refusal question carries an anchor for exactly that page. Relative `questions` and `ekg_db` paths are taken from this directory, and logs
land in `logs/` (`uv run inspect view` browses them). Everything else (`--limit`, `--max-connections`,
`--no-fail-on-error`, `--log-dir`, …) is a plain Inspect option; `uv run inspect eval --help` lists them.
`caltrans-bench smoke` wraps the same task for CI and only exposes `--condition`, `--model`, `--questions`,
`--split`, `--limit`, and `--log-dir`.

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

## Running on a Claude subscription (no API key): the `claudecode/` provider

`caltrans_bench/claude_code.py` registers `claudecode/<model>` as an Inspect model
provider. It drives Claude Code in headless print mode (the copy bundled with the
Claude desktop app, or `claude` on PATH), so the benchmark bills the Claude
subscription the app is logged into. Log the CLI in once (browser flow):

```bash
"$HOME/Library/Application Support/Claude/claude-code/"*/claude.app/Contents/MacOS/claude auth login
```

then run any condition with `--model claudecode/sonnet` (alias) or
`--model claudecode/claude-sonnet-5`. `closed_book`/`rag` are plain generation with
the harness system prompt and no built-in tools. `ekg` hands the CLI the EKG MCP
gateway over the pinned snapshot and lets Claude Code run the tool loop itself;
the calls it made are recorded on each sample's ModelCall. `--bare` is not used
because it restricts auth to API keys. Knobs: `CALTRANS_CLAUDE_BIN`,
`CALTRANS_EKG_DB`, and model args `-M max_connections=4 -M max_turns=30 -M ekg_db=...`.

## Running on a ChatGPT subscription: the `codex/` provider

`caltrans_bench/codex_cli.py` registers `codex/<model>` (for example `codex/gpt-5.6-sol`) the same
way, driving `codex exec --json` headless. Each sample runs in an empty working directory with its own
hermetic `CODEX_HOME` (only `auth.json` is borrowed from `~/.codex`): shell and unified-exec tools,
web search, ChatGPT connectors ("apps"), the plugin marketplace, browsers, skills, hooks, memories and
multi-agent are all switched off, so `closed_book` really is closed book and `ekg` sees only the
gateway's read tools. The harness system prompt is delivered as the working directory's `AGENTS.md`.
Every tool item Codex reports is kept on the sample (`output.metadata.tool_calls`), and
`foreign_tools` lists anything outside the condition's budget — check it is empty before trusting a
run; a first attempt without these switches used web search and a GitHub connector. Knobs:
`CALTRANS_CODEX_BIN`, `CODEX_AUTH_HOME`, model args `-M reasoning_effort=medium -M max_connections=4
-M ekg_db=...`.

## Plan understanding work (Tier 1: sheet-level extraction)

`caltrans_bench/plans.py` measures how well the ingestion parser (`extractSheetFacts` in
`services/ingestion`) reads a drawing sheet: title block, scales, view labels, match lines,
cross-sheet references, schedules. It follows the question set's discipline — verified gold,
"not printed" as a first-class answer, deterministic scoring — and is the first rung of the
plan-understanding ladder (structured extraction → cross-sheet graph → grounded description →
plan-reading QA → robustness).

| Path | What |
|---|---|
| `plans/gold/sheets-v0.jsonl` | One gold row per PDF page of a plan set (`SheetGold`); `status=todo` rows are unscored. |
| `plans/preds/<doc>.jsonl` | Parser output per page from `scripts/extract-sheet-facts.mjs` (gitignored, regenerate). |
| `plans/scorecards/*.json` | Scorecards; `tier1-dev-baseline.json` is the CI reference. |
| `plans/renders/` | PNG renders for labelling (gitignored). |

Splits are by plan set: `d3-03-3H3904-plans` and `d3-03-2H4504-plans` are dev, the other four
District 3 sets are held out. Labelling workflow:

```bash
uv run caltrans-bench plans template --docs d3-03-2H4504-plans   # todo rows for every page
uv run caltrans-bench plans render d3-03-2H4504-plans 1-27 --dpi 60  # PNGs to read from
uv run caltrans-bench corpus page d3-03-2H4504-plans 2                # text layer to copy strings from
uv run caltrans-bench plans validate                                  # every labelled string must be on the page
uv run caltrans-bench plans extract --docs d3-03-2H4504-plans         # needs `npm run build` at the repo root
uv run caltrans-bench plans score --split dev --out plans/scorecards/tier1-dev.json \
    --baseline plans/scorecards/tier1-dev-baseline.json               # exit 1 on any metric drop
```

Field meanings and the validator's matching rules (letter-spaced CAD text, stacked fractions,
multi-line titles that extract bottom-up) are documented at the top of `caltrans_bench/plans.py`.
Strings the text layer cannot confirm (Revised Standard Plans inserted as outlines) go in
`visual_only`.

### Tier 1b: sheet context (what the sheet is about)

A gold row may carry a `context` block: route, counties and post miles from the title block, every
road name shown, alignment line names, station limits with the line they belong to, structures, and
a short description plus `facts` — short checkable phrases (an identifier, a station, a quantity, a
component) a correct description must contain. Strings are validated against the text layer like the
labels; the description and facts are the labeler's words. Three systems can be scored against it:

```bash
uv run caltrans-bench plans extract --system textlayer --docs d3-03-2H4504-plans   # regex baseline over the page text
uv run caltrans-bench plans score --split dev --preds plans/preds-textlayer         # context section of the scorecard
uv run inspect eval caltrans_bench/plans_task.py -T condition=image -T split=dev --model anthropic/claude-sonnet-5
uv run caltrans-bench plans import-log logs/<log>.eval --out-dir plans/preds-sonnet-image
uv run caltrans-bench plans score --split dev --preds plans/preds-sonnet-image
```

`plans_task.py` conditions: `image` (rendered sheet), `text` (text layer only), `image_text`, and
`image_facts` (image plus the product parser's facts, `-T facts_preds=plans/preds`). Each reply is
also scored in place (sheet id, title, label F1, context F1, fact coverage, valid JSON). The product
parser emits no context yet, so its context row scores as missed by construction — that gap is the
point of the tier. Dimensions and CAD layers are deliberately not Tier 1 fields: the parser returns a
sample of dimensions, so an exhaustive gold list would score the sample size, not the reading.
