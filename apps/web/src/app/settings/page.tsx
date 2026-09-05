import type { ReviewStatus } from '@ekg/core';
import { inspectDatabase } from '@ekg/store-sqlite';
import { getCaller, getFirmName, getRoles, getStore, isAdmin, storePath } from '../../lib/store';
import { AppearanceSettings } from '../../components/AppearanceSettings';
import { FirmNameSettings } from '../../components/FirmNameSettings';
import { RolesSettings } from '../../components/RolesSettings';
import { ReviewBadge } from '../../components/ui';

export const dynamic = 'force-dynamic';

/**
 * Workspace settings. Appearance (theme/density) is a client preference;
 * everything else here is an honest, read-only view of the running dev
 * deployment — identity, retrieval backend, and graph health — surfacing
 * what the app already hints at in header tooltips. Production turns the
 * read-only blocks into real controls behind the curator/admin role (P0-9).
 */
export default async function SettingsPage() {
  const store = await getStore();
  const caller = await getCaller();
  const entities = await store.list(caller, { limit: 2000 });
  const relationships = await store.listRelationships(caller);

  const byStatus = new Map<ReviewStatus, number>();
  for (const e of entities) {
    const s = e.provenance.reviewStatus;
    byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
  }

  const firmName = await getFirmName();
  const canEditFirmName = isAdmin(caller);
  const roles = await getRoles();
  const canEditRoles = isAdmin(caller);

  const provider = process.env.EKG_EMBEDDINGS_PROVIDER;
  const dbPath = process.env.EKG_DB_PATH ?? '.data/ekg.db';
  const retrieval = provider
    ? `Hybrid — lexical + FTS5 + dense (${provider})`
    : 'Lexical + FTS5 only (no embedding provider configured)';
  // Schema state of the file this process opened (ADR 0012) — read-only, no
  // integrity scan on a page render; `npm run db -- status` does the full check.
  const dbFile = storePath();
  const schema = dbFile ? inspectDatabase(dbFile, { check: false }) : undefined;
  const schemaLine = !schema
    ? 'in-memory (ephemeral, no file)'
    : schema.tooNew
      ? `v${schema.version} — newer than this build supports (v${schema.latest})`
      : schema.pending.length > 0
        ? `v${schema.version} → v${schema.latest} pending (applied on next open)`
        : `v${schema.version} (current)`;
  const lastUpgrade = schema?.ledger[schema.ledger.length - 1];

  return (
    <>
      <h2 style={{ marginTop: 0 }}>Settings</h2>

      <section className="settings-section">
        <div className="settings-head">
          <h3>Appearance</h3>
          <p className="meta">Stored on this device. Applied before first paint, so no flash on reload.</p>
        </div>
        <AppearanceSettings />
      </section>

      <section className="settings-section">
        <div className="settings-head">
          <h3>Identity</h3>
          <p className="meta">
            The firm name is how this workspace presents itself — in the header and in grounded
            answers. Only an admin can change it. The tenant id and principals below are the
            signed-in caller for this request (a fixed dev identity in local development); a deployed
            app resolves the caller per request from Entra ID SSO and trims every read by it (PRD
            P0-7, P0-9).
          </p>
        </div>
        <FirmNameSettings initialFirmName={firmName} canEdit={canEditFirmName} />
        <dl className="kv-list">
          <div>
            <dt>Tenant id</dt>
            <dd>
              <code>{caller.tenantId}</code>
            </dd>
          </div>
          <div>
            <dt>Principals</dt>
            <dd>
              {caller.principals.map((p) => (
                <code key={p} className="inline-code">
                  {p}
                </code>
              ))}
            </dd>
          </div>
        </dl>
      </section>

      <section className="settings-section">
        <div className="settings-head">
          <h3>Retrieval &amp; storage</h3>
          <p className="meta">
            How search ranks results and where curated knowledge lives. Configure with
            <code className="inline-code">EKG_EMBEDDINGS_PROVIDER</code> and
            <code className="inline-code">EKG_DB_PATH</code>.
          </p>
        </div>
        <dl className="kv-list">
          <div>
            <dt>Retrieval mode</dt>
            <dd>{retrieval}</dd>
          </div>
          <div>
            <dt>Store</dt>
            <dd>
              SQLite · <code>{dbPath}</code>
            </dd>
          </div>
          <div>
            <dt>Schema</dt>
            <dd>
              {schemaLine}
              {schema?.ftsRecipe !== undefined && schema?.ftsRecipe !== null
                ? ` · FTS recipe v${schema.ftsRecipe}`
                : ''}
              {lastUpgrade ? ` · last upgraded ${lastUpgrade.appliedAt.slice(0, 10)} (${lastUpgrade.name})` : ''}
              {schema ? (
                <>
                  {' '}
                  — backups, verify and restore via <code className="inline-code">npm run db -- status</code>
                </>
              ) : null}
            </dd>
          </div>
        </dl>
      </section>

      <section className="settings-section">
        <div className="settings-head">
          <h3>Retrieval roles</h3>
          <p className="meta">
            Focus lenses an admin defines to pivot retrieval toward the knowledge a kind of work
            cares about. A role <strong>re-ranks</strong> — it boosts items carrying its tags or
            types so they surface first, but never hides anything, so honest no-answer results and
            permissions are unaffected (PRD P0-7, P0-8). Roles apply in search, on the map, and
            through the MCP gateway. This is unrelated to access roles.
          </p>
        </div>
        <RolesSettings initialRoles={roles} canEdit={canEditRoles} />
      </section>

      <section className="settings-section">
        <div className="settings-head">
          <h3>Knowledge graph</h3>
          <p className="meta">Current contents visible to your identity.</p>
        </div>
        <div className="settings-stats">
          <div className="settings-stat">
            <span className="settings-stat-num">{entities.length.toLocaleString()}</span>
            <span className="settings-stat-label">entities</span>
          </div>
          <div className="settings-stat">
            <span className="settings-stat-num">{relationships.length.toLocaleString()}</span>
            <span className="settings-stat-label">relationships</span>
          </div>
        </div>
        <div className="status-rows">
          {(['verified', 'unverified', 'superseded', 'deprecated'] as ReviewStatus[])
            .filter((s) => byStatus.get(s))
            .map((s) => (
              <div key={s} className="status-row">
                <ReviewBadge status={s} />
                <span className="status-count">{byStatus.get(s)}</span>
              </div>
            ))}
        </div>
        {byStatus.get('unverified') ? (
          <p className="meta" style={{ marginTop: '0.7rem' }}>
            <a href="/curation">
              {byStatus.get('unverified')} candidate
              {byStatus.get('unverified') === 1 ? '' : 's'} awaiting review →
            </a>
          </p>
        ) : null}
      </section>
    </>
  );
}
