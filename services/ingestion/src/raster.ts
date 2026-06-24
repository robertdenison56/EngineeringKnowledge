import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Drawing-sheet rasterization via poppler's pdftoppm (ADR 0005). An external
 * binary rather than an npm dependency: poppler is battle-tested on
 * large-format sheets, and when it is absent we degrade honestly (no images,
 * candidate still queued) instead of failing ingestion.
 */

export interface SheetImage {
  /** e.g. "page 1 overview (150 DPI)" or "page 1 tile 2/4 (300 DPI)". */
  label: string;
  png: Buffer;
}

export function rasterizerAvailable(): boolean {
  return spawnSync('pdftoppm', ['-v']).error === undefined;
}

function run(args: string[], pdfPath: string, outDir: string): Buffer[] {
  const result = spawnSync('pdftoppm', [...args, pdfPath, join(outDir, 'out')]);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pdftoppm exited ${result.status}: ${result.stderr?.toString().slice(0, 200)}`);
  }
  return readdirSync(outDir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => readFileSync(join(outDir, f)));
}

/** Width/height from a PNG's IHDR header — avoids an image-library dependency. */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Rasterize one page: a full-page overview, plus 300-DPI quadrant tiles so
 * small annotation text stays legible to a vision model (the resolutions
 * validated in the OQ 8 drawing-description spike).
 */
export function rasterizeSheet(
  pdfPath: string,
  options: { page?: number; overviewDpi?: number; tileDpi?: number; tiles?: boolean } = {},
): SheetImage[] {
  const page = options.page ?? 1;
  const overviewDpi = options.overviewDpi ?? 150;
  const tileDpi = options.tileDpi ?? 300;
  const pageArgs = ['-png', '-f', String(page), '-l', String(page)];

  const images: SheetImage[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'ekg-raster-'));
  try {
    const [overview] = run([...pageArgs, '-r', String(overviewDpi)], pdfPath, dir);
    if (!overview) throw new Error(`page ${page} produced no image`);
    images.push({ label: `page ${page} overview (${overviewDpi} DPI)`, png: overview });

    if (options.tiles ?? true) {
      // Tile dimensions in tile-DPI pixels, derived from the overview's size.
      const scale = tileDpi / overviewDpi;
      const { width, height } = pngSize(overview);
      const w = Math.ceil((width * scale) / 2);
      const h = Math.ceil((height * scale) / 2);
      let n = 0;
      for (const y of [0, h]) {
        for (const x of [0, w]) {
          n += 1;
          const tileDir = mkdtempSync(join(tmpdir(), 'ekg-raster-tile-'));
          try {
            const [tile] = run(
              [...pageArgs, '-r', String(tileDpi), '-x', String(x), '-y', String(y), '-W', String(w), '-H', String(h)],
              pdfPath,
              tileDir,
            );
            if (tile) images.push({ label: `page ${page} tile ${n}/4 (${tileDpi} DPI)`, png: tile });
          } finally {
            rmSync(tileDir, { recursive: true, force: true });
          }
        }
      }
    }
    return images;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
