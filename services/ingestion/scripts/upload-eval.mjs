#!/usr/bin/env node
/**
 * Upload-accuracy scorecard — runs the REAL ingestion pipeline
 * (`buildCandidate` + reference-edge resolution, exactly what the CLI and
 * the gateway's `ingest_document` execute) over a folder of engineering
 * PDFs and reports what the resulting candidates look like, per document:
 *
 *  - classification + parse status + how much text actually landed
 *  - title-block harvest hit rate across analyzed pages (drawing sets)
 *  - sheet semantics counts (views, dimensions, callouts, match lines,
 *    schedules) and outbound sheet references
 *  - cross-sheet `references` edges resolved within the batch
 *  - timing, so ingestion cadence stays honest
 *
 * Usage: node scripts/upload-eval.mjs <folder> [--out scorecard.json]
 * Read-only on the corpus; nothing is written to a database.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { buildCandidate } from '../dist/candidate.js';
import { buildReferenceEdges, sheetIndex } from '../dist/edges.js';
import { extractVectorContent } from '../dist/vector.js';
import { SqliteGraphStore } from '@ekg/store-sqlite';

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--'));
if (!folder) {
  console.error('Usage: node scripts/upload-eval.mjs <folder> [--out scorecard.json]');
  process.exit(1);
}
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
const root = resolve(process.env.INIT_CWD ?? process.cwd(), folder);

const files = readdirSync(root)
  .filter((f) => extname(f).toLowerCase() === '.pdf')
  .sort();

const rows = [];
const candidates = [];
for (const name of files) {
  const filePath = join(root, name);
  const sizeMb = statSync(filePath).size / (1024 * 1024);
  const started = Date.now();
  const row = { file: name, mb: Number(sizeMb.toFixed(1)) };
  try {
    const candidate = await buildCandidate(filePath, {
      tenantId: 'eval',
      pipeline: 'upload-eval',
    });
    candidates.push(candidate);
    const e = candidate.entity;
    row.type = e.type;
    row.parseStatus = candidate.parseStatus;
    row.pages = candidate.pageCount;
    row.contentChars = e.content?.length ?? 0;
    row.contentTruncated = (e.content?.length ?? 0) >= 20000;
    row.anchorSheet = e.provenance.anchor?.sheet ?? null;
    row.sheet = e.properties.sheet ?? null;
    row.semantics = e.properties.semantics ?? null;
    row.sheetRefs = e.properties.sheetRefs ?? [];
    row.tags = e.tags ?? [];

    // Chunk coverage (ADR 0006): passages, deepest page reached, and how much
    // total text is retained vs the bounded entity preview.
    const chunks = candidate.chunks ?? [];
    const previewChars = e.content?.length ?? 0;
    const fullChars = chunks.reduce((n, k) => n + k.text.length, 0);
    row.chunks = {
      count: chunks.length,
      deepestPage: chunks.reduce((m, k) => Math.max(m, k.anchor?.page ?? 0), 0),
      previewChars,
      fullChars,
      retainedBeyondPreview: fullChars > previewChars,
    };

    // Title-block hit rate over the pages the pipeline analyzed — drawing
    // sets should yield one per sheet; spec books should yield ~none.
    const vector = await extractVectorContent(new Uint8Array(readFileSync(filePath)));
    const analyzed = vector.pages.length;
    const withTb = vector.pages.filter((p) => p.titleBlock !== undefined).length;
    const sheetNumbers = vector.pages
      .map((p) => p.titleBlock?.sheetNumber)
      .filter((s) => s !== undefined);
    row.capability = vector.capability;
    row.titleBlocks = { analyzedPages: analyzed, found: withTb, sheetNumbers: [...new Set(sheetNumbers)].slice(0, 12) };
  } catch (err) {
    row.error = err instanceof Error ? err.message : String(err);
  }
  row.ms = Date.now() - started;
  rows.push(row);
  console.error(`  uploaded ${name} (${row.ms} ms)`);
}

// Cross-sheet edges resolvable inside this batch (what the CLI would create).
const index = sheetIndex(candidates.map((c) => c.entity));
const { edges, unresolved, ambiguous } = buildReferenceEdges(candidates, index, 'eval');

// Deep-search proof (ADR 0006): ingest into a scratch store, then for the
// longest spec book query a term that lives PAST the 20k preview and confirm
// it is found and cited to its page.
let deepSearch;
const caller = { tenantId: 'eval', principals: ['*'] };
const longest = candidates
  .filter((c) => (c.chunks?.length ?? 0) > 0)
  .sort((a, b) => (b.pageCount ?? 0) - (a.pageCount ?? 0))[0];
if (longest) {
  const db = new SqliteGraphStore(join(mkdtempSync(join(tmpdir(), 'ekg-eval-')), 'ekg.db'));
  for (const c of candidates) await db.upsertEntity(c.entity, c.chunks);
  const preview = (longest.entity.content ?? '').toLowerCase();
  const docName = rows.find((r) => r.contentChars && r.pages === longest.pageCount)?.file ?? '(unknown)';
  // A deep passage whose first 4 long words form a phrase absent from the preview.
  let deepChunk, query;
  for (const k of longest.chunks) {
    if ((k.anchor.page ?? 0) <= 50 || k.text.length < 400) continue;
    const words = k.text.split(/\s+/).filter((w) => /^[A-Za-z]{6,}$/.test(w));
    if (words.length < 4) continue;
    const phrase = words.slice(0, 4).join(' ');
    if (!preview.includes(phrase.toLowerCase())) {
      deepChunk = k;
      query = phrase;
      break;
    }
  }
  if (deepChunk) {
    const hits = await db.search(caller, query, { limit: 5 });
    const hit = hits.find((h) => h.entity.id === longest.entity.id);
    deepSearch = {
      doc: docName,
      pages: longest.pageCount,
      query,
      queryFromPage: deepChunk.anchor.page,
      queryInPreview: preview.includes(query.toLowerCase()),
      found: !!hit,
      citedPage: hit?.chunk?.anchor?.page ?? null,
    };
  }
  db.close();
}

const scorecard = {
  corpus: root,
  date: new Date().toISOString().slice(0, 10),
  files: rows,
  edges: edges.map((e) => ({ from: e.fromId, to: e.toId, ...e.properties })),
  unresolvedSheetRefs: unresolved,
  ambiguousSheetRefs: ambiguous,
  ...(deepSearch ? { deepSearch } : {}),
};

const json = JSON.stringify(scorecard, null, 1);
if (outPath) {
  writeFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), outPath), json);
  console.error(`\nwrote ${outPath}`);
} else {
  console.log(json);
}

console.error('\nSummary:');
for (const r of rows) {
  const tb = r.titleBlocks ? `tb ${r.titleBlocks.found}/${r.titleBlocks.analyzedPages}` : '';
  const ch = r.chunks
    ? `chunks ${r.chunks.count} (→p${r.chunks.deepestPage}, ${(r.chunks.fullChars / 1000).toFixed(0)}k vs ${(r.chunks.previewChars / 1000).toFixed(0)}k preview)`
    : 'no chunks';
  console.error(
    `  ${r.file}: ${r.type ?? 'ERROR'} ${r.parseStatus ?? ''} ${r.pages ?? '?'}p ${tb} | ${ch} | ${r.ms} ms`,
  );
}
console.error(`  edges resolved in batch: ${edges.length}; unresolved targets: ${unresolved.length}; ambiguous: ${ambiguous.length}`);
if (deepSearch) {
  console.error(
    `  deep-search: "${deepSearch.doc}" (${deepSearch.pages}p) — query from page ${deepSearch.queryFromPage}, in preview? ${deepSearch.queryInPreview}; FOUND=${deepSearch.found} cited page ${deepSearch.citedPage}`,
  );
}
