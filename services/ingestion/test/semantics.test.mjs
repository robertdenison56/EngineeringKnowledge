import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractVectorContent } from '../dist/vector.js';
import { analyzeSheet, detectDimensions, normalizeSheetNumber } from '../dist/semantics.js';
import { buildCandidate } from '../dist/candidate.js';
import { buildReferenceEdges, sheetIndex } from '../dist/edges.js';

const samples = join(import.meta.dirname, '..', 'samples');
const read = (dir, name) => new Uint8Array(readFileSync(join(dir, name)));

const CALLOUT_SHEET = 'C-102 Drainage Plan (callouts).pdf';
const LAYERED_SHEET = 'S-101 Widget Wall Details (layered).pdf';

// --- Authored fixture: every Phase B detector, exact expectations ---------

async function calloutSemantics() {
  const v = await extractVectorContent(read(samples, CALLOUT_SHEET), { decodeStrokes: true });
  return { page: v.pages[0], semantics: analyzeSheet(v.pages[0]) };
}

test('callout bubble: circle + detail/sheet stack → cross-sheet reference with evidence', async () => {
  const { page, semantics } = await calloutSemantics();
  assert.equal(semantics.callouts.length, 1);
  const c = semantics.callouts[0];
  assert.equal(c.detail, '3');
  assert.equal(c.targetSheet, 'S-101');
  assert.equal(c.evidence.method, 'geometry');
  // Evidence points at real primitives: the circle stroke is a 4-Bézier loop.
  const circle = page.strokes[c.evidence.strokes[0]];
  assert.equal(circle.curves, 4);
  assert.equal(circle.closed, true);
});

test('match line: label + long dashed stroke, continuation sheet extracted', async () => {
  const { page, semantics } = await calloutSemantics();
  assert.equal(semantics.matchLines.length, 1);
  const m = semantics.matchLines[0];
  assert.equal(m.targetSheet, 'C-103');
  assert.equal(m.evidence.method, 'geometry');
  assert.equal(page.strokes[m.evidence.strokes[0]].dashed, true);
});

test('dimension rides its line (geometry method); scale text is not a dimension', async () => {
  const { semantics } = await calloutSemantics();
  assert.deepEqual(
    semantics.dimensions.map((d) => d.text),
    [`12'-6"`],
  );
  assert.equal(semantics.dimensions[0].evidence.method, 'geometry');
  assert.deepEqual(semantics.scales, [`1/2" = 1'-0"`]);
});

test('view label names its geometry cluster and picks up the scale below it', async () => {
  const { semantics } = await calloutSemantics();
  assert.equal(semantics.views.length, 1);
  const view = semantics.views[0];
  assert.equal(view.kind, 'section');
  assert.equal(view.name, 'A-A');
  assert.equal(view.scale, `1/2" = 1'-0"`);
  // The cluster above the label is the drawn wall section at known coords.
  assert.deepEqual(view.region, [80, 440, 220, 470]);
  assert.equal(view.evidence.method, 'geometry');
});

test('schedule grid: line families → cell matrix; cells are not loose dimensions', async () => {
  const { semantics } = await calloutSemantics();
  assert.equal(semantics.schedules.length, 1);
  const table = semantics.schedules[0];
  assert.equal(table.title, 'PIPE SCHEDULE');
  assert.equal(table.rows, 3);
  assert.equal(table.columns, 2);
  assert.deepEqual(table.cells, [
    ['MARK', 'SIZE'],
    ['P-1', '18" RCP'],
    ['P-2', '24" RCP'],
  ]);
  // '18" RCP' lives in the table — it must not double-report as a dimension.
  assert.ok(!semantics.dimensions.some((d) => d.text.includes('18')));
});

test('layered fixture: dimension attributed via CAD layer (Tier 2 beats geometry)', async () => {
  const v = await extractVectorContent(read(samples, LAYERED_SHEET), { decodeStrokes: true });
  const dims = detectDimensions(v.pages[0]);
  const dim = dims.find((d) => d.text.startsWith(`3'-6`));
  assert.ok(dim, `expected the 3'-6" dimension, got ${JSON.stringify(dims)}`);
  assert.equal(dim.evidence.method, 'layer');
  assert.ok(dim.evidence.confidence >= 0.9);
});

// --- Candidate integration: semantics reach entity properties -------------

test('buildCandidate: drawing gets semantics summary, sheetRefs, and references', async () => {
  const candidate = await buildCandidate(join(samples, CALLOUT_SHEET), {
    tenantId: 'demo',
    pipeline: 'test',
  });
  const props = candidate.entity.properties;
  assert.equal(props.sheet.number, 'C-102');
  assert.deepEqual(props.sheetRefs.sort(), ['C-103', 'S-101']);
  assert.equal(props.semantics.callouts, 1);
  assert.equal(props.semantics.matchLines, 1);
  assert.equal(props.semantics.schedules, 1);
  assert.deepEqual(props.semantics.viewLabels, ['SECTION A-A']);
  assert.deepEqual(props.semantics.scheduleTitles, ['PIPE SCHEDULE']);

  assert.equal(candidate.references.length, 2);
  const callout = candidate.references.find((r) => r.targetSheet === 'S-101');
  assert.equal(callout.detail, '3');
  assert.equal(callout.method, 'geometry');
});

test('buildCandidate: spec PDFs skip the geometry pass (auto mode) — no semantics', async () => {
  const candidate = await buildCandidate(
    join(samples, '07 92 00 - Joint Sealants Spec (excerpt).pdf'),
    { tenantId: 'demo', pipeline: 'test' },
  );
  assert.equal(candidate.entity.properties.semantics, undefined);
  assert.equal(candidate.references, undefined);
});

// --- Cross-sheet reference edges -------------------------------------------

test('buildReferenceEdges: callout resolves to the sibling sheet, unknowns reported', async () => {
  const c102 = await buildCandidate(join(samples, CALLOUT_SHEET), {
    tenantId: 'demo',
    pipeline: 'test',
  });
  const s101 = await buildCandidate(join(samples, LAYERED_SHEET), {
    tenantId: 'demo',
    pipeline: 'test',
  });
  const index = sheetIndex([c102.entity, s101.entity]);
  const { edges, unresolved, ambiguous } = buildReferenceEdges([c102, s101], index, 'demo');

  assert.equal(edges.length, 1);
  const edge = edges[0];
  assert.equal(edge.type, 'references');
  assert.equal(edge.fromId, c102.entity.id);
  assert.equal(edge.toId, s101.entity.id);
  assert.equal(edge.properties.detail, '3');
  // C-103 is not in the batch — reported, never guessed.
  assert.deepEqual(unresolved, ['C-103']);
  assert.deepEqual(ambiguous, []);
});

test('buildReferenceEdges: ambiguous sheet numbers are skipped, not guessed', async () => {
  const c102 = await buildCandidate(join(samples, CALLOUT_SHEET), {
    tenantId: 'demo',
    pipeline: 'test',
  });
  const fake = (id) => ({
    id,
    tenantId: 'demo',
    type: 'document',
    title: id,
    properties: {},
    provenance: {
      createdAt: '2026-01-01T00:00:00Z',
      modifiedAt: '2026-01-01T00:00:00Z',
      reviewStatus: 'unverified',
      anchor: { sheet: 'S-101' },
    },
    acl: { allowedPrincipals: ['*'] },
  });
  const index = sheetIndex([c102.entity, fake('doc:a'), fake('doc:b')]);
  const { edges, ambiguous } = buildReferenceEdges([c102], index, 'demo');
  assert.equal(edges.length, 0);
  assert.deepEqual(ambiguous, ['S-101']);
});

test('normalizeSheetNumber: print variants converge', () => {
  assert.equal(normalizeSheetNumber('s-501 '), 'S501');
  assert.equal(normalizeSheetNumber('S501'), 'S501');
});

// --- Caltrans formats (corpus eval 2026-06-11) -----------------------------

import { harvestTitleBlock } from '../dist/vector.js';

const span = (str, x, y) => ({ str, x, y, width: str.length * 4, height: 8 });

test('Caltrans title block: short sheet id, scattered SHEET No. / TOTAL SHEETS, dash date', () => {
  // Page-space layout mimicking a Caltrans band (page height 2448, band ≤ 391):
  // the stamp ring scrambles text order, so harvest works from positions.
  const tb = harvestTitleBlock(
    [
      span('LAYOUT', 1300, 200),
      span('SHEET', 1400, 300),
      span('No.', 1430, 300),
      span('2', 1455, 300),
      span('TOTAL', 1400, 250),
      span('SHEETS', 1440, 250),
      span('27', 1488, 250),
      span('L-1', 1350, 280),
      span('ROUTE', 100, 300),
      span('505', 140, 300),
      span('LAST', 100, 200),
      span('REVISION', 130, 200),
      span('6-18-22', 200, 200),
    ],
    2448,
  );
  assert.equal(tb?.sheetNumber, 'L-1');
  assert.equal(tb?.sheetIndex, 2);
  assert.equal(tb?.sheetTotal, 27);
  assert.equal(tb?.revision, '6-18-22');
});

test('a stray sheet-shaped string without drawing labels is not a title block', () => {
  // "SW-846" (an EPA method number) in a spec-book footer minted a drawing
  // sheet before the gate required corroborating band evidence.
  const tb = harvestTitleBlock([span('SW-846', 300, 100), span('Page 12', 100, 100)], 792);
  assert.equal(tb, undefined);
});

test('title harvest never emits stamp fragments or engineer names (feeds vision)', () => {
  // A wrong title is misinformation to the fusion prompt — these Caltrans
  // band fragments must yield NO title, not a garbage one.
  const band = (extra) =>
    harvestTitleBlock(
      [
        span('L-1', 1350, 280),
        span('SHEET', 1400, 300),
        span('No.', 1430, 300),
        span('2', 1455, 300),
        span('SCALE', 100, 300),
        ...extra,
      ],
      2448,
    );
  assert.equal(band([span('ME PLOTTED =>', 1300, 200)])?.title, undefined, 'plot stamp rejected');
  assert.equal(band([span('JIN SHEN LOW', 1300, 200)])?.title, undefined, 'engineer name rejected');
  assert.equal(band([span('MELAKU A. ZELEKE', 1300, 200)])?.title, undefined, 'name w/ initial rejected');
  // A genuine sheet title (carries a drawing-domain word) is still harvested.
  assert.equal(band([span('GENERAL PLAN', 1300, 200)])?.title, 'GENERAL PLAN', 'real title kept');
});

test('curve-data angles and station artifacts are not dimensions', () => {
  const page = {
    pageNumber: 1,
    width: 612,
    height: 792,
    strokes: [],
    orderedText: '',
    texts: [
      { str: `28°26'20"`, x: 100, y: 400, width: 40, height: 8 }, // DMS angle
      { str: `12'-15`, x: 100, y: 380, width: 30, height: 8 }, // inches > 11
      { str: `38'-5`, x: 100, y: 360, width: 30, height: 8 }, // real dimension
    ],
  };
  const dims = detectDimensions(page);
  assert.deepEqual(
    dims.map((d) => d.text),
    [`38'-5`],
  );
});

// --- Real-corpus goldens (vector-parsing plan, Phase B exit tests) --------

const corpus = join(import.meta.dirname, 'corpus');
const ENDWALL = 'FDOT-430-030 Straight Concrete Endwalls.pdf';

test(
  'golden: endwall sheet 2 — PLAN and DETAIL "A" views, dimensions from geometry',
  { skip: !existsSync(join(corpus, ENDWALL)) },
  async () => {
    const v = await extractVectorContent(read(corpus, ENDWALL), { decodeStrokes: true });
    const s = analyzeSheet(v.pages[1]);
    const labels = s.views.map((x) => x.label);
    assert.ok(labels.includes('PLAN'), `views: ${labels}`);
    assert.ok(labels.includes('DETAIL "A"'), `views: ${labels}`);
    assert.ok(s.dimensions.length >= 20, `expected real dimension density, got ${s.dimensions.length}`);
    // Most values sit on their dimension lines; the rest stay pattern-method
    // (honest downgrade, not a failure).
    const geometry = s.dimensions.filter((d) => d.evidence.method === 'geometry').length;
    assert.ok(geometry >= s.dimensions.length / 2, `${geometry}/${s.dimensions.length} geometry`);
    // The plot stamp's "1:55:08 PM" must not read as a ratio scale.
    assert.deepEqual(s.scales, []);
  },
);

test(
  'golden: endwall sheet 3 — the dimension tables surface as schedule grids',
  { skip: !existsSync(join(corpus, ENDWALL)) },
  async () => {
    const v = await extractVectorContent(read(corpus, ENDWALL), { decodeStrokes: true });
    const s = analyzeSheet(v.pages[2]);
    assert.ok(s.schedules.length >= 1, 'expected at least one schedule grid');
    assert.ok(
      s.schedules.some((t) => t.rows >= 10 && t.columns >= 10),
      `expected a dense table, got ${s.schedules.map((t) => `${t.rows}×${t.columns}`)}`,
    );
  },
);
