import { ENTITY_TYPES } from '@ekg/core';
import { DEV_CALLER, getStore } from '../../lib/store';
import { EntityCard } from '../../components/ui';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; tag?: string }>;
}) {
  const { q = '', type = '', tag = '' } = await searchParams;
  const store = await getStore();
  const types = type ? [type] : undefined;
  const tags = tag ? [tag] : undefined;

  const entities = q
    ? (await store.search(DEV_CALLER, q, { types, tags, limit: 25 })).map((h) => h.entity)
    : await store.list(DEV_CALLER, { types, tags, limit: 50 });

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
        {tag ? <input type="hidden" name="tag" value={tag} /> : null}
        <button type="submit">Search</button>
      </form>
      {tag ? (
        <p className="meta" style={{ marginBottom: '0.8rem' }}>
          Filtering by tag <strong>#{tag}</strong> · <a href={`/search?q=${encodeURIComponent(q)}`}>clear</a>
        </p>
      ) : null}

      {entities.length === 0 ? (
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
          {entities.map((e) => (
            <EntityCard key={e.id} entity={e} />
          ))}
        </div>
      )}
    </>
  );
}
