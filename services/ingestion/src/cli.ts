#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { DEMO_TENANT } from '@ekg/core';
import { SqliteGraphStore } from '@ekg/store-sqlite';
import { KNOWN_EXTENSIONS, buildCandidate, type Candidate } from './candidate.js';
import { buildReferenceEdges, sheetIndex } from './edges.js';
import { createPageOcr } from './ocr.js';

/**
 * Ingestion v0 (PRD P0-2): walk a folder, classify each file, and create
 * `unverified` candidate entities in the shared SQLite database — they
 * appear in the workspace app's curation workbench for review.
 *
 * Per-file behavior (classification, PDF text-layer extraction, honesty
 * statuses) lives in `buildCandidate` and is shared with the MCP gateway's
 * `ingest_document` tool (ADR 0004, ADR 0005).
 */

function usage(): never {
  console.error('Usage: npm run ingest --workspace @ekg/ingestion -- <folder> [--db <path>] [--tenant <id>]');
  process.exit(1);
}

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--'));
if (!folder) usage();

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

// npm workspace scripts run with cwd inside the package; INIT_CWD is where
// the user actually invoked npm, so documented relative paths work.
const baseDir = process.env.INIT_CWD ?? process.cwd();
const dbPath = resolve(baseDir, flag('db') ?? join('.data', 'ekg.db'));
const tenantId = flag('tenant') ?? DEMO_TENANT;
const root = resolve(baseDir, folder);

const store = new SqliteGraphStore(dbPath);
const now = new Date().toISOString();
// OCR image-only scans into a searchable, page-anchored text layer when an
// engine is installed (tesseract.js or the tesseract CLI, plus poppler) — an
// honest no-op otherwise: the scan stays needs-ocr, never fabricated (P0-2a).
// EKG_DISABLE_OCR=1 opts out even when an engine is present (matches gateway).
const ocr = process.env.EKG_DISABLE_OCR === '1' ? null : await createPageOcr();
const counts = new Map<string, number>();
const candidates: Candidate[] = [];
let skipped = 0;
let needsOcr = 0;
let ocrExtracted = 0;
let ocrFlagged = 0;
const unreadable: string[] = [];

for (const name of readdirSync(root, { recursive: true }) as string[]) {
  const filePath = join(root, name);
  // A folder we are handed is not a folder we control: a dangling symlink (an
  // alias to a moved folder, a cloud-sync placeholder) makes `stat` throw, and
  // an unhandled throw here abandons the whole walk mid-run — every document
  // after it silently missing, with a partial write already committed. Report
  // the entry and keep going; the summary names what was passed over.
  let entry;
  try {
    entry = statSync(filePath);
  } catch {
    unreadable.push(name);
    continue;
  }
  if (!entry.isFile()) continue;
  if (!KNOWN_EXTENSIONS.has(extname(name).toLowerCase())) {
    skipped += 1;
    continue;
  }

  const candidate = await buildCandidate(filePath, {
    tenantId,
    pipeline: 'ingestion-v0',
    now,
    ...(ocr ? { ocr } : {}),
  });
  if (candidate.parseStatus === 'needs-ocr') needsOcr += 1;
  if (candidate.parseStatus === 'ocr-extracted') {
    ocrExtracted += 1;
    const meta = candidate.entity.properties.ocr as { needsReview?: boolean } | undefined;
    if (meta?.needsReview) ocrFlagged += 1;
  }
  await store.upsertEntity(candidate.entity, candidate.chunks);
  candidates.push(candidate);
  counts.set(candidate.entity.type, (counts.get(candidate.entity.type) ?? 0) + 1);
}

// Cross-sheet callouts → `references` edges (Phase B): resolve against this
// batch plus what the store already knows, so a sheet ingested today links
// to one ingested last week.
const existing = await store.list({ tenantId, principals: ['ingestion-cli'] });
const index = sheetIndex([...existing, ...candidates.map((c) => c.entity)]);
const { edges, unresolved, ambiguous } = buildReferenceEdges(candidates, index, tenantId);
for (const edge of edges) await store.upsertRelationship(edge);

store.close();

const total = [...counts.values()].reduce((a, b) => a + b, 0);
const chunkTotal = candidates.reduce((n, c) => n + (c.chunks?.length ?? 0), 0);
console.log(`Ingested ${total} candidate(s) into ${dbPath} (tenant: ${tenantId})`);
for (const [type, n] of counts) console.log(`  ${type}: ${n}`);
if (chunkTotal > 0) console.log(`  ${chunkTotal} searchable passage(s) indexed across documents (ADR 0006)`);
if (ocrExtracted > 0)
  console.log(
    `  ${ocrExtracted} scanned PDF(s) OCR-recovered` +
      (ocrFlagged > 0 ? ` (${ocrFlagged} flagged low-confidence for review)` : ''),
  );
if (needsOcr > 0)
  console.log(
    `  ${needsOcr} scanned PDF(s) flagged needs-ocr — ${ocr ? 'nothing legible recovered' : 'no OCR engine installed'}`,
  );
if (skipped > 0) console.log(`  skipped ${skipped} file(s) with unsupported extensions`);
if (unreadable.length > 0)
  console.log(
    `  ${unreadable.length} unreadable entr(y/ies) passed over (broken link or no permission): ${unreadable.slice(0, 8).join(', ')}`,
  );
if (edges.length > 0) console.log(`  ${edges.length} cross-sheet reference edge(s) created from callouts/match lines`);
if (unresolved.length > 0)
  console.log(`  ${unresolved.length} referenced sheet(s) not in the graph yet: ${unresolved.slice(0, 8).join(', ')}`);
if (ambiguous.length > 0)
  console.log(`  ${ambiguous.length} reference(s) skipped — multiple entities claim the sheet: ${ambiguous.join(', ')}`);
console.log('Candidates are queued as "unverified" — review them in the workspace app at /curation.');
