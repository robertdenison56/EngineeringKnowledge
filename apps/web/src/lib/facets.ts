import type { Entity, SearchHit } from '@ekg/core';

/**
 * Search facets beyond type/tag (PRD P0-9 filters; gap G7): project,
 * discipline, MasterFormat spec section, and modified-date range. Every facet
 * is a pure POST-filter over the hits the store already admitted, so the
 * honest no-results gate, role boosting, and relaxed-pass disclosure (P0-8)
 * behave identically whether facets are on or off — the same contract the
 * review-status facet established.
 *
 * Only type-only imports from @ekg/core, so this module loads under
 * `node --experimental-strip-types` for unit tests, like lib/auth.ts.
 */

/** The G7 facet selections carried in the search page's query string. */
export interface FacetParams {
  project?: string;
  discipline?: string;
  section?: string;
  from?: string;
  to?: string;
}

/** True when at least one G7 facet (or the status facet) narrows results. */
export function anyFacetActive(f: FacetParams & { status?: string }): boolean {
  return Boolean(f.status || f.project || f.discipline || f.section || f.from || f.to);
}

/**
 * Canonical form of a MasterFormat section code for comparison: separators
 * dropped, lowercased — "07 84 00", "07-84-00", "07.84.00" all become
 * "078400", and a bare division "07" stays "07" so it prefix-matches every
 * section under it. Mirrors the spirit of core's `canonicalizeIdentifiers`
 * without importing runtime code.
 */
export function canonSection(code: string): string {
  return code.toLowerCase().replace(/[^0-9a-z]/g, '');
}

/** The spec section an entity carries, if any: source anchor, else the
 *  `masterformat` property spec-section entities record. */
function sectionOf(entity: Entity): string | undefined {
  if (entity.provenance.anchor?.specSection) return entity.provenance.anchor.specSection;
  const mf = entity.properties['masterformat'];
  return typeof mf === 'string' ? mf : undefined;
}

/**
 * Spec-section facet: prefix match on canonical codes, so "07" (division),
 * "07 84", and "07 84 00" all work. A hit qualifies through its entity's own
 * section OR through the passage it matched on — a spec-book chunk hit is
 * exactly the case where the anchor lives on the chunk (ADR 0006).
 */
export function hitMatchesSection(hit: SearchHit, input: string): boolean {
  const want = canonSection(input);
  if (!want) return true;
  const candidates = [sectionOf(hit.entity), hit.chunk?.anchor.specSection];
  return candidates.some((c) => c !== undefined && canonSection(c).startsWith(want));
}

/** The discipline an entity declares (`properties.discipline`), if any. */
export function disciplineOf(entity: Entity): string | undefined {
  const d = entity.properties['discipline'];
  return typeof d === 'string' && d.trim() ? d.trim() : undefined;
}

/** Discipline facet: case-insensitive match on the declared discipline. */
export function matchesDiscipline(entity: Entity, value: string): boolean {
  const d = disciplineOf(entity);
  return d !== undefined && d.toLowerCase() === value.trim().toLowerCase();
}

/**
 * Distinct disciplines present in the current results, alphabetized, keeping
 * the first-seen casing for display. The currently-selected value is always
 * included so an active selection never disappears from its own dropdown.
 */
export function disciplineOptions(hits: SearchHit[], selected?: string): string[] {
  const byKey = new Map<string, string>();
  for (const h of hits) {
    const d = disciplineOf(h.entity);
    if (d) byKey.set(d.toLowerCase(), byKey.get(d.toLowerCase()) ?? d);
  }
  if (selected && selected.trim() && !byKey.has(selected.trim().toLowerCase())) {
    byKey.set(selected.trim().toLowerCase(), selected.trim());
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Date-range facet over `provenance.modifiedAt`. Bounds are YYYY-MM-DD from
 * `<input type="date">`, inclusive on both ends; the ISO timestamp's date part
 * compares lexicographically, so no Date parsing (and no timezone surprises
 * beyond the stamp's own offset) is involved.
 */
export function inDateRange(entity: Entity, from?: string, to?: string): boolean {
  const day = entity.provenance.modifiedAt.slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}
