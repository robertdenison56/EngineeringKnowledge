import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  DEMO_TENANT,
  InMemoryGraphStore,
  seedDemo,
  type Caller,
  type GraphStore,
} from '@ekg/core';
import { SqliteGraphStore, providerFromEnv } from '@ekg/store-sqlite';

/**
 * Store bootstrap for the workspace app. Persistent SQLite by default
 * (.data/ekg.db, seeded with the demo corpus on first run) so curation
 * actions and ingested knowledge survive restarts. Set EKG_DB_PATH to
 * relocate the database, or to ":memory:" for an ephemeral seeded store.
 * Production swaps in the real graph engine behind the same GraphStore
 * interface (PRD Open Question 1).
 */
const globalForStore = globalThis as unknown as { __ekgStore?: GraphStore };

async function createStore(): Promise<GraphStore> {
  const envPath = process.env.EKG_DB_PATH;
  if (envPath === ':memory:') {
    const store = new InMemoryGraphStore();
    await seedDemo(store);
    return store;
  }
  const dbPath = envPath ?? path.join(process.cwd(), '.data', 'ekg.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = new SqliteGraphStore(dbPath, { embeddings: providerFromEnv() });
  // The dev workspace seeds the demo corpus on first run so the app is
  // explorable out of the box; EKG_SEED_DEMO=0 keeps a fresh database empty
  // (a real firm's workspace should start from its own documents).
  const seedDisabled = ['0', 'false', 'no'].includes(
    (process.env.EKG_SEED_DEMO ?? '').toLowerCase(),
  );
  if (store.countEntities(DEMO_TENANT) === 0 && !seedDisabled) {
    await seedDemo(store);
  } else {
    // Backfill vectors for rows ingested before a provider was configured.
    void store.reindexEmbeddings(DEMO_TENANT).catch(() => {});
  }
  return store;
}

export async function getStore(): Promise<GraphStore> {
  if (!globalForStore.__ekgStore) {
    globalForStore.__ekgStore = await createStore();
  }
  return globalForStore.__ekgStore;
}

/**
 * Principal that grants firm-wide admin rights (workspace settings, and the
 * role management to come). Production derives it from Entra ID group/role
 * claims; here it's carried on the fixed dev identity below (PRD P0-9).
 */
export const ADMIN_PRINCIPAL = 'role:admin';

/**
 * Fixed development identity — same as the MCP server's dev caller, so the
 * app and the gateways show an identical permission-trimmed view (PRD P0-7).
 * Carries the admin role so the single dev user can exercise admin-only
 * controls. Production resolves the caller from Entra ID SSO (PRD P0-9).
 */
export const DEV_CALLER: Caller = {
  tenantId: DEMO_TENANT,
  principals: ['user:dev', 'group:engineering', ADMIN_PRINCIPAL],
};

/** Whether a caller may change workspace-wide settings (PRD P0-9 admin role). */
export function isAdmin(caller: Caller): boolean {
  return caller.principals.includes(ADMIN_PRINCIPAL);
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
