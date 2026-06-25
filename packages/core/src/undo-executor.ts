import type { Caller, GraphStore } from './graph-store.js';
import type { Chunk, Entity } from './ontology.js';
import {
  keyId,
  type BeforeImage,
  type OperationJournal,
} from './operation-journal.js';

export interface UndoOptions {
  /** Caller used for the permission-gated restore reads/deletes (an admin). */
  caller: Caller;
  /**
   * Undo even when a newer operation has since touched the same records. Off by
   * default — the safe path is undoing newest-first (LIFO).
   */
  force?: boolean;
}

export interface UndoResult {
  ok: boolean;
  reason?: string;
  /** How many records were restored or removed. */
  restored: number;
}

/**
 * Reverse a previously-journaled operation (PRD P0-9 undo) by replaying each
 * record's before-image: restore what was changed/deleted, delete what was
 * created. Entities are restored before relationships so an edge's endpoints
 * exist again first; entity-field and chunk images are rejoined per id so a
 * fields-only edit never rewrites the document's passages (ADR 0006).
 *
 * `store` should be the journaling decorator called OUTSIDE any operation
 * context (the undo's own writes must not be re-journaled). Restores run as
 * sequential awaited writes rather than one SQL transaction: restoring an
 * entity re-runs the async embedding step, which cannot be held inside a
 * synchronous SQLite transaction — and each individual write is already
 * internally consistent, so a retry of a half-applied undo simply completes it.
 */
export async function undoOperation(
  store: GraphStore,
  journal: OperationJournal,
  opId: string,
  opts: UndoOptions,
): Promise<UndoResult> {
  const op = journal.get(opId);
  if (!op) return { ok: false, reason: 'That change is no longer in the history.', restored: 0 };
  if (op.status === 'undone') return { ok: false, reason: 'That change was already undone.', restored: 0 };

  if (!opts.force) {
    const newer = journal.newerActiveKeys(opId);
    if (op.entries.some((e) => newer.has(e.key))) {
      return {
        ok: false,
        reason: 'A later change touched the same records — undo the newer change first.',
        restored: 0,
      };
    }
  }

  // Group entity-field and chunk images by entity id so they restore as one write.
  const entityImages = new Map<string, Extract<BeforeImage, { kind: 'entity' }>>();
  const chunkImages = new Map<string, Chunk[]>();
  const relEntries: Array<{ id: string; image: Extract<BeforeImage, { kind: 'rel' }> }> = [];
  const settingImages: Array<Extract<BeforeImage, { kind: 'setting' }>> = [];

  for (const { key, image } of op.entries) {
    if (image.kind === 'entity') entityImages.set(keyId(key), image);
    else if (image.kind === 'chunks') chunkImages.set(keyId(key), image.chunks);
    else if (image.kind === 'rel') relEntries.push({ id: keyId(key), image });
    else settingImages.push(image);
  }

  const { caller } = opts;
  let restored = 0;

  // 1. Entities — restore fields (+ chunks when the op replaced them) or delete
  //    those the operation created.
  for (const [id, image] of entityImages) {
    if (!image.existed) {
      await store.deleteEntity(caller, id);
    } else {
      const chunks = chunkImages.get(id);
      if (chunks !== undefined) await store.upsertEntity(image.entity as Entity, chunks);
      else await store.upsertEntity(image.entity as Entity);
    }
    restored += 1;
  }

  // 2. Settings — restore the prior value, or remove a setting the op created.
  for (const s of settingImages) {
    if (s.existed) await store.setSetting(s.tenantId, s.key, s.value as string);
    else await store.deleteSetting(s.tenantId, s.key);
    restored += 1;
  }

  // 3. Relationships — restore the prior edge (resets a repoint, re-creates a
  //    dropped/deleted one) or delete one the op created.
  for (const { id, image } of relEntries) {
    if (image.existed && image.rel) await store.upsertRelationship(image.rel);
    else await store.deleteRelationship(caller, id);
    restored += 1;
  }

  journal.markUndone(opId);
  return { ok: true, restored };
}
