'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import type { RetrievalRole } from '@ekg/core';
import { TYPE_COLORS, typeColor } from './ui';
import SvgGraphView from './SvgGraphView';
import type { MapLink, MapNode } from './map-shared';

export type { MapLink, MapNode, MapSection } from './map-shared';

// The 3D view rides on three.js — a ~370 kB gz chunk that only ever loads
// when someone flips the toggle, and can never render during SSR (WebGL).
// The 2D SVG view stays the default: it server-renders, prints, and is the
// accessible representation.
const Graph3D = dynamic(() => import('./Graph3D'), {
  ssr: false,
  loading: () => <div className="map-3d-loading">Loading 3D view…</div>,
});

/** Display order for the review-status filter chips (lifecycle order). */
const REVIEW_ORDER = ['verified', 'unverified', 'superseded', 'deprecated'];

const VIEW_STORAGE_KEY = 'ekg-map-view';

/**
 * Interactive graph "mind map" (PRD P0-9 graph explorer). This shell owns the
 * toolbar — 2D/3D view toggle, filters for entity type, relationship type,
 * review status, discipline, and tags, plus the retrieval-role lens — and the
 * legend, and hands the same node/link payload plus visibility sets to the
 * active renderer: the SSR-safe SVG view (default) or the lazily-loaded
 * WebGL 3D view. Layout is computed once per payload in either view — the
 * page keeps the payload bounded (overview cap, or focus-mode neighborhood),
 * which is how the P0-9 100k+ scale requirement is met — and filters only
 * toggle visibility, so positions hold steady while chips are clicked.
 */
export default function GraphMap({
  nodes,
  links,
  roles = [],
  focusId,
}: {
  nodes: MapNode[];
  links: MapLink[];
  roles?: RetrievalRole[];
  /** Entity the page's focus mode centered on — the 3D view flies to it. */
  focusId?: string;
}) {
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [hiddenRelTypes, setHiddenRelTypes] = useState<Set<string>>(new Set());
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(new Set());
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [activeDisciplines, setActiveDisciplines] = useState<Set<string>>(new Set());
  const [activeRoleId, setActiveRoleId] = useState<string>('');
  const [resetSignal, setResetSignal] = useState(0);
  const activeRole = roles.find((r) => r.id === activeRoleId);

  // SSR always renders the 2D view; the stored preference kicks in after
  // hydration so the markup matches on both sides.
  useEffect(() => {
    if (window.localStorage.getItem(VIEW_STORAGE_KEY) === '3d') setView('3d');
  }, []);
  const switchView = (v: '2d' | '3d') => {
    setView(v);
    window.localStorage.setItem(VIEW_STORAGE_KEY, v);
  };

  const allTypes = useMemo(() => [...new Set(nodes.map((n) => n.type))].sort(), [nodes]);
  const allRelTypes = useMemo(() => [...new Set(links.map((l) => l.type))].sort(), [links]);
  const allStatuses = useMemo(() => {
    const present = new Set(nodes.map((n) => n.reviewStatus));
    return [
      ...REVIEW_ORDER.filter((s) => present.has(s)),
      ...[...present].filter((s) => !REVIEW_ORDER.includes(s)).sort(),
    ];
  }, [nodes]);
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [nodes]);
  const allDisciplines = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) {
      if (n.discipline) counts.set(n.discipline, (counts.get(n.discipline) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [nodes]);

  // Filters resolve to visibility sets; the renderers never re-layout on a
  // chip toggle, they only show/hide. A link is visible when its type is
  // shown AND both endpoints are.
  const { visibleNodeIds, visibleLinkIds } = useMemo(() => {
    const nodeIds = new Set<string>();
    for (const n of nodes) {
      if (hiddenTypes.has(n.type)) continue;
      if (hiddenStatuses.has(n.reviewStatus)) continue;
      if (activeTags.size > 0 && !n.tags.some((t) => activeTags.has(t))) continue;
      if (
        activeDisciplines.size > 0 &&
        !(n.discipline !== undefined && activeDisciplines.has(n.discipline))
      )
        continue;
      nodeIds.add(n.id);
    }
    const linkIds = new Set<string>();
    for (const l of links) {
      if (hiddenRelTypes.has(l.type)) continue;
      if (nodeIds.has(l.source) && nodeIds.has(l.target)) linkIds.add(l.id);
    }
    return { visibleNodeIds: nodeIds, visibleLinkIds: linkIds };
  }, [nodes, links, hiddenTypes, hiddenRelTypes, hiddenStatuses, activeTags, activeDisciplines]);

  const toggleIn = (set: (fn: (prev: Set<string>) => Set<string>) => void, value: string) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });

  return (
    <div className="map-card">
      <div className="map-toolbar">
        {/* View switch — a distinct segmented control, not a filter chip, so
            it reads as "which renderer" rather than one more toggle. */}
        <div
          className="map-view-toggle"
          role="group"
          aria-label="Map view: 2D or 3D"
        >
          <span className="map-view-label">View</span>
          <button
            type="button"
            className={`map-view-btn${view === '2d' ? ' active' : ''}`}
            aria-pressed={view === '2d'}
            title="Flat force-directed map"
            onClick={() => switchView('2d')}
          >
            ▤ 2D
          </button>
          <button
            type="button"
            className={`map-view-btn${view === '3d' ? ' active' : ''}`}
            aria-pressed={view === '3d'}
            title="Orbit the same graph in three dimensions"
            onClick={() => switchView('3d')}
          >
            ◈ 3D
          </button>
        </div>
        <span className="toolbar-sep" />
        {roles.length > 0 ? (
          <>
            <label className="map-role-picker">
              ◎ Role
              <select
                value={activeRoleId}
                onChange={(e) => setActiveRoleId(e.target.value)}
                aria-label="Highlight a retrieval role's focus"
              >
                <option value="">None</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="toolbar-sep" />
          </>
        ) : null}
        {allTypes.map((t) => (
          <button
            key={t}
            type="button"
            className={`chip-btn${hiddenTypes.has(t) ? ' off' : ''}`}
            style={{ borderColor: typeColor(t), color: hiddenTypes.has(t) ? undefined : typeColor(t) }}
            onClick={() => toggleIn(setHiddenTypes, t)}
          >
            ● {t}
          </button>
        ))}
        <span className="toolbar-sep" />
        {allRelTypes.map((t) => (
          <button
            key={t}
            type="button"
            className={`chip-btn${hiddenRelTypes.has(t) ? ' off' : ''}`}
            title={`Toggle ${t} relationships`}
            onClick={() => toggleIn(setHiddenRelTypes, t)}
          >
            ⇢ {t}
          </button>
        ))}
        <span className="toolbar-sep" />
        {allStatuses.map((s) => (
          <button
            key={s}
            type="button"
            className={`chip-btn${hiddenStatuses.has(s) ? ' off' : ''}`}
            title={`Toggle ${s} items`}
            onClick={() => toggleIn(setHiddenStatuses, s)}
          >
            ◆ {s}
          </button>
        ))}
        {allDisciplines.length > 0 ? (
          <>
            <span className="toolbar-sep" />
            {allDisciplines.map(([d, count]) => (
              <button
                key={d}
                type="button"
                className={`chip-btn tag${activeDisciplines.has(d) ? ' active' : ''}`}
                title={`Show only ${d} knowledge`}
                onClick={() => toggleIn(setActiveDisciplines, d)}
              >
                ◈ {d} <span className="chip-count">{count}</span>
              </button>
            ))}
          </>
        ) : null}
        <span className="toolbar-sep" />
        {allTags.map(([t, count]) => (
          <button
            key={t}
            type="button"
            className={`chip-btn tag${activeTags.has(t) ? ' active' : ''}`}
            onClick={() => toggleIn(setActiveTags, t)}
          >
            #{t} <span className="chip-count">{count}</span>
          </button>
        ))}
        <span className="toolbar-sep" />
        <button type="button" className="chip-btn" onClick={() => setResetSignal((s) => s + 1)}>
          ⟳ Reset view
        </button>
      </div>

      {view === '2d' ? (
        <SvgGraphView
          nodes={nodes}
          links={links}
          visibleNodeIds={visibleNodeIds}
          visibleLinkIds={visibleLinkIds}
          activeRole={activeRole}
          resetSignal={resetSignal}
        />
      ) : (
        <Graph3D
          nodes={nodes}
          links={links}
          visibleNodeIds={visibleNodeIds}
          visibleLinkIds={visibleLinkIds}
          activeRole={activeRole}
          resetSignal={resetSignal}
          focusId={focusId}
        />
      )}

      <div className="map-legend">
        {Object.entries(TYPE_COLORS)
          .filter(([t]) => allTypes.includes(t))
          .map(([t, c]) => (
            <span key={t}>
              <span className="legend-dot" style={{ background: c }} /> {t}
            </span>
          ))}
        <span>
          <span className="legend-dot legend-flagged" /> superseded/deprecated
        </span>
        <span>
          <span className="legend-dot legend-unverified" /> unverified (faded)
        </span>
        {nodes.some((n) => (n.sections?.length ?? 0) > 0) ? (
          <span>§ document with indexed sections — click to unfold</span>
        ) : null}
        {activeRole ? (
          <span>
            <span className="legend-dot legend-focused" /> focused by {activeRole.name}
          </span>
        ) : null}
      </div>
    </div>
  );
}
