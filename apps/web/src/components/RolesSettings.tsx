'use client';

import { useActionState, useState } from 'react';
import { ENTITY_TYPES, STRENGTH_PRESETS, type RetrievalRole } from '@ekg/core';
import {
  addSuggestedRoles,
  createRole,
  deleteRole,
  updateRole,
  type RoleFormState,
} from '../app/settings/actions';

/**
 * Admin management of retrieval roles (focus lenses) — Settings → Retrieval
 * roles. Every mutation goes through a server action that re-checks the admin
 * role, so this component only decides what to render. Non-admins see the roles
 * read-only.
 */
export function RolesSettings({
  initialRoles,
  canEdit,
}: {
  initialRoles: RetrievalRole[];
  canEdit: boolean;
}) {
  if (!canEdit) {
    return initialRoles.length === 0 ? (
      <p className="meta">No retrieval roles defined. Ask an admin to create one.</p>
    ) : (
      <ul className="role-list">
        {initialRoles.map((role) => (
          <li key={role.id} className="role-card">
            <RoleSummary role={role} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="roles-admin">
      {initialRoles.length === 0 ? (
        <p className="meta">
          No roles yet. Create one below, or seed the suggested set to get started.
        </p>
      ) : (
        <ul className="role-list">
          {initialRoles.map((role) => (
            <li key={role.id} className="role-card">
              <RoleEditor mode="edit" role={role} />
            </li>
          ))}
        </ul>
      )}

      <div className="role-create">
        <h4>Add a role</h4>
        <RoleEditor mode="create" />
      </div>

      <form action={addSuggestedRoles} className="role-suggest">
        <button type="submit" className="ghost-btn">
          + Add suggested roles
        </button>
        <span className="meta">Façade &amp; Fire Safety, Project Delivery, Specifications &amp; Standards.</span>
      </form>
    </div>
  );
}

function RoleSummary({ role }: { role: RetrievalRole }) {
  return (
    <>
      <div className="role-card-head">
        <strong>{role.name}</strong>
        <span className="role-weight">×{role.weight}</span>
      </div>
      {role.description ? <p className="meta">{role.description}</p> : null}
      <div className="role-focus">
        {role.boostTypes.map((t) => (
          <span key={t} className="role-type-chip">
            {t}
          </span>
        ))}
        {role.boostTags.map((t) => (
          <span key={t} className="role-tag-chip">
            #{t}
          </span>
        ))}
      </div>
    </>
  );
}

function closestStrengthId(weight: number): string {
  let bestId: string = STRENGTH_PRESETS[1].id;
  let bestDiff = Math.abs(STRENGTH_PRESETS[1].weight - weight);
  for (const p of STRENGTH_PRESETS) {
    const diff = Math.abs(p.weight - weight);
    if (diff < bestDiff) {
      bestId = p.id;
      bestDiff = diff;
    }
  }
  return bestId;
}

function RoleEditor({ mode, role }: { mode: 'create' | 'edit'; role?: RetrievalRole }) {
  const action = mode === 'edit' ? updateRole : createRole;
  const [state, formAction, pending] = useActionState<RoleFormState, FormData>(action, { ok: true });
  // Edit forms start collapsed to a summary; expand to reveal the fields.
  const [open, setOpen] = useState(mode === 'create');

  if (mode === 'edit' && !open) {
    return (
      <div className="role-collapsed">
        <RoleSummary role={role!} />
        <div className="role-card-actions">
          <button type="button" className="ghost-btn" onClick={() => setOpen(true)}>
            Edit
          </button>
          <DeleteRoleButton id={role!.id} />
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="role-form">
      {mode === 'edit' ? <input type="hidden" name="id" value={role!.id} /> : null}
      <label>
        Name
        <input
          name="name"
          defaultValue={role?.name ?? ''}
          maxLength={60}
          required
          autoComplete="off"
          placeholder="e.g. Façade &amp; Fire Safety"
        />
      </label>
      <label>
        Description <span className="meta">(optional)</span>
        <input
          name="description"
          defaultValue={role?.description ?? ''}
          maxLength={140}
          autoComplete="off"
          placeholder="What this lens focuses answers on"
        />
      </label>
      <label>
        Focus tags <span className="meta">(comma-separated)</span>
        <input
          name="tags"
          defaultValue={(role?.boostTags ?? []).join(', ')}
          autoComplete="off"
          placeholder="firestop, fire-safety, curtain-wall"
        />
      </label>

      <fieldset className="role-types">
        <legend>Focus entity types</legend>
        <div className="role-type-grid">
          {ENTITY_TYPES.map((t) => (
            <label key={t} className="role-type-option">
              <input
                type="checkbox"
                name="types"
                value={t}
                defaultChecked={role?.boostTypes.includes(t) ?? false}
              />
              {t}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="role-strength">
        <legend>Strength</legend>
        <div className="role-strength-options">
          {STRENGTH_PRESETS.map((p) => {
            const selected = closestStrengthId(role?.weight ?? STRENGTH_PRESETS[1].weight);
            return (
              <label key={p.id} className="role-strength-option">
                <input type="radio" name="strength" value={p.id} defaultChecked={p.id === selected} />
                {p.label} <span className="meta">×{p.weight}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="role-form-actions">
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : mode === 'create' ? 'Create role' : 'Save'}
        </button>
        {mode === 'edit' ? (
          <>
            <button type="button" className="ghost-btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <DeleteRoleButton id={role!.id} />
          </>
        ) : null}
        {state.message ? (
          <span className={`role-msg${state.ok ? ' ok' : ' err'}`} role="status" aria-live="polite">
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function DeleteRoleButton({ id }: { id: string }) {
  return (
    <form action={deleteRole} className="role-delete">
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="ghost-btn danger">
        Delete
      </button>
    </form>
  );
}
