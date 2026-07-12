import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FolderConnector,
  buildCandidate,
  contentVersion,
  planSync,
} from '../dist/index.js';

// --- change detection (the testable core of scheduled SharePoint sync) ---

function item(id, version) {
  return { id, name: `${id}.txt`, version, meta: { system: 'folder' }, read: async () => new Uint8Array() };
}

test('planSync — first sync treats everything as added', () => {
  const plan = planSync([item('a', 'v1'), item('b', 'v1')], {});
  assert.deepEqual(plan.added.map((i) => i.id), ['a', 'b']);
  assert.equal(plan.changed.length, 0);
  assert.equal(plan.unchanged.length, 0);
  assert.deepEqual(plan.removed, []);
  assert.deepEqual(plan.nextManifest, { a: 'v1', b: 'v1' });
});

test('planSync — re-sync skips unchanged, re-ingests changed, reports removed', () => {
  const manifest = { a: 'v1', b: 'v1', c: 'v1' };
  // a unchanged, b's content moved, c is gone, d is new.
  const plan = planSync([item('a', 'v1'), item('b', 'v2'), item('d', 'v1')], manifest);
  assert.deepEqual(plan.unchanged.map((i) => i.id), ['a'], 'unchanged item skipped');
  assert.deepEqual(plan.changed.map((i) => i.id), ['b'], 'version bump ⇒ re-ingest');
  assert.deepEqual(plan.added.map((i) => i.id), ['d'], 'new item added');
  assert.deepEqual(plan.removed, ['c'], 'vanished item reported, never auto-deleted');
  assert.deepEqual(plan.nextManifest, { a: 'v1', b: 'v2', d: 'v1' });
});

test('contentVersion changes iff bytes change', () => {
  const a = contentVersion(new Uint8Array([1, 2, 3]));
  assert.equal(a, contentVersion(new Uint8Array([1, 2, 3])), 'stable for identical bytes');
  assert.notEqual(a, contentVersion(new Uint8Array([1, 2, 4])), 'differs when content differs');
});

test('FolderConnector lists known files with content-hash versions; planSync drives an incremental re-sync', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ekg-folder-'));
  try {
    writeFileSync(join(dir, 'one.txt'), 'first');
    writeFileSync(join(dir, 'two.md'), '# second');
    writeFileSync(join(dir, 'skip.bin'), 'ignored'); // unsupported extension

    const connector = new FolderConnector(dir, 'Test library');
    assert.equal(connector.system, 'folder');
    const first = await connector.list();
    assert.deepEqual(
      first.map((i) => i.name).sort(),
      ['one.txt', 'two.md'],
      'only known extensions are listed',
    );
    assert.ok(first[0].meta.sourceUrl?.startsWith('file://'), 'item carries a deep link');

    const plan1 = planSync(first, {});
    assert.equal(plan1.added.length, 2);

    // Edit one file; the next sync should re-ingest only it.
    writeFileSync(join(dir, 'one.txt'), 'first, edited');
    const second = await connector.list();
    const plan2 = planSync(second, plan1.nextManifest);
    assert.deepEqual(plan2.changed.map((i) => i.name), ['one.txt']);
    assert.deepEqual(plan2.unchanged.map((i) => i.name), ['two.md']);
    assert.equal(plan2.added.length, 0);

    // The bytes a connector hands buildCandidate are the real file content.
    const edited = second.find((i) => i.name === 'one.txt');
    assert.equal(Buffer.from(await edited.read()).toString(), 'first, edited');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- source-ACL + provenance capture threaded into buildCandidate (P0-2) ---

test('buildCandidate without source keeps the tenant-public, file:// defaults', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ekg-src-'));
  try {
    const fp = join(dir, 'note.md');
    writeFileSync(fp, '# A plain note about firestop joints');
    const c = await buildCandidate(fp, { tenantId: 't', pipeline: 'test' });
    assert.deepEqual(c.entity.acl.allowedPrincipals, ['*'], 'defaults tenant-public');
    assert.ok(c.entity.provenance.sourceUrl.startsWith('file://'));
    assert.equal(c.entity.provenance.sourceSystem, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildCandidate captures source-system permissions, deep link, author, and mtime as item metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ekg-src-'));
  try {
    const fp = join(dir, 'legal-memo.md');
    writeFileSync(fp, '# Confidential settlement terms');
    const c = await buildCandidate(fp, {
      tenantId: 't',
      pipeline: 'test',
      source: {
        system: 'sharepoint',
        sourceUrl: 'https://firm.sharepoint.com/legal/memo.docx',
        acl: { allowedPrincipals: ['group:legal'] },
        author: 'Dana Okafor',
        modifiedAt: '2026-01-15T00:00:00.000Z',
      },
    });
    // Source-system permission became the item ACL — not tenant-public.
    assert.deepEqual(c.entity.acl.allowedPrincipals, ['group:legal']);
    assert.equal(c.entity.provenance.sourceUrl, 'https://firm.sharepoint.com/legal/memo.docx');
    assert.equal(c.entity.provenance.sourceSystem, 'sharepoint');
    assert.equal(c.entity.provenance.author, 'Dana Okafor');
    assert.equal(c.entity.provenance.modifiedAt, '2026-01-15T00:00:00.000Z');
    // Still queued for curation regardless of source.
    assert.equal(c.entity.provenance.reviewStatus, 'unverified');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
