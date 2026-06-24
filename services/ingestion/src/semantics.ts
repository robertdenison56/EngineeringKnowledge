import type { PositionedText, VectorPage, VectorStroke } from './vector.js';

/**
 * Sheet semantics from geometry (Phase B of the vector-parsing plan,
 * docs/plans/2026-06-10). Pure functions over the decoded `VectorPage`:
 * what is a dimension, where the callout bubbles point, which dashed line
 * is a match line, what views the sheet contains, which line families form
 * a schedule.
 *
 * The honesty contract from ADRs 0003–0005 applies to every claim: nothing
 * is asserted without `evidence` pointing back at the primitives it was
 * derived from (indexes into `page.texts` / `page.strokes`), the `method`
 * that produced it, and a confidence. Layer attribution (Tier 2) beats
 * geometry beats bare text patterns — and absence of a tier is a reported
 * state, never a guess.
 */

export type DetectionMethod = 'layer' | 'geometry' | 'pattern';

export interface Evidence {
  method: DetectionMethod;
  /** 0..1 — calibrated by method, not optimism. */
  confidence: number;
  /** Indexes into `page.texts` — the spans this claim is derived from. */
  texts: number[];
  /** Indexes into `page.strokes` — the primitives this claim is derived from. */
  strokes: number[];
}

/** A callout bubble or textual reference pointing at another sheet. */
export interface CalloutReference {
  /** Detail/view identifier inside the bubble, e.g. "3" in 3/S-501. */
  detail?: string;
  /** Referenced sheet number as printed, e.g. "S-501". */
  targetSheet: string;
  evidence: Evidence;
}

export interface DimensionHit {
  /** The dimension string as printed, e.g. `12'-6"` or `Ø8`. */
  text: string;
  evidence: Evidence;
}

export interface MatchLineHit {
  label: string;
  /** Sheet the match line continues on, when the label says so. */
  targetSheet?: string;
  evidence: Evidence;
}

export interface ViewRegion {
  kind: 'plan' | 'elevation' | 'section' | 'detail' | 'profile' | 'isometric';
  /** Label as printed, e.g. `SECTION A-A`. */
  label: string;
  /** View name, e.g. "A-A" in SECTION A-A, "A" in DETAIL "A". */
  name?: string;
  /** Scale noted at the label, e.g. `1/2" = 1'-0"`. */
  scale?: string;
  /** Bbox of the geometry cluster the label names, when one is present. */
  region?: [number, number, number, number];
  evidence: Evidence;
}

export interface ScheduleTable {
  /** Heading above the grid, e.g. "PIPE SCHEDULE". */
  title?: string;
  rows: number;
  columns: number;
  /** Text matrix, top row (usually the header) first. */
  cells: string[][];
  bbox: [number, number, number, number];
  evidence: Evidence;
}

export interface SheetSemantics {
  views: ViewRegion[];
  dimensions: DimensionHit[];
  callouts: CalloutReference[];
  matchLines: MatchLineHit[];
  /** Distinct scale notations on the sheet, e.g. `1/4" = 1'-0"`, "N.T.S.". */
  scales: string[];
  schedules: ScheduleTable[];
}

// ---------------------------------------------------------------------------
// Shared geometry + text helpers

type BBox = [number, number, number, number];

/** pdf.js maps CAD-font quotes to typographic ones; measurements normalize. */
const norm = (s: string) => s.replace(/[’′]/g, "'").replace(/[”″]/g, '"');

function textBBox(t: PositionedText): BBox {
  return [t.x, t.y, t.x + Math.max(t.width, 1), t.y + Math.max(t.height, 1)];
}

function textCenter(t: PositionedText): [number, number] {
  return [t.x + t.width / 2, t.y + Math.max(t.height, 1) / 2];
}

function contains(b: BBox, x: number, y: number, margin = 0): boolean {
  return x >= b[0] - margin && x <= b[2] + margin && y >= b[1] - margin && y <= b[3] + margin;
}

/** Gap between two boxes (0 when they touch or overlap). */
function bboxGap(a: BBox, b: BBox): number {
  const dx = Math.max(a[0] - b[2], b[0] - a[2], 0);
  const dy = Math.max(a[1] - b[3], b[1] - a[3], 0);
  return Math.hypot(dx, dy);
}

const isHLine = (s: VectorStroke, minLen: number) =>
  s.curves === 0 && s.bbox[3] - s.bbox[1] <= 1.5 && s.bbox[2] - s.bbox[0] >= minLen;
const isVLine = (s: VectorStroke, minLen: number) =>
  s.curves === 0 && s.bbox[2] - s.bbox[0] <= 1.5 && s.bbox[3] - s.bbox[1] >= minLen;

// ---------------------------------------------------------------------------
// Tier 2: layer-name semantics (NCS/AIA `*-ANNO-DIMS`, MicroStation FDOT
// CADD `tcd_`, `border_PROJ-ID-BLOCK-anno`, …). Detect-and-exploit only —
// layer info is stripped in most exports and never a precondition.

export type LayerSemantic = 'dimension' | 'callout' | 'match-line' | 'title-block';

const LAYER_RULES: Array<{ pattern: RegExp; semantic: LayerSemantic }> = [
  { pattern: /ANNO[-_]?DIMS?\b/i, semantic: 'dimension' },
  { pattern: /ANNO[-_]?SYMB/i, semantic: 'callout' },
  { pattern: /ANNO[-_]?MTLN|MATCH[-_]?LINE/i, semantic: 'match-line' },
  { pattern: /TTLB|PROJ[-_]?ID[-_]?BLOCK/i, semantic: 'title-block' },
];

export function layerSemantic(layer: string | undefined): LayerSemantic | undefined {
  if (!layer) return undefined;
  return LAYER_RULES.find((r) => r.pattern.test(layer))?.semantic;
}

// ---------------------------------------------------------------------------
// Text patterns (Tier 1)

const FEET_INCHES = /\b(\d+)'-(\d+)(?:\s+\d+\/\d+)?(?:"|\b)/;
const INCHES = /\b(\d+)(?:\s+\d+\/\d+)?"/;
/**
 * Curve-data angles (28°26'20") read as inches/feet to the patterns above —
 * strip degree-minute-second runs before dimension matching
 * (Caltrans-corpus eval: every "dimension" on a layout sheet was an angle).
 */
const DMS_ANGLE = /\d{1,3}\s*°\s*\d{1,2}\s*'\s*\d{1,2}(?:\.\d+)?\s*"?/g;
const DIAMETER = /[Øø⌀]\s*\d/;
const SPACING = /@\s*\d+\s*["']?\s*(?:O\.?C\.?|CTRS?\.?|CENTERS)/i;
const METRIC_MM = /\b\d+(?:\.\d+)?\s?mm\b/i;
const SCALE = /\d+(?:\/\d+)?"\s*=\s*\d+'(?:-\d+(?:\s+\d+\/\d+)?")?|\bN\.?T\.?S\.?\b|\bNO\s+SCALE\b/;
/**
 * Bare ratio scales ("1:200") only count standalone or labeled SCALE —
 * plot-stamp times ("1:55:08 PM") and slope callouts ("Sod Slope 1:2")
 * read identically inside running text.
 */
const RATIO_SCALE = /^1\s*:\s*\d{1,4}$|\bSCALE\s*[:=]?\s*(1\s*:\s*\d{1,4})\b/i;
const SHEET_REF = /^[A-Z]{1,2}-?\d{2,4}[A-Z]?$/;
const DETAIL_OVER_SHEET = /^([A-Z0-9]{1,3})\s*\/\s*([A-Z]{1,2}-\d{2,4}[A-Z]?)$/;
const INLINE_REF = /\b([A-Z0-9]{1,3})\s*\/\s*([A-Z]{1,2}-\d{2,4}[A-Z]?)\b/;
const MATCH_LINE = /MATCH\s*LINE/i;
const SEE_SHEET = /SEE\s+(?:SHEET|SHT\.?|DWG\.?|DRAWING)\s+([A-Z0-9][A-Z0-9.-]*?)\.?(?:\s|$)/i;
const VIEW_LABEL =
  /^(?:(?:MIRRORED|PARTIAL|TYPICAL|ENLARGED)\s+)?(PLAN|ELEVATION|SECTION|DETAIL|PROFILE|ISOMETRIC|LAYOUT)\b\s*[-:–]?\s*("?[A-Z0-9]+(?:-[A-Z0-9]+)?"?)?(\s+[A-Z]{2,12}(?:\s+[A-Z]{2,12})?)?\s*$/;
const MASTERFORMAT_HEADING = /^SECTION\s+\d{2}\s?\d{2}\s?\d{2}\b/i;
/** Running-text sentences start with view words too — reject prose. */
const VIEW_STOPWORDS = /\b(SHALL|WITH|SEE|PER|THE|AND|FOR|ALL|USE|ARE|TO|OF|AT|IS)\b/;

// ---------------------------------------------------------------------------
// Dimensions

export function detectDimensions(page: VectorPage, excludeTexts?: Set<number>): DimensionHit[] {
  const hits: DimensionHit[] = [];
  page.texts.forEach((t, i) => {
    if (excludeTexts?.has(i)) return;
    const s = norm(t.str).replace(DMS_ANGLE, ' ');
    // A scale notation reads like a dimension — it is not one.
    if (s.includes('=') || SCALE.test(s)) return;
    const feet = s.match(FEET_INCHES);
    // Real feet-inches keep inches under 12 and feet plausible — "12'-15"
    // and "560'-25" are station/elevation artifacts, not dimensions.
    const feetOk = feet && Number(feet[2]) <= 11 && Number(feet[1]) <= 999;
    const inches = s.match(INCHES);
    const inchesOk = inches && Number(inches[1]) <= 96;
    const m =
      (feetOk ? feet : null) ??
      s.match(DIAMETER) ??
      s.match(SPACING) ??
      s.match(METRIC_MM) ??
      (inchesOk ? inches : null);
    if (!m) return;

    if (layerSemantic(t.layer) === 'dimension') {
      hits.push({ text: m[0], evidence: { method: 'layer', confidence: 0.95, texts: [i], strokes: [] } });
      return;
    }
    // Geometry boost: a thin line primitive hugging the text is the
    // dimension line the value annotates.
    const tb = textBBox(t);
    const nearLine = page.strokes.findIndex(
      (st) => (isHLine(st, 10) || isVLine(st, 10)) && bboxGap(tb, st.bbox) <= 12,
    );
    if (nearLine >= 0) {
      hits.push({ text: m[0], evidence: { method: 'geometry', confidence: 0.8, texts: [i], strokes: [nearLine] } });
    } else {
      hits.push({ text: m[0], evidence: { method: 'pattern', confidence: 0.6, texts: [i], strokes: [] } });
    }
  });
  return hits;
}

// ---------------------------------------------------------------------------
// Callout bubbles → cross-sheet references

/** Closed 4-Bézier loops with a square-ish bbox at symbol size are circles. */
function isCalloutCircle(s: VectorStroke): boolean {
  const w = s.bbox[2] - s.bbox[0];
  const h = s.bbox[3] - s.bbox[1];
  if (!s.closed || s.curves < 4 || s.commands > s.curves + 4) return false;
  if (w < 8 || w > 90 || h < 8 || h > 90) return false;
  const aspect = w / h;
  return aspect > 0.75 && aspect < 1.33;
}

export function detectCallouts(page: VectorPage): CalloutReference[] {
  const out: CalloutReference[] = [];
  const consumed = new Set<number>();

  page.strokes.forEach((stroke, si) => {
    if (!isCalloutCircle(stroke)) return;
    const inside: number[] = [];
    page.texts.forEach((t, ti) => {
      const [cx, cy] = textCenter(t);
      if (contains(stroke.bbox, cx, cy, 2) && t.str.trim().length > 0) inside.push(ti);
    });
    if (inside.length === 0) return;

    let detail: string | undefined;
    let target: string | undefined;
    const evidenceTexts: number[] = [];
    // Single-span "3/S-501" form.
    for (const ti of inside) {
      const m = norm(page.texts[ti].str).trim().match(DETAIL_OVER_SHEET);
      if (m) {
        detail = m[1];
        target = m[2];
        evidenceTexts.push(ti);
        break;
      }
    }
    // Stacked form: detail number above, sheet number below the divider.
    if (!target) {
      const sheetTi = inside.find((ti) => SHEET_REF.test(page.texts[ti].str.trim()));
      if (sheetTi !== undefined) {
        target = page.texts[sheetTi].str.trim();
        evidenceTexts.push(sheetTi);
        const detailTi = inside.find(
          (ti) =>
            ti !== sheetTi &&
            /^[A-Z0-9]{1,3}$/.test(page.texts[ti].str.trim()) &&
            page.texts[ti].y > page.texts[sheetTi].y,
        );
        if (detailTi !== undefined) {
          detail = page.texts[detailTi].str.trim();
          evidenceTexts.push(detailTi);
        }
      }
    }
    if (!target) return;
    evidenceTexts.forEach((ti) => consumed.add(ti));
    const method: DetectionMethod = layerSemantic(stroke.layer) === 'callout' ? 'layer' : 'geometry';
    out.push({
      ...(detail ? { detail } : {}),
      targetSheet: target,
      evidence: {
        method,
        confidence: method === 'layer' ? 0.95 : 0.9,
        texts: evidenceTexts,
        strokes: [si],
      },
    });
  });

  // Pattern fallback: "3/S-501" in running text, no bubble found around it.
  page.texts.forEach((t, ti) => {
    if (consumed.has(ti)) return;
    const m = norm(t.str).match(INLINE_REF);
    if (!m) return;
    out.push({
      detail: m[1],
      targetSheet: m[2],
      evidence: { method: 'pattern', confidence: 0.6, texts: [ti], strokes: [] },
    });
  });

  // Dedup by detail/target, keeping the strongest evidence.
  const best = new Map<string, CalloutReference>();
  for (const c of out) {
    const key = `${c.detail ?? ''}/${c.targetSheet}`;
    const prev = best.get(key);
    if (!prev || c.evidence.confidence > prev.evidence.confidence) best.set(key, c);
  }
  return [...best.values()];
}

// ---------------------------------------------------------------------------
// Match lines

export function detectMatchLines(page: VectorPage): MatchLineHit[] {
  const hits: MatchLineHit[] = [];
  const longSide = Math.max(page.width, page.height);
  page.texts.forEach((t, ti) => {
    const s = norm(t.str);
    if (!MATCH_LINE.test(s)) return;
    const label = s.replace(/\s+/g, ' ').trim();
    const targetSheet = label.match(SEE_SHEET)?.[1];

    // The long dashed stroke the label rides on (collinearity via proximity:
    // the label sits on or immediately beside the line).
    const tb = textBBox(t);
    let strokeIdx = -1;
    page.strokes.forEach((st, si) => {
      if (!st.dashed) return;
      const w = st.bbox[2] - st.bbox[0];
      const h = st.bbox[3] - st.bbox[1];
      if (Math.max(w, h) < longSide * 0.2 || Math.min(w, h) > 3) return;
      if (strokeIdx === -1 && bboxGap(tb, st.bbox) <= 30) strokeIdx = si;
    });

    const layered = layerSemantic(strokeIdx >= 0 ? page.strokes[strokeIdx].layer : undefined) === 'match-line' ||
      layerSemantic(t.layer) === 'match-line';
    const method: DetectionMethod = layered ? 'layer' : strokeIdx >= 0 ? 'geometry' : 'pattern';
    hits.push({
      label,
      ...(targetSheet ? { targetSheet } : {}),
      evidence: {
        method,
        confidence: method === 'layer' ? 0.95 : method === 'geometry' ? 0.9 : 0.6,
        texts: [ti],
        strokes: strokeIdx >= 0 ? [strokeIdx] : [],
      },
    });
  });
  return hits;
}

// ---------------------------------------------------------------------------
// Views

const TITLE_BLOCK_BAND = 0.16; // matches harvestTitleBlock — that band is its turf

export function detectViews(page: VectorPage): ViewRegion[] {
  const out: ViewRegion[] = [];
  page.texts.forEach((t, ti) => {
    const s = norm(t.str).replace(/\s+/g, ' ').trim();
    if (s.length === 0 || s.length > 40 || s !== s.toUpperCase()) return;
    if (t.y <= page.height * TITLE_BLOCK_BAND) return; // title block, not a view
    if (MASTERFORMAT_HEADING.test(s)) return; // spec heading, not a drawing view
    if (VIEW_STOPWORDS.test(s)) return; // prose that happens to start with PLAN/…
    const m = s.match(VIEW_LABEL);
    if (!m) return;

    const word = m[1].toLowerCase();
    const kind = (word === 'layout' ? 'plan' : word) as ViewRegion['kind'];
    const name = m[2]?.replace(/"/g, '');

    // Scale noted at the label: nearest scale text just below it.
    let scale: string | undefined;
    let scaleTi = -1;
    page.texts.forEach((c, ci) => {
      if (ci === ti) return;
      const cs = norm(c.str);
      const sm = cs.match(SCALE);
      if (!sm) return;
      const dy = t.y - c.y;
      if (dy <= 0 || dy > 40 || Math.abs(c.x - t.x) > 120) return;
      if (scaleTi === -1 || dy < t.y - page.texts[scaleTi].y) {
        scale = sm[0].trim();
        scaleTi = ci;
      }
    });

    // The geometry cluster above the label is the view it names.
    let region: BBox | undefined;
    const regionStrokes: number[] = [];
    const x0 = t.x - 60;
    const x1 = t.x + Math.max(t.width, 120) + 60;
    let rb: BBox = [Infinity, Infinity, -Infinity, -Infinity];
    page.strokes.forEach((st, si) => {
      const cx = (st.bbox[0] + st.bbox[2]) / 2;
      const cy = (st.bbox[1] + st.bbox[3]) / 2;
      if (cx < x0 || cx > x1 || cy <= t.y || cy > t.y + 400) return;
      regionStrokes.push(si);
      rb = [
        Math.min(rb[0], st.bbox[0]),
        Math.min(rb[1], st.bbox[1]),
        Math.max(rb[2], st.bbox[2]),
        Math.max(rb[3], st.bbox[3]),
      ];
    });
    if (regionStrokes.length >= 4) region = rb;

    out.push({
      kind,
      label: s,
      ...(name ? { name } : {}),
      ...(scale ? { scale } : {}),
      ...(region ? { region } : {}),
      evidence: {
        method: region ? 'geometry' : 'pattern',
        confidence: region ? 0.85 : 0.6,
        texts: scaleTi >= 0 ? [ti, scaleTi] : [ti],
        strokes: regionStrokes,
      },
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Scales

export function detectScales(page: VectorPage): string[] {
  const found = new Set<string>();
  for (const t of page.texts) {
    const s = norm(t.str).trim();
    const m = s.match(SCALE);
    if (m) {
      found.add(m[0].trim());
      continue;
    }
    const r = s.match(RATIO_SCALE);
    if (r) found.add((r[1] ?? r[0]).replace(/\s+/g, ''));
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Schedules — aligned line families → cell grid → text matrix

interface LineFamily {
  strokeIdxs: number[];
  ys: number[];
  x0: number;
  x1: number;
}

export function detectSchedules(page: VectorPage): ScheduleTable[] {
  const out: ScheduleTable[] = [];
  const ALIGN = 8; // pt tolerance for "same extent"

  // Horizontal rules grouped by shared x-extent.
  const families: LineFamily[] = [];
  page.strokes.forEach((s, si) => {
    if (!isHLine(s, 40)) return;
    const [x0, y, x1] = [s.bbox[0], (s.bbox[1] + s.bbox[3]) / 2, s.bbox[2]];
    const fam = families.find((f) => Math.abs(f.x0 - x0) <= ALIGN && Math.abs(f.x1 - x1) <= ALIGN);
    if (fam) {
      fam.strokeIdxs.push(si);
      fam.ys.push(y);
    } else {
      families.push({ strokeIdxs: [si], ys: [y], x0, x1 });
    }
  });

  for (const fam of families) {
    // Distinct y positions, top-down.
    const ys = [...new Set(fam.ys.map((y) => Math.round(y * 2) / 2))].sort((a, b) => b - a);
    if (ys.length < 3) continue;
    const yTop = ys[0];
    const yBot = ys[ys.length - 1];

    // Verticals spanning the family's full height inside its x-extent.
    const vIdx: number[] = [];
    const vXs: number[] = [];
    page.strokes.forEach((s, si) => {
      if (!isVLine(s, 8)) return;
      const x = (s.bbox[0] + s.bbox[2]) / 2;
      if (x < fam.x0 - ALIGN || x > fam.x1 + ALIGN) return;
      if (s.bbox[1] > yBot + ALIGN || s.bbox[3] < yTop - ALIGN) return;
      vIdx.push(si);
      vXs.push(x);
    });
    const xs = [...new Set(vXs.map((x) => Math.round(x * 2) / 2))].sort((a, b) => a - b);
    if (xs.length < 3) continue; // a grid needs at least 2 columns

    // Assign text spans to cells by their center point.
    const rows = ys.length - 1;
    const columns = xs.length - 1;
    const cellTexts: number[][][] = Array.from({ length: rows }, () =>
      Array.from({ length: columns }, () => []),
    );
    const usedTexts: number[] = [];
    page.texts.forEach((t, ti) => {
      const [cx, cy] = textCenter(t);
      if (cx < xs[0] || cx > xs[columns] || cy < yBot || cy > yTop) return;
      const r = ys.findIndex((y, i) => i < rows && cy <= y && cy >= ys[i + 1]);
      const c = xs.findIndex((x, i) => i < columns && cx >= x && cx <= xs[i + 1]);
      if (r < 0 || c < 0) return;
      cellTexts[r][c].push(ti);
      usedTexts.push(ti);
    });
    const cells = cellTexts.map((row) =>
      row.map((idxs) =>
        idxs
          .sort((a, b) => page.texts[a].x - page.texts[b].x)
          .map((ti) => page.texts[ti].str.trim())
          .join(' ')
          .trim(),
      ),
    );
    const nonEmpty = cells.flat().filter((c) => c.length > 0).length;
    // Sparse grids are drawn structure (column lines, county boxes,
    // signature blocks — Caltrans-corpus eval false positives), not data
    // tables. Real schedules keep most cells filled.
    if (nonEmpty < 2 || nonEmpty / (rows * columns) < 0.5) continue;

    // Heading directly above the top rule — words, not a stray cell value.
    let title: string | undefined;
    page.texts.forEach((t) => {
      const dy = t.y - yTop;
      if (dy <= 0 || dy > 18 || t.x < fam.x0 - 10 || t.x > fam.x1) return;
      const s = t.str.trim();
      if (s.length >= 4 && s === s.toUpperCase() && /[A-Z]{3}/.test(s)) title = title ?? s;
    });

    out.push({
      ...(title ? { title } : {}),
      rows,
      columns,
      cells,
      bbox: [fam.x0, yBot, fam.x1, yTop],
      evidence: {
        method: 'geometry',
        confidence: 0.85,
        texts: usedTexts,
        strokes: [...fam.strokeIdxs, ...vIdx],
      },
    });
  }

  // Dense real-world tables shed near-duplicate families (rule extents vary
  // by a few points) — keep the densest grid where bboxes mostly coincide.
  out.sort((a, b) => b.rows * b.columns - a.rows * a.columns);
  const kept: ScheduleTable[] = [];
  for (const table of out) {
    const dup = kept.some((k) => {
      const ox = Math.min(k.bbox[2], table.bbox[2]) - Math.max(k.bbox[0], table.bbox[0]);
      const oy = Math.min(k.bbox[3], table.bbox[3]) - Math.max(k.bbox[1], table.bbox[1]);
      if (ox <= 0 || oy <= 0) return false;
      const area = (table.bbox[2] - table.bbox[0]) * (table.bbox[3] - table.bbox[1]);
      return area > 0 && (ox * oy) / area > 0.6;
    });
    if (!dup) kept.push(table);
  }
  return kept;
}

/**
 * Sheet numbers print inconsistently across title blocks, callouts, and
 * filenames ("S-501", "S501", "s-501 "). One canonical form for matching.
 */
export function normalizeSheetNumber(sheet: string): string {
  return sheet.toUpperCase().replace(/[\s-]+/g, '');
}

// ---------------------------------------------------------------------------
// The full per-sheet analysis

export function analyzeSheet(page: VectorPage): SheetSemantics {
  const schedules = detectSchedules(page);
  // Schedule cells quote sizes ('18" RCP') — counting them as loose
  // dimensions would double-report what the table already states.
  const scheduleTexts = new Set(schedules.flatMap((s) => s.evidence.texts));
  return {
    views: detectViews(page),
    dimensions: detectDimensions(page, scheduleTexts),
    callouts: detectCallouts(page),
    matchLines: detectMatchLines(page),
    scales: detectScales(page),
    schedules,
  };
}
