import type { Chunk, Entity, EntityType, Relationship, RelationshipType, SourceAnchor } from './ontology.js';

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

/**
 * The passage a hit matched on (ADR 0006). Lets gateways cite the page or
 * spec section, not just the file (P0-2a), when the match came from a
 * document chunk rather than the entity's own metadata.
 */
export interface ChunkMatch {
  anchor: SourceAnchor;
  heading?: string;
  /** Text window around the matched concepts, for the citation snippet. */
  snippet: string;
  ordinal: number;
}

export interface SearchHit {
  entity: Entity;
  score: number;
  /**
   * Present when the item is superseded/deprecated. Gateways must surface
   * this prominently — flagged items are never served clean (PRD P0-8).
   */
  warning?: string;
  /** Best-matching passage when the hit came from a chunk (ADR 0006). */
  chunk?: ChunkMatch;
}

export interface SearchOptions {
  types?: EntityType[];
  /** Entities must carry every listed tag. */
  tags?: string[];
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
  /**
   * Upsert an entity and, optionally, replace its document chunks (ADR 0006).
   * `chunks` omitted leaves existing chunks untouched — a curation re-upsert
   * that only flips `reviewStatus` must not wipe the searchable text. Pass
   * `[]` to clear chunks explicitly.
   */
  upsertEntity(entity: Entity, chunks?: Chunk[]): Promise<void>;
  upsertRelationship(rel: Relationship): Promise<void>;
  getEntity(caller: Caller, id: string): Promise<Entity | undefined>;
  /** A document's passages in order, permission-trimmed via its parent. */
  getChunks(caller: Caller, entityId: string): Promise<Chunk[]>;
  search(caller: Caller, query: string, options?: SearchOptions): Promise<SearchHit[]>;
  /** Browse without a query (workspace-app faceted browse, PRD P0-9). */
  list(caller: Caller, options?: SearchOptions): Promise<Entity[]>;
  /**
   * Remove an entity and every relationship touching it (curation reject,
   * PRD P0-9). Returns false if the entity is missing or not visible to the
   * caller.
   */
  deleteEntity(caller: Caller, id: string): Promise<boolean>;
  /**
   * All relationships whose BOTH endpoints are visible to the caller —
   * edges must never leak the existence of hidden entities (PRD P0-7).
   * Powers the workspace app's full-graph knowledge map (PRD P0-9).
   */
  listRelationships(caller: Caller): Promise<Relationship[]>;
  /**
   * Remove a single relationship (curation edge fix, PRD P0-1/P0-9). The
   * caller must be able to read both endpoints — the same visibility rule as
   * listRelationships, so an edge a caller cannot see cannot be deleted.
   * Returns false if the relationship is missing or not visible.
   */
  deleteRelationship(caller: Caller, id: string): Promise<boolean>;
  /**
   * Merge `duplicateId` into `survivorId` (curation merge, PRD P0-9):
   * every relationship touching the duplicate is repointed onto the survivor
   * (self-loops and edges that would duplicate an existing survivor edge are
   * dropped), then the duplicate entity and its chunks are removed. Field-
   * level merging (tags, aliases, summary) is the caller's job before
   * invoking. Returns false — changing nothing — unless both entities are
   * visible to the caller and distinct.
   */
  mergeEntities(caller: Caller, survivorId: string, duplicateId: string): Promise<boolean>;
  /** Follow relationships from an entity (MCP `traverse` tool, PRD P0-3). */
  neighbors(caller: Caller, entityId: string, type?: RelationshipType): Promise<NeighborHit[]>;
  /**
   * Tenant-scoped workspace settings — a small key→value store for config
   * that belongs to the firm rather than the graph (e.g. the firm's display
   * name). Set by an admin in the workspace app (PRD P0-9); like every other
   * read, lookups are scoped to a single tenant. Returns undefined when unset.
   */
  getSetting(tenantId: string, key: string): Promise<string | undefined>;
  setSetting(tenantId: string, key: string, value: string): Promise<void>;
}
