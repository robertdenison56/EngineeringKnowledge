import Link from 'next/link';
import { isPublicAcl, type Acl, type Entity, type ReviewStatus, type SourceSystem } from '@ekg/core';

/** Human labels for where an item entered the graph (PRD P0-2 provenance). */
const SOURCE_LABELS: Record<string, string> = {
  upload: 'Uploaded',
  folder: 'Folder ingest',
  csv: 'CSV import',
  manual: 'Manual capture',
  gateway: 'Assistant ingest',
  sharepoint: 'SharePoint',
  onedrive: 'OneDrive',
  procore: 'Procore',
  acc: 'Autodesk Construction Cloud',
};

export function sourceLabel(system: SourceSystem | undefined): string | undefined {
  return system ? (SOURCE_LABELS[system] ?? system) : undefined;
}

export const TYPE_COLORS: Record<string, string> = {
  project: '#7c3aed',
  'design-detail': '#2563eb',
  'spec-section': '#0891b2',
  standard: '#475569',
  'lesson-learned': '#d97706',
  rfi: '#db2777',
  person: '#16a34a',
  client: '#9333ea',
  material: '#b45309',
  discipline: '#0d9488',
  document: '#64748b',
};

export function typeColor(type: string): string {
  return TYPE_COLORS[type] ?? '#6b7280';
}

const REVIEW_STYLES: Record<ReviewStatus, { bg: string; fg: string; label: string }> = {
  verified: { bg: '#dcfce7', fg: '#166534', label: 'Verified' },
  unverified: { bg: '#f1f5f9', fg: '#475569', label: 'Unverified' },
  superseded: { bg: '#fef3c7', fg: '#92400e', label: 'Superseded' },
  deprecated: { bg: '#fee2e2', fg: '#991b1b', label: 'Deprecated' },
};

/** Mirrors the gateway's P0-8 behavior: flagged items are never shown clean. */
export const REVIEW_WARNINGS: Partial<Record<ReviewStatus, string>> = {
  superseded:
    'This item has been superseded. Check its relationships for the current replacement before relying on it.',
  deprecated: 'This item is deprecated and must not be used on new work.',
};

export function TypeBadge({ type }: { type: string }) {
  return (
    <span className="badge" style={{ background: typeColor(type), color: '#fff' }}>
      {type}
    </span>
  );
}

export function ReviewBadge({ status }: { status: ReviewStatus }) {
  const s = REVIEW_STYLES[status] ?? REVIEW_STYLES.unverified;
  return (
    <span className="badge" style={{ background: s.bg, color: s.fg }}>
      {s.label}
    </span>
  );
}

export function entityHref(id: string): string {
  return `/entities/${encodeURIComponent(id)}`;
}

/**
 * Visibility chip (PRD P0-2 item ACLs). Public items are the norm, so they show
 * nothing — only a restricted ACL gets a badge, with the allowed principals on
 * hover, so a curator can spot and confirm scoped material before verifying.
 */
export function AccessBadge({ acl }: { acl: Acl }) {
  if (isPublicAcl(acl)) return null;
  const who = acl.allowedPrincipals.join(', ');
  return (
    <span
      className="badge access-badge"
      title={`Restricted — only ${who} can retrieve this item.`}
    >
      🔒 {acl.allowedPrincipals.length} principal{acl.allowedPrincipals.length === 1 ? '' : 's'}
    </span>
  );
}

export function TagChips({ tags }: { tags?: string[] }) {
  if (!tags || tags.length === 0) return null;
  return (
    <span className="tags">
      {tags.map((t) => (
        <Link key={t} href={`/search?tag=${encodeURIComponent(t)}`} className="tag-chip">
          #{t}
        </Link>
      ))}
    </span>
  );
}

export function ProvenanceLine({ entity }: { entity: Entity }) {
  const p = entity.provenance;
  return (
    <p className="meta">
      {p.author ? <>By {p.author} · </> : null}
      Updated {p.modifiedAt.slice(0, 10)}
      {p.anchor?.sheet ? <> · Sheet {p.anchor.sheet}</> : null}
      {p.anchor?.page ? <> · p. {p.anchor.page}</> : null}
      {p.anchor?.specSection ? <> · § {p.anchor.specSection}</> : null}
      {p.sourceUrl ? (
        <>
          {' · '}
          <a href={p.sourceUrl} target="_blank" rel="noreferrer">
            Source document ↗
          </a>
        </>
      ) : null}
      {sourceLabel(p.sourceSystem) ? <> · via {sourceLabel(p.sourceSystem)}</> : null}
    </p>
  );
}

/** The passage a search hit matched on, for citation in the card (ADR 0006). */
export interface CardMatch {
  heading?: string;
  snippet: string;
}

export function EntityCard({
  entity,
  match,
  focused,
}: {
  entity: Entity;
  match?: CardMatch;
  /** True when the active retrieval role favors this item (boosted its rank). */
  focused?: boolean;
}) {
  const warning = REVIEW_WARNINGS[entity.provenance.reviewStatus];
  return (
    <article
      className={`card${focused ? ' focused' : ''}`}
      style={{ ['--accent-rail' as string]: typeColor(entity.type) }}
    >
      <div className="card-head">
        <Link href={entityHref(entity.id)} className="card-title">
          {entity.title}
        </Link>
        <span className="badges">
          {focused ? <span className="badge focus-badge">◎ Focused</span> : null}
          <TypeBadge type={entity.type} />
          <ReviewBadge status={entity.provenance.reviewStatus} />
        </span>
      </div>
      {warning ? <p className="warning">⚠ {warning}</p> : null}
      {match ? (
        <p className="summary">
          {match.heading ? <span className="match-loc">{match.heading} — </span> : null}
          <span className="match-snippet">{match.snippet}</span>
        </p>
      ) : entity.summary ? (
        <p className="summary">{entity.summary}</p>
      ) : null}
      <TagChips tags={entity.tags} />
      <ProvenanceLine entity={entity} />
    </article>
  );
}
