import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_TENANT } from '@ekg/core';
import { SqliteGraphStore } from '../dist/index.js';

const CALLER = { tenantId: 't', principals: ['*'] };
const OTHER = { tenantId: 'other', principals: ['*'] };

function freshStore() {
  return new SqliteGraphStore(join(mkdtempSync(join(tmpdir(), 'ekg-chunks-')), 'ekg.db'));
}

function doc(id, content, props = {}) {
  return {
    id,
    tenantId: 't',
    type: 'document',
    title: id,
    summary: content.slice(0, 80),
    properties: props,
    content: content.slice(0, 60), // bounded preview, like ingestion
    provenance: { createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z', reviewStatus: 'unverified' },
    acl: { allowedPrincipals: ['*'] },
  };
}

function chunk(entityId, ordinal, anchor, text, heading) {
  return { id: `${entityId}#${ordinal}`, entityId, tenantId: 't', ordinal, anchor, text, ...(heading ? { heading } : {}) };
}

// --- The core win: text past the preview is searchable via chunks ----------

test('deep-page text (past the preview) is found and cited to its page', async () => {
  const store = freshStore();
  // Preview holds only the opening; the silica-fume requirement lives "deep".
  const entity = doc('spec:1', 'SECTION 90 INTRO boilerplate that fills the preview window completely');
  const chunks = [
    chunk('spec:1', 0, { page: 1 }, 'SECTION 90 INTRO boilerplate', '90 (p. 1)'),
    chunk('spec:1', 1, { page: 212, specSection: '90 10' }, 'Concrete shall contain silica fume admixture per the special provisions', '90 10 (p. 212)'),
  ];
  await store.upsertEntity(entity, chunks);

  // The term is NOT in the entity preview…
  assert.ok(!entity.content.includes('silica'));
  // …yet search finds it, and cites the page it lives on.
  const hits = await store.search(CALLER, 'silica fume admixture');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].entity.id, 'spec:1');
  assert.equal(hits[0].chunk?.anchor.page, 212);
  assert.equal(hits[0].chunk?.anchor.specSection, '90 10');
  assert.match(hits[0].chunk?.snippet ?? '', /silica fume/i);
  store.close();
});

test('chunk gate stays honest: scattered concepts in different chunks do not match', async () => {
  const store = freshStore();
  await store.upsertEntity(doc('spec:2', 'opening preview text only'), [
    chunk('spec:2', 0, { page: 3 }, 'discussion of mineral wool firestopping systems'),
    chunk('spec:2', 1, { page: 80 }, 'unrelated section about asphalt paving joints'),
  ]);
  // "asphalt" + "firestopping" never co-occur in one passage, and neither is
  // in the preview — so no honest match (P0-8).
  assert.equal((await store.search(CALLER, 'asphalt firestopping')).length, 0);
  // Both concepts in ONE chunk → match.
  assert.equal((await store.search(CALLER, 'mineral wool firestopping')).length, 1);
  store.close();
});

// --- Lifecycle: replace, preserve, cascade, isolate ------------------------

test('omitted chunks preserve passages; [] clears them', async () => {
  const store = freshStore();
  const entity = doc('d:1', 'body');
  await store.upsertEntity(entity, [chunk('d:1', 0, { page: 1 }, 'firestop detail text')]);
  assert.equal((await store.getChunks(CALLER, 'd:1')).length, 1);

  // Curation-style re-upsert with no chunks must NOT wipe them.
  entity.provenance.reviewStatus = 'verified';
  await store.upsertEntity(entity);
  assert.equal((await store.getChunks(CALLER, 'd:1')).length, 1);
  assert.equal((await store.search(CALLER, 'firestop detail')).length, 1);

  // Explicit empty array clears.
  await store.upsertEntity(entity, []);
  assert.equal((await store.getChunks(CALLER, 'd:1')).length, 0);
  store.close();
});

test('re-upsert with new chunks replaces the old set (no stale rows)', async () => {
  const store = freshStore();
  await store.upsertEntity(doc('d:2', 'body'), [chunk('d:2', 0, { page: 1 }, 'old keyword zebra')]);
  await store.upsertEntity(doc('d:2', 'body'), [chunk('d:2', 0, { page: 1 }, 'new keyword giraffe')]);
  assert.equal((await store.search(CALLER, 'zebra')).length, 0, 'stale chunk gone');
  assert.equal((await store.search(CALLER, 'giraffe')).length, 1);
  store.close();
});

test('deleteEntity cascades chunks and their FTS rows', async () => {
  const store = freshStore();
  await store.upsertEntity(doc('d:3', 'body'), [chunk('d:3', 0, { page: 1 }, 'culvert headwall keyword')]);
  assert.equal(await store.deleteEntity(CALLER, 'd:3'), true);
  assert.equal((await store.getChunks(CALLER, 'd:3')).length, 0);
  assert.equal((await store.search(CALLER, 'culvert headwall')).length, 0, 'chunk FTS row removed');
  store.close();
});

test('chunks inherit parent ACL/tenant trimming', async () => {
  const store = freshStore();
  await store.upsertEntity(doc('d:4', 'body'), [chunk('d:4', 0, { page: 1 }, 'tenant-scoped passage text')]);
  // A caller from another tenant sees neither the chunk nor a search hit.
  assert.equal((await store.getChunks(OTHER, 'd:4')).length, 0);
  assert.equal((await store.search(OTHER, 'tenant-scoped passage')).length, 0);
  store.close();
});

test('chunkless entities still search at the entity level (no regression)', async () => {
  const store = freshStore();
  await store.upsertEntity(doc('d:5', 'a short captured lesson about parapet flashing'));
  const hits = await store.search(CALLER, 'parapet flashing');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chunk, undefined, 'no chunk match attached for an entity-level hit');
  store.close();
});
