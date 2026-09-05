import type { DatabaseSync } from 'node:sqlite';
import { normalizeText, type Chunk, type Entity } from '@ekg/core';
import { rowToChunk, rowToEntity, type ChunkRow, type EntityRow } from './rows.js';

/**
 * Version of the FTS *recipe*: what text an `entities_fts` / `chunks_fts` row is
 * built from ({@link ftsText} / {@link chunkFtsText}). Bump it whenever that
 * recipe changes. On its next open, every database indexed under the old
 * recipe rebuilds its FTS rows from source — so retrieval tuning reaches
 * existing installs instead of splitting quality between rows indexed before
 * and after the change. The on-open reconciliation (`reconcileFts`) cannot do
 * this: it only backfills *missing* rows and cannot tell a stale row from a
 * fresh one.
 *
 * A tokenizer change is different: the tokenizer is part of the virtual
 * table's DDL, so it needs a schema migration (drop + recreate the FTS table)
 * in schema.ts, followed by a bump here so the rows are rebuilt.
 */
export const FTS_RECIPE_VERSION = 1;

/** `schema_meta` key under which the recipe version a database was indexed with is kept. */
export const FTS_RECIPE_KEY = 'fts_recipe';

/** Raw + normalized text indexed by FTS5 so both spellings tokenize. */
export function ftsText(entity: Entity): string {
  const raw = [
    entity.title,
    entity.summary ?? '',
    (entity.aliases ?? []).join(' '),
    (entity.tags ?? []).join(' '),
    entity.content ?? '',
    JSON.stringify(entity.properties),
  ].join('\n');
  return `${raw}\n${normalizeText(raw)}`;
}

/** Raw + normalized chunk text indexed by FTS5 so both spellings tokenize. */
export function chunkFtsText(chunk: Chunk): string {
  const raw = `${chunk.heading ?? ''}\n${chunk.text}`;
  return `${raw}\n${normalizeText(raw)}`;
}

/**
 * Rebuild every FTS row from its source row under the current recipe. The
 * caller owns the transaction. Streams the source tables rather than loading
 * them, so a large corpus rebuilds in bounded memory.
 */
export function rebuildFts(db: DatabaseSync): { entities: number; chunks: number } {
  db.exec('DELETE FROM entities_fts');
  db.exec('DELETE FROM chunks_fts');
  let entities = 0;
  const insert = db.prepare('INSERT INTO entities_fts (id, tenant_id, text) VALUES (?, ?, ?)');
  for (const row of db.prepare('SELECT * FROM entities').iterate() as Iterable<EntityRow>) {
    insert.run(row.id, row.tenant_id, ftsText(rowToEntity(row)));
    entities += 1;
  }
  let chunks = 0;
  const insertChunk = db.prepare(
    'INSERT INTO chunks_fts (id, entity_id, tenant_id, text) VALUES (?, ?, ?, ?)',
  );
  for (const row of db.prepare('SELECT * FROM chunks').iterate() as Iterable<ChunkRow>) {
    insertChunk.run(row.id, row.entity_id, row.tenant_id, chunkFtsText(rowToChunk(row)));
    chunks += 1;
  }
  return { entities, chunks };
}
