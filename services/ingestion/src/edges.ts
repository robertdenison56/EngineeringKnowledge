import { createHash } from 'node:crypto';
import type { Entity, Relationship } from '@ekg/core';
import type { Candidate } from './candidate.js';
import { normalizeSheetNumber } from './semantics.js';

/**
 * Cross-sheet callouts → `references` graph edges (Phase B of the
 * vector-parsing plan). A drawing set stops being a pile of files: "3/S-501"
 * on one sheet becomes a traversable edge to the S-501 entity, which is what
 * `traverse` and the knowledge map were built for.
 *
 * Resolution is deliberately conservative: a reference only becomes an edge
 * when exactly one known entity claims the target sheet number. Unresolved
 * and ambiguous targets are reported, not guessed — the printed reference
 * stays visible on the entity (`properties.sheetRefs`) either way.
 */

/**
 * Index entities by the sheet numbers they claim (provenance anchor and the
 * geometry-harvested title block). Feed it everything visible: the current
 * ingestion batch plus what is already in the store.
 */
export function sheetIndex(entities: Iterable<Entity>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (sheet: string | undefined, id: string) => {
    if (!sheet) return;
    const key = normalizeSheetNumber(sheet);
    if (key.length === 0) return;
    let ids = index.get(key);
    if (!ids) index.set(key, (ids = new Set()));
    ids.add(id);
  };
  for (const e of entities) {
    add(e.provenance.anchor?.sheet, e.id);
    const sheet = e.properties.sheet as { number?: string } | undefined;
    add(sheet?.number, e.id);
  }
  return index;
}

export interface ReferenceEdgeResult {
  edges: Relationship[];
  /** Targets with no known entity — printed refs to sheets we have not seen. */
  unresolved: string[];
  /** Targets multiple entities claim — never guess which one was meant. */
  ambiguous: string[];
}

export function buildReferenceEdges(
  candidates: Candidate[],
  index: Map<string, Set<string>>,
  tenantId: string,
): ReferenceEdgeResult {
  const edges = new Map<string, Relationship>();
  const unresolved = new Set<string>();
  const ambiguous = new Set<string>();

  for (const candidate of candidates) {
    for (const ref of candidate.references ?? []) {
      const ids = index.get(normalizeSheetNumber(ref.targetSheet));
      if (!ids || ids.size === 0) {
        unresolved.add(ref.targetSheet);
        continue;
      }
      if (ids.size > 1) {
        ambiguous.add(ref.targetSheet);
        continue;
      }
      const toId = [...ids][0];
      const fromId = candidate.entity.id;
      if (fromId === toId) continue;
      const id = `ingest:ref:${createHash('sha1')
        .update(`${fromId}->${toId}#${ref.detail ?? ''}`)
        .digest('hex')
        .slice(0, 12)}`;
      edges.set(id, {
        id,
        tenantId,
        type: 'references',
        fromId,
        toId,
        properties: {
          targetSheet: ref.targetSheet,
          ...(ref.detail ? { detail: ref.detail } : {}),
          page: ref.page,
          confidence: ref.confidence,
          method: ref.method,
        },
      });
    }
  }
  return { edges: [...edges.values()], unresolved: [...unresolved], ambiguous: [...ambiguous] };
}
