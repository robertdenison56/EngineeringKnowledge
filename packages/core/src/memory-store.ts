import type { Entity, Relationship, RelationshipType, ReviewStatus } from './ontology.js';
import type { Caller, GraphStore, NeighborHit, SearchHit, SearchOptions } from './graph-store.js';

const REVIEW_WARNINGS: Partial<Record<ReviewStatus, string>> = {
  superseded:
    'This item has been superseded. Consult the replacement (see "supersedes" relationships) before relying on it.',
  deprecated: 'This item is deprecated and must not be used on new work.',
};

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

  private canRead(caller: Caller, entity: Entity): boolean {
    if (entity.tenantId !== caller.tenantId) return false;
    const allowed = entity.acl.allowedPrincipals;
    return allowed.includes('*') || allowed.some((p) => caller.principals.includes(p));
  }

  async getEntity(caller: Caller, id: string): Promise<Entity | undefined> {
    const entity = this.entities.get(id);
    return entity && this.canRead(caller, entity) ? entity : undefined;
  }

  async search(caller: Caller, query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits: SearchHit[] = [];
    for (const entity of this.entities.values()) {
      if (!this.canRead(caller, entity)) continue;
      if (options.types && !options.types.includes(entity.type)) continue;
      const haystack = [entity.title, entity.summary ?? '', JSON.stringify(entity.properties)]
        .join(' ')
        .toLowerCase();
      // All terms must match (AND): partial matches would surface unrelated
      // items and defeat the honest no_results state (PRD P0-8).
      if (!terms.every((t) => haystack.includes(t))) continue;
      const title = entity.title.toLowerCase();
      const score = terms.length + terms.filter((t) => title.includes(t)).length;
      hits.push({ entity, score, warning: REVIEW_WARNINGS[entity.provenance.reviewStatus] });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, options.limit ?? 10);
  }

  async list(caller: Caller, options: SearchOptions = {}): Promise<Entity[]> {
    const out: Entity[] = [];
    for (const entity of this.entities.values()) {
      if (!this.canRead(caller, entity)) continue;
      if (options.types && !options.types.includes(entity.type)) continue;
      out.push(entity);
      if (out.length >= (options.limit ?? 100)) break;
    }
    return out;
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
      if (other && this.canRead(caller, other)) {
        hits.push({ relationship: rel, entity: other, direction });
      }
    }
    return hits;
  }
}
