/**
 * AEC-native ontology (PRD P0-1).
 *
 * Built-in entity and relationship types cover the v1 ontology; both unions
 * leave room for tenant-defined custom types, which P0-1 requires to work
 * without code changes.
 */

/** Review lifecycle every knowledge item carries (PRD P0-1, P0-8). */
export type ReviewStatus = 'unverified' | 'verified' | 'superseded' | 'deprecated';

export const ENTITY_TYPES = [
  'project',
  'document',
  'design-detail',
  'spec-section',
  'standard',
  'lesson-learned',
  'rfi',
  'person',
  'client',
  'material',
  'discipline',
] as const;

export type BuiltInEntityType = (typeof ENTITY_TYPES)[number];
export type EntityType = BuiltInEntityType | (string & {});

export const RELATIONSHIP_TYPES = [
  'used-in',
  'supersedes',
  'authored-by',
  'complies-with',
  'had-issue',
  'applies-to',
  /**
   * Document-to-document cross-reference, e.g. a callout bubble on one
   * drawing sheet pointing at a detail on another (ingestion Phase B). A
   * drawing set becomes a navigable graph instead of a pile of files.
   */
  'references',
] as const;

export type BuiltInRelationshipType = (typeof RELATIONSHIP_TYPES)[number];
export type RelationshipType = BuiltInRelationshipType | (string & {});

/**
 * Where a document-derived item lives inside its source file (PRD P0-2a).
 * Citations must resolve to the page/sheet, never just the file.
 */
export interface SourceAnchor {
  page?: number;
  /** Drawing sheet number, e.g. "A-501". */
  sheet?: string;
  /** MasterFormat section number for spec-book items, e.g. "07 84 00". */
  specSection?: string;
}

export interface Provenance {
  /** Deep link to the item in its source system (SharePoint, Procore, …). */
  sourceUrl?: string;
  author?: string;
  /** ISO 8601 timestamps. */
  createdAt: string;
  modifiedAt: string;
  reviewStatus: ReviewStatus;
  anchor?: SourceAnchor;
}

/**
 * Principals (user/group identifiers, Entra object ids in production) allowed
 * to read an item. `"*"` means tenant-public (PRD P0-7).
 */
export interface Acl {
  allowedPrincipals: string[];
}

export interface Entity {
  id: string;
  tenantId: string;
  type: EntityType;
  title: string;
  summary?: string;
  /** Type-specific attributes; schema is tenant-extensible. */
  properties: Record<string, unknown>;
  /**
   * Free-form, multi-valued labels for cross-cutting facets (discipline,
   * system, hazard, market…). Assigned by curators, capture forms, and the
   * ingestion parser; searchable and filterable everywhere.
   */
  tags?: string[];
  /**
   * Alternate names and domain synonyms ("safing", "perimeter fire
   * barrier") so retrieval finds knowledge however the engineer words it.
   */
  aliases?: string[];
  /**
   * Extracted source-document text (P0-2a pipeline output). Searchable, and
   * shown in the workspace app so users can verify answers against the
   * exact document.
   */
  content?: string;
  provenance: Provenance;
  acl: Acl;
}

export interface Relationship {
  id: string;
  tenantId: string;
  type: RelationshipType;
  fromId: string;
  toId: string;
  properties?: Record<string, unknown>;
}

/**
 * A retrievable passage of a document, owned by its parent entity (ADR 0006).
 * Long documents — 400-page spec books, multi-sheet plan sets — are too big
 * for one searchable/embeddable unit: a hit must resolve to the page or spec
 * section, not the whole file (P0-2a), and one vector cannot represent
 * hundreds of pages. Chunks carry the authoritative full text, each its own
 * FTS row and embedding and `anchor`; the parent entity keeps only a bounded
 * preview. Chunks are not entities — they inherit the parent's ACL and review
 * status and are never curated or traversed on their own.
 */
export interface Chunk {
  /** Stable within the document, e.g. `${entityId}#${ordinal}`. */
  id: string;
  entityId: string;
  tenantId: string;
  /** Position within the parent document (page order / section order). */
  ordinal: number;
  /** Where this passage lives in the source — the citation target. */
  anchor: SourceAnchor;
  /** Human label, e.g. "Sheet L-1" or "07 92 00 · PART 2 — PRODUCTS". */
  heading?: string;
  text: string;
}
