import type { ReviewStatus } from '@ekg/core';
import { DEV_CALLER, getStore } from '../../lib/store';
import { AppearanceSettings } from '../../components/AppearanceSettings';
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
  const entities = await store.list(DEV_CALLER, { limit: 2000 });
  const relationships = await store.listRelationships(DEV_CALLER);

  const byStatus = new Map<ReviewStatus, number>();
  for (const e of entities) {
    const s = e.provenance.reviewStatus;
    byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
  }

  const provider = process.env.EKG_EMBEDDINGS_PROVIDER;
  const dbPath = process.env.EKG_DB_PATH ?? '.data/ekg.db';
  const retrieval = provider
    ? `Hybrid — lexical + FTS5 + dense (${provider})`
    : 'Lexical + FTS5 only (no embedding provider configured)';

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
            Fixed development identity. Production resolves the caller per request from Entra ID
            SSO and trims every read by it (PRD P0-7, P0-9).
          </p>
        </div>
        <dl className="kv-list">
          <div>
            <dt>Tenant</dt>
            <dd>
              <code>{DEV_CALLER.tenantId}</code>
            </dd>
          </div>
          <div>
            <dt>Principals</dt>
            <dd>
              {DEV_CALLER.principals.map((p) => (
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
        </dl>
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
