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
 * `unverified` items, and only an explicit verify here promotes them.
 */

function refreshViews() {
  revalidatePath('/curation');
  revalidatePath('/search');
  revalidatePath('/');
}

export async function verifyEntity(formData: FormData): Promise<void> {
  // Promoting an item to `verified` is a curator action — re-checked server-side
  // (the authorization boundary, not the hidden-in-UI affordance; PRD P0-9).
  const caller = await getCaller();
  if (!isCurator(caller)) return;
  const id = String(formData.get('id') ?? '');
  const store = await getStore();
  const entity = await store.getEntity(caller, id);
  if (!entity) return;
  // Immutable update — never mutate the fetched entity in place, or the undo
  // journal would capture the already-verified state as its "before" image.
  const verified: Entity = {
    ...entity,
    provenance: { ...entity.provenance, reviewStatus: 'verified', modifiedAt: new Date().toISOString() },
  };
  await runAsOperation({ label: `Verified “${entity.title}”`, kind: 'verify-entity' }, async () => {
    await store.upsertEntity(verified);
  });
  refreshViews();
}

export async function rejectEntity(formData: FormData): Promise<void> {
  // Deleting a candidate is a curator action — re-checked server-side (P0-9).
  const caller = await getCaller();
  if (!isCurator(caller)) return;
  const id = String(formData.get('id') ?? '');
  const store = await getStore();
  const entity = await store.getEntity(caller, id);
  await runAsOperation(
    { label: entity ? `Rejected “${entity.title}”` : 'Rejected a candidate', kind: 'reject-entity' },
    async () => {
      await store.deleteEntity(caller, id);
    },
  );
  refreshViews();
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
  const tags = String(formData.get('tags') ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, '-'))
    .filter(Boolean);
  const sourceUrl = String(formData.get('sourceUrl') ?? '').trim();
  const sheet = String(formData.get('sheet') ?? '').trim();
  const pageRaw = String(formData.get('page') ?? '').trim();
  const page = pageRaw ? Number(pageRaw) : undefined;
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
  });
  refreshViews();
  redirect('/curation');
}
