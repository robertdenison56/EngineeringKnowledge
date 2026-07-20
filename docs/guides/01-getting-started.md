# 1 · Getting started (set up)

This guide takes you from a fresh clone to a working knowledge graph you can
search in the app and from an AI assistant. It targets **local development** —
the setup an engineer or evaluator runs on their own machine. Org-wide,
multi-user deployment is the [Administration guide](05-admin-guide.md).

## Prerequisites

- **Node.js 20 or newer** (`node --version`). The project deliberately avoids
  native dependencies — the SQLite store uses the built-in `node:sqlite`, and
  drawing-sheet rendering is own code (no poppler/system binary required), so
  there is nothing to compile.
- **git**, and a clone of this repository.
- *(Optional)* an AI assistant that speaks MCP — e.g. Claude Code or the Claude
  desktop app — if you want to ask questions from an assistant rather than only
  the app.

## Install, build, and test

From the repository root:

```sh
npm install      # installs all workspaces (packages, services, apps)
npm run build    # builds core, the SQLite store, ingestion, and the gateway
npm test         # runs unit tests + the MCP smoke tests (stdio and HTTP)
```

`npm test` is also a good smoke check that your environment is sound: it spawns
the gateway, performs the MCP handshake, and runs a real search against the
seeded demo graph — including the ACL-trimming, tenant-isolation, and
superseded-warning behavior. If that passes, everything is wired correctly.

## Run the workspace app

```sh
npm run dev --workspace @ekg/web
```

Open **http://localhost:3000**. On first run the app creates and **seeds a demo
graph** at `apps/web/.data/ekg.db` (a small AEC corpus: projects, design
details, specs, lessons learned, and experts), so the app is never empty. That
SQLite file is the firm's curated knowledge — it survives restarts, and it is
the same database the gateway will serve.

You should see:

- a **dashboard** with a search bar, knowledge counts by type, and recently
  updated items;
- top-nav links to **Browse & search**, **Map**, **Curate**, **Capture**, and
  **Settings**.

Try a search for `curtain wall firestop`. How to read the results — provenance,
review-status warnings, the graph view — is covered in
[Using EKG](02-using-the-app.md).

> **Identity in local dev is fixed.** The app runs as a single development
> identity (`demo-firm` · `user:dev`, in `group:engineering`), shown in the
> top-right of the header. There is no login screen yet — production signs users
> in with Entra ID SSO and trims every read by their real identity. See the
> [Administration guide](05-admin-guide.md#identity-tenants-and-permissions).

## Connect an AI assistant (the stdio gateway)

The simplest way to ground an assistant is the **stdio** transport — a
single-user local gateway. Build first (`npm run build`), then register it.

With **Claude Code**:

```sh
claude mcp add ekg -- node apps/mcp-server/dist/index.js
```

With **Claude Desktop**, add the same command to `claude_desktop_config.json`
— [Guide 6](06-testing-with-claude-desktop.md) has the exact config block plus
a scripted end-to-end test tour.

By default the gateway serves the **seeded in-memory demo graph**. To serve the
**same curated database the app writes to** — so anything you capture or verify
in the app is what the assistant answers from — point it at the app's database:

```sh
EKG_DB_PATH=$PWD/apps/web/.data/ekg.db node apps/mcp-server/dist/index.js
```

Or, when registering it with Claude Code, pass the env vars through:

```sh
claude mcp add ekg --env EKG_DB_PATH=$PWD/apps/web/.data/ekg.db \
  --env EKG_INGEST_ROOT=$HOME/EKG-Inbox \
  -- node apps/mcp-server/dist/index.js
```

`EKG_INGEST_ROOT` is the folder `ingest_document` may read from — path
ingestion is disabled without it (`ingest_root_not_configured`), and relative
paths resolve against it. Skip it if you only want query tools.

Now ask your assistant something like:

> *"How have we detailed curtain-wall firestop conditions, and what went wrong
> at Riverside?"*

The answer comes back grounded in the graph, with citations and a link into the
app for each item — and the superseded revision of the detail comes back **with
a warning**, not as a clean result. That round trip — assistant → gateway →
curated graph → cited answer → verify in the app — is the whole product.

What the gateway exposes (`search`, `fetch`, `traverse`, `find_experts`,
`get_project_context`, plus `propose_knowledge` / `ingest_document` /
`save_description`) is described in [Using EKG](02-using-the-app.md) and
[Adding knowledge](03-adding-knowledge.md).

## The full loop in one place

If you want the complete pipeline — ingest a folder, review it, then serve it:

```sh
# 1. App on :3000, seeds .data/ekg.db on first run
npm run dev --workspace @ekg/web

# 2. Queue a folder of documents as unverified candidates into the app's DB
npm run ingest --workspace @ekg/ingestion -- services/ingestion/samples \
  --db apps/web/.data/ekg.db

# 3. Review at http://localhost:3000/curation → Verify / Reject

# 4. Serve exactly what curators approved
EKG_DB_PATH=$PWD/apps/web/.data/ekg.db node apps/mcp-server/dist/index.js
```

The `services/ingestion/samples` folder holds ready-made fixtures (a spec, a
scanned detail sheet, a drawing with callouts, an RFI, a lesson learned) so you
can exercise ingestion immediately. Details are in
[Adding knowledge](03-adding-knowledge.md).

## Configuration you may want early

All configuration is environment variables — there is no config file to edit.
The ones worth knowing on day one:

| Variable | What it does | Default |
|---|---|---|
| `EKG_DB_PATH` | Path to the curated SQLite database. Set this so the app and gateway share one graph. `:memory:` gives an ephemeral seeded store. | `apps/web/.data/ekg.db` (app) / in-memory demo (gateway) |
| `EKG_EMBEDDINGS_PROVIDER` | Turn on semantic (vector) retrieval: `voyage`, `openai`, or `ollama`. Unset = lexical + full-text search only. | unset |
| `EKG_APP_URL` | Base URL the gateway puts in citation links. | `http://localhost:3000` |
| `EKG_INGEST_ROOT` | Folder `ingest_document` is confined to (alias `EKG_UPLOAD_ROOT`); relative paths resolve against it. Unset = path ingestion disabled (fails closed). | unset (ingestion disabled) |

The full table — including the remote gateway's `EKG_TRANSPORT`,
`EKG_JWT_SECRET`, `EKG_PORT`, and `EKG_AUDIT_LOG` — is in the
[Administration guide](05-admin-guide.md#configuration-reference).

## Troubleshooting

- **The app shows the demo corpus, not my data.** The app seeds the demo graph
  only when the database is empty. If you ingested into a *different* database
  path than the app uses, point both at the same `EKG_DB_PATH`.
- **The assistant answers from general knowledge, not the firm graph.** Confirm
  the gateway is registered and pointed at your database (`EKG_DB_PATH`), and
  that you rebuilt (`npm run build`) after pulling changes — the stdio gateway
  runs the bundled `dist/index.js`.
- **Search feels keyword-only / misses synonyms.** That's expected without an
  embedding provider. See
  [retrieval configuration](05-admin-guide.md#retrieval-and-storage).
- **A scanned PDF ingested as `needs-ocr` with no text.** Expected — image-only
  PDFs are flagged rather than ingested as garbage. See
  [Adding knowledge](03-adding-knowledge.md#what-the-parser-does-and-doesnt-do).

---

Next: **[2 · Using EKG →](02-using-the-app.md)**
