import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_TENANT, InMemoryGraphStore, seedDemo } from '../dist/index.js';

const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };
const OTHER_FIRM = { tenantId: 'other-firm', principals: ['*'] };

async function seededStore() {
  const store = new InMemoryGraphStore();
  await seedDemo(store);
  return store;
}

test('deleteRelationship removes a single edge, scoped to the caller', async () => {
  const store = await seededStore();
  // Wrong tenant can't touch it.
  assert.equal(await store.deleteRelationship(OTHER_FIRM, 'rel:1'), false);
  assert.equal(await store.deleteRelationship(ENGINEER, 'missing'), false);

  assert.equal(await store.deleteRelationship(ENGINEER, 'rel:1'), true);
  const usedIn = await store.neighbors(ENGINEER, 'detail:cw-firestop-02', 'used-in');
  assert.equal(usedIn.length, 0, 'the used-in edge is gone');
  // Other edges on the same entity are untouched.
  const compliesWith = await store.neighbors(ENGINEER, 'detail:cw-firestop-02', 'complies-with');
  assert.equal(compliesWith.length, 1);
});

test('deleteRelationship refuses edges with an endpoint the caller cannot see (P0-7)', async () => {
  const store = new InMemoryGraphStore();
  const base = { tenantId: DEMO_TENANT, properties: {}, provenance: { createdAt: 'x', modifiedAt: 'x', reviewStatus: 'verified' } };
  await store.upsertEntity({ ...base, id: 'a', type: 'project', title: 'Public A', acl: { allowedPrincipals: ['*'] } });
  await store.upsertEntity({ ...base, id: 'b', type: 'document', title: 'Secret B', acl: { allowedPrincipals: ['group:legal'] } });
  await store.upsertRelationship({ id: 'r', tenantId: DEMO_TENANT, type: 'references', fromId: 'a', toId: 'b' });

  const engineer = { tenantId: DEMO_TENANT, principals: ['group:engineering'] };
  assert.equal(await store.deleteRelationship(engineer, 'r'), false, 'cannot delete into a hidden entity');
  const legal = { tenantId: DEMO_TENANT, principals: ['group:legal'] };
  assert.equal(await store.deleteRelationship(legal, 'r'), true, 'caller who sees both endpoints can');
});

test('mergeEntities repoints edges, drops the now-self-loop, and deletes the duplicate', async () => {
  const store = await seededStore();
  // Fold the superseded detail (01) into the current one (02).
  const result = await store.mergeEntities(ENGINEER, 'detail:cw-firestop-02', 'detail:cw-firestop-01');
  assert.ok(result, 'merge succeeded');
  // rel:5 (lesson applies-to 01) is repointed onto 02; rel:2 (02 supersedes 01)
  // collapses to a self-loop and is dropped.
  assert.equal(result.repointed, 1);
  assert.equal(result.dropped, 1);

  assert.equal(await store.getEntity(ENGINEER, 'detail:cw-firestop-01'), undefined, 'duplicate gone');
  const lesson = await store.neighbors(ENGINEER, 'lesson:firestop-mockup-failure', 'applies-to');
  assert.deepEqual(
    lesson.map((n) => n.entity.id),
    ['detail:cw-firestop-02'],
    'the lesson now points at the survivor',
  );
  // No dangling edge to the deleted entity remains anywhere.
  const all = await store.listRelationships(ENGINEER);
  assert.ok(
    all.every((r) => r.fromId !== 'detail:cw-firestop-01' && r.toId !== 'detail:cw-firestop-01'),
    'no edge references the merged-away id',
  );
});

test('mergeEntities dedupes a repointed edge against one the survivor already has', async () => {
  const store = new InMemoryGraphStore();
  const base = { tenantId: DEMO_TENANT, properties: {}, acl: { allowedPrincipals: ['*'] }, provenance: { createdAt: 'x', modifiedAt: 'x', reviewStatus: 'verified' } };
  for (const id of ['survivor', 'dup', 'target']) {
    await store.upsertEntity({ ...base, id, type: 'design-detail', title: id });
  }
  // Both survivor and dup already comply-with the same target.
  await store.upsertRelationship({ id: 'e1', tenantId: DEMO_TENANT, type: 'complies-with', fromId: 'survivor', toId: 'target' });
  await store.upsertRelationship({ id: 'e2', tenantId: DEMO_TENANT, type: 'complies-with', fromId: 'dup', toId: 'target' });

  const caller = { tenantId: DEMO_TENANT, principals: ['*'] };
  const result = await store.mergeEntities(caller, 'survivor', 'dup');
  assert.deepEqual(result, { survivorId: 'survivor', repointed: 0, dropped: 1 });
  const rels = await store.listRelationships(caller);
  assert.equal(rels.length, 1, 'the redundant edge collapsed into the existing one');
});

test('mergeEntities refuses same/missing/invisible ids', async () => {
  const store = await seededStore();
  assert.equal(await store.mergeEntities(ENGINEER, 'detail:cw-firestop-02', 'detail:cw-firestop-02'), undefined);
  assert.equal(await store.mergeEntities(ENGINEER, 'detail:cw-firestop-02', 'nope'), undefined);
  assert.equal(await store.mergeEntities(OTHER_FIRM, 'detail:cw-firestop-02', 'detail:cw-firestop-01'), undefined);
  // Both still present after a refused merge.
  assert.ok(await store.getEntity(ENGINEER, 'detail:cw-firestop-01'));
});
