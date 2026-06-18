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
not yet meet it. The single largest miss: **there is no way to add a document
through the GUI at all** — no upload control exists anywhere in the app. Several
core curation actions are also GUI-absent.

## Coverage matrix

Legend: ✅ GUI exists · 🟡 GUI partial · ❌ no GUI (CLI / data-layer / assistant only)

| User interaction | State | PRD ref | Gap ID |
|---|:--:|---|---|
| Search / browse | 🟡 | P0-9 faceted search | [G7](#g7--thin-search-facets) |
| Explore graph (map + neighborhood) | 🟡 | P0-9 graph explorer | [G8](#g8--graph-explorer-filters--scale) |
| View entity + provenance | ✅ | P0-9 entity pages | — |
| Capture lesson / detail by hand | 🟡 | P0-9 guided capture | [G9](#g9--guided-capture-without-type-ahead-linking) |
| Verify / reject a candidate | 🟡 | P0-9 workbench | [G3](#g3--curation-workbench-is-verifyreject-only) |
| **Add a document (upload)** | ❌ | P0-2, P0-9 | [G1](#g1--no-in-app-document-upload) |
| **Bulk ingest a folder / source** | ❌ | P0-2, P0-9 wizard | [G2](#g2--no-ingestion-setup-wizard-or-bulk-import-gui) |
| **Edit / correct an entity** | ❌ | P0-1, P0-9 inline edit | [G4](#g4--no-inline-entity-editing) |
| **Merge duplicates** | ❌ | P0-9 merge | [G3](#g3--curation-workbench-is-verifyreject-only) |
| **Set tags / aliases on an item** | ❌ | P0-1, P0-9 | [G4](#g4--no-inline-entity-editing) |
| **Mark superseded / deprecated** | ❌ | P0-1 lifecycle, P0-8 | [G5](#g5--no-gui-for-the-supersededdeprecated-lifecycle) |
| **Set / confirm an item's ACL** | ❌ | P0-2, P0-9 curator | [G6](#g6--no-gui-for-aclpermission-curation) |
| Usage analytics (top / zero-result / cited) | ❌ | P1-4 | [G10](#g10--no-usage-analytics-dashboard-p1) |
| Roles & SSO sign-in | ❌ | P0-9 roles, P0-7 | [G11](#g11--no-roles-or-sso-auth) |
| Gateway / SSO / embeddings / tokens | ⚙️ CLI | Admin setup | *out of scope (allowed)* |

---

## P0 gaps — break the "GUI for every user" rule

### G1 · No in-app document upload

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

- **PRD:** P0-2 *"Source-system permissions… stored as item ACLs."* P0-9 curator
  role; P0-7 ACL enforcement.
- **Persona:** Curator; overlaps IT/Security Admin (Dana).
- **Now:** ACL enforcement works (data layer), but `acl.allowedPrincipals` is only
  set programmatically — capture defaults to tenant-public (`*`), ingestion sets it
  in code. No GUI to view or change who can see an item.
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
- **Now:** [`search/page.tsx`](../apps/web/src/app/search/page.tsx) filters by
  **type** and **tag** only.
- **Approach:** Add review-status, date-range, discipline, and spec-section facets
  (data already on entities/anchors). **Effort: S–M.**

### G8 · Graph explorer filters & scale

- **PRD:** P0-9 *"filter by entity type, relationship type, discipline, project,
  and review status… usable on 100k+ entities… progressive loading, not a hairball."*
- **Now:** [`map/page.tsx`](../apps/web/src/app/map/page.tsx) loads up to 1,000
  entities and toggles types/tags only — no relationship-type or review-status
  filter, no progressive loading.
- **Approach:** Add the missing filters; server-side neighborhood expansion instead
  of loading the whole graph. **Effort: M–L.**

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

- **PRD:** P0-9 *"viewer / contributor / curator / admin roles; sign-in via Entra
  ID SSO."* P0-7 per-request identity.
- **Now:** The app runs as a fixed dev identity (`DEV_CALLER` in
  [`lib/store.ts`](../apps/web/src/lib/store.ts)); the HTTP gateway already does
  per-request JWT identity, but the app has no login and no role gating — so
  curator-only actions (G3–G6) currently have nothing to gate against.
- **Note:** SSO/token plumbing is **admin setup** (allowed CLI), but *role-gated
  GUI actions* depend on it; it's listed here because G4–G6 need a role to attach
  to. **Effort: L** (SSO is the deferred OAuth 2.1 + Entra phase; the verifier swap
  is already scoped in [`auth.ts`](../apps/mcp-server/src/auth.ts)).

---

## Suggested sequencing

A pragmatic order that closes the principle-breaking gaps first and reuses the
most existing code:

1. **G1 + interim G2** — in-app upload running the existing `buildCandidate`
   pipeline. One change closes "can't add a document in a browser."
2. **G4 + G5** — inline entity edit + supersede/deprecate controls (both mostly
   `upsertEntity`/`upsertRelationship`; high trust value).
3. **G3** — workbench edit + bulk + merge (merge needs the store extension).
4. **G6, G9, G7** — ACL editor, capture type-ahead linking, search facets.
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
