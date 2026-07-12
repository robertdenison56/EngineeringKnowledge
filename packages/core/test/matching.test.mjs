import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQueryGroups,
  canonicalizeIdentifiers,
  normalizeText,
  DEMO_TENANT,
  InMemoryGraphStore,
  seedDemo,
} from '../dist/index.js';

const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };

test('canonicalizeIdentifiers collapses a section code to one atomic token', () => {
  assert.equal(canonicalizeIdentifiers('07 84 00'), '078400');
  assert.equal(canonicalizeIdentifiers('07.84.00'), '078400');
  assert.equal(canonicalizeIdentifiers('07-84-00'), '078400');
  // Level-4 (2-2-2-2) sections collapse too.
  assert.equal(canonicalizeIdentifiers('09 91 23.13'), '09912313');
  // Only the code is touched; surrounding prose is preserved.
  assert.equal(canonicalizeIdentifiers('see section 07 84 00 for firestopping'), 'see section 078400 for firestopping');
});

test('canonicalizeIdentifiers leaves non-section number runs alone', () => {
  // A year and a two-pair run are not 2-2-2 section codes.
  assert.equal(canonicalizeIdentifiers('completed 2024 06'), 'completed 2024 06');
  assert.equal(canonicalizeIdentifiers('a 4 pcf mineral wool'), 'a 4 pcf mineral wool');
});

test('normalizeText maps every spelling of a section code to one form', () => {
  const forms = ['07 84 00', '07.84.00', '07-84-00', '078400', 'Section 07 84 00'];
  const normalized = forms.map(normalizeText);
  assert.ok(normalized.every((n) => n.includes('078400')), `expected 078400 in all, got ${JSON.stringify(normalized)}`);
});

test('buildQueryGroups treats a section code as a single concept, not three', () => {
  // Before canonicalization this split into [["07"],["84"],["00"]] — three
  // ANDed concepts, so the compact form could never satisfy them all.
  assert.deepEqual(buildQueryGroups('07 84 00'), [['078400']]);
  assert.deepEqual(buildQueryGroups('section 078400'), [['section'], ['078400']]);
});

test('search finds a spec section by its compact code (the fix)', async () => {
  const store = new InMemoryGraphStore();
  await seedDemo(store);
  // The seed stores "07 84 00" (spaced); querying the compact form used to miss.
  const hits = await store.search(ENGINEER, 'section 078400');
  assert.equal(hits[0]?.entity.id, 'spec:07-84-00', `expected spec:07-84-00, got [${hits.map((h) => h.entity.id).join(', ')}]`);
});

test('section-code canonicalization stays honest: an absent section returns nothing', async () => {
  const store = new InMemoryGraphStore();
  await seedDemo(store);
  const hits = await store.search(ENGINEER, 'section 09 91 00');
  assert.equal(hits.length, 0, `expected no results, got [${hits.map((h) => h.entity.id).join(', ')}]`);
});
