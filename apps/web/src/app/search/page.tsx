import { ENTITY_TYPES, entityMatchesRole, type SearchHit } from '@ekg/core';
import { getCaller, getRole, getRoles, getStore } from '../../lib/store';
import { EntityCard } from '../../components/ui';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; tag?: string; role?: string }>;
}) {
  const { q = '', type = '', tag = '', role = '' } = await searchParams;
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
        <select name="role" defaultValue={role} aria-label="Retrieval role">
          <option value="">No role</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
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
          {q ? (
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
