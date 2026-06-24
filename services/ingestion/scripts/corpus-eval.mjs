#!/usr/bin/env node
/**
 * Corpus capability scorecard — run against a folder of real engineering
 * PDFs to see what each extraction tier has to work with (vector-parsing
 * plan, docs/plans/2026-06-10): text layer (tier 0), vector operator volume
 * (tier 1), OCG layer metadata (tier 2).
 *
 * Usage: node scripts/corpus-eval.mjs <folder> [--pages-per-doc N]
 *
 * Read-only: nothing is ingested; large sets are sampled (first, middle,
 * last page) so a 45 MB plan set doesn't take minutes.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--'));
if (!folder) {
  console.error('Usage: node scripts/corpus-eval.mjs <folder>');
  process.exit(1);
}
const root = resolve(process.env.INIT_CWD ?? process.cwd(), folder);

const files = readdirSync(root)
  .filter((f) => f.toLowerCase().endsWith('.pdf'))
  .sort();

const rows = [];
for (const name of files) {
  const filePath = join(root, name);
  const sizeMb = statSync(filePath).size / (1024 * 1024);
  const row = { file: name, mb: sizeMb.toFixed(1) };
  try {
    const task = getDocument({
      data: new Uint8Array(readFileSync(filePath)),
      useSystemFonts: true,
      verbosity: 0,
    });
    const doc = await task.promise;
    row.pages = doc.numPages;

    const occ = await doc.getOptionalContentConfig();
    // Count leaf OCGs — order entries can be ids or nested {name, order} nodes
    // (MicroStation exports nest levels under a per-DGN parent group).
    const leaves = [];
    const walk = (entries) => {
      for (const e of entries ?? []) {
        if (typeof e === 'string') leaves.push(e);
        else if (e?.order) walk(e.order);
      }
    };
    walk(occ.getOrder?.());
    row.layers = leaves.length;
    if (leaves.length > 0) {
      const names = leaves.map((id) => occ.getGroup?.(id)?.name).filter(Boolean);
      row.layerSample = [...new Set(names)].slice(0, 8);
    }

    // Sample first / middle / last page.
    const sample = [...new Set([1, Math.ceil(doc.numPages / 2), doc.numPages])];
    let chars = 0;
    let paths = 0;
    let textOps = 0;
    for (const p of sample) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      chars += tc.items.reduce((a, i) => a + i.str.length, 0);
      const ops = await page.getOperatorList();
      for (const fn of ops.fnArray) {
        if (fn === OPS.constructPath) paths += 1;
        else if (fn === OPS.showText || fn === OPS.showSpacedText) textOps += 1;
      }
    }
    row.charsPerPage = Math.round(chars / sample.length);
    row.pathsPerPage = Math.round(paths / sample.length);
    row.textOpsPerPage = Math.round(textOps / sample.length);
    row.class =
      row.charsPerPage < 24
        ? row.pathsPerPage > 50
          ? 'vector-no-text (outlines?)'
          : 'scan/needs-ocr'
        : row.pathsPerPage > 200
          ? 'vector drawing set'
          : 'text document';
    await task.destroy();
  } catch (err) {
    row.class = `unreadable: ${err instanceof Error ? err.message.slice(0, 60) : err}`;
  }
  rows.push(row);
  console.error(`  probed ${name}`);
}

console.log(JSON.stringify(rows, null, 1));

const classes = new Map();
for (const r of rows) classes.set(r.class, (classes.get(r.class) ?? 0) + 1);
console.error('\nSummary:');
for (const [c, n] of classes) console.error(`  ${n} × ${c}`);
console.error(`  layers present in ${rows.filter((r) => r.layers > 0).length}/${rows.length} files`);
