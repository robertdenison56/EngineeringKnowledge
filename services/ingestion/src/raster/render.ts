import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { Canvas, type RGB } from './canvas.js';

/**
 * Own-code page rasterizer (ADR 0009) — replaces poppler/pdftoppm. Renders a
 * PDF page from the same pdf.js primitives the parser already consumes: the
 * operator list (faithful path geometry) and the positioned text stream
 * (drawn fragment-by-fragment, which visually reassembles strings even where
 * our string-assembly fails). No external binary, no native module — pure JS
 * plus node:zlib for PNG.
 *
 * Engineering-drawing tuned: pure-white background, mid-gray linework with a
 * minimum stroke width so hairlines survive, and pure-black annotation text
 * in a clean fixed font (a contrast hierarchy so dense linework never drowns
 * the text the vision model reads). Resolution-independent — any DPI from one
 * vector source. The page is parsed ONCE; overview + tiles re-rasterize the
 * same primitives.
 */

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (m: Matrix, n: Matrix): Matrix => [
  n[0] * m[0] + n[1] * m[2],
  n[0] * m[1] + n[1] * m[3],
  n[2] * m[0] + n[3] * m[2],
  n[2] * m[1] + n[3] * m[3],
  n[4] * m[0] + n[5] * m[2] + m[4],
  n[4] * m[1] + n[5] * m[3] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

const PATH_COORDS: Record<number, number> = { 0: 2, 1: 2, 2: 6, 4: 0 };
// Contrast hierarchy: geometry in mid gray, annotation text pure black.
const INK: RGB = [95, 95, 95];
const FILL: RGB = [175, 175, 175];
const TEXT: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];

/** Page primitives, fetched once and re-rasterized for overview + tiles. */
export interface PageModel {
  view: [number, number, number, number];
  pageWidth: number;
  pageHeight: number;
  fnArray: number[];
  argsArray: unknown[];
  texts: Array<{ str: string; transform: number[]; height: number }>;
}

export interface RasterOptions {
  dpi?: number;
  /** Crop in page points [x, y, w, h] (bottom-left origin) for tiling. */
  crop?: [number, number, number, number];
  supersample?: number;
}

export interface SheetImage {
  label: string;
  png: Buffer;
  width: number;
  height: number;
}

function bezier(
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const n = 10;
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    ]);
  }
  return out;
}

/** Fetch a page's geometry + text once (one getDocument per call). */
export async function loadPageModel(data: Uint8Array, pageNumber: number): Promise<PageModel> {
  const task = getDocument({ data, useSystemFonts: true, verbosity: 0 });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(pageNumber);
    const view = page.view as [number, number, number, number];
    const opList = await page.getOperatorList();
    const tc = await page.getTextContent();
    const texts = (tc.items as Array<Record<string, unknown>>)
      .filter((it) => typeof it.str === 'string' && (it.str as string).trim().length > 0)
      .map((it) => ({ str: it.str as string, transform: it.transform as number[], height: (it.height as number) ?? 6 }));
    return {
      view,
      pageWidth: view[2] - view[0],
      pageHeight: view[3] - view[1],
      fnArray: Array.from(opList.fnArray),
      argsArray: opList.argsArray,
      texts,
    };
  } finally {
    await task.destroy();
  }
}

/** Rasterize the page model (or a crop of it) to a PNG. */
export function rasterize(model: PageModel, options: RasterOptions = {}): SheetImage {
  const dpi = options.dpi ?? 150;
  const scale = dpi / 72;
  const [vx0, vy0] = model.view;
  const [cx, cy, cw, ch] = options.crop ?? [0, 0, model.pageWidth, model.pageHeight];
  const canvas = new Canvas(cw * scale, ch * scale, options.supersample ?? 3);
  const toDevice = (px: number, py: number): [number, number] => [
    (px - vx0 - cx) * scale,
    (ch - (py - vy0 - cy)) * scale,
  ];

  const ctmStack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  let lineWidth = 1;
  for (let i = 0; i < model.fnArray.length; i++) {
    const fn = model.fnArray[i];
    const args = model.argsArray[i] as unknown[];
    if (fn === OPS.save) ctmStack.push(ctm);
    else if (fn === OPS.restore) ctm = ctmStack.pop() ?? IDENTITY;
    else if (fn === OPS.transform) ctm = mul(ctm, args as unknown as Matrix);
    else if (fn === OPS.setLineWidth) lineWidth = args[0] as number;
    else if (fn === OPS.constructPath) {
      const [renderOp, pathData] = args as [number, ArrayLike<number>[]];
      const d = pathData?.[0];
      if (!d || d.length === 0) continue;
      const filled =
        renderOp === OPS.fill || renderOp === OPS.eoFill ||
        renderOp === OPS.fillStroke || renderOp === OPS.eoFillStroke;
      const pageOf = (x: number, y: number): [number, number] => apply(ctm, x, y);
      const w = Math.max(0.7, lineWidth * scale * 0.5);
      const draw = (a: [number, number], b: [number, number]) => {
        const da = toDevice(a[0], a[1]);
        const db = toDevice(b[0], b[1]);
        canvas.line(da[0], da[1], db[0], db[1], INK, w);
      };
      let cur: [number, number] | null = null;
      let start: [number, number] | null = null;
      const poly: Array<[number, number]> = [];
      for (let p = 0; p < d.length; ) {
        const op = d[p];
        const nc = PATH_COORDS[op];
        if (nc === undefined) break;
        if (op === 0) {
          cur = pageOf(d[p + 1], d[p + 2]); start = cur; if (filled) poly.push(cur);
        } else if (op === 1) {
          const next = pageOf(d[p + 1], d[p + 2]);
          if (cur && !filled) draw(cur, next);
          if (filled) poly.push(next);
          cur = next;
        } else if (op === 2) {
          if (cur) {
            const c1 = pageOf(d[p + 1], d[p + 2]);
            const c2 = pageOf(d[p + 3], d[p + 4]);
            const end = pageOf(d[p + 5], d[p + 6] as number);
            const pts = bezier(cur[0], cur[1], c1[0], c1[1], c2[0], c2[1], end[0], end[1]);
            let prev = cur;
            for (const pt of pts) { if (!filled) draw(prev, pt); if (filled) poly.push(pt); prev = pt; }
            cur = end;
          }
        } else if (op === 4) {
          if (cur && start && !filled) draw(cur, start);
          cur = start;
        }
        p += 1 + nc;
      }
      if (filled && poly.length >= 3) canvas.fillPolygon(poly.map(([px, py]) => toDevice(px, py)), FILL);
    }
  }

  // Positioned text: each fragment at its matrix position/size/rotation, in
  // target-pixel coords (consistent with line drawing). A white halo behind
  // each fragment lifts the annotation off the linework so the vision model
  // reads it cleanly (engineering-drawing tuning, ADR 0009).
  for (const item of model.texts) {
    const tm = item.transform;
    const size = Math.hypot(tm[2], tm[3]) || item.height || 6;
    const sizePx = size * scale;
    const angle = Math.atan2(tm[1], tm[0]);
    const [dx, dy] = toDevice(tm[4], tm[5]);
    // Halo only for near-horizontal text (axis-aligned rect); rotated dims
    // skip it to avoid covering geometry at the wrong angle.
    if (Math.abs(angle) < 0.05 || Math.abs(Math.abs(angle) - Math.PI) < 0.05) {
      const wPx = item.str.length * sizePx * 0.62;
      canvas.rect(dx - sizePx * 0.1, dy - sizePx * 1.05, wPx, sizePx * 1.2, WHITE);
    }
    canvas.text(dx, dy - sizePx, item.str, sizePx, TEXT, -angle);
  }

  return { label: '', png: canvas.toPng(), width: canvas.w, height: canvas.h };
}

/**
 * Render a sheet for vision: a full-page overview plus 300-DPI quadrant tiles
 * (the resolutions the describe spike validated), all from one page parse.
 */
export async function renderSheetImages(
  data: Uint8Array,
  pageNumber: number,
  options: { overviewDpi?: number; tileDpi?: number; tiles?: boolean } = {},
): Promise<SheetImage[]> {
  return renderModelImages(await loadPageModel(data, pageNumber), pageNumber, options);
}

/** True when the page carries vector text/geometry our renderer can draw. */
export function hasVectorContent(model: PageModel): boolean {
  return model.texts.length > 0 || model.fnArray.filter((f) => f === OPS.constructPath).length > 20;
}

/** Render overview + tiles from an already-loaded page model. */
export function renderModelImages(
  model: PageModel,
  pageNumber: number,
  options: { overviewDpi?: number; tileDpi?: number; tiles?: boolean } = {},
): SheetImage[] {
  const overviewDpi = options.overviewDpi ?? 150;
  const tileDpi = options.tileDpi ?? 300;
  const images: SheetImage[] = [];

  const overview = rasterize(model, { dpi: overviewDpi });
  images.push({ ...overview, label: `page ${pageNumber} overview (${overviewDpi} DPI)` });

  if (options.tiles ?? true) {
    const hw = model.pageWidth / 2;
    const hh = model.pageHeight / 2;
    const quads: Array<[number, number]> = [[0, hh], [hw, hh], [0, 0], [hw, 0]];
    quads.forEach(([cx, cy], i) => {
      const tile = rasterize(model, { dpi: tileDpi, crop: [cx, cy, hw, hh] });
      images.push({ ...tile, label: `page ${pageNumber} tile ${i + 1}/4 (${tileDpi} DPI)` });
    });
  }
  return images;
}
