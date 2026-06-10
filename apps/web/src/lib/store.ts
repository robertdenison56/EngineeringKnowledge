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
  if (store.countEntities(DEMO_TENANT) === 0) {
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
 * Fixed development identity — same as the MCP server's dev caller, so the
 * app and the gateways show an identical permission-trimmed view (PRD P0-7).
 * Production resolves the caller from Entra ID SSO (PRD P0-9).
 */
export const DEV_CALLER: Caller = {
  tenantId: DEMO_TENANT,
  principals: ['user:dev', 'group:engineering'],
};
