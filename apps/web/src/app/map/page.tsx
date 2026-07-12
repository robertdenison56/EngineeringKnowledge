import type { Chunk } from '@ekg/core';
import { getCaller, getRoles, getStore } from '../../lib/store';
import GraphMap, { type MapSection } from '../../components/GraphMap';

export const dynamic = 'force-dynamic';

/** Sections shown when a document node is unfolded; the rest collapse into "+N more". */
const MAX_MAP_SECTIONS = 12;

/** Short, word-bounded excerpt of a passage — the section's map description. */
function excerpt(text: string, max = 110): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  let cut = t.lastIndexOf(' ', max);
  if (cut < max * 0.6) cut = max;
  return `${t.slice(0, cut)}…`;
}

/** Same label the entity page gives a passage: heading, else anchor, else ordinal. */
function sectionLabel(c: Chunk): string {
  if (c.heading) return c.heading;
  const a = c.anchor ?? {};
  const loc = [
    a.sheet ? `Sheet ${a.sheet}` : null,
    a.specSection ?? null,
    a.page ? `p. ${a.page}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return loc || `Passage ${c.ordinal + 1}`;
}

export default async function MapPage() {
  const store = await getStore();
  const caller = await getCaller();
  const entities = await store.list(caller, { limit: 1000 });
  const relationships = await store.listRelationships(caller);
  const roles = await getRoles();

  // Section summaries for chunked documents (ADR 0006), so the map can unfold
  // a large file into its passages. Only file-derived entities (`content` set)
  // can carry chunks; single-chunk docs stay plain nodes.
  const sectionsById = new Map<string, { sections: MapSection[]; count: number }>();
  await Promise.all(
    entities
      .filter((e) => e.content)
      .map(async (e) => {
        const chunks = await store.getChunks(caller, e.id);
        if (chunks.length < 2) return;
        sectionsById.set(e.id, {
          count: chunks.length,
          sections: chunks.slice(0, MAX_MAP_SECTIONS).map((c) => ({
            label: sectionLabel(c),
            description: excerpt(c.text),
          })),
        });
      }),
  );

  const nodes = entities.map((e) => {
    const doc = sectionsById.get(e.id);
    return {
      id: e.id,
      title: e.title,
      type: e.type,
      reviewStatus: e.provenance.reviewStatus,
      tags: e.tags ?? [],
      ...(doc ? { sections: doc.sections, sectionCount: doc.count } : {}),
    };
  });
  const links = relationships.map((r) => ({
    id: r.id,
    source: r.fromId,
    target: r.toId,
    type: r.type,
  }));

  return (
    <>
      <h2>Knowledge map</h2>
      <p className="meta" style={{ marginBottom: '0.8rem' }}>
        The whole graph your identity can see — {nodes.length} entities, {links.length}{' '}
        relationships. Scroll to zoom, drag to pan, hover to highlight a neighborhood, click a
        node to open it. Documents marked § unfold on click into their indexed sections.
        Toggle types and tags to focus the map, or pick a retrieval role to see the knowledge
        it favors light up.
      </p>
      <GraphMap nodes={nodes} links={links} roles={roles} />
    </>
  );
}
