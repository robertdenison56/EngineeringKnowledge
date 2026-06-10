# Knowledge Workspace App (PRD P0-9)

The first-party web app for viewing and (soon) curating the knowledge graph.

Built today:

- **Dashboard** — knowledge counts by type, recent items, search entry
- **Browse & search** — full-text search with entity-type facet; honest
  empty state when the graph has no answer (mirrors gateway P0-8)
- **Entity pages** — provenance (author, dates, sheet/page/spec anchors,
  source links), review-status badges, superseded warnings with a pointer to
  the replacement, full relationship table, and a clickable SVG
  graph-neighborhood view (seed of the P0-9 graph explorer)
- Stable deep links: `/entities/<id>` — the URLs gateway citations point at

Identity is a fixed dev caller (`demo-firm` / `group:engineering`) so the
app shows exactly the same permission-trimmed view as the MCP gateway;
production replaces it with Entra ID SSO.

```sh
npm run dev --workspace @ekg/web    # http://localhost:3000
```

Next up (per PRD): curation workbench (review queue), guided capture forms,
ingestion setup wizard, and the full graph explorer with filtering.
