import type { Entity } from '@ekg/core';
import { deprecateEntity, restoreEntity, supersedeEntity } from '../app/entities/[id]/actions';
import type { MergeCandidate } from './EntityEditor';

/**
 * Curator controls for the superseded/deprecated lifecycle (PRD P0-1 review
 * states, P0-8 "flag, don't delete"; gap G5). The states were already honoured
 * on reads (badges + gateway warnings) but could not be SET from the GUI — this
 * is that control. Plain server-action forms, gated by the same `isCurator`
 * check the actions re-enforce server-side.
 */
export function LifecycleControls({
  entity,
  mergeCandidates,
}: {
  entity: Entity;
  mergeCandidates: MergeCandidate[];
}) {
  const status = entity.provenance.reviewStatus;
  const flagged = status === 'superseded' || status === 'deprecated';

  return (
    <details className="lifecycle-panel">
      <summary>Lifecycle — flag this item, don’t delete it</summary>
      <div className="lifecycle-body">
        {flagged ? (
          <form action={restoreEntity} className="lifecycle-row">
            <input type="hidden" name="id" value={entity.id} />
            <span className="meta">
              This item is <strong>{status}</strong>. Restoring returns it to verified.
            </span>
            <button type="submit" className="btn-verify">
              ↩ Restore to verified
            </button>
          </form>
        ) : (
          <>
            <form action={supersedeEntity} className="lifecycle-row">
              <input type="hidden" name="id" value={entity.id} />
              <label className="meta" htmlFor="supersede-with">
                Superseded by
              </label>
              <select id="supersede-with" name="replacementId" defaultValue="" required>
                <option value="" disabled>
                  {mergeCandidates.length > 0
                    ? 'Choose the current version…'
                    : 'No other items of this type'}
                </option>
                {mergeCandidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn-reject" disabled={mergeCandidates.length === 0}>
                Mark superseded
              </button>
            </form>
            <form action={deprecateEntity} className="lifecycle-row">
              <input type="hidden" name="id" value={entity.id} />
              <span className="meta">No longer current, with no single replacement.</span>
              <button type="submit" className="btn-reject">
                Deprecate
              </button>
            </form>
          </>
        )}
      </div>
    </details>
  );
}
