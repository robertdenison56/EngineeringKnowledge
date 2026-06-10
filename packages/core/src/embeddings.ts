import type { Entity } from './ontology.js';

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

/** What gets embedded for an entity — capped so giant documents don't dominate. */
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
