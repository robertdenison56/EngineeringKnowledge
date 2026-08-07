import type { Chunk, SourceAnchor } from '@ekg/core';
import { parseSpecSectionHeading } from './classify.js';

/**
 * Split a document into retrievable passages (ADR 0006). The 20k-char entity
 * `content` preview stops a few pages into a 400-page spec book, leaving the
 * rest unsearchable, un-embeddable, and uncitable. Chunks carry the
 * authoritative full text: each its own FTS row, embedding, and anchor, so a
 * hit resolves to the page or spec section, not just the file (P0-2a).
 *
 * PDFs chunk per page — already the right granularity (~1–2k chars), and the
 * page is a natural citation target; sheet/spec-section anchors enrich it.
 * Plain text chunks into size-bounded windows on paragraph boundaries.
 * Short documents (one window) stay chunkless — their entity content already
 * holds everything.
 */

export interface PageText {
  pageNumber: number;
  text: string;
  /** Drawing sheet number from the title block, when harvested. */
  sheet?: string;
  /** Sheet title from the title block, when harvested. */
  title?: string;
}

export interface ChunkSource {
  entityId: string;
  tenantId: string;
  /** One entry per PDF page (drawings and specs alike). */
  pages?: PageText[];
  /** Whole text for non-paginated documents (.md/.txt). */
  text?: string;
  /** Spec section from filename classification, as an anchor fallback. */
  specSection?: string;
}

/** A page longer than this is sub-split so no single chunk dominates. */
const MAX_CHUNK_CHARS = 6000;
/** Target window for plain-text documents. */
const TEXT_WINDOW = 1600;
/** Below this, a text document is left whole (no chunks). */
const MIN_CHUNKABLE = 2400;

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Split an over-long passage on sentence/paragraph-ish boundaries. */
function windowText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    // Prefer a break at whitespace near the window edge.
    let cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.6) cut = size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

export function chunkDocument(source: ChunkSource): Chunk[] {
  const chunks: Chunk[] = [];
  const push = (text: string, anchor: SourceAnchor, heading?: string) => {
    const body = clean(text);
    if (body.length === 0) return;
    const ordinal = chunks.length;
    chunks.push({
      id: `${source.entityId}#${ordinal}`,
      entityId: source.entityId,
      tenantId: source.tenantId,
      ordinal,
      anchor,
      ...(heading ? { heading } : {}),
      text: body,
    });
  };

  if (source.pages && source.pages.length > 0) {
    for (const page of source.pages) {
      const body = clean(page.text);
      if (body.length === 0) continue;
      const specSection = parseSpecSectionHeading(body.slice(0, 200)) ?? source.specSection;
      const anchor: SourceAnchor = {
        page: page.pageNumber,
        ...(page.sheet ? { sheet: page.sheet } : {}),
        ...(specSection ? { specSection } : {}),
      };
      const heading = page.sheet
        ? `Sheet ${page.sheet}${page.title ? ` — ${page.title}` : ''}`
        : specSection
          ? `${specSection} (p. ${page.pageNumber})`
          : `Page ${page.pageNumber}`;
      // One chunk per page, sub-split only when a page runs very long.
      const windows = windowText(body, MAX_CHUNK_CHARS);
      windows.forEach((w, i) =>
        push(w, anchor, windows.length > 1 ? `${heading} (${i + 1}/${windows.length})` : heading),
      );
    }
    return chunks;
  }

  // Plain text: leave short documents whole; window longer ones.
  const text = clean(source.text ?? '');
  if (text.length < MIN_CHUNKABLE) return [];
  const windows = windowText(text, TEXT_WINDOW);
  windows.forEach((w, i) =>
    push(w, source.specSection ? { specSection: source.specSection } : {}, `Part ${i + 1}/${windows.length}`),
  );
  return chunks;
}

/** Concatenated chunk text — the full document, for whole-doc grounding. */
export function chunksToText(chunks: Chunk[]): string {
  return chunks
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((c) => c.text)
    .join('\n\n');
}
