import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rasterizeSheet, rasterizerAvailable } from './raster.js';

/**
 * OCR for image-only PDFs — the consumer of ADR 0004's `needs-ocr` flag, which
 * until now nothing acted on. A scanned sheet carries no text layer and no
 * vector geometry, so the describe flow handed the vision model pixels with
 * NOTHING to ground its reading against: every quoted dimension came back
 * `groundable: false` (ground.ts). OCR recovers a text layer from the raster so
 * those quotes can be checked, and the document becomes searchable besides.
 *
 * Engine posture mirrors poppler (raster.ts): no hard npm dependency, honest
 * degradation. We prefer tesseract.js (pure JS/WASM) when it is installed, fall
 * back to a system `tesseract` binary when present, and when neither is there a
 * scan simply stays `needs-ocr` — never fabricated text. Enable OCR by either
 * `npm i tesseract.js` in the ingestion service or installing the tesseract CLI.
 */

export type OcrEngineName = 'tesseract.js' | 'tesseract-cli' | 'injected';

export interface OcrResult {
  text: string;
  /** Mean per-word confidence (0–100) when the engine reports it. */
  confidence?: number;
  engine: OcrEngineName;
}

/**
 * Recover text from one page of a PDF. `null` when the page yielded nothing
 * legible. Injectable so the pipeline can be tested without a real OCR engine.
 */
export type PageOcr = (filePath: string, page: number) => Promise<OcrResult | null>;

/** A rendered page must yield at least this much text to count as recovered. */
const MIN_OCR_CHARS = 16;
/** DPI for the OCR raster — higher than the vision overview; OCR needs detail. */
const OCR_DPI = 300;
/** Default page budget — OCR is seconds/page; bound it, report truncation. */
const DEFAULT_MAX_OCR_PAGES = 10;
/**
 * Mean per-word confidence (0–100) below which an OCR page is flagged for
 * curator review (PRD P0-2a: "pages below the confidence threshold are flagged
 * for human review"). Tuned for tesseract's per-word confidence — clean scans
 * report 85–95, marginal/rotated/large-format scans drop well below this.
 */
export const OCR_CONFIDENCE_THRESHOLD = 70;

// ---------------------------------------------------------------------------
// PNG-level engines (resolved once, cached)

type PngOcr = (png: Buffer) => Promise<OcrResult>;

async function tesseractJsEngine(): Promise<PngOcr | null> {
  try {
    // Optional dependency: a variable specifier keeps tsc from resolving types
    // for a package that is intentionally absent from package.json. The
    // webpackIgnore hint keeps Next from trying to bundle this heavy optional
    // WASM engine into the web app — it stays a runtime-only import.
    const spec = 'tesseract.js';
    const mod = (await import(/* webpackIgnore: true */ spec)) as {
      recognize: (image: Buffer, lang: string) => Promise<{ data: { text?: string; confidence?: number } }>;
    };
    return async (png) => {
      const { data } = await mod.recognize(png, 'eng');
      return {
        text: typeof data?.text === 'string' ? data.text : '',
        ...(typeof data?.confidence === 'number' ? { confidence: data.confidence } : {}),
        engine: 'tesseract.js',
      };
    };
  } catch {
    return null; // not installed
  }
}

function tesseractCliEngine(): PngOcr | null {
  if (spawnSync('tesseract', ['--version']).error !== undefined) return null;
  return async (png) => {
    const dir = mkdtempSync(join(tmpdir(), 'ekg-ocr-'));
    try {
      const inPath = join(dir, 'page.png');
      writeFileSync(inPath, png);
      const res = spawnSync('tesseract', [inPath, 'stdout', '-l', 'eng']);
      if (res.error) throw res.error;
      if (res.status !== 0) {
        throw new Error(`tesseract exited ${res.status}: ${res.stderr?.toString().slice(0, 200)}`);
      }
      return { text: res.stdout?.toString() ?? '', engine: 'tesseract-cli' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

let pngEngine: PngOcr | null | undefined;
async function resolvePngOcr(): Promise<PngOcr | null> {
  if (pngEngine !== undefined) return pngEngine;
  pngEngine = (await tesseractJsEngine()) ?? tesseractCliEngine();
  return pngEngine;
}

/**
 * True when OCR is actually runnable here: some OCR engine AND a rasterizer for
 * scans (poppler) are both present. Lets callers report the capability honestly
 * before ingesting.
 */
export async function ocrAvailable(): Promise<boolean> {
  return rasterizerAvailable() && (await resolvePngOcr()) !== null;
}

// ---------------------------------------------------------------------------
// Page-level OCR (rasterize → recognize)

/**
 * The default page OCR: rasterize the scanned page (poppler full-page at OCR
 * DPI) then recognize it. Returns null — so the caller keeps `needs-ocr` — when
 * no engine/rasterizer is available or the page yielded nothing legible.
 */
export async function createPageOcr(): Promise<PageOcr | null> {
  if (!rasterizerAvailable()) return null;
  const recognize = await resolvePngOcr();
  if (!recognize) return null;
  return async (filePath, page) => {
    const [image] = rasterizeSheet(filePath, { page, tiles: false, overviewDpi: OCR_DPI });
    if (!image) return null;
    const result = await recognize(image.png);
    const text = result.text.replace(/\s+/g, ' ').trim();
    return text.length >= MIN_OCR_CHARS ? { ...result, text } : null;
  };
}

/** One OCR-recovered page, kept page-anchored so a hit still cites the page. */
export interface OcrPage {
  pageNumber: number;
  text: string;
  /** Mean per-word confidence (0–100) when the engine reported it. */
  confidence?: number;
}

export interface OcrPagesResult {
  pages: OcrPage[];
  engine?: OcrEngineName;
  /** True when the document had more pages than the OCR budget allowed. */
  truncated: boolean;
  /**
   * 1-based page numbers whose confidence fell below OCR_CONFIDENCE_THRESHOLD —
   * recovered, but flagged for human review (P0-2a). Empty when no page reported
   * a confidence (engine can't score) or every page cleared the bar.
   */
  lowConfidencePages: number[];
  /** Mean confidence across pages that reported one; undefined if none did. */
  meanConfidence?: number;
}

/**
 * OCR provenance persisted on an OCR-extracted entity at
 * `entity.properties.ocr`. Lets the curation workbench flag machine-read text
 * for review (P0-2a) and lets retrieval/curators weight it below born-digital
 * text — never silently promoted to verified.
 */
export interface OcrMeta {
  engine?: OcrEngineName;
  /** Pages that yielded text. */
  pages: number;
  /** Mean per-word confidence across pages that reported one (0–100). */
  meanConfidence?: number;
  /** Page numbers that came back below the review threshold. */
  lowConfidencePages?: number[];
  /**
   * True when a human must review before this text is trusted — some page came
   * back low-confidence, or no page reported a confidence at all (so quality
   * could not be measured). The entity is `unverified` regardless; this records
   * WHY a curator should look closely.
   */
  needsReview: boolean;
  /** True when the document exceeded the OCR page budget. */
  truncated?: boolean;
}

/**
 * OCR up to a page budget, collecting per-page text (so chunks keep their page
 * anchors for citation) and per-page confidence (so low-quality pages can be
 * flagged for review, P0-2a). Pages that read as empty are dropped, not faked.
 */
export async function ocrPdfPages(
  filePath: string,
  pageCount: number,
  ocr: PageOcr,
  maxPages = DEFAULT_MAX_OCR_PAGES,
): Promise<OcrPagesResult> {
  const limit = Math.min(pageCount, Math.max(1, maxPages));
  const pages: OcrPage[] = [];
  let engine: OcrEngineName | undefined;
  const confidences: number[] = [];
  const lowConfidencePages: number[] = [];
  for (let p = 1; p <= limit; p++) {
    const result = await ocr(filePath, p);
    const text = result?.text.trim() ?? '';
    if (text.length > 0) {
      const confidence = result?.confidence;
      pages.push({ pageNumber: p, text, ...(typeof confidence === 'number' ? { confidence } : {}) });
      engine = result?.engine;
      if (typeof confidence === 'number') {
        confidences.push(confidence);
        if (confidence < OCR_CONFIDENCE_THRESHOLD) lowConfidencePages.push(p);
      }
    }
  }
  const meanConfidence =
    confidences.length > 0
      ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 10) / 10
      : undefined;
  return {
    pages,
    ...(engine ? { engine } : {}),
    truncated: pageCount > limit,
    lowConfidencePages,
    ...(meanConfidence !== undefined ? { meanConfidence } : {}),
  };
}
