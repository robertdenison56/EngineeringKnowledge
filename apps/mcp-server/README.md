# @ekg/mcp-server

MCP gateway for the AEC Engineering Knowledge Graph. One server grounds
Claude, ChatGPT, and Microsoft 365 Copilot in your firm's engineering
knowledge, with provenance on every result.

This v0 package runs on stdio with a seeded demo graph — enough to install,
connect to an MCP client, and evaluate the tool surface. The remote
deployment (Streamable HTTP + OAuth, real graph store) replaces the demo
internals without changing the tools.

## Install

From a packaged tarball (built with `npm run pack:mcp-server` at the repo
root, output in `release/`):

```sh
npm install -g ekg-mcp-server-0.1.0.tgz
ekg-mcp            # starts the gateway on stdio
```

Or point an MCP client at it directly, e.g. Claude Code:

```sh
claude mcp add ekg -- ekg-mcp
```

## Tools

| Tool | Purpose |
|---|---|
| `search` | Search the knowledge graph; results carry provenance, deep links, and warnings on superseded items. Explicit `no_results` state — the model is told never to substitute general knowledge for firm precedent. |
| `fetch` | Full record for an entity, including related entities. |
| `traverse` | Follow typed relationships (`used-in`, `supersedes`, `authored-by`, …) from any entity. |
| `ingest_document` | Add a document (`.pdf`, `.md`, `.txt`) as an **unverified** candidate — same pipeline as the ingestion CLI (classification, PDF text-layer extraction, ADR 0004 honesty statuses). Drawing sheets come back with rendered images so the *calling* model can describe them. |
| `save_description` | Store the calling model's sheet description. Quoted annotations are mechanically grounded against the document text layer; ungrounded ones are flagged for curator review (ADR 0005). |

## Ingest from your assistant — your AI subscription does the reading

Users add documents from inside Claude (or any MCP client): *"Add
`P-204 Pump Room Piping.pdf` to our knowledge base."* The gateway queues the
candidate and returns rendered sheet images; the **user's own model** —
running on their existing AI subscription — describes what is drafted and
calls `save_description`. The gateway needs no LLM API key of its own; it
verifies every quoted annotation against the extracted text layer and flags
anything ungrounded. Everything lands `unverified` in the workspace app's
curation queue.

Sheet rendering requires poppler (`brew install poppler` /
`apt-get install poppler-utils`) on the gateway host; without it, documents
still ingest — images are skipped with an explicit note.

## Demo

Ask your connected assistant: *"How have we detailed curtain-wall firestop
conditions, and what went wrong at Riverside?"* The seeded graph returns the
current detail (rev. 2), flags the superseded rev. 1 with a warning, and
links the lesson learned from the failed mockup — citing sheet A-501.
