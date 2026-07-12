'use server';

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { revalidatePath } from 'next/cache';
import {
  buildCandidate,
  buildProjectCandidates,
  buildReferenceEdges,
  createPageOcr,
  parseProjectCsv,
  sheetIndex,
  KNOWN_EXTENSIONS,
  type Candidate,
} from '@ekg/ingestion';
import { aclFromPrincipals, type Acl } from '@ekg/core';
import { getCaller, getStore, isCurator, runAsOperation } from '../../lib/store';
import { auditAction } from '../../lib/audit';

/**
 * In-app document upload (PRD P0-2 manual ingestion; closes gaps G1 and the
 * interim slice of G2). Files POSTed from the browser are written to a managed
 * location and run through the **same** `buildCandidate` pipeline the folder
 * CLI and the MCP gateway use — so classification, vector parsing, chunking,
 * honesty statuses, and cross-sheet reference edges are identical no matter how
 * a document enters. Every upload lands as `unverified`; nothing reaches the
 * verified graph without a curator (mirrors `services/ingestion/src/cli.ts`).
 *
 * Mutations resolve the request's authenticated caller and re-check the
 * curator role server-side (PRD P0-7, P0-9).
 */

/** Per-file outcome surfaced back to the uploader UI. */
export interface IngestFileResult {
  name: string;
  ok: boolean;
  id?: string;
  title?: string;
  type?: string;
  parseStatus?: string;
  chunks?: number;
  error?: string;
}

export interface IngestResult {
  ok: boolean;
  files: IngestFileResult[];
  /** Cross-sheet callout edges (Phase B) created across the batch + graph. */
  referencesLinked: number;
  /** Referenced sheets not yet in the graph — reported, never guessed. */
  referencesUnresolved: string[];
  message: string;
}

/** Matches next.config's serverActions.bodySizeLimit; enforced per file here. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Managed location for uploaded originals — alongside the SQLite DB under
 * `.data/` by default (gitignored), relocatable with EKG_UPLOAD_DIR. Each
 * upload gets its own uuid subdirectory so the on-disk filename stays the
 * original (clean entity titles) while the full path — and thus the derived
 * entity id — is unique even when the same file is uploaded twice.
 */
function uploadRoot(): string {
  return process.env.EKG_UPLOAD_DIR ?? path.join(process.cwd(), '.data', 'uploads');
}

/** Strip any path components and exotic characters before touching disk. */
function safeName(name: string): string {
  return (
    path
      .basename(name)
      .replace(/[^\w.\- ]+/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 200) || 'upload'
  );
}

/** Comma-separated batch tags, normalized to the same slug form as the parser. */
function parseBatchTags(formData: FormData): string[] {
  return String(formData.get('tags') ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, '-'))
    .filter(Boolean);
}

/**
 * Resolve the import's visibility into an item ACL (PRD P0-2 "stored as item
 * ACLs"). "restricted" stamps the listed principals; "public" (the default)
 * stays tenant-readable. A blank restriction falls back to public via
 * `aclFromPrincipals`, so a mis-set form never hides items from everyone. Until
 * a source connector maps real source-system permissions, this is the manual
 * capture path — and the seam the SharePoint sync will write through (gap G6).
 */
function aclFromForm(formData: FormData): Acl {
  if (String(formData.get('visibility') ?? 'public') !== 'restricted') {
    return { allowedPrincipals: ['*'] };
  }
  return aclFromPrincipals(String(formData.get('principals') ?? '').split(','));
}

export async function ingestUploads(
  _prev: IngestResult | null,
  formData: FormData,
): Promise<IngestResult> {
  // Server-side authorization boundary — the same check every other mutation
  // makes, not a hidden-UI affordance (PRD P0-7/P0-9). Gated on the request's
  // authenticated caller; SSO supplies the curator role in production (gap G11).
  const caller = await getCaller();
  if (!isCurator(caller)) {
    return {
      ok: false,
      files: [],
      referencesLinked: 0,
      referencesUnresolved: [],
      message: 'You need the curator role to add documents.',
    };
  }

  const uploads = formData
    .getAll('files')
    .filter((f): f is File => f instanceof File && f.size > 0);

  if (uploads.length === 0) {
    return {
      ok: false,
      files: [],
      referencesLinked: 0,
      referencesUnresolved: [],
      message: 'No files selected.',
    };
  }

  // Optional batch tags applied to every file — the cheap, useful slice of the
  // G2 wizard's "label this import" without the full source-connector build.
  const batchTags = parseBatchTags(formData);
  // Visibility chosen on the form → the item ACL captured at ingestion (P0-2).
  const acl = aclFromForm(formData);

  const store = await getStore();
  const now = new Date().toISOString();
  const root = uploadRoot();
  // OCR image-only scans when an engine is installed (honest no-op otherwise),
  // matching the CLI and gateway so an uploaded scan parses identically (P0-2a).
  // EKG_DISABLE_OCR=1 opts out even when an engine is present.
  const ocr = process.env.EKG_DISABLE_OCR === '1' ? null : await createPageOcr();

  const results: IngestFileResult[] = [];
  const candidates: Candidate[] = [];
  // Cross-sheet callouts → `references` edges, resolved across this batch plus
  // what the graph already knows, so a sheet uploaded today links to one
  // ingested last week (mirrors the CLI and gateway's Phase B step).
  let referencesLinked = 0;
  let referencesUnresolved: string[] = [];

  // The whole batch — every entity plus its cross-sheet reference edges — is ONE
  // undoable operation, so a mistaken import rolls back in a single click (P0-9).
  await runAsOperation(
    { label: `Imported ${uploads.length} document${uploads.length === 1 ? '' : 's'}`, kind: 'ingest-uploads' },
    async () => {
      for (const file of uploads) {
        const name = safeName(file.name);
        const ext = path.extname(name).toLowerCase();
        try {
          if (!KNOWN_EXTENSIONS.has(ext)) {
            throw new Error(`unsupported type — accepted: ${[...KNOWN_EXTENSIONS].join(', ')}`);
          }
          if (file.size > MAX_FILE_BYTES) {
            throw new Error(
              `too large (${(file.size / 1048576).toFixed(1)} MB — 25 MB limit)`,
            );
          }

          const destDir = path.join(root, randomUUID());
          await mkdir(destDir, { recursive: true });
          const filePath = path.join(destDir, name);
          await writeFile(filePath, Buffer.from(await file.arrayBuffer()));

          const candidate = await buildCandidate(filePath, {
            tenantId: caller.tenantId,
            pipeline: 'workspace-upload',
            now,
            ...(ocr ? { ocr } : {}),
            // Stamp the upload's origin + chosen visibility onto the candidate so
            // provenance reads honestly and the curator can see/adjust who may view
            // it before verifying (PRD P0-2; gap G6 seed).
            source: { system: 'upload', acl },
          });
          if (batchTags.length > 0) {
            candidate.entity.tags = [
              ...new Set([...(candidate.entity.tags ?? []), ...batchTags]),
            ];
          }
          await store.upsertEntity(candidate.entity, candidate.chunks);
          candidates.push(candidate);

          results.push({
            name,
            ok: true,
            id: candidate.entity.id,
            title: candidate.entity.title,
            type: candidate.entity.type,
            ...(candidate.parseStatus ? { parseStatus: candidate.parseStatus } : {}),
            ...(candidate.chunks ? { chunks: candidate.chunks.length } : {}),
          });
        } catch (err) {
          // One bad file never sinks the batch — report it and keep going.
          results.push({
            name,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (candidates.length > 0) {
        const existing = await store.list(caller);
        const index = sheetIndex([...existing, ...candidates.map((c) => c.entity)]);
        const { edges, unresolved } = buildReferenceEdges(
          candidates,
          index,
          caller.tenantId,
        );
        for (const edge of edges) await store.upsertRelationship(edge);
        referencesLinked = edges.length;
        referencesUnresolved = unresolved;

        revalidatePath('/curation');
        revalidatePath('/search');
        revalidatePath('/');
      }
    },
  );

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  // Per-file detail on top of the operation-level event runAsOperation records.
  auditAction(caller, 'ingest_upload', {
    args: {
      files: results.map((r) => r.name),
      failed: failCount,
      referencesLinked,
    },
    resultIds: results.filter((r) => r.ok && r.id).map((r) => r.id!),
    outcome: okCount > 0 ? 'ok' : 'error',
  });
  return {
    ok: okCount > 0,
    files: results,
    referencesLinked,
    referencesUnresolved,
    message:
      okCount === 0
        ? 'No documents were ingested.'
        : `Queued ${okCount} document${okCount === 1 ? '' : 's'} as unverified` +
          (failCount > 0 ? ` (${failCount} skipped)` : '') +
          ' — review them in the curation workbench.',
  };
}

// ── CSV project-list import (PRD P0-2 "CSV/bulk import for project lists") ──

/** One imported project, surfaced back to the CSV importer UI. */
export interface CsvImportedRow {
  id: string;
  title: string;
  number?: string;
}

export interface CsvImportResult {
  ok: boolean;
  imported: CsvImportedRow[];
  /** Rows the parser refused to guess at — shown so they can be fixed. */
  rowErrors: Array<{ line: number; message: string }>;
  /** Header columns mapped vs ignored, so the user can confirm the mapping. */
  recognized: string[];
  ignored: string[];
  message: string;
}

/**
 * Import a project list (pasted CSV or an uploaded `.csv`/`.tsv`) into the
 * graph as `project` candidates — the spreadsheet many firms already keep
 * becomes the graph's project spine without hand entry. Rows queue `unverified`
 * for the same curator sign-off as every other surface; malformed rows are
 * reported, never invented. Closes G2 step 3.
 */
export async function importProjectCsv(
  _prev: CsvImportResult | null,
  formData: FormData,
): Promise<CsvImportResult> {
  const empty = { imported: [], rowErrors: [], recognized: [], ignored: [] };

  // Server-side authorization boundary (PRD P0-7/P0-9), same as every mutation.
  const caller = await getCaller();
  if (!isCurator(caller)) {
    return { ok: false, ...empty, message: 'You need the curator role to import projects.' };
  }

  // An uploaded file wins over the textarea, so either path works.
  const file = formData.get('file');
  let text = '';
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_FILE_BYTES) {
      return { ok: false, ...empty, message: 'CSV file too large (25 MB limit).' };
    }
    text = await file.text();
  } else {
    text = String(formData.get('csv') ?? '');
  }
  if (!text.trim()) {
    return { ok: false, ...empty, message: 'Paste a project list or choose a .csv file.' };
  }

  const { rows, errors, recognized, ignored } = parseProjectCsv(text);
  if (rows.length === 0) {
    return {
      ok: false,
      imported: [],
      rowErrors: errors,
      recognized,
      ignored,
      message:
        errors[0]?.message ?? 'No project rows found — the file needs a header and at least one row.',
    };
  }

  const acl = aclFromForm(formData);
  const batchTags = parseBatchTags(formData);
  const now = new Date().toISOString();
  const candidates = buildProjectCandidates(rows, {
    tenantId: caller.tenantId,
    now,
    source: { system: 'csv', acl },
  });

  // Collapse rows that resolve to the same entity (a project number repeated
  // within one file) so a duplicate updates once and is reported — never
  // silently double-counted with the earlier occurrence clobbered (last wins).
  const deduped = new Map<string, (typeof candidates)[number]>();
  const dupErrors: Array<{ line: number; message: string }> = [];
  for (const c of candidates) {
    const prev = deduped.get(c.entity.id);
    if (prev) {
      dupErrors.push({
        line: c.row.line,
        message: `duplicate of "${prev.row.name}"${
          prev.row.number ? ` (no. ${prev.row.number})` : ''
        } on line ${prev.row.line} — kept the last occurrence`,
      });
    }
    deduped.set(c.entity.id, c);
  }

  const store = await getStore();
  const imported: CsvImportedRow[] = [];
  // One operation for the whole import, so the project list rolls back together.
  await runAsOperation(
    { label: `Imported ${deduped.size} project${deduped.size === 1 ? '' : 's'}`, kind: 'import-csv' },
    async () => {
      for (const c of deduped.values()) {
        if (batchTags.length > 0) {
          c.entity.tags = [...new Set([...(c.entity.tags ?? []), ...batchTags])];
        }
        await store.upsertEntity(c.entity);
        imported.push({
          id: c.entity.id,
          title: c.entity.title,
          ...(c.row.number ? { number: c.row.number } : {}),
        });
      }
    },
  );

  revalidatePath('/curation');
  revalidatePath('/search');
  revalidatePath('/');

  const n = imported.length;
  const skipped = errors.length;
  const merged = dupErrors.length;
  return {
    ok: true,
    imported,
    rowErrors: [...errors, ...dupErrors],
    recognized,
    ignored,
    message:
      `Queued ${n} project${n === 1 ? '' : 's'} as unverified` +
      (skipped > 0 ? ` (${skipped} row${skipped === 1 ? '' : 's'} skipped)` : '') +
      (merged > 0 ? ` (${merged} duplicate${merged === 1 ? '' : 's'} merged)` : '') +
      ' — review them in the curation workbench.',
  };
}
