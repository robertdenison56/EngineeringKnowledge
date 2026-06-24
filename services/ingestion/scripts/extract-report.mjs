#!/usr/bin/env node
/**
 * One-document extraction report — runs the real ingestion pipeline over a
 * single PDF, ingests it into the given database, and prints everything the
 * parser pulled out, so you can see exactly how much is extracted.
 *
 * Usage: node scripts/extract-report.mjs <file.pdf> [--db <path>] [--no-ingest]
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildCandidate } from '../dist/candidate.js';
import { buildReferenceEdges, sheetIndex } from '../dist/edges.js';
import { extractVectorContent } from '../dist/vector.js';
import { analyzeSheet } from '../dist/semantics.js';
import { SqliteGraphStore } from '@ekg/store-sqlite';

const args = process.argv.slice(2);
const file = resolve(process.env.INIT_CWD ?? process.cwd(), args.find((a) => !a.startsWith('--')));
const dbFlag = args.indexOf('--db');
const dbPath = dbFlag >= 0 ? resolve(process.env.INIT_CWD ?? process.cwd(), args[dbFlag + 1]) : undefined;
const doIngest = !args.includes('--no-ingest') && dbPath;
const TENANT = 'demo-firm';

const bar = (n, w = 40) => '█'.repeat(Math.round((n / 100) * w)).padEnd(w, '░');
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const sizeMb = (statSync(file).size / 1024 / 1024).toFixed(1);
const data = new Uint8Array(readFileSync(file));

// --- Real pipeline (what actually gets ingested) ---------------------------
const t0 = Date.now();
const candidate = await buildCandidate(file, { tenantId: TENANT, pipeline: 'extract-report' });
const buildMs = Date.now() - t0;
const e = candidate.entity;
const chunks = candidate.chunks ?? [];

h('═══ DOCUMENT ═══');
console.log(`  file          ${file.split('/').pop()}`);
console.log(`  size / pages  ${sizeMb} MB · ${candidate.pageCount} pages`);
console.log(`  classified    ${e.type}  (parseStatus: ${candidate.parseStatus})`);
console.log(`  entity id     ${e.id}`);
console.log(`  tags          ${(e.tags ?? []).join(', ') || '—'}`);
console.log(`  ingest time   ${buildMs} ms`);

h('═══ TEXT EXTRACTION ═══');
const fullChars = chunks.reduce((n, c) => n + c.text.length, 0);
console.log(`  preview (entity.content)  ${(e.content?.length ?? 0).toLocaleString()} chars`);
console.log(`  full text (chunks)        ${fullChars.toLocaleString()} chars across ${chunks.length} passages`);
console.log(`  deepest chunk page        ${Math.max(...chunks.map((c) => c.anchor.page ?? 0))} / ${candidate.pageCount}`);

// --- Full per-sheet geometry pass (decode every page for the report) -------
const vector = await extractVectorContent(data, { decodeStrokes: true, maxDecodePages: candidate.pageCount });

h('═══ TITLE BLOCKS (geometry-harvested per sheet) ═══');
const tbs = vector.pages.map((p) => ({ page: p.pageNumber, tb: p.titleBlock }));
const withSheet = tbs.filter((x) => x.tb?.sheetNumber);
const pct = Math.round((withSheet.length / vector.pages.length) * 100);
console.log(`  sheet number harvested on ${withSheet.length}/${vector.pages.length} sheets  ${bar(pct)} ${pct}%`);
const sheetNums = [...new Set(withSheet.map((x) => x.tb.sheetNumber))];
console.log(`  distinct sheet numbers: ${sheetNums.join(', ')}`);
const sample = withSheet.slice(0, 6).map((x) => `p${x.page}:${x.tb.sheetNumber}${x.tb.title ? ` "${x.tb.title}"` : ''}${x.tb.sheetIndex ? ` (${x.tb.sheetIndex}/${x.tb.sheetTotal})` : ''}`);
sample.forEach((s) => console.log(`    ${s}`));

h('═══ SHEET SEMANTICS (per sheet) ═══');
const per = vector.pages.map((p) => ({ page: p.pageNumber, sheet: p.titleBlock?.sheetNumber ?? '—', s: analyzeSheet(p) }));
console.log('  page  sheet      views  dims  callouts  matchln  sched  scales');
for (const r of per) {
  const sc = r.s;
  if (sc.views.length + sc.dimensions.length + sc.callouts.length + sc.matchLines.length + sc.schedules.length === 0) continue;
  console.log(
    `  ${String(r.page).padStart(3)}   ${String(r.sheet).padEnd(9)}  ${String(sc.views.length).padStart(4)}  ${String(sc.dimensions.length).padStart(4)}  ${String(sc.callouts.length).padStart(7)}  ${String(sc.matchLines.length).padStart(6)}  ${String(sc.schedules.length).padStart(5)}  ${sc.scales.join(',') || ''}`,
  );
}
const sum = (f) => per.reduce((n, r) => n + f(r.s), 0);
h('  TOTALS across the set:');
console.log(`    views ${sum((s) => s.views.length)} · dimensions ${sum((s) => s.dimensions.length)} · callouts ${sum((s) => s.callouts.length)} · match lines ${sum((s) => s.matchLines.length)} · schedules ${sum((s) => s.schedules.length)}`);
const viewLabels = [...new Set(per.flatMap((r) => r.s.views.map((v) => v.label)))];
console.log(`    distinct view labels: ${viewLabels.slice(0, 24).join(' · ')}`);
const allScales = [...new Set(per.flatMap((r) => r.s.scales))];
console.log(`    scales seen: ${allScales.join(' · ') || '—'}`);
const schedTitles = per.flatMap((r) => r.s.schedules.map((t) => t.title).filter(Boolean));
if (schedTitles.length) console.log(`    schedule titles: ${[...new Set(schedTitles)].slice(0, 12).join(' · ')}`);

h('═══ CROSS-SHEET REFERENCES ═══');
const refs = candidate.references ?? [];
console.log(`  outbound references detected: ${refs.length}`);
for (const r of refs.slice(0, 12)) console.log(`    ${r.detail ? r.detail + '/' : ''}${r.targetSheet}  (p${r.page}, ${r.method}, conf ${r.confidence})`);
const idx = sheetIndex([e]);
const { edges, unresolved } = buildReferenceEdges([candidate], idx, TENANT);
console.log(`  edges resolvable within this document: ${edges.length}; targets to other docs: ${unresolved.length}${unresolved.length ? ' → ' + unresolved.slice(0, 8).join(', ') : ''}`);

h('═══ CAD LAYERS (tier 2) ═══');
console.log(`  layer table: ${vector.capability.layerTable} levels · per-primitive attribution: ${vector.capability.layerAttribution}`);
if (vector.layers) console.log(`    sample: ${vector.layers.slice(0, 10).join(', ')}`);

// --- Ingest --------------------------------------------------------------
if (doIngest) {
  const store = new SqliteGraphStore(dbPath);
  await store.upsertEntity(e, chunks);
  for (const edge of edges) await store.upsertRelationship(edge);
  store.close();
  h(`✓ Ingested into ${dbPath} as an unverified candidate — browse it at /entities/${encodeURIComponent(e.id)}`);
}
