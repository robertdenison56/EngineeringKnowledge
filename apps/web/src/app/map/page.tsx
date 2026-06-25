import { DEV_CALLER, getRoles, getStore } from '../../lib/store';
import GraphMap from '../../components/GraphMap';

export const dynamic = 'force-dynamic';

export default async function MapPage() {
  const store = await getStore();
  const entities = await store.list(DEV_CALLER, { limit: 1000 });
  const relationships = await store.listRelationships(DEV_CALLER);
  const roles = await getRoles();

  const nodes = entities.map((e) => ({
    id: e.id,
    title: e.title,
    type: e.type,
    reviewStatus: e.provenance.reviewStatus,
    tags: e.tags ?? [],
  }));
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
        node to open it. Toggle types and tags to focus the map, or pick a
        retrieval role to see the knowledge it favors light up.
      </p>
      <GraphMap nodes={nodes} links={links} roles={roles} />
    </>
  );
}
