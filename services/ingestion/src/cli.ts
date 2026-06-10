#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { DEMO_TENANT, type Entity } from '@ekg/core';
import { SqliteGraphStore } from '@ekg/store-sqlite';
import { classifyFilename, deriveTags } from './classify.js';

/**
 * Ingestion v0 (PRD P0-2): walk a folder, classify each file, and create
 * `unverified` candidate entities in the shared SQLite database — they
 * appear in the workspace app's curation workbench for review.
 *
 * Text formats (.txt/.md) get their content summarized. PDFs are recorded
 * with classification + anchors only: class-specific text extraction is
 * gated on the PRD Open Question 8 parser spike (P0-2a), and recording
 * "parsing pending" is more honest than ingesting garbage text.
 */

const TEXT_EXTENSIONS = new Set(['.txt', '.md']);
const KNOWN_EXTENSIONS = new Set(['.txt', '.md', '.pdf']);

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
const counts = new Map<string, number>();
let skipped = 0;

for (const name of readdirSync(root, { recursive: true }) as string[]) {
  const filePath = join(root, name);
  if (!statSync(filePath).isFile()) continue;
  const ext = extname(name).toLowerCase();
  if (!KNOWN_EXTENSIONS.has(ext)) {
    skipped += 1;
    continue;
  }

  const file = basename(name);
  const classification = classifyFilename(file);
  const { type, anchor } = classification;
  const id = `ingest:${createHash('sha1').update(filePath).digest('hex').slice(0, 12)}`;

  let summary: string;
  let content = '';
  if (TEXT_EXTENSIONS.has(ext)) {
    content = readFileSync(filePath, 'utf8').replace(/\s+/g, ' ').trim();
    summary = content.slice(0, 400);
  } else {
    summary = '[PDF — text extraction pending the class-specific parsing spike (PRD P0-2a / OQ 8)]';
  }
  const tags = deriveTags(file, content, classification);

  const entity: Entity = {
    id,
    tenantId,
    type,
    title: file.replace(/\.[^.]+$/, ''),
    summary,
    properties: { ingestedFrom: filePath, extension: ext, pipeline: 'ingestion-v0' },
    ...(tags.length > 0 ? { tags } : {}),
    // Full extracted text — searchable, and viewable in the workspace app
    // so users can verify answers against the exact source document.
    ...(content ? { content: content.slice(0, 20000) } : {}),
    provenance: {
      sourceUrl: `file://${filePath}`,
      createdAt: now,
      modifiedAt: now,
      reviewStatus: 'unverified',
      ...(anchor ? { anchor } : {}),
    },
    acl: { allowedPrincipals: ['*'] },
  };

  await store.upsertEntity(entity);
  counts.set(type, (counts.get(type) ?? 0) + 1);
}

store.close();

const total = [...counts.values()].reduce((a, b) => a + b, 0);
console.log(`Ingested ${total} candidate(s) into ${dbPath} (tenant: ${tenantId})`);
for (const [type, n] of counts) console.log(`  ${type}: ${n}`);
if (skipped > 0) console.log(`  skipped ${skipped} file(s) with unsupported extensions`);
console.log('Candidates are queued as "unverified" — review them in the workspace app at /curation.');
