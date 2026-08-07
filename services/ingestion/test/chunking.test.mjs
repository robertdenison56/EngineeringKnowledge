import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkDocument, chunksToText } from '../dist/chunking.js';
import { buildCandidate } from '../dist/candidate.js';

// --- Unit: the chunker over structured input -------------------------------

test('PDF pages → one chunk each, anchored to page + sheet', () => {
  const chunks = chunkDocument({
    entityId: 'e:1',
    tenantId: 't',
    pages: [
      { pageNumber: 1, text: 'General notes for the bridge', sheet: 'L-1', title: 'LAYOUT' },
      { pageNumber: 2, text: 'Utility plan callouts', sheet: 'U-1' },
      { pageNumber: 3, text: '   ' }, // blank → skipped
    ],
  });
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].anchor, { page: 1, sheet: 'L-1' });
  assert.equal(chunks[0].heading, 'Sheet L-1 — LAYOUT');
  assert.equal(chunks[0].ordinal, 0);
  assert.deepEqual(chunks[1].anchor, { page: 2, sheet: 'U-1' });
  assert.equal(chunks[1].ordinal, 1);
});

test('spec page anchors carry the MasterFormat section detected on the page', () => {
  const chunks = chunkDocument({
    entityId: 'e:2',
    tenantId: 't',
    pages: [{ pageNumber: 12, text: '07 92 00 JOINT SEALANTS. Backer rod shall be closed-cell.' }],
  });
  assert.equal(chunks[0].anchor.specSection, '07 92 00');
  assert.equal(chunks[0].anchor.page, 12);
});

test('a dated page header does not anchor the chunk to a fake section', () => {
  // Reproduces the real failure: every page of the Caltrans standard
  // specifications opens with this line, so the citation for page 212 read
  // "04 15 22 (p. 212)" — a section that does not exist.
  const chunks = chunkDocument({
    entityId: 'e:caltrans',
    tenantId: 't',
    pages: [
      {
        pageNumber: 212,
        text:
          'REVISED STANDARD SPECIFICATIONS DATED 04-15-22\n' +
          'Concrete shall contain silica fume admixture per the special provisions.',
      },
    ],
  });
  assert.equal(chunks[0].anchor.specSection, undefined, 'no fabricated section');
  assert.equal(chunks[0].anchor.page, 212);
  assert.equal(chunks[0].heading, 'Page 212');
});

test('a dated header does not hide a real section further down the page', () => {
  const chunks = chunkDocument({
    entityId: 'e:spec',
    tenantId: 't',
    pages: [
      {
        pageNumber: 8,
        text: 'REVISED 06-30-24\nSECTION 07 84 00 - FIRESTOPPING\nPART 1 - GENERAL',
      },
    ],
  });
  assert.equal(chunks[0].anchor.specSection, '07 84 00');
  assert.equal(chunks[0].heading, '07 84 00 (p. 8)');
});

test('the document-level section still backfills a page with none of its own', () => {
  const chunks = chunkDocument({
    entityId: 'e:spec2',
    tenantId: 't',
    specSection: '07 92 00',
    pages: [{ pageNumber: 3, text: 'Tool joints to a concave profile. Dated 01-02-25.' }],
  });
  assert.equal(chunks[0].anchor.specSection, '07 92 00', 'falls back, not fabricates');
});

test('a very long page sub-splits but keeps its anchor', () => {
  const long = 'word '.repeat(2000); // ~10k chars > MAX_CHUNK_CHARS
  const chunks = chunkDocument({
    entityId: 'e:3',
    tenantId: 't',
    pages: [{ pageNumber: 5, text: long, sheet: 'X-1' }],
  });
  assert.ok(chunks.length > 1, 'long page split into multiple chunks');
  assert.ok(chunks.every((c) => c.anchor.page === 5 && c.anchor.sheet === 'X-1'));
  assert.match(chunks[0].heading, /1\/\d/);
});

test('short plain text stays whole (no chunks); long text windows', () => {
  assert.deepEqual(chunkDocument({ entityId: 'e:4', tenantId: 't', text: 'tiny note' }), []);
  const long = chunkDocument({ entityId: 'e:5', tenantId: 't', text: 'para. '.repeat(800) });
  assert.ok(long.length > 1);
  assert.ok(long.every((c) => c.id.startsWith('e:5#')));
});

test('chunksToText reassembles passages in order', () => {
  const text = chunksToText([
    { id: 'x#1', entityId: 'x', tenantId: 't', ordinal: 1, anchor: {}, text: 'second' },
    { id: 'x#0', entityId: 'x', tenantId: 't', ordinal: 0, anchor: {}, text: 'first' },
  ]);
  assert.equal(text, 'first\n\nsecond');
});

// --- Integration: buildCandidate preserves full text in chunks -------------

const corpus = join(import.meta.dirname, 'corpus');
const ENDWALL = 'FDOT-430-030 Straight Concrete Endwalls.pdf';

test(
  'buildCandidate: multi-page PDF gets per-page chunks; preview bounded, full text in chunks',
  { skip: !existsSync(join(corpus, ENDWALL)) },
  async () => {
    const c = await buildCandidate(join(corpus, ENDWALL), { tenantId: 't', pipeline: 'test' });
    assert.ok(c.chunks && c.chunks.length >= 4, `expected >= 4 chunks, got ${c.chunks?.length}`);
    // Every chunk anchored to a page, and the sheet number rides along.
    assert.ok(c.chunks.every((k) => typeof k.anchor.page === 'number'));
    assert.ok(c.chunks.some((k) => k.anchor.sheet === '430-030'));
    // Preview is bounded; chunk text covers at least as much as the preview.
    assert.ok((c.entity.content?.length ?? 0) <= 20000);
    assert.ok(chunksToText(c.chunks).length >= (c.entity.content?.length ?? 0));
  },
);

const districtDir = process.env.EKG_CORPUS_DIR;
const specBook = districtDir && join(districtDir, '03-4H5814sp.pdf');

test(
  'buildCandidate: 494-page spec book chunks every page, far past the 20k preview',
  { skip: !specBook || !existsSync(specBook) },
  async () => {
    const c = await buildCandidate(specBook, { tenantId: 't', pipeline: 'test' });
    assert.ok(c.pageCount > 400, `expected a long spec book, got ${c.pageCount} pages`);
    // Chunks reach deep into the document — the old 20k/40-page cap is gone.
    const deepestPage = Math.max(...c.chunks.map((k) => k.anchor.page ?? 0));
    assert.ok(deepestPage > 300, `chunks should reach deep pages, deepest was ${deepestPage}`);
    assert.ok(chunksToText(c.chunks).length > 100000, 'full document text retained in chunks');
  },
);
