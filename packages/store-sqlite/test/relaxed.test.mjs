import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_TENANT, seedDemo } from '@ekg/core';
import { SqliteGraphStore } from '../dist/index.js';

const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };

const BASE = {
  tenantId: DEMO_TENANT,
  properties: {},
  acl: { allowedPrincipals: ['*'] },
  provenance: { createdAt: 'x', modifiedAt: 'x', reviewStatus: 'verified' },
};

/**
 * Fixture where the query's concepts are real but split across entities, so
 * the strict AND admits nothing and the relaxed pass has work to do:
 * - detail:cw matches curtain/wall/firestop (3 of 5 concepts)
 * - note:riverside matches riverside/camber (2 of 5, the threshold)
 */
async function relaxFixture() {
  const store = new SqliteGraphStore(':memory:');
  await store.upsertEntity({
    ...BASE, id: 'detail:cw', type: 'design-detail', title: 'Curtain wall firestop detail',
  });
  await store.upsertEntity({
    ...BASE, id: 'note:riverside', type: 'document', title: 'Riverside camber note',
  });
  return store;
}

const SPLIT_QUERY = 'curtain wall firestop riverside camber';

test('relaxed pass: partial hits with honest matched/missing disclosure when strict finds nothing', async () => {
  const store = await relaxFixture();

  const hits = await store.search(ENGINEER, SPLIT_QUERY);
  assert.deepEqual(
    hits.map((h) => h.entity.id),
    ['detail:cw', 'note:riverside'],
    'more matched concepts rank higher',
  );

  const [detail, note] = hits;
  assert.deepEqual(detail.partial, {
    matchedConcepts: ['curtain', 'wall', 'firestop'],
    missingConcepts: ['riverside', 'camber'],
  });
  assert.deepEqual(note.partial, {
    matchedConcepts: ['riverside', 'camber'],
    missingConcepts: ['curtain', 'wall', 'firestop'],
  });
  assert.ok(hits.every((h) => h.chunk === undefined), 'relaxed hits carry no passage citation');

  // The store's normal limit still caps relaxed results.
  assert.equal((await store.search(ENGINEER, SPLIT_QUERY, { limit: 1 })).length, 1);
  store.close();
});

test('relax: false keeps the hard no_results behavior', async () => {
  const store = await relaxFixture();
  assert.deepEqual(await store.search(ENGINEER, SPLIT_QUERY, { relax: false }), []);
  store.close();
});

test('a partial hit may join a strict result, but never above it', async () => {
  const store = await relaxFixture();
  // Matches 2 of 3 concepts of the query below — admitted, and disclosed.
  await store.upsertEntity({
    ...BASE, id: 'note:riverside-2', type: 'document', title: 'Riverside camber addendum',
  });

  const hits = await store.search(ENGINEER, 'riverside camber note');
  assert.equal(hits[0].entity.id, 'note:riverside', 'the all-concepts hit leads');
  assert.equal(hits[0].partial, undefined, 'strict hits are never tagged partial');
  // Every hit after the first is partial, and every partial hit says so: the
  // bands are ordered, and nothing in the second band pretends to be in the
  // first (P0-8).
  assert.ok(
    hits.slice(1).every((h) => h.partial),
    'partial hits follow, disclosed',
  );
  store.close();
});

test('queries under three concepts never relax (P0-8)', async () => {
  const store = await relaxFixture();
  // 'camber' alone matches note:riverside, but 1 of 2 concepts must not surface it.
  assert.deepEqual(await store.search(ENGINEER, 'camber tolerances'), []);
  store.close();
});

test('nothing above the threshold means no_results, even relaxed', async () => {
  const store = await relaxFixture();
  assert.deepEqual(await store.search(ENGINEER, 'zzz yyy xxx www'), []);
  store.close();
});

test('relaxed scores take the same review-status multiplier and role boost as strict', async () => {
  const store = await relaxFixture();
  // Same concept coverage as detail:cw, but deprecated — must sink below it.
  await store.upsertEntity({
    ...BASE,
    id: 'lesson:cw-old',
    type: 'lesson-learned',
    title: 'Curtain wall firestop detail (superseded practice)',
    provenance: { ...BASE.provenance, reviewStatus: 'deprecated' },
  });

  const hits = await store.search(ENGINEER, SPLIT_QUERY);
  assert.deepEqual(
    hits.map((h) => h.entity.id),
    ['detail:cw', 'lesson:cw-old', 'note:riverside'],
    'status multiplier sinks the deprecated twin below the verified one',
  );
  assert.match(hits[1].warning ?? '', /deprecated/i, 'flagged items are never served clean');

  // A role lens re-ranks relaxed hits exactly as it does strict ones.
  const role = { id: 'qa', name: 'QA', boostTags: [], boostTypes: ['lesson-learned'], weight: 3 };
  const boosted = await store.search(ENGINEER, SPLIT_QUERY, { boostRole: role });
  assert.equal(boosted[0].entity.id, 'lesson:cw-old', 'role boost applies to relaxed scores');
  assert.deepEqual(
    new Set(boosted.map((h) => h.entity.id)),
    new Set(hits.map((h) => h.entity.id)),
    'a role re-ranks, never admits or hides (P0-8)',
  );
  store.close();
});

test('graph-expansion never runs off relaxed hits', async () => {
  const store = await relaxFixture();
  // A neighbor of the strongest relaxed hit that matches no query concept:
  // expansion (default on) would surface it — the relaxed pass must not.
  await store.upsertEntity({
    ...BASE, id: 'project:zebra', type: 'project', title: 'Zebra Tower',
  });
  await store.upsertRelationship({
    id: 'rel:cw-zebra', tenantId: DEMO_TENANT, type: 'used-in',
    fromId: 'detail:cw', toId: 'project:zebra',
  });

  const hits = await store.search(ENGINEER, SPLIT_QUERY, { limit: 25 });
  assert.ok(hits.every((h) => h.entity.id !== 'project:zebra'), 'no neighbors from partial matches');
  assert.ok(hits.every((h) => h.partial), 'every relaxed hit is disclosed as partial');
  store.close();
});

test('the golden honest-no-results cases stay empty with relaxation on (eval gate)', async () => {
  const store = new SqliteGraphStore(':memory:');
  await seedDemo(store);
  assert.deepEqual(await store.search(ENGINEER, 'section 09 91 00', { limit: 5 }), []);
  assert.deepEqual(await store.search(ENGINEER, 'standard parapet coping detail', { limit: 5 }), []);
  store.close();
});
