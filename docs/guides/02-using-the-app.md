# 2 · Using EKG (find and trust answers)

This guide is for the people who **consume** firm knowledge — project engineers
finding precedent while they work, and QA principals checking that what comes
back is trustworthy. It covers both ways to use EKG: the **workspace app** and a
**connected AI assistant**. They draw on the same curated graph and the same
permissions, so an answer in one is verifiable in the other.

## Two ways in

| You want to… | Use |
|---|---|
| Explore, verify a citation, see the graph around an item | The **workspace app** (http://localhost:3000) |
| Ask a question in natural language while you work | A **connected assistant** (Claude, ChatGPT, Copilot) grounded by the gateway |

The assistant is for asking; the app is for verifying and exploring. Every
assistant citation deep-links into the app.

## The workspace app

### Dashboard

The home page (`/`) is your starting point:

- a **search bar** — type a query and go;
- **Knowledge by type** — a count for each entity type present, each a shortcut
  into a filtered browse;
- **Recently updated** — the most recently changed items, so you can see what
  curation and ingestion have added.

### Browse & search (`/search`)

Search ranks across the whole graph and **into document passages**, not just
titles. A long spec book or multi-sheet plan set is split into per-page /
per-section **chunks**, each independently searchable — so a hit can point at
"page 214" or spec section "07 92 00 · PART 2 — PRODUCTS", not just the file.

- Type a query, optionally filter by **entity type** (the dropdown) or by **tag**
  (click a tag chip anywhere to filter by it).
- A result card shows the title, type, a snippet (the matched passage when the
  hit was inside a document), tags, and a provenance line.
- **When there is no match, EKG says so** — *"The firm graph has no answer for
  '…'."* It does not fabricate a result. That honesty is a core promise: if you
  learn the answer, [capture it](03-adding-knowledge.md) so the next engineer
  finds it here.

### Entity pages (`/entities/<id>`)

Click any result to open its record — this is where you **verify** an answer.

- **Title, type, and a review-status badge** at the top.
- **A warning banner** if the item is superseded or deprecated, with a link to
  the current version where one exists. (More on the lifecycle
  [below](#review-status-trust-at-a-glance).)
- **Summary and tags.**
- **Provenance line** — author, date, review status, source.
- **Source document text** — a collapsible panel with the extracted text, so you
  can check the answer against the *exact* source wording.
- **Document sections** — for long documents, the list of indexed passages, each
  labeled by page / sheet / spec section, so you know what is citable.
- **Graph neighborhood** — an SVG of this item and its first-degree neighbors,
  each clickable. Follow `used-in`, `supersedes`, `authored-by`,
  `complies-with`, `references`, and more.
- **Relationships table** — every link in and out, with the neighbor's type and
  review status.
- **Record** — the raw id, dates, author, and type-specific properties.

### The Map (`/map`)

The Map is the whole graph your identity can see, laid out as an interactive
force-directed view. Scroll to zoom, drag to pan, hover to highlight a
neighborhood, click a node to open it, and toggle entity types and tags to
focus. It's how a QA reviewer **spots gaps, stale items, and undocumented
connections** that a search box would never reveal — e.g. a project with no
lessons learned attached, or a detail nothing references.

### Settings (`/settings`)

Two kinds of things live here:

- **Appearance** — light / dark / system theme and display density, stored on
  your device and applied before first paint (no flash on reload).
- **Read-only status** of the running deployment — your identity (tenant and
  principals), the retrieval mode and storage path, and graph health (entity and
  relationship counts, a breakdown by review status, and a link to anything
  awaiting review). In production these read-only blocks become real controls
  behind the admin/curator role.

## Review status: trust at a glance

Every knowledge item carries one of four review states. This is the heart of
"trustworthy," and it shows up everywhere — badges in the app, and a `warning`
field on assistant results.

| Status | Meaning | How it behaves |
|---|---|---|
| **`unverified`** | Candidate from ingestion, capture, or an assistant. Not yet firm knowledge. | Visible in the app's curation queue; awaits a curator. |
| **`verified`** | A curator approved it. | The trustworthy default — served cleanly. |
| **`superseded`** | A newer version replaces it. | Returned **with a warning** and a pointer to the current version — never silently served. |
| **`deprecated`** | Known-bad / withdrawn. | Returned **with a warning** so the assistant can't propagate a past mistake. |

The point of `superseded`/`deprecated` is that bad knowledge is **flagged, not
hidden**. You still find it (so you understand history), but you're always told
not to rely on it.

## Asking from a connected assistant

Once the gateway is connected (see
[Getting started](01-getting-started.md#connect-an-ai-assistant-the-stdio-gateway)
or, org-wide, the [Administration guide](05-admin-guide.md)), you can ask
questions in natural language. The assistant calls the gateway's tools, gets
grounded results with provenance, and cites them back with links into the app.

### What the gateway can do

The gateway exposes a focused tool surface. You don't call these directly — the
assistant picks them — but knowing what exists helps you phrase questions.

| Tool | Use it to ask… |
|---|---|
| **`search`** | "How have we detailed X?" / "Find lessons learned about Y." Searches the graph and document passages; returns provenance, a link, and a `warning` on stale items. |
| **`fetch`** | (Follow-up) Pull the full record for one item by id — properties, related items, and a specific document section in full, cited to its page/section. |
| **`traverse`** | "What supersedes this?" / "Which projects used this detail?" Follows one relationship from an item. |
| **`find_experts`** | "Who in the firm knows about curtain-wall firestop?" Returns people **with the evidence** — the details, specs, and lessons they authored that match — never an unsupported name. |
| **`get_project_context`** | "Tell me everything about the Riverside project." Assembles one briefing: details and documents used, applicable specs and standards, issues and lessons, the team, and the client. |

### How to read a grounded answer

- **Every claim should carry a citation** — a project, author, date, review
  status, and a link into the app. If it doesn't, treat it as the assistant's
  own words, not firm knowledge.
- **Heed warnings.** A result tagged superseded or deprecated means *don't reuse
  this as-is* — follow the pointer to the current version.
- **"No firm answer" is a real answer.** The gateway instructs the assistant to
  say the firm graph has nothing rather than fall back to generic LLM knowledge.
  If you see a confident answer with **no** firm citation, be skeptical — that's
  general knowledge, not precedent.
- **Click through to verify.** For anything you'll rely on, open the cited
  entity page and check the answer against the **source document text**. The
  responsibility for the deliverable is still yours.

### Good questions to start with

- *"How have we detailed a curtain-wall-to-slab firestop on past projects?"*
- *"Who has worked on mass-timber structures in seismic category D?"*
- *"What lessons learned do we have about parapet flashing?"*
- *"Give me the full context on the Riverside project."*
- *"Is detail cw-firestop-01 still current?"* (expect a superseded warning)

---

Found a gap, or learned something the graph should know? That's the next guide.

Next: **[3 · Adding knowledge →](03-adding-knowledge.md)**
