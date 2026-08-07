import type { EntityType, SourceAnchor } from '@ekg/core';

export interface Classification {
  type: EntityType;
  anchor?: SourceAnchor;
}

/**
 * A MasterFormat section code: exactly three 2-digit groups with a CONSISTENT
 * separator (all space, dot, dash, or none — `\2` backreference) and NOT part of
 * a longer digit run (the `(?<!\d)`/`(?!\d)` guards). Those rules keep 4-digit-
 * year dates and IDs out: "2024 06 24" can't match (its first two pairs have no
 * separator, the next does), and "1078400" / "12345678" are rejected as longer
 * runs. They do NOT keep out a 2-digit "MM-DD-YY" date — see below. A level-4
 * code with a separator before its 4th pair ("09 91 23.13") still resolves to
 * its 2-2-2 section because the trailing "." is a non-digit; only a *fully
 * compact* 8-digit level-4 ("09912313") is skipped — a rare case, and worth
 * trading away to reject 8-digit invoice/job numbers.
 */
const SPEC_SECTION = /(?<!\d)(\d{2})([ .\-]?)(\d{2})\2(\d{2})(?!\d)/g;

/**
 * `MM-DD-YY` is *the* false positive, and it is not hypothetical: every page
 * of the Caltrans standard specifications carries "REVISED STANDARD
 * SPECIFICATIONS DATED 04-15-22" in its header, which anchored 134 of 140
 * chunks to the fictional section "04 15 22". The division check alone can
 * never catch it — every calendar month is <= 12, so a date always passes the
 * 00–49 range test.
 *
 * A date and a section code are genuinely indistinguishable by shape alone, so
 * this leans on the words around the digits and treats two spellings as
 * decisive: MasterFormat's canonical separator is a SPACE ("07 84 00"), and a
 * level-2 section ends in "00". Every other spelling — "-", ".", and compact —
 * is how a date stamp is actually written, and a live year does not read "00".
 *
 * Two limitations are deliberate, and both fail toward *no* citation rather
 * than a wrong one — except where noted:
 *   1. A dash/dot/compact-spelled LEVEL-3 section in divisions 01–12 whose
 *      level-2 group is <= 31 ("08 11 13") is read as a date and dropped, even
 *      after a "SECTION" cue — because "TYPICAL CROSS SECTION 06-30-24" is a
 *      drawing title followed by a date, and a cue cannot be trusted over the
 *      shape. Measured over 149 real MasterFormat 2020 sections: the canonical
 *      SPACE spelling loses 0; dash, dot, and compact each lose the same 10
 *      (6.7%) — 06 17 53, 07 31 13, 08 11 13, 08 12 13, 08 14 16, 08 31 13,
 *      09 05 61, 09 21 16, 09 22 16, 10 21 13.
 *   2. Day-first dates ("15-04-22") are NOT recognized as dates, because the
 *      day range overlaps real divisions 13–31 and rejecting them would delete
 *      most of Divisions 13–31. An explicit date cue still catches them. This
 *      one can still fabricate; it is a US-corpus assumption (MasterFormat is
 *      a CSI standard) and wants a labeled corpus, not a guess, to go further.
 */
// The word immediately before the digits, ignoring "No."/":"/"-" and spaces.
// Same-line only ([ \t], never \s) — PDF extraction flattens a whole cover
// sheet into one string, so a noun on the line above must not vouch or veto.
const TRAILING_WORD = /([A-Za-z]+)\.?[ \t]*(?:no\.?|number|#)?[ \t]*[:\-]?[ \t]*$/;
/** Exact words — a substring test lets "cross-section" and "UPDATED" through. */
const SPEC_WORDS = new Set(['section', 'sect', 'division', 'div']);
const DATE_WORDS = new Set([
  'dated', 'date', 'revised', 'revision', 'rev', 'issued', 'effective', 'printed', 'of',
]);

/**
 * A separator a date is actually written with. Only the canonical MasterFormat
 * SPACE is exempt: "07 84 00" is not a date, but "04-15-22", "04.15.22", and
 * the compact "092923" all are. The compact spelling matters most — a
 * `MMDDYY` stamp in a filename ("chp0060 092923-a11y.pdf") is how a whole
 * document gets mis-typed, and from there every one of its passages inherits
 * the phantom section.
 */
const DATE_SEPARATORS = new Set(['-', '.', '']);

/** Could this triple be a US calendar date rather than a section number? */
function dateShaped(mm: string, dd: string, yy: string, separator: string): boolean {
  if (!DATE_SEPARATORS.has(separator)) return false; // canonical section spelling
  if (Number(yy) === 0) return false; // level-2 "NN NN 00"; no live year reads 00
  const month = Number(mm);
  const day = Number(dd);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function wordBefore(text: string, index: number): string | undefined {
  return TRAILING_WORD.exec(text.slice(0, index))?.[1]?.toLowerCase();
}

/**
 * Extract a MasterFormat section code from text as normalized "NN NN NN", or
 * undefined. Rejects divisions outside the MasterFormat range (00–49), digit
 * runs that merely look like one (invoice/job numbers, dotted outline
 * numbering), and — see above — dates. Scans every candidate rather than only
 * the first, so a real section still wins after a date ahead of it is
 * discarded.
 */
export function parseSpecSection(text: string): string | undefined {
  return scanSpecSections(text, false);
}

/**
 * The same scan, but for deciding what a PAGE is a section of — and it will
 * not read a section out of a bare number.
 *
 * The difference is blast radius. A filename is one deliberate human act, and
 * a wrong read costs one mis-typed document. This runs against the opening of
 * every page of every document, where the text is a running header, a title
 * block, or the top row of a table — and on real engineering documents those
 * are made of numbers. Ingesting 29 Caltrans PDFs, permissive scanning put a
 * MasterFormat anchor on 353 passages, every one of them false: an hour-of-day
 * table became "00 01 02", a conductor list "10 11 12", a bid item code
 * "07 00 30", a design-speed table header "20 25 30".
 *
 * So a page must say the number is a section, in one of the two ways a spec
 * book actually says it:
 *   - an explicit "SECTION"/"DIVISION" cue, or
 *   - the number OPENS the page and a title follows it ("07 92 00 JOINT
 *     SEALANTS"), which is the running header of a spec book page.
 * A number that merely appears somewhere in the header is not evidence. Pages
 * that fail this keep their page anchor and fall back to the document-level
 * section — a coarser citation, never a wrong one.
 */
export function parseSpecSectionHeading(text: string): string | undefined {
  return scanSpecSections(text, true);
}

/** Does a section title follow the code, rather than another number? */
const TITLE_AFTER = /^[\s.\-–—:]*[A-Za-z]/;

function scanSpecSections(text: string, headingOnly: boolean): string | undefined {
  let fallback: string | undefined;
  for (const m of text.matchAll(SPEC_SECTION)) {
    const [, mm, separator, dd, yy] = m;
    if (Number(mm) > 49) continue; // not a real MasterFormat division
    // Mid-run of a longer separated number ("1.2.07.84.00" is an outline, not
    // a section). Only "." and "-" continue a run — a space does not, or
    // "Volume 2 07 84 00" would lose its section.
    if (/\d[.\-]$/.test(text.slice(0, m.index))) continue;
    const cue = wordBefore(text, m.index);
    if (cue && DATE_WORDS.has(cue)) continue;
    // Shape outranks the cue: see limitation 1 above.
    if (dateShaped(mm, dd, yy, separator)) continue;
    if (cue && SPEC_WORDS.has(cue)) return `${mm} ${dd} ${yy}`;
    if (headingOnly) {
      const opensText = m.index === 0;
      if (!opensText || !TITLE_AFTER.test(text.slice(m.index + m[0].length))) continue;
    }
    fallback ??= `${mm} ${dd} ${yy}`;
  }
  return fallback;
}

const SHEET_NUMBER = /\b([A-Z]{1,2}-\d{3})\b/;

/**
 * Filename-based classification (PRD P0-2). Deliberately conservative:
 * anything unrecognized lands as a plain `document` for a curator to
 * reclassify. Content-based classification arrives with the real pipeline.
 */
export function classifyFilename(filename: string): Classification {
  const spec = parseSpecSection(filename);
  if (spec) {
    return { type: 'spec-section', anchor: { specSection: spec } };
  }
  const sheet = filename.match(SHEET_NUMBER);
  if (sheet) {
    return { type: 'document', anchor: { sheet: sheet[1] } };
  }
  if (/\brfi\b|\brfi-/i.test(filename)) {
    return { type: 'rfi' };
  }
  if (/lesson/i.test(filename)) {
    return { type: 'lesson-learned' };
  }
  return { type: 'document' };
}

const SHEET_DISCIPLINES: Record<string, string> = {
  A: 'architecture',
  S: 'structural',
  M: 'mechanical',
  E: 'electrical',
  P: 'plumbing',
  FP: 'fire-protection',
};

const KEYWORD_TAGS: Record<string, string> = {
  firestop: 'firestop',
  'fire barrier': 'fire-safety',
  'curtain wall': 'curtain-wall',
  parapet: 'parapet',
  flashing: 'envelope',
  waterproof: 'envelope',
  seismic: 'structural',
};

/**
 * Parser-assigned tags (multi-valued): discipline from the sheet prefix,
 * MasterFormat division from spec numbers, and a small keyword dictionary
 * over filename + content. Conservative — tags suggest facets; curators
 * refine them in the workbench.
 */
export function deriveTags(
  filename: string,
  content: string,
  classification: Classification,
): string[] {
  const tags = new Set<string>();
  const sheet = classification.anchor?.sheet;
  if (sheet) {
    const prefix = sheet.split('-')[0];
    const discipline = SHEET_DISCIPLINES[prefix];
    if (discipline) tags.add(discipline);
  }
  const spec = classification.anchor?.specSection;
  if (spec) tags.add(`division-${spec.slice(0, 2)}`);
  const text = `${filename} ${content}`.toLowerCase();
  for (const [keyword, tag] of Object.entries(KEYWORD_TAGS)) {
    if (text.includes(keyword)) tags.add(tag);
  }
  return [...tags].sort();
}
