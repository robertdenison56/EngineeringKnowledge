import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildQueryGroups,
  canRead,
  chunkEmbeddingText,
  cosineSimilarity,
  embeddingText,
  groupConcept,
  matchesTagFilter,
  relaxedScoreEntityMatch,
  roleBoostFactor,
  scoreChunkMatch,
  scoreEntityMatch,
  snippetForGroups,
  warningFor,
  type Caller,
  type Chunk,
  type ChunkMatch,
  type EmbeddingProvider,
  type Entity,
  type GraphStore,
  type MergeResult,
  type NeighborHit,
  type Relationship,
  type RelationshipType,
  type SearchHit,
  type SearchOptions,
} from '@ekg/core';

import { SqliteOperationJournal } from './operation-journal-sqlite.js';
import { FTS_RECIPE_KEY, FTS_RECIPE_VERSION, chunkFtsText, ftsText, rebuildFts } from './fts.js';
import {
  rowToChunk,
  rowToEntity,
  rowToRelationship,
  type ChunkRow,
  type EntityRow,
  type RelationshipRow,
} from './rows.js';
import {
  SchemaError,
  assertNotInUse,
  backupDatabase,
  defaultBackupPath,
  migrate,
  readSchemaVersion,
  utcStamp,
  verifyDatabase,
  type MigrateResult,
  type VerifyResult,
} from './schema.js';

export { providerFromEnv } from './providers.js';
export { SqliteOperationJournal } from './operation-journal-sqlite.js';
export { FTS_RECIPE_VERSION, rebuildFts } from './fts.js';
export {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  SchemaError,
  assertNotInUse,
  backupDatabase,
  defaultBackupPath,
  inspectDatabase,
  migrate,
  readSchemaVersion,
  utcStamp,
  verifyDatabase,
  type AppliedMigration,
  type LedgerEntry,
  type MigrateOptions,
  type MigrateResult,
  type Migration,
  type SchemaErrorCode,
  type SchemaStatus,
  type VerifyResult,
} from './schema.js';

/** FTS5 MATCH expression mirroring the AND-across/OR-within group contract. */
function ftsQuery(groups: string[][]): string {
  return groups
    .map((g) => `(${g.map((v) => `"${v.replace(/"/g, '')}"`).join(' OR ')})`)
    .join(' AND ');
}

const RRF_K = 60;

/**
 * Weighted reciprocal-rank fusion: a deep passage co-occurrence (chunk FTS — the
 * identifier/section wedge) and BM25 (entity FTS) are stronger precision signals
 * than a loose substring match, so they fuse heavier; graph-expanded neighbors
 * fuse lightest so they never outrank a direct concept match. Plain RRF is the
 * all-1 special case.
 */
const RRF_WEIGHTS = { lexical: 1, fts: 1.5, chunkFts: 2, dense: 1.2, expanded: 0.4 };

/** How many of the strongest base matches we expand 1-hop neighbors from. */
const EXPAND_FROM = 6;

export interface SqliteStoreOptions {
  /** Optional dense-retrieval provider; lexical-only without it. */
  embeddings?: EmbeddingProvider;
  /**
   * Schema upgrades on open (ADR 0012): `auto` applies pending migrations;
   * `manual` refuses an existing database that needs one, so an operator runs
   * `ekg-db migrate` deliberately. Default: `manual` when `EKG_DB_MIGRATE=manual`,
   * else `auto`.
   */
  migrate?: 'auto' | 'manual';
  /**
   * Snapshot an existing file next to itself before the first pending
   * migration touches it (`<db>.v<from>-<stamp>.backup`). Default: on, unless
   * `EKG_DB_BACKUP_ON_MIGRATE=0`. Meaningless for `:memory:`.
   */
  backupOnMigrate?: boolean;
  /** Where lifecycle notices (upgrade applied, FTS rebuilt) go; default stderr. */
  log?: (message: string) => void;
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
  private readonly path: string;
  private readonly fileBacked: boolean;
  private readonly log: (message: string) => void;
  /** What opening did to the schema: version before/after, migrations applied, snapshot written. */
  readonly migration: MigrateResult;

  constructor(path: string, options: SqliteStoreOptions = {}) {
    this.path = path;
    this.fileBacked = path !== ':memory:' && !/^file:.*mode=memory/.test(path);
    this.log = options.log ?? ((message) => console.error(`ekg-store: ${message}`));
    this.db = new DatabaseSync(path);
    // Concurrency + durability for the documented shared-DB story: the workspace
    // app and the MCP gateway open the same file at once (README "full loop").
    // WAL lets a reader and a writer coexist instead of one blocking the other;
    // busy_timeout makes a contended write wait briefly rather than throwing
    // SQLITE_BUSY. Pragmas are per-connection, so set them on every open. (WAL is
    // a no-op on :memory: databases, which is fine.)
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.embeddings = options.embeddings;
    // Schema first (ADR 0012): apply whatever migrations this file still needs,
    // snapshotting an existing file before the first one touches it, and
    // refuse a file whose schema is newer than this build.
    const mode = options.migrate ?? (process.env.EKG_DB_MIGRATE === 'manual' ? 'manual' : 'auto');
    const snapshot = options.backupOnMigrate ?? process.env.EKG_DB_BACKUP_ON_MIGRATE !== '0';
    this.migration = migrate(this.db, {
      mode,
      backup:
        this.fileBacked && snapshot
          ? (from) => backupDatabase(this.db, defaultBackupPath(path, from)).path
          : undefined,
    });
    if (this.migration.existing && this.migration.applied.length > 0) {
      const steps = this.migration.applied.map((m) => `v${m.version} ${m.name}`).join(', ');
      this.log(
        `upgraded ${path} from schema v${this.migration.from} to v${this.migration.to} (${steps})` +
          (this.migration.backupPath ? `; pre-upgrade snapshot: ${this.migration.backupPath}` : ''),
      );
    }
    this.ensureFtsRecipe();
    this.reconcileFts();
  }

  /**
   * Rebuild the FTS rows when the recipe they were built with is not the
   * current one ({@link FTS_RECIPE_VERSION}) — the refresh `reconcileFts`
   * cannot do, since it only backfills missing rows. Runs after migrations in
   * one IMMEDIATE transaction, so concurrent openers serialize and the second
   * finds it already done.
   */
  private ensureFtsRecipe(): void {
    this.tx(() => {
      const row = this.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(FTS_RECIPE_KEY) as
        | { value: string }
        | undefined;
      if (row?.value === String(FTS_RECIPE_VERSION)) return;
      const rebuilt = rebuildFts(this.db);
      this.db
        .prepare(
          'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(FTS_RECIPE_KEY, String(FTS_RECIPE_VERSION));
      if (this.fileBacked && rebuilt.entities + rebuilt.chunks > 0) {
        this.log(
          `rebuilt the FTS index of ${this.path} under recipe v${FTS_RECIPE_VERSION} ` +
            `(${rebuilt.entities} entities, ${rebuilt.chunks} chunks; was ${row ? `v${row.value}` : 'unversioned'})`,
        );
      }
    });
  }

  /**
   * Restore the FTS invariant on open: exactly one entities_fts row per
   * entities row (and one chunks_fts row per chunk). Live databases carry
   * residue from before writes were transactional (pre WAL/busy_timeout, a
   * SQLITE_BUSY or crash between `DELETE FROM entities` and `DELETE FROM
   * entities_fts` stranded the FTS row), and the previous count-based
   * backfill (`ftsCount === 0`) could neither heal an orphan, nor complete an
   * interrupted backfill, nor survive two processes racing the count check
   * without double-inserting. Set-based reconciliation is idempotent, and the
   * single IMMEDIATE transaction serializes concurrent openers (app +
   * gateway), so the second sees a consistent index and does nothing. Full
   * scans of the id sets are fine at this store's dev-grade scale.
   */
  private reconcileFts(): void {
    this.tx(() => {
      // Orphans: FTS rows whose source row is gone.
      this.db.exec('DELETE FROM entities_fts WHERE id NOT IN (SELECT id FROM entities)');
      this.db.exec('DELETE FROM chunks_fts WHERE id NOT IN (SELECT id FROM chunks)');
      // Duplicates (e.g. two pre-fix processes racing the old count-based
      // backfill): drop every copy; the re-insert below restores one.
      const dupEntity = this.db
        .prepare('SELECT id FROM entities_fts GROUP BY id HAVING COUNT(*) > 1')
        .all() as unknown as { id: string }[];
      for (const { id } of dupEntity) this.db.prepare('DELETE FROM entities_fts WHERE id = ?').run(id);
      const dupChunk = this.db
        .prepare('SELECT id FROM chunks_fts GROUP BY id HAVING COUNT(*) > 1')
        .all() as unknown as { id: string }[];
      for (const { id } of dupChunk) this.db.prepare('DELETE FROM chunks_fts WHERE id = ?').run(id);
      // Missing: databases that predate the FTS tables (the old backfill's
      // job), interrupted backfills, and the duplicate re-inserts above.
      const missing = this.db
        .prepare('SELECT * FROM entities WHERE id NOT IN (SELECT id FROM entities_fts)')
        .all() as unknown as EntityRow[];
      const insert = this.db.prepare(
        'INSERT INTO entities_fts (id, tenant_id, text) VALUES (?, ?, ?)',
      );
      for (const row of missing) insert.run(row.id, row.tenant_id, ftsText(rowToEntity(row)));
      const missingChunks = this.db
        .prepare('SELECT * FROM chunks WHERE id NOT IN (SELECT id FROM chunks_fts)')
        .all() as unknown as ChunkRow[];
      const insertChunk = this.db.prepare(
        'INSERT INTO chunks_fts (id, entity_id, tenant_id, text) VALUES (?, ?, ?, ?)',
      );
      for (const row of missingChunks) {
        insertChunk.run(row.id, row.entity_id, row.tenant_id, chunkFtsText(rowToChunk(row)));
      }
    });
  }

  close(): void {
    this.db.close();
  }

  /** Current `PRAGMA user_version` of the open database. */
  schemaVersion(): number {
    return readSchemaVersion(this.db);
  }

  /**
   * Consistent snapshot of this database at `dest` — safe while the app and
   * gateway keep writing. See {@link backupDatabase}.
   */
  backup(dest: string): { path: string; bytes: number } {
    return backupDatabase(this.db, dest);
  }

  /**
   * Run a multi-statement mutation atomically — a crash or thrown error rolls
   * the whole thing back, so the graph never lands half-merged (orphan chunks,
   * dangling FTS rows, an edge repointed but its duplicate undeleted). Matches
   * the in-memory store's natural atomicity (parity, PRD P0-7). BEGIN
   * IMMEDIATE takes the write lock up front (with busy_timeout waiting on a
   * concurrent writer) instead of failing at the first write. The callback
   * must be synchronous: do every await (e.g. embedding) before opening it.
   */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* a failed rollback must not mask the original error */
      }
      throw err;
    }
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
    // Never let one tenant's write land on another tenant's row (PRD P0-7).
    // Ids are tenant-scoped upstream, so a same-id different-tenant collision is
    // a bug or an attack, not a legitimate update.
    const owner = this.db.prepare('SELECT tenant_id FROM entities WHERE id = ?').get(entity.id) as
      | { tenant_id: string }
      | undefined;
    if (owner && owner.tenant_id !== entity.tenantId) {
      throw new Error(`refusing cross-tenant overwrite of entity ${entity.id}`);
    }

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

    // Entity row + its FTS index + its chunks must land together or not at all.
    this.tx(() => {
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
    });
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

  async deleteRelationship(caller: Caller, id: string): Promise<boolean> {
    const row = this.db
      .prepare('SELECT * FROM relationships WHERE id = ? AND tenant_id = ?')
      .get(id, caller.tenantId) as RelationshipRow | undefined;
    if (!row) return false;
    const rel = rowToRelationship(row);
    // Both endpoints must be visible — no deleting an edge into a hidden entity.
    const from = await this.getEntity(caller, rel.fromId);
    const to = await this.getEntity(caller, rel.toId);
    if (!from || !to) return false;
    this.db.prepare('DELETE FROM relationships WHERE id = ?').run(id);
    return true;
  }

  async mergeEntities(
    caller: Caller,
    survivorId: string,
    duplicateId: string,
  ): Promise<MergeResult | undefined> {
    if (survivorId === duplicateId) return undefined;
    const survivor = await this.getEntity(caller, survivorId);
    const duplicate = await this.getEntity(caller, duplicateId);
    if (!survivor || !duplicate) return undefined;

    const edgeKey = (type: string, from: string, to: string) => `${type} ${from} ${to}`;
    // Edges the survivor already has, so a repointed dup edge that collides with
    // one of them is dropped rather than duplicated.
    const survivorRows = this.db
      .prepare('SELECT * FROM relationships WHERE tenant_id = ? AND (from_id = ? OR to_id = ?)')
      .all(caller.tenantId, survivorId, survivorId) as unknown as RelationshipRow[];
    const seen = new Set(
      survivorRows.map(rowToRelationship).map((r) => edgeKey(r.type, r.fromId, r.toId)),
    );

    const dupRows = this.db
      .prepare('SELECT * FROM relationships WHERE tenant_id = ? AND (from_id = ? OR to_id = ?)')
      .all(caller.tenantId, duplicateId, duplicateId) as unknown as RelationshipRow[];
    const update = this.db.prepare('UPDATE relationships SET from_id = ?, to_id = ? WHERE id = ?');
    const del = this.db.prepare('DELETE FROM relationships WHERE id = ?');
    // Repoint + dedup the duplicate's edges, then remove the duplicate, its FTS
    // row, and its chunks — atomically, so a failure can't leave a half-merged
    // graph (edges repointed but the duplicate still present, or vice versa).
    return this.tx(() => {
      let repointed = 0;
      let dropped = 0;
      for (const row of dupRows) {
        const rel = rowToRelationship(row);
        const fromId = rel.fromId === duplicateId ? survivorId : rel.fromId;
        const toId = rel.toId === duplicateId ? survivorId : rel.toId;
        const k = edgeKey(rel.type, fromId, toId);
        if (fromId === toId || seen.has(k)) {
          del.run(rel.id);
          dropped += 1;
        } else {
          update.run(fromId, toId, rel.id);
          seen.add(k);
          repointed += 1;
        }
      }

      // The duplicate now has no edges pointing at it; remove it, its FTS row,
      // and its chunks (the survivor keeps its own).
      this.db.prepare('DELETE FROM entities WHERE id = ?').run(duplicateId);
      this.db.prepare('DELETE FROM entities_fts WHERE id = ?').run(duplicateId);
      this.db.prepare('DELETE FROM chunks WHERE entity_id = ?').run(duplicateId);
      this.db.prepare('DELETE FROM chunks_fts WHERE entity_id = ?').run(duplicateId);
      return { survivorId, repointed, dropped };
    });
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
    if (admitted.size === 0) return this.relaxedPass(visible, groups, options);

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

    // Weighted reciprocal-rank fusion + review-status adjustment.
    const fused = new Map<string, number>();
    const addList = (ids: string[], weight: number) =>
      ids.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + weight / (RRF_K + rank + 1)));
    addList(lexical, RRF_WEIGHTS.lexical);
    addList(fts, RRF_WEIGHTS.fts);
    addList(chunkFts, RRF_WEIGHTS.chunkFts);
    addList(dense, RRF_WEIGHTS.dense);

    // Graph-expansion (the GraphRAG payoff): surface 1-hop neighbors of the
    // strongest matches — a hit on a spec section pulls in the detail it
    // references, an expert pulls in their projects. Gated on a non-empty honest
    // admission, so no_results stays no_results (P0-8); neighbors are trimmed to
    // the caller's visible, type/tag-filtered set (`byId`) and join at a low
    // weight, so they rank below every direct concept match.
    if (options.expand !== false && admitted.size > 0) {
      const topBase = [...fused.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, EXPAND_FROM)
        .map(([id]) => id);
      const freq = new Map<string, number>();
      for (const id of topBase) {
        for (const hit of await this.neighbors(caller, id)) {
          const nid = hit.entity.id;
          if (admitted.has(nid) || !byId.has(nid)) continue;
          freq.set(nid, (freq.get(nid) ?? 0) + 1);
        }
      }
      const expanded = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      for (const id of expanded) admitted.add(id);
      addList(expanded, RRF_WEIGHTS.expanded);
    }

    const ranked = [...fused.entries()]
      .filter(([id]) => admitted.has(id))
      .map(([id, score]) => {
        const entity = byId.get(id)!;
        const status = entity.provenance.reviewStatus;
        const adjusted =
          score *
          (status === 'superseded' || status === 'deprecated' ? 0.85 : 1) *
          (status === 'unverified' ? 0.95 : 1) *
          // Role re-rank (focus lens): scales already-admitted candidates only,
          // so it never admits a non-match or hides a match (P0-8).
          roleBoostFactor(entity, options.boostRole);
        return { entity, score: adjusted, warning: warningFor(status) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit ?? 10);

    // Attach the matched passage for citation (ADR 0006): page/section anchor
    // and a snippet. Preferred source is the chunk FTS pick; when that is
    // absent we fall back to a lexical scan of the entity's own chunks (see
    // `lexicalBestChunk`).
    return ranked.map((hit) => {
      const chunk = this.citationChunk(hit.entity.id, bestChunkId.get(hit.entity.id), groups);
      if (!chunk) return hit;
      const match: ChunkMatch = {
        anchor: chunk.anchor,
        ordinal: chunk.ordinal,
        snippet: snippetForGroups(chunk.text, groups),
        ...(chunk.heading ? { heading: chunk.heading } : {}),
      };
      return { ...hit, chunk: match };
    });
  }

  /**
   * The passage to cite for an already-admitted hit, or undefined when none
   * of the entity's passages contains the query concepts.
   *
   * CITATION ONLY — this runs over `ranked`, after admission and scoring are
   * settled, so it can never admit an entity, drop one, or reorder the list.
   * That is what makes the lexical fallback safe: the honest-gate contract
   * (P0-8) is enforced upstream and untouched here.
   *
   * The fallback exists because the two gates tokenize differently. Entity
   * admission includes a substring pass, so "fire stopping spec" admits the
   * firestopping spec ("firestopping" contains "stopping"); FTS5 is
   * token-based, so chunk FTS matches neither, and the hit would be served
   * with no page or section even though PART 2 plainly says it. Falling back
   * to `scoreChunkMatch` — the same per-passage co-occurrence gate the
   * in-memory store already applies, so the two stores now agree — recovers
   * the citation. When no passage clears that gate we return undefined and
   * the hit cites the file only, rather than pointing at an arbitrary page.
   */
  private citationChunk(
    entityId: string,
    ftsChunkId: string | undefined,
    groups: string[][],
  ): Chunk | undefined {
    if (ftsChunkId) {
      const row = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(ftsChunkId) as
        | ChunkRow
        | undefined;
      if (row) return rowToChunk(row);
    }
    const rows = this.db
      .prepare('SELECT * FROM chunks WHERE entity_id = ? ORDER BY ordinal')
      .all(entityId) as unknown as ChunkRow[];
    let best: { chunk: Chunk; score: number } | undefined;
    for (const row of rows) {
      const candidate = rowToChunk(row);
      const score = scoreChunkMatch(candidate, groups);
      if (score > 0 && (!best || score > best.score)) best = { chunk: candidate, score };
    }
    return best?.chunk;
  }

  /**
   * Most-concepts-match fallback (SearchOptions.relax, default on): runs ONLY
   * when the strict pipeline admitted zero entities, and only for queries of
   * three or more concept groups. Entity-level only — no chunk pass, so
   * relaxed hits never carry a passage citation — and it never seeds
   * graph-expansion. Every hit is disclosed as partial via
   * `SearchHit.partial`, and the same review-status and role multipliers the
   * strict fusion applies scale the relaxed score, so honesty (P0-8) and the
   * focus-lens contract hold. Capped at the store's normal limit.
   */
  private relaxedPass(
    visible: Entity[],
    groups: string[][],
    options: SearchOptions,
  ): SearchHit[] {
    if (options.relax === false || groups.length < 3) return [];
    return visible
      .map((entity) => ({ entity, match: relaxedScoreEntityMatch(entity, groups) }))
      .filter(({ match }) => match.score > 0)
      .map(({ entity, match }) => {
        const status = entity.provenance.reviewStatus;
        // SAME multipliers as the strict fusion path above.
        const score =
          match.score *
          (status === 'superseded' || status === 'deprecated' ? 0.85 : 1) *
          (status === 'unverified' ? 0.95 : 1) *
          roleBoostFactor(entity, options.boostRole);
        const matched = new Set(match.matchedGroups);
        return {
          entity,
          score,
          warning: warningFor(status),
          partial: {
            matchedConcepts: match.matchedGroups.map((i) => groupConcept(groups[i])),
            missingConcepts: groups
              .map((_, i) => i)
              .filter((i) => !matched.has(i))
              .map((i) => groupConcept(groups[i])),
          },
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit ?? 10);
  }

  async list(caller: Caller, options: SearchOptions = {}): Promise<Entity[]> {
    return this.tenantEntities(caller, options).slice(0, options.limit ?? 100);
  }

  async deleteEntity(caller: Caller, id: string): Promise<boolean> {
    const entity = await this.getEntity(caller, id);
    if (!entity) return false;
    // Entity, its edges, FTS rows, and chunks drop together or not at all.
    this.tx(() => {
      this.db.prepare('DELETE FROM relationships WHERE from_id = ? OR to_id = ?').run(id, id);
      this.db.prepare('DELETE FROM entities WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM entities_fts WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM chunks WHERE entity_id = ?').run(id);
      this.db.prepare('DELETE FROM chunks_fts WHERE entity_id = ?').run(id);
    });
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

  // ── journal capture (tenant-scoped, NOT ACL-trimmed; see GraphStore docs) ──

  async getRelationship(tenantId: string, id: string): Promise<Relationship | undefined> {
    const row = this.db
      .prepare('SELECT * FROM relationships WHERE tenant_id = ? AND id = ?')
      .get(tenantId, id) as unknown as RelationshipRow | undefined;
    return row ? rowToRelationship(row) : undefined;
  }

  async relationshipsTouching(tenantId: string, ids: string[]): Promise<Relationship[]> {
    if (ids.length === 0) return [];
    const ph = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM relationships WHERE tenant_id = ? AND (from_id IN (${ph}) OR to_id IN (${ph}))`,
      )
      .all(tenantId, ...ids, ...ids) as unknown as RelationshipRow[];
    return rows.map(rowToRelationship);
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

  async deleteSetting(tenantId: string, key: string): Promise<void> {
    this.db.prepare('DELETE FROM settings WHERE tenant_id = ? AND key = ?').run(tenantId, key);
  }

  /**
   * A change journal for undo (PRD P0-9), sharing this store's database
   * connection so before-images live in the same file and stay consistent with
   * the graph. node:sqlite is single-handle, so the journal must reuse `this.db`
   * rather than opening its own.
   */
  createJournal(): SqliteOperationJournal {
    return new SqliteOperationJournal(this.db);
  }
}

export interface RestoreResult {
  restoredFrom: string;
  /** Snapshot of the live database as it was before the restore (when one existed). */
  preRestoreBackup?: string;
  /** Migrations the restored file needed to reach this build's schema. */
  migration: MigrateResult;
  verify: VerifyResult;
}

/**
 * Rehearsed restore of `backupPath` over `dbPath` (ADR 0012): verify the
 * backup, refuse while anything has the live file open, snapshot the live file
 * (so the restore is itself reversible), swap the backup in with the WAL/SHM
 * sidecars cleared, open it through the store — which migrates an older backup
 * forward — and verify the result. Everything before the swap is read-only.
 */
export function restoreDatabase(
  backupPath: string,
  dbPath: string,
  options: { log?: (message: string) => void } = {},
): RestoreResult {
  if (!existsSync(backupPath)) throw new SchemaError('not_found', `no backup at ${backupPath}`);
  const check = verifyDatabase(backupPath);
  if (!check.ok) {
    throw new SchemaError('backup_invalid', `${backupPath} failed verification: ${check.problems.join('; ')}`);
  }
  assertNotInUse(dbPath);
  let preRestoreBackup: string | undefined;
  if (existsSync(dbPath)) {
    const live = new DatabaseSync(dbPath, { readOnly: true });
    try {
      preRestoreBackup = backupDatabase(live, `${dbPath}.pre-restore-${utcStamp()}.backup`).path;
    } finally {
      live.close();
    }
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  copyFileSync(backupPath, dbPath);
  // The backup itself is the fallback for this open, so no second snapshot.
  const store = new SqliteGraphStore(dbPath, { log: options.log, backupOnMigrate: false });
  const migration = store.migration;
  store.close();
  const verify = verifyDatabase(dbPath);
  if (!verify.ok) {
    throw new SchemaError(
      'backup_invalid',
      `restored database failed verification: ${verify.problems.join('; ')}` +
        (preRestoreBackup ? ` (the pre-restore snapshot is at ${preRestoreBackup})` : ''),
    );
  }
  return {
    restoredFrom: backupPath,
    ...(preRestoreBackup ? { preRestoreBackup } : {}),
    migration,
    verify,
  };
}
