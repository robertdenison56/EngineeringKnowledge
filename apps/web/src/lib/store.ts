import {
  DEMO_TENANT,
  InMemoryGraphStore,
  seedDemo,
  type Caller,
  type GraphStore,
} from '@ekg/core';

/**
 * Singleton store for the workspace app. In development this is the seeded
 * in-memory demo graph; production swaps in the real graph store behind the
 * same GraphStore interface (ADR 0001). Cached on globalThis so Next.js HMR
 * doesn't reseed on every recompile.
 */
const globalForStore = globalThis as unknown as { __ekgStore?: GraphStore };

export async function getStore(): Promise<GraphStore> {
  if (!globalForStore.__ekgStore) {
    const store = new InMemoryGraphStore();
    await seedDemo(store);
    globalForStore.__ekgStore = store;
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
