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

// --- Page geometry: non-zero view origin + /Rotate ------------------------
// Real large-format AEC sheets often carry a non-zero CropBox/MediaBox origin
// and a page /Rotate; both must be normalized or geometry-derived claims land
// on the wrong axis/band. All committed fixtures are 0-origin/unrotated, so
// these two build minimal PDFs inline to exercise the normalization.

/** Assemble a valid PDF from 1-indexed object bodies, computing the xref. */
function buildPdf(objects) {
  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const obj = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    chunks.push(obj);
    offset += obj.length;
  });
  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return new Uint8Array(Buffer.concat(chunks));
}
function streamObj(body) {
  const data = Buffer.from(body, 'latin1');
  return Buffer.concat([
    Buffer.from(`<< /Length ${data.length} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}
function onePagePdf({ mediaBox, rotate, content }) {
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox}]${rotate ? ` /Rotate ${rotate}` : ''} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    streamObj(content),
  ]);
}

test('non-zero CropBox origin: text positions normalized into the view box', async () => {
  // View origin (100,50); text drawn at PDF (110,70) sits at (10,20) in view space.
  const pdf = onePagePdf({ mediaBox: '100 50 712 842', content: 'BT /F1 10 Tf 110 70 Td (TBLOCK) Tj ET' });
  const page = (await extractVectorContent(pdf)).pages[0];
  assert.equal(page.width, 612);
  assert.equal(page.height, 792);
  const t = page.texts.find((t) => t.str.includes('TBLOCK'));
  assert.ok(t, 'text extracted');
  assert.ok(Math.abs(t.x - 10) < 1, `x normalized to the view origin, got ${t.x} (would be 110 unfixed)`);
  assert.ok(Math.abs(t.y - 20) < 1, `y normalized to the view origin, got ${t.y} (would be 70 unfixed)`);
});

test('page /Rotate 90: display dimensions swap and positions stay in the box', async () => {
  const pdf = onePagePdf({ mediaBox: '0 0 612 792', rotate: 90, content: 'BT /F1 10 Tf 10 20 Td (ROT) Tj ET' });
  const page = (await extractVectorContent(pdf)).pages[0];
  assert.equal(page.width, 792, 'rotated display width = original height');
  assert.equal(page.height, 612, 'rotated display height = original width');
  const t = page.texts.find((t) => t.str.includes('ROT'));
  assert.ok(t, 'text extracted');
  assert.ok(
    t.x >= 0 && t.x <= 792 && t.y >= 0 && t.y <= 612,
    `position normalized into the rotated display box, got (${t.x}, ${t.y})`,
  );
});
