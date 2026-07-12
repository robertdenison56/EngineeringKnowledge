'use client';

import { useActionState } from 'react';
import { undoLastOperation, type UndoState } from './undo-actions';

/**
 * Roll back the most recent change (PRD P0-9 undo). The safe, one-click path —
 * whatever the last operation was (a bulk import, a merge, an edit), this
 * reverses it as a unit. Selective undo of older changes lives in the recent-
 * changes list.
 */
export function UndoLastButton() {
  const [state, formAction, pending] = useActionState<UndoState | null, FormData>(
    undoLastOperation,
    null,
  );
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
      <form action={formAction}>
        <button type="submit" className="button-link" disabled={pending}>
          {pending ? 'Undoing…' : '↶ Undo last change'}
        </button>
      </form>
      {state?.message ? (
        <span className="meta" style={state.ok ? undefined : { color: '#b91c1c' }}>
          {state.message}
        </span>
      ) : null}
    </span>
  );
}
