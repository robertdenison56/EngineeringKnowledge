import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_TENANT, entityMatchesRole, seedDemo } from '@ekg/core';
import { SqliteGraphStore } from '../dist/index.js';

const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };

/** A lens that strongly favors lessons-learned — the demo has exactly one. */
const LESSON_ROLE = {
  id: 'qa-lessons',
  name: 'QA & Lessons',
  boostTags: [],
  boostTypes: ['lesson-learned'],
  weight: 3,
};

const rankOf = (hits, id) => hits.findIndex((h) => h.entity.id === id);

test('a retrieval role re-ranks favored items up without changing the result set', async () => {
  const store = new SqliteGraphStore(':memory:');
  await seedDemo(store);
  const q = 'firestop fire safety';

  const base = await store.search(ENGINEER, q, { limit: 25 });
  const boosted = await store.search(ENGINEER, q, { limit: 25, boostRole: LESSON_ROLE });

  // Membership is identical — a role only re-ranks, never admits or hides (P0-8).
  assert.deepEqual(
    new Set(boosted.map((h) => h.entity.id)),
    new Set(base.map((h) => h.entity.id)),
    'role must not add or remove results',
  );

  const lessonId = 'lesson:firestop-mockup-failure';
  const baseRank = rankOf(base, lessonId);
  const boostedRank = rankOf(boosted, lessonId);
  assert.ok(baseRank >= 0 && boostedRank >= 0, 'lesson present in both result sets');
  assert.ok(boostedRank <= baseRank, 'a favored item never sinks under its own lens');

  // A strong boost lifts the favored item to the top.
  assert.ok(
    entityMatchesRole(boosted[0].entity, LESSON_ROLE),
    `top result under the lens should be favored, got ${boosted[0].entity.id}`,
  );

  store.close();
});

test('a role cannot turn an honest no_results into results', async () => {
  const store = new SqliteGraphStore(':memory:');
  await seedDemo(store);
  const hits = await store.search(ENGINEER, 'zzz nonexistent topic zzz', {
    boostRole: LESSON_ROLE,
  });
  assert.equal(hits.length, 0, 'boost only scales already-admitted candidates (P0-8)');
  store.close();
});
