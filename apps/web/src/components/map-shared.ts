import type { RetrievalRole } from '@ekg/core';

/** One indexed passage of a chunked document, as shown when its node unfolds. */
export interface MapSection {
  /** Human label — "Sheet L-1 — Planting plan", "07 92 00 · PART 2", "Page 14". */
  label: string;
  /** Short excerpt of the passage text. */
  description: string;
}

export interface MapNode {
  id: string;
  title: string;
  type: string;
  reviewStatus: string;
  tags: string[];
  /** Declared discipline (`properties.discipline`), when the entity has one. */
  discipline?: string;
  /** Present for multi-passage documents (ADR 0006) — clicking the node unfolds these. */
  sections?: MapSection[];
  /** Total indexed passages; `sections` is capped, the rest fold into "+N more". */
  sectionCount?: number;
}

export interface MapLink {
  id: string;
  source: string;
  target: string;
  type: string;
}

/**
 * Whether a retrieval role favors a node — same tag/type test as the
 * `entityMatchesRole` boost the store applies, expressed over the map's lighter
 * node shape so the highlight matches what actually ranks higher.
 */
export function nodeMatchesRole(node: MapNode, role: RetrievalRole): boolean {
  return role.boostTypes.includes(node.type) || node.tags.some((t) => role.boostTags.includes(t));
}

export function shortTitle(title: string, max = 22): string {
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}
