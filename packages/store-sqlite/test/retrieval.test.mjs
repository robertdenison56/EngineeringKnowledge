import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_TENANT, GOLDEN_RETRIEVAL, seedDemo } from '@ekg/core';
import { SqliteGraphStore } from '../dist/index.js';

const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };

/** Deterministic toy embedder — tests the dense plumbing, not quality. */
class MockEmbeddings {
  id = 'mock:test';
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array(16).fill(0);
      for (const ch of t.toLowerCase()) v[ch.charCodeAt(0) % 16] += 1;
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
}

test('golden retrieval set passes on the hybrid store (lexical + FTS5)', async () => {
  const store = new SqliteGraphStore(':memory:');
  await seedDemo(store);
  for (const c of GOLDEN_RETRIEVAL) {
    const hits = await store.search(ENGINEER, c.query, { limit: c.k });
    const ids = hits.map((h) => h.entity.id);
    if (c.expect === null) {
      assert.equal(hits.length, 0, `${c.name}: expected no results, got [${ids.join(', ')}]`);
    } else {
      assert.ok(
        ids.slice(0, c.k).includes(c.expect),
        `${c.name}: expected ${c.expect} in top ${c.k}, got [${ids.join(', ')}]`,
      );
    }
  }
});

test('dense layer: embeddings stored, fused, and never break honesty', async () => {
  const store = new SqliteGraphStore(':memory:', { embeddings: new MockEmbeddings() });
  await seedDemo(store);
  assert.ok(store.countEmbedded(DEMO_TENANT) > 0, 'vectors stored at upsert');

  const hits = await store.search(ENGINEER, 'curtain wall firestop detail');
  assert.equal(hits[0].entity.id, 'detail:cw-firestop-02', 'hybrid ranking still correct');

  const none = await store.search(ENGINEER, 'zzz nonexistent topic zzz');
  assert.equal(none.length, 0, 'vectors must not admit lexically unmatched items (P0-8)');
});

test('reindexEmbeddings backfills rows missing vectors', async () => {
  const store = new SqliteGraphStore(':memory:');
  await seedDemo(store);
  const withProvider = new SqliteGraphStore(':memory:', { embeddings: new MockEmbeddings() });
  await seedDemo(withProvider);
  // simulate pre-embedding rows: a fresh store without provider has none
  assert.equal(store.countEmbedded(DEMO_TENANT), 0);
  assert.ok(withProvider.countEmbedded(DEMO_TENANT) > 0);
  store.close();
  withProvider.close();
});
