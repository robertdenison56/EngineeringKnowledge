import { encodePng } from './png.js';
import { foldText, glyph, GLYPH_W, GLYPH_H } from './font.js';

/**
 * Tiny software canvas (own code, ADR 0009). Draws aliased at a supersample
 * factor and box-downsamples on export, so lines and text come out
 * anti-aliased without per-pixel coverage math. RGB only — enough to render
 * engineering linework, annotation text, and the semantic color emphasis the
 * parser enables.
 */

export type RGB = [number, number, number];
export const BLACK: RGB = [0, 0, 0];

export class Canvas {
  readonly w: number;
  readonly h: number;
  private readonly ss: number;
  private readonly sw: number;
  private readonly sh: number;
  private readonly buf: Uint8Array; // supersampled RGB

  constructor(width: number, height: number, supersample = 3) {
    this.w = Math.max(1, Math.round(width));
    this.h = Math.max(1, Math.round(height));
    this.ss = supersample;
    this.sw = this.w * this.ss;
    this.sh = this.h * this.ss;
    this.buf = new Uint8Array(this.sw * this.sh * 3).fill(255); // white
  }

  private px(x: number, y: number, c: RGB): void {
    if (x < 0 || y < 0 || x >= this.sw || y >= this.sh) return;
    const i = (y * this.sw + x) * 3;
    this.buf[i] = c[0];
    this.buf[i + 1] = c[1];
    this.buf[i + 2] = c[2];
  }

  /** Stroke a segment in page→pixel coords with a given device line width. */
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, width = 1): void {
    const s = this.ss;
    const ax = x0 * s, ay = y0 * s, bx = x1 * s, by = y1 * s;
    const half = Math.max(s * 0.5, (width * s) / 2);
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const steps = Math.ceil(len);
    const r = Math.ceil(half);
    for (let i = 0; i <= steps; i++) {
      const x = ax + (dx * i) / steps;
      const y = ay + (dy * i) / steps;
      // Stamp a filled disc of radius `half` for thickness.
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          if (ox * ox + oy * oy <= half * half) this.px(Math.round(x) + ox, Math.round(y) + oy, c);
        }
      }
    }
  }

  /** Fill an axis-aligned rectangle (target-px coords). */
  rect(x: number, y: number, w: number, h: number, c: RGB): void {
    const s = this.ss;
    const x0 = Math.round(x * s), y0 = Math.round(y * s);
    const x1 = Math.round((x + w) * s), y1 = Math.round((y + h) * s);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.px(xx, yy, c);
  }

  /** Solid scanline fill of a closed polygon (page→pixel coords). */
  fillPolygon(pts: Array<[number, number]>, c: RGB): void {
    if (pts.length < 3) return;
    const s = this.ss;
    const ys = pts.map((p) => p[1] * s);
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const bot = Math.min(this.sh - 1, Math.ceil(Math.max(...ys)));
    for (let y = top; y <= bot; y++) {
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = [pts[i][0] * s, pts[i][1] * s];
        const [x2, y2] = [pts[(i + 1) % pts.length][0] * s, pts[(i + 1) % pts.length][1] * s];
        if (y1 === y2) continue;
        if (y >= Math.min(y1, y2) && y < Math.max(y1, y2)) {
          xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.floor(xs[k]); x <= Math.ceil(xs[k + 1]); x++) this.px(x, y, c);
      }
    }
  }

  /**
   * Stamp text with its TOP-LEFT at page-coords (x, y), glyph cell `size` px
   * tall. `rotation` in radians (0 = horizontal; CAD dimension text is often
   * ±90°). `weight` (>=1) thickens glyph pixels for annotation emphasis.
   */
  text(x: number, y: number, str: string, size: number, c: RGB, rotation = 0, weight = 1): void {
    const s = this.ss;
    const cell = Math.max(1, (size * s) / GLYPH_H); // device px per glyph pixel
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    const bx = x * s, by = y * s;
    const grow = Math.max(1, Math.round(cell * weight));
    let penX = 0; // advance along the text direction, in device px
    for (const ch of foldText(str)) {
      const g = glyph(ch.codePointAt(0) ?? 0x20);
      for (let row = 0; row < GLYPH_H; row++) {
        for (let col = 0; col < GLYPH_W; col++) {
          if (!(g[row] & (1 << col))) continue;
          const lx = penX + col * cell; // glyph-local device px (top-left origin)
          const ly = row * cell;
          const ox = bx + lx * cos - ly * sin;
          const oy = by + lx * sin + ly * cos;
          for (let dy = 0; dy < grow; dy++)
            for (let dx = 0; dx < grow; dx++) this.px(Math.round(ox + dx), Math.round(oy + dy), c);
        }
      }
      penX += GLYPH_W * cell; // 8-px advance (glyph is 7 wide + 1 spacing)
    }
  }

  /** Box-downsample the supersampled buffer to the target size. */
  toRGB(): Uint8Array {
    const s = this.ss;
    if (s === 1) return this.buf;
    const out = new Uint8Array(this.w * this.h * 3);
    const n = s * s;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        let r = 0, g = 0, b = 0;
        for (let oy = 0; oy < s; oy++) {
          for (let ox = 0; ox < s; ox++) {
            const i = ((y * s + oy) * this.sw + (x * s + ox)) * 3;
            r += this.buf[i];
            g += this.buf[i + 1];
            b += this.buf[i + 2];
          }
        }
        const o = (y * this.w + x) * 3;
        out[o] = (r / n) | 0;
        out[o + 1] = (g / n) | 0;
        out[o + 2] = (b / n) | 0;
      }
    }
    return out;
  }

  toPng(): Buffer {
    return encodePng(this.toRGB(), this.w, this.h);
  }
}
