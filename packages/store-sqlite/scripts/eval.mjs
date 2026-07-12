#!/usr/bin/env node
/**
 * Retrieval scorecard (PRD success metric: grounded-answer citation
 * correctness). Runs the golden set against the hybrid SQLite store on the seed
 * corpus and reports RANKED metrics — recall@k, MRR, and the passage-citation
 * rate (how often a document hit lands on a specific page/section, the AEC
 * provenance wedge) — not just binary pass/fail. Exit 1 on any recall/no-results
 * regression so it gates CI. Set EKG_EMBEDDINGS_PROVIDER to score the dense
 * layer too; default is lexical + FTS5.
 *
 * The committed golden set runs with no external data so CI is reproducible.
 * Point EKG_EVAL_GOLDEN at a JSON array of extra {name,query,expect,k} cases
 * (e.g. the 25–40 labelled queries over a real Caltrans/District-3 corpus) to
 * score against a larger, deployment-specific set without committing the PDFs.
 */
import { readFileSync } from 'node:fs';
import { DEMO_TENANT, GOLDEN_RETRIEVAL, seedDemo } from '@ekg/core';
import { SqliteGraphStore, providerFromEnv } from '../dist/index.js';

/** Depth used to locate the expected item for MRR (beyond a case's own k). */
const MRR_DEPTH = 10;

const caller = { tenantId: DEMO_TENANT, principals: ['user:eval', 'group:engineering'] };
const embeddings = providerFromEnv();
const store = new SqliteGraphStore(':memory:', { embeddings });
await seedDemo(store);

// Optional extra cases for a deployment-specific corpus (kept out of the repo).
let cases = [...GOLDEN_RETRIEVAL];
if (process.env.EKG_EVAL_GOLDEN) {
  const extra = JSON.parse(readFileSync(process.env.EKG_EVAL_GOLDEN, 'utf8'));
  if (!Array.isArray(extra)) throw new Error('EKG_EVAL_GOLDEN must be a JSON array of golden cases');
  cases = [...cases, ...extra];
}

let passed = 0;
let reciprocalSum = 0;
let positives = 0; // cases that expect a specific item
let found = 0; // expected item appeared within MRR_DEPTH
let passageHits = 0; // found document/spec hits that cited a page/section
let passageEligible = 0; // found hits where a passage citation is meaningful
let noResultsCases = 0;
let noResultsOk = 0;
const rows = [];

for (const c of cases) {
  if (c.expect === null) {
    // Honest no-results behaviour (P0-8): say "no answer", don't fabricate.
    noResultsCases += 1;
    const hits = await store.search(caller, c.query, { limit: c.k });
    const ok = hits.length === 0;
    if (ok) {
      noResultsOk += 1;
      passed += 1;
    }
    rows.push({
      result: ok ? 'PASS' : 'FAIL',
      case: c.name,
      query: c.query,
      detail: ok ? 'no results (correct)' : `got: ${hits.map((h) => h.entity.id).join(', ')}`,
    });
    continue;
  }

  positives += 1;
  const depth = Math.max(c.k, MRR_DEPTH);
  const hits = await store.search(caller, c.query, { limit: depth });
  const ids = hits.map((h) => h.entity.id);
  const rank = ids.indexOf(c.expect) + 1; // 1-based; 0 when absent
  const recallOk = rank > 0 && rank <= c.k;
  if (recallOk) passed += 1;

  if (rank > 0) {
    found += 1;
    reciprocalSum += 1 / rank;
    // A document/spec answer should cite the page/section it matched, not just
    // the file — the provenance wedge. Other entity kinds (people, materials,
    // standards) legitimately have no passage, so they don't count against it.
    const hit = hits[rank - 1];
    if (/^(document|spec):/.test(c.expect)) {
      passageEligible += 1;
      if (hit.chunk) passageHits += 1;
    }
  }

  rows.push({
    result: recallOk ? 'PASS' : 'FAIL',
    case: c.name,
    query: c.query,
    detail:
      rank > 0
        ? `rank ${rank}${rank <= c.k ? '' : ` (> k=${c.k})`}${hits[rank - 1].chunk ? ' · cited passage' : ''}`
        : `not in top ${depth} — got: ${ids.slice(0, c.k).join(', ') || '(none)'}`,
  });
}

const mode = embeddings ? `hybrid + dense (${embeddings.id})` : 'lexical + FTS5';
console.log(`\nRetrieval eval — ${mode}\n`);
for (const r of rows) {
  console.log(`${r.result}  ${r.case}`);
  console.log(`      query:  "${r.query}"`);
  console.log(`      ${r.detail}\n`);
}

const mrr = positives > 0 ? reciprocalSum / positives : 0;
const passageRate = passageEligible > 0 ? passageHits / passageEligible : 0;
console.log('— Scorecard —');
console.log(`  recall@k:            ${passed}/${cases.length} cases pass`);
console.log(`  MRR (depth ${MRR_DEPTH}):       ${mrr.toFixed(3)} over ${positives} positive cases (${found} found)`);
console.log(`  passage citations:   ${passageHits}/${passageEligible} document hits cite a page/section`);
console.log(`  honest no-results:   ${noResultsOk}/${noResultsCases} correct`);
console.log('');

store.close();
// Gate on the same correctness bar as before — every case must pass its
// recall@k / no-results criterion — so the ranked metrics are reporting, not a
// flaky threshold. A retrieval regression that drops an expected hit out of
// top-k fails CI.
process.exit(passed === cases.length ? 0 : 1);
