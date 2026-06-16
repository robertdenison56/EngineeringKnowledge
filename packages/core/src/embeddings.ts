import type { Chunk, Entity } from './ontology.js';

/**
 * Pluggable dense-retrieval interface. Stores accept any provider; firms
 * with confidentiality constraints run a local model (e.g. Ollama), others
 * use an API (Voyage, OpenAI). No provider → lexical-only retrieval.
 */
export interface EmbeddingProvider {
  /** Stable identifier (provider:model) stored next to each vector. */
  readonly id: string;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * What gets embedded for an entity — title/summary/metadata plus the content
 * preview. For long documents the per-chunk vectors (`chunkEmbeddingText`)
 * carry deep retrieval; this entity-level vector covers short entities and
 * whole-document gist (ADR 0006).
 */
export function embeddingText(entity: Entity): string {
  return [
    entity.title,
    entity.summary ?? '',
    (entity.aliases ?? []).join(' '),
    (entity.tags ?? []).join(' '),
    (entity.content ?? '').slice(0, 2000),
  ]
    .filter(Boolean)
    .join('\n');
}

/** What gets embedded for one passage — heading for context, then the body. */
export function chunkEmbeddingText(chunk: Chunk): string {
  return [chunk.heading ?? '', chunk.text].filter(Boolean).join('\n').slice(0, 2000);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
