import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_TENANT } from '@ekg/core';
import { SqliteGraphStore } from '../dist/index.js';

/**
 * Page-first retrieval: a long document is reachable through the passage that
 * answers the question, not only through the bounded preview at its front
 * (ADR 0006). The gate is coverage — enough of the query to be worth citing —
 * and everything admitted this way is disclosed as a partial match and ranked
 * below every all-concepts hit (PRD P0-8).
 */

const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };

const BASE = {
  tenantId: DEMO_TENANT,
  properties: {},
  acl: { allowedPrincipals: ['*'] },
  provenance: { createdAt: 'x', modifiedAt: 'x', reviewStatus: 'verified' },
};

const chunk = (ordinal, page, heading, text) => ({
  id: `c${ordinal}`,
  tenantId: DEMO_TENANT,
  ordinal,
  anchor: { page },
  heading,
  text,
});

/**
 * A manual whose front matter says nothing about sight distance and whose
 * page 40 is the table that answers it — the shape every real spec book and
 * design manual has, and the one the preview-only gates cannot see past.
 */
async function manualStore() {
  const store = new SqliteGraphStore(':memory:');
  await store.upsertEntity(
    {
      ...BASE,
      id: 'doc:manual',
      type: 'document',
      title: 'Highway Design Manual Chapter 200',
      content: 'Foreword. Revision history. How to use this manual. '.repeat(40),
    },
    [
      chunk(0, 1, 'Page 1', 'Foreword. Revision history. How to use this manual.'),
      chunk(
        39,
        40,
        'Page 40',
        'Table 201.1 Sight Distance Standards. Design speed 45 mph: stopping sight distance 360 feet.',
      ),
    ],
  );
  return store;
}

test('a whole-sentence question reaches the page that answers it', async () => {
  const store = await manualStore();
  const hits = await store.search(
    ENGINEER,
    'According to Table 201.1, what is the minimum stopping sight distance for a design speed of 45 mph?',
  );
  assert.equal(hits.length, 1, 'the manual is found');
  assert.equal(hits[0].entity.id, 'doc:manual');
  assert.equal(hits[0].chunk.ordinal, 39, 'cites the page that carried the query, not page 1');
  assert.equal(hits[0].chunk.anchor.page, 40);
  assert.ok(
    hits[0].chunk.matchedConcepts < hits[0].chunk.ofConcepts,
    'coverage travels with the citation, so a best-coverage page is never served as an exact one',
  );
  assert.ok(hits[0].partial, 'and the hit itself is disclosed as partial');
  store.close();
});

test('a passage carrying too little of the query admits nothing (P0-8)', async () => {
  const store = await manualStore();
  // "sight distance" appears on page 40; nothing else in this query does.
  const hits = await store.search(
    ENGINEER,
    'sight distance requirements for tunnel ventilation shafts in coastal flood zones',
  );
  assert.deepEqual(hits, [], 'one concept in common is not a match');
  store.close();
});

test('relax:false turns the page pass off with the rest of the partial band', async () => {
  const store = await manualStore();
  const query =
    'According to Table 201.1, what is the minimum stopping sight distance for a design speed of 45 mph?';
  assert.equal((await store.search(ENGINEER, query)).length, 1, 'found by default');
  assert.deepEqual(
    await store.search(ENGINEER, query, { relax: false }),
    [],
    'a caller asking for all-concepts hits gets none of this',
  );
  store.close();
});

test('a short precise query still needs every concept', async () => {
  const store = await manualStore();
  // Two concepts, one of them absent: the coverage floor is the all-concepts
  // gate at this length, so page-first reach must not loosen it.
  assert.deepEqual(await store.search(ENGINEER, 'stopping culvert'), []);
  assert.equal((await store.search(ENGINEER, 'stopping sight')).length, 1);
  store.close();
});

test('an all-concepts hit outranks a page-coverage one', async () => {
  const store = await manualStore();
  await store.upsertEntity({
    ...BASE,
    id: 'detail:ssd',
    type: 'design-detail',
    title: 'Stopping sight distance design speed table check',
    summary: 'Minimum stopping sight distance for a design speed of 45 mph, per Table 201.1.',
  });
  const hits = await store.search(
    ENGINEER,
    'minimum stopping sight distance design speed 45 mph Table 201.1',
  );
  assert.equal(hits[0].entity.id, 'detail:ssd', 'the whole-query match leads');
  assert.equal(hits[0].partial, undefined);
  assert.ok(
    hits.slice(1).every((h) => h.partial),
    'the page-coverage hit follows it, disclosed',
  );
  store.close();
});
