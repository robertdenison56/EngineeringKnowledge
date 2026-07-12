import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_TENANT, seedDemo } from '@ekg/core';
import { SqliteGraphStore } from '../dist/index.js';

const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };

async function seededStore() {
  const store = new SqliteGraphStore(':memory:');
  await seedDemo(store);
  return store;
}

test('mergeEntities repoints, drops the self-loop, and removes the duplicate (parity with in-memory)', async () => {
  const store = await seededStore();
  const result = await store.mergeEntities(ENGINEER, 'detail:cw-firestop-02', 'detail:cw-firestop-01');
  assert.deepEqual(result, { survivorId: 'detail:cw-firestop-02', repointed: 1, dropped: 1 });

  assert.equal(await store.getEntity(ENGINEER, 'detail:cw-firestop-01'), undefined);
  const lesson = await store.neighbors(ENGINEER, 'lesson:firestop-mockup-failure', 'applies-to');
  assert.deepEqual(lesson.map((n) => n.entity.id), ['detail:cw-firestop-02']);

  // The merged-away entity must no longer be findable by search either.
  const hits = await store.search(ENGINEER, 'firestop curtain wall');
  assert.ok(
    hits.every((h) => h.entity.id !== 'detail:cw-firestop-01'),
    'duplicate is dropped from the FTS index too',
  );
});

test('mergeEntities deletes the duplicate document chunks', async () => {
  const store = new SqliteGraphStore(':memory:');
  const base = {
    tenantId: DEMO_TENANT,
    properties: {},
    acl: { allowedPrincipals: ['*'] },
    provenance: { createdAt: 'x', modifiedAt: 'x', reviewStatus: 'verified' },
  };
  await store.upsertEntity({ ...base, id: 'survivor', type: 'document', title: 'Survivor' }, []);
  await store.upsertEntity({ ...base, id: 'dup', type: 'document', title: 'Duplicate scan' }, [
    { id: 'dup#0', entityId: 'dup', tenantId: DEMO_TENANT, ordinal: 0, anchor: { page: 1 }, text: 'unique firestop passage' },
  ]);

  const caller = { tenantId: DEMO_TENANT, principals: ['*'] };
  assert.equal((await store.getChunks(caller, 'dup')).length, 1);
  await store.mergeEntities(caller, 'survivor', 'dup');
  assert.equal((await store.getChunks(caller, 'dup')).length, 0, 'chunks removed with the entity');
  const hits = await store.search(caller, 'unique firestop passage');
  assert.equal(hits.length, 0, 'duplicate chunk is out of the chunk FTS index');
});

test('deleteRelationship removes one edge in SQLite', async () => {
  const store = await seededStore();
  assert.equal(await store.deleteRelationship(ENGINEER, 'rel:1'), true);
  assert.equal(await store.deleteRelationship(ENGINEER, 'rel:1'), false, 'already gone');
  const usedIn = await store.neighbors(ENGINEER, 'detail:cw-firestop-02', 'used-in');
  assert.equal(usedIn.length, 0);
});
