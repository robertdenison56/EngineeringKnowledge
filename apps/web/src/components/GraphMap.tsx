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
import type { RetrievalRole } from '@ekg/core';
import { TYPE_COLORS, entityHref, typeColor } from './ui';

/** One indexed passage of a chunked document, as shown when its node unfolds. */
export interface MapSection {
  /** Human label — "Sheet L-1 — Planting plan", "07 92 00 · PART 2", "Page 14". */
  label: string;
  /** Short excerpt of the passage text. */
  description: string;
}

export interface MapNode {
  id: string;
  title: string;
  type: string;
  reviewStatus: string;
  tags: string[];
  /** Present for multi-passage documents (ADR 0006) — clicking the node unfolds these. */
  sections?: MapSection[];
  /** Total indexed passages; `sections` is capped, the rest fold into "+N more". */
  sectionCount?: number;
}

/**
 * Whether a retrieval role favors a node — same tag/type test as the
 * `entityMatchesRole` boost the store applies, expressed over the map's lighter
 * node shape so the highlight matches what actually ranks higher.
 */
function nodeMatchesRole(node: MapNode, role: RetrievalRole): boolean {
  return role.boostTypes.includes(node.type) || node.tags.some((t) => role.boostTags.includes(t));
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
 * Interactive full-graph "mind map" (PRD P0-9 graph explorer): force-directed
 * layout, pan/zoom, hover-highlighting of neighborhoods, type and tag
 * filters, click-through to entity pages. Chunked documents (ADR 0006) carry a
 * §-count badge and unfold on click into a radial fan of their sections, each
 * with a short description. Layout is computed synchronously —
 * fine at firm-demo scale; progressive loading is the documented P0-9
 * requirement for 100k+ graphs.
 */
export default function GraphMap({
  nodes,
  links,
  roles = [],
}: {
  nodes: MapNode[];
  links: MapLink[];
  roles?: RetrievalRole[];
}) {
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [activeRoleId, setActiveRoleId] = useState<string>('');
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Document node currently unfolded into its sections (one at a time keeps
  // the radial labels readable; clicking the node again folds it back).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const activeRole = roles.find((r) => r.id === activeRoleId);
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

  // An unfolded document focuses its neighborhood the same way hover does, so
  // the sections read against a quiet background; hover still wins while active.
  const focusId = hoverId ?? expandedId;
  const dimmed = (id: string) =>
    focusId !== null && id !== focusId && !(adjacency.get(focusId)?.has(id) ?? false);

  return (
    <div className="map-card">
      <div className="map-toolbar">
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
          {placedLinks.map((l) => {
            const s = l.source as unknown as SimNode;
            const t = l.target as unknown as SimNode;
            const dim = focusId !== null && s.id !== focusId && t.id !== focusId;
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
                  stroke={flagged ? '#d97706' : '#0f172a'}
                  strokeWidth={flagged ? 2.5 : 0.8}
                  strokeDasharray={flagged ? '4 3' : undefined}
                />
                {expandable ? (
                  <g
                    transform={`translate(${(n.x ?? 0) + r * 0.8}, ${(n.y ?? 0) - r * 0.8})`}
                  >
                    <rect
                      x={-badgeW / 2}
                      y={-7}
                      width={badgeW}
                      height={14}
                      rx={7}
                      fill="#0f172a"
                      opacity={0.9}
                    />
                    <text x={0} y={3.5} textAnchor="middle" fontSize={8.5} fontWeight={600} fill="#fff">
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
                    fill="#334155"
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
            const doc = expandedId ? placedNodes.find((p) => p.id === expandedId) : undefined;
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
