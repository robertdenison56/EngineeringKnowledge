import { mkdirSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Chunk, Entity } from '@ekg/core';

/**
 * Soft-delete for the curation workbench: Reject moves the candidate (entity
 * plus its document chunks) into an on-disk trash folder instead of losing it
 * outright, so a misclick is one "Restore" away. Files live under
 * `.data/trash/` next to the database (EKG_TRASH_DIR relocates); each record
 * is one JSON file keyed by the entity id.
 */
export interface TrashRecord {
  key: string;
  rejectedAt: string;
  rejectedBy: string;
  entity: Entity;
  chunks: Chunk[];
}

function trashDir(): string {
  return process.env.EKG_TRASH_DIR ?? path.join(process.cwd(), '.data', 'trash');
}

function keyFor(entityId: string): string {
  return encodeURIComponent(entityId);
}

export async function writeTrash(
  entity: Entity,
  chunks: Chunk[],
  rejectedBy: string,
): Promise<string> {
  const dir = trashDir();
  mkdirSync(dir, { recursive: true });
  const key = keyFor(entity.id);
  const record: Omit<TrashRecord, 'key'> = {
    rejectedAt: new Date().toISOString(),
    rejectedBy,
    entity,
    chunks,
  };
  await writeFile(path.join(dir, `${key}.json`), JSON.stringify(record));
  return key;
}

/** Most recently rejected first. Unreadable files are skipped, not fatal. */
export async function listTrash(limit = 10): Promise<TrashRecord[]> {
  let names: string[];
  try {
    names = (await readdir(trashDir())).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const records: TrashRecord[] = [];
  for (const name of names) {
    try {
      const raw = await readFile(path.join(trashDir(), name), 'utf8');
      records.push({ key: name.slice(0, -'.json'.length), ...(JSON.parse(raw) as Omit<TrashRecord, 'key'>) });
    } catch {
      /* skip corrupt record */
    }
  }
  records.sort((a, b) => b.rejectedAt.localeCompare(a.rejectedAt));
  return records.slice(0, limit);
}

export async function readTrash(key: string): Promise<TrashRecord | undefined> {
  // The key is a filename we minted; re-encode to refuse traversal input.
  const safe = keyFor(decodeURIComponent(key));
  try {
    const raw = await readFile(path.join(trashDir(), `${safe}.json`), 'utf8');
    return { key: safe, ...(JSON.parse(raw) as Omit<TrashRecord, 'key'>) };
  } catch {
    return undefined;
  }
}

export async function removeTrash(key: string): Promise<void> {
  const safe = keyFor(decodeURIComponent(key));
  await rm(path.join(trashDir(), `${safe}.json`), { force: true });
}
