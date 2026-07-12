import type { Entity } from '@ekg/core';
import { RELATIONSHIP_TYPES } from '@ekg/core';
import { addRelationship, updateAcl } from './actions';

/**
 * Curator controls for an item's visibility and outgoing links (PRD P0-2 item
 * ACLs, P0-1 curator-created relationships; gaps G4/G6). Rendered only for
 * curators; the server actions re-check the role — the UI is an affordance,
 * not the boundary.
 */
export function AccessAndLinksPanel({
  entity,
  linkTargets,
}: {
  entity: Entity;
  /** Entities offered by the add-relationship picker. */
  linkTargets: Entity[];
}) {
  return (
    <details className="doc-panel">
      <summary>Access &amp; relationships — who can see this item, and what it links to</summary>

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
