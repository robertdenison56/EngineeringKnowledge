import type { Chunk, Entity, EntityType, Relationship, RelationshipType, SourceAnchor } from './ontology.js';
import type { RetrievalRole } from './roles.js';

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
  /**
   * Optional retrieval role (focus lens). When set, the store multiplies the
   * fused score of items the role favors by its weight — a pure re-rank over
   * the already-admitted candidate set, never a filter (PRD P0-8).
   */
  boostRole?: RetrievalRole;
  /**
   * Graph-expansion: also surface 1-hop neighbors of the strongest matches (the
   * knowledge-graph payoff — a query that lands on a spec section can surface
   * the detail it references). Defaults on. Expansion only fires when the honest
   * gate already admitted a direct match, and neighbors join at a low weight, so
   * no_results stays no_results and a neighbor never outranks a real match (P0-8).
   */
  expand?: boolean;
}

export interface NeighborHit {
  relationship: Relationship;
  entity: Entity;
  direction: 'out' | 'in';
}

/**
 * Outcome of folding a duplicate entity into a survivor (PRD P0-9 merge).
 * `repointed` edges now hang off the survivor; `dropped` edges were discarded
 * because the repoint turned them into self-loops or duplicates of an edge the
 * survivor already had.
 */
export interface MergeResult {
  survivorId: string;
  repointed: number;
  dropped: number;
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
  /**
   * Remove a single relationship by id (curator edit, PRD P0-9). Returns false
   * if it is missing or either endpoint is invisible to the caller — you cannot
   * delete an edge whose existence you are not allowed to see (PRD P0-7).
   */
  deleteRelationship(caller: Caller, id: string): Promise<boolean>;
  /**
   * Fold a duplicate entity into a survivor (PRD P0-9 curation merge): repoint
   * every relationship touching the duplicate onto the survivor, drop edges that
   * the repoint turns into self-loops or duplicates of one the survivor already
   * has, then delete the duplicate and its chunks. This primitive owns only the
   * graph topology the app cannot rewrite without a full edge view; reconciling
   * the two entities' fields (title/tags/aliases) is a curation decision the
   * caller makes via `upsertEntity` on the survivor beforehand. Returns undefined
   * if either id is missing/invisible, or the two ids are the same.
   */
  mergeEntities(
    caller: Caller,
    survivorId: string,
    duplicateId: string,
  ): Promise<MergeResult | undefined>;
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
  /** Follow relationships from an entity (MCP `traverse` tool, PRD P0-3). */
  neighbors(caller: Caller, entityId: string, type?: RelationshipType): Promise<NeighborHit[]>;
  /**
   * The relationship with `id` in the tenant, WITHOUT ACL trimming — distinct
   * from the caller-scoped reads above. Used only by the undo journal to capture
   * the exact pre-state of an edge a privileged merge/edit will mutate, since
   * those mutations are themselves visibility-independent. Never a user read.
   */
  getRelationship(tenantId: string, id: string): Promise<Relationship | undefined>;
  /**
   * Every relationship touching any of `ids` within the tenant, WITHOUT ACL
   * trimming — the journal-capture counterpart to {@link neighbors}. A merge or
   * delete repoints/drops every touching edge regardless of the caller's
   * visibility, so undo must snapshot the same superset or it would silently
   * lose a partially-visible edge (one whose far endpoint the caller can't see).
   * Never a user read.
   */
  relationshipsTouching(tenantId: string, ids: string[]): Promise<Relationship[]>;
  /**
   * Tenant-scoped workspace settings — a small key→value store for config
   * that belongs to the firm rather than the graph (e.g. the firm's display
   * name). Set by an admin in the workspace app (PRD P0-9); like every other
   * read, lookups are scoped to a single tenant. Returns undefined when unset.
   */
  getSetting(tenantId: string, key: string): Promise<string | undefined>;
  setSetting(tenantId: string, key: string, value: string): Promise<void>;
  /**
   * Remove a tenant setting entirely (no-op if unset). Distinct from setting an
   * empty value: undo of a setting an operation *created* must leave it truly
   * absent, so `getSetting` reads undefined again and config falls back to its
   * default (PRD P0-9 undo).
   */
  deleteSetting(tenantId: string, key: string): Promise<void>;
}
