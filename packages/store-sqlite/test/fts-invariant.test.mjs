import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEMO_TENANT, JournaledGraphStore, undoOperation, seedDemo } from '@ekg/core';
import { SqliteGraphStore } from '../dist/index.js';

const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };

function freshDbPath() {
  return join(mkdtempSync(join(tmpdir(), 'ekg-fts-')), 'ekg.db');
}

/**
 * The invariant a live database violated (19 entities_fts rows for 18
 * entities): exactly one FTS row per source row.
 */
function ftsCounts(path) {
  const db = new DatabaseSync(path);
  const counts = {
    entities: db.prepare('SELECT COUNT(*) AS n FROM entities').get().n,
    entitiesFts: db.prepare('SELECT COUNT(*) AS n FROM entities_fts').get().n,
    chunks: db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n,
    chunksFts: db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get().n,
  };
  db.close();
  return counts;
}

function assertInvariant(path, msg) {
  const c = ftsCounts(path);
  assert.equal(c.entitiesFts, c.entities, `${msg}: entities_fts === entities`);
  assert.equal(c.chunksFts, c.chunks, `${msg}: chunks_fts === chunks`);
}

test('reopen heals an orphaned FTS row left by the pre-transactional deleteEntity', async () => {
  const path = freshDbPath();
  const store = new SqliteGraphStore(path);
  await seedDemo(store);
  store.close();

  // Replay the legacy failure exactly: before writes were transactional
  // (pre-WAL, pre-busy_timeout), deleteEntity ran as autocommit statements and
  // an interruption (SQLITE_BUSY from the other process on the shared file, or
  // a crash) between `DELETE FROM entities` and `DELETE FROM entities_fts`
  // stranded the FTS row. This is how a live DB reached 19 fts rows for 18
  // entities.
  const raw = new DatabaseSync(path);
  raw.prepare('DELETE FROM relationships WHERE from_id = ? OR to_id = ?')
    .run('detail:cw-firestop-01', 'detail:cw-firestop-01');
  raw.prepare('DELETE FROM entities WHERE id = ?').run('detail:cw-firestop-01');
  // ...interrupted here: entities_fts (and chunks for document entities) keep their rows.
  raw.close();

  const before = ftsCounts(path);
  assert.equal(before.entitiesFts, before.entities + 1, 'fixture reproduces the orphan');

  const healed = new SqliteGraphStore(path);
  assertInvariant(path, 'after reopen');
  // The orphan must not haunt retrieval: its tokens hit nothing, and a live
  // entity sharing tokens hits exactly once.
  const hits = await healed.search(ENGINEER, 'curtain wall firestop', { limit: 25 });
  assert.ok(hits.every((h) => h.entity.id !== 'detail:cw-firestop-01'), 'orphan never surfaces');
  assert.equal(
    hits.filter((h) => h.entity.id === 'detail:cw-firestop-02').length, 1,
    'surviving twin hits exactly once',
  );
  healed.close();
});

test('reopen heals a duplicated FTS row (two processes racing the old count-based backfill)', async () => {
  const path = freshDbPath();
  const store = new SqliteGraphStore(path);
  await seedDemo(store);
  store.close();

  const raw = new DatabaseSync(path);
  const row = raw
    .prepare("SELECT id, tenant_id, text FROM entities_fts WHERE id = 'detail:cw-firestop-02'")
    .get();
  raw.prepare('INSERT INTO entities_fts (id, tenant_id, text) VALUES (?, ?, ?)')
    .run(row.id, row.tenant_id, row.text);
  raw.close();
  assert.equal(ftsCounts(path).entitiesFts, ftsCounts(path).entities + 1, 'fixture duplicated a row');

  const healed = new SqliteGraphStore(path);
  assertInvariant(path, 'after reopen');
  const hits = await healed.search(ENGINEER, 'curtain wall firestop', { limit: 25 });
  assert.equal(hits.filter((h) => h.entity.id === 'detail:cw-firestop-02').length, 1);
  healed.close();
});

test('reopen completes a missing or interrupted backfill (pre-FTS and partially-indexed databases)', async () => {
  const path = freshDbPath();
  const store = new SqliteGraphStore(path);
  await seedDemo(store);
  store.close();

  // Partial: some rows indexed, some not — the old `ftsCount === 0` backfill
  // never completed this state.
  const raw = new DatabaseSync(path);
  raw.prepare("DELETE FROM entities_fts WHERE id = 'detail:cw-firestop-02'").run();
  raw.close();

  const healed = new SqliteGraphStore(path);
  assertInvariant(path, 'after partial-backfill reopen');
  const hits = await healed.search(ENGINEER, 'curtain wall firestop', { limit: 25 });
  assert.equal(hits.filter((h) => h.entity.id === 'detail:cw-firestop-02').length, 1);
  healed.close();

  // Empty: a database from before the FTS tables existed (the old backfill's job).
  const raw2 = new DatabaseSync(path);
  raw2.exec('DELETE FROM entities_fts');
  raw2.close();
  const backfilled = new SqliteGraphStore(path);
  assertInvariant(path, 'after pre-FTS reopen');
  assert.ok((await backfilled.search(ENGINEER, 'curtain wall firestop')).length > 0);
  backfilled.close();
});

test('ingest -> journaled reject -> undo keeps the FTS invariant and restores exactly one hit', async () => {
  const path = freshDbPath();
  const raw = new SqliteGraphStore(path);
  const journal = raw.createJournal();
  let ctx;
  const store = new JournaledGraphStore(raw, journal, () => ctx);

  // Ingest (not journaled, like the CLI): a document with a chunk.
  await raw.upsertEntity(
    {
      id: 'ingest:lesson-a501',
      tenantId: DEMO_TENANT,
      type: 'document',
      title: 'A-501 firestop lesson',
      properties: {},
      content: 'Lesson learned - firestop at curtain wall edge',
      provenance: { createdAt: 'x', modifiedAt: 'x', reviewStatus: 'unverified' },
      acl: { allowedPrincipals: ['*'] },
    },
    [
      {
        id: 'ingest:lesson-a501#0',
        entityId: 'ingest:lesson-a501',
        tenantId: DEMO_TENANT,
        ordinal: 0,
        anchor: { page: 1 },
        text: 'hose-stream failure at the mockup taught us to stage safing first',
      },
    ],
  );

  // Journaled reject, then undo — the suspected orphan sequence.
  journal.begin({
    id: 'op-reject', tenantId: DEMO_TENANT, label: 'Rejected "A-501 firestop lesson"',
    kind: 'reject-entity', actor: 'user:test', createdAt: '2026-01-01T00:00:00.000Z',
  });
  ctx = { opId: 'op-reject', caller: ENGINEER };
  assert.equal(await store.deleteEntity(ENGINEER, 'ingest:lesson-a501'), true);
  ctx = undefined;
  journal.commit('op-reject');
  assertInvariant(path, 'after reject');

  const res = await undoOperation(store, journal, 'op-reject', { caller: ENGINEER });
  assert.ok(res.ok);
  assertInvariant(path, 'after undo');

  const hits = await store.search(ENGINEER, 'A-501 firestop lesson', { limit: 25 });
  assert.equal(
    hits.filter((h) => h.entity.id === 'ingest:lesson-a501').length, 1,
    'restored entity hits exactly once',
  );
  raw.close();
});
