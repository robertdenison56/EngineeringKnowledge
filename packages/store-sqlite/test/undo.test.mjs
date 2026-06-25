import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEMO_TENANT, JournaledGraphStore, undoOperation, seedDemo } from '@ekg/core';
import { SqliteGraphStore } from '../dist/index.js';

const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };

const BASE = {
  tenantId: DEMO_TENANT,
  properties: {},
  acl: { allowedPrincipals: ['*'] },
  provenance: { createdAt: 'x', modifiedAt: 'x', reviewStatus: 'verified' },
};

function harness(raw) {
  const journal = raw.createJournal();
  let ctx;
  const store = new JournaledGraphStore(raw, journal, () => ctx);
  let n = 0;
  async function run(meta, fn) {
    n += 1;
    const id = meta.id ?? `op-${n}`;
    const createdAt = meta.createdAt ?? new Date(1700000000000 + n * 1000).toISOString();
    journal.begin({
      id,
      tenantId: DEMO_TENANT,
      label: meta.label ?? 'op',
      kind: meta.kind ?? 'edit-entity',
      actor: 'user:test',
      createdAt,
    });
    ctx = { opId: id, caller: meta.caller ?? ENGINEER };
    try {
      return await fn();
    } finally {
      ctx = undefined;
      journal.commit(id);
    }
  }
  return { store, journal, run };
}

function tmpFile() {
  return path.join(tmpdir(), `ekg-undo-${process.pid}-${Date.now()}-${Math.floor(performance.now())}.db`);
}

test('undo of a merge restores the duplicate to the FTS index', async () => {
  const raw = new SqliteGraphStore(':memory:');
  await seedDemo(raw);
  const { store, journal, run } = harness(raw);

  await run({ kind: 'merge-entities' }, async () => {
    const survivor = await store.getEntity(ENGINEER, 'detail:cw-firestop-02');
    const duplicate = await store.getEntity(ENGINEER, 'detail:cw-firestop-01');
    await store.upsertEntity({ ...survivor, aliases: [...(survivor.aliases ?? []), duplicate.title] });
    await store.mergeEntities(ENGINEER, 'detail:cw-firestop-02', 'detail:cw-firestop-01');
  });
  let hits = await store.search(ENGINEER, 'firestop curtain wall');
  assert.ok(hits.every((h) => h.entity.id !== 'detail:cw-firestop-01'), 'duplicate dropped from FTS');

  const opId = journal.list(DEMO_TENANT, 1)[0].id;
  const res = await undoOperation(store, journal, opId, { caller: ENGINEER });
  assert.ok(res.ok);
  assert.ok(await store.getEntity(ENGINEER, 'detail:cw-firestop-01'), 'duplicate restored');
  const lesson = await store.neighbors(ENGINEER, 'lesson:firestop-mockup-failure', 'applies-to');
  assert.deepEqual(lesson.map((n) => n.entity.id), ['detail:cw-firestop-01'], 'edge repointed back');
  hits = await store.search(ENGINEER, 'firestop curtain wall');
  assert.ok(hits.some((h) => h.entity.id === 'detail:cw-firestop-01'), 'duplicate back in the FTS index');
});

test('undo of a fields-only edit leaves the document chunks searchable (ADR 0006)', async () => {
  const raw = new SqliteGraphStore(':memory:');
  const { store, journal, run } = harness(raw);
  await raw.upsertEntity({ ...BASE, id: 'doc', type: 'document', title: 'Original' }, [
    { id: 'doc#0', entityId: 'doc', tenantId: DEMO_TENANT, ordinal: 0, anchor: { page: 1 }, text: 'unique safing passage' },
  ]);

  await run({ kind: 'edit-entity' }, async () => {
    const e = await store.getEntity(ENGINEER, 'doc');
    await store.upsertEntity({ ...e, title: 'Renamed' }); // chunks omitted
  });
  const opId = journal.list(DEMO_TENANT, 1)[0].id;
  await undoOperation(store, journal, opId, { caller: ENGINEER });

  assert.equal((await store.getEntity(ENGINEER, 'doc')).title, 'Original');
  const hits = await store.search(ENGINEER, 'unique safing passage');
  assert.ok(hits.some((h) => h.entity.id === 'doc'), 'chunk survived the edit and the undo');
});

test('undo of a bulk import removes every entity and reference edge', async () => {
  const raw = new SqliteGraphStore(':memory:');
  const { store, journal, run } = harness(raw);
  await run({ kind: 'ingest-uploads', label: 'Imported 2 sheets' }, async () => {
    await store.upsertEntity({ ...BASE, id: 'a101', type: 'document', title: 'A-101' }, []);
    await store.upsertEntity({ ...BASE, id: 'a102', type: 'document', title: 'A-102' }, []);
    await store.upsertRelationship({ id: 'ref', tenantId: DEMO_TENANT, type: 'references', fromId: 'a101', toId: 'a102' });
  });
  assert.equal((await store.list(ENGINEER)).length, 2);
  assert.equal((await store.listRelationships(ENGINEER)).length, 1);

  const opId = journal.list(DEMO_TENANT, 1)[0].id;
  await undoOperation(store, journal, opId, { caller: ENGINEER });
  assert.equal((await store.list(ENGINEER)).length, 0, 'entities gone');
  assert.equal((await store.listRelationships(ENGINEER)).length, 0, 'reference edge gone');
});

test('the journal persists before-images across a store reopen', async () => {
  const file = tmpFile();
  try {
    {
      const raw = new SqliteGraphStore(file);
      const journal = raw.createJournal();
      let ctx;
      const store = new JournaledGraphStore(raw, journal, () => ctx);
      await raw.upsertEntity({ ...BASE, id: 'z', type: 'project', title: 'Z0' });
      journal.begin({
        id: 'op-1',
        tenantId: DEMO_TENANT,
        label: 'Edited “Z”',
        kind: 'edit-entity',
        actor: 'user:test',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      ctx = { opId: 'op-1', caller: ENGINEER };
      const e = await store.getEntity(ENGINEER, 'z');
      await store.upsertEntity({ ...e, title: 'Z1' });
      ctx = undefined;
      journal.commit('op-1');
      raw.close();
    }
    {
      const raw = new SqliteGraphStore(file);
      const journal = raw.createJournal();
      let ctx;
      const store = new JournaledGraphStore(raw, journal, () => ctx);
      const list = journal.list(DEMO_TENANT);
      assert.equal(list.length, 1, 'operation survived the restart');
      assert.equal(list[0].label, 'Edited “Z”');
      assert.equal((await store.getEntity(ENGINEER, 'z')).title, 'Z1');
      const res = await undoOperation(store, journal, 'op-1', { caller: ENGINEER });
      assert.ok(res.ok);
      assert.equal((await store.getEntity(ENGINEER, 'z')).title, 'Z0', 'undo works after reopen');
      raw.close();
    }
  } finally {
    rmSync(file, { force: true });
  }
});
