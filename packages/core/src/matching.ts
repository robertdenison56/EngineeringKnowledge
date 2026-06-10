import type { Caller } from './graph-store.js';
import type { Entity, ReviewStatus } from './ontology.js';

/**
 * Shared retrieval semantics used by every GraphStore implementation, so the
 * P0-7/P0-8 contract (permission trimming, honest matching, warnings on
 * flagged items) is identical regardless of storage engine.
 */

export const REVIEW_WARNINGS: Partial<Record<ReviewStatus, string>> = {
  superseded:
    'This item has been superseded. Consult the replacement (see "supersedes" relationships) before relying on it.',
  deprecated: 'This item is deprecated and must not be used on new work.',
};

export function warningFor(status: ReviewStatus): string | undefined {
  return REVIEW_WARNINGS[status];
}

/** Tenant + ACL check (PRD P0-7). `"*"` in the ACL means tenant-public. */
export function canRead(caller: Caller, entity: Entity): boolean {
  if (entity.tenantId !== caller.tenantId) return false;
  const allowed = entity.acl.allowedPrincipals;
  return allowed.includes('*') || allowed.some((p) => caller.principals.includes(p));
}

/**
 * Lowercase, strip diacritics and hyphens, so "Façade" matches "facade"
 * and "fire-stopping" matches "firestopping".
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/-/g, '');
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'did', 'do', 'for', 'from', 'how', 'in',
  'is', 'of', 'on', 'or', 'our', 'the', 'to', 'was', 'we', 'went', 'what',
  'when', 'where', 'which', 'who', 'with', 'wrong',
]);

/**
 * Small, defensible AEC synonym dictionary applied at query time. Within a
 * term group any variant may match (OR); across groups all concepts must
 * match (AND) — synonyms widen wording, never weaken the honesty contract.
 * Entity-level `aliases` handle item-specific vocabulary.
 */
export const AEC_SYNONYMS: Record<string, string[]> = {
  firestop: ['firestopping', 'safing'],
  firestopping: ['firestop', 'safing'],
  safing: ['firestop', 'firestopping'],
  spec: ['specification'],
  specification: ['spec'],
  specifications: ['spec'],
  drawing: ['sheet'],
  facade: ['envelope'],
};

/** One group per query concept: [token, ...synonyms]. Stopwords dropped. */
export function buildQueryGroups(query: string): string[][] {
  return normalizeText(query)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .map((t) => [t, ...(AEC_SYNONYMS[t] ?? [])]);
}

/** Tag filter: entity must carry every requested tag (SearchOptions.tags). */
export function matchesTagFilter(entity: Entity, tags?: string[]): boolean {
  if (!tags || tags.length === 0) return true;
  const own = entity.tags ?? [];
  return tags.every((t) => own.includes(t));
}

/** Everything searchable about an entity, normalized. */
export function entityHaystack(entity: Entity): string {
  return normalizeText(
    [
      entity.title,
      entity.summary ?? '',
      (entity.aliases ?? []).join(' '),
      (entity.tags ?? []).join(' '),
      entity.content ?? '',
      JSON.stringify(entity.properties),
    ].join(' '),
  );
}

/**
 * AND-match across concept groups, OR within a group's synonyms. Score 0
 * means no hit — partial concept matches would surface unrelated items and
 * defeat the honest no_results state (PRD P0-8). Title/alias hits boost.
 */
export function scoreEntityMatch(entity: Entity, groups: string[][]): number {
  if (groups.length === 0) return 0;
  const haystack = entityHaystack(entity);
  if (!groups.every((g) => g.some((v) => haystack.includes(v)))) return 0;
  const title = normalizeText(`${entity.title} ${(entity.aliases ?? []).join(' ')}`);
  return groups.length + groups.filter((g) => g.some((v) => title.includes(v))).length;
}
