import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PdfExtraction {
  pageCount: number;
  /** Whitespace-normalized text per page. */
  pages: string[];
  /** All pages joined — empty string when there is no text layer. */
  text: string;
  /**
   * False for image-only PDFs (scans, raster plots). Gated on average
   * characters per page so a stray watermark or page number on a scan
   * doesn't masquerade as extractable content.
   */
  hasTextLayer: boolean;
}

/**
 * Below this average chars/page the document is treated as a scan needing
 * OCR. Deliberately conservative (ADR 0004): a borderline drawing sheet
 * flagged `needs-ocr` costs a curator a glance; near-empty text ingested as
 * `content` silently poisons retrieval and the verification panel.
 */
const MIN_CHARS_PER_PAGE = 24;

/** Extract the text layer from a PDF (pdf.js, pure JS — no native deps). */
export async function extractPdfText(data: Uint8Array): Promise<PdfExtraction> {
  // verbosity 0 silences pdf.js warnings about quirky real-world files;
  // genuine failures still reject the promise and are handled by callers.
  // Copy first: pdf.js detaches the buffer it is given (see vector.ts), and
  // callers must be free to reuse their bytes.
  const task = getDocument({ data: new Uint8Array(data), useSystemFonts: true, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    }
    const text = pages.filter((p) => p.length > 0).join('\n\n');
    const hasTextLayer = text.length >= MIN_CHARS_PER_PAGE * pages.length;
    return { pageCount: pages.length, pages, text: hasTextLayer ? text : '', hasTextLayer };
  } finally {
    await task.destroy();
  }
}
