# Knowledge Workspace App (PRD P0-9)

The first-party web app where firms build, review, and explore the knowledge
graph — and the destination for every gateway citation.

Built today:

- **Dashboard** — knowledge counts by type, recent items, search entry
- **Browse & search** — full-text search with entity-type, tag, and
  review-status facets; honest empty state when the graph has no answer
  (mirrors gateway P0-8)
- **Entity pages** — provenance (author, dates, sheet/page/spec anchors,
  source links), review-status badges, superseded warnings with a pointer to
  the replacement, full relationship table, a clickable SVG graph-neighborhood
  view, and a **curation panel**: inline field editing (title, summary, tags,
  aliases), ACL editing, verify / deprecate / supersede-with-replacement
  lifecycle controls, merge-into-survivor, and relationship add/remove
- **Curation workbench** (`/curation`) — the unverified queue with per-item
  and bulk verify/reject, pagination, and a **Recently rejected** trash with
  one-click restore (reject is a soft delete)
- **Capture form** (`/capture`) — guided entry for lessons learned and design
  details, with project (`used-in`) and author (`authored-by`) linking into
  the graph at capture time
- **Document upload** (`/ingest`) — drag-drop one or many PDF/MD/TXT files
  through the same pipeline as the ingestion CLI and the gateway
- **Knowledge map** (`/map`) — force-directed graph of the visible corpus
- **Settings** — firm name (admin-gated), appearance
- Stable deep links: `/entities/<id>` — the URLs gateway citations point at

Every mutating action (verify, reject, restore, edit, ACL, lifecycle, merge,
relationships, capture, upload, settings) emits a P0-7 audit event with
`transport: "web"` — same schema and, if `EKG_AUDIT_LOG` points there, same
file as the gateway's trail.

Identity is a fixed dev caller (`demo-firm` / `group:engineering` +
`role:admin`) so the app shows exactly the same permission-trimmed view as the
MCP gateway; production replaces it with Entra ID SSO and per-role gating of
the curation controls.

```sh
npm run dev --workspace @ekg/web    # http://localhost:3000
```

First run seeds `.data/ekg.db` with the demo corpus (`EKG_SEED_DEMO=0` to
start empty). The store runs SQLite in WAL mode, so the app, the MCP gateway,
and the ingestion CLI can safely share the database — see
[Guide 6](../../docs/guides/06-testing-with-claude-desktop.md) for the full
loop from Claude Desktop.

Next up (per PRD): SharePoint/OneDrive sync wizard with permission mapping,
richer search facets (project / discipline / date), graph-explorer filters and
progressive loading for large corpora, usage analytics from the audit trail,
and Entra ID SSO with viewer/contributor/curator/admin roles.
