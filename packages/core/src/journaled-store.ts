import type { Chunk, Entity, Relationship, RelationshipType } from './ontology.js';
import type {
  Caller,
  GraphStore,
  MergeResult,
  NeighborHit,
  SearchHit,
  SearchOptions,
} from './graph-store.js';
import {
  chunksKey,
  entityKey,
  relKey,
  settingKey,
  type BeforeImage,
  type OperationJournal,
} from './operation-journal.js';

/**
 * The ambient operation a mutation runs inside. Carried request-scoped by the
 * web app's AsyncLocalStorage and read by the decorator below; the caller is
 * used for the permission-trimmed reads that capture before-images.
 */
export interface OperationContext {
  opId: string;
  caller: Caller;
}

/**
 * Wraps a {@link GraphStore} so every mutation made inside an operation records
 * the pre-operation state of the records it touches into an {@link OperationJournal}
 * (PRD P0-9 undo). Reads pass straight through. When there is no active operation
 * — CLI ingestion, the bootstrap seed, embedding backfill — capture is a no-op,
 * so wrapping the store is always safe and only deliberate, operation-scoped
 * edits become reversible.
 *
 * Capture reads the current state via the wrapped store before delegating; the
 * journal keeps the FIRST image per record per operation, which is the true
 * pre-operation truth even if the same record is written more than once.
 */
export class JournaledGraphStore implements GraphStore {
  constructor(
    private readonly inner: GraphStore,
    private readonly journal: OperationJournal,
    private readonly currentOperation: () => OperationContext | undefined,
  ) {}

  /* ── reads: pass through ──────────────────────────────────────────────── */

  getEntity(caller: Caller, id: string): Promise<Entity | undefined> {
    return this.inner.getEntity(caller, id);
  }
  getChunks(caller: Caller, entityId: string): Promise<Chunk[]> {
    return this.inner.getChunks(caller, entityId);
  }
  search(caller: Caller, query: string, options?: SearchOptions): Promise<SearchHit[]> {
    return this.inner.search(caller, query, options);
  }
  list(caller: Caller, options?: SearchOptions): Promise<Entity[]> {
    return this.inner.list(caller, options);
  }
  listRelationships(caller: Caller): Promise<Relationship[]> {
    return this.inner.listRelationships(caller);
  }
  neighbors(caller: Caller, entityId: string, type?: RelationshipType): Promise<NeighborHit[]> {
    return this.inner.neighbors(caller, entityId, type);
  }
  getSetting(tenantId: string, key: string): Promise<string | undefined> {
    return this.inner.getSetting(tenantId, key);
  }

  /* ── mutations: capture before-image, then delegate ───────────────────── */

  async upsertEntity(entity: Entity, chunks?: Chunk[]): Promise<void> {
    const op = this.currentOperation();
    if (op) {
      const prior = await this.inner.getEntity(op.caller, entity.id);
      this.journal.record(op.opId, entityKey(entity.id), prior
        ? { kind: 'entity', existed: true, entity: prior }
        : { kind: 'entity', existed: false });
      // Chunks live under their own key so a fields-only re-upsert (chunks
      // omitted) never claims to replace the searchable passages (ADR 0006).
      // We snapshot the pre-op chunks only when this call actually replaces them.
      if (chunks !== undefined) {
        this.journal.record(op.opId, chunksKey(entity.id), {
          kind: 'chunks',
          chunks: await this.inner.getChunks(op.caller, entity.id),
        });
      }
    }
    return this.inner.upsertEntity(entity, chunks);
  }

  async upsertRelationship(rel: Relationship): Promise<void> {
    const op = this.currentOperation();
    if (op) {
      const prior = await this.findRelationship(op.caller, rel);
      this.journal.record(op.opId, relKey(rel.id), prior
        ? { kind: 'rel', existed: true, rel: prior }
        : { kind: 'rel', existed: false });
    }
    return this.inner.upsertRelationship(rel);
  }

  async deleteRelationship(caller: Caller, id: string): Promise<boolean> {
    const op = this.currentOperation();
    if (op) {
      const prior = await this.findRelationshipById(caller, id);
      if (prior) this.journal.record(op.opId, relKey(id), { kind: 'rel', existed: true, rel: prior });
    }
    return this.inner.deleteRelationship(caller, id);
  }

  async deleteEntity(caller: Caller, id: string): Promise<boolean> {
    const op = this.currentOperation();
    if (op) {
      const prior = await this.inner.getEntity(caller, id);
      if (prior) {
        this.journal.record(op.opId, entityKey(id), { kind: 'entity', existed: true, entity: prior });
        this.journal.record(op.opId, chunksKey(id), {
          kind: 'chunks',
          chunks: await this.inner.getChunks(caller, id),
        });
        // deleteEntity cascades every touching edge — snapshot them all so undo
        // can re-create them.
        for (const rel of await this.edgesTouching(caller, id)) {
          this.journal.record(op.opId, relKey(rel.id), { kind: 'rel', existed: true, rel });
        }
      }
    }
    return this.inner.deleteEntity(caller, id);
  }

  async mergeEntities(
    caller: Caller,
    survivorId: string,
    duplicateId: string,
  ): Promise<MergeResult | undefined> {
    const op = this.currentOperation();
    if (op && survivorId !== duplicateId) {
      // The duplicate entity + its chunks are deleted by the merge — snapshot them.
      const duplicate = await this.inner.getEntity(caller, duplicateId);
      if (duplicate) {
        this.journal.record(op.opId, entityKey(duplicateId), {
          kind: 'entity',
          existed: true,
          entity: duplicate,
        });
        this.journal.record(op.opId, chunksKey(duplicateId), {
          kind: 'chunks',
          chunks: await this.inner.getChunks(caller, duplicateId),
        });
      }
      // Every edge touching either endpoint may be repointed or dropped — snapshot
      // the superset so undo restores each to its exact pre-merge from/to.
      for (const rel of await this.edgesTouching(caller, survivorId, duplicateId)) {
        this.journal.record(op.opId, relKey(rel.id), { kind: 'rel', existed: true, rel });
      }
    }
    return this.inner.mergeEntities(caller, survivorId, duplicateId);
  }

  async setSetting(tenantId: string, key: string, value: string): Promise<void> {
    const op = this.currentOperation();
    if (op) {
      const prior = await this.inner.getSetting(tenantId, key);
      this.journal.record(op.opId, settingKey(tenantId, key), {
        kind: 'setting',
        tenantId,
        key,
        existed: prior !== undefined,
        ...(prior !== undefined ? { value: prior } : {}),
      });
    }
    return this.inner.setSetting(tenantId, key, value);
  }

  async deleteSetting(tenantId: string, key: string): Promise<void> {
    const op = this.currentOperation();
    if (op) {
      const prior = await this.inner.getSetting(tenantId, key);
      this.journal.record(op.opId, settingKey(tenantId, key), {
        kind: 'setting',
        tenantId,
        key,
        existed: prior !== undefined,
        ...(prior !== undefined ? { value: prior } : {}),
      });
    }
    return this.inner.deleteSetting(tenantId, key);
  }

  /* ── capture helpers ──────────────────────────────────────────────────── */

  /** All edges (both directions) touching any of the given entity ids, deduped. */
  private async edgesTouching(caller: Caller, ...ids: string[]): Promise<Relationship[]> {
    const out = new Map<string, Relationship>();
    for (const id of ids) {
      for (const hit of await this.inner.neighbors(caller, id)) {
        out.set(hit.relationship.id, hit.relationship);
      }
    }
    return [...out.values()];
  }

  /** Current stored relationship matching `rel.id`, if visible to the caller. */
  private async findRelationship(caller: Caller, rel: Relationship): Promise<Relationship | undefined> {
    const hits = await this.inner.neighbors(caller, rel.fromId);
    return hits.find((h) => h.relationship.id === rel.id)?.relationship;
  }

  private async findRelationshipById(caller: Caller, id: string): Promise<Relationship | undefined> {
    return (await this.inner.listRelationships(caller)).find((r) => r.id === id);
  }
}
