'use client';

import { useState } from 'react';

/**
 * Visibility control shared by the document uploader and the CSV importer
 * (PRD P0-2 "source-system permissions… stored as item ACLs"). Until a source
 * connector maps real permissions, this is the manual capture point: public
 * (tenant-readable) by default, or restricted to a list of principals — Entra
 * group/user ids in production (e.g. `group:legal`, `user:dana`). The chosen
 * value posts as `visibility` + `principals`; the Server Action turns it into
 * the item ACL via `aclFromPrincipals`.
 */
export function VisibilityFields() {
  const [restricted, setRestricted] = useState(false);

  return (
    <fieldset className="visibility">
      <legend>Who can see these items</legend>
      <label className="vis-opt">
        <input
          type="radio"
          name="visibility"
          value="public"
          defaultChecked
          onChange={() => setRestricted(false)}
        />
        <span>
          <strong>Everyone in the workspace</strong>
          <span className="vis-hint">Tenant-readable, subject to each user's identity.</span>
        </span>
      </label>
      <label className="vis-opt">
        <input
          type="radio"
          name="visibility"
          value="restricted"
          onChange={() => setRestricted(true)}
        />
        <span>
          <strong>Restricted to specific people or groups</strong>
          <span className="vis-hint">Only the principals you list below may retrieve them.</span>
        </span>
      </label>
      {restricted && (
        <input
          className="vis-principals"
          name="principals"
          placeholder="comma-separated, e.g. group:legal, user:dana"
          aria-label="Allowed principals"
        />
      )}
    </fieldset>
  );
}
