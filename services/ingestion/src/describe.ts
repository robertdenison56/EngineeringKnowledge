import { analyzeSheet } from './semantics.js';
import { extractVectorContent } from './vector.js';

/**
 * Deterministic sheet facts for VLM fusion (Phase C of the vector-parsing
 * plan, ADR 0007). The gateway's describe flow (ADR 0005) hands a vision
 * model rendered pixels and asks it to read the sheet. The Caltrans eval
 * (docs/spikes/2026-06-11) showed where that fails: the model misreads small
 * text — `Br No.` -> "BY No.", `ADT (2043)` -> "2020" — and occasionally
 * fabricates values.
 *
 * But we already parsed the sheet's geometry deterministically (Phases A+B):
 * the title block, view labels, dimension strings, callouts, schedules, and
 * CAD layer names. Feeding those to the model as ground truth lets it narrate
 * *on top of* facts instead of re-deriving them from pixels — anchoring the
 * identifiers and structure it is worst at reading.
 */

export interface SheetFacts {
  page: number;
  sheetNumber?: string;
  title?: string;
  revision?: string;
  sheetIndex?: number;
  sheetTotal?: number;
  views: string[];
  scales: string[];
  /** Distinct dimension strings, a representative sample. */
  dimensions: string[];
  /** Cross-sheet callouts as printed, e.g. "3/S-101". */
  callouts: string[];
  matchLines: string[];
  /** Schedule titles, or "RxC table" when untitled. */
  schedules: string[];
  /** CAD layer names, only when per-primitive attribution survived. */
  layers: string[];
}

const MAX_DIMENSIONS = 24;

/**
 * Extract deterministic facts for one page. Returns null when the page has no
 * usable vector content (a scan, or text-as-outlines) — the describe flow
 * then proceeds with pixels only, honestly unenriched.
 */
export async function extractSheetFacts(
  data: Uint8Array,
  page = 1,
): Promise<SheetFacts | null> {
  // Decode geometry up to (and including) the requested page — the gateway
  // describes one sheet at a time, so this is bounded.
  const vector = await extractVectorContent(data, {
    maxPages: page,
    maxDecodePages: page,
    decodeStrokes: true,
  });
  const vp = vector.pages[page - 1];
  if (!vp || (vp.texts.length === 0 && vp.strokes.length === 0)) return null;

  const sem = analyzeSheet(vp);
  const tb = vp.titleBlock;

  const dimensions = [...new Set(sem.dimensions.map((d) => d.text))].slice(0, MAX_DIMENSIONS);
  const views = [...new Set(sem.views.map((v) => v.label))];
  const callouts = [...new Set(sem.callouts.map((c) => (c.detail ? `${c.detail}/` : '') + c.targetSheet))];
  const matchLines = sem.matchLines.map((m) => (m.targetSheet ? `→ ${m.targetSheet}` : m.label));
  const schedules = sem.schedules.map((s) => s.title ?? `${s.rows}×${s.columns} table`);
  // Layer names are only trustworthy when content was actually attributed.
  const layers = vector.capability.layerAttribution ? (vector.layers ?? []) : [];

  const facts: SheetFacts = {
    page,
    ...(tb?.sheetNumber ? { sheetNumber: tb.sheetNumber } : {}),
    ...(tb?.title ? { title: tb.title } : {}),
    ...(tb?.revision ? { revision: tb.revision } : {}),
    ...(tb?.sheetIndex !== undefined ? { sheetIndex: tb.sheetIndex, sheetTotal: tb.sheetTotal } : {}),
    views,
    scales: sem.scales,
    dimensions,
    callouts,
    matchLines,
    schedules,
    layers,
  };

  // Nothing worth fusing → behave as if unextractable.
  const hasAnything =
    facts.sheetNumber !== undefined ||
    views.length > 0 ||
    dimensions.length > 0 ||
    callouts.length > 0 ||
    schedules.length > 0 ||
    facts.scales.length > 0;
  return hasAnything ? facts : null;
}

/**
 * Render facts as a ground-truth instruction block for the describing model.
 * Each line is a deterministic finding the model should trust over its own
 * reading of the pixels.
 */
export function formatSheetFacts(facts: SheetFacts): string {
  const lines: string[] = [];
  const sheet =
    facts.sheetNumber || facts.title
      ? [
          facts.sheetNumber,
          facts.title ? `"${facts.title}"` : undefined,
          facts.sheetIndex !== undefined ? `(sheet ${facts.sheetIndex} of ${facts.sheetTotal})` : undefined,
          facts.revision ? `rev ${facts.revision}` : undefined,
        ]
          .filter(Boolean)
          .join(' ')
      : undefined;
  if (sheet) lines.push(`- Sheet: ${sheet}`);
  if (facts.views.length) lines.push(`- Views detected: ${facts.views.join('; ')}`);
  if (facts.scales.length) lines.push(`- Scales: ${facts.scales.join('; ')}`);
  if (facts.dimensions.length) lines.push(`- Dimensions found: ${facts.dimensions.join('  ')}`);
  if (facts.callouts.length) lines.push(`- Cross-sheet callouts: ${facts.callouts.join('; ')}`);
  if (facts.matchLines.length) lines.push(`- Match lines: ${facts.matchLines.join('; ')}`);
  if (facts.schedules.length) lines.push(`- Schedules/tables: ${facts.schedules.join('; ')}`);
  if (facts.layers.length)
    lines.push(`- CAD layers: ${facts.layers.slice(0, 20).join('; ')}${facts.layers.length > 20 ? ' …' : ''}`);

  return (
    'DETERMINISTIC PARSE of this sheet (extracted from the vector geometry — ' +
    'trust these for identifiers, structure, and exact values; the rendered ' +
    'image is for reading what they mean and what else is drafted):\n' +
    lines.join('\n') +
    '\n\nUse the facts above as ground truth: do not contradict the sheet number, ' +
    'view names, or dimension strings listed. Describe what is drafted around ' +
    'them and quote any additional annotations verbatim — still no symbol ' +
    'counts, no inferred dimensions, and say so if a region is illegible.\n' +
    'When you quote a dimension or identifier, make it ONE atomic annotation — ' +
    'the bare printed value by itself (e.g. `18\'-11"`), NOT bundled with ' +
    'descriptive words; put context like "after strengthening" in the ' +
    'description prose. Atomic quotes can be mechanically verified; bundled ' +
    'ones cannot.'
  );
}
