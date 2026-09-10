#!/usr/bin/env node
/**
 * Plan understanding work — dump the parser's SheetFacts for every page of a plan set.
 *
 *   node scripts/extract-sheet-facts.mjs <plan-set.pdf> --doc <manifest id> --out <preds.jsonl> --pages 1-54
 *
 * Calls the real product function (`extractSheetFacts`, services/ingestion describe.ts)
 * once per page, exactly as the gateway's describe flow does, and appends one JSON line
 * per page: {"doc","page","ms","facts"} — `facts` is null when the parser found nothing
 * usable (scan, text-as-outlines), and a per-page parser throw is recorded as "error"
 * rather than aborting the run. The Python side (caltrans_bench.plans) reads this file;
 * it never imports the TypeScript build directly.
 */
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', '..', 'services', 'ingestion', 'dist');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const pdf = args.find((a) => !a.startsWith('--') && a.toLowerCase().endsWith('.pdf'));
const doc = flag('--doc');
const out = flag('--out');
const pages = flag('--pages');
if (!pdf || !doc || !out || !pages) {
  console.error('usage: extract-sheet-facts.mjs <pdf> --doc <id> --out <jsonl> --pages <a-b>');
  process.exit(2);
}
const [lo, hi] = pages.split('-').map((n) => Number.parseInt(n, 10));
if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi < lo) {
  console.error(`bad --pages ${pages}`);
  process.exit(2);
}

const { extractSheetFacts } = await import(`${dist}/describe.js`);
const data = new Uint8Array(readFileSync(resolve(pdf)));
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(out, '');

let extracted = 0;
for (let page = lo; page <= hi; page += 1) {
  const t0 = Date.now();
  let facts = null;
  let error;
  try {
    facts = await extractSheetFacts(data, page);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const ms = Date.now() - t0;
  if (facts) extracted += 1;
  appendFileSync(out, JSON.stringify({ doc, page, ms, facts, ...(error ? { error } : {}) }) + '\n');
  if (page % 10 === 0 || page === hi) {
    console.error(`${doc}: ${page - lo + 1}/${hi - lo + 1} pages, ${extracted} extracted`);
  }
}
