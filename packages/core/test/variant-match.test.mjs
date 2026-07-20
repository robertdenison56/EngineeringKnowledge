import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQueryGroups,
  normalizeText,
  scoreEntityMatch,
  variantMatches,
} from '../dist/matching.js';

/**
 * Word-level concept matching (`variantMatches`). These pin a genuine tension:
 * the matcher must reject syllable-level accidents ("air" inside "stair") while
 * still matching AEC compounds ("stopping" inside "firestopping"). Pure
 * token-boundary matching satisfies the first and breaks the second, so if a
 * future change swaps this for a \b regex, the compound cases below fail loudly
 * rather than silently costing recall on the golden set.
 */

const BASE = {
  tenantId: 't',
  properties: {},
  acl: { allowedPrincipals: ['*'] },
  provenance: { createdAt: 'x', modifiedAt: 'x', reviewStatus: 'verified' },
};

test('a match at a token start counts — exact tokens and prefixes', () => {
  assert.ok(variantMatches('air barrier continuity', 'air'), 'exact token');
  assert.ok(variantMatches('the specification governs', 'spec'), 'prefix of a longer token');
  assert.ok(variantMatches('firestopping systems', 'firestop'), 'prefix of a compound');
  assert.ok(variantMatches('sealant joint', 'seal'), 'prefix, not a syllable accident');
});

test('a short variant inside a token does NOT count (the precision leak)', () => {
  assert.equal(variantMatches('stair tread repair', 'air'), false, '"air" is not in "stair"');
  assert.equal(variantMatches('chair rail', 'air'), false);
  assert.equal(variantMatches('drywall partition', 'wall'), false, 'drywall is not a wall assembly');
});

test('a long variant inside a token DOES count (AEC compounds)', () => {
  // normalizeText strips hyphens, so "fire-stopping" collapses to one token and
  // the concept "stopping" is a standalone token nowhere in the corpus.
  assert.equal(normalizeText('fire-stopping'), 'firestopping');
  assert.ok(variantMatches('firestopping systems', 'stopping'), 'the golden-set case');
  assert.ok(variantMatches('waterproofing membrane', 'proofing'));
});

test('a variant counts if ANY occurrence sits at a token boundary', () => {
  // "air" is buried in "repair" but stands alone later — the scan must not stop
  // at the first (rejected) occurrence.
  assert.ok(variantMatches('repair the air barrier', 'air'));
});

test('the tension resolves correctly end to end through scoreEntityMatch', () => {
  const stair = { ...BASE, id: 'd:stair', type: 'design-detail', title: 'Stair tread repair' };
  const spec = {
    ...BASE,
    id: 'spec:07-84-00',
    type: 'spec-section',
    title: 'Section 07 84 00 — Firestopping',
    aliases: ['fire-stopping'],
  };

  assert.equal(scoreEntityMatch(stair, buildQueryGroups('air barrier')), 0, 'no syllable match');
  assert.ok(scoreEntityMatch(stair, buildQueryGroups('stair repair')) > 0, 'real tokens still hit');
  assert.ok(
    scoreEntityMatch(spec, buildQueryGroups('fire stopping')) > 0,
    'compound recall preserved — this is what the golden set depends on',
  );
});

test('empty and degenerate variants never match', () => {
  assert.equal(variantMatches('anything at all', ''), false, 'an empty variant is not always-true');
  assert.equal(variantMatches('', 'firestop'), false);
});
