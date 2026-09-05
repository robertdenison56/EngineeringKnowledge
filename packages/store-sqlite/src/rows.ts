import type { Chunk, Entity, Relationship } from '@ekg/core';

/** Column shapes of the persisted tables (see the baseline DDL in schema.ts). */
export interface EntityRow {
  id: string;
  tenant_id: string;
  type: string;
  title: string;
  summary: string | null;
  properties: string;
  tags: string | null;
  aliases: string | null;
  content: string | null;
  embedding: string | null;
  embedding_provider: string | null;
  provenance: string;
  acl: string;
}

export interface RelationshipRow {
  id: string;
  tenant_id: string;
  type: string;
  from_id: string;
  to_id: string;
  properties: string | null;
}

export interface ChunkRow {
  id: string;
  entity_id: string;
  tenant_id: string;
  ordinal: number;
  anchor: string | null;
  heading: string | null;
  text: string;
  embedding: string | null;
  embedding_provider: string | null;
}

export function rowToChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    entityId: row.entity_id,
    tenantId: row.tenant_id,
    ordinal: row.ordinal,
    anchor: row.anchor ? JSON.parse(row.anchor) : {},
    text: row.text,
    ...(row.heading ? { heading: row.heading } : {}),
  };
}

export function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    title: row.title,
    summary: row.summary ?? undefined,
    properties: JSON.parse(row.properties),
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    aliases: row.aliases ? JSON.parse(row.aliases) : undefined,
    content: row.content ?? undefined,
    provenance: JSON.parse(row.provenance),
    acl: JSON.parse(row.acl),
  };
}

export function rowToRelationship(row: RelationshipRow): Relationship {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    fromId: row.from_id,
    toId: row.to_id,
    properties: row.properties ? JSON.parse(row.properties) : undefined,
  };
}
