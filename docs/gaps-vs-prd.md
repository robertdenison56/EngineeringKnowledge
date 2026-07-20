# GUI coverage gaps vs. PRD

**As of 2026-06-17 · build: Phase 1 / early Phase 2**

A backlog of the places where EKG's current build forces a **user** onto the CLI
or "the data layer" for a task the [PRD](../PRD-engineering-knowledge-graph.md)
says belongs in the workspace app GUI.

## The principle being measured

> Assistants are the primary *query* surface; the app is the primary *build,
> review, and visualization* surface. — PRD **P0-9**

The working rule: **every user interaction should have a GUI; the CLI is for
admin setup only** (running the gateway, identity/secrets, embeddings, tokens —
see the [Administration guide](guides/05-admin-guide.md)). The folder-walk
ingestion CLI is explicitly a v0 stand-in — *"SharePoint/OneDrive OAuth sync
replaces the folder walk"* ([`services/ingestion/README.md`](../services/ingestion/README.md)),
so it does **not** count as the steady-state user path.

**Verdict:** the principle is the PRD's own intent, but the current build does
not yet meet it. Several core curation actions remain GUI-absent.

> **Update 2026-06-23 — G1 + interim G2 shipped.** In-app document upload now
> exists at [`/ingest`](../apps/web/src/app/ingest/page.tsx): drag-drop or pick
> one-or-many PDF/MD/TXT files, which run through the **same** `buildCandidate`
> pipeline as the CLI and gateway and land in the curation queue as
> `unverified`. This closes G1 and the interim multi-file slice of G2; the full
> SharePoint/OneDrive OAuth **sync wizard** (G2 step 2) is still pending.

> **Update 2026-07-02 — G3, G4, G5, G6 shipped; G7 and G9 partial.** The
> entity page gains a *Curate this item* panel
> ([`CurationPanel.tsx`](../apps/web/src/app/entities/%5Bid%5D/CurationPanel.tsx)):
> inline field editing (G4), an ACL editor (G6), supersede-with-replacement +
> deprecate lifecycle controls (G5), merge with edge repointing (G3 — the
> store gained `deleteRelationship`/`mergeEntities`), and relationship
> add/remove. The workbench gains bulk verify/reject, pagination past the old
> 500-item silent truncation, and a soft-delete trash with restore. Capture
> links `used-in` (project select) and `authored-by` (person-matched author)
> at entry — the G9 type-ahead slice. Search gains a review-status facet (G7
> slice; project/discipline/date facets still pending). Every app mutation now
> emits a P0-7 audit event (transport `web`) into the same trail as the
> gateway, with snapshots on destructive actions. Still open: G2 (SharePoint
> wizard), G7/G8 depth, G10 (analytics dashboard), G11 (roles/SSO).

> **Update 2026-07-19 — G7 and G8 closed.** Search gains the full PRD facet
> set (project / discipline / MasterFormat section / date range on top of
> type / tag / review status), all pure post-filters so P0-8 honesty is
> unchanged. The knowledge map gains relationship-type, review-status, and
> discipline filters plus a progressively-loaded **focus mode**
> (`/map?focus=<id>&depth=1|2`, BFS over `neighbors`, capped) that replaces
> whole-graph loading at scale; entity pages deep-link into it. Still open:
> G2 (SharePoint wizard), G10 (analytics dashboard), G11 (Entra SSO E2E).

## Coverage matrix

Legend: ✅ GUI exists · 🟡 GUI partial · ❌ no GUI (CLI / data-layer / assistant only)

| User interaction | State | PRD ref | Gap ID |
|---|:--:|---|---|
| Search / browse | ✅ | P0-9 faceted search | [G7](#g7--thin-search-facets) |
| Explore graph (map + neighborhood) | ✅ | P0-9 graph explorer | [G8](#g8--graph-explorer-filters--scale) |
| View entity + provenance | ✅ | P0-9 entity pages | — |
| Capture lesson / detail by hand | 🟡 | P0-9 guided capture | [G9](#g9--guided-capture-without-type-ahead-linking) |
| Verify / reject a candidate | ✅ | P0-9 workbench | [G3](#g3--curation-workbench-is-verifyreject-only) |
| **Add a document (upload)** | ✅ | P0-2, P0-9 | [G1](#g1--no-in-app-document-upload) |
| **Bulk ingest a folder / source** | 🟡 | P0-2, P0-9 wizard | [G2](#g2--no-ingestion-setup-wizard-or-bulk-import-gui) |
| **Edit / correct an entity** | ✅ | P0-1, P0-9 inline edit | [G4](#g4--no-inline-entity-editing) |
| **Merge duplicates** | ✅ | P0-9 merge | [G3](#g3--curation-workbench-is-verifyreject-only) |
| **Set tags / aliases on an item** | ✅ | P0-1, P0-9 | [G4](#g4--no-inline-entity-editing) |
| **Mark superseded / deprecated** | ✅ | P0-1 lifecycle, P0-8 | [G5](#g5--no-gui-for-the-supersededdeprecated-lifecycle) |
| **Set / confirm an item's ACL** | ✅ | P0-2, P0-9 curator | [G6](#g6--no-gui-for-aclpermission-curation) |
| Usage analytics (top / zero-result / cited) | ❌ | P1-4 | [G10](#g10--no-usage-analytics-dashboard-p1) |
| Roles & SSO sign-in | 🟡 | P0-9 roles, P0-7 | [G11](#g11--no-roles-or-sso-auth) |
| Gateway / SSO / embeddings / tokens | ⚙️ CLI | Admin setup | *out of scope (allowed)* |

---

## P0 gaps — break the "GUI for every user" rule

### G1 · No in-app document upload

- **Status: ✅ Shipped (2026-06-23)** — [`/ingest`](../apps/web/src/app/ingest/page.tsx)
  + [`actions.ts`](../apps/web/src/app/ingest/actions.ts). Upload writes to a
  managed `.data/uploads/<uuid>/` location and runs the existing `buildCandidate`
  pipeline via `store.upsertEntity(entity, chunks)`; result lands in the curation
  queue. Body-size limit raised in `next.config.mjs` (25 MB); `pdfjs-dist` kept
  external. The original-text below is retained for history.
- **PRD:** P0-2 *"manual… ingestion"*; P0-9 the app is the *"build"* surface.
- **Persona:** Knowledge Manager (Marcus), any engineer.
- **Now:** No file-upload control exists in the app (`apps/web/src/app/**` has no
  `type="file"`, no upload route). The capture form
  ([`capture/page.tsx`](../apps/web/src/app/capture/page.tsx)) is structured-text
  only — it can create a `document` *entity* with no actual document attached. The
  only ways to add a real file are the [ingestion CLI](#g2--no-ingestion-setup-wizard-or-bulk-import-gui)
  or the gateway's `ingest_document`, which requires the file to already exist on
  the server host.
- **Impact:** A user in a browser cannot add a PDF. This is the most direct
  violation of the principle.
- **Approach:** Add an upload control (on `/capture` or a new `/ingest` page) that
  POSTs the file to a server action, writes it to a temp/managed location, and
  runs the **existing** `buildCandidate` pipeline — it's already a shared library
  (`@ekg/ingestion`, used by both the CLI and the gateway), so this is wiring, not
  new parsing. Result lands in the curation queue exactly as today.
- **Effort:** **M.** Reuses `buildCandidate` + `store.upsertEntity(entity, chunks)`.
  Needs file-size/type handling and a storage location decision.

### G2 · No ingestion setup wizard or bulk-import GUI

- **Status: 🟡 Steps 1 + 3 shipped — step 2 (SharePoint sync) pending.** The
  `/ingest` page accepts **multiple files at once** (step 1, 2026-06-23) and now
  also **imports a project list from CSV** (step 3, 2026-06-24): paste or upload a
  register, rows become `project` candidates keyed on project number, malformed
  rows reported not guessed ([`csv.ts`](../services/ingestion/src/csv.ts), tabbed
  UI in [`IngestTabs.tsx`](../apps/web/src/app/ingest/IngestTabs.tsx)). The
  **source-connector seam** that step 2 plugs into also landed —
  `SourceConnector` + `planSync` change detection + a `FolderConnector` reference
  impl ([`source.ts`](../services/ingestion/src/source.ts)) — so the SharePoint
  build is a new connector, not a new ingestion path. Still pending: step 2
  proper (SharePoint/OneDrive OAuth connector + scheduled sync + sync-health
  panel).
- **PRD:** P0-9 *"Ingestion setup wizard: connect a source (SharePoint…), pick
  libraries/projects, confirm permission mapping, and monitor sync health —
  designed so Marcus can do it without IT after initial OAuth consent."* P0-2
  *"OAuth connection to SharePoint/OneDrive… CSV/bulk import for project lists."*
- **Persona:** Knowledge Manager (Marcus) — explicitly *without IT*.
- **Now:** Bulk ingestion is CLI-only:
  `npm run ingest --workspace @ekg/ingestion -- <folder> --db …`
  ([`services/ingestion/src/cli.ts`](../services/ingestion/src/cli.ts)). No
  source-connector UI, no CSV import, no sync-health view.
- **Impact:** The intended primary growth path for the graph is a CLI command a
  knowledge manager shouldn't have to run. Also blocks the "admin deploys, then
  Marcus self-serves" model.
- **Approach (phased):**
  1. *Now:* a **folder/multi-file upload + run** page wrapping the same pipeline
     as G1 (closes the immediate self-serve gap without the SharePoint work).
  2. *Next:* the SharePoint/OneDrive OAuth connector + scheduled sync + a sync
     health panel (this is the larger P0-2 build the README already anticipates).
  3. CSV bulk import for project lists (small, standalone).
- **Effort:** **L** for the full wizard; **M** for the interim upload page (overlaps G1).

### G3 · Curation workbench is verify/reject only

- **Status: ✅ Shipped (2026-07-02)** — bulk verify/reject + pagination on the
  workbench, journaled undo of every operation (a mistaken reject restores
  fields, passages, and edges from *Recent changes*), and merge with field
  union + edge repointing via the `deleteRelationship`/`mergeEntities`
  store primitives — all gated by a server-side `isCurator` check. (A
  diff-style preview against the survivor remains a nice-to-have.)
- **PRD:** P0-9 *"Curation workbench: queue… with accept / **edit** / **reject** /
  **merge** actions, diff-style preview against existing entities, and bulk
  operations; median time to process an item < 2 minutes."*
- **Persona:** Knowledge Manager (Marcus), QA Reviewer (Elena).
- **Now:** [`curation/actions.ts`](../apps/web/src/app/curation/actions.ts) exposes
  `verifyEntity` (→ `verified`) and `rejectEntity` (→ delete). No edit, no merge,
  no diff preview, no bulk select. The [curation guide](guides/04-curating-knowledge.md)
  candidly notes refinements are *"done at the data layer or via re-capture."*
- **Impact:** Correcting a misclassified candidate, deduping, or tagging before
  verify all require non-GUI work — directly against the < 2-min throughput
  target.
- **Approach:** Inline edit (see G4); a **merge** action; bulk-select for verify/reject.
  Note: `GraphStore` has `upsertEntity`/`deleteEntity` but **no `deleteRelationship`
  and no edge-repoint primitive** — merge needs a small store extension to repoint
  the loser's relationships onto the survivor and remove the duplicate's edges.
- **Effort:** **M** (edit + bulk); **L** (merge with diff preview + store work).

### G4 · No inline entity editing

- **Status: ✅ Shipped (2026-06-24)** —
  [`EntityEditor.tsx`](../apps/web/src/components/EntityEditor.tsx) +
  [`entities/[id]/actions.ts`](../apps/web/src/app/entities/[id]/actions.ts). A
  curator opens an inline editor on the entity page to correct title, type,
  summary, **tags**, and **aliases**; edits go through `upsertEntity` with no
  `chunks` argument so a field change never wipes a document's indexed passages
  (ADR 0006). Relationships can be added and removed inline. The editor is
  gated by a server-side `isCurator` check on the request's authenticated
  caller ([`lib/auth.ts`](../apps/web/src/lib/auth.ts)).
- **PRD:** P0-1 *"Curators can create/edit/merge entities and relationships via the
  workspace app."* P0-9 entity pages *"inline editing for users with curator role."*
- **Persona:** Curator.
- **Now:** [`entities/[id]/page.tsx`](../apps/web/src/app/entities/[id]/page.tsx) is
  fully read-only. There is no UI to fix a title/type/summary, edit **tags** or
  **aliases**, or add/remove relationships after creation.
- **Impact:** Aliases (domain synonyms — central to AEC retrieval) and tags can be
  set at capture but never corrected later in the GUI; the same field-edit gap
  underlies G3.
- **Approach:** A curator-gated edit form on the entity page calling a server
  action that mutates fields via `store.upsertEntity`, and `store.upsertRelationship`
  for adding edges. All primitives exist except relationship deletion (see G3).
- **Effort:** **M** (field edit); **+S** once roles (G11) exist to gate it.

### G5 · No GUI for the superseded / deprecated lifecycle

- **Status: ✅ Shipped (2026-07-02)** — lifecycle buttons (verify / back to
  queue / deprecate) and *Superseded by…*, which flags the item and creates
  the `supersedes` edge from the chosen replacement.
- **PRD:** P0-1 review status `unverified`/`verified`/`superseded`/`deprecated`;
  P0-8 *"Items flagged superseded/deprecated are returned only with a prominent
  warning."*
- **Persona:** Curator, QA Reviewer.
- **Now:** Only `unverified → verified` (verify) and delete (reject) transitions
  are exposed. The states are honored everywhere they're read (app badges +
  gateway warnings), but there is **no control to set them**. Marking a detail
  superseded — the core "flag, don't delete" safety behavior the product is sold
  on — requires data-layer edits.
- **Impact:** The trust mechanism can be *displayed* but not *operated* from the
  GUI. High symbolic + practical severity.
- **Approach:** On the entity page (and/or workbench), a "supersede with…" action
  that sets the old item's `reviewStatus = 'superseded'` (`upsertEntity`) and
  creates a `supersedes` relationship from the replacement (`upsertRelationship`)
  — both primitives already exist — plus a simple "deprecate" toggle.
- **Effort:** **S–M.**

### G6 · No GUI for ACL / permission curation

- **Status: ✅ Shipped (2026-07-02)** — visibility is **captured at ingestion**
  (the upload form and CSV importer carry a public / restricted-to-principals
  control that becomes the item ACL), shown everywhere (`AccessBadge`, the
  entity record's "Access" row), and **re-editable** from the entity page's
  *Access & relationships* panel (`updateAcl`, curator-gated + journaled).
  Source-mapped defaults still arrive with G2's SharePoint sync.
- **PRD:** P0-2 *"Source-system permissions… stored as item ACLs."* P0-9 curator
  role; P0-7 ACL enforcement.
- **Persona:** Curator; overlaps IT/Security Admin (Dana).
- **Now:** ACL enforcement works (data layer) and visibility is captured + shown
  at ingestion (above); what's missing is **re-editing** an existing item's
  `allowedPrincipals` from the GUI.
- **Impact:** A curator can't confirm/restrict visibility of sensitive material
  (e.g. legal, client-confidential) before verifying — the review checklist in the
  [curation guide](guides/04-curating-knowledge.md#permissions-and-acls) asks them
  to do exactly that with no tool to do it.
- **Approach:** Show the ACL on the entity/workbench detail and allow editing
  `allowedPrincipals` via `upsertEntity`; longer term, drive defaults from
  source-system mapping (ties to G2 SharePoint sync).
- **Effort:** **M** (manual editor); **L** (mapped from source).

---

## P1 gaps — degrade the experience, not strictly CLI-forcing

### G7 · Thin search facets

- **PRD:** P0-9 *"filters (project, discipline, MasterFormat section, review
  status, date range)."*
- **Status: ✅ shipped (2026-07-19).** `/search` now carries the full PRD facet
  set on top of type/tag: **review status**, **project** (the project plus its
  1-hop graph neighborhood via `GraphStore.neighbors` — used-in details,
  had-issue lessons, applies-to specs, either direction), **discipline**
  (`properties.discipline`; dropdown options derive from the live result set so
  it only ever offers refinements that exist), **MasterFormat section** (prefix
  match on canonicalized codes — "07", "07 84", "07-84-00", and "078400" all
  hit the same anchors, whether on the entity or on the matched passage), and
  **date range** (inclusive bounds over `provenance.modifiedAt`).
- Every facet is a pure post-filter ([`facets.ts`](../apps/web/src/lib/facets.ts),
  unit-tested in [`facets.test.mjs`](../apps/web/test/facets.test.mjs)), so the
  P0-8 honest no-results gate and role boosting are untouched — and when facets
  hide everything, the empty state says *"N matches — all hidden by your
  filters"* with a clear-filters link, never a false *"no answer."*
- **Section-facet semantics (deliberate):** a multi-section document carries a
  section per *passage*, so the facet is per-hit — it accepts the entity's own
  anchor/`masterformat` **or the anchor of the passage the hit matched on**.
  Searching with a section facet therefore follows the real section breakdown
  of chunked spec books. In query-less *browse* mode there is no matched
  passage, so only entity-level sections apply (one bucket per file); true
  passage-level browse faceting would need a chunk-aware `list()` in the store
  and is deferred until a real corpus demands it.

### G8 · Graph explorer filters & scale

- **PRD:** P0-9 *"filter by entity type, relationship type, discipline, project,
  and review status… usable on 100k+ entities… progressive loading, not a hairball."*
- **Status: ✅ shipped (2026-07-19).** [`GraphMap.tsx`](../apps/web/src/components/GraphMap.tsx)
  now filters by entity type, **relationship type**, **review status**,
  **discipline**, and tag; the project axis is served by focus mode (focus on
  the project entity). For scale, [`/map?focus=<id>&depth=1|2`](../apps/web/src/app/map/page.tsx)
  renders a **progressively-loaded neighborhood** — breadth-first over the same
  `GraphStore.neighbors` primitive the MCP traverse tool uses, capped at the
  150 nearest nodes, ring-internal edges included — so cost scales with the
  neighborhood, not the corpus. The overview keeps its 1,000-entity window and
  now says so when truncated; entity pages deep-link into focus mode
  (*"Explore this neighborhood in the knowledge map"*).
- Remaining beyond demo scale: a store-side batched neighborhood query if
  per-node `neighbors` round-trips ever bite at true 100k+ corpora.

### G9 · Guided capture without type-ahead linking

- **PRD:** P0-9 *"structured entry for LessonLearned and DesignDetail… with
  type-ahead linking to existing projects, standards, and people."*
- **Now:** [`capture/page.tsx`](../apps/web/src/app/capture/page.tsx) takes free-text
  author and tags; it cannot **link** to existing project/standard/person entities,
  so captured items arrive unconnected to the graph. (It also offers
  `document`/`material`/`rfi` types the PRD doesn't scope to guided capture.)
- **Approach:** Type-ahead pickers backed by `store.search`/`list`, creating
  relationships on submit (`upsertRelationship`). **Effort: M.**

### G10 · No usage-analytics dashboard (P1)

- **PRD:** P1-4 *"query themes, zero-result queries, citation counts, per-gateway
  adoption"* (user story 11).
- **Now:** The data exists in the gateway audit JSONL
  ([`audit.ts`](../apps/mcp-server/src/audit.ts)), but reading it is an admin/CLI
  task — there's no in-app view. Also blocks the "entity pages show 'cited in
  answers' usage count" item in P0-9.
- **Approach:** Ingest audit events into a queryable store and surface a dashboard;
  derive per-entity citation counts. **Effort: L.**

### G11 · No roles or SSO (auth)

- **Status: 🟡 Identity substrate shipped (2026-06-28); Entra SSO end-to-end
  pending.** Every page and server action now resolves a per-request caller via
  [`lib/auth.ts`](../apps/web/src/lib/auth.ts) (`resolveCaller`): an
  Entra/"Easy Auth" `x-ms-client-principal` header maps to principals, groups,
  and admin/curator roles (`EKG_ADMIN_GROUP`/`EKG_CURATOR_GROUP`), and an
  unauthenticated **production** request fails closed. `DEV_CALLER` survives
  only as the local-dev fallback (`EKG_DEV_AUTH=1`/non-prod). Curator/admin
  actions (G3–G6, settings) re-check the role server-side.
- **PRD:** P0-9 *"viewer / contributor / curator / admin roles; sign-in via Entra
  ID SSO."* P0-7 per-request identity.
- **Still open:** deploying behind real Entra ID SSO end-to-end (the identity
  proxy that sets the header), plus the gateway's OAuth 2.1 federation
  ([ADR 0011](decisions/0011-gateway-oauth-entra-federation.md)).
- **Note:** SSO/token plumbing is **admin setup** (allowed CLI); the role-gated
  GUI actions it feeds are live. **Effort: M** for the remaining SSO deployment
  (the verifier swap is already scoped in
  [`auth.ts`](../apps/mcp-server/src/auth.ts)).

---

## Suggested sequencing

A pragmatic order that closes the principle-breaking gaps first and reuses the
most existing code:

1. ~~**G1 + interim G2** — in-app upload running the existing `buildCandidate`
   pipeline. One change closes "can't add a document in a browser."~~ **✅ Done
   2026-06-23** (`/ingest` single + multi-file upload).
2. ~~**G4 + G5** — inline entity edit + supersede/deprecate controls.~~ **✅
   Done 2026-07-02** (EntityEditor + LifecycleControls, journaled + role-gated).
3. ~~**G3** — workbench edit + bulk + merge (merge needs the store
   extension).~~ **✅ Done 2026-07-02** (bulk actions, journaled undo, merge
   on `mergeEntities`).
4. **G6, G9, G7** — ~~ACL editor~~ (✅ 2026-07-02), capture type-ahead linking
   (🟡 project + author links shipped; standards linking pending), search
   facets (🟡 review-status shipped; project/discipline/date pending).
5. **G2 full wizard, G8, G10, G11** — SharePoint sync, graph scale, analytics, SSO
   (the larger platform builds).

## Documentation follow-ups

Independent of the product work, the guides should be made honest about the above
(tracked separately from this backlog):

- **Guide 3** — relabel the ingestion CLI as **admin/dev-only**, not a knowledge-
  manager workflow; add a note that in-app upload/ingestion (G1/G2) is the
  intended user path and is not yet built.
- **Guide 4** — frame edit/merge/tag/supersede/ACL as **GUI gaps** (link here)
  rather than presenting "the data layer" as a user option.
- **Guides index** — link this report as the canonical "what's GUI vs. not yet"
  reference.
