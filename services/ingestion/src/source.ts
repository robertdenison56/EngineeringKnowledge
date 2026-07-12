import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Acl, SourceSystem } from '@ekg/core';
import { KNOWN_EXTENSIONS } from './candidate.js';

/**
 * Source-connector seam (PRD P0-2). Every way a document enters the graph —
 * the folder-walk CLI, in-app upload, and the SharePoint/OneDrive OAuth sync
 * still to come — is the same shape: enumerate items, capture where each lives
 * and who may see it, and fetch bytes on demand. Pulling that behind one
 * interface means the SharePoint connector is a new `SourceConnector`
 * implementation, not a second ingestion path; classification, parsing, and
 * curation downstream stay identical.
 *
 * The change-detection half (`planSync`) is pure and lives here too, so the
 * "selected libraries sync on schedule with change detection" requirement is
 * testable without a live tenant — a connector just supplies a stable
 * per-item `version` (a content hash or the source's etag).
 */

/**
 * Provenance + permissions a connector captures for one item, threaded into
 * `buildCandidate({ source })`. Replaces the per-surface hardcoding of
 * `sourceUrl`/`acl` so source-system permissions become item ACLs at ingestion
 * (PRD P0-2), not a tenant-public default.
 */
export interface SourceMeta {
  /** Origin system, stamped onto `provenance.sourceSystem`. */
  system: SourceSystem;
  /** Deep link back to the item in its source system; overrides `file://`. */
  sourceUrl?: string;
  /**
   * Source-system permissions captured at ingestion → the item's ACL (PRD
   * P0-2). Omitted ⇒ the pipeline's tenant-public default.
   */
  acl?: Acl;
  /** Original author/owner from the source system. */
  author?: string;
  /** Source-system timestamps (ISO 8601); fall back to ingestion time. */
  createdAt?: string;
  modifiedAt?: string;
}

/** One item a connector exposes for ingestion. */
export interface SourceItem {
  /**
   * Stable id WITHIN the source — a path, a Graph driveItem id, a list-item
   * id. The key for change detection across syncs; never changes when the
   * item's content does.
   */
  id: string;
  /** File name (with extension) the classifier and title derive from. */
  name: string;
  /**
   * Opaque version token that changes iff the content changes — a content
   * hash or the source's etag. Compared against the manifest to decide whether
   * a re-sync needs to re-ingest this item.
   */
  version: string;
  meta: SourceMeta;
  /** Fetch the bytes lazily, so listing a large library stays cheap. */
  read(): Promise<Uint8Array>;
}

/**
 * A connectable source: a SharePoint library, a OneDrive folder, a local
 * directory. `list()` enumerates the current items; the sync engine diffs them
 * against the last manifest with {@link planSync}.
 */
export interface SourceConnector {
  readonly system: SourceSystem;
  /** Human label for the connected scope, e.g. "Specs library". */
  readonly label: string;
  list(): Promise<SourceItem[]>;
}

/**
 * The last-synced state of a source: item id → the `version` ingested. Persisted
 * per connected source (a settings row in the workspace app), so the next sync
 * only touches what changed.
 */
export type SyncManifest = Record<string, string>;

/** What a sync would do, computed by diffing current items against the manifest. */
export interface SyncPlan {
  /** Items not seen before — ingest. */
  added: SourceItem[];
  /** Items whose `version` moved since last sync — re-ingest. */
  changed: SourceItem[];
  /** Items unchanged since last sync — skip (the point of change detection). */
  unchanged: SourceItem[];
  /** Manifest ids no longer present at the source — candidates for removal. */
  removed: string[];
  /** The manifest to persist after this sync succeeds. */
  nextManifest: SyncManifest;
}

/**
 * Diff the current source listing against the last manifest. Pure and
 * deterministic: this is the change-detection core of scheduled SharePoint
 * sync (PRD P0-2), exercised in tests without any network. Removal is
 * *reported*, never executed here — deleting a source item is a curation
 * decision, not an automatic consequence of a sync.
 */
export function planSync(items: SourceItem[], manifest: SyncManifest = {}): SyncPlan {
  const added: SourceItem[] = [];
  const changed: SourceItem[] = [];
  const unchanged: SourceItem[] = [];
  const nextManifest: SyncManifest = {};
  const seen = new Set<string>();

  for (const item of items) {
    seen.add(item.id);
    nextManifest[item.id] = item.version;
    const prev = manifest[item.id];
    if (prev === undefined) added.push(item);
    else if (prev !== item.version) changed.push(item);
    else unchanged.push(item);
  }

  const removed = Object.keys(manifest).filter((id) => !seen.has(id));
  return { added, changed, unchanged, removed, nextManifest };
}

/** Hash file bytes for a content-based `version` (change detection). */
export function contentVersion(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex').slice(0, 16);
}

/**
 * Reference connector over a local directory — the folder-walk path expressed
 * through the seam. It captures the file's mtime and a content-hash version, so
 * the same `planSync` that will drive SharePoint sync is proven end-to-end
 * against the filesystem today. (Local files have no source-system ACL, so
 * items default to the pipeline's tenant-public ACL; the SharePoint connector
 * is where real permission capture lands.)
 */
export class FolderConnector implements SourceConnector {
  readonly system: SourceSystem = 'folder';
  readonly label: string;

  constructor(
    private readonly root: string,
    label?: string,
  ) {
    this.label = label ?? root;
  }

  async list(): Promise<SourceItem[]> {
    const items: SourceItem[] = [];
    for (const name of readdirSync(this.root, { recursive: true }) as string[]) {
      const filePath = join(this.root, name);
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      if (!KNOWN_EXTENSIONS.has(extname(name).toLowerCase())) continue;
      // Read once: bytes feed both the version hash and the lazy read().
      const bytes = new Uint8Array(readFileSync(filePath));
      items.push({
        id: filePath,
        name: name.split(/[\\/]/).pop() ?? name,
        version: contentVersion(bytes),
        meta: {
          system: 'folder',
          sourceUrl: pathToFileURL(filePath).href,
          modifiedAt: stat.mtime.toISOString(),
        },
        read: async () => bytes,
      });
    }
    return items;
  }
}
