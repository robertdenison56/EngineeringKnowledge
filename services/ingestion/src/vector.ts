import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * CAD-native vector extraction (Phase A of the vector-parsing plan,
 * docs/plans/2026-06-10). Decodes what survives in vector PDFs exported
 * from MicroStation / Civil 3D / AutoCAD:
 *
 *  - positioned text (every string with page coordinates)
 *  - path primitives with graphics state, CTM-resolved to page space
 *  - CAD layer names via Optional Content Groups, when the export kept them
 *
 * From those it reconstructs reading order (drawing text extracts in draw
 * order — notes come out 8…1 — spatial ordering fixes search content and
 * grounding) and harvests the title block (sheet number, index, revision)
 * from geometry rather than the filename.
 *
 * pdf.js v6 path encoding, verified empirically against authored fixtures
 * (scripts/make-sample-pdfs.mjs): flat arrays of [op, ...coords] with
 * moveTo=0 (2 coords), lineTo=1 (2), cubic curveTo=2 (6, v/y normalized),
 * closePath=4. This is an internal encoding — the version is pinned and
 * fixture tests will catch a change.
 */

export interface PositionedText {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** CAD layer (OCG) name, when the document carries layer metadata. */
  layer?: string;
}

export interface VectorStroke {
  /** Page-space bounding box [minX, minY, maxX, maxY] (CTM applied). */
  bbox: [number, number, number, number];
  /** Number of decoded path commands (size proxy for the primitive). */
  commands: number;
  /** Cubic Bézier commands among them — circles are 4-curve loops. */
  curves: number;
  lineWidth: number;
  dashed: boolean;
  closed: boolean;
  render: 'stroke' | 'fill' | 'fillStroke' | 'other';
  layer?: string;
}

export interface TitleBlock {
  /** Drawing/index number, e.g. "430-030" (DOT) or "A-501" (AIA/NCS). */
  sheetNumber?: string;
  sheetIndex?: number;
  sheetTotal?: number;
  title?: string;
  /** Last-revision date string as printed, e.g. "11/01/19". */
  revision?: string;
  /** All text found in the title-block band — the evidence. */
  raw: string[];
}

export interface VectorPage {
  pageNumber: number;
  width: number;
  height: number;
  texts: PositionedText[];
  strokes: VectorStroke[];
  orderedText: string;
  titleBlock?: TitleBlock;
}

export interface VectorContent {
  pageCount: number;
  /** Analyzed pages (up to options.maxPages). */
  pages: VectorPage[];
  /** CAD layer names, or null when the export stripped them (honest state). */
  layers: string[] | null;
  capability: {
    hasTextLayer: boolean;
    /** OCG layer names listed in the document catalog (0 = stripped). */
    layerTable: number;
    /**
     * True only when content is actually tagged with layers (BDC /OC marked
     * content). Some CAD exports keep the layer *table* but drop per-
     * primitive membership — then the names are metadata, nothing more.
     */
    layerAttribution: boolean;
    charsPerPage: number;
    strokesPerPage: number;
  };
}

/** Same scan threshold as ADR 0004's text-layer gate. */
const MIN_CHARS_PER_PAGE = 24;

// ---------------------------------------------------------------------------
// Matrix helpers (PDF CTM [a, b, c, d, e, f])

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    n[0] * m[0] + n[1] * m[2],
    n[0] * m[1] + n[1] * m[3],
    n[2] * m[0] + n[3] * m[2],
    n[2] * m[1] + n[3] * m[3],
    n[4] * m[0] + n[5] * m[2] + m[4],
    n[4] * m[1] + n[5] * m[3] + m[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// ---------------------------------------------------------------------------
// Path + layer decoding from the operator list

const PATH_OP_COORDS: Record<number, number> = { 0: 2, 1: 2, 2: 6, 4: 0 };

interface OpsDecodeResult {
  strokes: VectorStroke[];
  /** OC layer active at each marked-content event, for text correlation. */
  markedContentLayers: (string | null)[];
}

function topLayer(stack: (string | null)[]): string | null {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i] !== null) return stack[i];
  return null;
}

function decodeOperatorList(
  opList: { fnArray: number[]; argsArray: unknown[] },
  resolveLayer: (id: string) => string | undefined,
): OpsDecodeResult {
  const strokes: VectorStroke[] = [];
  const markedContentLayers: (string | null)[] = [];
  const ctmStack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  const ocStack: (string | null)[] = [];
  let lineWidth = 1;
  let dashed = false;

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i] as unknown[];
    switch (fn) {
      case OPS.save:
        ctmStack.push(ctm);
        break;
      case OPS.restore:
        ctm = ctmStack.pop() ?? IDENTITY;
        break;
      case OPS.transform:
        ctm = multiply(ctm, args as unknown as Matrix);
        break;
      case OPS.setLineWidth:
        lineWidth = args[0] as number;
        break;
      case OPS.setDash:
        dashed = Array.isArray(args[0]) && (args[0] as unknown[]).length > 0;
        break;
      case OPS.beginMarkedContentProps: {
        const [tag, props] = args as [string, { id?: string } | null];
        const layer =
          tag === 'OC' && props?.id ? (resolveLayer(props.id) ?? null) : null;
        ocStack.push(layer);
        markedContentLayers.push(topLayer(ocStack));
        break;
      }
      case OPS.beginMarkedContent:
        ocStack.push(null);
        markedContentLayers.push(topLayer(ocStack));
        break;
      case OPS.endMarkedContent:
        ocStack.pop();
        markedContentLayers.push(topLayer(ocStack));
        break;
      case OPS.constructPath: {
        const [renderOp, pathData] = args as [number, ArrayLike<number>[]];
        const data = pathData?.[0];
        if (!data || data.length === 0) break;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let commands = 0;
        let curves = 0;
        let closed = false;
        let ok = true;
        for (let p = 0; p < data.length; ) {
          const op = data[p];
          const coords = PATH_OP_COORDS[op];
          if (coords === undefined) {
            ok = false; // unknown opcode — refuse to guess (encoding drift)
            break;
          }
          commands += 1;
          if (op === 2) curves += 1;
          if (op === 4) closed = true;
          for (let c = 0; c < coords; c += 2) {
            const [x, y] = apply(ctm, data[p + 1 + c], data[p + 2 + c]);
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
          p += 1 + coords;
        }
        if (!ok || commands === 0 || minX === Infinity) break;
        const render =
          renderOp === OPS.stroke || renderOp === OPS.closeStroke
            ? 'stroke'
            : renderOp === OPS.fill || renderOp === OPS.eoFill
              ? 'fill'
              : renderOp === OPS.fillStroke || renderOp === OPS.eoFillStroke
                ? 'fillStroke'
                : 'other';
        const layer = topLayer(ocStack) ?? undefined;
        strokes.push({
          bbox: [minX, minY, maxX, maxY],
          commands,
          curves,
          lineWidth,
          dashed,
          closed,
          render,
          ...(layer ? { layer } : {}),
        });
        break;
      }
    }
  }
  return { strokes, markedContentLayers };
}

// ---------------------------------------------------------------------------
// Reading order — recursive XY-cut over positioned text

const GAP_Y = 14; // pt of empty vertical space that separates blocks
const GAP_X = 30; // pt of empty horizontal space that separates columns

interface Span {
  t: PositionedText;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function findGap(
  spans: Span[],
  lo: (s: Span) => number,
  hi: (s: Span) => number,
  minGap: number,
): number | undefined {
  const sorted = [...spans].sort((a, b) => lo(a) - lo(b));
  let reach = hi(sorted[0]);
  let best: { at: number; size: number } | undefined;
  for (const s of sorted) {
    const gap = lo(s) - reach;
    if (gap >= minGap && (!best || gap > best.size)) best = { at: reach + gap / 2, size: gap };
    reach = Math.max(reach, hi(s));
  }
  return best?.at;
}

function xyCut(spans: Span[], out: Span[][]): void {
  if (spans.length === 0) return;
  // Prefer horizontal cuts (top/bottom blocks), then vertical (columns).
  const yGap = findGap(spans, (s) => s.y0, (s) => s.y1, GAP_Y);
  if (yGap !== undefined) {
    // Page coordinates are bottom-up: the upper block reads first.
    xyCut(spans.filter((s) => s.y0 >= yGap), out);
    xyCut(spans.filter((s) => s.y0 < yGap), out);
    return;
  }
  const xGap = findGap(spans, (s) => s.x0, (s) => s.x1, GAP_X);
  if (xGap !== undefined) {
    xyCut(spans.filter((s) => s.x0 < xGap), out);
    xyCut(spans.filter((s) => s.x0 >= xGap), out);
    return;
  }
  out.push(spans);
}

export function orderTexts(texts: PositionedText[]): string {
  const spans: Span[] = texts
    .filter((t) => t.str.trim().length > 0)
    .map((t) => ({
      t,
      x0: t.x,
      x1: t.x + Math.max(t.width, 1),
      y0: t.y,
      y1: t.y + Math.max(t.height, 1),
    }));
  if (spans.length === 0) return '';

  const blocks: Span[][] = [];
  xyCut(spans, blocks);

  const lines: string[] = [];
  for (const block of blocks) {
    // Group block spans into visual lines by baseline proximity.
    const byY = [...block].sort((a, b) => b.y0 - a.y0 || a.x0 - b.x0);
    let line: Span[] = [];
    let lineY = Infinity;
    const flush = () => {
      if (line.length === 0) return;
      lines.push(
        line
          .sort((a, b) => a.x0 - b.x0)
          .map((s) => s.t.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      );
      line = [];
    };
    for (const s of byY) {
      const tol = Math.max(s.y1 - s.y0, 4) * 0.6;
      if (line.length > 0 && Math.abs(s.y0 - lineY) > tol) flush();
      if (line.length === 0) lineY = s.y0;
      line.push(s);
    }
    flush();
  }
  return lines.filter((l) => l.length > 0).join('\n');
}

// ---------------------------------------------------------------------------
// Title-block harvest

const DOT_INDEX = /\b(\d{3}-\d{3})\b/;
const AIA_SHEET = /\b([A-Z]{1,2}-\d{3}[A-Z]?)\b/;
/**
 * Caltrans drawing numbers are short — L-1, U-2, X-12 (Caltrans-corpus
 * eval, 2026-06-11). Too short to trust inside running text (the AIA
 * pattern requires 3 digits for that reason), but safe as a complete span.
 */
const SHORT_SHEET_SPAN = /^([A-Z]{1,3}-\d{1,3}[A-Z]?)$/;
const SHEET_OF = /\b(\d{1,3})\s+of\s+(\d{1,4})\b/i;
/** Slash and dash forms — Caltrans prints 6-18-22, FDOT 11/01/19. */
const DATE = /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/;
const BAND = 0.16; // bottom fraction of the page examined
const LABELS =
  /^(INDEX|SHEET|NO\.?|LAST|REVISION|DESCRIPTION|DATE|FY\b|STANDARD PLANS|DEMO STANDARD PLANS|OF|SCALE|TOTAL|POST MILES|DIST|COUNTY|ROUTE|PROJECT)\b/i;
/**
 * Plot-stamp, file-path, and registration-block vocabulary that the bottom
 * band carries alongside the real title — a title candidate containing any of
 * these is noise, not a sheet title (Caltrans-corpus eval).
 */
const STAMP_NOISE =
  /PLOTTED|USERNAME|DGN|FILENAME|PLANS APPROVAL|REGISTERED|CIVIL\b|\bEXP\b|LICENSE|CONTRACT/i;
/** Engineer signature names ("MELAKU A. ZELEKE", "JOHN P SMITH"). */
const PERSON_NAME = /^[A-Z]+\s+[A-Z]\.?\s+[A-Z]+$/;
/**
 * Real engineering sheet titles carry a drawing-domain noun; engineer names
 * and stamp fragments do not. Requiring one is the reliable discriminator
 * (Caltrans bands surface "JIN SHEN LOW" as a 3-word all-caps candidate that
 * is structurally indistinguishable from a title — only the vocabulary tells
 * them apart). A title we cannot confirm is dropped, never guessed.
 */
const TITLE_WORD =
  /\b(PLAN|PLANS|ELEVATION|ELEVATIONS|SECTION|SECTIONS|DETAIL|DETAILS|LAYOUT|GENERAL|TYPICAL|PROFILE|PROFILES|NOTES|QUANTITIES|SCHEDULE|SCHEDULES|BORINGS?|LOG|CONSTRUCTION|STAGE|DRAINAGE|UTILITY|UTILITIES|PAVING|PAVEMENT|GRADING|SIGNING|STRIPING|MARKINGS?|LIGHTING|ELECTRICAL|STRUCTURE|STRUCTURES|ABUTMENT|BENT|FOUNDATION|GIRDER|DECK|BARRIER|WALL|WALLS|ENDWALLS?|RAMP|ROADWAY|ALIGNMENT|CONTOURS?|EROSION|CONTROL|LANDSCAPE|IRRIGATION|INDEX|TITLE|KEY|SUMMARY|COVER|CULVERT|DRIVE|HEADWALL|JOINT|REINFORCEMENT|FRAMING|GEOMETRY|SURVEY)\b/;
/**
 * A bare sheet-number-shaped string is only a title block when drawing
 * labels corroborate it — "SW-846" in a spec-book footer must not mint a
 * drawing sheet (Caltrans-corpus eval false positive).
 */
const BAND_EVIDENCE = /\b(SHEET|REVISION|SCALE|DIST|COUNTY|ROUTE|POST MILES|INDEX|DRAWN|CHECKED)\b/i;

/** Nearest standalone integer to any anchor label, within reach. */
function nearestInteger(
  band: PositionedText[],
  anchors: PositionedText[],
  maxDistance: number,
): number | undefined {
  let best: number | undefined;
  let bestDist = Infinity;
  for (const t of band) {
    const m = t.str.trim().match(/^(\d{1,4})$/);
    if (!m) continue;
    for (const a of anchors) {
      const d = Math.hypot(t.x - a.x, t.y - a.y);
      if (d <= maxDistance && d < bestDist) {
        bestDist = d;
        best = Number(m[1]);
      }
    }
  }
  return best;
}

export function harvestTitleBlock(
  texts: PositionedText[],
  pageHeight: number,
): TitleBlock | undefined {
  const band = texts
    .filter((t) => t.y <= pageHeight * BAND && t.str.trim().length > 0)
    .sort((a, b) => b.y - a.y || a.x - b.x);
  if (band.length === 0) return undefined;
  const raw = band.map((t) => t.str.replace(/\s+/g, ' ').trim());
  const joined = raw.join(' ');

  const standaloneSheet = band.find((t) => SHORT_SHEET_SPAN.test(t.str.trim()));
  const sheetNumber =
    joined.match(DOT_INDEX)?.[1] ??
    joined.match(AIA_SHEET)?.[1] ??
    standaloneSheet?.str.trim().match(SHORT_SHEET_SPAN)?.[1];

  // "2 of 4" (FDOT) in the joined band, else Caltrans label proximity:
  // the integers nearest "SHEET No." and "TOTAL SHEETS" in page space —
  // the stamp ring scrambles the band's text order, positions don't lie.
  let sheetOf = joined.match(SHEET_OF) as { 1: string; 2: string } | null;
  let sheetIndex = sheetOf ? Number(sheetOf[1]) : undefined;
  let sheetTotal = sheetOf ? Number(sheetOf[2]) : undefined;
  if (sheetIndex === undefined) {
    const sheetLabels = band.filter((t) => /^SHEETS?$/i.test(t.str.trim()));
    const noLabels = band.filter(
      (t) =>
        /^No\.?$/i.test(t.str.trim()) &&
        sheetLabels.some((s) => Math.hypot(s.x - t.x, s.y - t.y) <= 60),
    );
    const totalLabels = band.filter(
      (t) =>
        /^SHEETS$/i.test(t.str.trim()) &&
        band.some(
          (o) => /^TOTAL$/i.test(o.str.trim()) && Math.hypot(o.x - t.x, o.y - t.y) <= 60,
        ),
    );
    sheetIndex = nearestInteger(band, noLabels, 50);
    sheetTotal = nearestInteger(band, totalLabels, 50);
    if (sheetIndex !== undefined || sheetTotal !== undefined) {
      sheetOf = { 1: String(sheetIndex ?? ''), 2: String(sheetTotal ?? '') };
    }
  }

  // Revision date: prefer dates near a REVISION label; reject plot stamps
  // (dates printed beside a time, e.g. "10/6/2022" next to "1:55:00 PM").
  let revision: string | undefined;
  let revisionScore = -Infinity;
  raw.forEach((s, i) => {
    const m = s.match(DATE);
    if (!m) return;
    const near = (j: number) => raw[j] ?? '';
    let score = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(raw.length - 1, i + 3); j++) {
      if (/\bREVISION\b/i.test(near(j))) score += 2;
    }
    if ([near(i - 1), s, near(i + 1)].some((n) => /\d{1,2}:\d{2}/.test(n))) score -= 3;
    if (score > revisionScore) {
      revision = m[1];
      revisionScore = score;
    }
  });

  // Title: the longest coherent uppercase multi-word string that is plausibly
  // a sheet title. A WRONG title is worse than none — it feeds the vision
  // model misinformation (Caltrans bands surface plot-stamp fragments like
  // "ME PLOTTED =>" and engineer names like "MELAKU A. ZELEKE"), so the gate
  // is strict and a missing title is the honest default.
  const title = raw
    .filter(
      (s) =>
        s.length >= 8 &&
        /\s/.test(s) &&
        !LABELS.test(s) &&
        !DATE.test(s) &&
        !STAMP_NOISE.test(s) && // plot stamps, file names, registration blocks
        !PERSON_NAME.test(s) && // engineer signatures
        !/[\d=^>]/.test(s) && // titles carry no digits, equals, carets, arrows
        s === s.toUpperCase() &&
        TITLE_WORD.test(s) && // must read like a sheet title, not a name
        // At least two real words (3+ letters each) — rejects char-fragment
        // joins like "TYPE 1, Typ | RAILING".
        (s.match(/\b[A-Z]{3,}\b/g)?.length ?? 0) >= 2,
    )
    .sort((a, b) => b.length - a.length)[0];

  // Require real title-block evidence — a lone "2 of 413" page footer on a
  // spec document, or a stray "SW-846" method number, must not masquerade
  // as a drawing title block.
  if (!sheetNumber && !(sheetOf && (revision || /\bSHEET\b/i.test(joined)))) {
    return undefined;
  }
  if (sheetNumber && sheetIndex === undefined && !BAND_EVIDENCE.test(joined)) {
    return undefined;
  }
  return {
    ...(sheetNumber ? { sheetNumber } : {}),
    ...(sheetIndex !== undefined ? { sheetIndex } : {}),
    ...(sheetTotal !== undefined ? { sheetTotal } : {}),
    ...(title ? { title } : {}),
    ...(revision ? { revision } : {}),
    raw,
  };
}

// ---------------------------------------------------------------------------
// Document-level extraction

export interface VectorOptions {
  /**
   * Extract text + reading order + title block for at most this many pages.
   * Defaults to the whole document — text extraction is cheap and every page
   * must be chunkable for deep retrieval (ADR 0006). The hard ceiling guards
   * against pathological page counts.
   */
  maxPages?: number;
  /**
   * Decode path primitives (operator-list walk — the expensive part) for at
   * most this many pages. Default 40: geometry/semantics on the opening
   * sheets, where they pay off, without walking 8k paths/page across a
   * 600-sheet set.
   */
  maxDecodePages?: number;
  /**
   * Decode path primitives (operator-list walk — the expensive part).
   * `'auto'` decodes page 1 and continues only when it looks like a drawing
   * sheet (title block found, or stroke density at drawing levels) — plan
   * sets get full geometry, 400-page spec books skip the walk.
   */
  decodeStrokes?: boolean | 'auto';
}

/** Hard ceiling on analyzed pages — generous, just a runaway guard. */
const MAX_PAGES_CEILING = 3000;
/** Default page budget for the expensive stroke/semantics decode. */
const DEFAULT_DECODE_PAGES = 40;

/**
 * The plans-vs-specs split in the probed corpora is clean: >2,000 paths/page
 * for drawing sets vs <150 for specs (vector-parsing plan, Evidence). 500
 * sits safely between.
 */
const DRAWING_MIN_STROKES = 500;

export async function extractVectorContent(
  data: Uint8Array,
  options: VectorOptions = {},
): Promise<VectorContent> {
  const maxDecodePages = options.maxDecodePages ?? DEFAULT_DECODE_PAGES;
  // pdf.js transfers (detaches) the ArrayBuffer it is handed, so the caller's
  // Uint8Array is left empty after this call. Parse a private copy: the same
  // file is read once and then handed to facts + rasterizer, and reusing one
  // shared buffer would otherwise throw DataCloneError on the second parse.
  const task = getDocument({ data: new Uint8Array(data), useSystemFonts: true, verbosity: 0 });
  try {
    const doc = await task.promise;

    // Layer table (tier 2) — leaf OCGs, walking nested per-DGN groups.
    const occ = await doc.getOptionalContentConfig();
    const leafIds: string[] = [];
    const walk = (entries: unknown[] | null | undefined): void => {
      for (const e of entries ?? []) {
        if (typeof e === 'string') leafIds.push(e);
        else if (e && typeof e === 'object' && 'order' in e) walk((e as { order: unknown[] }).order);
      }
    };
    walk(occ.getOrder?.());
    const layerNames = leafIds
      .map((id) => occ.getGroup?.(id)?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    const layers = layerNames.length > 0 ? [...new Set(layerNames)] : null;
    const resolveLayer = (id: string): string | undefined => occ.getGroup?.(id)?.name ?? undefined;

    const pages: VectorPage[] = [];
    let chars = 0;
    let strokeCount = 0;
    let decodedPages = 0;
    let attributionSeen = false;
    // If page 1 carries no marked content despite a layer table, the export
    // dropped per-primitive membership — stop paying for the operator walk.
    let probeAttribution = layers !== null;
    // 'auto': page 1 decides whether the rest of the document is worth it.
    let autoDecode = true;
    // Text for the whole document (chunkable, ADR 0006); strokes only for the
    // opening pages (expensive). Default text limit is the full doc.
    const pageLimit = Math.min(doc.numPages, options.maxPages ?? MAX_PAGES_CEILING);
    for (let p = 1; p <= pageLimit; p++) {
      const page = await doc.getPage(p);
      // Normalize every position through pdf.js's own viewport transform, which
      // folds in the view origin (a non-zero CropBox/MediaBox offset — pervasive
      // on large-format ARCH-E/civil sheets) AND the page /Rotate (90/180/270 —
      // pervasive on civil/structural sets). We re-flip to the y-up,
      // title-block-at-low-y convention the band/reading-order logic expects. A
      // 0-origin, unrotated page reduces to identity, so existing fixtures are
      // unaffected; without this, geometry-derived claims on offset or rotated
      // sheets land on the wrong axis/band with no test catching it.
      const viewport = page.getViewport({ scale: 1 });
      const width = viewport.width;
      const height = viewport.height;
      const vt = viewport.transform;
      const normPoint = (px: number, py: number): [number, number] => {
        const dx = vt[0] * px + vt[2] * py + vt[4];
        const dy = vt[1] * px + vt[3] * py + vt[5];
        // Viewport device space is y-down, top-left origin; flip back to y-up.
        return [dx, height - dy];
      };
      const normBbox = (
        b: [number, number, number, number],
      ): [number, number, number, number] => {
        const [ax, ay] = normPoint(b[0], b[1]);
        const [cx, cy] = normPoint(b[2], b[3]);
        return [Math.min(ax, cx), Math.min(ay, cy), Math.max(ax, cx), Math.max(ay, cy)];
      };

      // Operator-list walk only when needed (layer attribution or strokes)
      // and only within the decode budget — deep pages get text, not geometry.
      const decodeAllowed = p <= maxDecodePages;
      const wantStrokes =
        decodeAllowed &&
        (options.decodeStrokes === true || (options.decodeStrokes === 'auto' && autoDecode));
      let decoded: OpsDecodeResult | undefined;
      if (wantStrokes || (probeAttribution && decodeAllowed)) {
        decoded = decodeOperatorList(await page.getOperatorList(), resolveLayer);
        strokeCount += decoded.strokes.length;
        decodedPages += 1;
        if (decoded.markedContentLayers.some((l) => l !== null)) attributionSeen = true;
        else if (p === 1 && !wantStrokes) probeAttribution = false;
      }

      // Positioned text; layer attribution by correlating this stream's
      // marked-content events with the operator list's (same content stream,
      // same order — verified by fixture tests; on mismatch, layers are
      // honestly left unattributed).
      const tc = await page.getTextContent({ includeMarkedContent: decoded !== undefined });
      const texts: PositionedText[] = [];
      let mcIndex = 0;
      let currentLayer: string | undefined;
      let mcAligned = true;
      for (const item of tc.items as Array<Record<string, unknown>>) {
        if (typeof item.type === 'string') {
          const layer = decoded?.markedContentLayers[mcIndex];
          mcIndex += 1;
          if (layer === undefined) mcAligned = false;
          currentLayer = mcAligned ? (layer ?? undefined) : undefined;
          continue;
        }
        const str = item.str as string;
        if (typeof str !== 'string') continue;
        const tm = item.transform as number[];
        const [nx, ny] = normPoint(tm[4], tm[5]);
        texts.push({
          str,
          x: nx,
          y: ny,
          width: (item.width as number) ?? 0,
          height: (item.height as number) ?? 0,
          ...(currentLayer ? { layer: currentLayer } : {}),
        });
        chars += str.length;
      }
      if (decoded && mcIndex !== decoded.markedContentLayers.length) {
        // Streams disagreed — drop text-layer attribution rather than lie.
        for (const t of texts) delete t.layer;
      }

      // Normalize stroke geometry to the same view-relative, rotation-corrected
      // space as the text, so text↔stroke correlation (dimension labels next to
      // dimension lines, etc.) stays valid on offset/rotated sheets.
      const strokes = (decoded?.strokes ?? []).map((s) => ({ ...s, bbox: normBbox(s.bbox) }));

      const vectorPage: VectorPage = {
        pageNumber: p,
        width,
        height,
        texts,
        strokes,
        orderedText: orderTexts(texts),
        titleBlock: harvestTitleBlock(texts, height),
      };
      pages.push(vectorPage);
      if (p === 1 && options.decodeStrokes === 'auto') {
        autoDecode =
          vectorPage.titleBlock !== undefined ||
          (decoded?.strokes.length ?? 0) >= DRAWING_MIN_STROKES;
      }
    }

    const analyzed = pages.length || 1;
    return {
      pageCount: doc.numPages,
      pages,
      layers,
      capability: {
        hasTextLayer: chars >= MIN_CHARS_PER_PAGE * analyzed,
        layerTable: layers?.length ?? 0,
        layerAttribution: attributionSeen,
        charsPerPage: Math.round(chars / analyzed),
        strokesPerPage: decodedPages > 0 ? Math.round(strokeCount / decodedPages) : 0,
      },
    };
  } finally {
    await task.destroy();
  }
}
