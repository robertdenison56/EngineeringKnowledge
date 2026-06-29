'use server';

import { revalidatePath } from 'next/cache';
import {
  ENTITY_TYPES,
  SUGGESTED_ROLES,
  STRENGTH_PRESETS,
  type EntityType,
  type RetrievalRole,
} from '@ekg/core';
import {
  FIRM_NAME_KEY,
  getCaller,
  getRoles,
  getStore,
  isAdmin,
  runAsOperation,
  saveRoles,
} from '../../lib/store';

/**
 * Settings mutations. Like the curation actions, these resolve the request's
 * authenticated caller ({@link getCaller}) and gate on the admin role. The admin
 * check here is the real authorization boundary — it is enforced server-side,
 * not just hidden in the UI.
 */

export interface FirmNameState {
  ok: boolean;
  message?: string;
  /** The persisted value, echoed back so the form reflects what was saved. */
  firmName?: string;
}

const MAX_FIRM_NAME = 80;

export async function setFirmName(
  _prev: FirmNameState,
  formData: FormData,
): Promise<FirmNameState> {
  const caller = await getCaller();
  if (!isAdmin(caller)) {
    return { ok: false, message: 'Only an admin can change the firm name.' };
  }

  const firmName = String(formData.get('firmName') ?? '').trim();
  if (!firmName) {
    return { ok: false, message: 'Firm name cannot be empty.' };
  }
  if (firmName.length > MAX_FIRM_NAME) {
    return { ok: false, message: `Firm name must be ${MAX_FIRM_NAME} characters or fewer.` };
  }

  const store = await getStore();
  await runAsOperation({ label: `Set firm name to “${firmName}”`, kind: 'set-firm-name' }, async () => {
    await store.setSetting(caller.tenantId, FIRM_NAME_KEY, firmName);
  });

  // Refresh the header badge everywhere (it lives in the root layout) and the
  // settings view itself.
  revalidatePath('/', 'layout');
  revalidatePath('/settings');

  return { ok: true, message: 'Saved.', firmName };
}

/* ── Retrieval roles (focus lenses) ─────────────────────────────────────── */

export interface RoleFormState {
  ok: boolean;
  message?: string;
}

const MAX_ROLE_NAME = 60;
const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);

/** Role views revalidate together — roles steer ranking on /search and /map. */
function refreshRoleViews() {
  revalidatePath('/settings');
  revalidatePath('/search');
  revalidatePath('/map');
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/** Same normalization curation uses for capture-form tags. */
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

/** Read and shape a role from the editor form. Null when the name is empty. */
function roleFromForm(formData: FormData, id: string): RetrievalRole | { error: string } {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return { error: 'Role name cannot be empty.' };
  if (name.length > MAX_ROLE_NAME) {
    return { error: `Role name must be ${MAX_ROLE_NAME} characters or fewer.` };
  }
  const description = String(formData.get('description') ?? '').trim();
  const boostTags = parseTags(String(formData.get('tags') ?? ''));
  const boostTypes = formData
    .getAll('types')
    .map(String)
    .filter((t) => ENTITY_TYPE_SET.has(t)) as EntityType[];
  const strengthId = String(formData.get('strength') ?? 'balanced');
  const weight = (STRENGTH_PRESETS.find((p) => p.id === strengthId) ?? STRENGTH_PRESETS[1]).weight;

  if (boostTags.length === 0 && boostTypes.length === 0) {
    return { error: 'Pick at least one tag or entity type to focus on.' };
  }
  return {
    id,
    name,
    ...(description ? { description } : {}),
    boostTags,
    boostTypes,
    weight,
  };
}

export async function createRole(_prev: RoleFormState, formData: FormData): Promise<RoleFormState> {
  const caller = await getCaller();
  if (!isAdmin(caller)) return { ok: false, message: 'Only an admin can manage roles.' };

  const roles = await getRoles();
  const name = String(formData.get('name') ?? '').trim();
  // Stable, unique slug id derived from the name.
  let id = slugify(name) || `role-${roles.length + 1}`;
  const taken = new Set(roles.map((r) => r.id));
  if (taken.has(id)) {
    let n = 2;
    while (taken.has(`${id}-${n}`)) n += 1;
    id = `${id}-${n}`;
  }

  const role = roleFromForm(formData, id);
  if ('error' in role) return { ok: false, message: role.error };

  await runAsOperation({ label: `Created role “${role.name}”`, kind: 'create-role' }, async () => {
    await saveRoles([...roles, role]);
  });
  refreshRoleViews();
  return { ok: true, message: `Created “${role.name}”.` };
}

export async function updateRole(_prev: RoleFormState, formData: FormData): Promise<RoleFormState> {
  const caller = await getCaller();
  if (!isAdmin(caller)) return { ok: false, message: 'Only an admin can manage roles.' };

  const id = String(formData.get('id') ?? '');
  const roles = await getRoles();
  if (!roles.some((r) => r.id === id)) return { ok: false, message: 'Role not found.' };

  const role = roleFromForm(formData, id);
  if ('error' in role) return { ok: false, message: role.error };

  await runAsOperation({ label: `Updated role “${role.name}”`, kind: 'update-role' }, async () => {
    await saveRoles(roles.map((r) => (r.id === id ? role : r)));
  });
  refreshRoleViews();
  return { ok: true, message: 'Saved.' };
}

export async function deleteRole(formData: FormData): Promise<void> {
  const caller = await getCaller();
  if (!isAdmin(caller)) return;
  const id = String(formData.get('id') ?? '');
  const roles = await getRoles();
  const removed = roles.find((r) => r.id === id);
  await runAsOperation(
    { label: removed ? `Deleted role “${removed.name}”` : 'Deleted a role', kind: 'delete-role' },
    async () => {
      await saveRoles(roles.filter((r) => r.id !== id));
    },
  );
  refreshRoleViews();
}

/** One-click seed: add any suggested roles whose id is not already present. */
export async function addSuggestedRoles(): Promise<void> {
  const caller = await getCaller();
  if (!isAdmin(caller)) return;
  const roles = await getRoles();
  const have = new Set(roles.map((r) => r.id));
  const additions = SUGGESTED_ROLES.filter((r) => !have.has(r.id));
  if (additions.length === 0) return;
  await runAsOperation(
    { label: `Added ${additions.length} suggested role${additions.length === 1 ? '' : 's'}`, kind: 'add-suggested-roles' },
    async () => {
      await saveRoles([...roles, ...additions]);
    },
  );
  refreshRoleViews();
}
