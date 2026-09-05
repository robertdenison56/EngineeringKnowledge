#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SchemaError,
  SqliteGraphStore,
  backupDatabase,
  inspectDatabase,
  restoreDatabase,
  verifyDatabase,
  type SchemaStatus,
} from './index.js';

/**
 * `ekg-db` — the database lifecycle for operators (ADR 0012): see where a
 * database stands, upgrade it deliberately, take a snapshot that is safe
 * while the app and gateway run, verify any file, and rehearse a restore.
 */
const USAGE = `Usage: ekg-db <command> [options]

  status  [--db <path>] [--json]       Schema version, pending migrations, ledger, row counts, quick integrity check (read-only)
  migrate [--db <path>] [--no-backup]  Apply pending migrations now; a pre-upgrade snapshot is written next to the database first
  backup  <dest> [--db <path>]         Consistent snapshot of the database, then verified — safe while the app and gateway are running
  verify  <file> [--json]              Full integrity check of a database or backup file (read-only)
  restore <backup> [--db <path>]       Rehearsed restore: verify the backup, snapshot the live file, swap in, migrate forward, verify

--db defaults to $EKG_DB_PATH, else .data/ekg.db under the directory npm was invoked from.
Exit status: 0 ok · 1 problem found or refused · 2 usage.`;

const args = process.argv.slice(2);
const command = args[0];
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional: string[] = [];
for (let i = 1; i < args.length; i += 1) {
  const a = args[i]!;
  if (a === '--db') i += 1;
  else if (!a.startsWith('--')) positional.push(a);
}

function flagValue(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

// npm workspace scripts run with cwd inside the package; INIT_CWD is where the
// user actually invoked npm, so documented relative paths work.
const baseDir = process.env.INIT_CWD ?? process.cwd();
const dbPath = resolve(baseDir, flagValue('db') ?? process.env.EKG_DB_PATH ?? resolve('.data', 'ekg.db'));
const json = flags.has('--json');
const log = (message: string) => console.error(`ekg-db: ${message}`);

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function printStatus(status: SchemaStatus, checkLabel: string): void {
  if (!status.exists) {
    console.log(`Database: ${status.path} — does not exist yet (created and initialized at v${status.latest} on first open)`);
    return;
  }
  console.log(`Database: ${status.path} (${human(statSync(status.path).size)})`);
  const schema = status.tooNew
    ? `v${status.version} — NEWER than this build (v${status.latest}); upgrade the software or restore the pre-upgrade snapshot`
    : status.pending.length > 0
      ? `v${status.version} → pending: ${status.pending.map((m) => `v${m.version} ${m.name}`).join(', ')} (applied on next open, or run: ekg-db migrate)`
      : `v${status.version} (latest) — up to date`;
  console.log(`Schema:   ${schema}`);
  const recipe =
    status.ftsRecipe === null
      ? 'unversioned (rebuilt on next open)'
      : status.ftsRecipe === status.ftsRecipeLatest
        ? `recipe v${status.ftsRecipe} (current)`
        : `recipe v${status.ftsRecipe} → v${status.ftsRecipeLatest} (rebuilt on next open)`;
  console.log(`FTS:      ${recipe}${status.ftsInvariant === false ? ' · index out of step with source rows (healed on next open)' : ''}`);
  const counts = Object.entries(status.counts).map(([t, n]) => `${t} ${n}`);
  if (counts.length > 0) console.log(`Rows:     ${counts.join(' · ')}`);
  console.log(`Check:    ${Array.isArray(status.check) ? `FAILED — ${status.check.join('; ')}` : status.check} (${checkLabel})`);
  if (status.ledger.length > 0) {
    console.log('Ledger:');
    for (const m of status.ledger) console.log(`  v${m.version} ${m.name.padEnd(12)} ${m.appliedAt}  ${m.durationMs} ms`);
  }
}

function main(): number {
  switch (command) {
    case 'status': {
      const status = inspectDatabase(dbPath);
      if (json) console.log(JSON.stringify(status, null, 2));
      else printStatus(status, 'quick_check');
      return status.exists && (status.tooNew || status.check !== 'ok') ? 1 : 0;
    }
    case 'migrate': {
      const before = inspectDatabase(dbPath);
      if (before.exists && before.pending.length === 0 && !before.tooNew) {
        console.log(`${dbPath} is already at schema v${before.version} — nothing to do`);
      }
      const store = new SqliteGraphStore(dbPath, {
        migrate: 'auto',
        backupOnMigrate: !flags.has('--no-backup'),
        log,
      });
      const { migration } = store;
      store.close();
      if (json) console.log(JSON.stringify(migration, null, 2));
      else if (migration.applied.length > 0) {
        console.log(
          `${before.exists ? 'upgraded' : 'initialized'} ${dbPath}: v${migration.from} → v${migration.to} ` +
            `(${migration.applied.map((m) => `v${m.version} ${m.name}, ${m.durationMs} ms`).join('; ')})`,
        );
        if (migration.backupPath) console.log(`pre-upgrade snapshot: ${migration.backupPath}`);
      }
      return 0;
    }
    case 'backup': {
      const dest = positional[0];
      if (!dest) usage();
      if (!existsSync(dbPath)) throw new SchemaError('not_found', `no database at ${dbPath}`);
      const target = resolve(baseDir, dest);
      const source = new DatabaseSync(dbPath, { readOnly: true });
      let written;
      try {
        written = backupDatabase(source, target);
      } finally {
        source.close();
      }
      const check = verifyDatabase(target);
      if (json) console.log(JSON.stringify({ ...written, verify: check }, null, 2));
      else {
        console.log(`wrote ${written.path} (${human(written.bytes)})`);
        console.log(check.ok ? 'verified: ok' : `verified: FAILED — ${check.problems.join('; ')}`);
      }
      return check.ok ? 0 : 1;
    }
    case 'verify': {
      const file = positional[0];
      if (!file) usage();
      const result = verifyDatabase(resolve(baseDir, file));
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        printStatus(result.status, 'integrity_check');
        console.log(result.ok ? 'Verdict:  ok' : `Verdict:  FAILED\n  - ${result.problems.join('\n  - ')}`);
      }
      return result.ok ? 0 : 1;
    }
    case 'restore': {
      const backup = positional[0];
      if (!backup) usage();
      const result = restoreDatabase(resolve(baseDir, backup), dbPath, { log });
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`restored ${dbPath} from ${result.restoredFrom}`);
        if (result.preRestoreBackup) console.log(`previous contents kept at ${result.preRestoreBackup}`);
        if (result.migration.applied.length > 0) {
          console.log(`migrated forward: v${result.migration.from} → v${result.migration.to}`);
        }
        const c = result.verify.status.counts;
        console.log(`verified: ok (schema v${result.verify.status.version}; entities ${c.entities ?? 0}, chunks ${c.chunks ?? 0})`);
      }
      return 0;
    }
    default:
      usage();
  }
}

try {
  process.exitCode = main();
} catch (err) {
  if (err instanceof SchemaError) {
    console.error(`ekg-db: refused (${err.code}): ${err.message}`);
  } else {
    console.error(`ekg-db: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exitCode = 1;
}
