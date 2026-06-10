import type { Entity, EntityType, Relationship, RelationshipType } from './ontology.js';

/**
 * Identity making a request. Every read is tenant-scoped and permission-
 * trimmed against it — there is deliberately no way to query without a
 * caller (PRD P0-3, P0-7).
 */
export interface Caller {
  tenantId: string;
  /** Principals the user resolves to (own id + group memberships). */
  principals: string[];
}

export interface SearchHit {
  entity: Entity;
  score: number;
  /**
   * Present when the item is superseded/deprecated. Gateways must surface
   * this prominently — flagged items are never served clean (PRD P0-8).
   */
  warning?: string;
}

export interface SearchOptions {
  types?: EntityType[];
  limit?: number;
}

export interface NeighborHit {
  relationship: Relationship;
  entity: Entity;
  direction: 'out' | 'in';
}

/**
 * Storage abstraction so the engine choice (native graph DB vs relational +
 * graph layer) can be settled by the Open Question 1 spike without blocking
 * Phase 1. All Phase 1 code targets this interface.
 */
export interface GraphStore {
  upsertEntity(entity: Entity): Promise<void>;
  upsertRelationship(rel: Relationship): Promise<void>;
  getEntity(caller: Caller, id: string): Promise<Entity | undefined>;
  search(caller: Caller, query: string, options?: SearchOptions): Promise<SearchHit[]>;
  /** Browse without a query (workspace-app faceted browse, PRD P0-9). */
  list(caller: Caller, options?: SearchOptions): Promise<Entity[]>;
  /** Follow relationships from an entity (MCP `traverse` tool, PRD P0-3). */
  neighbors(caller: Caller, entityId: string, type?: RelationshipType): Promise<NeighborHit[]>;
}
