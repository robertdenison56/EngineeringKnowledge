'use client';

import { useActionState } from 'react';
import { undoOperationById, type UndoState } from './undo-actions';

export interface RecentChangeItem {
  id: string;
  label: string;
  actor: string;
  when: string;
  entryCount: number;
}

/**
 * The staged history of undoable operations, newest first (PRD P0-9). Each row
 * can be rolled back on its own; undoing an older change is blocked when a newer
 * one touched the same records (the server returns the reason here), so the safe
 * path is newest-first.
 */
export function RecentChanges({ items }: { items: RecentChangeItem[] }) {
  const [state, formAction, pending] = useActionState<UndoState | null, FormData>(
    undoOperationById,
    null,
  );

  if (items.length === 0) {
    return (
      <p className="meta">
        No changes yet — edits, merges, and imports will appear here so they can be rolled back.
      </p>
    );
  }

  return (
    <div>
      {state?.message ? (
        <p className="meta" style={state.ok ? undefined : { color: '#b91c1c' }}>
          {state.message}
        </p>
      ) : null}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {items.map((it) => (
          <li
            key={it.id}
            style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem' }}
          >
            <span>
              <span style={{ fontWeight: 600 }}>{it.label}</span>{' '}
              <span className="meta">
                · {it.actor} · {it.when} · {it.entryCount} record{it.entryCount === 1 ? '' : 's'}
              </span>
            </span>
            <form action={formAction}>
              <input type="hidden" name="opId" value={it.id} />
              <button type="submit" className="button-link" disabled={pending}>
                Undo
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
