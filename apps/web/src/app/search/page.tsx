import { ENTITY_TYPES, entityMatchesRole, type Entity, type SearchHit } from '@ekg/core';
import { getCaller, getRole, getRoles, getStore } from '../../lib/store';
import { EntityCard } from '../../components/ui';
import {
  anyFacetActive,
  disciplineOptions,
  hitMatchesSection,
  inDateRange,
  matchesDiscipline,
} from '../../lib/facets';

const REVIEW_FILTERS = ['verified', 'unverified', 'superseded', 'deprecated'] as const;

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    type?: string;
    tag?: string;
    status?: string;
    role?: string;
    project?: string;
    discipline?: string;
    section?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const {
    q = '',
    type = '',
    tag = '',
    status = '',
    role = '',
    project = '',
    discipline = '',
    section = '',
    from = '',
    to = '',
  } = await searchParams;
  const store = await getStore();
  const caller = await getCaller();
  const types = type ? [type] : undefined;
  const tags = tag ? [tag] : undefined;

  const roles = await getRoles();
  const activeRole = await getRole(role);

  let hits: SearchHit[];
  if (q) {
    hits = await store.search(caller, q, { types, tags, limit: 25, boostRole: activeRole });
  } else {
    // Browse has no relevance score to boost, but a role still focuses the view:
    // surface the items it favors first.
    const listed = await store.list(caller, { types, tags, limit: 50 });
    const ordered = activeRole
      ? [
          ...listed.filter((e) => entityMatchesRole(e, activeRole)),
          ...listed.filter((e) => !entityMatchesRole(e, activeRole)),
        ]
      : listed;
    hits = ordered.map((entity) => ({ entity, score: 0 }));
  }

  // The full PRD P0-9 facet set (gap G7): review status, project, discipline,
  // spec section, date range — all pure post-filters, so the honest no-results
  // gate and role boosting behave identically with them on (P0-8).
  const preFacetCount = hits.length;
  if (status) hits = hits.filter((h) => h.entity.provenance.reviewStatus === status);
  const focusProject = project ? await store.getEntity(caller, project) : undefined;
  if (project) {
    // "On this project" = the project itself plus everything one hop away —
    // used-in details, had-issue lessons, applies-to specs, in either direction.
    const linked = new Set([project, ...(await store.neighbors(caller, project)).map((n) => n.entity.id)]);
    hits = hits.filter((h) => linked.has(h.entity.id));
  }
  if (section) hits = hits.filter((h) => hitMatchesSection(h, section));
  if (from || to) hits = hits.filter((h) => inDateRange(h.entity, from, to));
  // Discipline options come from the otherwise-filtered results, so the
  // dropdown always offers refinements that exist — and never loses the
  // active selection.
  const disciplines = disciplineOptions(hits, discipline);
  if (discipline) hits = hits.filter((h) => matchesDiscipline(h.entity, discipline));

  const projects = (await store.list(caller, { types: ['project'], limit: 200 })).sort((a, b) =>
    a.title.localeCompare(b.title),
  );

  const facetsActive = anyFacetActive({ status, project, discipline, section, from, to });
  // Facets hid everything the query matched — say that, not "no answer" (P0-8).
  const hiddenByFacets = hits.length === 0 && facetsActive && preFacetCount > 0;
  const clearFacetsHref = `/search?q=${encodeURIComponent(q)}${type ? `&type=${encodeURIComponent(type)}` : ''}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}${role ? `&role=${encodeURIComponent(role)}` : ''}`;

  const activeFacetNotes = [
    status ? `status ${status}` : null,
    focusProject ? `project ${focusProject.title}` : project ? `project ${project}` : null,
    discipline ? `discipline ${discipline}` : null,
    section ? `§ ${section}` : null,
    from || to ? `updated ${from || '…'} → ${to || '…'}` : null,
  ].filter(Boolean);

  return (
    <>
      <h2>Browse &amp; search</h2>
      <form action="/search" className="search-form">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search details, specs, lessons learned, experts…"
          aria-label="Search query"
        />
        <select name="type" defaultValue={type} aria-label="Entity type filter">
          <option value="">All types</option>
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={status} aria-label="Review status filter">
          <option value="">Any status</option>
          {REVIEW_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select name="role" defaultValue={role} aria-label="Retrieval role">
          <option value="">No role</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select name="project" defaultValue={project} aria-label="Project filter">
          <option value="">All projects</option>
          {projects.map((p: Entity) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <select name="discipline" defaultValue={discipline} aria-label="Discipline filter">
          <option value="">Any discipline</option>
          {disciplines.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <input
          type="text"
          name="section"
          defaultValue={section}
          placeholder="Spec section, e.g. 07 84 00"
          aria-label="MasterFormat section filter"
          className="facet-section"
        />
        <label className="facet-label">
          from
          <input type="date" name="from" defaultValue={from} aria-label="Updated on or after" />
        </label>
        <label className="facet-label">
          to
          <input type="date" name="to" defaultValue={to} aria-label="Updated on or before" />
        </label>
        {tag ? <input type="hidden" name="tag" value={tag} /> : null}
        <button type="submit">Search</button>
      </form>
      {tag ? (
        <p className="meta" style={{ marginBottom: '0.8rem' }}>
          Filtering by tag <strong>#{tag}</strong> ·{' '}
          <a href={`/search?q=${encodeURIComponent(q)}${role ? `&role=${encodeURIComponent(role)}` : ''}`}>
            clear
          </a>
        </p>
      ) : null}
      {activeFacetNotes.length > 0 ? (
        <p className="meta" style={{ marginBottom: '0.8rem' }}>
          Filtered by {activeFacetNotes.join(' · ')} · <a href={clearFacetsHref}>clear filters</a>
        </p>
      ) : null}
      {activeRole ? (
        <p className="meta role-active-note" style={{ marginBottom: '0.8rem' }}>
          ◎ Focused by <strong>{activeRole.name}</strong> — items it favors rank higher.{' '}
          <a href={`/search?q=${encodeURIComponent(q)}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}${type ? `&type=${encodeURIComponent(type)}` : ''}`}>
            clear
          </a>
        </p>
      ) : null}

      {hits.length === 0 ? (
        <div className="empty">
          {hiddenByFacets ? (
            <>
              <strong>
                {preFacetCount} match{preFacetCount === 1 ? '' : 'es'}
                {q ? <> for “{q}”</> : null} — all hidden by your filters.
              </strong>
              <br />
              The knowledge exists but doesn’t satisfy every active facet.{' '}
              <a href={clearFacetsHref}>Clear filters</a> to see it.
            </>
          ) : q ? (
            <>
              <strong>The firm graph has no answer for “{q}”.</strong>
              <br />
              Nothing matching was found in curated knowledge — this is reported honestly rather
              than filled in with general knowledge. If you learn the answer, capture it so the
              next engineer finds it here.
            </>
          ) : (
            <>No knowledge items of this type are visible to your identity.</>
          )}
        </div>
      ) : (
        <div className="cards">
          {hits.map((h) => (
            <EntityCard
              key={h.entity.id}
              entity={h.entity}
              focused={activeRole ? entityMatchesRole(h.entity, activeRole) : false}
              match={
                h.chunk
                  ? { snippet: h.chunk.snippet, ...(h.chunk.heading ? { heading: h.chunk.heading } : {}) }
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </>
  );
}
