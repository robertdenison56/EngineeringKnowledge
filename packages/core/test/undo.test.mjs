import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_TENANT,
  InMemoryGraphStore,
  InMemoryOperationJournal,
  JournaledGraphStore,
  undoOperation,
  seedDemo,
} from '../dist/index.js';

const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };

/** Drive the decorator the way the web app's runAsOperation does, but without
 *  AsyncLocalStorage — the test owns the context directly. */
function harness(raw) {
  const journal = new InMemoryOperationJournal();
  let ctx;
  const store = new JournaledGraphStore(raw, journal, () => ctx);
  let n = 0;
  async function run(meta, fn) {
    n += 1;
    const id = meta.id ?? `op-${n}`;
    const createdAt = meta.createdAt ?? new Date(1700000000000 + n * 1000).toISOString();
    journal.begin({
      id,
      tenantId: DEMO_TENANT,
      label: meta.label ?? 'op',
      kind: meta.kind ?? 'edit-entity',
      actor: 'user:test',
      createdAt,
    });
    ctx = { opId: id, caller: meta.caller ?? ENGINEER };
    try {
      return await fn();
    } finally {
      ctx = undefined;
      journal.commit(id);
    }
  }
  return { store, journal, run };
}

const BASE = {
  tenantId: DEMO_TENANT,
  properties: {},
  acl: { allowedPrincipals: ['*'] },
  provenance: { createdAt: 'x', modifiedAt: 'x', reviewStatus: 'verified' },
};
const chunk = (entityId, ordinal, text) => ({
  id: `${entityId}#${ordinal}`,
  entityId,
  tenantId: DEMO_TENANT,
  ordinal,
  anchor: { page: ordinal + 1 },
  text,
});

test('undo of a fields-only edit reverts fields and leaves chunks intact (ADR 0006)', async () => {
  const raw = new InMemoryGraphStore();
  const { store, journal, run } = harness(raw);
  await raw.upsertEntity({ ...BASE, id: 'doc', type: 'document', title: 'Original' }, [
    chunk('doc', 0, 'firestop passage'),
  ]);

  await run({ kind: 'edit-entity' }, async () => {
    const e = await store.getEntity(ENGINEER, 'doc');
    await store.upsertEntity({ ...e, title: 'Renamed' }); // chunks omitted
  });
  assert.equal((await store.getEntity(ENGINEER, 'doc')).title, 'Renamed');
  assert.equal((await store.getChunks(ENGINEER, 'doc')).length, 1);

  const opId = journal.list(DEMO_TENANT, 1)[0].id;
  const res = await undoOperation(store, journal, opId, { caller: ENGINEER });
  assert.ok(res.ok);
  assert.equal((await store.getEntity(ENGINEER, 'doc')).title, 'Original', 'fields reverted');
  const chunks = await store.getChunks(ENGINEER, 'doc');
  assert.equal(chunks.length, 1, 'chunks were never touched');
  assert.equal(chunks[0].text, 'firestop passage');
});

test('undo of a chunk-replacing upsert restores the prior chunks', async () => {
  const raw = new InMemoryGraphStore();
  const { store, journal, run } = harness(raw);
  await raw.upsertEntity({ ...BASE, id: 'doc', type: 'document', title: 'Doc' }, [
    chunk('doc', 0, 'one'),
    chunk('doc', 1, 'two'),
    chunk('doc', 2, 'three'),
  ]);

  await run({ kind: 'edit-entity' }, async () => {
    const e = await store.getEntity(ENGINEER, 'doc');
    await store.upsertEntity({ ...e, title: 'Doc2' }, []); // wipe chunks explicitly
  });
  assert.equal((await store.getChunks(ENGINEER, 'doc')).length, 0);

  const opId = journal.list(DEMO_TENANT, 1)[0].id;
  await undoOperation(store, journal, opId, { caller: ENGINEER });
  assert.equal((await store.getChunks(ENGINEER, 'doc')).length, 3, 'prior chunks restored');
});

test('undo of a newly-created entity deletes it', async () => {
  const raw = new InMemoryGraphStore();
  const { store, journal, run } = harness(raw);
  await run({ kind: 'capture-knowledge' }, async () => {
    await store.upsertEntity({ ...BASE, id: 'new', type: 'lesson-learned', title: 'New' });
  });
  assert.ok(await store.getEntity(ENGINEER, 'new'));

  const opId = journal.list(DEMO_TENANT, 1)[0].id;
  await undoOperation(store, journal, opId, { caller: ENGINEER });
  assert.equal(await store.getEntity(ENGINEER, 'new'), undefined);
});

test('undo of a merge restores the duplicate, its edges, and the survivor fields', async () => {
  const raw = new InMemoryGraphStore();
  await seedDemo(raw);
  const { store, journal, run } = harness(raw);
  const before = await store.getEntity(ENGINEER, 'detail:cw-firestop-02');

  // Mirror the merge server action: reconcile survivor, then fold the duplicate.
  await run({ kind: 'merge-entities', label: 'merge' }, async () => {
    const survivor = await store.getEntity(ENGINEER, 'detail:cw-firestop-02');
    const duplicate = await store.getEntity(ENGINEER, 'detail:cw-firestop-01');
    await store.upsertEntity({
      ...survivor,
      aliases: [...(survivor.aliases ?? []), duplicate.title],
      provenance: { ...survivor.provenance, modifiedAt: 'merged' },
    });
    await store.mergeEntities(ENGINEER, 'detail:cw-firestop-02', 'detail:cw-firestop-01');
  });
  assert.equal(await store.getEntity(ENGINEER, 'detail:cw-firestop-01'), undefined, 'merged away');

  const opId = journal.list(DEMO_TENANT, 1)[0].id;
  const res = await undoOperation(store, journal, opId, { caller: ENGINEER });
  assert.ok(res.ok);

  assert.ok(await store.getEntity(ENGINEER, 'detail:cw-firestop-01'), 'duplicate restored');
  const lesson = await store.neighbors(ENGINEER, 'lesson:firestop-mockup-failure', 'applies-to');
  assert.deepEqual(lesson.map((n) => n.entity.id), ['detail:cw-firestop-01'], 'edge repointed back');
  const sup = await store.neighbors(ENGINEER, 'detail:cw-firestop-02', 'supersedes');
  assert.ok(sup.some((n) => n.entity.id === 'detail:cw-firestop-01'), 'dropped supersedes edge restored');
  const after = await store.getEntity(ENGINEER, 'detail:cw-firestop-02');
  assert.deepEqual(after.aliases ?? [], before.aliases ?? [], 'survivor fields reverted');
  assert.equal(after.provenance.modifiedAt, before.provenance.modifiedAt);
});

test('undo of a reject restores the entity and every relationship it touched', async () => {
  const raw = new InMemoryGraphStore();
  await seedDemo(raw);
  const { store, journal, run } = harness(raw);
  const edgesBefore = (await store.neighbors(ENGINEER, 'detail:cw-firestop-02')).length;
  assert.ok(edgesBefore > 0);

  await run({ kind: 'reject-entity' }, async () => {
    await store.deleteEntity(ENGINEER, 'detail:cw-firestop-02');
  });
  assert.equal(await store.getEntity(ENGINEER, 'detail:cw-firestop-02'), undefined);

  const opId = journal.list(DEMO_TENANT, 1)[0].id;
  await undoOperation(store, journal, opId, { caller: ENGINEER });
  assert.ok(await store.getEntity(ENGINEER, 'detail:cw-firestop-02'), 'entity back');
  assert.equal(
    (await store.neighbors(ENGINEER, 'detail:cw-firestop-02')).length,
    edgesBefore,
    'edges back',
  );
});

test('a bulk operation undoes every entity and edge as one unit', async () => {
  const raw = new InMemoryGraphStore();
  const { store, journal, run } = harness(raw);
  await run({ kind: 'ingest-uploads', label: 'Imported 2 sheets' }, async () => {
    await store.upsertEntity({ ...BASE, id: 'sheetA', type: 'project', title: 'A-101' });
    await store.upsertEntity({ ...BASE, id: 'sheetB', type: 'project', title: 'A-102' });
    await store.upsertRelationship({
      id: 'refAB',
      tenantId: DEMO_TENANT,
      type: 'references',
      fromId: 'sheetA',
      toId: 'sheetB',
    });
  });
  const op = journal.list(DEMO_TENANT, 1)[0];
  assert.equal(op.entryCount, 3, 'two entities + one edge');

  await undoOperation(store, journal, op.id, { caller: ENGINEER });
  assert.equal(await store.getEntity(ENGINEER, 'sheetA'), undefined);
  assert.equal(await store.getEntity(ENGINEER, 'sheetB'), undefined);
  assert.equal((await store.listRelationships(ENGINEER)).length, 0, 'reference edge gone too');
});

test('list is newest-first and LIFO undo respects the conflict guard', async () => {
  const raw = new InMemoryGraphStore();
  const { store, journal, run } = harness(raw);
  await raw.upsertEntity({ ...BASE, id: 'z', type: 'project', title: 'Z0' });

  await run({ id: 'op-1', createdAt: '2026-01-01T00:00:00.000Z', kind: 'edit-entity' }, async () => {
    const e = await store.getEntity(ENGINEER, 'z');
    await store.upsertEntity({ ...e, title: 'Z1' });
  });
  await run({ id: 'op-2', createdAt: '2026-01-02T00:00:00.000Z', kind: 'edit-entity' }, async () => {
    const e = await store.getEntity(ENGINEER, 'z');
    await store.upsertEntity({ ...e, title: 'Z2' });
  });

  assert.deepEqual(journal.list(DEMO_TENANT).map((o) => o.id), ['op-2', 'op-1'], 'newest first');

  const blocked = await undoOperation(store, journal, 'op-1', { caller: ENGINEER });
  assert.equal(blocked.ok, false, 'older op blocked while a newer one touches the same record');
  assert.match(blocked.reason, /later change/i);

  const newest = await undoOperation(store, journal, 'op-2', { caller: ENGINEER });
  assert.ok(newest.ok, 'newest undoes freely');
  assert.equal((await store.getEntity(ENGINEER, 'z')).title, 'Z1');

  const older = await undoOperation(store, journal, 'op-1', { caller: ENGINEER });
  assert.ok(older.ok, 'older undoes once the newer one is gone');
  assert.equal((await store.getEntity(ENGINEER, 'z')).title, 'Z0', 'fully rolled back');
});

test('force overrides the conflict guard', async () => {
  const raw = new InMemoryGraphStore();
  const { store, journal, run } = harness(raw);
  await raw.upsertEntity({ ...BASE, id: 'z', type: 'project', title: 'Z0' });
  await run({ id: 'op-1', createdAt: '2026-01-01T00:00:00.000Z', kind: 'edit-entity' }, async () => {
    const e = await store.getEntity(ENGINEER, 'z');
    await store.upsertEntity({ ...e, title: 'Z1' });
  });
  await run({ id: 'op-2', createdAt: '2026-01-02T00:00:00.000Z', kind: 'edit-entity' }, async () => {
    const e = await store.getEntity(ENGINEER, 'z');
    await store.upsertEntity({ ...e, title: 'Z2' });
  });
  const forced = await undoOperation(store, journal, 'op-1', { caller: ENGINEER, force: true });
  assert.ok(forced.ok);
  assert.equal((await store.getEntity(ENGINEER, 'z')).title, 'Z0');
});

test('undo restores a prior setting and removes one the operation created', async () => {
  const raw = new InMemoryGraphStore();
  const { store, journal, run } = harness(raw);
  await run({ id: 'set-1', createdAt: '2026-01-01T00:00:00.000Z', kind: 'set-firm-name' }, async () => {
    await store.setSetting(DEMO_TENANT, 'firm-name', 'Acme');
  });
  await run({ id: 'set-2', createdAt: '2026-01-02T00:00:00.000Z', kind: 'set-firm-name' }, async () => {
    await store.setSetting(DEMO_TENANT, 'firm-name', 'Globex');
  });

  await undoOperation(store, journal, 'set-2', { caller: ENGINEER });
  assert.equal(await store.getSetting(DEMO_TENANT, 'firm-name'), 'Acme', 'prior value restored');

  await undoOperation(store, journal, 'set-1', { caller: ENGINEER });
  assert.equal(await store.getSetting(DEMO_TENANT, 'firm-name'), undefined, 'created setting removed');
});

test('commit drops an operation that recorded nothing', async () => {
  const raw = new InMemoryGraphStore();
  const { journal, run } = harness(raw);
  await run({ kind: 'edit-entity' }, async () => {
    /* no mutations */
  });
  assert.equal(journal.list(DEMO_TENANT).length, 0, 'empty operation left no trace');
});

test('value semantics: an in-place edit of a read entity does not alias the before-image', async () => {
  // Guards the verify-flow bug: mutating what getEntity returned must not poison
  // the captured pre-operation state.
  const raw = new InMemoryGraphStore();
  const { store, journal, run } = harness(raw);
  await raw.upsertEntity({
    ...BASE,
    id: 'v',
    type: 'material',
    title: 'V',
    provenance: { ...BASE.provenance, reviewStatus: 'unverified' },
  });

  await run({ kind: 'verify-entity' }, async () => {
    const e = await store.getEntity(ENGINEER, 'v');
    e.provenance.reviewStatus = 'verified'; // in-place mutation of the returned copy
    await store.upsertEntity(e);
  });
  assert.equal((await store.getEntity(ENGINEER, 'v')).provenance.reviewStatus, 'verified');

  const opId = journal.list(DEMO_TENANT, 1)[0].id;
  await undoOperation(store, journal, opId, { caller: ENGINEER });
  assert.equal(
    (await store.getEntity(ENGINEER, 'v')).provenance.reviewStatus,
    'unverified',
    'undo reverts even though the action edited the read object in place',
  );
});

test('undo is rejected once already undone', async () => {
  const raw = new InMemoryGraphStore();
  const { store, journal, run } = harness(raw);
  await run({ id: 'op-1', kind: 'capture-knowledge' }, async () => {
    await store.upsertEntity({ ...BASE, id: 'q', type: 'project', title: 'Q' });
  });
  assert.ok((await undoOperation(store, journal, 'op-1', { caller: ENGINEER })).ok);
  const again = await undoOperation(store, journal, 'op-1', { caller: ENGINEER });
  assert.equal(again.ok, false);
  assert.match(again.reason, /already undone/i);
});

test('undo of a merge restores an edge whose far endpoint is hidden from the actor (P0-7 data-loss)', async () => {
  // The regression the journal-capture fix closes: the merge repoints every
  // touching edge regardless of caller visibility, so capturing only
  // caller-visible edges (the old neighbors-based path) lost a partially-visible
  // one and undo could not restore it.
  const raw = new InMemoryGraphStore();
  const { store, journal, run } = harness(raw);
  await raw.upsertEntity({ ...BASE, id: 'survivor', type: 'detail', title: 'Survivor' });
  await raw.upsertEntity({ ...BASE, id: 'dup', type: 'detail', title: 'Duplicate' });
  // A 'hidden' entity the merging curator (ENGINEER) cannot see, linked from dup.
  await raw.upsertEntity({
    ...BASE,
    id: 'hidden',
    type: 'standard',
    title: 'Hidden',
    acl: { allowedPrincipals: ['user:secret'] },
  });
  await raw.upsertRelationship({
    id: 'e1',
    tenantId: DEMO_TENANT,
    type: 'references',
    fromId: 'dup',
    toId: 'hidden',
  });

  // ENGINEER genuinely cannot see the edge — its far endpoint is hidden.
  assert.equal((await store.neighbors(ENGINEER, 'dup')).length, 0);

  await run({ kind: 'merge-entities', caller: ENGINEER }, async () => {
    await store.mergeEntities(ENGINEER, 'survivor', 'dup');
  });
  // The merge repointed the edge onto the survivor (visibility-independent).
  assert.equal((await raw.getRelationship(DEMO_TENANT, 'e1')).fromId, 'survivor');

  const opId = journal.list(DEMO_TENANT, 1)[0].id;
  const res = await undoOperation(store, journal, opId, { caller: ENGINEER });
  assert.ok(res.ok, res.reason);

  // Undo restored the edge to its EXACT pre-merge endpoints — not deleted it,
  // not left it repointed.
  const restored = await raw.getRelationship(DEMO_TENANT, 'e1');
  assert.ok(restored, 'edge to the hidden entity was restored, not lost');
  assert.equal(restored.fromId, 'dup');
  assert.equal(restored.toId, 'hidden');
});

test('same-millisecond operations order by insertion, not random id (undo-last hits the true latest)', async () => {
  // Production stamps each op a random UUID id + a millisecond createdAt, so two
  // ops in the same ms must NOT tie-break by id (that's random) — "undo last"
  // would otherwise target the wrong one. Ids are chosen so an id tie-break would
  // (wrongly) make the FIRST op newest.
  const raw = new InMemoryGraphStore();
  const { store, journal, run } = harness(raw);
  const SAME = '2026-06-25T00:00:00.000Z';
  await run({ id: 'zzz-first', createdAt: SAME, kind: 'capture-knowledge' }, async () => {
    await store.upsertEntity({ ...BASE, id: 'e-a', type: 'project', title: 'A' });
  });
  await run({ id: 'aaa-second', createdAt: SAME, kind: 'capture-knowledge' }, async () => {
    await store.upsertEntity({ ...BASE, id: 'e-b', type: 'project', title: 'B' });
  });
  assert.equal(
    journal.list(DEMO_TENANT, 1)[0].id,
    'aaa-second',
    'the later-inserted op is newest despite a lexicographically smaller id',
  );
});
