import { createHash } from 'node:crypto';
import type { Entity } from '@ekg/core';
import type { SourceMeta } from './source.js';

/**
 * CSV project-list import (PRD P0-2 "CSV/bulk import for project lists"). A
 * knowledge manager seeds the graph's project spine from a spreadsheet export
 * instead of hand-entering each project. Rows become `project` candidate
 * entities queued `unverified` — same curation gate as every other surface;
 * nothing is auto-verified. Malformed rows are reported, never guessed.
 *
 * Deliberately dependency-free: a small RFC-4180 reader (quoted fields,
 * embedded commas/newlines, `""` escapes) so bulk import adds no supply chain.
 */

/** One parsed project row, with its 1-based source line for error reporting. */
export interface ProjectRow {
  name: string;
  number?: string;
  client?: string;
  discipline?: string;
  status?: string;
  location?: string;
  sourceUrl?: string;
  description?: string;
  tags?: string[];
  /** 1-based line number in the file (header is line 1), for the import log. */
  line: number;
}

export interface ProjectCsvParse {
  rows: ProjectRow[];
  /** Per-row problems — surfaced to the user, the row is skipped not invented. */
  errors: Array<{ line: number; message: string }>;
  /** Header columns mapped to a known field (for the import preview). */
  recognized: string[];
  /** Header columns ignored because nothing maps to them. */
  ignored: string[];
}

/** A built project candidate, paired with the row it came from. */
export interface ProjectCandidate {
  entity: Entity;
  row: ProjectRow;
}

/** Header synonyms → canonical field. Matched case-insensitively, trimmed. */
const FIELD_ALIASES: Record<string, keyof ProjectRow> = {
  name: 'name',
  project: 'name',
  'project name': 'name',
  title: 'name',
  number: 'number',
  'project number': 'number',
  'project no': 'number',
  'project #': 'number',
  no: 'number',
  'job number': 'number',
  'job no': 'number',
  client: 'client',
  owner: 'client',
  customer: 'client',
  discipline: 'discipline',
  trade: 'discipline',
  status: 'status',
  phase: 'status',
  stage: 'status',
  location: 'location',
  city: 'location',
  site: 'location',
  url: 'sourceUrl',
  link: 'sourceUrl',
  source: 'sourceUrl',
  'source url': 'sourceUrl',
  sharepoint: 'sourceUrl',
  description: 'description',
  summary: 'description',
  notes: 'description',
  tags: 'tags',
  labels: 'tags',
};

/**
 * Parse a delimited project list (comma or tab auto-detected). A header row is
 * required — column meaning is by name, not position, so partial/ reordered
 * exports work. Rows missing a project name are reported and skipped.
 */
export function parseProjectCsv(text: string): ProjectCsvParse {
  const { records, errors: parseErrors } = parseDelimited(text);
  if (records.length === 0) {
    return { rows: [], errors: [{ line: 1, message: 'file is empty' }], recognized: [], ignored: [] };
  }

  const header = records[0].cells;
  const recognized: string[] = [];
  const ignored: string[] = [];
  // Column index → canonical field; the first header that maps to a field wins.
  const colField: Array<keyof ProjectRow | undefined> = header.map((h) => {
    const field = FIELD_ALIASES[h.trim().toLowerCase()];
    if (field) recognized.push(h.trim());
    else if (h.trim()) ignored.push(h.trim());
    return field;
  });

  if (!colField.includes('name')) {
    return {
      rows: [],
      errors: [
        {
          line: 1,
          message: `no project-name column found — add a "name" (or "project") header. Saw: ${header.join(', ')}`,
        },
      ],
      recognized,
      ignored,
    };
  }

  const rows: ProjectRow[] = [];
  // Surface structural parse errors (e.g. an unterminated quote) alongside the
  // per-row validation errors below.
  const errors: Array<{ line: number; message: string }> = [...parseErrors];

  for (let i = 1; i < records.length; i++) {
    const { cells, line } = records[i];
    if (cells.every((c) => c.trim() === '')) continue; // blank line

    const get = (field: keyof ProjectRow): string => {
      const idx = colField.indexOf(field);
      return idx >= 0 && idx < cells.length ? cells[idx].trim() : '';
    };

    const name = get('name');
    if (!name) {
      errors.push({ line, message: 'missing project name — row skipped' });
      continue;
    }

    const tagsRaw = get('tags');
    const tags = tagsRaw
      ? [...new Set(tagsRaw.split(/[;,|]/).map((t) => normalizeTag(t)).filter(Boolean))]
      : undefined;

    rows.push({
      name,
      ...optional('number', get('number')),
      ...optional('client', get('client')),
      ...optional('discipline', get('discipline')),
      ...optional('status', get('status')),
      ...optional('location', get('location')),
      ...optional('sourceUrl', get('sourceUrl')),
      ...optional('description', get('description')),
      ...(tags && tags.length > 0 ? { tags } : {}),
      line,
    });
  }

  return { rows, errors, recognized, ignored };
}

function optional(key: keyof ProjectRow, value: string): Partial<ProjectRow> {
  return value ? { [key]: value } : {};
}

function normalizeTag(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Turn parsed rows into `project` candidate entities. Stable id keyed on the
 * project number when present (else the name), so re-importing a corrected
 * sheet updates a project rather than duplicating it. Every candidate is
 * `unverified`; `source.acl` (e.g. a SharePoint-mapped ACL or a manual
 * restriction) is captured here, defaulting to tenant-public.
 */
export function buildProjectCandidates(
  rows: ProjectRow[],
  options: { tenantId: string; now?: string; source?: SourceMeta },
): ProjectCandidate[] {
  const now = options.now ?? new Date().toISOString();
  const src = options.source;
  return rows.map((row) => {
    const key = (row.number ?? row.name).toLowerCase();
    const id = `csv:project:${createHash('sha1').update(`${options.tenantId}:${key}`).digest('hex').slice(0, 12)}`;

    const tags = [
      ...new Set([
        ...(row.tags ?? []),
        ...(row.discipline ? [normalizeTag(row.discipline)] : []),
      ]),
    ];

    const composed = [
      row.client ? `Client: ${row.client}` : '',
      row.number ? `No. ${row.number}` : '',
      row.location ?? '',
    ]
      .filter(Boolean)
      .join(' · ');
    const summary = row.description ?? (composed || undefined);

    const entity: Entity = {
      id,
      tenantId: options.tenantId,
      type: 'project',
      title: row.name,
      ...(summary ? { summary } : {}),
      properties: {
        pipeline: 'csv-project-import',
        ...(row.number ? { projectNumber: row.number } : {}),
        ...(row.client ? { client: row.client } : {}),
        ...(row.discipline ? { discipline: row.discipline } : {}),
        ...(row.status ? { status: row.status } : {}),
        ...(row.location ? { location: row.location } : {}),
      },
      ...(tags.length > 0 ? { tags } : {}),
      provenance: {
        ...(row.sourceUrl ?? src?.sourceUrl ? { sourceUrl: row.sourceUrl ?? src?.sourceUrl } : {}),
        sourceSystem: src?.system ?? 'csv',
        ...(src?.author ? { author: src.author } : {}),
        createdAt: src?.createdAt ?? now,
        modifiedAt: src?.modifiedAt ?? now,
        reviewStatus: 'unverified',
      },
      acl: src?.acl ?? { allowedPrincipals: ['*'] },
    };
    return { entity, row };
  });
}

/** A parsed physical record: its cells and 1-based source line. */
interface CsvRecord {
  cells: string[];
  line: number;
}

/**
 * True when a quoted field opened just after `start` has a real closing quote
 * before EOF (skipping `""` escapes). Lets the reader recognize an UNTERMINATED
 * quote up front and recover from it, instead of letting an unclosed quote
 * swallow the rest of the file into one field.
 */
function quoteCloses(body: string, start: number): boolean {
  for (let j = start; j < body.length; j++) {
    if (body[j] === '"') {
      if (body[j + 1] === '"') {
        j++; // a "" escape, not a close
        continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * Minimal RFC-4180 reader. Auto-detects comma vs tab from the header line.
 * Handles quoted fields with embedded delimiters, newlines, and `""` escapes;
 * tolerates both CRLF and LF. An unterminated quote is recovered (treated as a
 * literal so following rows still parse) and surfaced via `errors`, never
 * silently swallowed.
 */
function parseDelimited(text: string): {
  records: CsvRecord[];
  errors: Array<{ line: number; message: string }>;
} {
  const body = text.replace(/^﻿/, ''); // strip BOM
  const firstLine = body.slice(0, body.search(/\r?\n|$/));
  const delimiter = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';

  const records: CsvRecord[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let startedRecord = false;

  const pushField = () => {
    cells.push(field);
    field = '';
  };
  const pushRecord = (recordLine: number) => {
    pushField();
    records.push({ cells, line: recordLine });
    cells = [];
  };

  let recordLine = 1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (!startedRecord) {
      recordLine = line;
      startedRecord = true;
    }
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (quoteCloses(body, i + 1)) {
        inQuotes = true;
      } else {
        // Unterminated quote: never swallow the file's tail into one field.
        // Recover by treating this quote as a literal — so newlines still break
        // the following rows — and report the malformation (the parser's
        // "malformed rows are reported, never guessed" contract).
        field += '"';
        errors.push({
          line,
          message: 'unterminated quoted field — the opening quote is never closed',
        });
      }
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === '\r') {
      // swallow; the \n handles the record break
    } else if (ch === '\n') {
      pushRecord(recordLine);
      line++;
      startedRecord = false;
    } else {
      field += ch;
    }
  }
  // Trailing record without a final newline.
  if (startedRecord || field !== '' || cells.length > 0) {
    pushRecord(recordLine);
  }
  return { records, errors };
}
