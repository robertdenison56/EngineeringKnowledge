import type { Caller, ChunkMatch } from './graph-store.js';
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

/**
 * Shortest variant allowed to match inside a token rather than at its start.
 * Six is chosen from the two cases that pull in opposite directions: "stopping"
 * (8) must match "firestopping", and "air" (3) must NOT match "stair"/"repair".
 * Anything this long is a real trade term whose appearance inside a compound is
 * almost certainly the same concept; anything shorter is a syllable.
 */
const COMPOUND_TAIL_MIN = 6;

/**
 * Whether a concept variant occurs in normalized text as a *word*, not an
 * accident of spelling. Replaces the raw `includes()` the matcher used to do,
 * which admitted any substring anywhere: a query for "air" matched "stair tread
 * repair", and short tokens quietly turned concept groups into always-true
 * clauses — a precision leak that lands directly on the honest-results contract
 * (PRD P0-8), since a false concept match manufactures a hit where the firm has
 * no answer.
 *
 * Pure token-boundary matching is NOT the fix, and the golden set proves it:
 * `normalizeText` strips hyphens, so "fire-stopping" and "Firestopping" both
 * normalize to the single token "firestopping" and the query concept "stopping"
 * is a standalone token nowhere in the corpus. AEC vocabulary compounds
 * constantly (firestop, curtainwall, waterproofing), so requiring token
 * boundaries would drop real matches — including the spec-book passage citation
 * the scorecard measures.
 *
 * So: a match starting at a token boundary always counts (that covers exact
 * tokens and prefixes — "spec" in "specification", "firestop" in
 * "firestopping"), and a match *inside* a token counts only when the variant is
 * at least COMPOUND_TAIL_MIN long.
 */
export function variantMatches(haystack: string, variant: string): boolean {
  if (!variant) return false;
  for (let from = 0; ; ) {
    const at = haystack.indexOf(variant, from);
    if (at < 0) return false;
    // Token start = string start, or preceded by a non-alphanumeric. Covers
    // exact-token and prefix-of-token matches.
    if (at === 0 || !/[a-z0-9]/.test(haystack[at - 1])) return true;
    if (variant.length >= COMPOUND_TAIL_MIN) return true; // compound tail
    from = at + 1; // keep looking; a later occurrence may sit at a boundary
  }
}

/** Whether any of a concept group's variants matches — the OR within a group. */
export function groupMatches(haystack: string, group: string[]): boolean {
  return group.some((v) => variantMatches(haystack, v));
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
  if (!groups.every((g) => groupMatches(haystack, g))) return 0;
  const title = normalizeText(`${entity.title} ${(entity.aliases ?? []).join(' ')}`);
  return groups.length + groups.filter((g) => groupMatches(title, g)).length;
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
    if (groupMatches(haystack, g)) matchedGroups.push(i);
  });
  if (threshold === 0 || matchedGroups.length < threshold) {
    return { score: 0, matchedGroups };
  }
  const title = normalizeText(`${entity.title} ${(entity.aliases ?? []).join(' ')}`);
  const titleHits = matchedGroups.filter((i) => groupMatches(title, groups[i])).length;
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
  if (!groups.every((g) => groupMatches(haystack, g))) return 0;
  const heading = normalizeText(chunk.heading ?? '');
  return groups.length + groups.filter((g) => groupMatches(heading, g)).length;
}

/**
 * Share of a query's concepts one passage must carry before it may be cited,
 * when no passage carries them all. Deliberately high, and deliberately a
 * fraction: a two-concept query still needs both (ceil(2 x 0.6) = 2), so short
 * precise queries keep the all-concepts contract, while a fifteen-concept
 * question needs nine.
 */
/**
 * How many results a search returns when the caller does not say.
 *
 * Ten was the right number while ranking was weak: the list had to be long
 * because the answer could be anywhere in it. With page-first ranking the
 * Caltrans benchmark finds the right document at rank 1 for 89.7% of questions
 * and inside the top three for 98.5% — results four through ten add 0.7 points
 * of document recall and 0.8 of page recall for roughly half the payload of a
 * response. Five keeps a real tail for exploratory search and stops charging
 * every caller for the other five. Callers that want a long list still ask for
 * one (the workspace app's search page asks for 25).
 */
export const DEFAULT_SEARCH_LIMIT = 5;

export const CITATION_COVERAGE_FLOOR = 0.6;

/**
 * How many of a query's concepts one passage must carry to stand on its own —
 * to be cited, and (see below) to admit its parent document.
 *
 * Degenerates to the strict all-concepts gate for short queries: one concept
 * needs one, two need both, three need two. It only loosens where loosening is
 * the honest reading — a fifteen-concept sentence whose scaffolding ("according
 * to", "what is") no passage will ever contain.
 */
export function coverageFloor(groupCount: number): number {
  return Math.ceil(groupCount * CITATION_COVERAGE_FLOOR);
}

/** How many of the query's concept groups this passage contains. */
export function chunkCoverage(chunk: Chunk, groups: string[][]): number {
  const haystack = chunkHaystack(chunk);
  return groups.filter((g) => groupMatches(haystack, g)).length;
}

/** A passage picked to cite, with how much of the query it actually carries. */
export interface ChunkCoverage {
  chunk: Chunk;
  /** Query concepts this passage contains. */
  matched: number;
  /** Query concepts in total; `matched < total` is a best-coverage pick. */
  total: number;
}

/**
 * The passage that carries most of the query, for CITATION ONLY.
 *
 * `scoreChunkMatch` asks every concept to co-occur in one passage, which is the
 * right gate for admitting a chunk hit and the wrong one for choosing what to
 * cite. A whole-sentence question tokenizes into a dozen-plus concepts —
 * "According to HDM Table 201.1, what is the minimum stopping sight distance for
 * a design speed of 45 mph" is fifteen — and the passage that answers it carries
 * the substance, not the scaffolding. Measured on the Caltrans benchmark: mean
 * 15.2 concepts per question, the best passage carries 12.6 of them, and exactly
 * one question in sixty has a passage carrying all fifteen. Under the all-or-
 * nothing rule those hits cited a file and no page, so a caller that wanted the
 * text had to fetch the whole document back.
 *
 * Callers must keep this out of admission and scoring — it may only choose among
 * passages of an entity already admitted — and must disclose `matched`/`total`
 * whenever they differ, so a best-coverage citation is never presented as an
 * all-concepts one (PRD P0-8).
 */
export function bestCitationChunk(chunks: Chunk[], groups: string[][]): ChunkCoverage | undefined {
  if (groups.length === 0) return undefined;
  const required = coverageFloor(groups.length);
  let best: (ChunkCoverage & { tiebreak: number }) | undefined;
  for (const chunk of chunks) {
    const matched = chunkCoverage(chunk, groups);
    if (matched < required) continue;
    // Ties go to the passage whose heading names the concepts — the same
    // heading bonus `scoreChunkMatch` applies.
    const heading = normalizeText(chunk.heading ?? '');
    const tiebreak = groups.filter((g) => groupMatches(heading, g)).length;
    if (!best || matched > best.matched || (matched === best.matched && tiebreak > best.tiebreak)) {
      best = { chunk, matched, total: groups.length, tiebreak };
    }
  }
  return best && { chunk: best.chunk, matched: best.matched, total: best.total };
}

/**
 * What a hit matched and what it did not, across everything the caller is being
 * shown: the document's own metadata and preview, plus the passage being cited.
 * `undefined` when the hit carries the whole query, which is the only case that
 * may be served without a partial disclosure (PRD P0-8).
 *
 * The cited passage belongs in this union because it is evidence the caller can
 * read. A long document's `content` is a bounded preview (ADR 0006), so judging
 * coverage from the document alone would report a concept as missing while the
 * very passage in the result spells it out.
 */
export function partialDisclosure(
  entity: Entity,
  chunk: Chunk | undefined,
  groups: string[][],
): { matchedConcepts: string[]; missingConcepts: string[] } | undefined {
  if (groups.length === 0) return undefined;
  const haystacks = [entityHaystack(entity), ...(chunk ? [chunkHaystack(chunk)] : [])];
  const matched: string[] = [];
  const missing: string[] = [];
  groups.forEach((g) => {
    (haystacks.some((h) => groupMatches(h, g)) ? matched : missing).push(groupConcept(g));
  });
  return missing.length === 0
    ? undefined
    : { matchedConcepts: matched, missingConcepts: missing };
}

/** The wire shape of a cited passage: anchor, snippet, the passage itself, its coverage. */
export function chunkMatch({ chunk, matched, total }: ChunkCoverage, groups: string[][]): ChunkMatch {
  return {
    anchor: chunk.anchor,
    ordinal: chunk.ordinal,
    snippet: snippetForGroups(chunk.text, groups),
    text: chunk.text,
    matchedConcepts: matched,
    ofConcepts: total,
    ...(chunk.heading ? { heading: chunk.heading } : {}),
  };
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
