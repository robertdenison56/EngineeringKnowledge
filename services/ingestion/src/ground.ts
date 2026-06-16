/**
 * Grounding gate for AI-generated drawing descriptions (ADR 0005): every
 * annotation the describing model claims to have read verbatim must actually
 * appear in the document's extracted text layer. Same honesty philosophy as
 * the lexical gate in ADR 0003 — generated content never outranks evidence.
 */

export interface GroundingReport {
  /** False when the document has no text layer to check against (scans). */
  groundable: boolean;
  grounded: string[];
  ungrounded: string[];
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

export function groundAnnotations(
  annotations: string[],
  sourceText: string | undefined,
): GroundingReport {
  const cleaned = annotations.map((a) => a.trim()).filter((a) => a.length > 0);
  if (!sourceText || sourceText.trim().length === 0) {
    return { groundable: false, grounded: [], ungrounded: cleaned };
  }
  const normalized = normalizeForGrounding(sourceText);
  const haystack = ` ${normalized} `;
  // CAD text layers letter-space words ("ROUTE 505" extracts as
  // "R OU TE 505" — Caltrans-corpus eval), so a token-exact miss gets a
  // second, space-blind check. It must still respect token boundaries at
  // the match edges: "ASTM C92" may not ground against "ASTM C920".
  const tokens = normalized.split(' ');
  let tight = '';
  const tokenStart: boolean[] = [];
  for (const token of tokens) {
    for (let i = 0; i < token.length; i++) tokenStart.push(i === 0);
    tight += token;
  }
  const tightMatch = (needle: string): boolean => {
    if (needle.length < 6) return false; // short strings ground by coincidence
    for (let at = tight.indexOf(needle); at >= 0; at = tight.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (tokenStart[at] && (end === tight.length || tokenStart[end])) return true;
    }
    return false;
  };
  const grounded: string[] = [];
  const ungrounded: string[] = [];
  for (const annotation of cleaned) {
    const needle = normalizeForGrounding(annotation);
    const hit =
      (needle.length > 0 && haystack.includes(` ${needle} `)) ||
      tightMatch(needle.replace(/ /g, ''));
    if (hit) grounded.push(annotation);
    else ungrounded.push(annotation);
  }
  return { groundable: true, grounded, ungrounded };
}
