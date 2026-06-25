import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  buildCandidate,
  chunksToText,
  extractVectorContent,
  extractSheetFacts,
  groundAnnotations,
  loadPageModel,
  ocrPdfPages,
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = (name) => join(here, '..', 'samples', name);
const SCAN = sample('A-501 Curtain Wall Details (scanned).pdf');

// A deterministic OCR stand-in so the wiring is testable without a real engine
// (which needs tesseract.js or the tesseract binary). Returns plausible scan text.
const STUB_TEXT = 'A-501 CURTAIN WALL DETAILS SEALANT JOINT BACKER ROD ASTM C920';
const stubOcr = async (_filePath, page) => ({ text: `${STUB_TEXT} (page ${page})`, engine: 'injected' });
// Confidence-reporting stub: every page reads poorly (below the 70 threshold).
const lowConfidenceOcr = async (_filePath, page) => ({
  text: `${STUB_TEXT} (page ${page})`,
  confidence: 41,
  engine: 'injected',
});

test('review #1 — without OCR a scan stays needs-ocr, never fabricated text', async () => {
  const c = await buildCandidate(SCAN, { tenantId: 't', pipeline: 'test' });
  assert.equal(c.parseStatus, 'needs-ocr');
  assert.equal(c.imageOnly, true);
  assert.ok(!c.chunks || c.chunks.length === 0, 'no chunks invented for a scan');
});

test('review #1 — injected OCR recovers a searchable, page-anchored text layer', async () => {
  const c = await buildCandidate(SCAN, { tenantId: 't', pipeline: 'test', ocr: stubOcr });
  assert.equal(c.parseStatus, 'ocr-extracted');
  assert.equal(c.imageOnly, true, 'still flagged image-only so the gateway renders it');
  assert.ok(c.chunks && c.chunks.length > 0, 'OCR text is chunked for retrieval');
  assert.ok(c.chunks[0].anchor.page >= 1, 'chunks keep a page anchor for citation');
  assert.match(c.entity.content ?? '', /CURTAIN WALL DETAILS/);
  assert.match(c.entity.summary, /OCR-recovered/);
  assert.equal(c.entity.properties.ocr.engine, 'injected');
  // Confidence the engine can't report ⇒ quality unmeasured ⇒ flag for review.
  assert.equal(c.entity.properties.ocr.needsReview, true, 'unknown confidence ⇒ needsReview');
});

test('review #1 — per-page confidence is scored and low pages flagged for review (P0-2a)', async () => {
  // Pages 1 and 3 read clean; page 2 is a poor scan below the 70 threshold.
  const graded = async (_f, p) => ({ text: `line ${p}`, confidence: p === 2 ? 55 : 88, engine: 'injected' });
  const res = await ocrPdfPages('/whatever.pdf', 3, graded, 10);
  assert.deepEqual(res.pages.map((p) => p.confidence), [88, 55, 88], 'per-page confidence propagated');
  assert.deepEqual(res.lowConfidencePages, [2], 'page 2 (<70) flagged, clean pages are not');
  assert.equal(res.meanConfidence, 77, 'mean across the three pages');
});

test('review #1 — a low-confidence scan is recovered but flagged needsReview, never auto-verified', async () => {
  const c = await buildCandidate(SCAN, { tenantId: 't', pipeline: 'test', ocr: lowConfidenceOcr });
  assert.equal(c.parseStatus, 'ocr-extracted', 'text still recovered and searchable');
  assert.equal(c.entity.provenance.reviewStatus, 'unverified', 'never auto-promoted to verified');
  assert.equal(c.entity.properties.ocr.needsReview, true);
  assert.ok(
    c.entity.properties.ocr.lowConfidencePages.length >= 1,
    'the poor page(s) are recorded for the curator',
  );
  assert.equal(c.entity.properties.ocr.meanConfidence, 41);
});

test('review #1 — OCR text grounds a vision annotation that the scan could not before', async () => {
  const c = await buildCandidate(SCAN, { tenantId: 't', pipeline: 'test', ocr: stubOcr });
  const source = chunksToText(c.chunks);
  // Same grounding gate save_description uses: a real quote grounds, a
  // hallucinated count does not.
  const report = groundAnnotations(['CURTAIN WALL DETAILS', 'ASTM C920', '42 anchors total'], source);
  assert.equal(report.groundable, true, 'a scan is now groundable via its OCR layer');
  assert.deepEqual(report.grounded, ['CURTAIN WALL DETAILS', 'ASTM C920']);
  assert.deepEqual(report.ungrounded, ['42 anchors total']);
});

test('ocrPdfPages reports truncation past the page budget and drops empty pages', async () => {
  const everyOther = async (_f, p) => (p % 2 === 1 ? { text: `line ${p}`, engine: 'injected' } : null);
  const res = await ocrPdfPages('/whatever.pdf', 5, everyOther, 3);
  assert.deepEqual(res.pages.map((p) => p.pageNumber), [1, 3], 'empty pages dropped, budget honored');
  assert.equal(res.truncated, true, '5 pages, budget 3 → truncated');
  assert.equal(res.engine, 'injected');
});

// --- review #2: pdf.js detaches the input buffer; entry points must copy ---

test('review #2 — extractVectorContent does not detach the caller buffer (reusable)', async () => {
  const buf = new Uint8Array(readFileSync(SCAN));
  await extractVectorContent(buf, { decodeStrokes: 'auto' });
  assert.equal(buf.byteLength, buf.buffer.byteLength, 'buffer not transferred away');
  assert.ok(buf.byteLength > 0, 'still holds the bytes');
  // The real regression: a second parse of the SAME buffer must not throw.
  await assert.doesNotReject(() => extractVectorContent(buf, { decodeStrokes: 'auto' }));
});

test('review #2 — extractSheetFacts and loadPageModel reuse one buffer without DataCloneError', async () => {
  const drawing = join(here, 'corpus', 'FDOT-430-030 Straight Concrete Endwalls.pdf');
  const buf = new Uint8Array(readFileSync(drawing));
  await assert.doesNotReject(async () => {
    await extractSheetFacts(buf, 1);
    await loadPageModel(buf, 1); // the exact two-parse sequence the gateway runs
  });
  assert.ok(buf.byteLength > 0, 'caller buffer survives both parses');
});
