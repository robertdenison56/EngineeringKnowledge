import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQueryGroups,
  relaxationThreshold,
  relaxedScoreEntityMatch,
  warningFor,
  DEMO_TENANT,
  InMemoryGraphStore,
  seedDemo,
} from '../dist/index.js';

const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };
const LEGAL = { tenantId: DEMO_TENANT, principals: ['user:dana', 'group:legal'] };

async function seededStore() {
  const store = new InMemoryGraphStore();
  await seedDemo(store);
  return store;
}

test('buildQueryGroups folds plurals into singular candidates, keeping synonyms', () => {
  const [firestops] = buildQueryGroups('firestops');
  assert.ok(firestops.includes('firestop'), `expected singular fold, got ${JSON.stringify(firestops)}`);
  const [assemblies] = buildQueryGroups('assemblies');
  assert.ok(assemblies.includes('assembly'), '"ies" folds to "y"');
  const [specifications] = buildQueryGroups('specifications');
  assert.ok(specifications.includes('spec'), 'synonyms survive alongside folding');
  assert.ok(specifications.includes('specification'), 'trailing "s" dropped');
  // "ss" endings are not plurals and must not fold to a nonsense stem.
  const [glass] = buildQueryGroups('glass');
  assert.deepEqual(glass, ['glass']);
});

test('plural query matches a singular corpus (the false-negative fix)', async () => {
  const store = await seededStore();
  // Seed says "firestop" (singular); this used to return 0 hits.
  const hits = await store.search(ENGINEER, 'curtain wall firestops');
  assert.ok(hits.length > 0, 'expected hits for the plural query');
  assert.equal(hits[0].entity.type, 'design-detail');
  assert.equal(hits[0].partial, undefined, 'a full strict match must not be tagged partial');
});

test('singular query matches a plural corpus (substring direction)', async () => {
  const store = await seededStore();
  await store.upsertEntity({
    id: 'detail:parapet-joints',
    tenantId: DEMO_TENANT,
    type: 'design-detail',
    title: 'Expansion joints at parapets',
    properties: {},
    provenance: { createdAt: '2026-01-01', modifiedAt: '2026-01-01', reviewStatus: 'verified' },
    acl: { allowedPrincipals: ['*'] },
  });
  const hits = await store.search(ENGINEER, 'expansion joint parapet');
  assert.equal(hits[0]?.entity.id, 'detail:parapet-joints');
  assert.equal(hits[0].partial, undefined);
});

test('relaxationThreshold: no relaxation under three concepts, then a majority of at least two', () => {
  assert.equal(relaxationThreshold(0), 0);
  assert.equal(relaxationThreshold(1), 0);
  assert.equal(relaxationThreshold(2), 0);
  assert.equal(relaxationThreshold(3), 2);
  assert.equal(relaxationThreshold(4), 2);
  assert.equal(relaxationThreshold(5), 2);
  assert.equal(relaxationThreshold(6), 3);
  assert.equal(relaxationThreshold(7), 3);
});

test('concepts split across entities return relaxed hits with partial disclosure', async () => {
  const store = await seededStore();
  // No single entity carries all five concepts; strict returns 0 here.
  const hits = await store.search(ENGINEER, 'curtain wall firestop detail Riverside');
  assert.ok(hits.length > 0, 'expected relaxed hits');
  assert.ok(hits.every((h) => h.partial), 'every relaxed hit must disclose partial');
  assert.ok(hits.every((h) => h.chunk === undefined), 'no chunk citation on relaxed hits');

  const detail = hits.find((h) => h.entity.id === 'detail:cw-firestop-02');
  assert.ok(detail, 'the detail matching 4 of 5 concepts must surface');
  assert.deepEqual(
    [...detail.partial.matchedConcepts].sort(),
    ['curtain', 'detail', 'firestop', 'wall'],
  );
  assert.deepEqual(detail.partial.missingConcepts, ['riverside']);

  const project = hits.find((h) => h.entity.id === 'project:riverside');
  assert.ok(project, 'the project matching the other concepts must surface');
  assert.ok(project.partial.matchedConcepts.includes('riverside'));
  assert.ok(detail.score > project.score, 'more matched concepts rank higher');
});

test('relax:false suppresses the fallback and keeps hard no_results', async () => {
  const store = await seededStore();
  const hits = await store.search(ENGINEER, 'curtain wall firestop detail Riverside', {
    relax: false,
  });
  assert.equal(hits.length, 0, `expected no results, got [${hits.map((h) => h.entity.id).join(', ')}]`);
});

test('strict results present: no partial hits mixed in', async () => {
  const store = await seededStore();
  const hits = await store.search(ENGINEER, 'curtain wall firestop');
  assert.ok(hits.length > 0, 'expected strict hits');
  assert.ok(hits.every((h) => h.partial === undefined), 'strict and relaxed must never mix');
});

test('queries under three concepts never relax', async () => {
  const store = await seededStore();
  // "firestop" matches plenty, "unicorn" nothing — but two concepts must not relax.
  const hits = await store.search(ENGINEER, 'firestop unicorn');
  assert.equal(hits.length, 0, `expected no results, got [${hits.map((h) => h.entity.id).join(', ')}]`);
});

test('relaxedScoreEntityMatch gates on the threshold and reports matched indices', () => {
  const entity = {
    id: 'x',
    tenantId: 't',
    type: 'design-detail',
    title: 'Curtain wall firestop',
    properties: {},
    provenance: { createdAt: '', modifiedAt: '', reviewStatus: 'verified' },
    acl: { allowedPrincipals: ['*'] },
  };
  const groups = buildQueryGroups('curtain wall parapet coping riverside');
  const { score, matchedGroups } = relaxedScoreEntityMatch(entity, groups);
  assert.deepEqual(matchedGroups, [0, 1], 'indices into the query groups');
  assert.ok(score > 0, 'two of five meets the threshold of two');
  const below = relaxedScoreEntityMatch(entity, buildQueryGroups('curtain parapet coping riverside gasket'));
  assert.equal(below.score, 0, 'one matched group of five is below the threshold');
});

test('relaxed pass still trims by ACL (P0-7)', async () => {
  const store = await seededStore();
  const query = 'riverside legal memo firestop claim';
  const engineerHits = await store.search(ENGINEER, query);
  assert.equal(
    engineerHits.find((h) => h.entity.id === 'document:claims-memo-riverside'),
    undefined,
    'a partial match must never leak a restricted document',
  );
  const legalHits = await store.search(LEGAL, query);
  assert.ok(legalHits.find((h) => h.entity.id === 'document:claims-memo-riverside'));
});

test('unverified items carry the curator-review warning (P0-8)', async () => {
  assert.match(warningFor('unverified') ?? '', /unverified candidate awaiting curator review/);
  const store = await seededStore();
  const hits = await store.search(ENGINEER, 'intumescent sealant product');
  const candidate = hits.find((h) => h.entity.id === 'material:fs-195');
  assert.ok(candidate, 'unverified candidate should still be findable');
  assert.match(candidate.warning ?? '', /unverified/i);
});
