import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { FTS_RECIPE_KEY, FTS_RECIPE_VERSION } from './fts.js';

/**
 * Schema versioning for the SQLite store (ADR 0012).
 *
 * The database carries its schema version in `PRAGMA user_version`; the
 * ordered {@link MIGRATIONS} list is the only place DDL lives. Opening a
 * database applies every migration newer than its version, each in one
 * IMMEDIATE transaction that ends by stamping the new version — a crash or a
 * thrown migration rolls the whole step back (SQLite DDL is transactional), so
 * a file is always at an exact version, never between two. Before the first
 * pending migration touches an *existing* database, the caller's backup hook
 * writes a consistent snapshot next to the file, so every upgrade is
 * reversible by a rehearsed restore (see `restoreDatabase`).
 *
 * The IMMEDIATE lock also serializes concurrent openers (the workspace app,
 * the gateway and the ingestion CLI share one file): whoever wins applies the
 * migration; the others re-read the version inside the lock and find nothing
 * pending. A database whose version is *newer* than this build's is refused
 * outright — an old binary must never run against a shape it does not know,
 * because `CREATE TABLE IF NOT EXISTS` would silently no-op and the process
 * would then read and write columns that mean something else.
 */
export interface Migration {
  /** Strictly increasing, contiguous from 1. */
  version: number;
  /** Short kebab-case label recorded in the `schema_migrations` ledger. */
  name: string;
  /** Runs inside the migration transaction; throw to abort the upgrade. */
  up: (db: DatabaseSync) => void;
}

/**
 * The v1 shape: the graph (entities, relationships, chunks), their FTS5
 * shadows, per-tenant settings, and the undo journal (operations +
 * before-images), which lives in the same file as the graph it journals.
 */
const BASELINE_DDL = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  properties TEXT NOT NULL,
  tags TEXT,
  aliases TEXT,
  content TEXT,
  embedding TEXT,
  embedding_provider TEXT,
  provenance TEXT NOT NULL,
  acl TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_tenant_type ON entities(tenant_id, type);
CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  properties TEXT
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON relationships(from_id);
CREATE INDEX IF NOT EXISTS idx_rel_to ON relationships(to_id);
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  id UNINDEXED, tenant_id UNINDEXED, text,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  anchor TEXT,
  heading TEXT,
  text TEXT NOT NULL,
  embedding TEXT,
  embedding_provider TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_entity ON chunks(entity_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  id UNINDEXED, entity_id UNINDEXED, tenant_id UNINDEXED, text,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS settings (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_ops_tenant_created ON operations(tenant_id, status, created_at DESC);
CREATE TABLE IF NOT EXISTS operation_entries (
  op_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  record_key TEXT NOT NULL,
  before_json TEXT NOT NULL,
  PRIMARY KEY (op_id, record_key)
);
CREATE INDEX IF NOT EXISTS idx_entries_op ON operation_entries(op_id, seq);
CREATE INDEX IF NOT EXISTS idx_entries_key ON operation_entries(record_key);
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Columns the pre-versioning store added to `entities` with on-open ALTERs. */
const LATE_ENTITY_COLUMNS = ['tags', 'aliases', 'content', 'embedding', 'embedding_provider'];

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'baseline',
    up(db) {
      // Adopt pre-versioning files (user_version 0 with tables): the old store
      // grew `entities` with on-open ALTER TABLEs, so an early file may still
      // lack the late columns. Add them first so the DDL below — whose CREATE
      // INDEX statements need the current shape — is a no-op on what exists.
      if (tableExists(db, 'entities')) {
        const have = new Set(columnNames(db, 'entities'));
        for (const col of LATE_ENTITY_COLUMNS) {
          if (!have.has(col)) db.exec(`ALTER TABLE entities ADD COLUMN ${col} TEXT`);
        }
      }
      db.exec(BASELINE_DDL);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Bookkeeping owned by the migrator itself, outside the versioned DDL. */
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL
);
`;

export type SchemaErrorCode =
  | 'schema_too_new'
  | 'migrations_pending'
  | 'database_in_use'
  | 'backup_exists'
  | 'backup_invalid'
  | 'not_found';

/** Thrown for every refusal in this module; `code` is stable for callers and the CLI. */
export class SchemaError extends Error {
  constructor(
    public readonly code: SchemaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SchemaError';
  }
}

export function readSchemaVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

export function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
      .get(name) !== undefined
  );
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(
    (c) => c.name,
  );
}

/** True when the file holds any table at all — i.e. there is data to protect. */
export function hasUserTables(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get() as { n: number };
  return row.n > 0;
}

export interface AppliedMigration {
  version: number;
  name: string;
  durationMs: number;
}

export interface MigrateOptions {
  /** Defaults to {@link MIGRATIONS}; tests inject future versions. */
  migrations?: readonly Migration[];
  /**
   * `auto` (default) applies pending migrations on open. `manual` refuses to
   * open an existing database that needs upgrading (`migrations_pending`) so
   * an operator runs `ekg-db migrate` deliberately; a brand-new file is still
   * initialized either way — there is nothing in it to protect.
   */
  mode?: 'auto' | 'manual';
  /**
   * Called once, before the first pending migration touches an existing
   * database; returns the snapshot path it wrote (recorded in the result).
   * Not called for new files.
   */
  backup?: (fromVersion: number) => string | undefined;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: AppliedMigration[];
  /** True when the file already held tables — i.e. this was an upgrade, not initialization. */
  existing: boolean;
  backupPath?: string;
}

function pendingFor(migrations: readonly Migration[], version: number): Migration[] {
  return migrations.filter((m) => m.version > version).sort((a, b) => a.version - b.version);
}

function assertContiguous(migrations: readonly Migration[]): void {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  sorted.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`migration list must be contiguous from 1; found version ${m.version} at position ${i}`);
    }
  });
}

export function tooNewMessage(version: number, latest: number): string {
  return (
    `database schema is v${version} but this build supports up to v${latest}. ` +
    `Upgrade the software (npm install && npm run build), or restore the pre-upgrade ` +
    `snapshot written next to the database (ekg-db restore <db>.v${latest}-<stamp>.backup).`
  );
}

/**
 * Bring `db` to the latest schema version. See the module comment for the
 * guarantees. Returns what happened so callers can log it.
 */
export function migrate(db: DatabaseSync, options: MigrateOptions = {}): MigrateResult {
  const migrations = options.migrations ?? MIGRATIONS;
  assertContiguous(migrations);
  const latest = migrations[migrations.length - 1]!.version;
  const mode = options.mode ?? 'auto';

  const before = readSchemaVersion(db);
  if (before > latest) throw new SchemaError('schema_too_new', tooNewMessage(before, latest));
  if (before === latest) return { from: before, to: before, applied: [], existing: true };

  const existing = hasUserTables(db);
  if (existing && mode === 'manual') {
    throw new SchemaError(
      'migrations_pending',
      `database schema is v${before}; this build needs v${latest} and EKG_DB_MIGRATE=manual ` +
        `forbids upgrading on open. Run: ekg-db migrate --db <path>`,
    );
  }
  // The snapshot cannot live inside the transaction (VACUUM INTO refuses to run
  // in one), so two processes racing an upgrade may each write one. Harmless:
  // both are consistent pre-upgrade images, and only the lock winner migrates.
  let backupPath: string | undefined;
  if (existing && options.backup) backupPath = options.backup(before);

  const applied: AppliedMigration[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-read under the write lock: a concurrent opener may have finished.
    const from = readSchemaVersion(db);
    if (from > latest) throw new SchemaError('schema_too_new', tooNewMessage(from, latest));
    db.exec(LEDGER_DDL);
    const record = db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at, duration_ms) VALUES (?, ?, ?, ?)',
    );
    for (const m of pendingFor(migrations, from)) {
      const started = Date.now();
      m.up(db);
      const durationMs = Date.now() - started;
      record.run(m.version, m.name, new Date().toISOString(), durationMs);
      db.exec(`PRAGMA user_version = ${m.version}`);
      applied.push({ version: m.version, name: m.name, durationMs });
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the original error is the one to surface */
    }
    throw err;
  }
  return { from: before, to: latest, applied, existing, ...(backupPath ? { backupPath } : {}) };
}

// ---------------------------------------------------------------------------
// Backup, inspection, and the in-use probe (the CLI builds on these)
// ---------------------------------------------------------------------------

/**
 * Write a consistent, self-contained snapshot of `db` to `dest` using
 * `VACUUM INTO`: a single read transaction, so it is safe while the app and
 * gateway keep writing (WAL), and the output is a compacted rollback-journal
 * file with no `-wal` sidecar to forget. Never overwrites: a backup that
 * already exists is the one you may be about to need.
 */
export function backupDatabase(db: DatabaseSync, dest: string): { path: string; bytes: number } {
  if (existsSync(dest)) throw new SchemaError('backup_exists', `refusing to overwrite existing backup ${dest}`);
  mkdirSync(dirname(dest), { recursive: true });
  db.prepare('VACUUM INTO ?').run(dest);
  return { path: dest, bytes: statSync(dest).size };
}

/** Filesystem-safe UTC stamp for snapshot names: `20260904T153012Z`. */
export function utcStamp(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** `<db>.v<from>-<UTC stamp>.backup`, next to the database it snapshots. */
export function defaultBackupPath(dbPath: string, fromVersion: number, now = new Date()): string {
  return `${dbPath}.v${fromVersion}-${utcStamp(now)}.backup`;
}

/**
 * Refuse unless no other connection has `path` open. Under WAL an idle
 * connection holds no lock on the main file, but every connection keeps a
 * shared lock on the `-shm` sidecar for as long as it is open, and a
 * connection in EXCLUSIVE locking mode needs all of them gone before its first
 * read — so a failed exclusive read is a reliable "someone else is here".
 * Used before swapping the file underneath (restore), never for ordinary opens.
 */
export function assertNotInUse(path: string): void {
  if (!existsSync(path)) return;
  const probe = new DatabaseSync(path);
  try {
    probe.exec('PRAGMA busy_timeout = 250');
    probe.exec('PRAGMA locking_mode = EXCLUSIVE');
    probe.exec('BEGIN IMMEDIATE');
    probe.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    probe.exec('COMMIT');
  } catch {
    throw new SchemaError(
      'database_in_use',
      `${path} is open by another process (the workspace app, the gateway, or an ingestion run). Stop them first.`,
    );
  } finally {
    probe.close();
  }
}

export interface LedgerEntry {
  version: number;
  name: string;
  appliedAt: string;
  durationMs: number;
}

export interface SchemaStatus {
  path: string;
  exists: boolean;
  /** `PRAGMA user_version` of the file (0 = pre-versioning or empty). */
  version: number;
  latest: number;
  pending: { version: number; name: string }[];
  tooNew: boolean;
  ledger: LedgerEntry[];
  /** Recipe the FTS rows were built with; null before the first versioned open. */
  ftsRecipe: number | null;
  ftsRecipeLatest: number;
  tables: string[];
  counts: Record<string, number>;
  /** `ok`, `skipped` (check disabled by the caller), or the messages SQLite's check returned. */
  check: 'ok' | 'skipped' | string[];
  /** One FTS row per source row (null when the tables are absent). */
  ftsInvariant: boolean | null;
}

const COUNTED_TABLES = ['entities', 'chunks', 'relationships', 'settings', 'operations'];

/**
 * Read-only look at a database or backup file: version, pending migrations,
 * ledger, counts, and an integrity check (`quick_check` by default;
 * `full: true` runs the exhaustive `integrity_check`; `check: false` skips it
 * for callers that render on every request). Never migrates.
 */
export function inspectDatabase(
  path: string,
  options: { full?: boolean; check?: boolean } = {},
): SchemaStatus {
  const base: SchemaStatus = {
    path,
    exists: existsSync(path),
    version: 0,
    latest: LATEST_SCHEMA_VERSION,
    pending: MIGRATIONS.map((m) => ({ version: m.version, name: m.name })),
    tooNew: false,
    ledger: [],
    ftsRecipe: null,
    ftsRecipeLatest: FTS_RECIPE_VERSION,
    tables: [],
    counts: {},
    check: 'ok',
    ftsInvariant: null,
  };
  if (!base.exists) return base;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    return { ...base, check: [err instanceof Error ? err.message : String(err)] };
  }
  try {
    const version = readSchemaVersion(db);
    const status: SchemaStatus = {
      ...base,
      version,
      pending: pendingFor(MIGRATIONS, version).map((m) => ({ version: m.version, name: m.name })),
      tooNew: version > LATEST_SCHEMA_VERSION,
      tables: (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%\\_fts\\_%' ESCAPE '\\' ORDER BY name",
          )
          .all() as unknown as { name: string }[]
      ).map((r) => r.name),
    };
    if (tableExists(db, 'schema_migrations')) {
      status.ledger = (
        db
          .prepare('SELECT version, name, applied_at, duration_ms FROM schema_migrations ORDER BY version')
          .all() as unknown as { version: number; name: string; applied_at: string; duration_ms: number }[]
      ).map((r) => ({ version: r.version, name: r.name, appliedAt: r.applied_at, durationMs: r.duration_ms }));
    }
    if (tableExists(db, 'schema_meta')) {
      const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(FTS_RECIPE_KEY) as
        | { value: string }
        | undefined;
      if (row) status.ftsRecipe = Number(row.value);
    }
    for (const table of COUNTED_TABLES) {
      if (!tableExists(db, table)) continue;
      status.counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    }
    if (tableExists(db, 'entities_fts') && tableExists(db, 'chunks_fts')) {
      const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      status.ftsInvariant = n('entities_fts') === n('entities') && n('chunks_fts') === n('chunks');
    }
    if (options.check === false) {
      status.check = 'skipped';
      return status;
    }
    const check = (
      db.prepare(options.full ? 'PRAGMA integrity_check' : 'PRAGMA quick_check').all() as unknown as Record<
        string,
        string
      >[]
    ).map((r) => Object.values(r)[0]!);
    status.check = check.length === 1 && check[0] === 'ok' ? 'ok' : check;
    return status;
  } catch (err) {
    // Not a SQLite file at all ("file is not a database"), or unreadable:
    // report it as the check failing rather than throwing out of a read.
    return { ...base, check: [err instanceof Error ? err.message : String(err)] };
  } finally {
    db.close();
  }
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  status: SchemaStatus;
}

/**
 * Full integrity check of a database or backup file, plus everything a
 * restore would trip over: unknown (newer) schema, a broken FTS invariant.
 * Read-only; safe to run against a live database.
 */
export function verifyDatabase(path: string): VerifyResult {
  const status = inspectDatabase(path, { full: true });
  const problems: string[] = [];
  if (!status.exists) problems.push(`no database at ${path}`);
  else {
    if (Array.isArray(status.check)) problems.push(`integrity_check: ${status.check.join('; ')}`);
    if (status.tooNew) problems.push(tooNewMessage(status.version, status.latest));
    if (status.ftsInvariant === false) {
      problems.push('FTS index out of step with its source tables (healed on next open; restore is still safe)');
    }
  }
  return { ok: problems.length === 0, problems, status };
}
