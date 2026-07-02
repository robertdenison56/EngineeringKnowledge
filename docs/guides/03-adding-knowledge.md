# 3 · Adding knowledge

There are three ways to add knowledge to EKG. All three create
**`unverified` candidates** — nothing becomes firm knowledge until a curator
signs off (that's the next guide,
[Curating & refining](04-curating-knowledge.md)).

| Way to add | Best for | Who |
|---|---|---|
| [Capture form](#1-the-capture-form) | A single lesson learned, detail, or note typed by hand | Any engineer; knowledge managers |
| [In-app upload](#1b-in-app-document-upload) | One or many PDF/MD/TXT files, from the browser (`/ingest`) | Any engineer; knowledge managers |
| [Ingestion CLI](#2-the-ingestion-cli-bulk-folders) | A folder of existing documents, from a terminal (admin/dev) | Admins |
| [From your assistant](#3-ingest-from-your-assistant) | "Add this drawing to our knowledge base" or "save this as a lesson learned" while you work | Any engineer with the gateway connected |

All of them converge on the same candidate model and the same review queue.

## 1 · The capture form

The guided form (`/capture` in the app) is the fastest way to record something
that lives in someone's head — most often a **lesson learned**.

Fields:

| Field | Notes |
|---|---|
| **Type** | Lesson learned, design detail, document, material/product, or RFI. |
| **Title** *(required)* | "What happened / what is it?" |
| **Summary** | For lessons learned, write *what happened, the root cause, and the fix* — that's what makes it surface in future relevant queries. |
| **Tags** | Comma-separated facets, e.g. `firestop, curtain-wall, fire-safety`. These power filtering and tag-scoped search everywhere. |
| **Project** | Pick a project to create the `used-in` link at capture time, so the new knowledge shows up in that project's context immediately. |
| **Author** | Who knows this best. If the name matches a known person in the graph, capture creates a real `authored-by` link — which is what lets `find_experts` credit them. |
| **Source URL** | A link back to the source system, if any. |
| **Sheet / Page** | For drawing- or page-specific items, so citations resolve to the right location. |

Submitting lands the item in the **curation queue as `unverified`** and takes
you to `/curation`. It is *not* yet firm knowledge and won't be served cleanly to
assistants until verified.

> **Write lessons for retrieval.** A good summary names the *condition* and the
> *fix* in the words a future engineer would search for. "Parapet flashing leak
> at North Tower — termination bar was omitted at the reglet; require continuous
> termination bar + sealant" will surface; "flashing issue" won't.

## 1b · In-app document upload

`/ingest` in the app (also reachable as **+ Add documents** from the
workbench) accepts one or many PDF/MD/TXT files by drag-drop or file picker,
with optional batch tags. Uploads run through the **same pipeline** as the CLI
and the gateway — classification, text extraction, CAD-native vector parsing,
chunking, cross-sheet reference edges — and land in the curation queue as
`unverified`. This is the intended browser path for adding documents; the CLI
below is for admins working at a terminal.

## 2 · The ingestion CLI (bulk folders)

The ingestion CLI walks a folder, classifies each file, extracts text, splits
long documents into searchable passages, links cross-sheet references, and
queues everything as `unverified` candidates in the shared database.

```sh
npm run ingest --workspace @ekg/ingestion -- <folder> \
  --db apps/web/.data/ekg.db        # write into the app's database
```

Flags:

- `<folder>` — the directory to walk (recursively). Required.
- `--db <path>` — the SQLite database to write into. Use the app's
  (`apps/web/.data/ekg.db`) so candidates show up in the app's curation queue.
- `--tenant <id>` — the tenant to file the candidates under. Defaults to the demo
  tenant.

Try it on the bundled fixtures:

```sh
npm run ingest --workspace @ekg/ingestion -- services/ingestion/samples \
  --db apps/web/.data/ekg.db
```

The CLI prints a summary: how many candidates of each type, how many searchable
passages were indexed, how many scanned PDFs were flagged `needs-ocr`, how many
cross-sheet reference edges it created from callouts/match lines, and any
referenced sheets it couldn't resolve yet. Then review them at `/curation`.

### How files are classified (v0)

Classification is **filename-based and conservative by design** — it makes a safe
first guess and leaves the rest to the curator, rather than inventing structure.

| Filename pattern | Becomes | Location anchor |
|---|---|---|
| MasterFormat number, e.g. `07 84 00 …` | `spec-section` | spec section |
| Drawing sheet number, e.g. `A-501 …` | `document` | sheet |
| `RFI…` | `rfi` | — |
| `Lesson…` | `lesson-learned` | — |
| anything else | `document` | — |

### What the parser does (and doesn't) do

- **Born-digital PDFs**: the full text layer is extracted via pdf.js — searchable
  and verifiable against the source in the app.
- **Scanned / image-only PDFs**: flagged `parseStatus: needs-ocr` instead of
  ingesting garbage. They still become candidates (so they're tracked), but they
  have no text to search until OCR lands. A curator, or an
  [assistant description](#3-ingest-from-your-assistant), can fill the gap.
- **Vector drawing sheets**: get CAD-native parsing — the title block, reading
  order, views, dimensions, match lines, and schedule tables are recovered from
  the geometry, each claim carrying its own method, confidence, and evidence.
  Callout bubbles like `3/S-501` and match-line continuations resolve into
  `references` edges between sheets, so a drawing set becomes a navigable graph
  instead of a pile of files.
- **Long documents** are split into **chunks** — one passage per page (drawings,
  specs) or windowed passages (plain text) — each with its own page / sheet /
  spec-section anchor. The entity keeps a bounded preview; the chunks hold the
  authoritative full text. This is why a 400-page spec book is searchable and
  citable to the page, not truncated.

Every PDF candidate carries `parseStatus` (`extracted` / `needs-ocr` /
`parse-failed`) and `pageCount` so curators can see what was understood.

> **Roadmap:** the folder walk is the v0 source. SharePoint / OneDrive (and
> Procore) sync will replace it with OAuth-connected, ACL-mapped ingestion — the
> candidate model and curation flow stay identical. See the
> [PRD](../../PRD-engineering-knowledge-graph.md) and
> [`services/ingestion/README.md`](../../services/ingestion/README.md).

## 3 · Ingest from your assistant

With the gateway connected, you can add a document **without leaving your
assistant** — "add this drawing to our knowledge base." This uses two gateway
tools, `ingest_document` and `save_description`, and is the path that lets *your
own* AI subscription read a drawing sheet (the gateway never needs an LLM API
key — see [ADR 0005](../decisions/0005-gateway-ingestion-client-model-description.md)).

### `ingest_document`

Hands the gateway a file path and queues it as an `unverified` candidate.

- **`path`** — path to the file **on the machine running the gateway** (`.pdf`,
  `.md`, `.txt`). This is server-local, not your laptop unless the gateway runs
  there — see the note below.
- **`page`** — for drawings, which sheet/page to render (default 1); re-call for
  others.
- **`describe`** — force sheet rendering for description (drawing PDFs that aren't
  auto-detected from a sheet-number filename, e.g. some DOT standard plans).

It returns the queued candidate (id, type, tags, `parseStatus`, page count, any
cross-sheet references it linked), and — **for drawing sheets** — rendered sheet
**images** plus the deterministic facts the parser already extracted (sheet
number, views, dimensions, callouts). The image rendering is own code; no
external binary is required.

### `save_description`

After the assistant *reads* the rendered sheet, it calls `save_description` to
store what it saw:

- **`description`** — plain-language account of what's drafted on the sheet.
- **`annotations`** — labels, dimensions, and callouts **quoted verbatim** from
  the sheet (each one atomic — the bare printed value, e.g. `18'-11"`, not bundled
  with prose).
- **`sheet`** — title-block metadata (number, title, discipline, revision) if
  legible.

The gateway **mechanically checks every quoted annotation** against two
independent sources: the document text layer *and* the deterministic parser
facts captured at ingest. Quotes that match are kept as grounded; the strongest
are flagged as independently confirmed by the geometry parser; quotes that match
neither are flagged **`ungrounded`** and held for curator review — they are *not*
presented to you as facts from the document. (This two-source grounding is
[ADR 0007](../decisions/0007-vlm-fusion.md) /
[ADR 0008](../decisions/0008-parser-vision-collaboration.md).)

The stored description is always **machine-generated and unverified** — it
re-enters the curation queue regardless of how well it grounded.

> **Where the file must live.** `path` is resolved on the host running the
> gateway. On a local stdio setup that's your machine, so a local path works. On
> a [remote gateway](05-admin-guide.md), the file must be reachable by the
> server — this tool is for documents already on (or mounted to) the gateway
> host, not for uploading from a browser (that's [`/ingest`](#1b-in-app-document-upload)).
> Admins can confine the tool to one directory tree with `EKG_INGEST_ROOT`;
> paths outside it are refused.

### `propose_knowledge` — save a lesson from chat

Knowledge that surfaces *in conversation* shouldn't die there. Tell your
assistant *"save this as a lesson learned"* (or a design detail) and it calls
`propose_knowledge` with a title, the substance in your words, tags, and
optionally the project it belongs to — which links it `used-in` that project.
Like everything else, the proposal lands in the curation queue as
`unverified`; the assistant is instructed to say so rather than present it as
firm knowledge (PRD P1-5).

## What happens next

However it got in, a candidate is now `unverified`. It is visible to curators in
the workbench but is **not** served cleanly to assistants. Promoting it — or
correcting and rejecting it — is the curator's job.

---

Next: **[4 · Curating & refining →](04-curating-knowledge.md)**
