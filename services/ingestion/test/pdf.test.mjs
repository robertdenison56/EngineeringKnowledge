import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractPdfText } from '../dist/pdf.js';

const samples = join(import.meta.dirname, '..', 'samples');
const read = (name) => new Uint8Array(readFileSync(join(samples, name)));

test('born-digital PDF yields its text layer', async () => {
  const pdf = await extractPdfText(read('07 92 00 - Joint Sealants Spec (excerpt).pdf'));
  assert.equal(pdf.hasTextLayer, true);
  assert.equal(pdf.pageCount, 1);
  assert.ok(pdf.text.includes('SECTION 07 92 00 - JOINT SEALANTS'));
  assert.ok(pdf.text.includes('ASTM C920'));
  assert.ok(pdf.text.includes('curtain wall perimeter'));
});

test('image-only (scanned) PDF is flagged, never fake text', async () => {
  const pdf = await extractPdfText(read('A-501 Curtain Wall Details (scanned).pdf'));
  assert.equal(pdf.hasTextLayer, false);
  assert.equal(pdf.pageCount, 1);
  assert.equal(pdf.text, '');
});

test('corrupt input rejects instead of returning garbage', async () => {
  await assert.rejects(() => extractPdfText(new Uint8Array([1, 2, 3, 4])));
});
