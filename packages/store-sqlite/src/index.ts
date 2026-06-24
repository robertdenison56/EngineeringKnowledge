import { DatabaseSync } from 'node:sqlite';
import {
  buildQueryGroups,
  canRead,
  chunkEmbeddingText,
  cosineSimilarity,
  embeddingText,
  matchesTagFilter,
  normalizeText,
  scoreEntityMatch,
  snippetForGroups,
  warningFor,
  type Caller,
  type Chunk,
  type ChunkMatch,
  type EmbeddingProvider,
  type Entity,
  type GraphStore,
  type NeighborHit,
  type Relationship,
  type RelationshipType,
  type SearchHit,
  type SearchOptions,
} from '@ekg/core';

export { providerFromEnv } from './providers.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  properties TEXT NOT NULL,
  tags TEXT,
  aliases TEXT,
  content TEXT,
  embedding TEXT,
  embedding_provider TEXT,
  provenance TEXT NOT NULL,
  acl TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_tenant_type ON entities(tenant_id, type);
CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  properties TEXT
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON relationships(from_id);
CREATE INDEX IF NOT EXISTS idx_rel_to ON relationships(to_id);
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  id UNINDEXED, tenant_id UNINDEXED, text,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  anchor TEXT,
  heading TEXT,
  text TEXT NOT NULL,
  embedding TEXT,
  embedding_provider TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_entity ON chunks(entity_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  id UNINDEXED, entity_id UNINDEXED, tenant_id UNINDEXED, text,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS settings (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
`;

interface EntityRow {
  id: string;
  tenant_id: string;
  type: string;
  title: string;
  summary: string | null;
  properties: string;
  tags: string | null;
  aliases: string | null;
  content: string | null;
  embedding: string | null;
  embedding_provider: string | null;
  provenance: string;
  acl: string;
}

interface RelationshipRow {
  id: string;
  tenant_id: string;
  type: string;
  from_id: string;
  to_id: string;
  properties: string | null;
}

interface ChunkRow {
  id: string;
  entity_id: string;
  tenant_id: string;
  ordinal: number;
  anchor: string | null;
  heading: string | null;
  text: string;
  embedding: string | null;
  embedding_provider: string | null;
}

function rowToChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    entityId: row.entity_id,
    tenantId: row.tenant_id,
    ordinal: row.ordinal,
    anchor: row.anchor ? JSON.parse(row.anchor) : {},
    text: row.text,
    ...(row.heading ? { heading: row.heading } : {}),
  };
}

/** Raw + normalized chunk text indexed by FTS5 so both spellings tokenize. */
function chunkFtsText(chunk: Chunk): string {
  const raw = `${chunk.heading ?? ''}\n${chunk.text}`;
  return `${raw}\n${normalizeText(raw)}`;
}

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    title: row.title,
    summary: row.summary ?? undefined,
    properties: JSON.parse(row.properties),
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    aliases: row.aliases ? JSON.parse(row.aliases) : undefined,
    content: row.content ?? undefined,
    provenance: JSON.parse(row.provenance),
    acl: JSON.parse(row.acl),
  };
}

function rowToRelationship(row: RelationshipRow): Relationship {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    fromId: row.from_id,
    toId: row.to_id,
    properties: row.properties ? JSON.parse(row.properties) : undefined,
  };
}

/** Raw + normalized text indexed by FTS5 so both spellings tokenize. */
function ftsText(entity: Entity): string {
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

/** FTS5 MATCH expression mirroring the AND-across/OR-within group contract. */
function ftsQuery(groups: string[][]): string {
  return groups
    .map((g) => `(${g.map((v) => `"${v.replace(/"/g, '')}"`).join(' OR ')})`)
    .join(' AND ');
}

const RRF_K = 60;

export interface SqliteStoreOptions {
  /** Optional dense-retrieval provider; lexical-only without it. */
  embeddings?: EmbeddingProvider;
}

/**
 * Persistent GraphStore on SQLite via the Node built-in driver — no native
 * dependencies. Retrieval is hybrid: shared lexical matcher + FTS5 BM25,
 * fused with reciprocal-rank fusion, plus dense re-ranking when an
 * EmbeddingProvider is configured. The lexical AND-contract gates the
 * candidate set, so the honest no_results state survives hybridization:
 * vectors re-rank, they never admit unmatched items (PRD P0-8).
 */
export class SqliteGraphStore implements GraphStore {
  private db: DatabaseSync;
  private embeddings?: EmbeddingProvider;
  private embedWarned = false;

  constructor(path: string, options: SqliteStoreOptions = {}) {
    this.db = new DatabaseSync(path);
    this.embeddings = options.embeddings;
    // Migrations for databases created before newer columns existed; must
    // run before SCHEMA so CREATE INDEX statements find current shape.
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entities'")
      .all() as unknown as { name: string }[];
    if (tables.length > 0) {
      const cols = this.db.prepare('PRAGMA table_info(entities)').all() as unknown as {
        name: string;
      }[];
      const have = new Set(cols.map((c) => c.name));
      for (const col of ['tags', 'aliases', 'content', 'embedding', 'embedding_provider']) {
        if (!have.has(col)) this.db.exec(`ALTER TABLE entities ADD COLUMN ${col} TEXT`);
      }
    }
    this.db.exec(SCHEMA);
    // Backfill the FTS index for databases that predate it.
    const ftsCount = (this.db.prepare('SELECT COUNT(*) AS n FROM entities_fts').get() as { n: number }).n;
    const entCount = (this.db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n;
    if (ftsCount === 0 && entCount > 0) {
      const rows = this.db.prepare('SELECT * FROM entities').all() as unknown as EntityRow[];
      const insert = this.db.prepare(
        'INSERT INTO entities_fts (id, tenant_id, text) VALUES (?, ?, ?)',
      );
      for (const row of rows) insert.run(row.id, row.tenant_id, ftsText(rowToEntity(row)));
    }
  }

  close(): void {
    this.db.close();
  }

  /** Used by app bootstrap to decide whether to seed a fresh database. */
  countEntities(tenantId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM entities WHERE tenant_id = ?')
      .get(tenantId) as { n: number };
    return row.n;
  }

  /** How many entities carry a vector from the active provider (diagnostics/tests). */
  countEmbedded(tenantId: string): number {
    if (!this.embeddings) return 0;
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM entities WHERE tenant_id = ? AND embedding IS NOT NULL AND embedding_provider = ?',
      )
      .get(tenantId, this.embeddings.id) as { n: number };
    return row.n;
  }

  private async tryEmbed(texts: string[]): Promise<number[][] | undefined> {
    if (!this.embeddings) return undefined;
    try {
      return await this.embeddings.embed(texts);
    } catch (err) {
      if (!this.embedWarned) {
        this.embedWarned = true;
        console.error(`ekg-store: embedding provider ${this.embeddings.id} failed, continuing lexical-only:`, err);
      }
      return undefined;
    }
  }

  async upsertEntity(entity: Entity, chunks?: Chunk[]): Promise<void> {
    let embedding: string | null = null;
    let provider: string | null = null;
    const vectors = await this.tryEmbed([embeddingText(entity)]);
    if (vectors?.[0]) {
      embedding = JSON.stringify(vectors[0]);
      provider = this.embeddings!.id;
    }
    // Embed chunks before opening the write transaction (no await inside it).
    let chunkVectors: number[][] | undefined;
    if (chunks && chunks.length > 0) {
      chunkVectors = await this.tryEmbed(chunks.map(chunkEmbeddingText));
    }

    this.db
      .prepare(
        `INSERT INTO entities (id, tenant_id, type, title, summary, properties, tags, aliases, content, embedding, embedding_provider, provenance, acl)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           tenant_id = excluded.tenant_id, type = excluded.type, title = excluded.title,
           summary = excluded.summary, properties = excluded.properties,
           tags = excluded.tags, aliases = excluded.aliases, content = excluded.content,
           embedding = COALESCE(excluded.embedding, entities.embedding),
           embedding_provider = COALESCE(excluded.embedding_provider, entities.embedding_provider),
           provenance = excluded.provenance, acl = excluded.acl`,
      )
      .run(
        entity.id,
        entity.tenantId,
        entity.type,
        entity.title,
        entity.summary ?? null,
        JSON.stringify(entity.properties),
        entity.tags ? JSON.stringify(entity.tags) : null,
        entity.aliases ? JSON.stringify(entity.aliases) : null,
        entity.content ?? null,
        embedding,
        provider,
        JSON.stringify(entity.provenance),
        JSON.stringify(entity.acl),
      );
    this.db.prepare('DELETE FROM entities_fts WHERE id = ?').run(entity.id);
    this.db
      .prepare('INSERT INTO entities_fts (id, tenant_id, text) VALUES (?, ?, ?)')
      .run(entity.id, entity.tenantId, ftsText(entity));

    // Omitted chunks preserve the existing passages (ADR 0006); an explicit
    // array (including []) replaces them wholesale.
    if (chunks !== undefined) this.writeChunks(entity.id, chunks, chunkVectors);
  }

  /** Replace all chunks for an entity, with their FTS rows and embeddings. */
  private writeChunks(entityId: string, chunks: Chunk[], vectors?: number[][]): void {
    this.db.prepare('DELETE FROM chunks WHERE entity_id = ?').run(entityId);
    this.db.prepare('DELETE FROM chunks_fts WHERE entity_id = ?').run(entityId);
    const insert = this.db.prepare(
      `INSERT INTO chunks (id, entity_id, tenant_id, ordinal, anchor, heading, text, embedding, embedding_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.db.prepare(
      'INSERT INTO chunks_fts (id, entity_id, tenant_id, text) VALUES (?, ?, ?, ?)',
    );
    chunks.forEach((chunk, i) => {
      const vec = vectors?.[i];
      insert.run(
        chunk.id,
        entityId,
        chunk.tenantId,
        chunk.ordinal,
        chunk.anchor ? JSON.stringify(chunk.anchor) : null,
        chunk.heading ?? null,
        chunk.text,
        vec ? JSON.stringify(vec) : null,
        vec ? this.embeddings!.id : null,
      );
      insertFts.run(chunk.id, entityId, chunk.tenantId, chunkFtsText(chunk));
    });
  }

  async getChunks(caller: Caller, entityId: string): Promise<Chunk[]> {
    const entity = await this.getEntity(caller, entityId);
    if (!entity) return [];
    const rows = this.db
      .prepare('SELECT * FROM chunks WHERE entity_id = ? ORDER BY ordinal')
      .all(entityId) as unknown as ChunkRow[];
    return rows.map(rowToChunk);
  }

  /** Embed rows missing a vector from the active provider (bootstrap/backfill). */
  async reindexEmbeddings(tenantId: string): Promise<number> {
    if (!this.embeddings) return 0;
    const rows = this.db
      .prepare(
        'SELECT * FROM entities WHERE tenant_id = ? AND (embedding IS NULL OR embedding_provider != ?)',
      )
      .all(tenantId, this.embeddings.id) as unknown as EntityRow[];
    const entities = rows.map(rowToEntity);
    if (entities.length > 0) {
      const vectors = await this.tryEmbed(entities.map(embeddingText));
      if (vectors) {
        const update = this.db.prepare(
          'UPDATE entities SET embedding = ?, embedding_provider = ? WHERE id = ?',
        );
        entities.forEach((e, i) => {
          if (vectors[i]) update.run(JSON.stringify(vectors[i]), this.embeddings!.id, e.id);
        });
      }
    }

    // Chunk vectors too (ADR 0006) — deep retrieval needs per-passage dense.
    const chunkRows = this.db
      .prepare(
        'SELECT * FROM chunks WHERE tenant_id = ? AND (embedding IS NULL OR embedding_provider != ?)',
      )
      .all(tenantId, this.embeddings.id) as unknown as ChunkRow[];
    if (chunkRows.length > 0) {
      const chunks = chunkRows.map(rowToChunk);
      const vectors = await this.tryEmbed(chunks.map(chunkEmbeddingText));
      if (vectors) {
        const update = this.db.prepare(
          'UPDATE chunks SET embedding = ?, embedding_provider = ? WHERE id = ?',
        );
        chunks.forEach((c, i) => {
          if (vectors[i]) update.run(JSON.stringify(vectors[i]), this.embeddings!.id, c.id);
        });
      }
    }
    return entities.length + chunkRows.length;
  }

  async upsertRelationship(rel: Relationship): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO relationships (id, tenant_id, type, from_id, to_id, properties)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           tenant_id = excluded.tenant_id, type = excluded.type,
           from_id = excluded.from_id, to_id = excluded.to_id, properties = excluded.properties`,
      )
      .run(
        rel.id,
        rel.tenantId,
        rel.type,
        rel.fromId,
        rel.toId,
        rel.properties ? JSON.stringify(rel.properties) : null,
      );
  }

  async getEntity(caller: Caller, id: string): Promise<Entity | undefined> {
    const row = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as
      | EntityRow
      | undefined;
    if (!row) return undefined;
    const entity = rowToEntity(row);
    return canRead(caller, entity) ? entity : undefined;
  }

  private tenantRows(caller: Caller): EntityRow[] {
    return this.db
      .prepare('SELECT * FROM entities WHERE tenant_id = ?')
      .all(caller.tenantId) as unknown as EntityRow[];
  }

  private tenantEntities(caller: Caller, options: SearchOptions): Entity[] {
    return this.tenantRows(caller)
      .map(rowToEntity)
      .filter((e) => canRead(caller, e))
      .filter((e) => !options.types || options.types.includes(e.type))
      .filter((e) => matchesTagFilter(e, options.tags));
  }

  async search(caller: Caller, query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const groups = buildQueryGroups(query);
    if (groups.length === 0) return [];
    const visible = this.tenantEntities(caller, options);
    const byId = new Map(visible.map((e) => [e.id, e]));
    const ftsExpr = ftsQuery(groups);

    // List 1 — shared lexical matcher (the honesty gate: AND across concepts,
    // over entity metadata + content preview).
    const lexical = visible
      .map((e) => ({ id: e.id, score: scoreEntityMatch(e, groups) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((h) => h.id);

    // List 2 — entity FTS5 BM25 over the same AND/OR contract.
    let fts: string[] = [];
    try {
      const rows = this.db
        .prepare(
          'SELECT id FROM entities_fts WHERE entities_fts MATCH ? AND tenant_id = ? ORDER BY rank LIMIT 50',
        )
        .all(ftsExpr, caller.tenantId) as unknown as { id: string }[];
      fts = rows.map((r) => r.id).filter((id) => byId.has(id));
    } catch {
      // Malformed MATCH input — lexical list still stands.
    }

    // List 2b — chunk FTS (ADR 0006): every concept must co-occur in ONE
    // passage, rolled up to its parent entity. This is the deep-document
    // path — the preview that entity FTS sees stops a few pages in, but the
    // chunks cover the whole file. Stricter than the entity gate, so it only
    // admits parents that genuinely contain the concepts (P0-8 stays honest).
    const chunkFts: string[] = [];
    const bestChunkId = new Map<string, string>();
    try {
      const rows = this.db
        .prepare(
          'SELECT id, entity_id FROM chunks_fts WHERE chunks_fts MATCH ? AND tenant_id = ? ORDER BY rank LIMIT 100',
        )
        .all(ftsExpr, caller.tenantId) as unknown as { id: string; entity_id: string }[];
      for (const r of rows) {
        if (!byId.has(r.entity_id)) continue; // parent trimmed by type/tag/ACL
        if (!bestChunkId.has(r.entity_id)) {
          bestChunkId.set(r.entity_id, r.id);
          chunkFts.push(r.entity_id);
        }
      }
    } catch {
      // Malformed MATCH input — other lists still stand.
    }

    // Candidate set: admitted by any honest gate. Vectors re-rank; they never
    // admit items no concept matched (keeps no_results honest, P0-8).
    const admitted = new Set([...lexical, ...fts, ...chunkFts]);
    if (admitted.size === 0) return [];

    // List 3 — dense similarity over admitted candidates: best of the
    // entity-level vector and the entity's chunk vectors.
    let dense: string[] = [];
    if (this.embeddings) {
      const queryVec = (await this.tryEmbed([query]))?.[0];
      if (queryVec) {
        const provider = this.embeddings.id;
        const sim = new Map<string, number>();
        for (const r of this.tenantRows(caller)) {
          if (!admitted.has(r.id) || !r.embedding || r.embedding_provider !== provider) continue;
          sim.set(r.id, cosineSimilarity(queryVec, JSON.parse(r.embedding)));
        }
        const ids = [...admitted];
        const rows = this.db
          .prepare(
            `SELECT entity_id, embedding FROM chunks WHERE embedding_provider = ? AND embedding IS NOT NULL AND entity_id IN (${ids.map(() => '?').join(',')})`,
          )
          .all(provider, ...ids) as unknown as { entity_id: string; embedding: string }[];
        for (const r of rows) {
          const s = cosineSimilarity(queryVec, JSON.parse(r.embedding));
          sim.set(r.entity_id, Math.max(sim.get(r.entity_id) ?? -1, s));
        }
        dense = [...sim.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      }
    }

    // Reciprocal-rank fusion + review-status adjustment.
    const fused = new Map<string, number>();
    for (const list of [lexical, fts, chunkFts, dense]) {
      list.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
    }
    const ranked = [...fused.entries()]
      .filter(([id]) => admitted.has(id))
      .map(([id, score]) => {
        const entity = byId.get(id)!;
        const status = entity.provenance.reviewStatus;
        const adjusted =
          score *
          (status === 'superseded' || status === 'deprecated' ? 0.85 : 1) *
          (status === 'unverified' ? 0.95 : 1);
        return { entity, score: adjusted, warning: warningFor(status) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit ?? 10);

    // Attach the matched passage for citation (ADR 0006): page/section anchor
    // and a snippet, for entities admitted via a chunk.
    return ranked.map((hit) => {
      const chunkId = bestChunkId.get(hit.entity.id);
      if (!chunkId) return hit;
      const row = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) as
        | ChunkRow
        | undefined;
      if (!row) return hit;
      const chunk = rowToChunk(row);
      const match: ChunkMatch = {
        anchor: chunk.anchor,
        ordinal: chunk.ordinal,
        snippet: snippetForGroups(chunk.text, groups),
        ...(chunk.heading ? { heading: chunk.heading } : {}),
      };
      return { ...hit, chunk: match };
    });
  }

  async list(caller: Caller, options: SearchOptions = {}): Promise<Entity[]> {
    return this.tenantEntities(caller, options).slice(0, options.limit ?? 100);
  }

  async deleteEntity(caller: Caller, id: string): Promise<boolean> {
    const entity = await this.getEntity(caller, id);
    if (!entity) return false;
    this.db.prepare('DELETE FROM relationships WHERE from_id = ? OR to_id = ?').run(id, id);
    this.db.prepare('DELETE FROM entities WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM entities_fts WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM chunks WHERE entity_id = ?').run(id);
    this.db.prepare('DELETE FROM chunks_fts WHERE entity_id = ?').run(id);
    return true;
  }

  async listRelationships(caller: Caller): Promise<Relationship[]> {
    const rows = this.db
      .prepare('SELECT * FROM relationships WHERE tenant_id = ?')
      .all(caller.tenantId) as unknown as RelationshipRow[];
    const out: Relationship[] = [];
    for (const row of rows) {
      const rel = rowToRelationship(row);
      const from = await this.getEntity(caller, rel.fromId);
      const to = await this.getEntity(caller, rel.toId);
      if (from && to) out.push(rel);
    }
    return out;
  }

  async neighbors(
    caller: Caller,
    entityId: string,
    type?: RelationshipType,
  ): Promise<NeighborHit[]> {
    const rows = this.db
      .prepare(
        'SELECT * FROM relationships WHERE tenant_id = ? AND (from_id = ? OR to_id = ?)',
      )
      .all(caller.tenantId, entityId, entityId) as unknown as RelationshipRow[];
    const hits: NeighborHit[] = [];
    for (const row of rows) {
      const rel = rowToRelationship(row);
      if (type && rel.type !== type) continue;
      const direction = rel.fromId === entityId ? 'out' : 'in';
      const other = await this.getEntity(caller, direction === 'out' ? rel.toId : rel.fromId);
      if (other) hits.push({ relationship: rel, entity: other, direction });
    }
    return hits;
  }

  async getSetting(tenantId: string, key: string): Promise<string | undefined> {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?')
      .get(tenantId, key) as { value: string } | undefined;
    return row?.value;
  }

  async setSetting(tenantId: string, key: string, value: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run(tenantId, key, value);
  }
}
