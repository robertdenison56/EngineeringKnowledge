import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_TENANT,
  InMemoryGraphStore,
  seedDemo,
} from '../dist/index.js';

const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };
const LEGAL = { tenantId: DEMO_TENANT, principals: ['user:dana', 'group:legal'] };
const OTHER_FIRM = { tenantId: 'other-firm', principals: ['*'] };

async function seededStore() {
  const store = new InMemoryGraphStore();
  await seedDemo(store);
  return store;
}

test('search finds the firestop detail with provenance', async () => {
  const store = await seededStore();
  const hits = await store.search(ENGINEER, 'curtain wall firestop');
  assert.ok(hits.length > 0, 'expected hits');
  const top = hits[0];
  assert.equal(top.entity.type, 'design-detail');
  assert.ok(top.entity.provenance.anchor?.sheet, 'detail must carry a sheet anchor (P0-2a)');
});

test('superseded items carry a warning, never served clean (P0-8)', async () => {
  const store = await seededStore();
  const hits = await store.search(ENGINEER, 'firestop');
  const superseded = hits.find((h) => h.entity.id === 'detail:cw-firestop-01');
  assert.ok(superseded, 'superseded detail should still be findable');
  assert.match(superseded.warning ?? '', /superseded/i);
  const current = hits.find((h) => h.entity.id === 'detail:cw-firestop-02');
  assert.equal(current?.warning, undefined);
});

test('ACL trimming: restricted document hidden from non-legal callers (P0-7)', async () => {
  const store = await seededStore();
  const engineerHits = await store.search(ENGINEER, 'legal memo claim');
  assert.equal(
    engineerHits.find((h) => h.entity.id === 'document:claims-memo-riverside'),
    undefined,
  );
  const legalHits = await store.search(LEGAL, 'legal memo claim');
  assert.ok(legalHits.find((h) => h.entity.id === 'document:claims-memo-riverside'));
});

test('tenant isolation: other tenants see nothing (P0-3)', async () => {
  const store = await seededStore();
  const hits = await store.search(OTHER_FIRM, 'firestop curtain wall riverside');
  assert.equal(hits.length, 0);
  assert.equal(await store.getEntity(OTHER_FIRM, 'detail:cw-firestop-02'), undefined);
});

test('list browses by type with ACL trimming (P0-9 browse)', async () => {
  const store = await seededStore();
  const details = await store.list(ENGINEER, { types: ['design-detail'] });
  assert.equal(details.length, 2);
  const docsForEngineer = await store.list(ENGINEER, { types: ['document'] });
  assert.equal(docsForEngineer.length, 0, 'restricted document must not appear in browse');
  const docsForLegal = await store.list(LEGAL, { types: ['document'] });
  assert.equal(docsForLegal.length, 1);
});

test('multi-tag filtering and tag-aware search', async () => {
  const store = await seededStore();
  const firestop = await store.list(ENGINEER, { tags: ['firestop'] });
  assert.ok(firestop.length >= 4, 'tag filter finds tagged entities');
  const both = await store.list(ENGINEER, { tags: ['firestop', 'sealant'] });
  assert.deepEqual(both.map((e) => e.id), ['material:fs-195'], 'multiple tags AND together');
  const bySearch = await store.search(ENGINEER, 'envelope', { tags: ['firestop'] });
  assert.ok(bySearch.length >= 2, 'search terms match tag text too');
});

test('listRelationships only returns edges between visible entities (P0-7)', async () => {
  const store = await seededStore();
  const rels = await store.listRelationships(ENGINEER);
  assert.equal(rels.length, 7);
  assert.equal((await store.listRelationships(OTHER_FIRM)).length, 0);
});

test('deleteEntity removes the entity and its relationships (curation reject)', async () => {
  const store = await seededStore();
  assert.equal(await store.deleteEntity(OTHER_FIRM, 'detail:cw-firestop-01'), false);
  assert.equal(await store.deleteEntity(ENGINEER, 'detail:cw-firestop-01'), true);
  assert.equal(await store.getEntity(ENGINEER, 'detail:cw-firestop-01'), undefined);
  const fromCurrent = await store.neighbors(ENGINEER, 'detail:cw-firestop-02', 'supersedes');
  assert.equal(fromCurrent.length, 0, 'dangling relationships must be removed');
});

test('neighbors traverses typed relationships in both directions', async () => {
  const store = await seededStore();
  const all = await store.neighbors(ENGINEER, 'detail:cw-firestop-02');
  const ids = all.map((n) => n.entity.id).sort();
  assert.deepEqual(ids, [
    'detail:cw-firestop-01',
    'person:james-okafor',
    'project:riverside',
    'standard:astm-e2307',
  ]);
  const supersedes = await store.neighbors(ENGINEER, 'detail:cw-firestop-01', 'supersedes');
  assert.equal(supersedes.length, 1);
  assert.equal(supersedes[0].direction, 'in');
});

test('settings: round-trip, upsert in place, and tenant isolation', async () => {
  const store = new InMemoryGraphStore();
  assert.equal(await store.getSetting(DEMO_TENANT, 'firm-name'), undefined, 'unset reads undefined');
  await store.setSetting(DEMO_TENANT, 'firm-name', 'Acme Engineering');
  assert.equal(await store.getSetting(DEMO_TENANT, 'firm-name'), 'Acme Engineering');
  await store.setSetting(DEMO_TENANT, 'firm-name', 'Acme Structural');
  assert.equal(await store.getSetting(DEMO_TENANT, 'firm-name'), 'Acme Structural');
  assert.equal(await store.getSetting('other-firm', 'firm-name'), undefined, 'scoped per tenant');
});

test('deleteRelationship removes a visible edge and refuses hidden/cross-tenant ones', async () => {
  const store = await seededStore();
  const rels = await store.listRelationships(ENGINEER);
  const authored = rels.find((r) => r.type === 'authored-by');
  assert.ok(authored, 'seed carries an authored-by edge');

  assert.equal(await store.deleteRelationship(OTHER_FIRM, authored.id), false, 'cross-tenant delete refused');
  assert.equal(await store.deleteRelationship(ENGINEER, 'rel:no-such-edge'), false, 'missing edge reads false');
  assert.equal(await store.deleteRelationship(ENGINEER, authored.id), true);
  const after = await store.listRelationships(ENGINEER);
  assert.ok(!after.some((r) => r.id === authored.id), 'edge is gone');
});

test('mergeEntities repoints the duplicate’s edges onto the survivor and removes it', async () => {
  const store = await seededStore();
  // A duplicate of the current firestop detail, with one edge of its own.
  await store.upsertEntity({
    id: 'detail:cw-firestop-02-dupe',
    tenantId: DEMO_TENANT,
    type: 'design-detail',
    title: 'CW firestop detail (duplicate import)',
    properties: {},
    provenance: { createdAt: '2026-01-01', modifiedAt: '2026-01-01', reviewStatus: 'unverified' },
    acl: { allowedPrincipals: ['*'] },
  });
  await store.upsertRelationship({
    id: 'rel:dupe-lesson',
    tenantId: DEMO_TENANT,
    type: 'had-issue',
    fromId: 'detail:cw-firestop-02-dupe',
    toId: 'lesson:firestop-mockup-failure',
  });
  // An edge that duplicates one the survivor already has — must be dropped.
  await store.upsertRelationship({
    id: 'rel:dupe-used-in',
    tenantId: DEMO_TENANT,
    type: 'used-in',
    fromId: 'detail:cw-firestop-02-dupe',
    toId: 'project:riverside',
  });

  assert.equal(
    await store.mergeEntities(OTHER_FIRM, 'detail:cw-firestop-02', 'detail:cw-firestop-02-dupe'),
    undefined,
    'cross-tenant merge refused',
  );
  const merged = await store.mergeEntities(
    ENGINEER,
    'detail:cw-firestop-02',
    'detail:cw-firestop-02-dupe',
  );
  assert.equal(merged?.survivorId, 'detail:cw-firestop-02');
  assert.equal(merged?.repointed, 1, 'unique edge repointed');
  assert.equal(merged?.dropped, 1, 'edge the survivor already had is dropped');
  assert.equal(await store.getEntity(ENGINEER, 'detail:cw-firestop-02-dupe'), undefined, 'duplicate gone');

  const neighbors = await store.neighbors(ENGINEER, 'detail:cw-firestop-02');
  assert.ok(
    neighbors.some((n) => n.relationship.id === 'rel:dupe-lesson'),
    'duplicate’s unique edge repointed onto the survivor',
  );
  const usedIn = neighbors.filter((n) => n.relationship.type === 'used-in');
  assert.equal(usedIn.length, 1, 'edge already on the survivor is dropped, not doubled');
});
