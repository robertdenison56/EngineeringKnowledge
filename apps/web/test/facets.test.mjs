import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure facet predicates with only type-only @ekg/core imports, so they load
// under Node's native type stripping with no runtime workspace dep.
import {
  anyFacetActive,
  canonSection,
  disciplineOf,
  disciplineOptions,
  hitMatchesSection,
  inDateRange,
  matchesDiscipline,
} from '../src/lib/facets.ts';

/** Minimal entity for facet tests — only the fields the predicates read. */
function entity({ properties = {}, anchor, modifiedAt = '2026-01-15T12:00:00Z' } = {}) {
  return {
    id: 'e1',
    tenantId: 'demo-firm',
    type: 'design-detail',
    title: 'Test entity',
    properties,
    provenance: {
      createdAt: '2026-01-01T00:00:00Z',
      modifiedAt,
      reviewStatus: 'verified',
      ...(anchor ? { anchor } : {}),
    },
    acl: { allowedPrincipals: ['*'] },
  };
}

const hit = (e, chunk) => ({ entity: e, score: 1, ...(chunk ? { chunk } : {}) });

test('canonSection collapses every separator spelling to one form', () => {
  for (const spelling of ['07 84 00', '07-84-00', '07.84.00', '078400', '07 84-00']) {
    assert.equal(canonSection(spelling), '078400');
  }
  assert.equal(canonSection('07'), '07');
  assert.equal(canonSection('  '), '');
});

test('section facet prefix-matches the entity anchor: division, pair, full code', () => {
  const h = hit(entity({ anchor: { specSection: '07 84 00' } }));
  for (const input of ['07', '07 84', '07-84-00', '078400']) {
    assert.equal(hitMatchesSection(h, input), true, `input ${input}`);
  }
  assert.equal(hitMatchesSection(h, '09'), false);
  // Blank input never filters.
  assert.equal(hitMatchesSection(hit(entity()), ''), true);
});

test('section facet falls back to the masterformat property', () => {
  const h = hit(entity({ properties: { masterformat: '09 91 23.13' } }));
  assert.equal(hitMatchesSection(h, '09 91'), true);
  assert.equal(hitMatchesSection(h, '07'), false);
  // Non-string masterformat is ignored, not crashed on.
  assert.equal(hitMatchesSection(hit(entity({ properties: { masterformat: 79 } })), '07'), false);
});

test('section facet qualifies through the matched passage anchor (ADR 0006)', () => {
  const h = hit(entity(), { anchor: { specSection: '07 92 00' }, snippet: 's', ordinal: 0 });
  assert.equal(hitMatchesSection(h, '07 92'), true);
  assert.equal(hitMatchesSection(h, '08'), false);
});

test('entities with no section anywhere fail any non-blank section filter', () => {
  assert.equal(hitMatchesSection(hit(entity()), '07'), false);
});

test('discipline facet matches case-insensitively and trims', () => {
  const e = entity({ properties: { discipline: 'Facade Engineering' } });
  assert.equal(disciplineOf(e), 'Facade Engineering');
  assert.equal(matchesDiscipline(e, 'facade engineering'), true);
  assert.equal(matchesDiscipline(e, '  FACADE ENGINEERING '), true);
  assert.equal(matchesDiscipline(e, 'architecture'), false);
  // Absent or non-string discipline never matches.
  assert.equal(matchesDiscipline(entity(), 'architecture'), false);
  assert.equal(matchesDiscipline(entity({ properties: { discipline: 3 } }), '3'), false);
  assert.equal(disciplineOf(entity({ properties: { discipline: '  ' } })), undefined);
});

test('disciplineOptions dedupes case-insensitively, sorts, and keeps the active selection', () => {
  const hits = [
    hit(entity({ properties: { discipline: 'structural' } })),
    hit(entity({ properties: { discipline: 'Structural' } })),
    hit(entity({ properties: { discipline: 'architecture' } })),
    hit(entity()),
  ];
  assert.deepEqual(disciplineOptions(hits), ['architecture', 'structural']);
  // A selection filtered out of the results still appears in its own dropdown.
  assert.deepEqual(disciplineOptions(hits, 'facade engineering'), [
    'architecture',
    'facade engineering',
    'structural',
  ]);
  assert.deepEqual(disciplineOptions(hits, 'STRUCTURAL'), ['architecture', 'structural']);
});

test('date-range facet is inclusive on both bounds and one-sided ranges work', () => {
  const e = entity({ modifiedAt: '2026-01-15T12:00:00Z' });
  assert.equal(inDateRange(e, '2026-01-15', '2026-01-15'), true);
  assert.equal(inDateRange(e, '2026-01-16', undefined), false);
  assert.equal(inDateRange(e, undefined, '2026-01-14'), false);
  assert.equal(inDateRange(e, '2026-01-01', undefined), true);
  assert.equal(inDateRange(e, undefined, '2026-12-31'), true);
  assert.equal(inDateRange(e, undefined, undefined), true);
});

test('anyFacetActive is true for each facet alone and false when all are blank', () => {
  assert.equal(anyFacetActive({}), false);
  assert.equal(anyFacetActive({ status: '' , project: '', section: '' }), false);
  for (const f of [
    { status: 'verified' },
    { project: 'project:riverside' },
    { discipline: 'architecture' },
    { section: '07' },
    { from: '2026-01-01' },
    { to: '2026-02-01' },
  ]) {
    assert.equal(anyFacetActive(f), true, JSON.stringify(f));
  }
});
