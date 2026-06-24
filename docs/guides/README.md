# EKG Guides

How to **set up, use, add to, and refine** the Engineering Knowledge Graph (EKG).

EKG has two surfaces that share one curated database:

- **The workspace app** (`apps/web`) — where people browse, search, capture, and
  curate firm knowledge, and where every assistant citation lands so it can be
  verified.
- **The gateway** (`apps/mcp-server`) — an MCP server that grounds the AI
  assistants the firm already uses (Claude, ChatGPT, Microsoft 365 Copilot) in
  that same knowledge, with provenance on every answer.

Everything one engineer verifies in the app is exactly what the assistants
serve — there is one graph, one review status, one set of permissions.

## Who reads what

These guides are organized around the four things you do with EKG, mapped to the
[product personas](../../PRD-engineering-knowledge-graph.md#users--personas).

| Guide | What it covers | Primary persona |
|---|---|---|
| [1 · Getting started](01-getting-started.md) | **Set up** — install, build, run the app, run the gateway, connect an assistant | Everyone (local dev) |
| [2 · Using EKG](02-using-the-app.md) | **Use** — search, browse, the map, entity pages, provenance & warnings, and asking from a connected assistant | Project Engineer (Priya), QA Reviewer (Elena) |
| [3 · Adding knowledge](03-adding-knowledge.md) | **Add** — the capture form, the ingestion CLI, and ingesting from your assistant | Knowledge Manager (Marcus), any engineer |
| [4 · Curating & refining](04-curating-knowledge.md) | **Refine** — the curation workbench, the review lifecycle, tags, supersede/deprecate, and how to keep answers trustworthy | Knowledge Manager (Marcus), QA Reviewer (Elena) |
| [5 · Administration](05-admin-guide.md) | **Operate** — the remote gateway, identity/tenants/ACLs, audit logs, retrieval config, and connecting assistants org-wide | IT / Security Admin (Dana) |

New here? Read them in order — each builds on the last. Just want to try it on
your laptop? [Getting started](01-getting-started.md) gets you to a working
search in a few minutes.

## The core idea, in one minute

1. Documents and lessons enter as **`unverified` candidates** — from a folder
   walk, the capture form, or an assistant.
2. A **curator verifies, corrects, or rejects** each candidate in the workspace
   app. Nothing reaches "firm knowledge" without sign-off.
3. The **gateway serves only what curators approved**, trimmed to what the
   calling user is allowed to see, with **provenance and a source link on every
   result**.
4. Superseded or known-bad knowledge is **flagged, not hidden** — and when the
   graph has no answer, the assistant is told to **say so** rather than
   substitute generic knowledge.

> EKG grounds answers and shows where they came from. Engineering judgment and
> responsibility remain with the Engineer of Record — the app says so in its own
> footer, and so do these guides.

## Current build status

This is the Phase 1 / early Phase 2 build. Where a flow differs between the
local development build and the intended production behavior (single sign-on,
role-gated curation, source-system sync), the guides say so explicitly rather
than implying a capability that isn't there yet. See the
[PRD](../../PRD-engineering-knowledge-graph.md) for the full roadmap and the
[decision records](../decisions/) for the "why" behind each design choice.
