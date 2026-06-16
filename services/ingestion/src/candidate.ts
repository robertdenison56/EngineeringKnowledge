import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { Chunk, Entity } from '@ekg/core';
import { chunkDocument, type PageText } from './chunking.js';
import { classifyFilename, deriveTags, type Classification } from './classify.js';
import {
  analyzeSheet,
  normalizeSheetNumber,
  type DetectionMethod,
  type SheetSemantics,
} from './semantics.js';
import { extractVectorContent, type TitleBlock, type VectorContent } from './vector.js';

/**
 * One file → one `unverified` candidate entity. Shared by the folder-walk
 * CLI and the MCP gateway's `ingest_document` tool (ADR 0005) so every
 * ingestion surface applies the same classification, extraction, and
 * honesty rules. Nothing reaches the verified graph without a curator.
 */

export const TEXT_EXTENSIONS = new Set(['.txt', '.md']);
export const KNOWN_EXTENSIONS = new Set(['.txt', '.md', '.pdf']);

export type ParseStatus = 'extracted' | 'needs-ocr' | 'parse-failed';

/**
 * An outbound cross-sheet reference detected on a drawing (callout bubble
 * or match-line label, ingestion Phase B). Resolved to `references` graph
 * edges by `buildReferenceEdges` once the target sheet is known.
 */
export interface SheetReference {
  /** Referenced sheet number as printed, e.g. "S-501". */
  targetSheet: string;
  /** Detail/view identifier when the callout names one, e.g. "3". */
  detail?: string;
  /** Page of THIS document the reference was found on. */
  page: number;
  confidence: number;
  method: DetectionMethod;
}

export interface Candidate {
  entity: Entity;
  classification: Classification;
  /** Set for PDFs only (ADR 0004). */
  parseStatus?: ParseStatus;
  pageCount?: number;
  /** Outbound cross-sheet references awaiting resolution (Phase B). */
  references?: SheetReference[];
  /**
   * Document passages for deep retrieval (ADR 0006). Pass to
   * `store.upsertEntity(entity, chunks)`; the entity keeps only a preview.
   */
  chunks?: Chunk[];
}

/** The entity carries a bounded preview; chunks hold the authoritative text. */
const CONTENT_PREVIEW_CHARS = 20000;

export async function buildCandidate(
  filePath: string,
  options: { tenantId: string; pipeline: string; now?: string },
): Promise<Candidate> {
  const ext = extname(filePath).toLowerCase();
  if (!KNOWN_EXTENSIONS.has(ext)) {
    throw new Error(`unsupported extension "${ext}" — supported: ${[...KNOWN_EXTENSIONS].join(', ')}`);
  }

  const file = basename(filePath);
  const classification = classifyFilename(file);
  const now = options.now ?? new Date().toISOString();

  let summary: string;
  // `fullText` is the authoritative extracted text (chunked + tagged);
  // `content` is the bounded preview stored on the entity (ADR 0006).
  let fullText = '';
  let content = '';
  let parseStatus: ParseStatus | undefined;
  let pageCount: number | undefined;
  let titleBlock: TitleBlock | undefined;
  let vector: VectorContent | undefined;
  let references: SheetReference[] = [];
  let semanticsSummary: Record<string, unknown> | undefined;
  let chunks: Chunk[] = [];
  if (TEXT_EXTENSIONS.has(ext)) {
    fullText = readFileSync(filePath, 'utf8').replace(/\s+/g, ' ').trim();
    content = fullText.slice(0, CONTENT_PREVIEW_CHARS);
    summary = fullText.slice(0, 400);
  } else {
    try {
      // CAD-native vector pass (vector-parsing plan, Phases A+B): spatially
      // ordered text (draw order scrambles drawing notes), a title block
      // harvested from geometry rather than the filename, and — on pages
      // that decoded as drawings — sheet semantics (views, dimensions,
      // callouts, match lines, schedules). 'auto' keeps the operator walk
      // off 400-page spec books.
      vector = await extractVectorContent(new Uint8Array(readFileSync(filePath)), {
        decodeStrokes: 'auto',
      });
      pageCount = vector.pageCount;
      if (vector.capability.hasTextLayer) {
        fullText = vector.pages
          .map((p) => p.orderedText)
          .filter((t) => t.length > 0)
          .join('\n\n')
          .trim();
        content = fullText.slice(0, CONTENT_PREVIEW_CHARS);
        summary = fullText.replace(/\s+/g, ' ').slice(0, 400);
        parseStatus = 'extracted';
        titleBlock = vector.pages
          .slice(0, 5)
          .map((p) => p.titleBlock)
          .find((tb) => tb?.sheetNumber !== undefined);

        const analyzed = vector.pages
          .filter((p) => p.strokes.length > 0)
          .map((p) => ({ page: p.pageNumber, semantics: analyzeSheet(p) }));
        ({ references, semanticsSummary } = summarizeSemantics(analyzed, vector));
      } else {
        summary = '[Scanned PDF — no text layer; flagged for OCR (ADR 0004)]';
        parseStatus = 'needs-ocr';
      }
    } catch (err) {
      summary = `[PDF could not be parsed: ${err instanceof Error ? err.message : String(err)}]`;
      parseStatus = 'parse-failed';
    }
  }
  // Tags fire from the full document, not just the opening preview.
  const tags = deriveTags(file, fullText, classification);

  const sheetMeta = titleBlock
    ? {
        ...(titleBlock.sheetNumber ? { number: titleBlock.sheetNumber } : {}),
        ...(titleBlock.title ? { title: titleBlock.title } : {}),
        ...(titleBlock.revision ? { revision: titleBlock.revision } : {}),
        ...(titleBlock.sheetIndex !== undefined
          ? { index: titleBlock.sheetIndex, total: titleBlock.sheetTotal }
          : {}),
      }
    : undefined;
  const anchor = {
    ...classification.anchor,
    // Geometry beats filename: the harvested sheet number fills the anchor
    // when the filename pattern missed (e.g. DOT "430-030" index names).
    ...(titleBlock?.sheetNumber && !classification.anchor?.sheet
      ? { sheet: titleBlock.sheetNumber }
      : {}),
  };

  const sheetRefs = [...new Set(references.map((r) => r.targetSheet))];
  const entityId = `ingest:${createHash('sha1').update(filePath).digest('hex').slice(0, 12)}`;

  // Document passages for deep retrieval (ADR 0006). The entity keeps a
  // bounded preview; chunks carry the whole document, each with its own
  // page/sheet/spec-section anchor for citation.
  if (vector && parseStatus === 'extracted') {
    const pages: PageText[] = vector.pages
      .filter((p) => p.orderedText.trim().length > 0)
      .map((p) => ({
        pageNumber: p.pageNumber,
        text: p.orderedText,
        ...(p.titleBlock?.sheetNumber ? { sheet: p.titleBlock.sheetNumber } : {}),
        ...(p.titleBlock?.title ? { title: p.titleBlock.title } : {}),
      }));
    chunks = chunkDocument({
      entityId,
      tenantId: options.tenantId,
      pages,
      ...(classification.anchor?.specSection ? { specSection: classification.anchor.specSection } : {}),
    });
  } else if (fullText.length > 0) {
    chunks = chunkDocument({
      entityId,
      tenantId: options.tenantId,
      text: fullText,
      ...(classification.anchor?.specSection ? { specSection: classification.anchor.specSection } : {}),
    });
  }

  const entity: Entity = {
    id: entityId,
    tenantId: options.tenantId,
    type: classification.type,
    title: file.replace(/\.[^.]+$/, ''),
    summary,
    properties: {
      ingestedFrom: filePath,
      extension: ext,
      pipeline: options.pipeline,
      ...(pageCount !== undefined ? { pageCount } : {}),
      ...(parseStatus ? { parseStatus } : {}),
      ...(sheetMeta ? { sheet: sheetMeta } : {}),
      ...(vector && vector.capability.layerTable > 0
        ? {
            layerTable: vector.capability.layerTable,
            layerAttribution: vector.capability.layerAttribution,
          }
        : {}),
      ...(semanticsSummary ? { semantics: semanticsSummary } : {}),
      // Outbound sheet references — visible to curators even before (or
      // without) edge resolution.
      ...(sheetRefs.length > 0 ? { sheetRefs } : {}),
    },
    ...(tags.length > 0 ? { tags } : {}),
    // Bounded preview shown in the app; the authoritative full text lives in
    // chunks (ADR 0006). For short documents the preview IS the full text.
    ...(content ? { content } : {}),
    provenance: {
      sourceUrl: `file://${filePath}`,
      createdAt: now,
      modifiedAt: now,
      reviewStatus: 'unverified',
      ...(Object.keys(anchor).length > 0 ? { anchor } : {}),
    },
    acl: { allowedPrincipals: ['*'] },
  };

  return {
    entity,
    classification,
    parseStatus,
    pageCount,
    ...(references.length > 0 ? { references } : {}),
    ...(chunks.length > 0 ? { chunks } : {}),
  };
}

/**
 * Fold per-page sheet semantics into (a) outbound cross-sheet references
 * and (b) a compact summary for entity properties — counts and labels, not
 * the full evidence graph, which stays an analysis-time artifact.
 */
function summarizeSemantics(
  analyzed: Array<{ page: number; semantics: SheetSemantics }>,
  vector: VectorContent,
): { references: SheetReference[]; semanticsSummary?: Record<string, unknown> } {
  if (analyzed.length === 0) return { references: [] };

  // A multi-sheet PDF calls out its own sheets constantly — those are
  // internal navigation, not graph edges to other documents.
  const ownSheets = new Set(
    vector.pages
      .map((p) => p.titleBlock?.sheetNumber)
      .filter((s): s is string => s !== undefined)
      .map(normalizeSheetNumber),
  );

  const byTarget = new Map<string, SheetReference>();
  for (const { page, semantics } of analyzed) {
    const candidates: Array<{ target: string; detail?: string; confidence: number; method: DetectionMethod }> = [
      ...semantics.callouts.map((c) => ({
        target: c.targetSheet,
        detail: c.detail,
        confidence: c.evidence.confidence,
        method: c.evidence.method,
      })),
      ...semantics.matchLines
        .filter((m) => m.targetSheet !== undefined)
        .map((m) => ({
          target: m.targetSheet as string,
          detail: undefined as string | undefined,
          confidence: m.evidence.confidence,
          method: m.evidence.method,
        })),
    ];
    for (const c of candidates) {
      if (ownSheets.has(normalizeSheetNumber(c.target))) continue;
      const key = `${normalizeSheetNumber(c.target)}#${c.detail ?? ''}`;
      const prev = byTarget.get(key);
      if (!prev || c.confidence > prev.confidence) {
        byTarget.set(key, {
          targetSheet: c.target,
          ...(c.detail ? { detail: c.detail } : {}),
          page,
          confidence: c.confidence,
          method: c.method,
        });
      }
    }
  }

  const sum = (pick: (s: SheetSemantics) => number) =>
    analyzed.reduce((n, a) => n + pick(a.semantics), 0);
  const viewLabels = [...new Set(analyzed.flatMap((a) => a.semantics.views.map((v) => v.label)))];
  const scheduleTitles = analyzed.flatMap((a) =>
    a.semantics.schedules.map((s) => s.title ?? `${s.rows}×${s.columns} table`),
  );
  const scales = [...new Set(analyzed.flatMap((a) => a.semantics.scales))];

  const counts = {
    views: sum((s) => s.views.length),
    dimensions: sum((s) => s.dimensions.length),
    callouts: sum((s) => s.callouts.length),
    matchLines: sum((s) => s.matchLines.length),
    schedules: sum((s) => s.schedules.length),
  };
  const any =
    Object.values(counts).some((n) => n > 0) || scales.length > 0 || byTarget.size > 0;
  return {
    references: [...byTarget.values()],
    ...(any
      ? {
          semanticsSummary: {
            ...counts,
            ...(viewLabels.length > 0 ? { viewLabels: viewLabels.slice(0, 20) } : {}),
            ...(scheduleTitles.length > 0 ? { scheduleTitles: scheduleTitles.slice(0, 12) } : {}),
            ...(scales.length > 0 ? { scales: scales.slice(0, 8) } : {}),
            analyzedPages: analyzed.length,
          },
        }
      : {}),
  };
}
