'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { Entity } from '@ekg/core';
import { getCaller, getStore, isCurator, runAsOperation } from '../../lib/store';

/**
 * Curation actions (PRD P0-9 workbench). Every mutation resolves the request's
 * authenticated caller ({@link getCaller}) and re-checks the curator role
 * server-side — that check is the authorization boundary, not the hidden-in-UI
 * affordance. Candidates never skip the queue: capture and ingestion create
 * `unverified` items, and only an explicit verify here promotes them. Each
 * action runs as one undoable, audited operation (P0-7, P0-9) — a bulk verify
 * or a mistaken reject rolls back as a unit from the Recent changes panel.
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
  // Promoting items to `verified` is a curator action — re-checked server-side
  // (the authorization boundary, not the hidden-in-UI affordance; PRD P0-9).
  const caller = await getCaller();
  if (!isCurator(caller)) return;
  const store = await getStore();
  const entities: Entity[] = [];
  for (const id of ids) {
    const entity = await store.getEntity(caller, id);
    if (entity) entities.push(entity);
  }
  if (entities.length === 0) return;

  const label =
    entities.length === 1
      ? `Verified “${entities[0].title}”`
      : `Verified ${entities.length} items`;
  await runAsOperation({ label, kind: 'verify-entity' }, async () => {
    for (const entity of entities) {
      // Immutable update — never mutate the fetched entity in place, or the undo
      // journal would capture the already-verified state as its "before" image.
      const verified: Entity = {
        ...entity,
        provenance: {
          ...entity.provenance,
          reviewStatus: 'verified',
          modifiedAt: new Date().toISOString(),
        },
      };
      await store.upsertEntity(verified);
    }
  });
  refreshViews(...entities.map((e) => e.id));
}

async function rejectIds(ids: string[]): Promise<void> {
  // Deleting candidates is a curator action — re-checked server-side (P0-9).
  // The journal snapshots each entity, its chunks, and every touching edge,
  // so a mistaken reject is restored in full from Recent changes.
  const caller = await getCaller();
  if (!isCurator(caller)) return;
  const store = await getStore();
  const entities: Entity[] = [];
  for (const id of ids) {
    const entity = await store.getEntity(caller, id);
    if (entity) entities.push(entity);
  }
  if (entities.length === 0) return;

  const label =
    entities.length === 1
      ? `Rejected “${entities[0].title}”`
      : `Rejected ${entities.length} candidates`;
  await runAsOperation({ label, kind: 'reject-entity' }, async () => {
    for (const entity of entities) {
      await store.deleteEntity(caller, entity.id);
    }
  });
  refreshViews(...entities.map((e) => e.id));
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

  const caller = await getCaller();
  const entity: Entity = {
    id: `${type}:${slugify(title)}-${randomUUID().slice(0, 8)}`,
    tenantId: caller.tenantId,
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
  await runAsOperation({ label: `Captured “${title}”`, kind: 'capture-knowledge' }, async () => {
    await store.upsertEntity(entity);

    // Type-ahead linking (PRD P0-9 guided capture; gap G9): connect the new
    // knowledge into the graph at capture time instead of leaving it an island.
    if (projectId) {
      const project = await store.getEntity(caller, projectId);
      if (project?.type === 'project') {
        await store.upsertRelationship({
          id: `rel:used-in-${entity.id}`,
          tenantId: caller.tenantId,
          type: 'used-in',
          fromId: entity.id,
          toId: project.id,
        });
      }
    }
    if (author) {
      // An author who matches a person entity by name gets a real authored-by
      // edge — this is what makes find_experts see captured knowledge.
      const people = await store.list(caller, { types: ['person'], limit: 1000 });
      const person = people.find((p) => p.title.toLowerCase() === author.toLowerCase());
      if (person) {
        await store.upsertRelationship({
          id: `rel:authored-by-${entity.id}`,
          tenantId: caller.tenantId,
          type: 'authored-by',
          fromId: entity.id,
          toId: person.id,
        });
      }
    }
  });
  refreshViews(entity.id);
  redirect('/curation');
}
