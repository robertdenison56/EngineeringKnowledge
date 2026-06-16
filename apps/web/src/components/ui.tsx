import Link from 'next/link';
import type { Entity, ReviewStatus } from '@ekg/core';

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
    </p>
  );
}

/** The passage a search hit matched on, for citation in the card (ADR 0006). */
export interface CardMatch {
  heading?: string;
  snippet: string;
}

export function EntityCard({ entity, match }: { entity: Entity; match?: CardMatch }) {
  const warning = REVIEW_WARNINGS[entity.provenance.reviewStatus];
  return (
    <article className="card">
      <div className="card-head">
        <Link href={entityHref(entity.id)} className="card-title">
          {entity.title}
        </Link>
        <span className="badges">
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
