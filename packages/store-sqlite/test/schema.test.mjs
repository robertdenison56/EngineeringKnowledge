import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEMO_TENANT, seedDemo } from '@ekg/core';
import {
  FTS_RECIPE_VERSION,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  SchemaError,
  SqliteGraphStore,
  assertNotInUse,
  inspectDatabase,
  migrate,
  rebuildFts,
  restoreDatabase,
  verifyDatabase,
} from '../dist/index.js';

const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };
const quiet = { log: () => {} };

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'ekg-schema-'));
}

function snapshotsIn(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.backup'));
}

function raw(path, fn) {
  const db = new DatabaseSync(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * The earliest shape the store ever wrote: no late entity columns (tags,
 * aliases, content, embedding, embedding_provider), no chunks, no journal, no
 * settings, and `user_version` 0 — exactly what a workspace created before
 * schema versioning looks like on disk.
 */
function writeLegacyDatabase(path) {
  raw(path, (db) => {
    db.exec(`
      CREATE TABLE entities (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
        summary TEXT, properties TEXT NOT NULL, provenance TEXT NOT NULL, acl TEXT NOT NULL
      );
      CREATE TABLE relationships (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, type TEXT NOT NULL,
        from_id TEXT NOT NULL, to_id TEXT NOT NULL, properties TEXT
      );
      CREATE VIRTUAL TABLE entities_fts USING fts5(
        id UNINDEXED, tenant_id UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    db.prepare(
      `INSERT INTO entities (id, tenant_id, type, title, summary, properties, provenance, acl)
       VALUES (?, ?, 'detail', 'Legacy curtain wall firestop detail', 'from before versioning', '{}', ?, ?)`,
    ).run(
      'detail:legacy-01',
      DEMO_TENANT,
      JSON.stringify({ createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z', reviewStatus: 'verified' }),
      JSON.stringify({ allowedPrincipals: ['*'] }),
    );
    db.prepare('INSERT INTO entities_fts (id, tenant_id, text) VALUES (?, ?, ?)').run(
      'detail:legacy-01',
      DEMO_TENANT,
      'indexed under the old recipe',
    );
  });
}

test('a new database is initialized at the latest schema with a full ledger and no snapshot', () => {
  const dir = freshDir();
  const path = join(dir, 'ekg.db');
  const store = new SqliteGraphStore(path, quiet);
  assert.deepEqual(
    { from: store.migration.from, to: store.migration.to, existing: store.migration.existing },
    { from: 0, to: LATEST_SCHEMA_VERSION, existing: false },
  );
  assert.equal(store.migration.applied.length, MIGRATIONS.length);
  assert.equal(store.migration.backupPath, undefined, 'nothing to protect in a new file');
  assert.equal(store.schemaVersion(), LATEST_SCHEMA_VERSION);
  store.close();

  const status = inspectDatabase(path);
  assert.equal(status.version, LATEST_SCHEMA_VERSION);
  assert.deepEqual(status.pending, []);
  assert.deepEqual(
    status.ledger.map((m) => m.version),
    MIGRATIONS.map((m) => m.version),
    'every migration is recorded in the ledger',
  );
  assert.equal(status.ftsRecipe, FTS_RECIPE_VERSION);
  assert.equal(status.check, 'ok');
  assert.deepEqual(snapshotsIn(dir), []);
});

test('a pre-versioning file is adopted: snapshot first, columns and tables added, data kept', async () => {
  const dir = freshDir();
  const path = join(dir, 'ekg.db');
  writeLegacyDatabase(path);
  assert.equal(inspectDatabase(path).version, 0);
  assert.equal(inspectDatabase(path).pending.length, MIGRATIONS.length, 'everything is pending at v0');

  const store = new SqliteGraphStore(path, quiet);
  assert.equal(store.migration.from, 0);
  assert.equal(store.migration.existing, true);
  assert.match(store.migration.backupPath ?? '', /ekg\.db\.v0-\d{8}T\d{6}Z\.backup$/);
  assert.ok(existsSync(store.migration.backupPath), 'pre-upgrade snapshot written next to the database');

  // The legacy row survives and is searchable; late columns and journal tables exist.
  const hits = await store.search(ENGINEER, 'legacy curtain wall firestop');
  assert.equal(hits[0]?.entity.id, 'detail:legacy-01');
  assert.equal(store.countEntities(DEMO_TENANT), 1);
  assert.deepEqual(store.createJournal().list(DEMO_TENANT), [], 'journal tables came from the baseline migration');
  await store.setSetting(DEMO_TENANT, 'firm-name', 'Acme');
  assert.equal(await store.getSetting(DEMO_TENANT, 'firm-name'), 'Acme');
  store.close();

  const after = inspectDatabase(path);
  assert.equal(after.version, LATEST_SCHEMA_VERSION);
  assert.ok(after.tables.includes('chunks') && after.tables.includes('operations') && after.tables.includes('settings'));
  raw(path, (db) => {
    const cols = db.prepare('PRAGMA table_info(entities)').all().map((c) => c.name);
    for (const col of ['tags', 'aliases', 'content', 'embedding', 'embedding_provider']) {
      assert.ok(cols.includes(col), `late column ${col} added`);
    }
  });

  // The snapshot is the pre-upgrade file: v0, verifiable, restorable.
  const snapshot = inspectDatabase(store.migration.backupPath, { full: true });
  assert.equal(snapshot.version, 0);
  assert.equal(snapshot.check, 'ok');
  assert.equal(snapshot.counts.entities, 1);

  // A second open finds nothing pending and writes no second snapshot.
  const again = new SqliteGraphStore(path, quiet);
  assert.deepEqual(again.migration.applied, []);
  again.close();
  assert.equal(snapshotsIn(dir).length, 1);
});

test('a database newer than this build is refused and left untouched', () => {
  const dir = freshDir();
  const path = join(dir, 'ekg.db');
  new SqliteGraphStore(path, quiet).close();
  raw(path, (db) => db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`));

  assert.throws(
    () => new SqliteGraphStore(path, quiet),
    (err) =>
      err instanceof SchemaError &&
      err.code === 'schema_too_new' &&
      new RegExp(`v${LATEST_SCHEMA_VERSION + 1}.*v${LATEST_SCHEMA_VERSION}`).test(err.message) &&
      /restore/.test(err.message),
  );
  assert.equal(inspectDatabase(path).version, LATEST_SCHEMA_VERSION + 1, 'version not clobbered');
  assert.equal(inspectDatabase(path).tooNew, true);
  assert.deepEqual(snapshotsIn(dir), [], 'a refusal writes nothing');
  const verdict = verifyDatabase(path);
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(' '), /newer|supports up to/);
});

test('manual mode refuses a pending upgrade but still initializes a new file', () => {
  const dir = freshDir();
  const legacy = join(dir, 'legacy.db');
  writeLegacyDatabase(legacy);
  assert.throws(
    () => new SqliteGraphStore(legacy, { ...quiet, migrate: 'manual' }),
    (err) => err instanceof SchemaError && err.code === 'migrations_pending' && /ekg-db migrate/.test(err.message),
  );
  assert.equal(inspectDatabase(legacy).version, 0, 'untouched');
  assert.deepEqual(snapshotsIn(dir), [], 'no snapshot for a refused upgrade');

  const fresh = new SqliteGraphStore(join(dir, 'new.db'), { ...quiet, migrate: 'manual' });
  assert.equal(fresh.schemaVersion(), LATEST_SCHEMA_VERSION);
  fresh.close();
});

test('future migrations apply in order, exactly once, and a failing one rolls back whole', () => {
  const path = join(freshDir(), 'ekg.db');
  new SqliteGraphStore(path, quiet).close();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 1000');
  const v2 = { version: 2, name: 'add-widgets', up: (d) => d.exec('CREATE TABLE widgets (x)') };

  const backups = [];
  const first = migrate(db, { migrations: [...MIGRATIONS, v2], backup: (from) => (backups.push(from), 'snap') });
  assert.deepEqual(first.applied.map((m) => `${m.version}:${m.name}`), ['2:add-widgets']);
  assert.deepEqual({ from: first.from, to: first.to, backupPath: first.backupPath }, { from: 1, to: 2, backupPath: 'snap' });
  assert.deepEqual(backups, [1], 'the snapshot hook sees the version being left behind');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);

  const second = migrate(db, { migrations: [...MIGRATIONS, v2], backup: () => assert.fail('no snapshot when nothing is pending') });
  assert.deepEqual(second.applied, []);

  const v3bad = {
    version: 3,
    name: 'boom',
    up: (d) => {
      d.exec('CREATE TABLE gadgets (x)');
      throw new Error('boom');
    },
  };
  assert.throws(() => migrate(db, { migrations: [...MIGRATIONS, v2, v3bad] }), /boom/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2, 'version unchanged after a failed step');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'gadgets'").get().n,
    0,
    'DDL from the failed step rolled back',
  );
  assert.deepEqual(
    db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version),
    [1, 2],
    'ledger unchanged after a failed step',
  );

  const v3good = { version: 3, name: 'add-gadgets', up: (d) => d.exec('CREATE TABLE gadgets (x)') };
  const third = migrate(db, { migrations: [...MIGRATIONS, v2, v3good] });
  assert.deepEqual(third.applied.map((m) => m.version), [3]);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  db.close();

  // The build that knows only v1 now refuses this file.
  assert.throws(() => new SqliteGraphStore(path, quiet), (err) => err instanceof SchemaError && err.code === 'schema_too_new');
});

test('the migration list must be contiguous from 1, and a new file never triggers the snapshot hook', () => {
  const db = new DatabaseSync(':memory:');
  assert.throws(() => migrate(db, { migrations: [{ version: 2, name: 'gap', up: () => {} }] }), /contiguous/);
  const result = migrate(db, { backup: () => assert.fail('a new database has nothing to snapshot') });
  assert.equal(result.existing, false);
  assert.equal(result.to, LATEST_SCHEMA_VERSION);
  db.close();
});

test('an FTS recipe bump rebuilds stale rows from source; a plain reopen does not', async () => {
  const path = join(freshDir(), 'ekg.db');
  const store = new SqliteGraphStore(path, quiet);
  await seedDemo(store);
  store.close();
  const id = 'detail:cw-firestop-02';
  raw(path, (db) => db.prepare('UPDATE entities_fts SET text = ? WHERE id = ?').run('stale', id));

  // Same recipe: reconciliation only fixes missing/duplicate rows, never content.
  new SqliteGraphStore(path, quiet).close();
  assert.equal(raw(path, (db) => db.prepare('SELECT text FROM entities_fts WHERE id = ?').get(id).text), 'stale');

  // A recipe change (simulated by an older stamp on disk) rebuilds every row.
  raw(path, (db) => db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'fts_recipe'").run());
  const rebuilt = new SqliteGraphStore(path, quiet);
  const text = raw(path, (db) => db.prepare('SELECT text FROM entities_fts WHERE id = ?').get(id).text);
  assert.notEqual(text, 'stale');
  assert.match(text, /firestop/i, 'rebuilt from the entity row');
  const hits = await rebuilt.search(ENGINEER, 'curtain wall firestop');
  assert.equal(hits[0]?.entity.id, id);
  rebuilt.close();
  const status = inspectDatabase(path);
  assert.equal(status.ftsRecipe, FTS_RECIPE_VERSION);
  assert.equal(status.ftsInvariant, true);
});

test('backup is a verified consistent snapshot, and restore brings it back (rehearsal)', async () => {
  const dir = freshDir();
  const path = join(dir, 'ekg.db');
  const store = new SqliteGraphStore(path, quiet);
  await seedDemo(store);
  await store.setSetting(DEMO_TENANT, 'firm-name', 'Acme Structural');
  const entities = store.countEntities(DEMO_TENANT);
  const backupPath = join(dir, 'backups', 'nightly.backup');
  const written = store.backup(backupPath);
  assert.ok(written.bytes > 0);
  assert.throws(() => store.backup(backupPath), (err) => err instanceof SchemaError && err.code === 'backup_exists');

  const check = verifyDatabase(backupPath);
  assert.equal(check.ok, true, check.problems.join('; '));
  assert.equal(check.status.counts.entities, entities);
  assert.equal(check.status.version, LATEST_SCHEMA_VERSION);

  // Damage the live database after the snapshot, then restore.
  assert.equal(await store.deleteEntity(ENGINEER, 'detail:cw-firestop-02'), true);
  await store.setSetting(DEMO_TENANT, 'firm-name', 'Wrong Name');
  assert.equal(store.countEntities(DEMO_TENANT), entities - 1);
  store.close();

  const result = restoreDatabase(backupPath, path, quiet);
  assert.equal(result.restoredFrom, backupPath);
  assert.match(result.preRestoreBackup ?? '', /ekg\.db\.pre-restore-\d{8}T\d{6}Z\.backup$/);
  assert.equal(result.verify.ok, true);
  assert.deepEqual(result.migration.applied, [], 'a current-schema backup needs no migration');

  const restored = new SqliteGraphStore(path, quiet);
  assert.equal(restored.countEntities(DEMO_TENANT), entities);
  assert.ok(await restored.getEntity(ENGINEER, 'detail:cw-firestop-02'), 'deleted entity is back');
  assert.equal(await restored.getSetting(DEMO_TENANT, 'firm-name'), 'Acme Structural');
  const hits = await restored.search(ENGINEER, 'curtain wall firestop');
  assert.equal(hits[0]?.entity.id, 'detail:cw-firestop-02', 'FTS came back with the data');
  restored.close();

  // The restore itself is reversible: the pre-restore snapshot holds the damaged state.
  const before = inspectDatabase(result.preRestoreBackup, { full: true });
  assert.equal(before.check, 'ok');
  assert.equal(before.counts.entities, entities - 1);
});

test('restore refuses while any connection holds the database open', async () => {
  const dir = freshDir();
  const path = join(dir, 'ekg.db');
  const live = new SqliteGraphStore(path, quiet);
  await seedDemo(live);
  const backupPath = live.backup(join(dir, 'snap.backup'));
  assert.throws(() => assertNotInUse(path), (err) => err instanceof SchemaError && err.code === 'database_in_use');
  assert.throws(
    () => restoreDatabase(backupPath.path, path, quiet),
    (err) => err instanceof SchemaError && err.code === 'database_in_use' && /Stop them first/.test(err.message),
  );
  assert.equal(readdirSync(dir).filter((f) => f.includes('pre-restore')).length, 0, 'refused before touching anything');
  live.close();
  assertNotInUse(path);
  assert.equal(restoreDatabase(backupPath.path, path, quiet).verify.ok, true);
});

test('restore refuses a corrupt or unknown-version backup and leaves the live file alone', async () => {
  const dir = freshDir();
  const path = join(dir, 'ekg.db');
  const store = new SqliteGraphStore(path, quiet);
  await seedDemo(store);
  const entities = store.countEntities(DEMO_TENANT);
  const good = store.backup(join(dir, 'good.backup')).path;
  store.close();

  const garbage = join(dir, 'garbage.backup');
  writeFileSync(garbage, 'definitely not a database\n'.repeat(200));
  assert.equal(verifyDatabase(garbage).ok, false);
  assert.throws(
    () => restoreDatabase(garbage, path, quiet),
    (err) => err instanceof SchemaError && err.code === 'backup_invalid',
  );

  raw(good, (db) => db.exec('PRAGMA user_version = 99'));
  assert.throws(
    () => restoreDatabase(good, path, quiet),
    (err) => err instanceof SchemaError && err.code === 'backup_invalid' && /v99/.test(err.message),
  );
  assert.throws(() => restoreDatabase(join(dir, 'missing.backup'), path, quiet), (err) => err.code === 'not_found');

  assert.equal(readdirSync(dir).filter((f) => f.includes('pre-restore')).length, 0, 'live file never touched');
  const untouched = new SqliteGraphStore(path, quiet);
  assert.equal(untouched.countEntities(DEMO_TENANT), entities);
  untouched.close();
});

test('restore migrates an older backup forward to this build', async () => {
  const dir = freshDir();
  const legacyBackup = join(dir, 'legacy.backup');
  writeLegacyDatabase(legacyBackup);
  const path = join(dir, 'ekg.db');
  const result = restoreDatabase(legacyBackup, path, quiet);
  assert.equal(result.preRestoreBackup, undefined, 'nothing lived there before');
  assert.deepEqual({ from: result.migration.from, to: result.migration.to }, { from: 0, to: LATEST_SCHEMA_VERSION });
  assert.equal(result.verify.ok, true);
  const store = new SqliteGraphStore(path, quiet);
  assert.equal((await store.search(ENGINEER, 'legacy firestop'))[0]?.entity.id, 'detail:legacy-01');
  store.close();
  assert.equal(inspectDatabase(legacyBackup).version, 0, 'the backup file itself is never modified');
});

test('rebuildFts replaces the index wholesale: stale and duplicate rows are gone, one fresh row per source', async () => {
  const path = join(freshDir(), 'ekg.db');
  const store = new SqliteGraphStore(path, quiet);
  await seedDemo(store);
  store.close();
  const id = 'detail:cw-firestop-02';
  raw(path, (db) => {
    db.prepare('UPDATE entities_fts SET text = ? WHERE id = ?').run('stale', id);
    db.prepare('INSERT INTO entities_fts (id, tenant_id, text) VALUES (?, ?, ?)').run(id, DEMO_TENANT, 'duplicate');
    db.prepare('INSERT INTO chunks_fts (id, entity_id, tenant_id, text) VALUES (?, ?, ?, ?)').run('ghost#0', 'ghost', DEMO_TENANT, 'orphan');
    // Exercise the function alone — no store open, so no reconciliation to hide behind.
    const counts = rebuildFts(db);
    assert.equal(counts.entities, db.prepare('SELECT COUNT(*) AS n FROM entities').get().n);
    assert.equal(counts.chunks, db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entities_fts').get().n, counts.entities, 'exactly one row per entity');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get().n, counts.chunks, 'exactly one row per chunk');
    const rows = db.prepare('SELECT text FROM entities_fts WHERE id = ?').all(id);
    assert.equal(rows.length, 1);
    assert.match(rows[0].text, /firestop/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE id = 'ghost#0'").get().n, 0, 'orphan dropped');
  });
});
