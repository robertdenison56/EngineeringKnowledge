import type { Chunk, Entity, NeighborHit, Relationship } from '@ekg/core';
import { getCaller, getRoles, getStore } from '../../lib/store';
import { disciplineOf } from '../../lib/facets';
import GraphMap, { type MapSection } from '../../components/GraphMap';

export const dynamic = 'force-dynamic';

/** Sections shown when a document node is unfolded; the rest collapse into "+N more". */
const MAX_MAP_SECTIONS = 12;

/**
 * Overview mode loads at most this many entities; the PRD scale target (100k+)
 * is served by focus mode, which never loads more than its own cap.
 */
const OVERVIEW_CAP = 1000;

/** Focus mode keeps the nearest N nodes — enough to read, never a hairball. */
const FOCUS_NODE_CAP = 150;

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

export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string; depth?: string }>;
}) {
  const { focus = '', depth: depthRaw = '' } = await searchParams;
  const depth = depthRaw === '2' ? 2 : 1;
  const store = await getStore();
  const caller = await getCaller();
  const roles = await getRoles();

  const focusEntity = focus ? await store.getEntity(caller, focus) : undefined;

  let entities: Entity[];
  let relationships: Relationship[];
  let capped = false;

  if (focusEntity) {
    // Progressive loading (PRD P0-9 graph scale, gap G8): instead of the whole
    // graph, breadth-first-expand the focus entity's neighborhood with the
    // same `neighbors` primitive the MCP traverse tool uses, capped at the
    // nearest FOCUS_NODE_CAP nodes. Cost scales with the neighborhood, not
    // the corpus, so this stays usable when the overview no longer is.
    const byId = new Map<string, Entity>([[focusEntity.id, focusEntity]]);
    const neighborCache = new Map<string, NeighborHit[]>();
    const expand = async (id: string): Promise<NeighborHit[]> => {
      const cached = neighborCache.get(id);
      if (cached) return cached;
      const hits = await store.neighbors(caller, id);
      neighborCache.set(id, hits);
      return hits;
    };

    let frontier = [focusEntity.id];
    for (let d = 0; d < depth && frontier.length > 0 && !capped; d += 1) {
      const expansions = await Promise.all(frontier.map(expand));
      const next: string[] = [];
      for (const hits of expansions) {
        for (const nh of hits) {
          if (byId.has(nh.entity.id)) continue;
          if (byId.size >= FOCUS_NODE_CAP) {
            capped = true;
            break;
          }
          byId.set(nh.entity.id, nh.entity);
          next.push(nh.entity.id);
        }
        if (capped) break;
      }
      frontier = next;
    }

    // Edge completion: every included node contributes its incident edges, so
    // relationships WITHIN the ring show too, not just spokes from the center.
    // Only edges with both endpoints in the neighborhood are kept.
    const edgeLists = await Promise.all([...byId.keys()].map(expand));
    const rels = new Map<string, Relationship>();
    for (const hits of edgeLists) {
      for (const nh of hits) {
        const r = nh.relationship;
        if (byId.has(r.fromId) && byId.has(r.toId)) rels.set(r.id, r);
      }
    }
    entities = [...byId.values()];
    relationships = [...rels.values()];
  } else {
    entities = await store.list(caller, { limit: OVERVIEW_CAP });
    relationships = await store.listRelationships(caller);
  }

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
    const discipline = disciplineOf(e);
    return {
      id: e.id,
      title: e.title,
      type: e.type,
      reviewStatus: e.provenance.reviewStatus,
      tags: e.tags ?? [],
      ...(discipline ? { discipline } : {}),
      ...(doc ? { sections: doc.sections, sectionCount: doc.count } : {}),
    };
  });
  const links = relationships.map((r) => ({
    id: r.id,
    source: r.fromId,
    target: r.toId,
    type: r.type,
  }));

  const focusOptions = [...entities].sort((a, b) => a.title.localeCompare(b.title));

  return (
    <>
      <h2>Knowledge map</h2>
      {focusEntity ? (
        <p className="meta" style={{ marginBottom: '0.8rem' }}>
          Neighborhood of <strong>{focusEntity.title}</strong> — {depth} hop
          {depth === 1 ? '' : 's'}, {nodes.length} entities, {links.length} relationships
          {capped ? ` (capped at the ${FOCUS_NODE_CAP} nearest)` : ''}.{' '}
          <a href="/map">Show full overview</a>
        </p>
      ) : (
        <p className="meta" style={{ marginBottom: '0.8rem' }}>
          The whole graph your identity can see — {nodes.length} entities, {links.length}{' '}
          relationships. Scroll to zoom, drag to pan, hover to highlight a neighborhood, click a
          node to open it. Documents marked § unfold on click into their indexed sections.
          Toggle types, relationships, tags, and review status to focus the map, or pick a
          retrieval role to see the knowledge it favors light up.
        </p>
      )}
      {focus && !focusEntity ? (
        <p className="meta" style={{ marginBottom: '0.8rem' }}>
          No visible entity matches “{focus}” — showing the overview instead.
        </p>
      ) : null}
      {!focusEntity && entities.length >= OVERVIEW_CAP ? (
        <p className="meta" style={{ marginBottom: '0.8rem' }}>
          Showing the first {OVERVIEW_CAP.toLocaleString()} entities. Focus on an entity below to
          explore beyond this window — the neighborhood view loads progressively and works at any
          graph size.
        </p>
      ) : null}
      <form action="/map" className="search-form" style={{ marginBottom: '0.8rem' }}>
        <input
          type="text"
          list="map-focus-options"
          name="focus"
          defaultValue={focus}
          placeholder="Focus on an entity — type to pick…"
          aria-label="Focus the map on one entity's neighborhood"
          className="facet-section"
        />
        <datalist id="map-focus-options">
          {focusOptions.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </datalist>
        <select name="depth" defaultValue={String(depth)} aria-label="Neighborhood depth">
          <option value="1">1 hop</option>
          <option value="2">2 hops</option>
        </select>
        <button type="submit">Focus</button>
      </form>
      <GraphMap nodes={nodes} links={links} roles={roles} />
    </>
  );
}
