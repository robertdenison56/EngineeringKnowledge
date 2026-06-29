'use server';

import { revalidatePath } from 'next/cache';
import { ENTITY_TYPES, type Entity, type EntityType } from '@ekg/core';
import { getCaller, getStore, isCurator, runAsOperation } from '../../../lib/store';

/**
 * Entity curation actions (PRD P0-1 "curators can edit/merge entities", P0-9
 * inline editing). Like the workbench actions they resolve the request's
 * authenticated caller ({@link getCaller}) and re-check the curator role
 * server-side — that check is the authorization boundary, not the hidden-in-UI
 * affordance. Edits go through `upsertEntity` with no `chunks` argument, so a
 * field change never wipes a document's indexed passages (ADR 0006).
 */

export interface EditState {
  ok: boolean;
  message?: string;
}

const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);
const MAX_TITLE = 160;
const MAX_SUMMARY = 2000;

/** Refresh every surface a field or topology change can move. */
function refreshEntityViews(id: string) {
  revalidatePath(`/entities/${encodeURIComponent(id)}`);
  revalidatePath('/search');
  revalidatePath('/map');
  revalidatePath('/curation');
}

/** Tags are slugged facets (match capture); aliases keep human phrasing. */
function parseTags(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((t) => t.trim().toLowerCase().replace(/\s+/g, '-'))
        .filter(Boolean),
    ),
  ];
}

function parseAliases(raw: string): string[] {
  return [...new Set(raw.split(',').map((a) => a.trim()).filter(Boolean))];
}

export async function editEntity(_prev: EditState, formData: FormData): Promise<EditState> {
  const caller = await getCaller();
  if (!isCurator(caller)) return { ok: false, message: 'Only a curator can edit entities.' };

  const id = String(formData.get('id') ?? '');
  const store = await getStore();
  const entity = await store.getEntity(caller, id);
  if (!entity) return { ok: false, message: 'Entity not found.' };

  const title = String(formData.get('title') ?? '').trim();
  if (!title) return { ok: false, message: 'Title cannot be empty.' };
  if (title.length > MAX_TITLE) return { ok: false, message: `Title must be ${MAX_TITLE} characters or fewer.` };

  // Accept any built-in type; a custom type may only be left unchanged, so the
  // edit form never silently coins a new type from free text.
  const rawType = String(formData.get('type') ?? entity.type);
  const type: EntityType =
    ENTITY_TYPE_SET.has(rawType) || rawType === entity.type ? rawType : entity.type;

  const summary = String(formData.get('summary') ?? '').trim();
  if (summary.length > MAX_SUMMARY) return { ok: false, message: `Summary must be ${MAX_SUMMARY} characters or fewer.` };
  const tags = parseTags(String(formData.get('tags') ?? ''));
  const aliases = parseAliases(String(formData.get('aliases') ?? ''));

  const updated: Entity = {
    ...entity,
    title,
    type,
    summary: summary || undefined,
    tags: tags.length > 0 ? tags : undefined,
    aliases: aliases.length > 0 ? aliases : undefined,
    provenance: { ...entity.provenance, modifiedAt: new Date().toISOString() },
  };

  await runAsOperation({ label: `Edited “${entity.title}”`, kind: 'edit-entity' }, async () => {
    await store.upsertEntity(updated);
  });
  refreshEntityViews(id);
  return { ok: true, message: 'Saved.' };
}

/** Union two optional string lists, preserving order and dropping blanks/dupes. */
function unionLists(a: string[] | undefined, b: string[] | undefined, extra: string[] = []): string[] {
  return [...new Set([...(a ?? []), ...(b ?? []), ...extra].map((s) => s.trim()).filter(Boolean))];
}

export async function mergeEntities(_prev: EditState, formData: FormData): Promise<EditState> {
  const caller = await getCaller();
  if (!isCurator(caller)) return { ok: false, message: 'Only a curator can merge entities.' };

  const survivorId = String(formData.get('survivorId') ?? '');
  const duplicateId = String(formData.get('duplicateId') ?? '');
  if (!duplicateId) return { ok: false, message: 'Pick a duplicate to merge.' };
  if (survivorId === duplicateId) return { ok: false, message: 'An entity cannot be merged into itself.' };

  const store = await getStore();
  const survivor = await store.getEntity(caller, survivorId);
  const duplicate = await store.getEntity(caller, duplicateId);
  if (!survivor || !duplicate) return { ok: false, message: 'One of the entities is no longer available.' };

  // Reconcile fields before the topology merge: the survivor keeps its title and
  // type, but inherits the duplicate's tags and aliases — and the duplicate's
  // own name becomes a survivor alias, so retrieval still finds it by the old
  // title (aliases are the AEC synonym mechanism, PRD P0-1).
  const tags = unionLists(survivor.tags, duplicate.tags);
  const titleAlias = duplicate.title === survivor.title ? [] : [duplicate.title];
  const aliases = unionLists(survivor.aliases, duplicate.aliases, titleAlias);
  const reconciled: Entity = {
    ...survivor,
    summary: survivor.summary ?? duplicate.summary,
    tags: tags.length > 0 ? tags : undefined,
    aliases: aliases.length > 0 ? aliases : undefined,
    provenance: { ...survivor.provenance, modifiedAt: new Date().toISOString() },
  };
  // Reconcile + topology merge are ONE operation, so undo reverses both halves:
  // the survivor's merged-in fields AND the duplicate's deletion + repointed edges.
  const result = await runAsOperation(
    { label: `Merged “${duplicate.title}” into “${survivor.title}”`, kind: 'merge-entities' },
    async () => {
      await store.upsertEntity(reconciled);
      return store.mergeEntities(caller, survivorId, duplicateId);
    },
  );
  if (!result) return { ok: false, message: 'Merge failed — the entities may have changed.' };

  refreshEntityViews(survivorId);
  const moved = `${result.repointed} relationship${result.repointed === 1 ? '' : 's'} repointed`;
  const collapsed = result.dropped > 0 ? `, ${result.dropped} redundant dropped` : '';
  return { ok: true, message: `Merged “${duplicate.title}” in — ${moved}${collapsed}.` };
}

export async function removeRelationship(formData: FormData): Promise<void> {
  const caller = await getCaller();
  if (!isCurator(caller)) return;
  const relId = String(formData.get('relId') ?? '');
  const entityId = String(formData.get('entityId') ?? '');
  const store = await getStore();
  await runAsOperation({ label: 'Removed a relationship', kind: 'remove-relationship' }, async () => {
    await store.deleteRelationship(caller, relId);
  });
  if (entityId) refreshEntityViews(entityId);
}

/* ── Lifecycle: flag, don't delete (PRD P0-1 review states, P0-8) ─────────── */
//
// The core "flag, don't delete" trust mechanism. The superseded/deprecated
// states are already honoured on every read (app badges + the gateway's
// warnings, PRD P0-8) — these are the curator controls that SET them (gap G5).
// Each is one undoable operation, so a mis-flag rolls back in a click.

/** Mark an item superseded by a replacement, recording the `supersedes` edge. */
export async function supersedeEntity(formData: FormData): Promise<void> {
  const caller = await getCaller();
  if (!isCurator(caller)) return;
  const id = String(formData.get('id') ?? '');
  const replacementId = String(formData.get('replacementId') ?? '');
  if (!replacementId || replacementId === id) return;

  const store = await getStore();
  const entity = await store.getEntity(caller, id);
  const replacement = await store.getEntity(caller, replacementId);
  if (!entity || !replacement) return;

  const superseded: Entity = {
    ...entity,
    provenance: {
      ...entity.provenance,
      reviewStatus: 'superseded',
      modifiedAt: new Date().toISOString(),
    },
  };
  await runAsOperation(
    { label: `Superseded “${entity.title}” with “${replacement.title}”`, kind: 'supersede-entity' },
    async () => {
      await store.upsertEntity(superseded);
      // Deterministic id → re-superseding the same pair is idempotent. The
      // replacement `supersedes` the old item, so the old item's page shows the
      // incoming edge as its "current version".
      await store.upsertRelationship({
        id: `supersedes:${replacementId}->${id}`,
        tenantId: caller.tenantId,
        type: 'supersedes',
        fromId: replacementId,
        toId: id,
      });
    },
  );
  refreshEntityViews(id);
  refreshEntityViews(replacementId);
}

/** Mark an item deprecated (no longer current, with no single replacement). */
export async function deprecateEntity(formData: FormData): Promise<void> {
  const caller = await getCaller();
  if (!isCurator(caller)) return;
  const id = String(formData.get('id') ?? '');
  const store = await getStore();
  const entity = await store.getEntity(caller, id);
  if (!entity) return;

  const updated: Entity = {
    ...entity,
    provenance: {
      ...entity.provenance,
      reviewStatus: 'deprecated',
      modifiedAt: new Date().toISOString(),
    },
  };
  await runAsOperation({ label: `Deprecated “${entity.title}”`, kind: 'deprecate-entity' }, async () => {
    await store.upsertEntity(updated);
  });
  refreshEntityViews(id);
}

/** Restore a superseded/deprecated item to `verified` (the inverse control). */
export async function restoreEntity(formData: FormData): Promise<void> {
  const caller = await getCaller();
  if (!isCurator(caller)) return;
  const id = String(formData.get('id') ?? '');
  const store = await getStore();
  const entity = await store.getEntity(caller, id);
  if (!entity) return;

  const updated: Entity = {
    ...entity,
    provenance: {
      ...entity.provenance,
      reviewStatus: 'verified',
      modifiedAt: new Date().toISOString(),
    },
  };
  await runAsOperation({ label: `Restored “${entity.title}” to verified`, kind: 'restore-entity' }, async () => {
    await store.upsertEntity(updated);
  });
  refreshEntityViews(id);
}
