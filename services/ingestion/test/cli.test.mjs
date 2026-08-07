import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/**
 * The database must live outside the walked folder — the CLI creates
 * `ekg.db`/`-wal`/`-shm` as it runs, and a database written into the corpus
 * would be counted by the walk that is still enumerating it.
 */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'ekg-cli-'));
  return { dir, db: join(mkdtempSync(join(tmpdir(), 'ekg-cli-db-')), 'ekg.db') };
}

function corpus() {
  const ws = workspace();
  writeFileSync(join(ws.dir, 'lesson-parapet-flashing.md'), '# Parapet flashing\nSeal the counterflashing.\n');
  writeFileSync(join(ws.dir, 'notes.md'), '# Notes\nBacker rod one size up.\n');
  return ws;
}

/**
 * A folder the CLI is pointed at is not a folder it controls. An alias to a
 * moved folder, or a cloud-sync placeholder, leaves an entry that `readdir`
 * lists and `stat` cannot resolve — and an unhandled throw there abandoned the
 * whole walk, so every document after the bad entry went silently missing with
 * a partial write already committed. Found ingesting a real corpus whose
 * `2025-SSPs` alias pointed at a folder that had been moved.
 */
test('walk survives a dangling symlink and still ingests the rest', async () => {
  const { dir, db } = corpus();
  symlinkSync(join(dir, 'target-that-does-not-exist'), join(dir, '2025-SSPs'));
  try {
    const { stdout } = await run(process.execPath, [CLI, dir, '--db', db]);
    assert.match(stdout, /Ingested 2 candidate\(s\)/, 'both real documents ingested');
    assert.match(stdout, /1 unreadable entr/, 'the broken link is reported, not swallowed');
    assert.match(stdout, /2025-SSPs/, 'the report names the entry that was passed over');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a folder of only unsupported files ingests nothing and says so', async () => {
  const { dir, db } = workspace();
  writeFileSync(join(dir, 'archive.zip'), 'not a document');
  try {
    const { stdout } = await run(process.execPath, [CLI, dir, '--db', db]);
    assert.match(stdout, /Ingested 0 candidate\(s\)/);
    assert.match(stdout, /skipped 1 file\(s\) with unsupported extensions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
