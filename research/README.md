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

**A run is one shard of the question set.** `caltrans-v0.jsonl` is dealt into four shards of 97 that each carry
the whole mix, and `-T shard=` picks one (default `a`); `-T shard=all` runs every question. The shard is in the
dataset name (`caltrans-bench:caltrans-v0:a`) and the task metadata, so a 97-question result cannot be read as a
388-question one. See [Run shards](#run-shards).

`-T name=value` sets any argument of the `caltrans_bench` task in `caltrans_bench/task.py`: `condition`
(`closed_book`, `rag`, `ekg`), `questions`, `split`, `shard`, `k`, `retriever`, `ekg_db`, `docs` (comma-separated
document ids to retrieve from), `strict`, and `max_chars` (RAG passes retrieved pages whole; set this only to study
a per-passage cap — the old default of 3,000 characters cut the answer off about half of the pages it retrieved).
The `ekg` condition adds `ekg_tools` (which gateway tools to expose, default `search,fetch,traverse`) plus
`token_limit` and `message_limit` backstops against a runaway tool loop. Every tool schema is re-sent on every
request of the loop, so `find_experts` and `get_project_context` are off by default: no question in the set can
use them, and the two cost about 540 tokens per request. Together with compact tool-result JSON and a section
index that is no longer re-sent on a fetch that already names a section, those changes cut the first six
questions from 79,159 input tokens to 62,251 (-21%) with the same answers and the same 12 tool calls.

Then `search` began citing the passage it matched. A benchmark question tokenizes into a mean 15.2 concepts and
the chunk gate wanted all of them in one passage, which exactly one question in sixty has — so every hit cited a
file and no page (0 of 40 top hits anchored) and the model fetched whole documents back to read what it had
already matched. Citing the best-coverage passage above a floor takes that to 32 of 40, and the six questions
from 62,251 input tokens to 38,606 (**-51% against the 79,159 baseline**) with answers still 1.00 — the model
fetches a section instead of a document, so tool bytes fall 82%.

Then the caller stopped guessing which section to ask for. `search` named the matched passage by heading
("Page 2") and `fetch` takes an ordinal (1), so the model asked for section 0 in every question that fetched at
all, read the wrong page, and fetched again — a wasted payload plus a whole round trip, which re-sends the
schemas, the system prompt and the transcript behind it. A hit now carries `passageSection`, the ordinal `fetch`
wants, for about five tokens. Search results also stopped repeating what the response can say once: the shared
source prefix folds into a response-level `sourceRoot` (`sourceRoot` + a result's `sourceUrl` is the URL that
came back before), and `partial` keeps the missing concepts — what a caller has to be able to name — while the
matched list becomes a count. A ten-hit search goes 2,786 to 2,376 tokens (-15%); the benchmark's keyword
searches return two hits, so that one shows up for the clients that get ten, not here.

Removing the wasted fetch took the six questions from 36,832 to 23,098 tokens (-37%) and answers from 1.00 to
0.83. The fetch it removed was load-bearing for one question: HDM page 2 is a sight-distance table whose
extracted header reads "(1) (2) Passing Design Speed Stopping", and page 1 is what says the first column is
stopping — so a model reading only the cited page answered 2,700 ft where the standard is 930, four runs out of
four. A section fetch therefore carries `precededBy`, the tail of the passage before it, labelled with its own
ordinal and anchor. Reading order is the point: the same bytes placed *after* the cited text still answer 2,700,
and 400 characters is not enough because the tail of HDM page 1 defines *passing* sight distance. At about a
page, ahead of the text, the six questions cost **25,297 tokens (-31% against 36,832)** with answers 1.00 on
three consecutive runs, in 11 tool calls over 17 requests rather than 16 over 22.

Token figures from here on are every request's full prompt, uncached, counted with `o200k_base`. The same build
reads 38,606 in the paragraph above and 36,832 here: an accounting difference in how much of each tool
definition is counted (~5%), not a change in the loop. Comparisons stay inside one convention.

### Retrieval quality

`scripts` in this directory do not cover it yet, but the number that matters most is measurable without a model:
run every question through the gateway's `search` and ask whether the anchored page came back. Before page-first
ranking (ADR 0013) the gateway returned the gold **document** for 84.8% of the 388 questions and the gold **page**
for 60.8%, while plain BM25 over the same passages — `caltrans_bench.rag.PageIndex`, 40 lines — returned the page
for 93.8%. The answering text is in the store for 387 of 388 questions, so that gap was ranking, not the corpus.

With page-first ranking: document at rank 1 **89.7%**, document in the returned list **99.0%**, page at rank 1
**76.0%**, page in the list **83.2%** (BM25 reference: 85.1%/96.9% document and 68.3%/90.7% page at 1 and 5).
The gateway is ahead at rank 1 and behind across the list, because it returns one page per document where BM25
returns five pages.

End to end on 60 questions (`--limit 60`, gemma4:31b-cloud): answer 80.0% → **90.0%**, citation 46.7% → **85.0%**,
tokens 19,419 → **15,198 per question**. Better ranking is cheaper: the model stops searching twice for what the
first search should have returned.

Two gateway settings (passed through by `gateway_env`) tune the rest, both off by default:

- `EKG_SEARCH_PASSAGES` — how many top results carry their cited passage in full. At 2 the six questions cost
  16,238 tokens (-79%) in 6 tool calls instead of 16, but answer accuracy fell to 0.83: reading a multi-column
  table straight from the passage, the model took the *passing* column (2,700 ft) where the question asked for
  *stopping* (930 ft). Cheap, and a table-reading risk for a small model.
- `EKG_FETCH_PREVIEW_CHARS` — how much body a `fetch` without a `section` returns (unset = the stored body). A
  grounding lever, not a budget one: at 2,000 those six went from citation 0.00 to 0.67 and from 62k tokens to
  123k, because the model made 2.3x the tool calls and every extra round re-sends the transcript.

Both want a full run before either default moves.
Citations are scored on manifest document ids, and `doc_aliases` maps every name that identifies exactly one
document onto its id, so the metric is comparable across conditions: the manifest id, the gateway's entity id
(`ingest:e3673a7430de`) and file stem (`chp0200-092923-a11y`), the printed title ("2025 Standard
Specifications"), and an HDM chapter named by a section number ("HDM Table 201.1" is chapter 200, Caltrans
numbering). A name that fits more than one document resolves to nothing rather than to a coin flip — a bare
`HDM` is 38 chapters, and `Standard Specifications` without an edition is two.

Do not read a low citation score as an alias gap; it was measured and it is not. Across 2,842 scored answers
the richer map (150 alias keys to 445) and the parser fix that reads the document in front of the page rather
than the token touching it — `HDM Table 309.2A p6` used to cite a document called `A` — take item resolution
from 33% to 60% and the citation metric from 13.2% to 13.3%. Almost everything that newly resolves cites the
**right document and the wrong page**: 577 items against 393 right. `rag` scores 43.6% because its context is
page-labelled; `ekg` scores 2.3% because models name the manual rather than the id they were handed
(gemma4 answers all six of the first questions correctly and writes `CITE: HDM p2` every time).

The answer protocol asks for the checked page to be cited even on
a `NOT IN DOCUMENT` answer; every refusal question carries an anchor for exactly that page. Relative `questions` and `ekg_db` paths are taken from this directory, and logs
land in `logs/` (`uv run inspect view` browses them). Everything else (`--limit`, `--max-connections`,
`--no-fail-on-error`, `--log-dir`, …) is a plain Inspect option; `uv run inspect eval --help` lists them.
`caltrans-bench smoke` wraps the same task for CI and only exposes `--condition`, `--model`, `--questions`,
`--split`, `--shard`, `--limit`, and `--log-dir`.

## Question sets

| File | What |
|---|---|
| `questions/smoke.jsonl` | 10 questions CI runs on the mock model; anchors only two documents so CI downloads a few MB. |
| `questions/caltrans-v0.jsonl` | The working benchmark set, 388 questions in 4 run shards of 97 (split `dev` until the dev/test split is frozen). Scope: current HDM chapter files + 2025 Standard Plans and Specifications + DIB 82-06 (designer-framed accessibility questions, ids `dib-*`), plus 100 HDM questions derived from the DIB 78-04 Design Checklist (ids `dib78-*`, anchored to the HDM chapters the checklist cites). |
| `questions/dib78-unused.jsonl` | 143 validated spare questions from the DIB 78-04 checklist pass that duplicate a value or item already in the set; move a line into `caltrans-v0.jsonl` to promote it. |

`caltrans-bench questions stats questions/caltrans-v0.jsonl` prints bucket, answer-type, document, and shard
counts; `--shard a` restricts every `questions` subcommand to one shard.

### Run shards

A shard is a run-sized piece of the set, not a split. Every shard is dealt from the same population so that it
carries the whole mix — the four hold 70/71 lookup, 10/11 multihop, 7 trap and 9 refusal each, across 15–16 of the
20 anchored documents — which is what makes one shard a usable estimate of the set and two shards comparable to
each other. Nothing is held out: all 388 questions are still `split=dev`.

The reason to run one is cost and survival. A full sweep is four times the price of a shard, and the runs that
have actually been cut short were cut by a provider cap part way down a 388-question list — a Codex run died at
252, a free-plan Gemma run at 45 — leaving a prefix that over-weights whatever the file happened to list first.
A shard that finishes is worth more than a full run that does not, so the default is one shard and the whole set
is the thing you ask for:

```bash
uv run inspect eval caltrans_bench/task.py -T condition=rag --model anthropic/claude-sonnet-5                  # shard a, 97 questions
uv run inspect eval caltrans_bench/task.py -T condition=rag -T shard=c --model anthropic/claude-sonnet-5       # another shard
uv run inspect eval caltrans_bench/task.py -T condition=rag -T shard=all --model anthropic/claude-sonnet-5     # all 388
```

The deal is deterministic and lives in the JSONL as a `shard` field, so a run is reproducible from the committed
file. `questions shard` recomputes it and rewrites those fields in place (section comments and field order
untouched); re-run it after adding questions. Do not set a letter by hand: the balance is a property of the whole
deal, and one question moved by hand is one bucket the shards no longer agree on.

```bash
uv run caltrans-bench questions shard questions/caltrans-v0.jsonl --dry-run   # print the deal, write nothing
uv run caltrans-bench questions shard questions/caltrans-v0.jsonl
```

The shard count follows the 100-question cap rather than being fixed at four, so a set that grows past 400 is
dealt into five. That re-deals every letter: a shard identifies a way to run the set, not a stable cohort, and an
old run is identified by the question ids it covered. `test_stratify_is_deterministic_and_matches_the_committed_file`
fails if the file and the deal drift apart.

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
