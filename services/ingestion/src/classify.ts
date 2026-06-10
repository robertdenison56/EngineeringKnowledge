import type { EntityType, SourceAnchor } from '@ekg/core';

export interface Classification {
  type: EntityType;
  anchor?: SourceAnchor;
}

const SPEC_SECTION = /\b(\d{2})\s?(\d{2})\s?(\d{2})\b/;
const SHEET_NUMBER = /\b([A-Z]{1,2}-\d{3})\b/;

/**
 * Filename-based classification (PRD P0-2). Deliberately conservative:
 * anything unrecognized lands as a plain `document` for a curator to
 * reclassify. Content-based classification arrives with the real pipeline.
 */
export function classifyFilename(filename: string): Classification {
  const spec = filename.match(SPEC_SECTION);
  if (spec) {
    return {
      type: 'spec-section',
      anchor: { specSection: `${spec[1]} ${spec[2]} ${spec[3]}` },
    };
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
  'mineral wool': 'firestop',
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
