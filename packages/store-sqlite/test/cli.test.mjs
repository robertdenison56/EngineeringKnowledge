import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DEMO_TENANT, seedDemo } from '@ekg/core';
import { LATEST_SCHEMA_VERSION, SqliteGraphStore } from '../dist/index.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const ENGINEER = { tenantId: DEMO_TENANT, principals: ['user:priya', 'group:engineering'] };

function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, EKG_DB_PATH: '' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function runJson(...args) {
  const r = run(...args, '--json');
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
}

test('ekg-db: status → backup → verify → damage → restore → status, end to end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ekg-cli-'));
  const db = join(dir, 'ekg.db');

  const missing = run('status', '--db', db);
  assert.equal(missing.code, 0);
  assert.match(missing.out, /does not exist yet/);

  const store = new SqliteGraphStore(db, { log: () => {} });
  await seedDemo(store);
  const entities = store.countEntities(DEMO_TENANT);
  store.close();

  const status = runJson('status', '--db', db);
  assert.equal(status.version, LATEST_SCHEMA_VERSION);
  assert.deepEqual(status.pending, []);
  assert.equal(status.counts.entities, entities);
  assert.equal(status.check, 'ok');
  assert.match(run('status', '--db', db).out, /up to date/);

  const backup = join(dir, 'backups', 'ekg.backup');
  const wrote = run('backup', backup, '--db', db);
  assert.equal(wrote.code, 0, wrote.err);
  assert.match(wrote.out, /verified: ok/);
  assert.ok(existsSync(backup));
  assert.equal(run('backup', backup, '--db', db).code, 1, 'never overwrites a backup');

  const verified = run('verify', backup);
  assert.equal(verified.code, 0, verified.err);
  assert.match(verified.out, /Verdict:\s+ok/);

  const damaged = new SqliteGraphStore(db, { log: () => {} });
  await damaged.deleteEntity(ENGINEER, 'detail:cw-firestop-02');
  damaged.close();
  assert.equal(runJson('status', '--db', db).counts.entities, entities - 1);

  const restored = run('restore', backup, '--db', db);
  assert.equal(restored.code, 0, restored.err);
  assert.match(restored.out, /previous contents kept at .*pre-restore/);
  assert.match(restored.out, /verified: ok/);
  assert.equal(runJson('status', '--db', db).counts.entities, entities);
});

test('ekg-db: migrate upgrades a pre-versioning file with a snapshot, then reports nothing to do', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ekg-cli-'));
  const db = join(dir, 'ekg.db');
  const legacy = new DatabaseSync(db);
  legacy.exec(`CREATE TABLE entities (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
    summary TEXT, properties TEXT NOT NULL, provenance TEXT NOT NULL, acl TEXT NOT NULL)`);
  legacy.close();
  assert.match(run('status', '--db', db).out, /v0 → pending: v1 baseline/);

  const upgraded = run('migrate', '--db', db);
  assert.equal(upgraded.code, 0, upgraded.err);
  assert.match(upgraded.out, new RegExp(`upgraded .*: v0 → v${LATEST_SCHEMA_VERSION}`));
  assert.match(upgraded.out, /pre-upgrade snapshot: .*\.v0-.*\.backup/);
  assert.match(upgraded.err, /ekg-db: upgraded/);

  const again = run('migrate', '--db', db);
  assert.equal(again.code, 0);
  assert.match(again.out, /already at schema v\d+ — nothing to do/);
});

test('ekg-db: refusals and usage exit non-zero with a reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ekg-cli-'));
  const garbage = join(dir, 'garbage.backup');
  writeFileSync(garbage, 'nope\n'.repeat(100));
  const bad = run('verify', garbage);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /Verdict:\s+FAILED/);

  const refused = run('restore', garbage, '--db', join(dir, 'ekg.db'));
  assert.equal(refused.code, 1);
  assert.match(refused.err, /refused \(backup_invalid\)/);

  assert.equal(run('frobnicate').code, 2);
  assert.equal(run('backup').code, 2, 'backup needs a destination');
});
