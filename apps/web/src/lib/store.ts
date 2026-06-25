import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  DEMO_TENANT,
  InMemoryGraphStore,
  InMemoryOperationJournal,
  JournaledGraphStore,
  RETRIEVAL_ROLES_KEY,
  parseRoles,
  seedDemo,
  serializeRoles,
  type Caller,
  type GraphStore,
  type OperationJournal,
  type OperationKind,
  type OperationSummary,
  type RetrievalRole,
} from '@ekg/core';
import { SqliteGraphStore, providerFromEnv } from '@ekg/store-sqlite';
import { currentOperation, runInOperation } from './operation-context';

/**
 * Store bootstrap for the workspace app. Persistent SQLite by default
 * (.data/ekg.db, seeded with the demo corpus on first run) so curation
 * actions and ingested knowledge survive restarts. Set EKG_DB_PATH to
 * relocate the database, or to ":memory:" for an ephemeral seeded store.
 * Production swaps in the real graph engine behind the same GraphStore
 * interface (PRD Open Question 1).
 */
const globalForStore = globalThis as unknown as {
  __ekgStore?: GraphStore;
  __ekgJournal?: OperationJournal;
};

/**
 * Build the store wrapped in the {@link JournaledGraphStore} decorator over a
 * change journal that shares the store's backend (the SQLite journal reuses the
 * store's single connection; the in-memory store gets an in-memory journal).
 * The seed/backfill run on the RAW store, before wrapping, so bootstrap writes
 * are never journaled — only deliberate, operation-scoped edits are undoable.
 */
async function createStore(): Promise<{ store: GraphStore; journal: OperationJournal }> {
  const envPath = process.env.EKG_DB_PATH;
  if (envPath === ':memory:') {
    const raw = new InMemoryGraphStore();
    await seedDemo(raw);
    const journal = new InMemoryOperationJournal();
    return { store: new JournaledGraphStore(raw, journal, currentOperation), journal };
  }
  const dbPath = envPath ?? path.join(process.cwd(), '.data', 'ekg.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new SqliteGraphStore(dbPath, { embeddings: providerFromEnv() });
  if (raw.countEntities(DEMO_TENANT) === 0) {
    await seedDemo(raw);
  } else {
    // Backfill vectors for rows ingested before a provider was configured.
    void raw.reindexEmbeddings(DEMO_TENANT).catch(() => {});
  }
  const journal = raw.createJournal();
  return { store: new JournaledGraphStore(raw, journal, currentOperation), journal };
}

async function initStore(): Promise<void> {
  if (!globalForStore.__ekgStore) {
    const { store, journal } = await createStore();
    globalForStore.__ekgStore = store;
    globalForStore.__ekgJournal = journal;
  }
}

export async function getStore(): Promise<GraphStore> {
  await initStore();
  return globalForStore.__ekgStore!;
}

/** The change journal backing undo — same instance the store decorator writes to. */
export async function getJournal(): Promise<OperationJournal> {
  await initStore();
  return globalForStore.__ekgJournal!;
}

/**
 * Run a mutating server action as one undoable operation (PRD P0-9). Every
 * `store.*` write inside `fn` is journaled under a single operation, so a bulk
 * import or a multi-step merge rolls back as one unit. Defaults the actor to the
 * dev caller, the identity every action already runs as.
 */
export async function runAsOperation<T>(
  meta: { label: string; kind: OperationKind; caller?: Caller },
  fn: () => Promise<T>,
): Promise<T> {
  const journal = await getJournal();
  return runInOperation(journal, { label: meta.label, kind: meta.kind, caller: meta.caller ?? DEV_CALLER }, fn);
}

/** Recent undoable operations for the workspace, newest first (admin UI). */
export async function listRecentOperations(limit = 10): Promise<OperationSummary[]> {
  const journal = await getJournal();
  return journal.list(DEV_CALLER.tenantId, limit);
}

/**
 * Principal that grants firm-wide admin rights (workspace settings, and the
 * role management to come). Production derives it from Entra ID group/role
 * claims; here it's carried on the fixed dev identity below (PRD P0-9).
 */
export const ADMIN_PRINCIPAL = 'role:admin';

/**
 * Principal that grants curation rights — editing, merging, and managing the
 * lifecycle of knowledge items (PRD P0-1, P0-9 curator role). Production derives
 * it from Entra ID claims; an admin implicitly curates ({@link isCurator}).
 */
export const CURATOR_PRINCIPAL = 'role:curator';

/**
 * Fixed development identity — same as the MCP server's dev caller, so the
 * app and the gateways show an identical permission-trimmed view (PRD P0-7).
 * Carries the admin role so the single dev user can exercise admin-only
 * controls. Production resolves the caller from Entra ID SSO (PRD P0-9).
 */
export const DEV_CALLER: Caller = {
  tenantId: DEMO_TENANT,
  principals: ['user:dev', 'group:engineering', CURATOR_PRINCIPAL, ADMIN_PRINCIPAL],
};

/** Whether a caller may change workspace-wide settings (PRD P0-9 admin role). */
export function isAdmin(caller: Caller): boolean {
  return caller.principals.includes(ADMIN_PRINCIPAL);
}

/**
 * Whether a caller may curate the graph — edit, merge, and manage entity
 * lifecycle (PRD P0-1, P0-9). Admins curate implicitly. This is the real
 * authorization boundary the edit/merge server actions re-check; the UI only
 * decides what to render.
 */
export function isCurator(caller: Caller): boolean {
  return caller.principals.includes(CURATOR_PRINCIPAL) || isAdmin(caller);
}

/** Settings key for the firm's display name (see {@link getFirmName}). */
export const FIRM_NAME_KEY = 'firm-name';

/**
 * The firm's display name — set by an admin in Settings → Identity, surfaced
 * in the header badge and reports. Falls back to the tenant id when unset, so
 * a fresh workspace still reads sensibly.
 */
export async function getFirmName(): Promise<string> {
  const store = await getStore();
  return (await store.getSetting(DEV_CALLER.tenantId, FIRM_NAME_KEY)) ?? DEV_CALLER.tenantId;
}

/**
 * The tenant's retrieval roles (focus lenses), set by an admin in Settings.
 * Stored as one JSON array in the settings store; absent/corrupt config parses
 * to [] so retrieval is never broken by a bad value.
 */
export async function getRoles(): Promise<RetrievalRole[]> {
  const store = await getStore();
  return parseRoles(await store.getSetting(DEV_CALLER.tenantId, RETRIEVAL_ROLES_KEY));
}

/** One role by id, or undefined — used to resolve the active lens at query time. */
export async function getRole(id: string | undefined): Promise<RetrievalRole | undefined> {
  if (!id) return undefined;
  return (await getRoles()).find((r) => r.id === id);
}

/** Persist the full role list (admin actions re-check {@link isAdmin} first). */
export async function saveRoles(roles: RetrievalRole[]): Promise<void> {
  const store = await getStore();
  await store.setSetting(DEV_CALLER.tenantId, RETRIEVAL_ROLES_KEY, serializeRoles(roles));
}
