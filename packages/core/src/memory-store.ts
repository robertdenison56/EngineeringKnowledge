import type { Entity, Relationship, RelationshipType } from './ontology.js';
import type { Caller, GraphStore, NeighborHit, SearchHit, SearchOptions } from './graph-store.js';
import { buildQueryGroups, canRead, matchesTagFilter, scoreEntityMatch, warningFor } from './matching.js';

/**
 * Development/test implementation of GraphStore. Naive term-match scoring
 * stands in for the production hybrid retrieval; ACL and tenant trimming are
 * real and match the production contract (PRD P0-7).
 */
export class InMemoryGraphStore implements GraphStore {
  private entities = new Map<string, Entity>();
  private relationships = new Map<string, Relationship>();

  async upsertEntity(entity: Entity): Promise<void> {
    this.entities.set(entity.id, entity);
  }

  async upsertRelationship(rel: Relationship): Promise<void> {
    this.relationships.set(rel.id, rel);
  }

  async getEntity(caller: Caller, id: string): Promise<Entity | undefined> {
    const entity = this.entities.get(id);
    return entity && canRead(caller, entity) ? entity : undefined;
  }

  async search(caller: Caller, query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const groups = buildQueryGroups(query);
    const hits: SearchHit[] = [];
    for (const entity of this.entities.values()) {
      if (!canRead(caller, entity)) continue;
      if (options.types && !options.types.includes(entity.type)) continue;
      if (!matchesTagFilter(entity, options.tags)) continue;
      const score = scoreEntityMatch(entity, groups);
      if (score > 0) {
        hits.push({ entity, score, warning: warningFor(entity.provenance.reviewStatus) });
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

  async deleteEntity(caller: Caller, id: string): Promise<boolean> {
    const entity = this.entities.get(id);
    if (!entity || !canRead(caller, entity)) return false;
    this.entities.delete(id);
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
}
