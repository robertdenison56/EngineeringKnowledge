import { DatabaseSync } from 'node:sqlite';
import {
  buildQueryGroups,
  canRead,
  cosineSimilarity,
  embeddingText,
  matchesTagFilter,
  normalizeText,
  scoreEntityMatch,
  warningFor,
  type Caller,
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

  async upsertEntity(entity: Entity): Promise<void> {
    let embedding: string | null = null;
    let provider: string | null = null;
    const vectors = await this.tryEmbed([embeddingText(entity)]);
    if (vectors?.[0]) {
      embedding = JSON.stringify(vectors[0]);
      provider = this.embeddings!.id;
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
  }

  /** Embed rows missing a vector from the active provider (bootstrap/backfill). */
  async reindexEmbeddings(tenantId: string): Promise<number> {
    if (!this.embeddings) return 0;
    const rows = this.db
      .prepare(
        'SELECT * FROM entities WHERE tenant_id = ? AND (embedding IS NULL OR embedding_provider != ?)',
      )
      .all(tenantId, this.embeddings.id) as unknown as EntityRow[];
    if (rows.length === 0) return 0;
    const entities = rows.map(rowToEntity);
    const vectors = await this.tryEmbed(entities.map(embeddingText));
    if (!vectors) return 0;
    const update = this.db.prepare(
      'UPDATE entities SET embedding = ?, embedding_provider = ? WHERE id = ?',
    );
    entities.forEach((e, i) => {
      if (vectors[i]) update.run(JSON.stringify(vectors[i]), this.embeddings!.id, e.id);
    });
    return entities.length;
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

    // List 1 — shared lexical matcher (the honesty gate: AND across concepts).
    const lexical = visible
      .map((e) => ({ id: e.id, score: scoreEntityMatch(e, groups) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((h) => h.id);

    // List 2 — FTS5 BM25 over the same AND/OR contract.
    let fts: string[] = [];
    try {
      const rows = this.db
        .prepare(
          'SELECT id FROM entities_fts WHERE entities_fts MATCH ? AND tenant_id = ? ORDER BY rank LIMIT 50',
        )
        .all(ftsQuery(groups), caller.tenantId) as unknown as { id: string }[];
      fts = rows.map((r) => r.id).filter((id) => byId.has(id));
    } catch {
      // Malformed MATCH input — lexical list still stands.
    }

    // Candidate set: lexically admitted only. Vectors re-rank; they never
    // admit items no concept matched (keeps no_results honest, P0-8).
    const admitted = new Set([...lexical, ...fts]);
    if (admitted.size === 0) return [];

    // List 3 — dense similarity over admitted candidates.
    let dense: string[] = [];
    if (this.embeddings) {
      const queryVec = (await this.tryEmbed([query]))?.[0];
      if (queryVec) {
        const provider = this.embeddings.id;
        dense = this.tenantRows(caller)
          .filter((r) => admitted.has(r.id) && r.embedding && r.embedding_provider === provider)
          .map((r) => ({ id: r.id, sim: cosineSimilarity(queryVec, JSON.parse(r.embedding!)) }))
          .sort((a, b) => b.sim - a.sim)
          .map((r) => r.id);
      }
    }

    // Reciprocal-rank fusion + review-status adjustment.
    const fused = new Map<string, number>();
    for (const list of [lexical, fts, dense]) {
      list.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
    }
    const hits: SearchHit[] = [...fused.entries()]
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
      .sort((a, b) => b.score - a.score);
    return hits.slice(0, options.limit ?? 10);
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
}
