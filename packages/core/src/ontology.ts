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
