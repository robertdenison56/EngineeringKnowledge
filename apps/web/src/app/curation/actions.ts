'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { Entity } from '@ekg/core';
import { DEV_CALLER, getStore } from '../../lib/store';
import { auditAction } from '../../lib/audit';
import { readTrash, removeTrash, writeTrash } from '../../lib/trash';

/**
 * Curation actions (PRD P0-9 workbench, P0-1 curator edit/merge). Mutations
 * run as the dev caller; production gates these behind the curator role from
 * Entra SSO. Candidates never skip the queue: capture and ingestion create
 * `unverified` items, and only an explicit verify here promotes them. Every
 * mutation lands in the same P0-7 audit trail the gateway writes, and Reject
 * is a soft delete — the candidate moves to the trash and can be restored.
 */

function refreshViews(...entityIds: string[]) {
  revalidatePath('/curation');
  revalidatePath('/search');
  revalidatePath('/map');
  revalidatePath('/');
  for (const id of entityIds) revalidatePath(`/entities/${encodeURIComponent(id)}`);
}

function formIds(formData: FormData, field: string): string[] {
  return formData
    .getAll(field)
    .map((v) => String(v))
    .filter(Boolean);
}

/** Comma-separated form input → trimmed list, or undefined when empty. */
function parseList(raw: FormDataEntryValue | null, normalize = false): string[] | undefined {
  const items = String(raw ?? '')
    .split(',')
    .map((t) => (normalize ? t.trim().toLowerCase().replace(/\s+/g, '-') : t.trim()))
    .filter(Boolean);
  return items.length > 0 ? [...new Set(items)] : undefined;
}

async function verifyIds(ids: string[]): Promise<void> {
  const store = await getStore();
  const verified: string[] = [];
  for (const id of ids) {
    const entity = await store.getEntity(DEV_CALLER, id);
    if (!entity) continue;
    entity.provenance.reviewStatus = 'verified';
    entity.provenance.modifiedAt = new Date().toISOString();
    await store.upsertEntity(entity);
    verified.push(id);
  }
  if (verified.length > 0) {
    auditAction('verify_entity', { resultIds: verified });
    refreshViews(...verified);
  }
}

async function rejectIds(ids: string[]): Promise<void> {
  const store = await getStore();
  const rejected: string[] = [];
  for (const id of ids) {
    const entity = await store.getEntity(DEV_CALLER, id);
    if (!entity) continue;
    // Soft delete: snapshot entity + chunks to the trash before removing, so
    // a curator misclick is recoverable ("Recently rejected" on the
    // workbench). The audit event carries the entity for the P0-7 record.
    const chunks = await store.getChunks(DEV_CALLER, id);
    await writeTrash(entity, chunks, DEV_CALLER.principals[0] ?? 'unknown');
    await store.deleteEntity(DEV_CALLER, id);
    auditAction('reject_entity', { resultIds: [id], snapshot: entity });
    rejected.push(id);
  }
  if (rejected.length > 0) refreshViews(...rejected);
}

export async function verifyEntity(formData: FormData): Promise<void> {
  await verifyIds(formIds(formData, 'id'));
}

export async function rejectEntity(formData: FormData): Promise<void> {
  await rejectIds(formIds(formData, 'id'));
}

export async function bulkVerify(formData: FormData): Promise<void> {
  await verifyIds(formIds(formData, 'ids'));
}

export async function bulkReject(formData: FormData): Promise<void> {
  await rejectIds(formIds(formData, 'ids'));
}

export async function restoreRejected(formData: FormData): Promise<void> {
  const key = String(formData.get('key') ?? '');
  const record = await readTrash(key);
  if (!record || record.entity.tenantId !== DEV_CALLER.tenantId) return;
  const store = await getStore();
  await store.upsertEntity(record.entity, record.chunks);
  await removeTrash(key);
  auditAction('restore_entity', { resultIds: [record.entity.id] });
  refreshViews(record.entity.id);
}

/** Inline field editing on the entity page (PRD P0-1, P0-9; gap G4). */
export async function updateEntity(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const store = await getStore();
  const entity = await store.getEntity(DEV_CALLER, id);
  if (!entity) return;

  const title = String(formData.get('title') ?? '').trim();
  if (title) entity.title = title;
  const summary = String(formData.get('summary') ?? '').trim();
  entity.summary = summary || undefined;
  entity.tags = parseList(formData.get('tags'), true);
  entity.aliases = parseList(formData.get('aliases'));
  entity.provenance.modifiedAt = new Date().toISOString();

  // Chunks omitted on purpose: a field edit must never wipe document text.
  await store.upsertEntity(entity);
  auditAction('update_entity', {
    args: { id, title: entity.title, tags: entity.tags, aliases: entity.aliases },
    resultIds: [id],
  });
  refreshViews(id);
}

/** ACL curation (PRD P0-2/P0-7; gap G6). Empty input = tenant-public. */
export async function updateAcl(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const store = await getStore();
  const entity = await store.getEntity(DEV_CALLER, id);
  if (!entity) return;
  entity.acl = { allowedPrincipals: parseList(formData.get('principals')) ?? ['*'] };
  entity.provenance.modifiedAt = new Date().toISOString();
  await store.upsertEntity(entity);
  auditAction('update_acl', {
    args: { id, principals: entity.acl.allowedPrincipals },
    resultIds: [id],
  });
  refreshViews(id);
}

const LIFECYCLE_STATUSES = new Set(['unverified', 'verified', 'deprecated']);

/**
 * Direct lifecycle transitions (PRD P0-1; gap G5): deprecate, restore to
 * verified, or send back to the review queue. `superseded` is set via
 * supersedeEntity so the replacement edge always exists.
 */
export async function setReviewStatus(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const status = String(formData.get('status') ?? '');
  if (!LIFECYCLE_STATUSES.has(status)) return;
  const store = await getStore();
  const entity = await store.getEntity(DEV_CALLER, id);
  if (!entity) return;
  entity.provenance.reviewStatus = status as Entity['provenance']['reviewStatus'];
  entity.provenance.modifiedAt = new Date().toISOString();
  await store.upsertEntity(entity);
  auditAction('set_review_status', { args: { id, status }, resultIds: [id] });
  refreshViews(id);
}

/**
 * The "flag, don't delete" trust action (PRD P0-1, P0-8; gap G5): mark this
 * item superseded AND record what replaces it, so every surface can warn and
 * point at the current version.
 */
export async function supersedeEntity(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const replacementId = String(formData.get('replacementId') ?? '');
  if (!replacementId || replacementId === id) return;
  const store = await getStore();
  const entity = await store.getEntity(DEV_CALLER, id);
  const replacement = await store.getEntity(DEV_CALLER, replacementId);
  if (!entity || !replacement) return;

  entity.provenance.reviewStatus = 'superseded';
  entity.provenance.modifiedAt = new Date().toISOString();
  await store.upsertEntity(entity);
  await store.upsertRelationship({
    id: `rel:supersedes-${randomUUID().slice(0, 8)}`,
    tenantId: DEV_CALLER.tenantId,
    type: 'supersedes',
    fromId: replacement.id,
    toId: entity.id,
  });
  auditAction('supersede_entity', {
    args: { id, replacementId },
    resultIds: [id, replacementId],
  });
  refreshViews(id, replacementId);
}

/**
 * Merge duplicates (PRD P0-9; gap G3): union tags/aliases onto the survivor,
 * repoint the duplicate's edges, remove the duplicate, and land on the
 * survivor's page.
 */
export async function mergeEntity(formData: FormData): Promise<void> {
  const duplicateId = String(formData.get('id') ?? '');
  const survivorId = String(formData.get('survivorId') ?? '');
  if (!survivorId || survivorId === duplicateId) return;
  const store = await getStore();
  const duplicate = await store.getEntity(DEV_CALLER, duplicateId);
  const survivor = await store.getEntity(DEV_CALLER, survivorId);
  if (!duplicate || !survivor) return;

  const union = (a?: string[], b?: string[]) => {
    const merged = [...new Set([...(a ?? []), ...(b ?? [])])];
    return merged.length > 0 ? merged : undefined;
  };
  survivor.tags = union(survivor.tags, duplicate.tags);
  survivor.aliases = union(survivor.aliases, duplicate.aliases);
  if (!survivor.summary && duplicate.summary) survivor.summary = duplicate.summary;
  survivor.provenance.modifiedAt = new Date().toISOString();
  await store.upsertEntity(survivor);
  await store.mergeEntities(DEV_CALLER, survivorId, duplicateId);
  auditAction('merge_entities', {
    args: { survivorId, duplicateId },
    resultIds: [survivorId],
    snapshot: duplicate,
  });
  refreshViews(survivorId, duplicateId);
  redirect(`/entities/${encodeURIComponent(survivorId)}`);
}

/** Add a typed edge from the entity page (PRD P0-1 curator-created relationships). */
export async function addRelationship(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const targetId = String(formData.get('targetId') ?? '').trim();
  const type = String(formData.get('type') ?? '').trim();
  const direction = String(formData.get('direction') ?? 'out');
  if (!targetId || !type || targetId === id) return;
  const store = await getStore();
  const entity = await store.getEntity(DEV_CALLER, id);
  const target = await store.getEntity(DEV_CALLER, targetId);
  if (!entity || !target) return;

  const rel = {
    id: `rel:${type}-${randomUUID().slice(0, 8)}`,
    tenantId: DEV_CALLER.tenantId,
    type,
    fromId: direction === 'in' ? targetId : id,
    toId: direction === 'in' ? id : targetId,
  };
  await store.upsertRelationship(rel);
  auditAction('add_relationship', {
    args: { type, fromId: rel.fromId, toId: rel.toId },
    resultIds: [id, targetId],
  });
  refreshViews(id, targetId);
}

/** Remove a mistaken edge (gap G3's missing primitive, now in the store). */
export async function removeRelationship(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const relId = String(formData.get('relId') ?? '');
  const store = await getStore();
  const removed = await store.deleteRelationship(DEV_CALLER, relId);
  if (removed) {
    auditAction('delete_relationship', { args: { relId }, resultIds: id ? [id] : [] });
    refreshViews(id);
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

const CAPTURE_TYPES = new Set(['lesson-learned', 'design-detail', 'document', 'material', 'rfi']);

export async function captureKnowledge(formData: FormData): Promise<void> {
  const title = String(formData.get('title') ?? '').trim();
  const type = String(formData.get('type') ?? 'lesson-learned');
  if (!title || !CAPTURE_TYPES.has(type)) return;

  const summary = String(formData.get('summary') ?? '').trim();
  const author = String(formData.get('author') ?? '').trim();
  const tags = parseList(formData.get('tags'), true) ?? [];
  const sourceUrl = String(formData.get('sourceUrl') ?? '').trim();
  const sheet = String(formData.get('sheet') ?? '').trim();
  const pageRaw = String(formData.get('page') ?? '').trim();
  const page = pageRaw ? Number(pageRaw) : undefined;
  const projectId = String(formData.get('project') ?? '').trim();
  const now = new Date().toISOString();

  const anchor =
    sheet || page ? { ...(sheet ? { sheet } : {}), ...(page ? { page } : {}) } : undefined;

  const entity: Entity = {
    id: `${type}:${slugify(title)}-${randomUUID().slice(0, 8)}`,
    tenantId: DEV_CALLER.tenantId,
    type,
    title,
    summary: summary || undefined,
    properties: { capturedVia: 'workspace-app' },
    ...(tags.length > 0 ? { tags } : {}),
    provenance: {
      createdAt: now,
      modifiedAt: now,
      reviewStatus: 'unverified',
      ...(author ? { author } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(anchor ? { anchor } : {}),
    },
    acl: { allowedPrincipals: ['*'] },
  };

  const store = await getStore();
  await store.upsertEntity(entity);

  // Type-ahead linking (PRD P0-9 guided capture; gap G9): connect the new
  // knowledge into the graph at capture time instead of leaving it an island.
  const linked: string[] = [];
  if (projectId) {
    const project = await store.getEntity(DEV_CALLER, projectId);
    if (project?.type === 'project') {
      await store.upsertRelationship({
        id: `rel:used-in-${entity.id}`,
        tenantId: DEV_CALLER.tenantId,
        type: 'used-in',
        fromId: entity.id,
        toId: project.id,
      });
      linked.push(project.id);
    }
  }
  if (author) {
    // An author who matches a person entity by name gets a real authored-by
    // edge — this is what makes find_experts see captured knowledge.
    const people = await store.list(DEV_CALLER, { types: ['person'], limit: 1000 });
    const person = people.find((p) => p.title.toLowerCase() === author.toLowerCase());
    if (person) {
      await store.upsertRelationship({
        id: `rel:authored-by-${entity.id}`,
        tenantId: DEV_CALLER.tenantId,
        type: 'authored-by',
        fromId: entity.id,
        toId: person.id,
      });
      linked.push(person.id);
    }
  }

  auditAction('capture_knowledge', {
    args: { id: entity.id, type, title, linked },
    resultIds: [entity.id, ...linked],
  });
  refreshViews(entity.id);
  redirect('/curation');
}
