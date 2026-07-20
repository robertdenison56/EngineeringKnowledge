import Link from 'next/link';
import { getCaller, getStore, isCurator } from '../../lib/store';
import { readAuditTrail } from '../../lib/analytics-source';
import { analyzeUsage, WEB_TRANSPORT } from '../../lib/analytics';
import { entityHref, ReviewBadge, TypeBadge } from '../../components/ui';

export const dynamic = 'force-dynamic';

/** "2026-07-19T21:51:02.123Z" → "2026-07-19 21:51 UTC" — deterministic, honest. */
function shortTs(ts?: string): string {
  return ts ? `${ts.slice(0, 16).replace('T', ' ')} UTC` : '—';
}

/**
 * Usage analytics (PRD P1-4, user story 11): what people ask through the
 * gateways, what the graph had no answer for, which items actually get cited,
 * and which surfaces are being used. Aggregated from the P0-7 audit trail —
 * the same JSONL the gateways and the app already write — so the numbers are
 * exactly the calls that happened, nothing modeled.
 */
export default async function AnalyticsPage() {
  const caller = await getCaller();
  if (!isCurator(caller)) {
    return (
      <>
        <h2 style={{ marginTop: 0 }}>Usage analytics</h2>
        <p className="meta">
          Usage analytics are visible to curators and admins. Your signed-in identity does not
          carry the curator role — ask an admin to add you to the curator group.
        </p>
      </>
    );
  }

  const trail = readAuditTrail();
  const usage = analyzeUsage(trail.events, { tenantId: caller.tenantId });
  const gatewayCalls = usage.byTransport
    .filter((t) => t.transport !== WEB_TRANSPORT)
    .reduce((sum, t) => sum + t.calls, 0);

  // Resolve titles for the most-cited items as THIS caller — an item their ACL
  // trims stays a bare id with its count, never a leaked title.
  const store = await getStore();
  const cited = await Promise.all(
    usage.topCited.map(async (c) => ({ ...c, entity: await store.getEntity(caller, c.id) })),
  );

  return (
    <>
      <h2 style={{ marginTop: 0 }}>Usage analytics</h2>
      <p className="meta">
        Aggregated from the audit trail at <code>{trail.sourcePath}</code>
        {trail.exists ? (
          <>
            {' '}
            — covering {shortTs(usage.firstTs)} to {shortTs(usage.lastTs)}
            {trail.truncated
              ? ' (large trail: only the most recent 8 MB is aggregated)'
              : ''}
            . Every number is a recorded call (PRD P0-7); nothing is sampled or modeled.
          </>
        ) : (
          <> — no audit file exists there yet, so there is nothing to report.</>
        )}
      </p>

      {trail.exists && usage.totalCalls === 0 ? (
        <p className="meta">
          The trail has no events for your firm yet. Ask something through a connected assistant,
          or curate something here, and this page fills in.
        </p>
      ) : null}

      {usage.totalCalls > 0 ? (
        <>
          <div className="settings-stats" style={{ flexWrap: 'wrap' }}>
            <div className="settings-stat">
              <span className="settings-stat-num">{usage.totalCalls.toLocaleString()}</span>
              <span className="settings-stat-label">recorded calls</span>
            </div>
            <div className="settings-stat">
              <span className="settings-stat-num">{gatewayCalls.toLocaleString()}</span>
              <span className="settings-stat-label">via assistant gateways</span>
            </div>
            <div className="settings-stat">
              <span className="settings-stat-num">{usage.distinctPrincipals.toLocaleString()}</span>
              <span className="settings-stat-label">distinct users</span>
            </div>
            <div className="settings-stat">
              <span className="settings-stat-num">{usage.zeroResultQueries.length.toLocaleString()}</span>
              <span className="settings-stat-label">zero-result query themes</span>
            </div>
            <div className="settings-stat">
              <span className="settings-stat-num">{usage.errorCount.toLocaleString()}</span>
              <span className="settings-stat-label">errors</span>
            </div>
          </div>

          <section className="settings-section">
            <div className="settings-head">
              <h3>Adoption by surface</h3>
              <p className="meta">
                Which gateways are actually being used (PRD P1-4). <code>web</code> is this app;
                everything else is an assistant surface.
              </p>
            </div>
            <table className="rel-table">
              <tbody>
                {usage.byTransport.map((t) => (
                  <tr key={t.transport}>
                    <td>
                      <code>{t.transport}</code>
                    </td>
                    <td>{t.calls.toLocaleString()} calls</td>
                    <td>
                      {t.principals.toLocaleString()} user{t.principals === 1 ? '' : 's'}
                    </td>
                    <td className="meta">last {shortTs(t.lastTs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="settings-section">
            <div className="settings-head">
              <h3>Zero-result queries</h3>
              <p className="meta">
                What people asked that the graph could not answer — the strongest signal for what
                to capture or ingest next. An honest &ldquo;no firm answer&rdquo; landing here is
                the system working (P0-8); the same question landing here repeatedly is a gap.
              </p>
            </div>
            {usage.zeroResultQueries.length === 0 ? (
              <p className="meta">None recorded — every query in the window found something.</p>
            ) : (
              <table className="rel-table">
                <tbody>
                  {usage.zeroResultQueries.map((q) => (
                    <tr key={q.query}>
                      <td>“{q.query}”</td>
                      <td>
                        {q.count.toLocaleString()}×
                      </td>
                      <td className="meta">last {shortTs(q.lastTs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="settings-section">
            <div className="settings-head">
              <h3>Top queries</h3>
              <p className="meta">
                Most-asked query themes across assistant surfaces (grouped on exact normalized
                text — deterministic, not modeled).
              </p>
            </div>
            {usage.topQueries.length === 0 ? (
              <p className="meta">No queries recorded in the window.</p>
            ) : (
              <table className="rel-table">
                <tbody>
                  {usage.topQueries.map((q) => (
                    <tr key={q.query}>
                      <td>“{q.query}”</td>
                      <td>{q.count.toLocaleString()}×</td>
                      <td className="meta">last {shortTs(q.lastTs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="settings-section">
            <div className="settings-head">
              <h3>Most-cited knowledge</h3>
              <p className="meta">
                Items that appeared in assistant answers (read-tool results on gateway surfaces;
                the app&rsquo;s own curation reads are not counted). Items your permissions
                don&rsquo;t cover show as ids only.
              </p>
            </div>
            {cited.length === 0 ? (
              <p className="meta">No assistant citations recorded in the window.</p>
            ) : (
              <table className="rel-table">
                <tbody>
                  {cited.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.entity ? (
                          <Link href={entityHref(c.id)}>{c.entity.title}</Link>
                        ) : (
                          <code>{c.id}</code>
                        )}
                      </td>
                      <td>
                        {c.entity ? (
                          <span className="badges">
                            <TypeBadge type={c.entity.type} />
                            <ReviewBadge status={c.entity.provenance.reviewStatus} />
                          </span>
                        ) : (
                          <span className="meta">not visible to you</span>
                        )}
                      </td>
                      <td>
                        cited {c.count.toLocaleString()}×
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="settings-section">
            <div className="settings-head">
              <h3>Tool usage</h3>
              <p className="meta">Calls per gateway tool and app action in the window.</p>
            </div>
            <table className="rel-table">
              <tbody>
                {usage.byTool.map((t) => (
                  <tr key={t.tool}>
                    <td>
                      <code>{t.tool}</code>
                    </td>
                    <td>
                      {t.calls.toLocaleString()} call{t.calls === 1 ? '' : 's'}
                    </td>
                    <td className="meta">{t.errors > 0 ? `${t.errors} error${t.errors === 1 ? '' : 's'}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
    </>
  );
}
