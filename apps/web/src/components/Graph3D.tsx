'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import ForceGraph3D from 'react-force-graph-3d';
import SpriteText from 'three-spritetext';
import * as THREE from 'three';
import { forceCollide } from 'd3-force-3d';
import type { RetrievalRole } from '@ekg/core';
import { entityHref, typeColor } from './ui';
import { nodeMatchesRole, shortTitle, type MapLink, type MapNode } from './map-shared';

interface GNode extends MapNode {
  degree: number;
  x?: number;
  y?: number;
  z?: number;
}

const H = 600;

/**
 * In-scene sprite labels are only readable (and affordable) up to a point;
 * past this the hover tooltip carries the names instead.
 */
const LABEL_LIMIT = 250;

/**
 * WebGL materials can't read CSS custom properties, so the app theme is
 * resolved to concrete colors at mount and re-resolved when the theme flips
 * (`data-theme` mutation or an OS scheme change). The canvas itself stays
 * transparent so the themed `--surface-2` page background shows through.
 */
interface ThemeTokens {
  text: string;
  border: string;
  dimNode: string;
  dimLink: string;
  surface2: string;
}

function mixHex(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1), 16);
  const pb = Number.parseInt(b.slice(1), 16);
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return a;
  const ch = (shift: number) =>
    Math.round(((pa >> shift) & 0xff) * (1 - t) + ((pb >> shift) & 0xff) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

function readTheme(): ThemeTokens {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  const text = v('--text', '#0b1f3a');
  const muted = v('--muted', '#5b6b87');
  const border = v('--border', '#dbe4f0');
  const surface2 = v('--surface-2', '#f8fbff');
  return {
    text,
    border,
    surface2,
    // Dim = pushed most of the way into the background, matching the 2D
    // view's opacity-0.15 treatment without per-node material opacity.
    dimNode: mixHex(muted, surface2, 0.8),
    dimLink: mixHex(border, surface2, 0.75),
  };
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Sphere radius used for label offsets and collision — mirrors nodeVal. */
function nodeRadius(n: GNode): number {
  return Math.cbrt(1 + Math.min(n.degree, 8)) * 4;
}

/**
 * WebGL 3D rendering of the knowledge map (react-force-graph-3d + the
 * d3-force-3d engine — the same force API the 2D view uses, one dimension
 * up). Loaded lazily behind GraphMap's 2D/3D toggle, never during SSR.
 *
 * Parity with the SVG view: type colors, degree-scaled size, unverified fade,
 * amber wireframe halo for superseded/deprecated, hover neighborhood dimming,
 * role-lens dimming, filters via visibility (layout runs once per payload —
 * warmup ticks, then frozen, like the 2D view's synchronous 300 ticks), and
 * click-through to entity pages. Chunked documents open a docked section
 * panel instead of the 2D radial fan — billboarded text fans read poorly in
 * 3D — and the camera flies to the clicked document.
 */
export default function Graph3D({
  nodes,
  links,
  visibleNodeIds,
  visibleLinkIds,
  activeRole,
  resetSignal,
  focusId,
}: {
  nodes: MapNode[];
  links: MapLink[];
  visibleNodeIds: Set<string>;
  visibleLinkIds: Set<string>;
  activeRole?: RetrievalRole;
  resetSignal: number;
  focusId?: string;
}) {
  const router = useRouter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- library ref surface
  const fgRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(920);
  const [theme, setTheme] = useState<ThemeTokens | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<GNode | null>(null);
  const [data, setData] = useState<{ nodes: GNode[]; links: MapLink[] } | null>(null);
  const didFocusFly = useRef(false);

  // Track the container width so the canvas fills the card at any window size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(320, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Theme bridge: resolve CSS variables now, again on toggle or OS change.
  useEffect(() => {
    setTheme(readTheme());
    const onChange = () => setTheme(readTheme());
    const mo = new MutationObserver(onChange);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', onChange);
    return () => {
      mo.disconnect();
      mq.removeEventListener('change', onChange);
    };
  }, []);

  // The engine mutates node objects (x/y/z, internal refs) and rewrites link
  // endpoints into object references — build private copies so the props
  // shared with the 2D view are never touched. Degree comes from the full
  // link set, matching the SVG view's stable node sizes.
  const built = useMemo(() => {
    const degree = new Map<string, number>();
    for (const l of links) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
    }
    return {
      nodes: nodes.map((n): GNode => ({ ...n, degree: degree.get(n.id) ?? 0 })),
      links: links.map((l) => ({ ...l })),
    };
  }, [nodes, links]);

  // Configure forces BEFORE handing the data over, so the warmup ticks run
  // against the intended physics (the 2D constants, retuned for 3D volume).
  // Depends on `theme` because the canvas (and so the ref) only exists once
  // the theme has resolved — with `built` alone this would fire exactly once,
  // pre-mount, and the data would never reach the engine. Theme re-runs are
  // no-ops for the layout: `built` keeps its identity, so the graphData prop
  // doesn't change and the engine isn't re-warmed.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !theme) return;
    fg.d3Force('link')?.distance(70);
    fg.d3Force('charge')?.strength(-220);
    fg.d3Force('collide', forceCollide<GNode>((n) => nodeRadius(n) + 8));
    didFocusFly.current = false;
    setData(built);
  }, [built, theme]);

  // Hover adjacency over the VISIBLE edges only — same rule as the 2D view.
  const adjacency = useMemo(() => {
    const adj = new Map<string, Set<string>>();
    for (const l of links) {
      if (!visibleLinkIds.has(l.id)) continue;
      if (!adj.has(l.source)) adj.set(l.source, new Set());
      if (!adj.has(l.target)) adj.set(l.target, new Set());
      adj.get(l.source)!.add(l.target);
      adj.get(l.target)!.add(l.source);
    }
    return adj;
  }, [links, visibleLinkIds]);

  const focus = hoverId ?? selectedDoc?.id ?? null;

  const nodeColorFn = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any): string => {
      const n = node as GNode;
      const base = typeColor(n.type);
      if (!theme) return base;
      const hoverDimmed =
        focus !== null && n.id !== focus && !(adjacency.get(focus)?.has(n.id) ?? false);
      const roleDimmed = activeRole ? !nodeMatchesRole(n, activeRole) : false;
      if (hoverDimmed || roleDimmed) return theme.dimNode;
      return n.reviewStatus === 'unverified' ? mixHex(base, theme.surface2, 0.45) : base;
    },
    [theme, focus, adjacency, activeRole],
  );

  const linkColorFn = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (link: any): string => {
      if (!theme) return '#cbd5e1';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const endId = (e: any): string => (typeof e === 'object' && e !== null ? e.id : e);
      const dim = focus !== null && endId(link.source) !== focus && endId(link.target) !== focus;
      return dim ? theme.dimLink : theme.border;
    },
    [theme, focus],
  );

  // In-scene labels and the flagged-status halo. Deliberately independent of
  // hover/filter state: rebuilding sprites for a thousand nodes on every
  // hover would jank — dimming happens in the cheap color accessors instead.
  const showLabels = visibleNodeIds.size <= LABEL_LIMIT;
  const nodeThreeObjectFn = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any): THREE.Object3D => {
      const n = node as GNode;
      const group = new THREE.Group();
      const flagged = n.reviewStatus === 'superseded' || n.reviewStatus === 'deprecated';
      // An empty group extends the default sphere with nothing — the typed
      // equivalent of "no extra object" (the accessor type forbids undefined).
      if (!theme || (!showLabels && !flagged)) return group;
      const r = nodeRadius(n);
      if (flagged) {
        // The 3D reading of the 2D dashed amber ring: a wireframe shell.
        const shell = new THREE.Mesh(
          new THREE.SphereGeometry(r + 2.2, 8, 6),
          new THREE.MeshBasicMaterial({
            color: '#d97706',
            wireframe: true,
            transparent: true,
            opacity: 0.55,
          }),
        );
        group.add(shell);
      }
      if (showLabels) {
        const badge = (n.sections?.length ?? 0) > 0 ? ` §${n.sectionCount ?? n.sections!.length}` : '';
        const label = new SpriteText(shortTitle(n.title) + badge, 3.4, theme.text);
        label.material.depthWrite = false;
        label.position.y = -(r + 5);
        group.add(label);
      }
      return group;
    },
    [theme, showLabels],
  );

  const nodeLabelFn = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any): string => {
      const n = node as GNode;
      const secs =
        (n.sections?.length ?? 0) > 0
          ? ` · ${n.sectionCount ?? n.sections!.length} sections — click to open them`
          : '';
      return `<div class="map-3d-tip"><strong>${esc(n.title)}</strong><br/>${esc(n.type)} · ${esc(n.reviewStatus)}${esc(secs)}</div>`;
    },
    [],
  );

  const flyTo = useCallback((n: GNode) => {
    const fg = fgRef.current;
    if (!fg) return;
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    const z = n.z ?? 0;
    const dist = Math.hypot(x, y, z) || 1;
    const ratio = 1 + 140 / dist;
    fg.cameraPosition({ x: x * ratio, y: y * ratio, z: z * ratio }, { x, y, z }, 900);
  }, []);

  const onNodeClick = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any) => {
      const n = node as GNode;
      if ((n.sections?.length ?? 0) > 0) {
        setSelectedDoc((prev) => (prev?.id === n.id ? null : n));
        flyTo(n);
      } else {
        router.push(entityHref(n.id));
      }
    },
    [flyTo, router],
  );

  // Arriving with ?focus= flies the camera to that entity once the warmed-up
  // layout has settled (cooldownTicks 0 → the engine stops immediately).
  const onEngineStop = useCallback(() => {
    if (didFocusFly.current || !focusId || !data) return;
    didFocusFly.current = true;
    const n = data.nodes.find((x) => x.id === focusId);
    if (n) flyTo(n);
  }, [focusId, data, flyTo]);

  // Frame the whole (visible) graph in the viewport — the in-canvas "Fit"
  // button and the shell's "Reset view" chip both call this. 400ms ease, 40px
  // padding; the accessor keeps hidden nodes from skewing the bounds.
  const fitToView = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fgRef.current?.zoomToFit(400, 40, (n: any) => visibleNodeIds.has((n as GNode).id));
  }, [visibleNodeIds]);

  // The shell's "Reset view" chip frames the whole graph too.
  useEffect(() => {
    if (resetSignal > 0) fitToView();
  }, [resetSignal, fitToView]);

  useEffect(() => {
    if (!selectedDoc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedDoc(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedDoc]);

  const doc = selectedDoc && visibleNodeIds.has(selectedDoc.id) ? selectedDoc : null;
  const docExtra = doc ? (doc.sectionCount ?? doc.sections!.length) - doc.sections!.length : 0;

  return (
    <div ref={wrapRef} className="map-3d" style={{ height: H }}>
      {theme ? (
        <ForceGraph3D
          ref={fgRef}
          width={width}
          height={H}
          graphData={data ?? { nodes: [], links: [] }}
          backgroundColor="rgba(0,0,0,0)"
          showNavInfo={false}
          warmupTicks={300}
          cooldownTicks={0}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodeVal={(n: any) => 1 + Math.min((n as GNode).degree, 8)}
          nodeColor={nodeColorFn}
          nodeOpacity={0.92}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodeVisibility={(n: any) => visibleNodeIds.has((n as GNode).id)}
          nodeThreeObject={nodeThreeObjectFn}
          nodeThreeObjectExtend={true}
          nodeLabel={nodeLabelFn}
          linkColor={linkColorFn}
          linkOpacity={0.55}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkVisibility={(l: any) => visibleLinkIds.has((l as MapLink).id)}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkLabel={(l: any) => esc((l as MapLink).type)}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onNodeHover={(n: any) => setHoverId(n ? (n as GNode).id : null)}
          onNodeClick={onNodeClick}
          onBackgroundClick={() => setSelectedDoc(null)}
          onEngineStop={onEngineStop}
        />
      ) : null}
      <div className="map-3d-controls">
        <button
          type="button"
          className="map-3d-ctrl"
          title="Fit the whole graph to the view"
          aria-label="Fit graph to screen"
          onClick={fitToView}
        >
          ⤢ Fit to screen
        </button>
      </div>
      {doc ? (
        <aside className="map-3d-panel" aria-label={`Sections of ${doc.title}`}>
          <button type="button" className="map-3d-close" onClick={() => setSelectedDoc(null)}>
            ✕
          </button>
          <h4>{doc.title}</h4>
          <p className="meta">
            {doc.sectionCount ?? doc.sections!.length} indexed section
            {(doc.sectionCount ?? doc.sections!.length) === 1 ? '' : 's'}
          </p>
          <ul>
            {doc.sections!.map((s, i) => (
              <li key={i}>
                <span className="sec-label">{s.label}</span>
                <br />
                <span className="sec-desc">{s.description}</span>
              </li>
            ))}
            {docExtra > 0 ? (
              <li>
                <span className="sec-desc">
                  +{docExtra} more section{docExtra === 1 ? '' : 's'} — open the document for the
                  full list
                </span>
              </li>
            ) : null}
          </ul>
          <a href={entityHref(doc.id)}>Open document →</a>
        </aside>
      ) : null}
      <p className="map-3d-hint">drag to orbit · scroll to zoom · right-drag to pan</p>
    </div>
  );
}
