'use client';

import { useActionState } from 'react';
import { setFirmName, type FirmNameState } from '../app/settings/actions';

/**
 * Admin control for the firm's display name (Settings → Identity). Writes go
 * through the `setFirmName` server action, which re-checks the admin role —
 * this component only decides what to render. Non-admins see the current value
 * read-only.
 */
export function FirmNameSettings({
  initialFirmName,
  canEdit,
}: {
  initialFirmName: string;
  canEdit: boolean;
}) {
  const [state, formAction, pending] = useActionState<FirmNameState, FormData>(setFirmName, {
    ok: true,
    firmName: initialFirmName,
  });
  const current = state.firmName ?? initialFirmName;

  if (!canEdit) {
    return (
      <p className="meta firm-name-readonly">
        Firm name: <strong>{current}</strong>. Ask an admin to change it.
      </p>
    );
  }

  return (
    <form action={formAction} className="firm-name-form">
      <label>
        Firm name
        <input
          name="firmName"
          defaultValue={current}
          maxLength={80}
          required
          autoComplete="off"
          placeholder="e.g. Acme Engineering"
        />
      </label>
      <div className="firm-name-actions">
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        {state.message ? (
          <span
            className={`firm-name-msg${state.ok ? ' ok' : ' err'}`}
            role="status"
            aria-live="polite"
          >
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
