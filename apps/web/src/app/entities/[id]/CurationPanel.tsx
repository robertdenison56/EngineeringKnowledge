import type { Entity } from '@ekg/core';
import { RELATIONSHIP_TYPES } from '@ekg/core';
import {
  addRelationship,
  mergeEntity,
  setReviewStatus,
  supersedeEntity,
  updateAcl,
  updateEntity,
} from '../../curation/actions';

/**
 * Curator controls on the entity page (PRD P0-1 create/edit/merge, P0-9
 * inline editing; gaps G3–G6): field editing, ACL, the superseded/deprecated
 * lifecycle, merge, and relationship creation. Rendered for every visitor
 * while the app runs as the fixed dev identity; Entra SSO roles gate it later
 * (gap G11).
 */
export function CurationPanel({
  entity,
  sameType,
  linkTargets,
}: {
  entity: Entity;
  /** Same-type entities (excluding this one) — supersede/merge candidates. */
  sameType: Entity[];
  /** Entities offered by the add-relationship picker. */
  linkTargets: Entity[];
}) {
  const status = entity.provenance.reviewStatus;
  return (
    <details className="doc-panel">
      <summary>Curate this item — edit fields, access, lifecycle, merge, relationships</summary>

      <h3>Fields</h3>
      <form action={updateEntity} className="capture-form">
        <input type="hidden" name="id" value={entity.id} />
        <label>
          Title
          <input name="title" defaultValue={entity.title} required />
        </label>
        <label>
          Summary
          <textarea name="summary" rows={3} defaultValue={entity.summary ?? ''} />
        </label>
        <div className="form-row">
          <label>
            Tags (comma-separated)
            <input name="tags" defaultValue={(entity.tags ?? []).join(', ')} />
          </label>
          <label>
            Aliases — domain synonyms retrieval should match
            <input name="aliases" defaultValue={(entity.aliases ?? []).join(', ')} />
          </label>
        </div>
        <button type="submit">Save fields</button>
      </form>

      <h3>Access</h3>
      <form action={updateAcl} className="capture-form">
        <input type="hidden" name="id" value={entity.id} />
        <label>
          Who can see this item (principals, comma-separated; <code>*</code> = whole firm)
          <input
            name="principals"
            defaultValue={entity.acl.allowedPrincipals.join(', ')}
            placeholder="* or e.g. group:legal, user:dana"
          />
        </label>
        <button type="submit">Save access</button>
      </form>

      <h3>Lifecycle</h3>
      <p className="meta">
        Flag, don&apos;t delete: superseded and deprecated items stay findable but every surface
        warns about them (PRD P0-8).
      </p>
      {/* One form per transition: values ride on hidden inputs because React
          does not serialize the submitter button's name/value for actions. */}
      <div className="actions">
        {status !== 'verified' ? (
          <form action={setReviewStatus}>
            <input type="hidden" name="id" value={entity.id} />
            <input type="hidden" name="status" value="verified" />
            <button type="submit" className="btn-verify">
              Mark verified
            </button>
          </form>
        ) : null}
        {status !== 'unverified' ? (
          <form action={setReviewStatus}>
            <input type="hidden" name="id" value={entity.id} />
            <input type="hidden" name="status" value="unverified" />
            <button type="submit">Send back to review queue</button>
          </form>
        ) : null}
        {status !== 'deprecated' ? (
          <form action={setReviewStatus}>
            <input type="hidden" name="id" value={entity.id} />
            <input type="hidden" name="status" value="deprecated" />
            <button type="submit" className="btn-reject">
              Mark deprecated
            </button>
          </form>
        ) : null}
      </div>
      {sameType.length > 0 ? (
        <form action={supersedeEntity} className="capture-form">
          <input type="hidden" name="id" value={entity.id} />
          <label>
            Superseded by…
            <select name="replacementId" required defaultValue="">
              <option value="" disabled>
                Choose the replacement ({entity.type})
              </option>
              {sameType.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Mark superseded and link the replacement</button>
        </form>
      ) : null}

      {sameType.length > 0 ? (
        <>
          <h3>Merge</h3>
          <p className="meta">
            Merging moves this item&apos;s relationships, tags, and aliases onto the survivor and
            removes this duplicate. The removed record is kept in the audit trail.
          </p>
          <form action={mergeEntity} className="capture-form">
            <input type="hidden" name="id" value={entity.id} />
            <label>
              Merge this item into…
              <select name="survivorId" required defaultValue="">
                <option value="" disabled>
                  Choose the surviving {entity.type}
                </option>
                {sameType.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn-reject">
              Merge (removes this duplicate)
            </button>
          </form>
        </>
      ) : null}

      <h3>Add relationship</h3>
      <form action={addRelationship} className="capture-form">
        <input type="hidden" name="id" value={entity.id} />
        <div className="form-row">
          <label>
            Direction
            <select name="direction" defaultValue="out">
              <option value="out">this item → target</option>
              <option value="in">target → this item</option>
            </select>
          </label>
          <label>
            Type
            <select name="type" defaultValue="used-in">
              {RELATIONSHIP_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Target entity (pick by id — titles shown as you type)
          <input name="targetId" list="ekg-link-targets" required placeholder="e.g. project:riverside" />
        </label>
        <datalist id="ekg-link-targets">
          {linkTargets.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title} ({e.type})
            </option>
          ))}
        </datalist>
        <button type="submit">Add relationship</button>
      </form>
    </details>
  );
}
