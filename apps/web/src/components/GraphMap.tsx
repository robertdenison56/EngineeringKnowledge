'use client';

import { useMemo, useRef, useState, useEffect } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { TYPE_COLORS, entityHref, typeColor } from './ui';

export interface MapNode {
  id: string;
  title: string;
  type: string;
  reviewStatus: string;
  tags: string[];
}

export interface MapLink {
  id: string;
  source: string;
  target: string;
  type: string;
}

interface SimNode extends SimulationNodeDatum, MapNode {
  degree: number;
}

const W = 920;
const H = 600;

function shortTitle(title: string, max = 22): string {
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

/**
 * Interactive full-graph "mind map" (PRD P0-9 graph explorer): force-directed
 * layout, pan/zoom, hover-highlighting of neighborhoods, type and tag
 * filters, click-through to entity pages. Layout is computed synchronously —
 * fine at firm-demo scale; progressive loading is the documented P0-9
 * requirement for 100k+ graphs.
 */
export default function GraphMap({ nodes, links }: { nodes: MapNode[]; links: MapLink[] }) {
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);

  const allTypes = useMemo(() => [...new Set(nodes.map((n) => n.type))].sort(), [nodes]);
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [nodes]);

  const { placedNodes, placedLinks, adjacency } = useMemo(() => {
    const visible = nodes.filter(
      (n) =>
        !hiddenTypes.has(n.type) &&
        (activeTags.size === 0 || n.tags.some((t) => activeTags.has(t))),
    );
    const ids = new Set(visible.map((n) => n.id));
    const visibleLinks = links.filter((l) => ids.has(l.source) && ids.has(l.target));

    const degree = new Map<string, number>();
    for (const l of visibleLinks) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
    }
    const simNodes: SimNode[] = visible.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 }));
    const simLinks = visibleLinks.map((l) => ({ ...l }));

    const sim = forceSimulation(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
          .id((d) => d.id)
          .distance(110),
      )
      .force('charge', forceManyBody().strength(-300))
      .force('center', forceCenter(W / 2, H / 2))
      .force('collide', forceCollide(34))
      // Gentle pull toward the middle so disconnected candidates stay on
      // the map instead of being flung to the edges by the charge force.
      .force('x', forceX(W / 2).strength(0.06))
      .force('y', forceY(H / 2).strength(0.09))
      .stop();
    for (let i = 0; i < 300; i += 1) sim.tick();

    const adj = new Map<string, Set<string>>();
    for (const l of simLinks) {
      const s = (l.source as unknown as SimNode).id;
      const t = (l.target as unknown as SimNode).id;
      if (!adj.has(s)) adj.set(s, new Set());
      if (!adj.has(t)) adj.set(t, new Set());
      adj.get(s)!.add(t);
      adj.get(t)!.add(s);
    }
    return { placedNodes: simNodes, placedLinks: simLinks, adjacency: adj };
  }, [nodes, links, hiddenTypes, activeTags]);

  // React registers wheel as passive; zooming needs preventDefault, so
  // attach a native non-passive listener.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setTransform((t) => {
        const k = Math.min(4, Math.max(0.3, t.k * (e.deltaY < 0 ? 1.12 : 0.89)));
        return { ...t, k };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const dimmed = (id: string) =>
    hoverId !== null && id !== hoverId && !(adjacency.get(hoverId)?.has(id) ?? false);

  return (
    <div className="map-card">
      <div className="map-toolbar">
        {allTypes.map((t) => (
          <button
            key={t}
            type="button"
            className={`chip-btn${hiddenTypes.has(t) ? ' off' : ''}`}
            style={{ borderColor: typeColor(t), color: hiddenTypes.has(t) ? undefined : typeColor(t) }}
            onClick={() =>
              setHiddenTypes((prev) => {
                const next = new Set(prev);
                if (next.has(t)) next.delete(t);
                else next.add(t);
                return next;
              })
            }
          >
            ● {t}
          </button>
        ))}
        <span className="toolbar-sep" />
        {allTags.map(([t, count]) => (
          <button
            key={t}
            type="button"
            className={`chip-btn tag${activeTags.has(t) ? ' active' : ''}`}
            onClick={() =>
              setActiveTags((prev) => {
                const next = new Set(prev);
                if (next.has(t)) next.delete(t);
                else next.add(t);
                return next;
              })
            }
          >
            #{t} <span className="chip-count">{count}</span>
          </button>
        ))}
        <span className="toolbar-sep" />
        <button
          type="button"
          className="chip-btn"
          onClick={() => setTransform({ x: 0, y: 0, k: 1 })}
        >
          ⟳ Reset view
        </button>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Knowledge graph map"
        style={{ cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
        onPointerDown={(e) => {
          dragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            ox: transform.x,
            oy: transform.y,
          };
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d) return;
          setTransform((t) => ({
            ...t,
            x: d.ox + (e.clientX - d.startX),
            y: d.oy + (e.clientY - d.startY),
          }));
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerLeave={() => {
          dragRef.current = null;
        }}
      >
        <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
          {placedLinks.map((l) => {
            const s = l.source as unknown as SimNode;
            const t = l.target as unknown as SimNode;
            const dim = hoverId !== null && s.id !== hoverId && t.id !== hoverId;
            return (
              <g key={l.id} opacity={dim ? 0.12 : 1}>
                <line x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke="#cbd5e1" strokeWidth={1.4} />
                <text
                  x={((s.x ?? 0) + (t.x ?? 0)) / 2}
                  y={((s.y ?? 0) + (t.y ?? 0)) / 2 - 4}
                  textAnchor="middle"
                  fontSize={8.5}
                  fill="#94a3b8"
                >
                  {l.type}
                </text>
              </g>
            );
          })}
          {placedNodes.map((n) => {
            const r = 14 + Math.min(n.degree, 6) * 3;
            const flagged = n.reviewStatus === 'superseded' || n.reviewStatus === 'deprecated';
            return (
              <a
                key={n.id}
                href={entityHref(n.id)}
                style={{ opacity: dimmed(n.id) ? 0.15 : 1 }}
                onMouseEnter={() => setHoverId(n.id)}
                onMouseLeave={() => setHoverId(null)}
              >
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={r}
                  fill={typeColor(n.type)}
                  opacity={n.reviewStatus === 'unverified' ? 0.55 : 0.92}
                  stroke={flagged ? '#d97706' : '#0f172a'}
                  strokeWidth={flagged ? 2.5 : 0.8}
                  strokeDasharray={flagged ? '4 3' : undefined}
                />
                <text
                  x={n.x}
                  y={(n.y ?? 0) + r + 12}
                  textAnchor="middle"
                  fontSize={10.5}
                  fill="#334155"
                >
                  {shortTitle(n.title)}
                </text>
              </a>
            );
          })}
        </g>
      </svg>

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
      </div>
    </div>
  );
}
