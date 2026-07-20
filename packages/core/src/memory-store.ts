import type { Chunk, Entity, Relationship, RelationshipType } from './ontology.js';
import type {
  Caller,
  ChunkMatch,
  GraphStore,
  MergeResult,
  NeighborHit,
  SearchHit,
  SearchOptions,
} from './graph-store.js';
import {
  buildQueryGroups,
  canRead,
  groupConcept,
  matchesTagFilter,
  relaxationThreshold,
  relaxedScoreEntityMatch,
  roleBoostFactor,
  scoreChunkMatch,
  scoreEntityMatch,
  snippetForGroups,
  warningFor,
} from './matching.js';

/**
 * Development/test implementation of GraphStore. Naive term-match scoring
 * stands in for the production hybrid retrieval; ACL and tenant trimming are
 * real and match the production contract (PRD P0-7).
 */
export class InMemoryGraphStore implements GraphStore {
  private entities = new Map<string, Entity>();
  private relationships = new Map<string, Relationship>();
  private chunks = new Map<string, Chunk[]>();
  /** Tenant-scoped key→value settings, keyed `${tenantId} ${key}`. */
  private settings = new Map<string, string>();

  async upsertEntity(entity: Entity, chunks?: Chunk[]): Promise<void> {
    // Never let one tenant's write land on another tenant's row (PRD P0-7).
    // Ids are tenant-scoped upstream, so a same-id different-tenant collision is
    // a bug or an attack, not a legitimate update.
    const existing = this.entities.get(entity.id);
    if (existing && existing.tenantId !== entity.tenantId) {
      throw new Error(`refusing cross-tenant overwrite of entity ${entity.id}`);
    }
    // Store a copy, not the caller's object — value semantics matching the
    // SQLite store, so a caller that later mutates what it passed (or what it
    // read back) can't retroactively change stored state or a captured undo
    // before-image (PRD P0-9).
    this.entities.set(entity.id, structuredClone(entity));
    // Omitted chunks preserve the existing passages (ADR 0006) — a curation
    // re-upsert that only flips reviewStatus must not wipe searchable text.
    if (chunks !== undefined) this.chunks.set(entity.id, structuredClone(chunks));
  }

  async getChunks(caller: Caller, entityId: string): Promise<Chunk[]> {
    const entity = this.entities.get(entityId);
    if (!entity || !canRead(caller, entity)) return [];
    return structuredClone([...(this.chunks.get(entityId) ?? [])].sort((a, b) => a.ordinal - b.ordinal));
  }

  async upsertRelationship(rel: Relationship): Promise<void> {
    this.relationships.set(rel.id, rel);
  }

  async deleteRelationship(caller: Caller, id: string): Promise<boolean> {
    const rel = this.relationships.get(id);
    if (!rel || rel.tenantId !== caller.tenantId) return false;
    const from = this.entities.get(rel.fromId);
    const to = this.entities.get(rel.toId);
    // Don't let a caller delete an edge whose endpoints they can't both see.
    if (!from || !to || !canRead(caller, from) || !canRead(caller, to)) return false;
    this.relationships.delete(id);
    return true;
  }

  async mergeEntities(
    caller: Caller,
    survivorId: string,
    duplicateId: string,
  ): Promise<MergeResult | undefined> {
    if (survivorId === duplicateId) return undefined;
    const survivor = this.entities.get(survivorId);
    const duplicate = this.entities.get(duplicateId);
    if (!survivor || !duplicate || !canRead(caller, survivor) || !canRead(caller, duplicate)) {
      return undefined;
    }

    const key = (type: string, from: string, to: string) => `${type}\u0000${from}\u0000${to}`;
    // Edges the survivor already has — a repointed dup edge matching one of
    // these is a duplicate and gets dropped, not added twice.
    const seen = new Set<string>();
    for (const rel of this.relationships.values()) {
      if (rel.tenantId !== caller.tenantId) continue;
      if (rel.fromId === survivorId || rel.toId === survivorId) {
        seen.add(key(rel.type, rel.fromId, rel.toId));
      }
    }

    let repointed = 0;
    let dropped = 0;
    for (const [relId, rel] of [...this.relationships]) {
      if (rel.tenantId !== caller.tenantId) continue;
      if (rel.fromId !== duplicateId && rel.toId !== duplicateId) continue;
      const fromId = rel.fromId === duplicateId ? survivorId : rel.fromId;
      const toId = rel.toId === duplicateId ? survivorId : rel.toId;
      const k = key(rel.type, fromId, toId);
      if (fromId === toId || seen.has(k)) {
        this.relationships.delete(relId);
        dropped += 1;
      } else {
        this.relationships.set(relId, { ...rel, fromId, toId });
        seen.add(k);
        repointed += 1;
      }
    }

    this.entities.delete(duplicateId);
    this.chunks.delete(duplicateId);
    return { survivorId, repointed, dropped };
  }

  async getEntity(caller: Caller, id: string): Promise<Entity | undefined> {
    const entity = this.entities.get(id);
    return entity && canRead(caller, entity) ? structuredClone(entity) : undefined;
  }

  async search(caller: Caller, query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const groups = buildQueryGroups(query);
    const hits: SearchHit[] = [];
    for (const entity of this.entities.values()) {
      if (!canRead(caller, entity)) continue;
      if (options.types && !options.types.includes(entity.type)) continue;
      if (!matchesTagFilter(entity, options.tags)) continue;

      // Entity-level match (metadata + content preview) OR a chunk match —
      // a concept hit in any passage admits the parent (ADR 0006). The chunk
      // gate is per-passage, so this never admits an entity no concept hit.
      const entityScore = scoreEntityMatch(entity, groups);
      let bestChunk: { chunk: Chunk; score: number } | undefined;
      for (const chunk of this.chunks.get(entity.id) ?? []) {
        const cs = scoreChunkMatch(chunk, groups);
        if (cs > 0 && (!bestChunk || cs > bestChunk.score)) bestChunk = { chunk, score: cs };
      }
      const baseScore = Math.max(entityScore, bestChunk?.score ?? 0);
      if (baseScore <= 0) continue;
      // Role re-rank: scale an admitted item's score when the active lens
      // favors it. Applied after the gate, so it never admits a non-match.
      const score = baseScore * roleBoostFactor(entity, options.boostRole);

      const match: ChunkMatch | undefined = bestChunk && {
        anchor: bestChunk.chunk.anchor,
        ordinal: bestChunk.chunk.ordinal,
        snippet: snippetForGroups(bestChunk.chunk.text, groups),
        ...(bestChunk.chunk.heading ? { heading: bestChunk.chunk.heading } : {}),
      };
      hits.push({
        entity,
        score,
        warning: warningFor(entity.provenance.reviewStatus),
        ...(match ? { chunk: match } : {}),
      });
    }
    // Relaxed fallback (most concepts match, disclosed as partial): runs ONLY
    // when the strict pipeline admitted nothing, the query is long enough to
    // relax (three-plus concepts), and the caller did not opt out. Strict and
    // relaxed results never mix, relaxed hits never feed graph-expansion, and
    // every relaxed hit carries `partial` naming what matched and what is
    // missing — that explicit disclosure is what keeps the fallback inside
    // the honest no_results contract (PRD P0-8). Entity-level only: no chunk
    // relaxation, so no `chunk` citation is attached to a partial hit.
    if (hits.length === 0 && options.relax !== false && relaxationThreshold(groups.length) > 0) {
      for (const entity of this.entities.values()) {
        if (!canRead(caller, entity)) continue;
        if (options.types && !options.types.includes(entity.type)) continue;
        if (!matchesTagFilter(entity, options.tags)) continue;

        const { score, matchedGroups } = relaxedScoreEntityMatch(entity, groups);
        if (score <= 0) continue;
        const matched = new Set(matchedGroups);
        hits.push({
          entity,
          // Same re-rank as the strict pass: the role lens scales admitted
          // candidates only, it never admits or hides one.
          score: score * roleBoostFactor(entity, options.boostRole),
          warning: warningFor(entity.provenance.reviewStatus),
          partial: {
            matchedConcepts: matchedGroups.map((i) => groupConcept(groups[i])),
            missingConcepts: groups.filter((_, i) => !matched.has(i)).map(groupConcept),
          },
        });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, options.limit ?? 10);
  }

  async list(caller: Caller, options: SearchOptions = {}): Promise<Entity[]> {
    const out: Entity[] = [];
    for (const entity of this.entities.values()) {
      if (!canRead(caller, entity)) continue;
      if (options.types && !options.types.includes(entity.type)) continue;
      if (!matchesTagFilter(entity, options.tags)) continue;
      out.push(entity);
      if (out.length >= (options.limit ?? 100)) break;
    }
    return out;
  }

  async listRelationships(caller: Caller): Promise<Relationship[]> {
    const out: Relationship[] = [];
    for (const rel of this.relationships.values()) {
      if (rel.tenantId !== caller.tenantId) continue;
      const from = this.entities.get(rel.fromId);
      const to = this.entities.get(rel.toId);
      if (from && to && canRead(caller, from) && canRead(caller, to)) out.push(rel);
    }
    return out;
  }

  // ── journal capture (tenant-scoped, NOT ACL-trimmed; see GraphStore docs) ──

  async getRelationship(tenantId: string, id: string): Promise<Relationship | undefined> {
    const rel = this.relationships.get(id);
    return rel && rel.tenantId === tenantId ? rel : undefined;
  }

  async relationshipsTouching(tenantId: string, ids: string[]): Promise<Relationship[]> {
    const idSet = new Set(ids);
    const out: Relationship[] = [];
    for (const rel of this.relationships.values()) {
      if (rel.tenantId !== tenantId) continue;
      if (idSet.has(rel.fromId) || idSet.has(rel.toId)) out.push(rel);
    }
    return out;
  }

  async deleteEntity(caller: Caller, id: string): Promise<boolean> {
    const entity = this.entities.get(id);
    if (!entity || !canRead(caller, entity)) return false;
    this.entities.delete(id);
    this.chunks.delete(id);
    for (const [relId, rel] of this.relationships) {
      if (rel.fromId === id || rel.toId === id) this.relationships.delete(relId);
    }
    return true;
  }

  async neighbors(
    caller: Caller,
    entityId: string,
    type?: RelationshipType,
  ): Promise<NeighborHit[]> {
    const hits: NeighborHit[] = [];
    for (const rel of this.relationships.values()) {
      if (rel.tenantId !== caller.tenantId) continue;
      if (type && rel.type !== type) continue;
      const direction = rel.fromId === entityId ? 'out' : rel.toId === entityId ? 'in' : undefined;
      if (!direction) continue;
      const other = this.entities.get(direction === 'out' ? rel.toId : rel.fromId);
      if (other && canRead(caller, other)) {
        hits.push({ relationship: rel, entity: other, direction });
      }
    }
    return hits;
  }

  async getSetting(tenantId: string, key: string): Promise<string | undefined> {
    return this.settings.get(`${tenantId} ${key}`);
  }

  async setSetting(tenantId: string, key: string, value: string): Promise<void> {
    this.settings.set(`${tenantId} ${key}`, value);
  }

  async deleteSetting(tenantId: string, key: string): Promise<void> {
    this.settings.delete(`${tenantId} ${key}`);
  }
}
