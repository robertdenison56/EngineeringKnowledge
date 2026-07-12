import Link from 'next/link';
import { ENTITY_TYPES } from '@ekg/core';
import { getCaller, getStore } from '../lib/store';
import { EntityCard, TypeBadge } from '../components/ui';

export default async function Dashboard() {
  const store = await getStore();
  const caller = await getCaller();
  const all = await store.list(caller, { limit: 500 });
  const counts = new Map<string, number>();
  for (const e of all) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const recent = [...all]
    .sort((a, b) => b.provenance.modifiedAt.localeCompare(a.provenance.modifiedAt))
    .slice(0, 4);

  return (
    <>
      <section className="hero">
        <h1>Firm engineering knowledge, grounded.</h1>
        <p>
          Search precedents, explore the graph, and see exactly where every answer comes from —
          here and in every connected assistant.
        </p>
        <form action="/search" className="searchbar">
          <input name="q" placeholder='Try "curtain wall firestop"…' aria-label="Search the knowledge graph" />
          <button type="submit">Search</button>
        </form>
      </section>

      <section>
        <h2>Knowledge by type</h2>
        <div className="stats">
          {ENTITY_TYPES.filter((t) => counts.get(t)).map((t) => (
            <Link key={t} href={`/search?type=${encodeURIComponent(t)}`} className="stat">
              <span className="stat-count">{counts.get(t)}</span>
              <TypeBadge type={t} />
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h2>Recently updated</h2>
        <div className="cards">
          {recent.map((e) => (
            <EntityCard key={e.id} entity={e} />
          ))}
        </div>
      </section>
    </>
  );
}
