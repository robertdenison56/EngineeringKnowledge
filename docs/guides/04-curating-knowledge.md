# 4 · Curating & refining knowledge

Curation is what makes EKG **trustworthy**. Anyone can add a candidate; a
curator decides what becomes firm knowledge and how it's labeled. This guide is
for the Knowledge Manager (Marcus) who owns the graph's quality and the QA
Principal (Elena) accountable for what gets reused.

The governing rule: **nothing reaches the verified graph without a curator's
sign-off.** Ingestion, the capture form, and assistant ingestion all create
`unverified` candidates and stop there.

## The curation workbench (`/curation`)

Open **http://localhost:3000/curation**. The workbench lists every `unverified`
candidate — from ingestion, capture, and assistants alike — with a count of how
many await review. Each candidate card shows its title, type badge, summary, and
provenance line, and links to the full entity page so you can inspect the source
document text before deciding.

For each candidate you have two actions:

- **✓ Verify** — promote it to `verified`. It becomes firm knowledge: served
  cleanly to assistants and shown without a warning in the app. Its
  modified-date is stamped.
- **✕ Reject** — remove the candidate. Use this for misclassified files,
  duplicates, junk, or anything that shouldn't be firm knowledge.

There's a **+ Capture knowledge** shortcut to the [capture form](03-adding-knowledge.md#1-the-capture-form),
since reviewing often surfaces something you want to add by hand.

> **Build status — what the workbench does today.** The queue supports
> per-item and **bulk** Verify/Reject (checkbox-select, then the toolbar
> buttons), and Reject is a soft delete — rejected candidates sit in
> **Recently rejected** below the queue and can be restored with one click.
> The fuller curator workflow from the
> [PRD](../../PRD-engineering-knowledge-graph.md) (user story 9) lives on each
> **entity page** under *Curate this item*: correcting fields (title, summary,
> tags, aliases), editing the ACL, the supersede/deprecate lifecycle, merging
> duplicates, and adding/removing relationships. Every curation action is
> recorded in the audit trail.

## A curator's review checklist

Before you verify, check the candidate against the source — the entity page puts
the extracted document text one click away for exactly this. Ask:

1. **Is the type right?** Ingestion classifies by filename and is deliberately
   conservative — a file that fell through to `document` might really be a
   `design-detail` or `spec-section`.
2. **Is it grounded?** For assistant-described drawings, check the
   **`ungrounded`** annotations — quotes the parser and text layer could *not*
   confirm. Don't verify those as fact; correct or drop them. (See
   [two-source grounding](03-adding-knowledge.md#save_description).)
3. **Did the text extract cleanly?** A `needs-ocr` or `parse-failed` candidate
   has no usable text — decide whether to hold it for OCR rather than verify an
   empty record.
4. **Is it tagged for retrieval?** Tags and aliases are what make it findable —
   see [refining for retrieval](#refining-for-retrieval).
5. **Does it supersede something?** If this replaces an existing detail, the old
   one should be marked superseded and linked — see
   [the lifecycle](#the-review-lifecycle).
6. **Who can see it?** Confirm the ACL matches the source — see
   [permissions](#permissions-and-acls).

## The review lifecycle

Every item carries exactly one review status. This is the single most important
piece of curator metadata, because it changes how the item behaves in **every**
answer, in the app and through every gateway.

| Status | When you set it | Effect on answers |
|---|---|---|
| **`unverified`** | Automatic on every add. | In the queue; not firm knowledge. |
| **`verified`** | You approved it. | The trustworthy default — served cleanly. |
| **`superseded`** | A newer version exists. | Served **with a warning** + a pointer to the current version. Still findable so history is visible. |
| **`deprecated`** | Known-bad / withdrawn. | Served **with a warning** so no assistant reuses a past mistake. |

The discipline that makes EKG safe: **flag, don't delete.** When a detail is
replaced or found defective, mark it `superseded`/`deprecated` and link the
replacement rather than removing it — engineers still find it, but are always
told not to reuse it. Reject is for things that were never firm knowledge
(junk, duplicates, misfiles), not for retiring real history.

Both transitions are one action on the entity page (*Curate this item →
Lifecycle*): **Mark deprecated** flags the item, and **Superseded by…** flags
it *and* creates the `supersedes` edge from the replacement you pick, so the
warning always points somewhere. There's also **Send back to review queue**
for verified items that need another look.

> Any **new machine-generated content always re-enters the queue as
> `unverified`** — e.g. when an assistant saves a new description for a sheet, it
> drops back to `unverified` even if it was verified before, so a curator sees
> the change.

## Refining for retrieval

Verification makes an item *trustworthy*; tags, aliases, and relationships make
it *findable and connected*. This is the ongoing "refine" work that keeps the
graph useful.

- **Tags** — free-form, multi-valued facets (discipline, system, hazard,
  market…). They're searchable and filterable everywhere — in the app's type/tag
  filters and in the gateway's `search` tag filter. Tag for the words an engineer
  would actually search.
- **Aliases** — domain synonyms ("safing", "perimeter fire barrier") so
  retrieval finds knowledge however it's worded. Critical in AEC, where the same
  condition has several names.
- **Relationships** — the edges (`used-in`, `supersedes`, `authored-by`,
  `complies-with`, `had-issue`, `applies-to`, `references`) turn a pile of items
  into a graph. They power `traverse`, `find_experts`, `get_project_context`, and
  the app's graph views. Ingestion creates `references` edges from drawing
  callouts automatically; authorship and compliance links are where curation adds
  the most value.

### Where to aim curation effort

Curate where demand is. Two honest signals available today:

- **Zero-result searches in the app** — when a search returns *"the firm graph
  has no answer,"* that's a gap worth filling. Encourage engineers to
  [capture](03-adding-knowledge.md#1-the-capture-form) what they learn when they
  hit one.
- **The gateway audit trail** — every assistant call is logged with its outcome
  (including `no_results`) and which items it surfaced. An admin can mine it for
  top queries, zero-result queries, and most-cited items. See the
  [Administration guide](05-admin-guide.md#audit-logging). (A built-in curation
  analytics dashboard is a roadmap item — PRD P1.)

## Permissions and ACLs

Each item carries an ACL — the principals (users/groups) allowed to read it;
`*` means tenant-public. ACLs are enforced at the data layer, so an item a user
can't see never appears in their app, their search, or their assistant's
answers.

- The **capture form** creates tenant-public (`*`) items by default.
- **Ingestion** sets ACLs as it builds candidates; in production these are mapped
  from the source system (SharePoint/Entra groups) so EKG never exposes through
  an assistant what a user couldn't open at the source.
- A curator's job includes confirming the ACL is right before verifying —
  especially for anything sensitive (e.g. legal or client-confidential
  material). The entity page shows the item's access under **Record → Access**,
  and the *Curate this item* panel has an ACL editor: list the allowed
  principals comma-separated (e.g. `group:legal, user:dana`), or `*` for the
  whole firm. The mechanics of identity, groups, and tenant isolation are in
  the [Administration guide](05-admin-guide.md#identity-tenants-and-permissions).

## Verifying the loop

After you verify a candidate, confirm it behaves as firm knowledge:

1. **Search for it in the app** — it should appear without an `unverified` badge.
2. **Ask the connected assistant** — it should now be served cleanly, with a
   citation and a link back into the app.
3. If you marked something **superseded/deprecated**, confirm the answer comes
   back **with the warning** and points to the current version.

That round trip is the proof that curation, the app, and every gateway share one
graph and one source of truth.

---

Operating EKG for a whole firm — multi-user gateway, SSO, ACL mapping, audit:

Next: **[5 · Administration →](05-admin-guide.md)**
