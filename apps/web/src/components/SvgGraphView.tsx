'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
import type { RetrievalRole } from '@ekg/core';
import { entityHref, typeColor } from './ui';
import { nodeMatchesRole, shortTitle, type MapLink, type MapNode } from './map-shared';

interface SimNode extends SimulationNodeDatum, MapNode {
  degree: number;
}

const W = 920;
const H = 600;

/** Word-wrap a section description into at most `maxLines` SVG text lines. */
function wrapText(s: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of s.split(' ')) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > width && cur) {
      if (lines.length === maxLines - 1) {
        lines.push(`${cur.slice(0, width - 1)}…`);
        return lines;
      }
      lines.push(cur);
      cur = word;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * The 2D SVG renderer of the knowledge map: force-directed layout, pan/zoom,
 * hover-highlighting of neighborhoods, click-through to entity pages, and the
 * radial section fan for chunked documents (ADR 0006). This is the default and
 * SSR-rendered view; GraphMap owns the toolbar and filter state and can swap
 * in the WebGL 3D view instead.
 *
 * Layout runs ONCE per {nodes, links} payload over the FULL graph; filters
 * only toggle visibility. Positions therefore stay put when chips are toggled
 * (no re-simulation jank, no wholesale position jumps), at the cost of gaps
 * where hidden nodes sat — the stable mental map is worth it.
 */
export default function SvgGraphView({
  nodes,
  links,
  visibleNodeIds,
  visibleLinkIds,
  activeRole,
  resetSignal,
}: {
  nodes: MapNode[];
  links: MapLink[];
  visibleNodeIds: Set<string>;
  visibleLinkIds: Set<string>;
  activeRole?: RetrievalRole;
  resetSignal: number;
}) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Document node currently unfolded into its sections (one at a time keeps
  // the radial labels readable; clicking the node again folds it back).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);

  const { placedNodes, placedLinks } = useMemo(() => {
    // Degree over the FULL link set, so node sizes are stable identities that
    // don't shrink when a relationship type is toggled off.
    const degree = new Map<string, number>();
    for (const l of links) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
    }
    const simNodes: SimNode[] = nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 }));
    const simLinks = links.map((l) => ({ ...l }));

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

    // Round to a fixed precision so SSR and client hydration render
    // byte-identical coordinates. d3-force leans on Math.sqrt/etc whose
    // last-ULP results differ between Node and the browser's V8, which
    // otherwise yields a hydration mismatch on every node, link, and label.
    // Links reference these same node objects, so this also fixes their
    // endpoints and the deterministically-derived label midpoints.
    for (const n of simNodes) {
      n.x = Math.round((n.x ?? 0) * 100) / 100;
      n.y = Math.round((n.y ?? 0) * 100) / 100;
    }

    return { placedNodes: simNodes, placedLinks: simLinks };
  }, [nodes, links]);

  const shownNodes = useMemo(
    () => placedNodes.filter((n) => visibleNodeIds.has(n.id)),
    [placedNodes, visibleNodeIds],
  );
  const shownLinks = useMemo(
    () => placedLinks.filter((l) => visibleLinkIds.has(l.id)),
    [placedLinks, visibleLinkIds],
  );

  // Hover adjacency over the VISIBLE edges only, so highlighting never lights
  // up a neighbor whose connecting relationship type is currently hidden.
  const adjacency = useMemo(() => {
    const adj = new Map<string, Set<string>>();
    for (const l of shownLinks) {
      const s = (l.source as unknown as SimNode).id;
      const t = (l.target as unknown as SimNode).id;
      if (!adj.has(s)) adj.set(s, new Set());
      if (!adj.has(t)) adj.set(t, new Set());
      adj.get(s)!.add(t);
      adj.get(t)!.add(s);
    }
    return adj;
  }, [shownLinks]);

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

  // The shell's "Reset view" chip bumps this counter for whichever view is active.
  useEffect(() => {
    setTransform({ x: 0, y: 0, k: 1 });
  }, [resetSignal]);

  // An unfolded document focuses its neighborhood the same way hover does, so
  // the sections read against a quiet background; hover still wins while active.
  const focusId = hoverId ?? expandedId;
  const dimmed = (id: string) =>
    focusId !== null && id !== focusId && !(adjacency.get(focusId)?.has(id) ?? false);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Knowledge graph map"
      style={{
        cursor: dragRef.current ? 'grabbing' : 'grab',
        touchAction: 'none',
        userSelect: 'none',
      }}
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
        {shownLinks.map((l) => {
          const s = l.source as unknown as SimNode;
          const t = l.target as unknown as SimNode;
          const dim = focusId !== null && s.id !== focusId && t.id !== focusId;
          return (
            <g key={l.id} opacity={dim ? 0.12 : 1}>
              <line
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                style={{ stroke: 'var(--border, #cbd5e1)' }}
                strokeWidth={1.4}
              />
              <text
                x={((s.x ?? 0) + (t.x ?? 0)) / 2}
                y={((s.y ?? 0) + (t.y ?? 0)) / 2 - 4}
                textAnchor="middle"
                fontSize={8.5}
                style={{ fill: 'var(--muted, #94a3b8)' }}
              >
                {l.type}
              </text>
            </g>
          );
        })}
        {shownNodes.map((n) => {
          const r = 14 + Math.min(n.degree, 6) * 3;
          const flagged = n.reviewStatus === 'superseded' || n.reviewStatus === 'deprecated';
          const focused = activeRole ? nodeMatchesRole(n, activeRole) : false;
          // A role pushes everything it does NOT favor into the background, so
          // the lens's knowledge stands out — mirrors the hover-dim behavior.
          const roleDimmed = activeRole ? !focused : false;
          const opacity = dimmed(n.id) ? 0.15 : roleDimmed ? 0.18 : 1;
          const expandable = (n.sections?.length ?? 0) > 0;
          const isExpanded = expandedId === n.id;
          const badge = expandable ? `§${n.sectionCount ?? n.sections!.length}` : '';
          const badgeW = badge.length * 5.5 + 8;
          const disc = (
            <>
              {focused ? (
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={r + 7}
                  fill="#f59e0b"
                  opacity={0.18}
                  stroke="#f59e0b"
                  strokeWidth={2.5}
                />
              ) : null}
              {isExpanded ? (
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={r + 5}
                  fill="none"
                  stroke={typeColor(n.type)}
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                />
              ) : null}
              <circle
                cx={n.x}
                cy={n.y}
                r={r}
                fill={typeColor(n.type)}
                opacity={n.reviewStatus === 'unverified' ? 0.55 : 0.92}
                style={{ stroke: flagged ? '#d97706' : 'var(--text, #0f172a)' }}
                strokeOpacity={flagged ? 1 : 0.55}
                strokeWidth={flagged ? 2.5 : 0.8}
                strokeDasharray={flagged ? '4 3' : undefined}
              />
              {expandable ? (
                <g transform={`translate(${(n.x ?? 0) + r * 0.8}, ${(n.y ?? 0) - r * 0.8})`}>
                  <rect
                    x={-badgeW / 2}
                    y={-7}
                    width={badgeW}
                    height={14}
                    rx={7}
                    style={{ fill: 'var(--text, #0f172a)' }}
                    opacity={0.9}
                  />
                  <text
                    x={0}
                    y={3.5}
                    textAnchor="middle"
                    fontSize={8.5}
                    fontWeight={600}
                    style={{ fill: 'var(--surface, #fff)' }}
                  >
                    {badge}
                  </text>
                </g>
              ) : null}
            </>
          );
          return (
            <g
              key={n.id}
              style={{ opacity }}
              onMouseEnter={() => setHoverId(n.id)}
              onMouseLeave={() => setHoverId(null)}
            >
              {expandable ? (
                // Chunked documents unfold in place; the title below stays a
                // link, so the entity page is always one click away.
                <g
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  aria-label={`${n.title} — ${n.sectionCount ?? n.sections!.length} sections, click to ${isExpanded ? 'fold' : 'unfold'}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setExpandedId(isExpanded ? null : n.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setExpandedId(isExpanded ? null : n.id);
                    }
                  }}
                >
                  {disc}
                </g>
              ) : (
                <a href={entityHref(n.id)}>{disc}</a>
              )}
              <a href={entityHref(n.id)}>
                <text
                  x={n.x}
                  y={(n.y ?? 0) + r + 12}
                  textAnchor="middle"
                  fontSize={10.5}
                  style={{ fill: 'var(--text, #334155)', opacity: 0.85 }}
                >
                  {shortTitle(n.title)}
                </text>
              </a>
            </g>
          );
        })}
        {(() => {
          // Radial section fan for the unfolded document — client-only state,
          // so it never renders during SSR and cannot cause hydration drift.
          const doc =
            expandedId && visibleNodeIds.has(expandedId)
              ? placedNodes.find((p) => p.id === expandedId)
              : undefined;
          if (!doc || !doc.sections || doc.sections.length === 0) return null;
          const ex = doc.x ?? 0;
          const ey = doc.y ?? 0;
          const r = 14 + Math.min(doc.degree, 6) * 3;
          const extra = (doc.sectionCount ?? doc.sections.length) - doc.sections.length;
          const items = [
            ...doc.sections.map((s) => ({ ...s, more: false })),
            ...(extra > 0
              ? [
                  {
                    label: `+${extra} more section${extra === 1 ? '' : 's'}`,
                    description: 'Open the document for the full list',
                    more: true,
                  },
                ]
              : []),
          ];
          const orbit = Math.max(92, 48 + items.length * 9);
          const color = typeColor(doc.type);
          return (
            <g>
              {items.map((s, i) => {
                const a = -Math.PI / 2 + (2 * Math.PI * i) / items.length;
                const x = ex + orbit * Math.cos(a);
                const y = ey + orbit * Math.sin(a);
                const descLines = wrapText(s.description, 34, 2);
                // Side items read outward left/right; items near 12/6 o'clock
                // stack centered above/below so they don't collide with their
                // angular neighbors' labels.
                const vertical = Math.abs(Math.cos(a)) < 0.2;
                const anchor = vertical ? 'middle' : Math.cos(a) >= 0 ? 'start' : 'end';
                const tx = vertical ? x : x + (Math.cos(a) >= 0 ? 11 : -11);
                const labelY = vertical
                  ? Math.sin(a) < 0
                    ? y - 12 - descLines.length * 9.5
                    : y + 16
                  : y - 3;
                const descY = labelY + 10;
                return (
                  <a key={`${doc.id}-sec-${i}`} href={entityHref(doc.id)}>
                    <line
                      x1={ex + r * Math.cos(a)}
                      y1={ey + r * Math.sin(a)}
                      x2={x}
                      y2={y}
                      stroke={color}
                      strokeWidth={1.1}
                      strokeDasharray="3 3"
                      opacity={0.6}
                    />
                    <circle
                      cx={x}
                      cy={y}
                      r={6.5}
                      fill="var(--surface, #fff)"
                      stroke={color}
                      strokeWidth={1.6}
                      strokeDasharray={s.more ? '2.5 2' : undefined}
                    />
                    <text
                      x={tx}
                      y={labelY}
                      textAnchor={anchor}
                      fontSize={9}
                      fontWeight={600}
                      fill="var(--text, #0f172a)"
                    >
                      {shortTitle(s.label, 30)}
                    </text>
                    {descLines.map((line, j) => (
                      <text
                        key={j}
                        x={tx}
                        y={descY + j * 9.5}
                        textAnchor={anchor}
                        fontSize={8}
                        fill="var(--muted, #475569)"
                      >
                        {line}
                      </text>
                    ))}
                  </a>
                );
              })}
            </g>
          );
        })()}
      </g>
    </svg>
  );
}
