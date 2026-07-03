import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Entity, NeighborHit } from '@ekg/core';
import { DEV_CALLER, getStore } from '../../../lib/store';
import { removeRelationship } from '../../curation/actions';
import { CurationPanel } from './CurationPanel';
import {
  ProvenanceLine,
  REVIEW_WARNINGS,
  ReviewBadge,
  TagChips,
  TypeBadge,
  entityHref,
  typeColor,
} from '../../../components/ui';

function shortTitle(title: string, max = 20): string {
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

/**
 * Server-rendered SVG neighborhood view — the seed of the P0-9 graph
 * explorer. Center node plus first-degree neighbors, clickable.
 */
function NeighborhoodGraph({ entity, neighbors }: { entity: Entity; neighbors: NeighborHit[] }) {
  const W = 640;
  const H = 400;
  const cx = W / 2;
  const cy = H / 2;
  const R = 140;
  const shown = neighbors.slice(0, 10);
  const placed = shown.map((n, i) => {
    const angle = (2 * Math.PI * i) / shown.length - Math.PI / 2;
    return { n, x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) };
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Graph neighborhood of ${entity.title}`}>
      {placed.map(({ n, x, y }) => (
        <g key={`edge-${n.relationship.id}`}>
          <line x1={cx} y1={cy} x2={x} y2={y} stroke="#cbd5e1" strokeWidth={1.5} />
          <text
            x={(cx + x) / 2}
            y={(cy + y) / 2 - 4}
            textAnchor="middle"
            fontSize={9}
            fill="#94a3b8"
          >
            {n.direction === 'out' ? n.relationship.type : `← ${n.relationship.type}`}
          </text>
        </g>
      ))}
      {placed.map(({ n, x, y }) => (
        <Link key={`node-${n.entity.id}`} href={entityHref(n.entity.id)}>
          <circle cx={x} cy={y} r={24} fill={typeColor(n.entity.type)} opacity={0.9} />
          <text x={x} y={y + 38} textAnchor="middle" fontSize={10} fill="#334155">
            {shortTitle(n.entity.title)}
          </text>
        </Link>
      ))}
      <circle cx={cx} cy={cy} r={30} fill={typeColor(entity.type)} stroke="#0f172a" strokeWidth={2} />
      <text x={cx} y={cy + 48} textAnchor="middle" fontSize={11} fontWeight={600} fill="#0f172a">
        {shortTitle(entity.title, 28)}
      </text>
    </svg>
  );
}

export default async function EntityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const store = await getStore();
  const entity = await store.getEntity(DEV_CALLER, id);
  if (!entity) notFound();
  const [neighbors, chunks, allEntities] = await Promise.all([
    store.neighbors(DEV_CALLER, id),
    store.getChunks(DEV_CALLER, id),
    store.list(DEV_CALLER, { limit: 1000 }),
  ]);
  const sameType = allEntities.filter((e) => e.type === entity.type && e.id !== entity.id);
  const linkTargets = allEntities.filter((e) => e.id !== entity.id);

  const warning = REVIEW_WARNINGS[entity.provenance.reviewStatus];
  const supersededBy = neighbors.find(
    (n) => n.relationship.type === 'supersedes' && n.direction === 'in',
  );
  const properties = Object.entries(entity.properties);

  return (
    <>
      <p className="breadcrumb">
        <Link href="/search">Browse</Link> / {entity.type}
      </p>
      <div className="card-head">
        <h1 style={{ margin: 0, fontSize: '1.4rem' }}>{entity.title}</h1>
        <span className="badges">
          <TypeBadge type={entity.type} />
          <ReviewBadge status={entity.provenance.reviewStatus} />
        </span>
      </div>
      {warning ? (
        <p className="warning">
          ⚠ {warning}
          {supersededBy ? (
            <>
              {' '}
              Current version:{' '}
              <Link href={entityHref(supersededBy.entity.id)}>{supersededBy.entity.title}</Link>
            </>
          ) : null}
        </p>
      ) : null}
      {entity.summary ? <p className="summary">{entity.summary}</p> : null}
      <TagChips tags={entity.tags} />
      <ProvenanceLine entity={entity} />
      {entity.content ? (
        <details className="doc-panel">
          <summary>
            Source document text
            {chunks.length > 0
              ? ` — preview of ${chunks.length.toLocaleString()} indexed passage${chunks.length === 1 ? '' : 's'}`
              : ` (${entity.content.length.toLocaleString()} characters)`}{' '}
            — verify the answer against the exact source
          </summary>
          <pre className="doc-text">{entity.content}</pre>
        </details>
      ) : null}
      {chunks.length > 1 ? (
        <details className="doc-panel">
          <summary>
            Document sections ({chunks.length.toLocaleString()}) — each searchable and citable by
            page/sheet/spec section (ADR 0006)
          </summary>
          <ol className="section-list">
            {chunks.map((c) => {
              const a = c.anchor ?? {};
              const loc = [
                a.sheet ? `Sheet ${a.sheet}` : null,
                a.specSection ? a.specSection : null,
                a.page ? `p. ${a.page}` : null,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <li key={c.id}>
                  <span className="section-loc">{loc || `Passage ${c.ordinal + 1}`}</span>
                  {c.heading && c.heading !== loc ? (
                    <span className="section-heading"> {c.heading}</span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </details>
      ) : null}

      <div className="entity-grid" style={{ marginTop: '1.2rem' }}>
        <div>
          <h2 style={{ marginTop: 0 }}>Graph neighborhood</h2>
          {neighbors.length > 0 ? (
            <div className="graph-card">
              <NeighborhoodGraph entity={entity} neighbors={neighbors} />
            </div>
          ) : (
            <div className="empty">No relationships yet.</div>
          )}

          <h2>Relationships</h2>
          {neighbors.length > 0 ? (
            <table className="rel-table">
              <tbody>
                {neighbors.map((n) => (
                  <tr key={n.relationship.id}>
                    <td>
                      <span className="rel-chip">
                        {n.direction === 'out' ? `${n.relationship.type} →` : `← ${n.relationship.type}`}
                      </span>
                    </td>
                    <td>
                      <Link href={entityHref(n.entity.id)}>{n.entity.title}</Link>
                    </td>
                    <td>
                      <TypeBadge type={n.entity.type} />
                    </td>
                    <td>
                      <ReviewBadge status={n.entity.provenance.reviewStatus} />
                    </td>
                    <td>
                      <form action={removeRelationship}>
                        <input type="hidden" name="id" value={entity.id} />
                        <input type="hidden" name="relId" value={n.relationship.id} />
                        <button
                          type="submit"
                          className="btn-reject"
                          title="Remove this relationship"
                          aria-label={`Remove ${n.relationship.type} relationship to ${n.entity.title}`}
                        >
                          ✕
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">No relationships yet.</div>
          )}
        </div>

        <div>
          <h2 style={{ marginTop: 0 }}>Record</h2>
          <div className="card">
            <table className="kv">
              <tbody>
                <tr>
                  <td>Entity id</td>
                  <td>
                    <code>{entity.id}</code>
                  </td>
                </tr>
                <tr>
                  <td>Review status</td>
                  <td>{entity.provenance.reviewStatus}</td>
                </tr>
                <tr>
                  <td>Access</td>
                  <td>
                    {entity.acl.allowedPrincipals.includes('*')
                      ? 'Whole firm'
                      : entity.acl.allowedPrincipals.join(', ')}
                  </td>
                </tr>
                {entity.provenance.author ? (
                  <tr>
                    <td>Author</td>
                    <td>{entity.provenance.author}</td>
                  </tr>
                ) : null}
                <tr>
                  <td>Created</td>
                  <td>{entity.provenance.createdAt.slice(0, 10)}</td>
                </tr>
                <tr>
                  <td>Modified</td>
                  <td>{entity.provenance.modifiedAt.slice(0, 10)}</td>
                </tr>
                {properties.map(([key, value]) => (
                  <tr key={key}>
                    <td>{key}</td>
                    <td>{typeof value === 'string' ? value : JSON.stringify(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div style={{ marginTop: '1.2rem' }}>
        <CurationPanel entity={entity} sameType={sameType} linkTargets={linkTargets} />
      </div>
    </>
  );
}
