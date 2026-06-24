import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSheetFacts, formatSheetFacts } from '../dist/describe.js';

const samples = join(import.meta.dirname, '..', 'samples');
const read = (dir, name) => new Uint8Array(readFileSync(join(dir, name)));

test('extractSheetFacts: full deterministic facts from the callout fixture', async () => {
  const f = await extractSheetFacts(read(samples, 'C-102 Drainage Plan (callouts).pdf'), 1);
  assert.ok(f);
  assert.equal(f.sheetNumber, 'C-102');
  assert.equal(f.title, 'DRAINAGE PLAN AND DETAILS');
  assert.equal(f.sheetIndex, 5);
  assert.equal(f.sheetTotal, 12);
  assert.deepEqual(f.views, ['SECTION A-A']);
  assert.deepEqual(f.scales, [`1/2" = 1'-0"`]);
  assert.deepEqual(f.dimensions, [`12'-6"`]);
  assert.deepEqual(f.callouts, ['3/S-101']);
  assert.deepEqual(f.matchLines, ['→ C-103']);
  assert.deepEqual(f.schedules, ['PIPE SCHEDULE']);
});

test('formatSheetFacts: ground-truth block names the sheet and forbids contradiction', async () => {
  const f = await extractSheetFacts(read(samples, 'C-102 Drainage Plan (callouts).pdf'), 1);
  const text = formatSheetFacts(f);
  assert.match(text, /DETERMINISTIC PARSE/);
  assert.match(text, /Sheet: C-102 "DRAINAGE PLAN AND DETAILS"/);
  assert.match(text, /Dimensions found: 12'-6"/);
  assert.match(text, /do not contradict the sheet number/i);
});

test('extractSheetFacts: layered fixture reports attributed CAD layers', async () => {
  const f = await extractSheetFacts(read(samples, 'S-101 Widget Wall Details (layered).pdf'), 1);
  assert.ok(f);
  // Per-primitive attribution survived in this fixture, so layers are trustworthy.
  assert.ok(f.layers.includes('S-ANNO-DIMS'), `expected attributed layers, got ${JSON.stringify(f.layers)}`);
});

test('extractSheetFacts: scanned sheet (no vector content) yields null — pixels only', async () => {
  const f = await extractSheetFacts(read(samples, 'A-501 Curtain Wall Details (scanned).pdf'), 1);
  assert.equal(f, null);
});

test('extractSheetFacts: a spec page has no drawing facts to fuse', async () => {
  const f = await extractSheetFacts(read(samples, '07 92 00 - Joint Sealants Spec (excerpt).pdf'), 1);
  // No title block, views, dimensions, callouts, or schedules → nothing to fuse.
  assert.equal(f, null);
});

// Real-corpus check: the FDOT endwall detail sheet (page 2) fuses real facts.
const corpus = join(import.meta.dirname, 'corpus');
const ENDWALL = 'FDOT-430-030 Straight Concrete Endwalls.pdf';

test(
  'golden: endwall sheet 2 fuses sheet number, views, and a dimension inventory',
  { skip: !existsSync(join(corpus, ENDWALL)) },
  async () => {
    const f = await extractSheetFacts(read(corpus, ENDWALL), 2);
    assert.ok(f);
    assert.equal(f.sheetNumber, '430-030');
    assert.ok(f.views.includes('PLAN'), `views: ${f.views}`);
    assert.ok(f.dimensions.length >= 5, `expected real dimensions, got ${f.dimensions.length}`);
  },
);
