import type { EntityType } from './ontology.js';

/**
 * A retrieval role (focus lens). Admin-defined tenant config that pivots
 * ranking toward the knowledge a given kind of work cares about — a "Façade &
 * Fire Safety" lens surfaces firestop details/specs/lessons first; a "Project
 * Delivery" lens favors lessons-learned and RFIs.
 *
 * A role only ever RE-RANKS already-admitted candidates (see `roleBoostFactor`
 * in matching.ts) — it never admits or hides anything, so the honest
 * `no_results` contract (PRD P0-8) and ACL trimming (P0-7) are untouched.
 *
 * Note this is unrelated to access "roles" like `role:admin` (ACL principals):
 * a retrieval role steers ranking, not permission.
 */
export interface RetrievalRole {
  /** Stable slug, derived from the name at creation. */
  id: string;
  name: string;
  description?: string;
  /** An entity carrying ANY of these tags is boosted. */
  boostTags: string[];
  /** An entity of ANY of these types is boosted. */
  boostTypes: EntityType[];
  /** Score multiplier applied to matching items (see STRENGTH_PRESETS). */
  weight: number;
}

/** Settings key under which a tenant's roles are persisted (one JSON array). */
export const RETRIEVAL_ROLES_KEY = 'retrieval-roles';

/**
 * Strength presets the admin UI offers instead of a raw multiplier — easier to
 * reason about than a number. The stored value is the multiplier itself, so the
 * model stays a plain `weight` and future tuning needs no migration.
 */
export const STRENGTH_PRESETS = [
  { id: 'subtle', label: 'Subtle', weight: 1.4 },
  { id: 'balanced', label: 'Balanced', weight: 1.8 },
  { id: 'strong', label: 'Strong', weight: 2.5 },
] as const;

/** Closest preset label for a stored weight (for the edit form / display). */
export function strengthLabel(weight: number): string {
  let bestLabel: string = STRENGTH_PRESETS[0].label;
  let bestDiff = Math.abs(STRENGTH_PRESETS[0].weight - weight);
  for (const p of STRENGTH_PRESETS) {
    const diff = Math.abs(p.weight - weight);
    if (diff < bestDiff) {
      bestLabel = p.label;
      bestDiff = diff;
    }
  }
  return bestLabel;
}

function isRole(value: unknown): value is RetrievalRole {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    Array.isArray(r.boostTags) &&
    Array.isArray(r.boostTypes) &&
    typeof r.weight === 'number'
  );
}

/**
 * Parse the persisted roles JSON, tolerating absence and corruption — config
 * read on every search must never throw retrieval into an error. Returns []
 * for missing/blank/malformed input, and drops any element that is not a
 * well-formed role.
 */
export function parseRoles(json: string | undefined): RetrievalRole[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRole).map((r) => ({
      id: r.id,
      name: r.name,
      ...(r.description ? { description: r.description } : {}),
      boostTags: r.boostTags.map(String),
      boostTypes: r.boostTypes.map(String),
      weight: r.weight,
    }));
  } catch {
    return [];
  }
}

export function serializeRoles(roles: RetrievalRole[]): string {
  return JSON.stringify(roles);
}

/** Resolve a role by id or (case-insensitive) name. Undefined if unmatched. */
export function findRole(
  roles: RetrievalRole[],
  idOrName: string | undefined,
): RetrievalRole | undefined {
  if (!idOrName) return undefined;
  const needle = idOrName.toLowerCase();
  return roles.find((r) => r.id === idOrName || r.name.toLowerCase() === needle);
}

/**
 * Starter roles grounded in the demo corpus's tags/types, offered by the admin
 * UI as a one-click seed so the feature is usable immediately.
 */
export const SUGGESTED_ROLES: RetrievalRole[] = [
  {
    id: 'facade-fire-safety',
    name: 'Façade & Fire Safety',
    description: 'Curtain-wall, envelope, and firestop knowledge first.',
    boostTags: ['firestop', 'fire-safety', 'curtain-wall', 'envelope', 'facade'],
    boostTypes: ['design-detail', 'spec-section', 'standard', 'lesson-learned'],
    weight: 1.8,
  },
  {
    id: 'project-delivery',
    name: 'Project Delivery',
    description: 'Lessons learned, RFIs, and project context for delivery teams.',
    boostTags: ['qa', 'mockup'],
    boostTypes: ['lesson-learned', 'rfi', 'project'],
    weight: 1.8,
  },
  {
    id: 'specs-and-standards',
    name: 'Specifications & Standards',
    description: 'Master specs and the standards work must comply with.',
    boostTags: ['division-07', 'testing'],
    boostTypes: ['spec-section', 'standard'],
    weight: 1.8,
  },
];
