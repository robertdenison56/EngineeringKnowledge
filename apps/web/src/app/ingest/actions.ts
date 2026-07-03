'use server';

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { revalidatePath } from 'next/cache';
import {
  buildCandidate,
  buildReferenceEdges,
  sheetIndex,
  KNOWN_EXTENSIONS,
  type Candidate,
} from '@ekg/ingestion';
import { DEV_CALLER, getStore } from '../../lib/store';
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
 * Mutations run as the dev caller; production gates these behind the
 * contributor/curator role from Entra SSO (PRD P0-9, gap G11).
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

export async function ingestUploads(
  _prev: IngestResult | null,
  formData: FormData,
): Promise<IngestResult> {
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
  const batchTags = String(formData.get('tags') ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, '-'))
    .filter(Boolean);

  const store = await getStore();
  const now = new Date().toISOString();
  const root = uploadRoot();

  const results: IngestFileResult[] = [];
  const candidates: Candidate[] = [];

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
        tenantId: DEV_CALLER.tenantId,
        pipeline: 'workspace-upload',
        now,
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

  // Cross-sheet callouts → `references` edges, resolved across this batch plus
  // what the graph already knows, so a sheet uploaded today links to one
  // ingested last week (mirrors the CLI and gateway's Phase B step).
  let referencesLinked = 0;
  let referencesUnresolved: string[] = [];
  if (candidates.length > 0) {
    const existing = await store.list(DEV_CALLER);
    const index = sheetIndex([...existing, ...candidates.map((c) => c.entity)]);
    const { edges, unresolved } = buildReferenceEdges(
      candidates,
      index,
      DEV_CALLER.tenantId,
    );
    for (const edge of edges) await store.upsertRelationship(edge);
    referencesLinked = edges.length;
    referencesUnresolved = unresolved;

    revalidatePath('/curation');
    revalidatePath('/search');
    revalidatePath('/');
  }

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  auditAction('ingest_upload', {
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
