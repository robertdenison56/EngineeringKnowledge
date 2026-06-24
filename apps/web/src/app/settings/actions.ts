'use server';

import { revalidatePath } from 'next/cache';
import { DEV_CALLER, FIRM_NAME_KEY, getStore, isAdmin } from '../../lib/store';

/**
 * Settings mutations. Like the curation actions, these run as the dev caller;
 * production gates them behind the admin role from Entra SSO. The admin check
 * here is the real authorization boundary — it is enforced server-side, not
 * just hidden in the UI.
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
  if (!isAdmin(DEV_CALLER)) {
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
  await store.setSetting(DEV_CALLER.tenantId, FIRM_NAME_KEY, firmName);

  // Refresh the header badge everywhere (it lives in the root layout) and the
  // settings view itself.
  revalidatePath('/', 'layout');
  revalidatePath('/settings');

  return { ok: true, message: 'Saved.', firmName };
}
