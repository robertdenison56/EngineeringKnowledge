#!/usr/bin/env node
/**
 * Retrieval scorecard: runs the golden set (PRD citation-correctness
 * metric) against the hybrid SQLite store on the seed corpus. Exit 1 on
 * any failure so it can gate CI. Set EKG_EMBEDDINGS_PROVIDER to score the
 * dense layer too; default is lexical+FTS only.
 */
import { DEMO_TENANT, GOLDEN_RETRIEVAL, seedDemo } from '@ekg/core';
import { SqliteGraphStore, providerFromEnv } from '../dist/index.js';

const caller = { tenantId: DEMO_TENANT, principals: ['user:eval', 'group:engineering'] };
const embeddings = providerFromEnv();
const store = new SqliteGraphStore(':memory:', { embeddings });
await seedDemo(store);

let passed = 0;
const rows = [];
for (const c of GOLDEN_RETRIEVAL) {
  const hits = await store.search(caller, c.query, { limit: c.k });
  const ids = hits.map((h) => h.entity.id);
  const ok = c.expect === null ? hits.length === 0 : ids.slice(0, c.k).includes(c.expect);
  if (ok) passed += 1;
  rows.push({
    result: ok ? 'PASS' : 'FAIL',
    case: c.name,
    query: c.query,
    expected: c.expect ?? '(no results)',
    got: ids.slice(0, c.k).join(', ') || '(no results)',
  });
}

console.log(`\nRetrieval eval — ${embeddings ? `hybrid + dense (${embeddings.id})` : 'lexical + FTS5'}\n`);
for (const r of rows) {
  console.log(`${r.result}  ${r.case}`);
  console.log(`      query: "${r.query}"`);
  console.log(`      expected: ${r.expected}`);
  console.log(`      got:      ${r.got}\n`);
}
console.log(`Recall: ${passed}/${GOLDEN_RETRIEVAL.length}`);
store.close();
process.exit(passed === GOLDEN_RETRIEVAL.length ? 0 : 1);
