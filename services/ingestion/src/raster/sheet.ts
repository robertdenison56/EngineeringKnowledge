import { readFileSync } from 'node:fs';
import { rasterizeSheet, rasterizerAvailable, type SheetImage as PopplerImage } from '../raster.js';
import { hasVectorContent, loadPageModel, renderModelImages, type SheetImage } from './render.js';

/**
 * Rasterize a sheet for the vision describe flow (ADR 0009). Prefers the
 * own-code vector renderer — no external binary, works out of the box — and
 * falls back to poppler ONLY for pages with no vector content (true scans /
 * image-only sheets) that our renderer cannot draw. The gateway no longer
 * *requires* poppler; it is an optional fidelity fallback when present.
 */

export interface SheetRasterResult {
  images: Array<{ label: string; png: Buffer }>;
  engine: 'vector' | 'poppler' | 'none';
  note?: string;
}

export async function rasterizeSheetForVision(
  filePath: string,
  page = 1,
  options: { overviewDpi?: number; tileDpi?: number } = {},
): Promise<SheetRasterResult> {
  const data = new Uint8Array(readFileSync(filePath));

  let model;
  try {
    model = await loadPageModel(data, page);
  } catch {
    model = undefined;
  }

  if (model && hasVectorContent(model)) {
    const images: SheetImage[] = renderModelImages(model, page, options);
    return { images, engine: 'vector' };
  }

  // Image-only / scanned page — our vector renderer has nothing to draw.
  if (rasterizerAvailable()) {
    const images: PopplerImage[] = rasterizeSheet(filePath, { page });
    return { images, engine: 'poppler' };
  }
  return {
    images: [],
    engine: 'none',
    note: 'Page has no vector content (likely a scan) and poppler is not installed for the raster fallback.',
  };
}
