import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_TENANT, seedDemo } from '@ekg/core';
import { SqliteGraphStore } from '../dist/index.js';

/**
 * Passage citation (ADR 0006 / PRD P0-2a): a document or spec hit must resolve
 * to the page or section it matched, not just the file. These cover the
 * citation-attachment fallback in `citationChunk` — which exists because entity
 * admission does substring matching while FTS5 is token-based, so an entity can
 * be admitted by a gate that chunk FTS cannot reproduce — and the invariant
 * that the fallback is citation-only and never widens what search returns.
 */

const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };
const LEGAL = { tenantId: DEMO_TENANT, principals: ['user:counsel', 'group:legal'] };

const BASE = {
  tenantId: DEMO_TENANT,
  properties: {},
  acl: { allowedPrincipals: ['*'] },
  provenance: { createdAt: 'x', modifiedAt: 'x', reviewStatus: 'verified' },
};

async function seeded() {
  const store = new SqliteGraphStore(':memory:');
  await seedDemo(store);
  return store;
}

test('the demo spec book carries passages, so a spec hit can cite a section', async () => {
  const store = await seeded();
  const chunks = await store.getChunks(ENGINEER, 'spec:07-84-00');
  assert.equal(chunks.length, 3, 'PART 1 / PART 2 / PART 3');
  assert.deepEqual(
    chunks.map((c) => c.anchor.specSection),
    ['07 84 00', '07 84 00', '07 84 00'],
  );
});

test('substring-admitted hit still cites a passage (the FTS-tokenization gap)', async () => {
  const store = await seeded();
  // "stopping" is a substring of "firestopping" but not an FTS5 token of it,
  // so chunk FTS cannot admit this — the lexical fallback supplies the cite.
  const [hit] = await store.search(ENGINEER, 'fire stopping spec', { limit: 1 });
  assert.equal(hit.entity.id, 'spec:07-84-00');
  assert.ok(hit.chunk, 'hit cites a passage rather than the whole file');
  assert.equal(hit.chunk.anchor.specSection, '07 84 00');
  assert.ok(hit.chunk.snippet.length > 0, 'citation carries a readable snippet');
});

test('a deep-content query lands on the passage that answers it, not page 1', async () => {
  const store = await seeded();

  const [products] = await store.search(ENGINEER, '25 percent compression mineral wool', {
    limit: 1,
  });
  assert.equal(products.entity.id, 'spec:07-84-00');
  assert.match(products.chunk.heading, /PART 2/, 'the compression requirement lives in PRODUCTS');

  const [execution] = await store.search(ENGINEER, 'special inspector compression continuity', {
    limit: 1,
  });
  assert.match(execution.chunk.heading, /PART 3/, 'field QC lives in EXECUTION');
});

test('no passage containing the concepts means no citation, not an arbitrary page', async () => {
  const store = new SqliteGraphStore(':memory:');
  // Entity metadata carries "warranty"; the passage does not mention it.
  await store.upsertEntity(
    { ...BASE, id: 'spec:roofing', type: 'spec-section', title: 'Roofing warranty spec' },
    [
      {
        id: 'spec:roofing#0',
        entityId: 'spec:roofing',
        tenantId: DEMO_TENANT,
        ordinal: 0,
        anchor: { page: 1 },
        text: 'PART 1 GENERAL. Membrane roofing over tapered insulation.',
      },
    ],
  );

  const [hit] = await store.search(ENGINEER, 'roofing warranty', { limit: 1 });
  assert.equal(hit.entity.id, 'spec:roofing', 'still admitted on its metadata');
  assert.equal(hit.chunk, undefined, 'declines to cite a passage that does not say it');
});

test('citation attachment never widens the result set (P0-8 gate is upstream)', async () => {
  const store = await seeded();
  // Concepts that appear only in the spec passages must not drag in entities
  // whose own passages never mention them, and an absent concept stays absent.
  const absent = await store.search(ENGINEER, 'parapet coping termination bar');
  assert.deepEqual(absent, [], 'honest no_results survives the chunk fallback');

  const hits = await store.search(ENGINEER, 'hose stream test mockup requirement');
  assert.ok(hits.length > 0);
  for (const h of hits) {
    assert.ok(h.chunk === undefined || h.chunk.snippet.length > 0);
  }
});

test('restricted passages inherit the parent ACL and never leak', async () => {
  const store = await seeded();
  const query = 'riverside schedule claim privileged memo';

  assert.deepEqual(
    await store.search(ENGINEER, query),
    [],
    'an engineer sees neither the memo nor its passages',
  );

  const [hit] = await store.search(LEGAL, query, { limit: 1 });
  assert.equal(hit.entity.id, 'document:claims-memo-riverside');
  assert.ok(hit.chunk, 'counsel gets the passage-level citation');

  assert.deepEqual(
    await store.getChunks(ENGINEER, 'document:claims-memo-riverside'),
    [],
    'getChunks is permission-trimmed via the parent, not just search',
  );
});

/**
 * Best-coverage citation: a whole-sentence question tokenizes into far more
 * concepts than any one passage carries, and requiring all of them cited the
 * file and no page — the caller then had to fetch the whole document back to
 * read what it had already matched. `bestCitationChunk` cites the passage
 * carrying most of the query instead, above a floor, and discloses how much.
 */
test('a long question cites the passage carrying most of it, and says how much', async () => {
  const store = new SqliteGraphStore(':memory:');
  await store.upsertEntity(
    {
      ...BASE,
      id: 'doc:hdm',
      type: 'standard',
      title: 'Highway Design Manual chapter 200',
      // Admission is entity-level, off the stored body — as it is for a real
      // ingested document. No single passage carries every concept.
      content:
        'Chapter 200 Geometric Design. Minimum geometric design controls. ' +
        'Table 201.1 Sight Distance Standards. Design speed 45 mph: stopping 360 ft, passing 1100 ft.',
    },
    [
      {
        id: 'doc:hdm#0',
        entityId: 'doc:hdm',
        tenantId: DEMO_TENANT,
        ordinal: 0,
        anchor: { page: 1 },
        heading: 'Chapter 200 Geometric Design',
        text: 'This chapter covers minimum geometric design controls and their application.',
      },
      {
        id: 'doc:hdm#1',
        entityId: 'doc:hdm',
        tenantId: DEMO_TENANT,
        ordinal: 1,
        anchor: { page: 2 },
        heading: 'Table 201.1 Sight Distance Standards',
        text: 'Table 201.1 Sight Distance Standards. Design speed 45 mph: stopping 360 ft, passing 1100 ft.',
      },
    ],
  );

  const [hit] = await store.search(
    ENGINEER,
    'minimum stopping sight distance for a design speed of 45 mph in Table 201.1',
    { limit: 1 },
  );
  assert.equal(hit.chunk.anchor.page, 2, 'cites the table page, not the chapter opener');
  assert.ok(
    hit.chunk.matchedConcepts < hit.chunk.ofConcepts,
    'a best-coverage pick reports itself as one',
  );
  assert.ok(hit.chunk.matchedConcepts / hit.chunk.ofConcepts >= 0.6, 'and clears the floor');
  assert.match(hit.chunk.text, /360 ft/, 'the passage comes back in full, ready to answer from');
});

test('a two-concept query still needs both — the floor does not loosen short queries', async () => {
  const store = new SqliteGraphStore(':memory:');
  await store.upsertEntity(
    { ...BASE, id: 'spec:roofing2', type: 'spec-section', title: 'Roofing warranty spec' },
    [
      {
        id: 'spec:roofing2#0',
        entityId: 'spec:roofing2',
        tenantId: DEMO_TENANT,
        ordinal: 0,
        anchor: { page: 1 },
        text: 'PART 1 GENERAL. Membrane roofing over tapered insulation.',
      },
    ],
  );
  const [hit] = await store.search(ENGINEER, 'roofing warranty', { limit: 1 });
  assert.equal(hit.entity.id, 'spec:roofing2');
  assert.equal(hit.chunk, undefined, 'ceil(2 x 0.6) = 2, so one of two concepts still declines');
});

test('a relaxed (partial) hit now carries a passage, and still discloses what it missed', async () => {
  const store = new SqliteGraphStore(':memory:');
  await store.upsertEntity(
    {
      ...BASE,
      id: 'doc:hdm2',
      type: 'standard',
      title: 'Highway Design Manual',
      content: 'Superelevation runoff is distributed along the transition on every curve.',
    },
    [
      {
        id: 'doc:hdm2#0',
        entityId: 'doc:hdm2',
        tenantId: DEMO_TENANT,
        ordinal: 0,
        anchor: { page: 7 },
        heading: 'Superelevation',
        text: 'Superelevation runoff is distributed along the transition on every curve.',
      },
    ],
  );
  // "monorail" appears nowhere, so the strict pass admits nothing and the
  // most-concepts fallback takes over.
  const [hit] = await store.search(ENGINEER, 'superelevation runoff transition monorail', {
    limit: 1,
  });
  assert.ok(hit.partial, 'still disclosed as a partial match');
  assert.deepEqual(hit.partial.missingConcepts, ['monorail']);
  assert.equal(hit.chunk.anchor.page, 7, 'and now points at the passage it did match');
  assert.ok(hit.chunk.matchedConcepts < hit.chunk.ofConcepts);
});

test('best-coverage citation never widens the result set', async () => {
  const store = await seeded();
  // Same invariant as the strict fallback: citation runs after admission, so
  // relaxing which passage may be cited must not admit an entity.
  const absent = await store.search(ENGINEER, 'parapet coping termination bar', { relax: false });
  assert.deepEqual(absent, [], 'honest no_results survives the best-coverage pick');
});
