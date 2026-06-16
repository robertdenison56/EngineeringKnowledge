import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_TENANT, seedDemo } from '@ekg/core';
import { SqliteGraphStore } from '../dist/index.js';

const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };
const LEGAL = { tenantId: DEMO_TENANT, principals: ['user:dana', 'group:legal'] };
const OTHER_FIRM = { tenantId: 'other-firm', principals: ['*'] };

function freshDbPath() {
  return join(mkdtempSync(join(tmpdir(), 'ekg-sqlite-')), 'ekg.db');
}

test('contract: search, ACL trimming, tenant isolation, warnings', async () => {
  const store = new SqliteGraphStore(freshDbPath());
  await seedDemo(store);

  const hits = await store.search(ENGINEER, 'curtain wall firestop');
  assert.equal(hits[0].entity.id, 'detail:cw-firestop-02');
  const superseded = (await store.search(ENGINEER, 'firestop')).find(
    (h) => h.entity.id === 'detail:cw-firestop-01',
  );
  assert.match(superseded?.warning ?? '', /superseded/i);

  assert.equal((await store.search(ENGINEER, 'legal memo claim')).length, 0);
  assert.equal((await store.search(LEGAL, 'legal memo claim')).length, 1);
  assert.equal((await store.search(OTHER_FIRM, 'firestop')).length, 0);
  store.close();
});

test('contract: neighbors and deleteEntity cascade', async () => {
  const store = new SqliteGraphStore(freshDbPath());
  await seedDemo(store);

  const neighbors = await store.neighbors(ENGINEER, 'detail:cw-firestop-02');
  assert.equal(neighbors.length, 4);

  assert.equal(await store.deleteEntity(OTHER_FIRM, 'detail:cw-firestop-01'), false);
  assert.equal(await store.deleteEntity(ENGINEER, 'detail:cw-firestop-01'), true);
  assert.equal(await store.getEntity(ENGINEER, 'detail:cw-firestop-01'), undefined);
  assert.equal(
    (await store.neighbors(ENGINEER, 'detail:cw-firestop-02', 'supersedes')).length,
    0,
    'dangling relationships removed',
  );
  store.close();
});

test('contract: tags round-trip, filter, and listRelationships visibility', async () => {
  const store = new SqliteGraphStore(freshDbPath());
  await seedDemo(store);
  const detail = await store.getEntity(ENGINEER, 'detail:cw-firestop-02');
  assert.ok(detail?.tags?.includes('firestop'), 'tags survive the round-trip');
  const both = await store.list(ENGINEER, { tags: ['firestop', 'sealant'] });
  assert.deepEqual(both.map((e) => e.id), ['material:fs-195']);
  assert.equal((await store.listRelationships(ENGINEER)).length, 7);
  assert.equal((await store.listRelationships(OTHER_FIRM)).length, 0);
  store.close();
});

test('persistence: data survives reopening the database', async () => {
  const path = freshDbPath();
  const first = new SqliteGraphStore(path);
  await seedDemo(first);
  assert.ok(first.countEntities(DEMO_TENANT) > 0);
  first.close();

  const second = new SqliteGraphStore(path);
  const entity = await second.getEntity(ENGINEER, 'detail:cw-firestop-02');
  assert.equal(entity?.title, 'Curtain wall to slab edge firestop detail (rev. 2)');
  assert.ok(entity?.provenance.anchor?.sheet, 'anchors survive round-trip');
  second.close();
});

test('upsert updates in place (curation verify flow)', async () => {
  const store = new SqliteGraphStore(freshDbPath());
  await seedDemo(store);
  const candidate = await store.getEntity(ENGINEER, 'material:fs-195');
  assert.equal(candidate?.provenance.reviewStatus, 'unverified');
  candidate.provenance.reviewStatus = 'verified';
  await store.upsertEntity(candidate);
  const after = await store.getEntity(ENGINEER, 'material:fs-195');
  assert.equal(after?.provenance.reviewStatus, 'verified');
  assert.equal(store.countEntities(DEMO_TENANT), 9, 'no duplicate row created');
  store.close();
});

test('persistence: chunks survive reopening and stay searchable (ADR 0006)', async () => {
  const path = freshDbPath();
  const first = new SqliteGraphStore(path);
  await seedDemo(first);
  await first.upsertEntity(
    {
      id: 'doc:spec-x',
      tenantId: DEMO_TENANT,
      type: 'document',
      title: 'Spec X',
      summary: 'opening preview',
      properties: {},
      content: 'opening preview',
      provenance: { createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z', reviewStatus: 'unverified' },
      acl: { allowedPrincipals: ['*'] },
    },
    [
      {
        id: 'doc:spec-x#0',
        entityId: 'doc:spec-x',
        tenantId: DEMO_TENANT,
        ordinal: 0,
        anchor: { page: 142, specSection: '51 10' },
        heading: '51 10 (p. 142)',
        text: 'cast-in-place prestressed box girder camber tolerances',
      },
    ],
  );
  first.close();

  const second = new SqliteGraphStore(path);
  const chunks = await second.getChunks(ENGINEER, 'doc:spec-x');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].anchor.page, 142);
  const hits = await second.search(ENGINEER, 'prestressed box girder camber');
  assert.equal(hits[0]?.entity.id, 'doc:spec-x');
  assert.equal(hits[0].chunk?.anchor.page, 142, 'hit cites the deep page');
  second.close();
});
