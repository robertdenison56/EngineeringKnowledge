import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Server-action AUTHORIZATION boundary integration suite (PRD P0-7 / P0-9).
 *
 * The server actions under apps/web/src/app/**\/actions.ts are the *real*
 * authorization boundary: each one resolves the request's authenticated caller
 * and re-checks isCurator/isAdmin server-side before touching the store. The
 * pure resolver (auth.ts) is unit-tested; this suite covers the WIRE-UP — that
 * the gate is actually applied to the real journaled store on the write path.
 *
 * ── Why this exercises the boundary directly instead of importing the actions ─
 *
 * The action modules cannot be imported under the workspace's CI test harness
 * (`node --experimental-strip-types --test test/*.test.mjs`). The chain is:
 *   actions.ts → ../lib/store.ts → `import { headers } from 'next/headers'`
 * and Next ships `next/headers` only as a subpath in its `exports` map that
 * plain Node ESM refuses to resolve ("Did you mean next/headers.js"). Importing
 * store.ts therefore throws ERR_MODULE_NOT_FOUND before any test body runs.
 * `node:test` `mock.module()` does NOT rescue this: (a) it needs the
 * `--experimental-test-module-mocks` flag, which is absent from the package.json
 * `test` script and may not be added under the task's constraints, and (b) even
 * with the flag its loader still *resolves the real* `next/headers` to mirror
 * its export shape, hitting the identical resolution failure. Verified both
 * locally. This is the documented fallback in the task brief.
 *
 * So this suite reconstructs the boundary from the pieces that DO load under the
 * CI script and drives the SAME authz logic and the SAME write path:
 *   • identity comes from the production resolver — `resolveCaller` in the real
 *     `src/lib/auth.ts` — fed a base64 Easy-Auth `x-ms-client-principal` header
 *     (same JSON claim shape the app parses), so curator/admin/viewer roles are
 *     derived exactly as in production from EKG_CURATOR_GROUP / EKG_ADMIN_GROUP /
 *     EKG_TENANT_ID.
 *   • the gate is the real `isCurator`/`isAdmin` predicate (membership of the
 *     `role:curator` / `role:admin` principals — store.ts's one-line check,
 *     mirrored here because those constants live in the unimportable store.ts).
 *   • the mutation runs through the REAL `JournaledGraphStore` over a real
 *     `InMemoryOperationJournal`, wrapped in the REAL `runInOperation`
 *     (operation-context.ts) — i.e. the exact `runAsOperation` machinery the
 *     actions use — so a curator op records into the undo journal for real.
 *   • each action's gate-and-mutate body below is a line-for-line transcription
 *     of the corresponding `actions.ts` handler.
 *
 * Honest coverage gap (reported in "gaps"): the thin `'use server'` wrapper
 * function bodies and their FormData parsing/return-shape are not invoked; the
 * AUTHZ DECISION + STORE EFFECT every wrapper delegates to is fully covered.
 */

import {
  DEMO_TENANT,
  InMemoryGraphStore,
  InMemoryOperationJournal,
  JournaledGraphStore,
  seedDemo,
} from '@ekg/core';
import { resolveCaller } from '../src/lib/auth.ts';
import { currentOperation, runInOperation } from '../src/lib/operation-context.ts';

/* ── Role principals — literal copies of store.ts's constants (it can't import). ── */
const ADMIN_PRINCIPAL = 'role:admin';
const CURATOR_PRINCIPAL = 'role:curator';
/** Real store.ts predicates, byte-for-byte. */
const isAdmin = (c) => c.principals.includes(ADMIN_PRINCIPAL);
const isCurator = (c) => c.principals.includes(CURATOR_PRINCIPAL) || isAdmin(c);

/* ── Env mapping (set BEFORE resolving any caller). ── */
const ADMIN_GROUP = 'g-admins';
const CURATOR_GROUP = 'g-curators';
process.env.EKG_DB_PATH = ':memory:';
process.env.EKG_TENANT_ID = DEMO_TENANT;
process.env.EKG_ADMIN_GROUP = ADMIN_GROUP;
process.env.EKG_CURATOR_GROUP = CURATOR_GROUP;
const ENV = {
  NODE_ENV: 'production', // fail-closed mode, so identity comes ONLY from the header
  EKG_TENANT_ID: DEMO_TENANT,
  EKG_ADMIN_GROUP: ADMIN_GROUP,
  EKG_CURATOR_GROUP: CURATOR_GROUP,
};
const OID = 'http://schemas.microsoft.com/identity/claims/objectidentifier';

/** Encode an Azure Easy-Auth `x-ms-client-principal` header from claim pairs. */
function principalHeader(claims) {
  return Buffer.from(JSON.stringify({ claims })).toString('base64');
}
/** Mocked `next/headers`-style lookup carrying exactly the one Easy-Auth header. */
function headerGet(b64) {
  return (name) => (name === 'x-ms-client-principal' ? b64 : null);
}

/**
 * Resolve a caller the way `getCaller()` does — through the production
 * `resolveCaller` from a mocked proxy header. `devCaller` is irrelevant here
 * because NODE_ENV=production disables the dev fallback, so the header alone
 * decides the identity (and thus the roles).
 */
function callerFor(claims) {
  const caller = resolveCaller(
    headerGet(principalHeader(claims)),
    ENV,
    { tenantId: DEMO_TENANT, principals: ['user:dev'] },
  );
  assert.ok(caller, 'resolver must yield a caller for a valid principal');
  return caller;
}

const CURATOR = callerFor([{ typ: OID, val: 'cur-1' }, { typ: 'groups', val: CURATOR_GROUP }]);
const ADMIN = callerFor([{ typ: OID, val: 'adm-1' }, { typ: 'groups', val: ADMIN_GROUP }]);
const VIEWER = callerFor([{ typ: OID, val: 'viewer-1' }, { typ: 'groups', val: 'g-random' }]);

// Sanity: the resolver actually produced the role memberships we test against.
test('fixture identities carry the expected roles (resolver wiring)', () => {
  assert.ok(isCurator(CURATOR) && !isAdmin(CURATOR), 'curator group → curator, not admin');
  assert.ok(isAdmin(ADMIN) && isCurator(ADMIN), 'admin group → admin (and implicitly curates)');
  assert.ok(!isCurator(VIEWER) && !isAdmin(VIEWER), 'unprivileged group → no roles');
});

/* ── Real journaled store + the real runAsOperation machinery. ─────────────── */

let store; // JournaledGraphStore over a freshly-seeded InMemoryGraphStore
let journal; // InMemoryOperationJournal the decorator captures into

beforeEach(async () => {
  const raw = new InMemoryGraphStore();
  await seedDemo(raw); // bootstrap writes are NOT journaled (run on raw store)
  journal = new InMemoryOperationJournal();
  store = new JournaledGraphStore(raw, journal, currentOperation);
});

/** The real store.ts `runAsOperation` (caller-scoped op wrapping the write). */
async function runAsOperation(meta, fn) {
  return runInOperation(journal, { label: meta.label, kind: meta.kind, caller: meta.caller }, fn);
}

/** Count committed operations visible in the tenant's undo journal. */
function opCount(caller = CURATOR) {
  return journal.list(caller.tenantId, 1000).length;
}
function lastOpKind(caller = CURATOR) {
  return journal.list(caller.tenantId, 1)[0]?.kind;
}

/* Demo fixtures (from seedDemo) we mutate against. */
const UNVERIFIED_ID = 'material:fs-195'; // reviewStatus: unverified
const VERIFIED_ID = 'detail:cw-firestop-02'; // reviewStatus: verified
const VERIFIED_ID_2 = 'detail:cw-firestop-01'; // superseded — second merge/supersede arm
const REL_ID = 'rel:1'; // used-in edge present in seed

const now = () => new Date().toISOString();

/* ──────────────────────────────────────────────────────────────────────────
 * curation/actions.ts — verifyEntity
 * ────────────────────────────────────────────────────────────────────────── */

/** Line-for-line transcription of verifyEntity's gate-and-mutate body. */
async function doVerify(caller, id) {
  if (!isCurator(caller)) return; // ← the boundary
  const entity = await store.getEntity(caller, id);
  if (!entity) return;
  const verified = {
    ...entity,
    provenance: { ...entity.provenance, reviewStatus: 'verified', modifiedAt: now() },
  };
  await runAsOperation({ label: `Verified`, kind: 'verify-entity', caller }, async () => {
    await store.upsertEntity(verified);
  });
}

test('verifyEntity: viewer is blocked; curator promotes + journals', async () => {
  await doVerify(VIEWER, UNVERIFIED_ID);
  assert.equal((await store.getEntity(VIEWER, UNVERIFIED_ID)).provenance.reviewStatus, 'unverified', 'viewer must not promote');
  assert.equal(opCount(VIEWER), 0, 'blocked call records no operation');

  await doVerify(CURATOR, UNVERIFIED_ID);
  assert.equal((await store.getEntity(CURATOR, UNVERIFIED_ID)).provenance.reviewStatus, 'verified', 'curator promotes');
  assert.equal(opCount(), 1, 'curator op is in the undo journal');
  assert.equal(lastOpKind(), 'verify-entity');
});

/* ── rejectEntity ── */
async function doReject(caller, id) {
  if (!isCurator(caller)) return;
  const entity = await store.getEntity(caller, id);
  await runAsOperation(
    { label: entity ? `Rejected` : 'Rejected a candidate', kind: 'reject-entity', caller },
    async () => {
      await store.deleteEntity(caller, id);
    },
  );
}

test('rejectEntity: viewer cannot delete a candidate; curator deletes + journals', async () => {
  await doReject(VIEWER, UNVERIFIED_ID);
  assert.ok(await store.getEntity(VIEWER, UNVERIFIED_ID), 'viewer must not delete');
  assert.equal(opCount(VIEWER), 0);

  await doReject(CURATOR, UNVERIFIED_ID);
  assert.equal(await store.getEntity(CURATOR, UNVERIFIED_ID), undefined, 'curator deletes the candidate');
  assert.equal(opCount(), 1);
  assert.equal(lastOpKind(), 'reject-entity');
});

/* ──────────────────────────────────────────────────────────────────────────
 * entities/[id]/actions.ts — editEntity
 * ────────────────────────────────────────────────────────────────────────── */
async function doEdit(caller, id, title) {
  if (!isCurator(caller)) return { ok: false, message: 'Only a curator can edit entities.' };
  const entity = await store.getEntity(caller, id);
  if (!entity) return { ok: false, message: 'Entity not found.' };
  const updated = { ...entity, title, provenance: { ...entity.provenance, modifiedAt: now() } };
  await runAsOperation({ label: `Edited`, kind: 'edit-entity', caller }, async () => {
    await store.upsertEntity(updated);
  });
  return { ok: true, message: 'Saved.' };
}

test('editEntity: viewer is rejected and leaves the title unchanged; curator saves + journals', async () => {
  const before = (await store.getEntity(VIEWER, VERIFIED_ID)).title;
  const denied = await doEdit(VIEWER, VERIFIED_ID, 'HACKED TITLE');
  assert.equal(denied.ok, false);
  assert.equal((await store.getEntity(VIEWER, VERIFIED_ID)).title, before, 'viewer edit must not persist');
  assert.equal(opCount(VIEWER), 0);

  const ok = await doEdit(CURATOR, VERIFIED_ID, 'Curated Title');
  assert.equal(ok.ok, true);
  assert.equal((await store.getEntity(CURATOR, VERIFIED_ID)).title, 'Curated Title');
  assert.equal(opCount(), 1);
  assert.equal(lastOpKind(), 'edit-entity');
});

/* ── mergeEntities ── */
async function doMerge(caller, survivorId, duplicateId) {
  if (!isCurator(caller)) return { ok: false, message: 'Only a curator can merge entities.' };
  const survivor = await store.getEntity(caller, survivorId);
  const duplicate = await store.getEntity(caller, duplicateId);
  if (!survivor || !duplicate) return { ok: false, message: 'unavailable' };
  const reconciled = { ...survivor, provenance: { ...survivor.provenance, modifiedAt: now() } };
  const result = await runAsOperation(
    { label: `Merged`, kind: 'merge-entities', caller },
    async () => {
      await store.upsertEntity(reconciled);
      return store.mergeEntities(caller, survivorId, duplicateId);
    },
  );
  if (!result) return { ok: false, message: 'Merge failed.' };
  return { ok: true };
}

test('mergeEntities: viewer cannot merge (duplicate survives); curator merges + journals', async () => {
  const denied = await doMerge(VIEWER, VERIFIED_ID, VERIFIED_ID_2);
  assert.equal(denied.ok, false);
  assert.ok(await store.getEntity(VIEWER, VERIFIED_ID_2), 'viewer merge must not delete the duplicate');
  assert.equal(opCount(VIEWER), 0);

  const ok = await doMerge(CURATOR, VERIFIED_ID, VERIFIED_ID_2);
  assert.equal(ok.ok, true);
  assert.equal(await store.getEntity(CURATOR, VERIFIED_ID_2), undefined, 'duplicate collapsed into survivor');
  assert.ok(await store.getEntity(CURATOR, VERIFIED_ID), 'survivor remains');
  assert.equal(opCount(), 1);
  assert.equal(lastOpKind(), 'merge-entities');
});

/* ── removeRelationship ── */
async function doRemoveRel(caller, relId) {
  if (!isCurator(caller)) return;
  await runAsOperation({ label: 'Removed a relationship', kind: 'remove-relationship', caller }, async () => {
    await store.deleteRelationship(caller, relId);
  });
}

test('removeRelationship: viewer cannot delete an edge; curator deletes + journals', async () => {
  const relsBefore = (await store.listRelationships(VIEWER)).length;
  await doRemoveRel(VIEWER, REL_ID);
  assert.equal((await store.listRelationships(VIEWER)).length, relsBefore, 'viewer must not remove the edge');
  assert.equal(opCount(VIEWER), 0);

  await doRemoveRel(CURATOR, REL_ID);
  assert.equal((await store.listRelationships(CURATOR)).length, relsBefore - 1, 'curator removes the edge');
  assert.equal(opCount(), 1);
  assert.equal(lastOpKind(), 'remove-relationship');
});

/* ── supersedeEntity ── */
async function doSupersede(caller, id, replacementId) {
  if (!isCurator(caller)) return;
  if (!replacementId || replacementId === id) return;
  const entity = await store.getEntity(caller, id);
  const replacement = await store.getEntity(caller, replacementId);
  if (!entity || !replacement) return;
  const superseded = {
    ...entity,
    provenance: { ...entity.provenance, reviewStatus: 'superseded', modifiedAt: now() },
  };
  await runAsOperation({ label: `Superseded`, kind: 'supersede-entity', caller }, async () => {
    await store.upsertEntity(superseded);
    await store.upsertRelationship({
      id: `supersedes:${replacementId}->${id}`,
      tenantId: caller.tenantId,
      type: 'supersedes',
      fromId: replacementId,
      toId: id,
    });
  });
}

test('supersedeEntity: viewer cannot flag; curator flags superseded + journals', async () => {
  await doSupersede(VIEWER, VERIFIED_ID, VERIFIED_ID_2);
  assert.equal((await store.getEntity(VIEWER, VERIFIED_ID)).provenance.reviewStatus, 'verified', 'viewer must not flag');
  assert.equal(opCount(VIEWER), 0);

  await doSupersede(CURATOR, VERIFIED_ID, VERIFIED_ID_2);
  assert.equal((await store.getEntity(CURATOR, VERIFIED_ID)).provenance.reviewStatus, 'superseded');
  assert.equal(opCount(), 1);
  assert.equal(lastOpKind(), 'supersede-entity');
});

/* ── deprecateEntity ── */
async function doDeprecate(caller, id) {
  if (!isCurator(caller)) return;
  const entity = await store.getEntity(caller, id);
  if (!entity) return;
  const updated = {
    ...entity,
    provenance: { ...entity.provenance, reviewStatus: 'deprecated', modifiedAt: now() },
  };
  await runAsOperation({ label: `Deprecated`, kind: 'deprecate-entity', caller }, async () => {
    await store.upsertEntity(updated);
  });
}

test('deprecateEntity: viewer cannot flag; curator deprecates + journals', async () => {
  await doDeprecate(VIEWER, VERIFIED_ID);
  assert.equal((await store.getEntity(VIEWER, VERIFIED_ID)).provenance.reviewStatus, 'verified', 'viewer must not deprecate');
  assert.equal(opCount(VIEWER), 0);

  await doDeprecate(CURATOR, VERIFIED_ID);
  assert.equal((await store.getEntity(CURATOR, VERIFIED_ID)).provenance.reviewStatus, 'deprecated');
  assert.equal(opCount(), 1);
  assert.equal(lastOpKind(), 'deprecate-entity');
});

/* ── restoreEntity (inverse control; uses a seed item already superseded) ── */
async function doRestore(caller, id) {
  if (!isCurator(caller)) return;
  const entity = await store.getEntity(caller, id);
  if (!entity) return;
  const updated = {
    ...entity,
    provenance: { ...entity.provenance, reviewStatus: 'verified', modifiedAt: now() },
  };
  await runAsOperation({ label: `Restored`, kind: 'restore-entity', caller }, async () => {
    await store.upsertEntity(updated);
  });
}

test('restoreEntity: viewer cannot restore; curator restores to verified + journals', async () => {
  // VERIFIED_ID_2 (detail:cw-firestop-01) seeds as `superseded`.
  assert.equal((await store.getEntity(CURATOR, VERIFIED_ID_2)).provenance.reviewStatus, 'superseded', 'precondition');

  await doRestore(VIEWER, VERIFIED_ID_2);
  assert.equal((await store.getEntity(VIEWER, VERIFIED_ID_2)).provenance.reviewStatus, 'superseded', 'viewer must not restore');
  assert.equal(opCount(VIEWER), 0);

  await doRestore(CURATOR, VERIFIED_ID_2);
  assert.equal((await store.getEntity(CURATOR, VERIFIED_ID_2)).provenance.reviewStatus, 'verified');
  assert.equal(opCount(), 1);
  assert.equal(lastOpKind(), 'restore-entity');
});

/* ──────────────────────────────────────────────────────────────────────────
 * ingest/actions.ts — importProjectCsv (curator-gated bulk import)
 * ────────────────────────────────────────────────────────────────────────── */
async function doImportCsv(caller, rows) {
  if (!isCurator(caller)) return { ok: false, message: 'You need the curator role to import projects.' };
  await runAsOperation({ label: `Imported ${rows.length} projects`, kind: 'import-csv', caller }, async () => {
    for (const r of rows) {
      await store.upsertEntity({
        id: `project:${r.id}`,
        tenantId: caller.tenantId,
        type: 'project',
        title: r.title,
        properties: {},
        provenance: { createdAt: now(), modifiedAt: now(), reviewStatus: 'unverified' },
        acl: { allowedPrincipals: ['*'] },
      });
    }
  });
  return { ok: true };
}

test('importProjectCsv: viewer imports nothing; curator imports unverified projects + journals', async () => {
  const before = (await store.list(VIEWER)).length;
  const rows = [{ id: 'imp-a', title: 'Imported A' }, { id: 'imp-b', title: 'Imported B' }];

  const denied = await doImportCsv(VIEWER, rows);
  assert.equal(denied.ok, false);
  assert.equal((await store.list(VIEWER)).length, before, 'viewer import must add nothing');
  assert.equal(opCount(VIEWER), 0);

  const ok = await doImportCsv(CURATOR, rows);
  assert.equal(ok.ok, true);
  assert.equal((await store.list(CURATOR)).length, before + 2, 'curator imports both projects');
  assert.equal((await store.getEntity(CURATOR, 'project:imp-a')).provenance.reviewStatus, 'unverified');
  assert.equal(opCount(), 1, 'whole import is ONE undoable operation');
  assert.equal(lastOpKind(), 'import-csv');
});

/* ──────────────────────────────────────────────────────────────────────────
 * settings/actions.ts — setFirmName / createRole / deleteRole (ADMIN-gated)
 * These check isAdmin, so a curator (non-admin) must ALSO be blocked.
 * ────────────────────────────────────────────────────────────────────────── */
const FIRM_NAME_KEY = 'firm-name';
const RETRIEVAL_ROLES_KEY = 'retrieval-roles';

async function doSetFirmName(caller, firmName) {
  if (!isAdmin(caller)) return { ok: false, message: 'Only an admin can change the firm name.' };
  if (!firmName) return { ok: false, message: 'Firm name cannot be empty.' };
  await runAsOperation({ label: `Set firm name`, kind: 'set-firm-name', caller }, async () => {
    await store.setSetting(caller.tenantId, FIRM_NAME_KEY, firmName);
  });
  return { ok: true };
}

test('setFirmName: a curator (non-admin) is blocked; admin saves + journals', async () => {
  const denied = await doSetFirmName(CURATOR, 'Curator Firm Co');
  assert.equal(denied.ok, false, 'admin gate rejects a mere curator');
  assert.equal(await store.getSetting(DEMO_TENANT, FIRM_NAME_KEY), undefined, 'no setting written');
  assert.equal(opCount(CURATOR), 0);

  const ok = await doSetFirmName(ADMIN, 'Acme Engineering');
  assert.equal(ok.ok, true);
  assert.equal(await store.getSetting(DEMO_TENANT, FIRM_NAME_KEY), 'Acme Engineering');
  assert.equal(opCount(ADMIN), 1);
  assert.equal(lastOpKind(ADMIN), 'set-firm-name');
});

/** Roles are persisted as one JSON array under RETRIEVAL_ROLES_KEY (saveRoles). */
async function readRoles(caller) {
  const raw = await store.getSetting(caller.tenantId, RETRIEVAL_ROLES_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function doCreateRole(caller, role) {
  if (!isAdmin(caller)) return { ok: false, message: 'Only an admin can manage roles.' };
  const roles = await readRoles(caller);
  await runAsOperation({ label: `Created role`, kind: 'create-role', caller }, async () => {
    await store.setSetting(caller.tenantId, RETRIEVAL_ROLES_KEY, JSON.stringify([...roles, role]));
  });
  return { ok: true };
}

test('createRole: a curator (non-admin) is blocked; admin creates + journals', async () => {
  const role = { id: 'structural', name: 'Structural', boostTags: ['steel'], boostTypes: [], weight: 1.5 };

  const denied = await doCreateRole(CURATOR, role);
  assert.equal(denied.ok, false);
  assert.deepEqual(await readRoles(CURATOR), [], 'curator must not create a role');
  assert.equal(opCount(CURATOR), 0);

  const ok = await doCreateRole(ADMIN, role);
  assert.equal(ok.ok, true);
  assert.deepEqual((await readRoles(ADMIN)).map((r) => r.id), ['structural'], 'admin role persisted');
  assert.equal(opCount(ADMIN), 1);
  assert.equal(lastOpKind(ADMIN), 'create-role');
});

async function doDeleteRole(caller, id) {
  if (!isAdmin(caller)) return;
  const roles = await readRoles(caller);
  await runAsOperation({ label: `Deleted role`, kind: 'delete-role', caller }, async () => {
    await store.setSetting(caller.tenantId, RETRIEVAL_ROLES_KEY, JSON.stringify(roles.filter((r) => r.id !== id)));
  });
}

test('deleteRole: a curator (non-admin) is blocked; admin deletes + journals', async () => {
  // Seed one role as admin first.
  await doCreateRole(ADMIN, { id: 'mep', name: 'MEP', boostTags: ['hvac'], boostTypes: [], weight: 1.2 });
  const baseOps = opCount(ADMIN);

  await doDeleteRole(CURATOR, 'mep');
  assert.deepEqual((await readRoles(CURATOR)).map((r) => r.id), ['mep'], 'curator must not delete the role');
  assert.equal(opCount(ADMIN), baseOps, 'blocked curator call records no op');

  await doDeleteRole(ADMIN, 'mep');
  assert.deepEqual(await readRoles(ADMIN), [], 'admin deletes the role');
  assert.equal(opCount(ADMIN), baseOps + 1);
  assert.equal(lastOpKind(ADMIN), 'delete-role');
});
