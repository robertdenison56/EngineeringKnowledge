'use server';

import { revalidatePath } from 'next/cache';
import { undoOperation as runUndo } from '@ekg/core';
import { getCaller, getJournal, getStore, isCurator } from '../../lib/store';
import { auditAction } from '../../lib/audit';

/**
 * Undo actions (PRD P0-9). A curator/admin can roll back a previously journaled
 * operation — including a whole bulk import — restoring the graph to its
 * pre-operation state. Re-checks the curator role server-side, the same
 * authorization boundary every mutation enforces.
 */

export interface UndoState {
  ok: boolean;
  message?: string;
}

/** Refresh every surface an undo can move — it can restore or remove anything. */
function refreshAll() {
  revalidatePath('/', 'layout');
  revalidatePath('/');
  revalidatePath('/search');
  revalidatePath('/map');
  revalidatePath('/curation');
  revalidatePath('/settings');
}

/** Roll back the most recent change (the safe, LIFO default). */
export async function undoLastOperation(
  _prev: UndoState | null,
  _formData?: FormData,
): Promise<UndoState> {
  const caller = await getCaller();
  if (!isCurator(caller)) return { ok: false, message: 'Only a curator can undo changes.' };

  const journal = await getJournal();
  const [latest] = journal.list(caller.tenantId, 1);
  if (!latest) return { ok: false, message: 'Nothing to undo.' };

  const store = await getStore();
  const res = await runUndo(store, journal, latest.id, { caller });
  if (!res.ok) return { ok: false, message: res.reason ?? 'Undo failed.' };

  // An undo mutates the graph like any other action — same P0-7 trail.
  auditAction(caller, 'undo-operation', { args: { opId: latest.id, label: latest.label } });
  refreshAll();
  const n = res.restored;
  return { ok: true, message: `Undid “${latest.label}” — ${n} record${n === 1 ? '' : 's'} restored.` };
}

/** Roll back a specific operation by id (recent-changes list; conflict-guarded). */
export async function undoOperationById(_prev: UndoState | null, formData: FormData): Promise<UndoState> {
  const caller = await getCaller();
  if (!isCurator(caller)) return { ok: false, message: 'Only a curator can undo changes.' };

  const opId = String(formData.get('opId') ?? '');
  const force = String(formData.get('force') ?? '') === '1';
  if (!opId) return { ok: false, message: 'No change selected.' };

  const journal = await getJournal();
  const label = journal.get(opId)?.label ?? 'change';
  const store = await getStore();
  const res = await runUndo(store, journal, opId, { caller, force });
  if (!res.ok) return { ok: false, message: res.reason ?? 'Undo failed.' };

  auditAction(caller, 'undo-operation', { args: { opId, label, force } });
  refreshAll();
  const n = res.restored;
  return { ok: true, message: `Undid “${label}” — ${n} record${n === 1 ? '' : 's'} restored.` };
}
