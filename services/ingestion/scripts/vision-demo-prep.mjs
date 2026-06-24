#!/usr/bin/env node
/**
 * Reproduces the gateway's ingest_document describe step (ADR 0005 + 0007)
 * for specific pages: renders the sheet exactly as the gateway does
 * (rasterizeSheet), extracts + formats the fusion facts (extractSheetFacts /
 * formatSheetFacts), and writes the rendered tiles + the exact describe
 * prompt to disk so a vision model can play the BYO client model.
 *
 * Usage: node scripts/vision-demo-prep.mjs <file.pdf> <page> [page...]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rasterizeSheet, extractSheetFacts, formatSheetFacts } from '../dist/index.js';

const args = process.argv.slice(2);
const file = resolve(process.env.INIT_CWD ?? process.cwd(), args[0]);
const pages = args.slice(1).map(Number);
const outDir = '/tmp/vision-demo';
mkdirSync(outDir, { recursive: true });

const data = new Uint8Array(readFileSync(file));

for (const page of pages) {
  const images = rasterizeSheet(file, { page }); // overview + 4 tiles (real gateway)
  const paths = [];
  images.forEach((img, i) => {
    const p = `${outDir}/p${page}-${i === 0 ? 'overview' : `tile${i}`}.png`;
    writeFileSync(p, img.png);
    paths.push({ label: img.label, path: p });
  });

  const facts = await extractSheetFacts(data, page);
  const factsBlock = facts ? formatSheetFacts(facts) : null;

  // The exact instruction text ingest_document appends after the images.
  const instructions =
    (factsBlock ? `${factsBlock}\n\n` : '') +
    `Sheet renderings above (${images.map((i) => i.label).join('; ')}). ` +
    'Describe what is drafted: views/details present, components, materials, and what the ' +
    'annotations say. Then call save_description with `description` (plain language) and ' +
    '`annotations` (labels, dimensions, callouts quoted VERBATIM from the sheet). Rules: ' +
    'quote, never paraphrase identifiers or dimensions; do NOT count symbols or report ' +
    'quantities; do NOT infer dimensions that are not printed; if a region is illegible, ' +
    'say so instead of guessing.';

  writeFileSync(`${outDir}/p${page}-prompt.txt`, instructions);
  writeFileSync(`${outDir}/p${page}-images.json`, JSON.stringify(paths, null, 1));
  console.log(`\n=== PAGE ${page} ===`);
  console.log(`images: ${paths.map((p) => p.path.split('/').pop()).join(', ')}`);
  console.log(`fusion facts: ${facts ? 'YES' : 'none (pixels only)'}`);
  console.log(`prompt → ${outDir}/p${page}-prompt.txt`);
}
