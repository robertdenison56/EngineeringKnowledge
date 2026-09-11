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
  DEFAULT_SEARCH_LIMIT,
  bestCitationChunk,
  buildQueryGroups,
  canRead,
  chunkMatch,
  groupConcept,
  matchesTagFilter,
  relaxationThreshold,
  partialDisclosure,
  relaxedScoreEntityMatch,
  roleBoostFactor,
  scoreChunkMatch,
  scoreEntityMatch,
  warningFor,
  type ChunkCoverage,
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
    const exact: SearchHit[] = [];
    // Candidates for the partial band: a document whose best passage carries
    // enough of the query to be cited, or whose metadata carries most of it.
    // Kept apart from `exact` so the two can be ranked as what they are.
    const partial: { entity: Entity; cite?: ChunkCoverage; order: number }[] = [];
    let order = 0;
    const eligible: Entity[] = [];
    for (const entity of this.entities.values()) {
      if (!canRead(caller, entity)) continue;
      if (options.types && !options.types.includes(entity.type)) continue;
      if (!matchesTagFilter(entity, options.tags)) continue;
      eligible.push(entity);

      // Entity-level match (metadata + content preview) OR a chunk match —
      // a concept hit in any passage admits the parent (ADR 0006). The chunk
      // gate is per-passage, so this never admits an entity no concept hit.
      const entityScore = scoreEntityMatch(entity, groups);
      let bestChunk: { chunk: Chunk; score: number } | undefined;
      for (const chunk of this.chunks.get(entity.id) ?? []) {
        const cs = scoreChunkMatch(chunk, groups);
        if (cs > 0 && (!bestChunk || cs > bestChunk.score)) bestChunk = { chunk, score: cs };
      }
      // Citation only, and strictly downstream of the gates: an all-concepts
      // passage when one exists, else the best-coverage passage. Picking it can
      // never admit, drop, or reorder an entity.
      const cite: ChunkCoverage | undefined = bestChunk
        ? { chunk: bestChunk.chunk, matched: groups.length, total: groups.length }
        : bestCitationChunk(this.chunks.get(entity.id) ?? [], groups);
      const baseScore = Math.max(entityScore, bestChunk?.score ?? 0);
      if (baseScore > 0) {
        // Role re-rank: scale an admitted item's score when the active lens
        // favors it. Applied after the gate, so it never admits a non-match.
        exact.push({
          entity,
          score: baseScore * roleBoostFactor(entity, options.boostRole),
          warning: warningFor(entity.provenance.reviewStatus),
          ...(cite ? { chunk: chunkMatch(cite, groups) } : {}),
        });
      } else if (cite) {
        // Page-first admission, the same contract the SQLite store applies: a
        // passage that carries enough of the query to be CITED may admit its
        // parent, even though no single passage carries every concept and the
        // bounded preview does not either. For a whole-sentence question
        // against a long document this is the only path to the answering page.
        partial.push({ entity, cite, order: order++ });
      }
    }

    // Partial band: page-coverage hits, then the entity-level most-concepts
    // fallback for documents with no passage to cite (short items, and corpora
    // with no chunks at all). Both are partial matches, so both are disclosed,
    // both need `relax`, and both rank below every exact hit.
    if (options.relax !== false && relaxationThreshold(groups.length) > 0) {
      const seen = new Set(partial.map((c) => c.entity.id));
      for (const entity of eligible) {
        if (seen.has(entity.id) || exact.some((h) => h.entity.id === entity.id)) continue;
        if (relaxedScoreEntityMatch(entity, groups).score <= 0) continue;
        partial.push({ entity, order: order++ });
      }
    }

    exact.sort((a, b) => b.score - a.score);
    const band =
      options.relax === false
        ? []
        : partial
            .map((c) => {
              const disclosure = partialDisclosure(c.entity, c.cite?.chunk, groups);
              // One rule for the whole band, whichever pass found it: how much
              // of the query this result actually covers, counting the document
              // and the passage it offers to cite.
              const covered = groups.length - (disclosure?.missingConcepts.length ?? 0);
              return {
                hit: {
                  entity: c.entity,
                  score: covered * roleBoostFactor(c.entity, options.boostRole),
                  warning: warningFor(c.entity.provenance.reviewStatus),
                  ...(c.cite ? { chunk: chunkMatch(c.cite, groups) } : {}),
                  ...(disclosure ? { partial: disclosure } : {}),
                } as SearchHit,
                covered,
                order: c.order,
              };
            })
            .sort((a, b) => b.hit.score - a.hit.score || a.order - b.order)
            .map((c) => c.hit);
    // Bands concatenated, never interleaved: an all-concepts match always
    // outranks a page-coverage or most-concepts one (PRD P0-8 — a partial hit
    // is disclosed as partial AND never displaces a full match).
    return [...exact, ...band].slice(0, options.limit ?? DEFAULT_SEARCH_LIMIT);
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
