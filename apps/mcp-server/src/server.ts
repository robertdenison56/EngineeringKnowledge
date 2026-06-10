import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  DEMO_TENANT,
  InMemoryGraphStore,
  seedDemo,
  type Caller,
  type Entity,
  type GraphStore,
  type SearchHit,
} from '@ekg/core';

/**
 * The canonical gateway (PRD P0-3). One MCP server serves Claude, ChatGPT,
 * and Microsoft 365 Copilot. `search` and `fetch` are named and shaped to
 * meet the ChatGPT connector spec; `traverse` exposes the graph structure.
 *
 * v0 scaffold: stdio transport, fixed dev caller, in-memory seeded store.
 * Production replaces these with Streamable HTTP + OAuth 2.1, per-request
 * caller resolution, and the real graph store — the tool surface stays.
 */

/** Stable deep link into the workspace app (PRD P0-9); placeholder host for now. */
function appUrl(entity: Entity): string {
  return `https://app.ekg.example/${entity.tenantId}/entities/${encodeURIComponent(entity.id)}`;
}

function citation(entity: Entity) {
  return {
    sourceUrl: entity.provenance.sourceUrl,
    author: entity.provenance.author,
    modifiedAt: entity.provenance.modifiedAt,
    reviewStatus: entity.provenance.reviewStatus,
    anchor: entity.provenance.anchor,
  };
}

function searchResult(hit: SearchHit) {
  return {
    id: hit.entity.id,
    title: hit.entity.title,
    url: appUrl(hit.entity),
    type: hit.entity.type,
    snippet: hit.entity.summary,
    provenance: citation(hit.entity),
    ...(hit.warning ? { warning: hit.warning } : {}),
  };
}

const NO_RESULTS_GUIDANCE =
  'The firm knowledge graph has no entries matching this query. Tell the user the firm graph ' +
  'has no answer — do NOT substitute general knowledge as if it were firm precedent (PRD P0-8).';

function asContent(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

export interface ServerOptions {
  store?: GraphStore;
  caller?: Caller;
}

export async function createServer(options: ServerOptions = {}): Promise<McpServer> {
  let store: GraphStore;
  if (options.store) {
    store = options.store;
  } else {
    const seeded = new InMemoryGraphStore();
    await seedDemo(seeded);
    store = seeded;
  }
  // Fixed identity for local development only. The remote deployment resolves
  // the caller from the OAuth token on every request (PRD P0-3, P0-7).
  const caller: Caller =
    options.caller ?? { tenantId: DEMO_TENANT, principals: ['user:dev', 'group:engineering'] };

  const server = new McpServer({ name: 'ekg-mcp', version: '0.1.0' });

  server.registerTool(
    'search',
    {
      title: 'Search firm engineering knowledge',
      description:
        "Search the firm's engineering knowledge graph (projects, design details, specs, standards, " +
        'lessons learned, experts). Results include provenance and a workspace-app URL — always cite them. ' +
        'Results carrying a "warning" field are superseded/deprecated and the warning must be relayed to the user. ' +
        'If the response has no_results=true, say the firm graph has no answer; never substitute general knowledge.',
      inputSchema: {
        query: z.string().describe('Natural-language or keyword query'),
        types: z
          .array(z.string())
          .optional()
          .describe('Optional entity-type filter, e.g. ["design-detail", "lesson-learned"]'),
        limit: z.number().int().min(1).max(25).optional(),
      },
    },
    async ({ query, types, limit }) => {
      const hits = await store.search(caller, query, { types, limit });
      if (hits.length === 0) {
        return asContent({ results: [], no_results: true, guidance: NO_RESULTS_GUIDANCE });
      }
      return asContent({ results: hits.map(searchResult) });
    },
  );

  server.registerTool(
    'fetch',
    {
      title: 'Fetch a knowledge item',
      description:
        'Fetch the full record for a knowledge-graph entity by id (ids come from search/traverse results). ' +
        'Returns properties, provenance, and related entities.',
      inputSchema: {
        id: z.string().describe('Entity id, e.g. "detail:cw-firestop-02"'),
      },
    },
    async ({ id }) => {
      const entity = await store.getEntity(caller, id);
      if (!entity) {
        return asContent({ error: 'not_found', id });
      }
      const related = await store.neighbors(caller, id);
      return asContent({
        id: entity.id,
        title: entity.title,
        text: entity.summary ?? '',
        url: appUrl(entity),
        metadata: {
          type: entity.type,
          properties: entity.properties,
          provenance: citation(entity),
          related: related.map((n) => ({
            relationship: n.relationship.type,
            direction: n.direction,
            id: n.entity.id,
            title: n.entity.title,
            type: n.entity.type,
          })),
        },
      });
    },
  );

  server.registerTool(
    'traverse',
    {
      title: 'Traverse graph relationships',
      description:
        'Follow relationships from an entity (e.g. which projects used a detail, who authored it, ' +
        'what supersedes it). Use after search to explore context around a result.',
      inputSchema: {
        entityId: z.string().describe('Starting entity id'),
        relationshipType: z
          .string()
          .optional()
          .describe('Optional filter, e.g. "supersedes", "used-in", "authored-by"'),
      },
    },
    async ({ entityId, relationshipType }) => {
      const start = await store.getEntity(caller, entityId);
      if (!start) {
        return asContent({ error: 'not_found', entityId });
      }
      const neighbors = await store.neighbors(caller, entityId, relationshipType);
      return asContent({
        start: { id: start.id, title: start.title, type: start.type },
        neighbors: neighbors.map((n) => ({
          relationship: n.relationship.type,
          direction: n.direction,
          id: n.entity.id,
          title: n.entity.title,
          type: n.entity.type,
          url: appUrl(n.entity),
          reviewStatus: n.entity.provenance.reviewStatus,
        })),
      });
    },
  );

  return server;
}
