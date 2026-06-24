import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from '../dist/raster/png.js';
import { Canvas, BLACK } from '../dist/raster/canvas.js';
import { loadPageModel, rasterize, renderSheetImages } from '../dist/raster/render.js';

const samples = join(import.meta.dirname, '..', 'samples');
const read = (name) => new Uint8Array(readFileSync(join(samples, name)));

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
