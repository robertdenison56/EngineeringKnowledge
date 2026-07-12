'use client';

import { useActionState, useState } from 'react';
import { ENTITY_TYPES, type Entity } from '@ekg/core';
import {
  editEntity,
  mergeEntities,
  removeRelationship,
  type EditState,
} from '../app/entities/[id]/actions';

/** Lightweight candidate shape for the merge picker (no content/provenance). */
export interface MergeCandidate {
  id: string;
  title: string;
  type: string;
  reviewStatus: string;
}

/**
 * Curator-only inline editing and duplicate merge for an entity page (PRD
 * P0-1, P0-9 G3/G4). Every mutation goes through a server action that re-checks
 * the curator role, so this component only decides what to render — non-curators
 * never receive it. Collapsed by default so the page reads cleanly; the curator
 * opens it to correct fields or fold in a duplicate.
 */
export function EntityEditor({
  entity,
  mergeCandidates,
}: {
  entity: Entity;
  mergeCandidates: MergeCandidate[];
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="entity-edit-bar">
        <button type="button" className="ghost-btn" onClick={() => setOpen(true)}>
          ✎ Edit entity
        </button>
        <span className="meta">Correct fields, tags &amp; aliases, or merge a duplicate.</span>
      </div>
    );
  }

  return (
    <div className="entity-editor">
      <div className="entity-editor-head">
        <h3 style={{ margin: 0 }}>Edit entity</h3>
        <button type="button" className="ghost-btn" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <EditForm entity={entity} />
      <MergeForm entity={entity} candidates={mergeCandidates} />
    </div>
  );
}

/**
 * Curator-only "remove this edge" control for a relationship row. A confirm
 * guards the destructive submit; the server action re-checks the curator role.
 */
export function RemoveRelationshipButton({
  relId,
  entityId,
  label,
}: {
  relId: string;
  entityId: string;
  label: string;
}) {
  return (
    <form
      action={removeRelationship}
      onSubmit={(e) => {
        if (!window.confirm(`Remove the “${label}” relationship?`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="relId" value={relId} />
      <input type="hidden" name="entityId" value={entityId} />
      <button
        type="submit"
        className="rel-remove"
        title="Remove relationship"
        aria-label={`Remove relationship: ${label}`}
      >
        ×
      </button>
    </form>
  );
}

function EditForm({ entity }: { entity: Entity }) {
  const [state, formAction, pending] = useActionState<EditState, FormData>(editEntity, { ok: true });
  // A custom (tenant-defined) type stays selectable even though it isn't built in.
  const typeOptions = ENTITY_TYPES.includes(entity.type as (typeof ENTITY_TYPES)[number])
    ? ENTITY_TYPES
    : [entity.type, ...ENTITY_TYPES];

  return (
    <form action={formAction} className="entity-edit-form">
      <input type="hidden" name="id" value={entity.id} />
      <label>
        Title
        <input name="title" defaultValue={entity.title} maxLength={160} required autoComplete="off" />
      </label>
      <label>
        Type
        <select name="type" defaultValue={entity.type}>
          {typeOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label>
        Summary <span className="meta">(optional)</span>
        <textarea name="summary" defaultValue={entity.summary ?? ''} rows={3} maxLength={2000} />
      </label>
      <label>
        Tags <span className="meta">(comma-separated facets)</span>
        <input
          name="tags"
          defaultValue={(entity.tags ?? []).join(', ')}
          autoComplete="off"
          placeholder="firestop, fire-safety, curtain-wall"
        />
      </label>
      <label>
        Aliases <span className="meta">(synonyms retrieval should match)</span>
        <input
          name="aliases"
          defaultValue={(entity.aliases ?? []).join(', ')}
          autoComplete="off"
          placeholder="perimeter fire barrier, safing"
        />
      </label>
      <div className="entity-edit-actions">
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        {state.message ? (
          <span className={`edit-msg${state.ok ? ' ok' : ' err'}`} role="status" aria-live="polite">
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function MergeForm({ entity, candidates }: { entity: Entity; candidates: MergeCandidate[] }) {
  const [state, formAction, pending] = useActionState<EditState, FormData>(mergeEntities, { ok: true });
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState('');

  const shown = candidates.filter((c) => c.title.toLowerCase().includes(filter.trim().toLowerCase()));
  const chosen = candidates.find((c) => c.id === selected);

  return (
    <div className="entity-merge">
      <h4>Merge a duplicate into this entity</h4>
      <p className="meta">
        The other {entity.type} is deleted; its relationships and aliases move onto{' '}
        <strong>{entity.title}</strong>. This cannot be undone.
      </p>
      {candidates.length === 0 ? (
        <p className="meta">No other {entity.type} entities to merge.</p>
      ) : (
        <form
          action={formAction}
          className="entity-merge-form"
          onSubmit={(e) => {
            if (!selected) {
              e.preventDefault();
              return;
            }
            const ok = window.confirm(
              `Merge “${chosen?.title}” into “${entity.title}”? The duplicate will be deleted.`,
            );
            if (!ok) e.preventDefault();
          }}
        >
          <input type="hidden" name="survivorId" value={entity.id} />
          <input
            type="search"
            className="merge-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}…`}
            autoComplete="off"
            aria-label="Filter merge candidates"
          />
          <select
            name="duplicateId"
            className="merge-select"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            size={Math.min(6, Math.max(2, shown.length + 1))}
          >
            <option value="">Select a duplicate…</option>
            {shown.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
                {c.reviewStatus !== 'verified' ? ` · ${c.reviewStatus}` : ''}
              </option>
            ))}
          </select>
          <div className="entity-edit-actions">
            <button type="submit" className="btn-merge" disabled={pending || !selected}>
              {pending ? 'Merging…' : 'Fold into this entity'}
            </button>
            {state.message ? (
              <span className={`edit-msg${state.ok ? ' ok' : ' err'}`} role="status" aria-live="polite">
                {state.message}
              </span>
            ) : null}
          </div>
        </form>
      )}
    </div>
  );
}
