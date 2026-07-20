import type { Caller } from './graph-store.js';
import type { Chunk, Entity, ReviewStatus } from './ontology.js';
import type { RetrievalRole } from './roles.js';

/**
 * Shared retrieval semantics used by every GraphStore implementation, so the
 * P0-7/P0-8 contract (permission trimming, honest matching, warnings on
 * flagged items) is identical regardless of storage engine.
 */

export const REVIEW_WARNINGS: Partial<Record<ReviewStatus, string>> = {
  superseded:
    'This item has been superseded. Consult the replacement (see "supersedes" relationships) before relying on it.',
  deprecated: 'This item is deprecated and must not be used on new work.',
  unverified:
    'This item is an unverified candidate awaiting curator review — do not present it as established firm knowledge.',
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
 * MasterFormat section codes are the precision identifiers AEC search runs on
 * (07 84 00, 09 91 23.13), but they get written with every separator —
 * "07 84 00", "07.84.00", "07-84-00", "078400". Collapse the 2-2-2 (and the
 * level-4 2-2-2-2) pattern to one atomic token so every spelling matches the
 * same way. Without this they split into per-pair tokens that each have to
 * AND-match, so the compact form "078400" missed the spaced form entirely and
 * the spaced form only matched by accidental substring ("07" inside any number).
 * Runs on already-lowercased text, before hyphen stripping, so the identical
 * canonical token lands in both the query groups and the indexed haystack
 * (ADR 0003 precision identifiers).
 */
const SECTION_CODE = /\b\d{2}[ .-]\d{2}[ .-]\d{2}(?:[ .-]\d{2})?\b/g;

export function canonicalizeIdentifiers(text: string): string {
  return text.replace(SECTION_CODE, (code) => code.replace(/[ .-]/g, ''));
}

/**
 * Lowercase, strip diacritics and hyphens, and canonicalize section codes, so
 * "Façade" matches "facade", "fire-stopping" matches "firestopping", and every
 * spelling of "07 84 00" matches "078400".
 */
export function normalizeText(text: string): string {
  const lowered = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  return canonicalizeIdentifiers(lowered).replace(/-/g, '');
}

const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'any', 'anyone', 'are', 'at', 'been', 'brief',
  'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have',
  'how', 'in', 'is', 'it', 'its', 'know', 'knows', 'me', 'my', 'of', 'on',
  'or', 'our', 'say', 'says', 'should', 'tell', 'the', 'their', 'there',
  'they', 'this', 'to', 'us', 'was', 'we', 'went', 'what', 'when', 'where',
  'which', 'who', 'would', 'with', 'wrong', 'your',
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

/**
 * Singular-candidate variants for a plural-looking token, so "firestops"
 * matches a corpus that says "firestop" (the reverse direction — singular
 * query, plural corpus — already works by substring). Deliberately dumb
 * English suffix stripping: "ies" → "y", "es" → drop "es" and drop "s",
 * trailing "s" (but not "ss" — "glass" is not a plural) → drop "s".
 * Nonsense candidates ("serie") are harmless — they simply never match —
 * but candidates shorter than 3 characters are dropped: a 1–2 character
 * variant substring-matches almost any haystack and would quietly turn a
 * concept group into an always-true clause (P0-8).
 */
function singularCandidates(token: string): string[] {
  const out: string[] = [];
  if (token.endsWith('ies')) out.push(`${token.slice(0, -3)}y`);
  else if (token.endsWith('es') && !token.endsWith('ss')) {
    out.push(token.slice(0, -2), token.slice(0, -1));
  } else if (token.endsWith('s') && !token.endsWith('ss')) {
    out.push(token.slice(0, -1));
  }
  return out.filter((v) => v.length >= 3);
}

/**
 * One group per query concept: [token, ...synonyms, ...singular candidates].
 * Stopwords dropped. Variants within a group OR together, so plural folding
 * (like synonyms) widens wording without weakening the cross-group AND.
 */
export function buildQueryGroups(query: string): string[][] {
  return normalizeText(query)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .map((t) => [...new Set([t, ...(AEC_SYNONYMS[t] ?? []), ...singularCandidates(t)])]);
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

/**
 * Minimum number of concept groups a relaxed match must still satisfy, or 0
 * when the query is too short to relax at all. Queries under three concepts
 * never relax — with one or two concepts, "most concepts matched" is
 * indistinguishable from "one word happened to appear", and the honest
 * no_results state (PRD P0-8) must win. From three concepts up, a majority
 * (never fewer than two) must match.
 */
export function relaxationThreshold(groupCount: number): number {
  if (groupCount < 3) return 0;
  return Math.max(2, Math.floor(groupCount / 2));
}

/**
 * Most-concepts-match fallback for queries whose full AND finds nothing —
 * the "curtain wall firestop detail Riverside" case, where the concepts are
 * real but split across entities. Same haystack and normalization as
 * `scoreEntityMatch`; a group counts as matched when any of its variants
 * appears. Score is 0 below `relaxationThreshold` (including queries too
 * short to relax); otherwise it is the matched-group count plus a boost per
 * matched group that also hits the title/aliases, mirroring the strict
 * scorer. Honesty (PRD P0-8) is preserved by how stores use this, not by the
 * scorer itself: the relaxed pass runs only after the strict pipeline
 * admitted nothing, and every hit it admits is disclosed as partial via
 * `SearchHit.partial` — a relaxed match is never served as a full match.
 */
export function relaxedScoreEntityMatch(
  entity: Entity,
  groups: string[][],
): { score: number; matchedGroups: number[] } {
  const threshold = relaxationThreshold(groups.length);
  const haystack = entityHaystack(entity);
  const matchedGroups: number[] = [];
  groups.forEach((g, i) => {
    if (g.some((v) => haystack.includes(v))) matchedGroups.push(i);
  });
  if (threshold === 0 || matchedGroups.length < threshold) {
    return { score: 0, matchedGroups };
  }
  const title = normalizeText(`${entity.title} ${(entity.aliases ?? []).join(' ')}`);
  const titleHits = matchedGroups.filter((i) => groups[i].some((v) => title.includes(v))).length;
  return { score: matchedGroups.length + titleHits, matchedGroups };
}

/**
 * The reportable name of a concept group — its original query token (variants
 * are synonyms/foldings of it). Used to populate `SearchHit.partial`'s
 * matched/missing concept lists so partial disclosure speaks the user's words.
 */
export function groupConcept(group: string[]): string {
  return group[0];
}

/**
 * Whether a retrieval role favors this entity — it carries one of the role's
 * boost tags, or is one of its boost types. Tag/type membership only; no text
 * scan (P0-8 honesty lives in the admission gate, not here).
 */
export function entityMatchesRole(entity: Entity, role: RetrievalRole): boolean {
  return (
    role.boostTypes.includes(entity.type) ||
    (entity.tags ?? []).some((t) => role.boostTags.includes(t))
  );
}

/**
 * Ranking multiplier a role applies to an entity — the role's `weight` when it
 * favors the entity, else 1 (no role, or no match). Applied alongside the
 * review-status multiplier in each store's fusion step: it only ever scales the
 * score of an already-admitted candidate, so a role can neither admit an item
 * no concept matched nor hide one that did (PRD P0-7/P0-8 unaffected).
 */
export function roleBoostFactor(entity: Entity, role?: RetrievalRole): number {
  return role && entityMatchesRole(entity, role) ? role.weight : 1;
}

/** Heading + body of a chunk, normalized — the chunk-level haystack. */
export function chunkHaystack(chunk: Chunk): string {
  return normalizeText(`${chunk.heading ?? ''} ${chunk.text}`);
}

/**
 * Same honesty contract as `scoreEntityMatch`, applied to a single passage:
 * every concept must co-occur in this chunk (ADR 0006). Stricter than the
 * entity gate — concepts scattered across 400 pages do not pass — so chunk
 * hits are precise, and rolling them up to the parent never admits an entity
 * no concept matched. Heading hits boost.
 */
export function scoreChunkMatch(chunk: Chunk, groups: string[][]): number {
  if (groups.length === 0) return 0;
  const haystack = chunkHaystack(chunk);
  if (!groups.every((g) => g.some((v) => haystack.includes(v)))) return 0;
  const heading = normalizeText(chunk.heading ?? '');
  return groups.length + groups.filter((g) => g.some((v) => heading.includes(v))).length;
}

/**
 * A short text window centered on the first matched concept, for citation
 * snippets. Operates on the original (un-normalized) text so the snippet
 * reads naturally; falls back to the opening when no variant is locatable
 * (normalization can shift offsets).
 */
export function snippetForGroups(text: string, groups: string[][], radius = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const lower = clean.toLowerCase();
  let at = -1;
  for (const group of groups) {
    for (const variant of group) {
      const i = lower.indexOf(variant);
      if (i >= 0 && (at === -1 || i < at)) at = i;
    }
  }
  if (at === -1) return clean.slice(0, radius * 2).trim();
  const start = Math.max(0, at - radius);
  const end = Math.min(clean.length, at + radius);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end).trim()}${end < clean.length ? '…' : ''}`;
}
