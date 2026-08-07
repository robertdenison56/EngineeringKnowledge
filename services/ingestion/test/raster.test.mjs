import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { encodePng } from '../dist/raster/png.js';
import { Canvas, BLACK } from '../dist/raster/canvas.js';
import { loadPageModel, rasterize, renderSheetImages } from '../dist/raster/render.js';

const samples = join(import.meta.dirname, '..', 'samples');
const read = (name) => new Uint8Array(readFileSync(join(samples, name)));

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ── helpers for the /Rotate regression ──────────────────────────────────
 * The sample corpus is entirely /Rotate 0, which is exactly how a sideways
 * rasterizer stayed green for 97 tests. These build a rotated page in memory
 * (same no-library technique as scripts/make-sample-pdfs.mjs) and read the
 * pixels back out, so the fixture can't quietly drift back to unrotated.
 */

function buildPdf(objects) {
  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const obj = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    chunks.push(obj);
    offset += obj.length;
  });
  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

const SHEET_W = 400;
const SHEET_H = 200;

/**
 * A landscape sheet with a filled mark hard against user-space (0,0) and a
 * text run near the opposite corner. Both are needed: geometry and text take
 * different paths through rasterize(), and an asymmetric layout is what makes
 * a mirrored transform distinguishable from a rotated one.
 */
function markedSheet(rotate) {
  const body = Buffer.from(
    '0 0 0 rg\n0 0 60 60 re f\nBT\n/F1 18 Tf\n150 150 Td\n(SHEET A-501) Tj\nET\n',
    'latin1',
  );
  return new Uint8Array(
    buildPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${SHEET_W} ${SHEET_H}]` +
        `${rotate ? ` /Rotate ${rotate}` : ''}` +
        ' /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      Buffer.concat([
        Buffer.from(`<< /Length ${body.length} >>\nstream\n`, 'latin1'),
        body,
        Buffer.from('\nendstream', 'latin1'),
      ]),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]),
  );
}

/** Decode our own PNGs: truecolor, filter 0 on every scanline (png.ts). */
function decodePng(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat = [];
  let p = 8;
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString('latin1', p + 4, p + 8);
    if (type === 'IDAT') idat.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const rgb = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (stride + 1)], 0, 'png.ts writes filter type 0');
    raw.copy(rgb, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { width, height, rgb };
}

/** Fraction of each grid cell that carries ink. */
function inkDensity(image, cols, rows) {
  const { width, height, rgb } = decodePng(image.png);
  const counts = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (rgb[i] < 200 || rgb[i + 1] < 200 || rgb[i + 2] < 200) {
        counts[Math.min(rows - 1, ((y / height) * rows) | 0)][
          Math.min(cols - 1, ((x / width) * cols) | 0)
        ]++;
      }
    }
  }
  const cell = (width / cols) * (height / rows);
  return counts.map((row) => row.map((n) => n / cell));
}

/** Rotate a grid 90° counter-clockwise — what /Rotate 270 does to the sheet. */
function rotateGridCcw(grid) {
  const rows = grid.length;
  const cols = grid[0].length;
  return Array.from({ length: cols }, (_, r) =>
    Array.from({ length: rows }, (_, c) => grid[c][cols - 1 - r]),
  );
}

test('PNG encoder writes a valid signature and IHDR dimensions', () => {
  const rgb = new Uint8Array(4 * 3 * 3).fill(255); // 4x3 white
  const png = encodePng(rgb, 4, 3);
  assert.ok(png.subarray(0, 8).equals(PNG_SIG), 'PNG signature');
  // IHDR width/height at bytes 16-23.
  assert.equal(png.readUInt32BE(16), 4);
  assert.equal(png.readUInt32BE(20), 3);
});

test('canvas: blank is white; drawing ink reduces brightness', () => {
  const blank = new Canvas(40, 20, 2).toRGB();
  assert.ok([...blank].every((v) => v === 255), 'blank canvas is pure white');

  const c = new Canvas(120, 24, 2);
  c.text(2, 2, 'A1-B2', 14, BLACK);
  c.line(0, 22, 120, 22, BLACK, 2);
  const rgb = c.toRGB();
  const dark = [...rgb].filter((v) => v < 128).length;
  assert.ok(dark > 50, `expected ink pixels, got ${dark}`);
});

test('rasterize: own renderer produces a PNG with real geometry+text (no poppler)', async () => {
  const model = await loadPageModel(read('C-102 Drainage Plan (callouts).pdf'), 1);
  assert.ok(model.texts.length > 0, 'page model carries positioned text');
  const img = rasterize(model, { dpi: 100 });
  assert.ok(img.png.subarray(0, 8).equals(PNG_SIG), 'valid PNG');
  assert.ok(img.width > 100 && img.height > 100, 'sized to the page');
  // The rendered sheet must contain dark (inked) pixels — not a blank page.
  const png = img.png;
  assert.ok(png.length > 1000, 'non-trivial PNG');
});

test('renderSheetImages: overview + 4 tiles from a single page parse', async () => {
  const images = await renderSheetImages(read('C-102 Drainage Plan (callouts).pdf'), 1, {
    overviewDpi: 90,
    tileDpi: 140,
  });
  assert.equal(images.length, 5, 'overview + 4 quadrant tiles');
  assert.match(images[0].label, /overview/);
  assert.match(images[4].label, /tile 4\/4/);
  assert.ok(images.every((i) => i.png.subarray(0, 8).equals(PNG_SIG)));
  // Tiles are higher-DPI crops, so each is a reasonable size.
  assert.ok(images[1].width > 0 && images[1].height > 0);
});

test('crop renders only its region (tiling)', async () => {
  const model = await loadPageModel(read('C-102 Drainage Plan (callouts).pdf'), 1);
  const full = rasterize(model, { dpi: 72 });
  const quad = rasterize(model, { dpi: 72, crop: [0, 0, model.pageWidth / 2, model.pageHeight / 2] });
  assert.ok(Math.abs(quad.width - full.width / 2) <= 2, 'crop half width');
  assert.ok(Math.abs(quad.height - full.height / 2) <= 2, 'crop half height');
});

test('/Rotate swaps the model’s display dimensions', async () => {
  const flat = await loadPageModel(markedSheet(0), 1);
  assert.equal(flat.rotate, 0);
  assert.deepEqual([flat.pageWidth, flat.pageHeight], [SHEET_W, SHEET_H]);

  for (const rotate of [90, 270]) {
    const turned = await loadPageModel(markedSheet(rotate), 1);
    assert.equal(turned.rotate, rotate);
    assert.deepEqual(
      [turned.pageWidth, turned.pageHeight],
      [SHEET_H, SHEET_W],
      `/Rotate ${rotate} presents the sheet portrait`,
    );
    // The unrotated view is still reported, for provenance.
    assert.deepEqual(turned.view, [0, 0, SHEET_W, SHEET_H]);
  }
});

test('/Rotate 270 renders the sheet upright, not sideways', async () => {
  // A mark at user-space (0,0) sits bottom-left of the *unrotated* page. PDF
  // /Rotate 270 turns the sheet 270° clockwise for display, so that corner
  // must arrive bottom-RIGHT. Before this was honored, both renders were
  // byte-identical and this corner never moved.
  const flat = rasterize(await loadPageModel(markedSheet(0), 1), { dpi: 72 });
  const turned = rasterize(await loadPageModel(markedSheet(270), 1), { dpi: 72 });

  assert.ok(Math.abs(turned.width - flat.height) <= 2, 'output is dimension-swapped');
  assert.ok(Math.abs(turned.height - flat.width) <= 2, 'output is dimension-swapped');

  // Locate the solid 60pt mark by ink density — it far outweighs the text run,
  // so this stays stable without depending on the glyph metrics.
  const markCell = (image) => {
    const g = inkDensity(image, 4, 4);
    let best = [0, 0];
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++) if (g[r][c] > g[best[0]][best[1]]) best = [r, c];
    return best;
  };
  assert.deepEqual(markCell(flat), [3, 0], 'unrotated: mark bottom-left');
  assert.deepEqual(markCell(turned), [3, 3], 'rotated 270°: mark bottom-right');
});

test('/Rotate 270 output is the flat render turned, geometry and text alike', async () => {
  // Stronger than the corner check: every cell's ink has to land where a 90°
  // counter-clockwise turn of the flat sheet puts it. Catches a transform that
  // reaches the right corner by mirroring rather than rotating, and covers the
  // text path — glyphs are placed by a separate branch of rasterize().
  const flat = rasterize(await loadPageModel(markedSheet(0), 1), { dpi: 96 });
  const turned = rasterize(await loadPageModel(markedSheet(270), 1), { dpi: 96 });

  const expected = rotateGridCcw(inkDensity(flat, 12, 6));
  const actual = inkDensity(turned, 6, 12);

  // Glyphs rasterized at 90° are not pixel-identical to the same glyphs at 0°,
  // so compare densities with a tolerance rather than booleans. Measured: a
  // correct transform deviates at most 0.032 per cell, while an un-turned grid
  // (the bug this guards) deviates 0.98 — a 30x margin either way.
  let worst = 0;
  let worstAt = null;
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 6; c++) {
      const delta = Math.abs(actual[r][c] - expected[r][c]);
      if (delta > worst) {
        worst = delta;
        worstAt = `[${r}][${c}] ${actual[r][c].toFixed(3)} vs ${expected[r][c].toFixed(3)}`;
      }
    }
  }
  assert.ok(worst <= 0.1, `rotated ink should match the turned flat grid; worst cell ${worstAt}`);
});

test('the rotated sheet actually draws its text, in the turned half', async () => {
  // The grid comparison above is flat-vs-turned, so anything that removes ink
  // from BOTH renders equally cancels out — deleting canvas.text() outright
  // left it green. This pins the text down on its own.
  const model = await loadPageModel(markedSheet(0), 1);
  assert.ok(model.texts.length > 0, 'the fixture carries a text run at all');

  // The 60pt mark sits in the bottom-left of the flat sheet, so any ink in the
  // top half is the text run and nothing else.
  const flat = rasterize(model, { dpi: 96 });
  const flatTop = inkDensity(flat, 1, 2)[0][0];
  assert.ok(flatTop > 0, `flat sheet renders text above the mark (got ${flatTop})`);

  // /Rotate 270 turns the sheet 90° counter-clockwise, so that top strip
  // becomes the LEFT half — which is also the half the mark is not in.
  const turned = rasterize(await loadPageModel(markedSheet(270), 1), { dpi: 96 });
  const turnedLeft = inkDensity(turned, 2, 1)[0][0];
  assert.ok(turnedLeft > 0, `rotated sheet renders that text on the left (got ${turnedLeft})`);
});

test('an unrotated page is unaffected by the rotation path', async () => {
  // The viewport transform on a /Rotate 0 page is [1,0,0,-1,-x0,y1], which
  // reduces the mapping to the original formula — same pixels, same tiling.
  const model = await loadPageModel(read('C-102 Drainage Plan (callouts).pdf'), 1);
  assert.equal(model.rotate, 0);
  assert.deepEqual(model.transform, [1, 0, 0, -1, 0, 792]);
  assert.deepEqual(
    [model.pageWidth, model.pageHeight],
    [model.view[2] - model.view[0], model.view[3] - model.view[1]],
    'display dimensions equal the view for an unrotated page',
  );
});
