import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import {
  extractVectorContent,
  parseProjectCsv,
  buildCandidate,
} from '../dist/index.js';

/**
 * Adversarial ingestion fuzz suite — the parsing moat is otherwise only tested
 * on clean, authored fixtures. Every case feeds a deliberately malformed input
 * and asserts GRACEFUL handling: a structured result (parseStatus
 * 'parse-failed', a reported parse error, swapped dimensions, …) or a CAUGHT
 * Error — never an uncaught throw, an infinite hang, or a silent bad parse.
 *
 * Each potentially-slow call is wrapped in withTimeout() so a hang fails loud
 * instead of stalling the runner.
 */

const HANG_MS = 20000;
function withTimeout(promise, label, ms = HANG_MS) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: ${label} did not settle in ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** Run an async op, returning {ok,value} or {ok:false,error} — never rethrowing. */
async function settle(promise, label) {
  try {
    return { ok: true, value: await withTimeout(promise, label) };
  } catch (error) {
    return { ok: false, error };
  }
}

let dir;
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ekg-fuzz-'));
});
test.after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function writeTmp(name, bytes) {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

// ---------------------------------------------------------------------------
// Inline PDF builder (mirrors services/ingestion/test/vector.test.mjs)

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

// ===========================================================================
// PDF: malformed binary inputs → caught Error, never a hang or silent success
// ===========================================================================

test('PDF: random garbage bytes with a .pdf extension are rejected, not parsed', async () => {
  const garbage = new Uint8Array(crypto.randomBytes(4096));
  const r = await settle(extractVectorContent(garbage), 'garbage-pdf');
  assert.equal(r.ok, false, 'random bytes must not parse as a valid PDF');
  assert.ok(r.error instanceof Error, 'rejection is a real Error');
  assert.doesNotMatch(r.error.message, /^HANG:/, 'must not hang');
});

test('PDF: a zero-byte file is rejected with a clear error', async () => {
  const r = await settle(extractVectorContent(new Uint8Array(0)), 'zero-byte-pdf');
  assert.equal(r.ok, false, 'empty input must not parse');
  assert.ok(r.error instanceof Error);
  assert.doesNotMatch(r.error.message, /^HANG:/);
});

test('PDF: a valid %PDF header with a truncated/corrupt body is rejected', async () => {
  // Real header, but the body ends mid-object: no xref, no pages, no trailer.
  const truncated = new Uint8Array(
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1'),
  );
  const r = await settle(extractVectorContent(truncated), 'truncated-pdf');
  assert.equal(r.ok, false, 'a header alone must not yield a usable document');
  assert.ok(r.error instanceof Error);
  assert.doesNotMatch(r.error.message, /^HANG:/);
});

test('PDF: a %PDF header followed by garbage is rejected', async () => {
  const headerGarbage = new Uint8Array(
    Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), crypto.randomBytes(2048)]),
  );
  const r = await settle(extractVectorContent(headerGarbage), 'header-garbage-pdf');
  assert.equal(r.ok, false);
  assert.ok(r.error instanceof Error);
  assert.doesNotMatch(r.error.message, /^HANG:/);
});

test('PDF: combined non-zero origin + /Rotate 90 parses and reports swapped dimensions', async () => {
  // View origin (100,50), 612x792 view, rotated 90°. Both transforms compound;
  // a regression here lands geometry on the wrong axis with no other test
  // covering the *combination*. Text drawn at PDF (110,70) must normalize into
  // the rotated display box.
  const pdf = onePagePdf({
    mediaBox: '100 50 712 842',
    rotate: 90,
    content: 'BT /F1 10 Tf 110 70 Td (TBLOCK) Tj ET',
  });
  const r = await settle(extractVectorContent(pdf), 'rotate-offset-pdf');
  assert.equal(r.ok, true, `must parse without crashing: ${r.error?.message}`);
  const page = r.value.pages[0];
  // Rotation swaps display dimensions: original view 612x792 -> 792x612.
  assert.equal(page.width, 792, 'rotated display width = original view height');
  assert.equal(page.height, 612, 'rotated display height = original view width');
  const t = page.texts.find((x) => x.str.includes('TBLOCK'));
  assert.ok(t, 'title-block text extracted');
  assert.ok(
    t.x >= 0 && t.x <= page.width && t.y >= 0 && t.y <= page.height,
    `position normalized into the rotated+offset box, got (${t.x}, ${t.y})`,
  );
});

test('PDF: an enormous declared page count does not hang or explode memory', async () => {
  // Declares /Count 1_000_000 but ships a single real kid. The walk must be
  // bounded (pdf.js reconciles the count against the page tree; maxPages and
  // the MAX_PAGES_CEILING bound the loop) — it must return promptly, never
  // attempt a million getPage() calls.
  const bomb = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1000000 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>',
    streamObj('BT ET'),
  ]);
  const started = Date.now();
  const r = await settle(extractVectorContent(bomb, { maxPages: 3 }), 'page-count-bomb');
  assert.equal(r.ok, true, `must settle gracefully: ${r.error?.message}`);
  // Analyzed pages are bounded by the real tree and maxPages, not the lie.
  assert.ok(r.value.pages.length <= 3, `analyzed pages bounded, got ${r.value.pages.length}`);
  assert.ok(Date.now() - started < HANG_MS, 'returned well within the hang budget');
});

// ===========================================================================
// CSV (parseProjectCsv): malformed text → reported, never a silent bad parse
// ===========================================================================

test('CSV: an unterminated quoted field is reported, not silently swallowed', () => {
  // FIXED (csv.ts parseDelimited): the reader now looks ahead when a quote opens
  // (quoteCloses) — an opening quote with no real close is recovered as a literal
  // so following rows still parse, and the malformation is surfaced as a parse
  // error instead of swallowing the file's tail into one field.
  const csv = [
    'name,client',
    'Good One,Acme',
    '"Unterminated Quote Field,BadCo',
    'Should Be Row 4,Beta',
    'Should Be Row 5,Gamma',
  ].join('\n');
  const { rows, errors } = parseProjectCsv(csv);
  // The good row before the unterminated quote survives.
  assert.ok(rows.some((r) => r.name === 'Good One'), 'clean row before the bad quote is kept');
  // The rows AFTER the unterminated quote must NOT be silently merged away.
  assert.ok(
    rows.some((r) => r.name === 'Should Be Row 4'),
    'rows after the unterminated quote are not swallowed',
  );
  // And the malformation must be surfaced, never guessed past.
  assert.ok(
    errors.some((e) => /quote|unterminated|unclosed/i.test(e.message)),
    'an unterminated-quote parse error is reported',
  );
});

test('CSV: an unterminated quote at least does not crash or hang (current behavior)', async () => {
  // Companion to the skipped defect test: even though the open quote is
  // mishandled, it must at minimum return a structured result without throwing
  // or hanging. This guards against a *worse* regression (a crash/hang) while
  // the silent-swallow defect stands.
  const csv = ['name,client', 'Good One,Acme', '"open,BadCo', 'tail,row'].join('\n');
  const r = await settle(Promise.resolve().then(() => parseProjectCsv(csv)), 'unterminated-csv');
  assert.equal(r.ok, true, 'parse returns a structured result, no throw/hang');
  assert.ok(Array.isArray(r.value.rows) && Array.isArray(r.value.errors));
});

test('CSV: no header row is reported as a missing name column, never invented', () => {
  // Data-only input: the first physical line is consumed as the header, so no
  // recognizable name column exists. Must be a reported error, zero data rows —
  // never a guessed header.
  const { rows, errors } = parseProjectCsv('Riverside Transit Center,2024-118,Metro Authority');
  assert.equal(rows.length, 0, 'no rows invented from a headerless file');
  assert.ok(errors.length >= 1, 'the problem is reported');
  assert.match(errors[0].message, /no project-name column/i);
});

test('CSV: embedded NUL bytes parse without crashing (no silent data loss of rows)', () => {
  // NUL inside fields must not truncate the C-string or crash the reader.
  const csv = 'name,client\nAlpha Beta,Ac me\nGamma,Delta';
  const { rows, errors } = parseProjectCsv(csv);
  assert.ok(Array.isArray(rows) && Array.isArray(errors), 'structured result');
  // Both data rows survive — the NUL is carried in the field, not a terminator.
  assert.equal(rows.length, 2, 'both rows parsed despite embedded NULs');
  assert.ok(rows[0].name.includes('Alpha') && rows[0].name.includes('Beta'));
  assert.equal(rows[1].name, 'Gamma');
});

test('CSV: rows with wildly mismatched column counts are tolerated, not crashed', () => {
  // Short rows (fewer cells than the header) and long rows (extra cells) must
  // both parse: missing cells read as empty, extra cells ignored — no
  // out-of-bounds access, no throw.
  const csv = [
    'name,client,status',
    'OnlyName',
    'A,B',
    'C,D,E',
    'F,G,H,I,J,K,L,M,N,O',
  ].join('\n');
  const { rows, errors } = parseProjectCsv(csv);
  assert.ok(Array.isArray(rows) && Array.isArray(errors), 'structured result, no crash');
  // The single-cell row has a name and is kept; the rest keep their names too.
  assert.deepEqual(
    rows.map((r) => r.name),
    ['OnlyName', 'A', 'C', 'F'],
  );
  // Extra columns beyond the header are simply ignored, not mis-assigned.
  assert.equal(rows[3].client, 'G');
  assert.equal(rows[3].status, 'H');
});

test('CSV: a very large input parses in bounded time without hanging', async () => {
  // 50k rows — exercises the single-pass reader against a realistic bulk export.
  const lines = ['name,number,client'];
  for (let i = 0; i < 50000; i++) lines.push(`Project ${i},P-${i},Client ${i % 100}`);
  const big = lines.join('\n');
  const started = Date.now();
  const r = await settle(Promise.resolve().then(() => parseProjectCsv(big)), 'large-csv');
  assert.equal(r.ok, true, 'large input parses without throwing/hanging');
  assert.equal(r.value.rows.length, 50000, 'every row parsed');
  assert.equal(r.value.errors.length, 0);
  assert.ok(Date.now() - started < HANG_MS, 'parsed within the hang budget');
});

// ===========================================================================
// buildCandidate end-to-end: unsupported / missing inputs → clean error
// ===========================================================================

test('buildCandidate: an unsupported extension throws a clean, descriptive error', async () => {
  const p = writeTmp('book.xlsx', Buffer.from('not really a spreadsheet'));
  const r = await settle(buildCandidate(p, { tenantId: 't', pipeline: 'fuzz' }), 'xlsx-candidate');
  assert.equal(r.ok, false, 'unsupported types are refused');
  assert.ok(r.error instanceof Error);
  assert.match(r.error.message, /unsupported extension/i);
  assert.match(r.error.message, /\.xlsx/);
});

test('buildCandidate: a missing PDF degrades to a parse-failed candidate, not a crash', async () => {
  // The PDF branch wraps read+extract in try/catch, so a missing file becomes a
  // structured parse-failed candidate (honest "could not parse"), not a throw.
  const missing = join(dir, 'no-such-file-zzz.pdf');
  const r = await settle(
    buildCandidate(missing, { tenantId: 't', pipeline: 'fuzz' }),
    'missing-pdf-candidate',
  );
  assert.equal(r.ok, true, 'missing PDF yields a candidate, not a crash');
  assert.equal(r.value.parseStatus, 'parse-failed');
  assert.match(r.value.entity.summary, /could not be parsed/i);
});

test('buildCandidate: a missing text file surfaces a clean caught ENOENT error', async () => {
  // The .txt branch reads synchronously without a catch, so a missing file
  // throws — but a thrown Error the caller catches is acceptable (a clean error,
  // not a hang or a silent fabricated candidate). We assert it is exactly that.
  const missing = join(dir, 'no-such-file-zzz.txt');
  const r = await settle(
    buildCandidate(missing, { tenantId: 't', pipeline: 'fuzz' }),
    'missing-txt-candidate',
  );
  assert.equal(r.ok, false, 'missing text file surfaces as a caught error');
  assert.ok(r.error instanceof Error);
  assert.match(r.error.message, /ENOENT|no such file/i);
});

test('buildCandidate: a .pdf file containing pure garbage degrades to parse-failed', async () => {
  // End-to-end: garbage bytes on disk with a .pdf extension must produce a
  // parse-failed candidate (the extract throw is caught in candidate.ts), never
  // propagate an uncaught error out of buildCandidate.
  const p = writeTmp('garbage.pdf', Buffer.from(crypto.randomBytes(3000)));
  const r = await settle(
    buildCandidate(p, { tenantId: 't', pipeline: 'fuzz' }),
    'garbage-pdf-candidate',
  );
  assert.equal(r.ok, true, 'garbage PDF yields a candidate, not a crash');
  assert.equal(r.value.parseStatus, 'parse-failed');
  assert.equal(r.value.entity.properties.parseStatus, 'parse-failed');
});
