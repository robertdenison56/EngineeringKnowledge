import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractVectorContent } from '../dist/vector.js';

const samples = join(import.meta.dirname, '..', 'samples');
const read = (dir, name) => new Uint8Array(readFileSync(join(dir, name)));

// --- Authored layered fixture: every tier, exact expectations ------------

test('layered fixture: OCG layer table and per-primitive attribution', async () => {
  const v = await extractVectorContent(read(samples, 'S-101 Widget Wall Details (layered).pdf'), {
    decodeStrokes: true,
  });
  assert.deepEqual(v.layers, ['S-ANNO-DIMS', 'border_SHEET']);
  assert.equal(v.capability.layerTable, 2);
  assert.equal(v.capability.layerAttribution, true);

  const page = v.pages[0];
  // Known geometry: dimension line (72,380)->(200,380) on S-ANNO-DIMS.
  const dimLine = page.strokes.find((s) => s.layer === 'S-ANNO-DIMS');
  assert.deepEqual(dimLine?.bbox, [72, 380, 200, 380]);
  assert.equal(dimLine?.closed, false);
  // Border rectangle on border_SHEET, closed.
  const border = page.strokes.find((s) => s.layer === 'border_SHEET');
  assert.deepEqual(border?.bbox, [36, 36, 576, 96]);
  assert.equal(border?.closed, true);
  // Text→layer correlation: the dimension text rides the dimension layer.
  const dimText = page.texts.find((t) => t.str.includes('3’-6'));
  assert.equal(dimText?.layer, 'S-ANNO-DIMS');
});

test('layered fixture: reading order fixes draw-order scramble', async () => {
  const v = await extractVectorContent(read(samples, 'S-101 Widget Wall Details (layered).pdf'));
  const text = v.pages[0].orderedText;
  const heading = text.indexOf('GENERAL NOTES:');
  const first = text.indexOf('1. First general note');
  const second = text.indexOf('2. Second general note');
  assert.ok(heading >= 0 && first > heading && second > first, `order wrong:\n${text}`);
});

test('layered fixture: title block harvested from geometry', async () => {
  const v = await extractVectorContent(read(samples, 'S-101 Widget Wall Details (layered).pdf'));
  const tb = v.pages[0].titleBlock;
  assert.equal(tb?.sheetNumber, '650-010');
  assert.equal(tb?.sheetIndex, 2);
  assert.equal(tb?.sheetTotal, 7);
  assert.equal(tb?.title, 'WIDGET WALL DETAILS');
  assert.equal(tb?.revision, '11/01/21');
});

test('spec fixture: no false title block, scan fixture: no text layer', async () => {
  const spec = await extractVectorContent(read(samples, '07 92 00 - Joint Sealants Spec (excerpt).pdf'));
  assert.equal(spec.pages[0].titleBlock, undefined);
  assert.equal(spec.capability.layerTable, 0);

  const scan = await extractVectorContent(read(samples, 'A-501 Curtain Wall Details (scanned).pdf'));
  assert.equal(scan.capability.hasTextLayer, false);
  assert.equal(scan.pages[0].orderedText, '');
});

// --- Real-corpus goldens (vector-parsing plan, Phase A exit tests) -------
// The FDOT standard-plan sheet is committed in test/corpus; the District 3
// project corpus is mounted via EKG_CORPUS_DIR and skipped when absent.

const corpus = join(import.meta.dirname, 'corpus');
const ENDWALL = 'FDOT-430-030 Straight Concrete Endwalls.pdf';

test(
  'golden: endwall title block from geometry alone (430-030, 2 of 4, 11/01/19)',
  { skip: !existsSync(join(corpus, ENDWALL)) },
  async () => {
    const v = await extractVectorContent(read(corpus, ENDWALL));
    assert.equal(v.pageCount, 4);
    assert.equal(v.capability.layerTable, 0); // FDOT pipeline strips layers
    const tb = v.pages[1].titleBlock;
    assert.equal(tb?.sheetNumber, '430-030');
    assert.equal(tb?.sheetIndex, 2);
    assert.equal(tb?.sheetTotal, 4);
    assert.equal(tb?.revision, '11/01/19');
  },
);

test(
  'golden: endwall general notes read 1…8, not draw order 8…1',
  { skip: !existsSync(join(corpus, ENDWALL)) },
  async () => {
    const v = await extractVectorContent(read(corpus, ENDWALL));
    const notes = v.pages[0].orderedText;
    const i1 = notes.indexOf('1. Use Class II concrete');
    const i8 = notes.indexOf('8. Quantities shown');
    assert.ok(i1 >= 0 && i8 > i1, 'notes not in reading order');
  },
);

const districtDir = process.env.EKG_CORPUS_DIR;
const district = districtDir && join(districtDir, '03-3H5404plans.pdf');

test(
  'golden: District 3 03-3H5404 — layer table present, attribution honestly absent',
  { skip: !district || !existsSync(district) },
  async () => {
    const v = await extractVectorContent(new Uint8Array(readFileSync(district)), { maxPages: 2 });
    assert.ok(v.capability.layerTable > 50, `expected MicroStation level table, got ${v.capability.layerTable}`);
    assert.ok(v.layers.includes('border_PROJ-ID-BLOCK-anno'), 'FDOT CADD level names resolvable');
    assert.equal(v.capability.layerAttribution, false); // table survived, membership did not
    assert.ok(v.capability.hasTextLayer);
  },
);
