/**
 * Grounding gate for AI-generated drawing descriptions (ADR 0005, 0008).
 * Every annotation the describing model claims to have read verbatim must be
 * confirmed against evidence — the document's extracted text layer, or the
 * deterministic vector parse. Same honesty philosophy as ADR 0003's lexical
 * gate: generated content never outranks evidence.
 *
 * Two independent sources of truth, so the parser and the vision model
 * collaborate (ADR 0008): the text layer (what strings the PDF carries) and
 * the parser's deterministic facts (the sheet number, view labels, dimension
 * inventory, callouts, scales it extracted from geometry). A vision quote
 * grounds if EITHER confirms it — which reclaims correct readings the text
 * layer mangles (stacked fractions, ± suffixes, the model appending
 * descriptive words to a dimension).
 */

/**
 * Deterministic facts from the vector parser, used as a second grounding
 * source. Structurally a subset of `SheetFacts` (describe.ts), so the gateway
 * passes the latter directly.
 */
export interface DeterministicFacts {
  sheetNumber?: string;
  views?: string[];
  scales?: string[];
  dimensions?: string[];
  callouts?: string[];
}

export interface GroundingReport {
  /** False when neither a text layer nor parser facts were available (scans). */
  groundable: boolean;
  grounded: string[];
  ungrounded: string[];
  /**
   * Subset of `grounded` the deterministic parser independently confirms —
   * the strongest signal, where two extractions agree (ADR 0008). Empty when
   * no facts were supplied.
   */
  parserConfirmed: string[];
}

/**
 * Tolerant of formatting noise (quotes, hyphens, stacked fractions render
 * differently in text layers), strict about substance: all alphanumeric
 * tokens must appear contiguously in the source.
 */
function normalizeForGrounding(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Specific enough to confirm by itself — multi-token or contains letters. */
function isSpecific(norm: string): boolean {
  return norm.length >= 3 && (norm.includes(' ') || /[a-z]/.test(norm));
}

/** Token-aligned containment in either direction on normalized strings. */
function tokenAlignedEither(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}

export function groundAnnotations(
  annotations: string[],
  sourceText: string | undefined,
  facts?: DeterministicFacts,
): GroundingReport {
  const cleaned = annotations.map((a) => a.trim()).filter((a) => a.length > 0);

  // Parser-truth phrases (ADR 0008) — the deterministic facts, specific ones only.
  const factPhrases = [
    facts?.sheetNumber,
    ...(facts?.views ?? []),
    ...(facts?.scales ?? []),
    ...(facts?.dimensions ?? []),
    ...(facts?.callouts ?? []),
  ]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map(normalizeForGrounding)
    .filter(isSpecific);

  const hasText = !!sourceText && sourceText.trim().length > 0;
  if (!hasText && factPhrases.length === 0) {
    return { groundable: false, grounded: [], ungrounded: cleaned, parserConfirmed: [] };
  }

  // --- Text-layer matching (existing behavior) ---
  const normalized = hasText ? normalizeForGrounding(sourceText) : '';
  const haystack = ` ${normalized} `;
  // CAD text layers letter-space words ("ROUTE 505" extracts as "R OU TE 505"),
  // so a token-exact miss gets a second, space-blind check that still respects
  // token boundaries at the edges ("ASTM C92" may not ground against "ASTM C920").
  const tokens = normalized.split(' ');
  let tight = '';
  const tokenStart: boolean[] = [];
  for (const token of tokens) {
    for (let i = 0; i < token.length; i++) tokenStart.push(i === 0);
    tight += token;
  }
  const tightMatch = (needle: string): boolean => {
    if (needle.length < 6) return false;
    for (let at = tight.indexOf(needle); at >= 0; at = tight.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (tokenStart[at] && (end === tight.length || tokenStart[end])) return true;
    }
    return false;
  };
  const textGrounds = (needle: string): boolean =>
    hasText && ((needle.length > 0 && haystack.includes(` ${needle} `)) || tightMatch(needle.replace(/ /g, '')));

  // --- Parser-fact matching (ADR 0008) ---
  const parserGrounds = (needle: string): boolean =>
    isSpecific(needle) && factPhrases.some((p) => tokenAlignedEither(needle, p));

  const grounded: string[] = [];
  const ungrounded: string[] = [];
  const parserConfirmed: string[] = [];
  for (const annotation of cleaned) {
    const needle = normalizeForGrounding(annotation);
    const byParser = parserGrounds(needle);
    if (textGrounds(needle) || byParser) {
      grounded.push(annotation);
      if (byParser) parserConfirmed.push(annotation);
    } else {
      ungrounded.push(annotation);
    }
  }
  return { groundable: true, grounded, ungrounded, parserConfirmed };
}
