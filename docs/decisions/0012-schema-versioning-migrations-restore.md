# ADR 0012: Schema versioning, migrations, and rehearsed restore

Date: 2026-09-04 · Status: **Accepted — implemented 2026-09-04**
(`packages/store-sqlite/src/schema.ts`, `fts.ts`, `cli.ts`; proven in
`test/schema.test.mjs` and `test/cli.test.mjs`, and rehearsed against a copy
of the live dev database)

## Context

The SQLite store ([ADR 0002](./0002-persistence-curation-ingestion.md)) had no
notion of a schema version. Its DDL was a single `CREATE TABLE IF NOT EXISTS`
script run on every open, `PRAGMA user_version` was 0 on every file, and the
only upgrade path was a handful of on-open `ALTER TABLE ... ADD COLUMN`s for
columns that arrived after the first workspaces were created. The undo journal
created its own tables the same way, from a different file.

That worked while every change was additive. It stops working the moment a
change is not:

- **`IF NOT EXISTS` no-ops silently on an existing file.** A changed column
  type, a new index on a rewritten table, a renamed FTS tokenizer — none of
  them reach a database that already has the table. The code and the file
  drift apart with no error, and the process reads columns that mean
  something else.
- **The FTS index could only be backfilled, never refreshed.** `reconcileFts`
  restores the one-row-per-source invariant, but it cannot tell a row indexed
  under last month's recipe from one indexed today. Any retrieval tuning that
  changes what text is indexed would split quality invisibly between old and
  new rows.
- **Three wanted roadmap items are schema changes** — BLOB vectors instead of
  JSON text, per-tenant synonym tables, curator-editable chunk anchors — and
  all three were gated on having a safe way to change the shape of a file
  that already holds a firm's curated knowledge.
- **The file is shared by processes of different ages.** The workspace app,
  the MCP gateway, and the ingestion CLI open the same `ekg.db`
  ([README, "full loop"](../../README.md)); after a deploy they are not
  necessarily rebuilt at the same moment.
- **No backup had ever been restored.** The admin guide said "back this file
  up like any other database of record" and stopped there. A backup that has
  never been restored is a hope, not a backup.

The 2026-07-25 repo review ranked this the one item whose cost strictly
increases every day it waits.

## Decisions

- **`PRAGMA user_version` is the schema version, and the ordered
  `MIGRATIONS` list in `schema.ts` is the only place DDL lives.** Version 1 is
  the baseline: the graph tables, their FTS5 shadows, per-tenant settings, the
  undo journal (which no longer runs DDL of its own), and a `schema_meta`
  key/value table. A `schema_migrations` ledger records every applied step
  with its timestamp and duration. Versions are contiguous from 1; the list
  refuses gaps.

- **Each migration runs in one `BEGIN IMMEDIATE` transaction that ends by
  stamping the new version.** SQLite DDL is transactional, so a thrown
  migration or a crash mid-step rolls back to an exact prior version — a file
  is never *between* two versions. The IMMEDIATE lock also serializes
  concurrent openers: the winner migrates, the others re-read the version
  under the lock and find nothing pending.

- **A file newer than the build is refused, never "handled".** If
  `user_version` exceeds the build's latest, the store throws
  `schema_too_new` with the two remedies in the message (upgrade the software,
  or restore the pre-upgrade snapshot). This is the guard the shared-file
  topology needs: an old gateway binary must not silently run against a shape
  it does not know.

- **Upgrades apply on open, after a snapshot.** Before the first pending
  migration touches an *existing* file, the store writes
  `<db>.v<from>-<stamp>.backup` next to it. Automatic-on-open matches how the
  store has always healed itself (WAL, FTS reconciliation) and the fact that
  three processes open the file with nobody running a separate step; the
  snapshot is what makes automatic safe. `EKG_DB_MIGRATE=manual` flips the
  posture for operators who want the step explicit: an existing file with a
  pending upgrade refuses to open until `ekg-db migrate` is run. A brand-new
  file is initialized in either mode — there is nothing in it to protect.
  `EKG_DB_BACKUP_ON_MIGRATE=0` turns the snapshot off.

- **The FTS *recipe* is versioned separately from the schema.**
  `FTS_RECIPE_VERSION` sits beside `ftsText` / `chunkFtsText` in `fts.ts`; the
  version a file was indexed with is stored under `schema_meta.fts_recipe`. On
  open, a mismatch rebuilds every FTS row from its source row, streaming, in
  one transaction, and stamps the new recipe. This is the refresh
  `reconcileFts` could not do — and it deliberately is not a schema version,
  because changing what text is indexed changes no DDL. A tokenizer change
  is DDL (it lives in the virtual table definition): that is a schema
  migration that drops and recreates the FTS table, plus a recipe bump so the
  rows are rebuilt. On its first versioned open, an existing install rebuilds
  its index once, so every file starts from a known recipe.

- **A backup is `VACUUM INTO`, and every backup is verified.** `VACUUM INTO`
  is a single read transaction — safe while the app and gateway keep writing
  under WAL — and produces one compacted rollback-journal file with no `-wal`
  sidecar to forget. It refuses to overwrite: an existing backup is the one
  you may be about to need. `ekg-db backup` runs a full `integrity_check` on
  what it wrote before reporting success.

- **Restore is a rehearsed sequence, not a file copy.** `ekg-db restore`:
  verifies the backup (integrity, FTS invariant, and that its version is not
  newer than the build); refuses if anything has the live file open; snapshots
  the live file to `<db>.pre-restore-<stamp>.backup` so the restore is itself
  reversible; removes the live file and its `-wal`/`-shm` sidecars; copies the
  backup in; opens it through the store — which migrates an older backup
  forward — and verifies the result. Everything before the swap is read-only.
  The in-use probe opens the file in EXCLUSIVE locking mode and attempts a
  read: under WAL every open connection keeps a shared lock on the `-shm`
  sidecar for as long as it is open, so the probe fails whenever anyone —
  even an idle app — is connected. Verified empirically before relying on it.

- **`ekg-db` is the operator surface** (`npm run db -- <command>` from the
  repo root): `status` (read-only: version, pending steps, ledger, counts,
  quick check), `migrate`, `backup <dest>`, `verify <file>`, `restore
  <backup>`. `--json` on the read commands for scripting.

## Alternatives considered

- **A migration framework (Knex, Drizzle, Prisma).** None drives
  `node:sqlite`, and the store's whole value is zero native dependencies. The
  mechanism here is ~150 lines and has exactly the semantics we need.
- **Down migrations.** Hand-written reversals are the least-tested code in
  any schema history. The pre-upgrade snapshot *is* the down migration, and
  it is exercised by `restore` on every rehearsal.
- **The `node:sqlite` online backup API.** Correct and incremental, but
  asynchronous, and the store must snapshot inside a synchronous constructor
  before it migrates. `VACUUM INTO` is synchronous, consistent, and simpler.
- **A schema hash instead of a version integer.** Detects drift but cannot
  order it — you cannot know which steps to apply, only that something
  differs.
- **Folding the FTS recipe into the schema version.** Would force a DDL
  migration (with a snapshot) for a change that touches no DDL, and would
  couple retrieval tuning to the upgrade story.

## Consequences

- **Adding a migration:** append `{ version: N+1, name, up(db) }` to
  `MIGRATIONS` — DDL only, no data assumptions the baseline does not
  guarantee — and add a test that opens a fixture at version N and asserts the
  new shape. Never edit a shipped migration. If the change alters what the
  FTS index holds, bump `FTS_RECIPE_VERSION` too. Bump the version only for
  DDL; a data-only refresh follows the recipe pattern.
- **First open after this change, on every existing install:** one snapshot
  next to the file, the baseline adoption (late columns, journal and meta
  tables), one full FTS rebuild, and one `ekg-store: upgraded ...` line on
  stderr. Rehearsed on a copy of the live dev database: sub-second.
- **Two processes racing the same upgrade may each write a snapshot.** The
  snapshot cannot live inside the transaction (`VACUUM INTO` refuses to run in
  one), and both images are consistent, so this is harmless and documented
  rather than prevented.
- **Restore requires stopping the app, gateway, and any ingestion run.** The
  probe enforces it; the message says so.
- **Backups still need a schedule and an off-box copy.** `ekg-db backup` is
  the safe primitive; where it runs and where the file goes is deployment
  (still "there is no outside" — Dockerfile/IaC remain roadmap).
- **What is deliberately still open:** data-only migrations beyond the FTS
  recipe (each gets written when a roadmap item needs it, as a versioned step
  with a test); `PRAGMA integrity_check` on open (O(file), so it stays in
  `verify`/`status`); a retention policy for the snapshots the store writes
  next to the file.
