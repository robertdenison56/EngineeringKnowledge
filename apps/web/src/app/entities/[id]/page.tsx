import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isPublicAcl, type Entity, type NeighborHit } from '@ekg/core';
import type { SheetFacts } from '@ekg/ingestion';
import { getCaller, getStore, isCurator } from '../../../lib/store';
import { SheetStructure } from '../../../components/SheetStructure';
import { LifecycleControls } from '../../../components/LifecycleControls';
import { AccessAndLinksPanel } from './AccessAndLinksPanel';
import {
  AccessBadge,
  ProvenanceLine,
  REVIEW_WARNINGS,
  ReviewBadge,
  TagChips,
  TypeBadge,
  entityHref,
  sourceLabel,
  typeColor,
} from '../../../components/ui';
import { EntityEditor, RemoveRelationshipButton, type MergeCandidate } from '../../../components/EntityEditor';

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
  const caller = await getCaller();
  const entity = await store.getEntity(caller, id);
  if (!entity) notFound();
  const [neighbors, chunks] = await Promise.all([
    store.neighbors(caller, id),
    store.getChunks(caller, id),
  ]);

  const canCurate = isCurator(caller);
  // Targets for the add-relationship picker (curators only — the list is a
  // permission-trimmed read either way, this just skips the work for viewers).
  const linkTargets = canCurate
    ? (await store.list(caller, { limit: 1000 })).filter((e) => e.id !== entity.id)
    : [];
  // Merge candidates are the other entities of this type — duplicates are
  // almost always same-type; keeping the picker scoped keeps it legible.
  const mergeCandidates: MergeCandidate[] = canCurate
    ? (await store.list(caller, { types: [entity.type], limit: 200 }))
        .filter((e) => e.id !== entity.id)
        .map((e) => ({
          id: e.id,
          title: e.title,
          type: e.type,
          reviewStatus: e.provenance.reviewStatus,
        }))
    : [];

  const warning = REVIEW_WARNINGS[entity.provenance.reviewStatus];
  const supersededBy = neighbors.find(
    (n) => n.relationship.type === 'supersedes' && n.direction === 'in',
  );
  // The deterministic CAD/spec parse is surfaced in its own panel below, so keep
  // it out of the raw key/value dump (it renders cleanly, not as a JSON blob).
  const parserFacts = entity.properties.parserFacts as SheetFacts | undefined;
  const properties = Object.entries(entity.properties).filter(([k]) => k !== 'parserFacts');

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
          <AccessBadge acl={entity.acl} />
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
      <SheetStructure anchor={entity.provenance.anchor} facts={parserFacts} />
      {canCurate ? <EntityEditor entity={entity} mergeCandidates={mergeCandidates} /> : null}
      {canCurate ? <LifecycleControls entity={entity} mergeCandidates={mergeCandidates} /> : null}
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
                    {canCurate ? (
                      <td className="rel-remove-cell">
                        <RemoveRelationshipButton
                          relId={n.relationship.id}
                          entityId={entity.id}
                          label={`${n.relationship.type} · ${n.entity.title}`}
                        />
                      </td>
                    ) : null}
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
                    {isPublicAcl(entity.acl)
                      ? 'Everyone in the workspace'
                      : `Restricted — ${entity.acl.allowedPrincipals.join(', ')}`}
                  </td>
                </tr>
                {sourceLabel(entity.provenance.sourceSystem) ? (
                  <tr>
                    <td>Source system</td>
                    <td>{sourceLabel(entity.provenance.sourceSystem)}</td>
                  </tr>
                ) : null}
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

      {canCurate ? (
        <div style={{ marginTop: '1.2rem' }}>
          <AccessAndLinksPanel entity={entity} linkTargets={linkTargets} />
        </div>
      ) : null}
    </>
  );
}
