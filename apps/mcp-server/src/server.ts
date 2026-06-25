import { existsSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z } from 'zod';
import { auditSinkFromEnv, type AuditEvent, type AuditSink } from './audit.js';
import {
  DEMO_TENANT,
  InMemoryGraphStore,
  RETRIEVAL_ROLES_KEY,
  findRole,
  parseRoles,
  seedDemo,
  warningFor,
  type Caller,
  type Chunk,
  type Entity,
  type GraphStore,
  type RetrievalRole,
  type SearchHit,
} from '@ekg/core';
import {
  KNOWN_EXTENSIONS,
  buildCandidate,
  buildReferenceEdges,
  chunksToText,
  createPageOcr,
  extractSheetFacts,
  formatSheetFacts,
  groundAnnotations,
  rasterizeSheetForVision,
  sheetIndex,
  type PageOcr,
  type SheetFacts,
} from '@ekg/ingestion';
import { readFileSync } from 'node:fs';

/**
 * The canonical gateway (PRD P0-3). One MCP server serves Claude, ChatGPT,
 * and Microsoft 365 Copilot. `search` and `fetch` are named and shaped to
 * meet the ChatGPT connector spec; `traverse` exposes the graph structure;
 * `find_experts` and `get_project_context` are the richer tools that complete
 * the P0-3 tool surface (who knows about X, and everything about a project).
 *
 * v0 scaffold: stdio transport, fixed dev caller, in-memory seeded store.
 * Production replaces these with Streamable HTTP + OAuth 2.1, per-request
 * caller resolution, and the real graph store — the tool surface stays.
 */

/**
 * Stable deep link to the entity in the workspace app (PRD P0-9), where the
 * user can verify the answer against the source document text, provenance,
 * and graph context. EKG_APP_URL points at the deployed app.
 */
const APP_BASE = (process.env.EKG_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');

function appUrl(entity: Entity): string {
  return `${APP_BASE}/entities/${encodeURIComponent(entity.id)}`;
}

/**
 * OCR engine for image-only PDFs, resolved once per process (review #1). Null
 * when no engine is installed — scans then stay `needs-ocr`, exactly as before.
 * Set EKG_DISABLE_OCR=1 to opt out even when an engine is present.
 */
let ocrEnginePromise: Promise<PageOcr | null> | undefined;
function getPageOcr(): Promise<PageOcr | null> {
  if (process.env.EKG_DISABLE_OCR === '1') return Promise.resolve(null);
  return (ocrEnginePromise ??= createPageOcr());
}

function chunksTextLength(chunks: Chunk[]): number {
  return chunks.reduce((n, c) => n + c.text.length, 0);
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
  // When the hit matched a document passage, cite the page/section, not just
  // the file (P0-2a, ADR 0006): snippet from the passage, anchor merged with
  // the chunk's location.
  const provenance = citation(hit.entity);
  if (hit.chunk) {
    provenance.anchor = { ...provenance.anchor, ...hit.chunk.anchor };
  }
  return {
    id: hit.entity.id,
    title: hit.entity.title,
    url: appUrl(hit.entity),
    type: hit.entity.type,
    snippet: hit.chunk?.snippet ?? hit.entity.summary,
    ...(hit.chunk ? { matchedSection: hit.chunk.heading ?? `passage ${hit.chunk.ordinal + 1}` } : {}),
    tags: hit.entity.tags,
    provenance,
    ...(hit.warning ? { warning: hit.warning } : {}),
  };
}

/**
 * Compact reference to a related entity — shared by find_experts and
 * get_project_context. Carries the deep link and review status, and (for
 * superseded/deprecated items) the same warning `search` surfaces, so flagged
 * knowledge is never returned as a clean result (PRD P0-8).
 */
function relatedRef(entity: Entity) {
  const warning = warningFor(entity.provenance.reviewStatus);
  return {
    id: entity.id,
    title: entity.title,
    type: entity.type,
    url: appUrl(entity),
    reviewStatus: entity.provenance.reviewStatus,
    ...(warning ? { warning } : {}),
  };
}

const NO_RESULTS_GUIDANCE =
  'The firm knowledge graph has no entries matching this query. Tell the user the firm graph ' +
  'has no answer — do NOT substitute general knowledge as if it were firm precedent (PRD P0-8).';

function asContent(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Resolve a retrieval role (focus lens) for the caller's tenant, by id or name.
 * Roles are admin-defined config stored in the same settings the workspace app
 * writes; reading them per-request keeps the gateway in sync with the app.
 * Undefined when unset or unmatched — search then ranks normally.
 */
async function resolveRole(
  store: GraphStore,
  tenantId: string,
  idOrName: string | undefined,
): Promise<RetrievalRole | undefined> {
  if (!idOrName) return undefined;
  const roles = parseRoles(await store.getSetting(tenantId, RETRIEVAL_ROLES_KEY));
  return findRole(roles, idOrName);
}

/**
 * Fixed local-development identity. stdio is single-user, so the dev caller
 * is resolved for every request. The remote HTTP gateway injects a
 * `resolveCaller` that derives the real caller from the request's verified
 * token instead (PRD P0-3, P0-7).
 */
export const DEV_CALLER: Caller = {
  tenantId: DEMO_TENANT,
  principals: ['user:dev', 'group:engineering'],
};

/** Resolve the calling identity from the per-request auth, if any. */
export type ResolveCaller = (authInfo?: AuthInfo) => Caller;

/**
 * Build the graph store from the environment: the workspace app's curated
 * SQLite database when EKG_DB_PATH points at one, else a seeded in-memory
 * demo graph. Built once and shared across requests by the HTTP gateway.
 */
export async function createStore(): Promise<GraphStore> {
  if (process.env.EKG_DB_PATH && process.env.EKG_DB_PATH !== ':memory:') {
    // Share the same persistent database the workspace app curates, so the
    // gateway serves curator-approved knowledge (point it at the app's
    // .data/ekg.db).
    const { SqliteGraphStore, providerFromEnv } = await import('@ekg/store-sqlite');
    const sqlite = new SqliteGraphStore(process.env.EKG_DB_PATH, {
      embeddings: providerFromEnv(),
    });
    // Only seed the demo corpus (which includes a privileged claims memo) into a
    // persistent DB when explicitly asked — never silently inject demo/sample
    // data into a production database on first boot (PRD P0-7). The app's own
    // dev store seeds its .data DB; opt in here with EKG_SEED_DEMO=1.
    if (process.env.EKG_SEED_DEMO === '1' && sqlite.countEntities(DEMO_TENANT) === 0) {
      await seedDemo(sqlite);
    }
    return sqlite;
  }
  const seeded = new InMemoryGraphStore();
  await seedDemo(seeded);
  return seeded;
}

export interface ServerOptions {
  store?: GraphStore;
  /** Fixed caller (stdio/tests). Ignored when `resolveCaller` is given. */
  caller?: Caller;
  /**
   * Per-request identity resolution (HTTP gateway). Defaults to the fixed
   * `caller`/DEV_CALLER, which is correct for single-user stdio.
   */
  resolveCaller?: ResolveCaller;
  /** Audit sink for every tool call (PRD P0-7). Defaults to `auditSinkFromEnv()`. */
  audit?: AuditSink;
  /** Transport label recorded in audit events ("stdio" | "http"). */
  transport?: string;
}

/** Collect entity ids (`id`/`entityId` fields) anywhere in a tool's payload. */
function collectIds(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if ((k === 'id' || k === 'entityId') && typeof v === 'string') out.add(v);
      else collectIds(v, out);
    }
  }
}

/** Which items a call surfaced, and whether it found anything — for the audit trail. */
function summarizeResult(result: unknown): { ids: string[]; outcome: AuditEvent['outcome'] } {
  const ids = new Set<string>();
  let outcome: AuditEvent['outcome'] = 'ok';
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      try {
        const parsed: unknown = JSON.parse(block.text);
        collectIds(parsed, ids);
        if (parsed && typeof parsed === 'object') {
          if ('error' in parsed) outcome = 'error';
          else if ('no_results' in parsed) outcome = 'no_results';
        }
      } catch {
        /* a non-JSON text block (e.g. the describe instructions) carries no ids */
      }
    }
  }
  return { ids: [...ids], outcome };
}

/** Redacted argument summary — enough to know what was asked, with long strings clipped. */
function summarizeArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v;
  }
  return out;
}

export async function createServer(options: ServerOptions = {}): Promise<McpServer> {
  const store = options.store ?? (await createStore());
  // stdio is single-user: every request resolves to the same fixed caller.
  // The HTTP gateway overrides this with token-derived identity (P0-3, P0-7).
  const resolveCaller: ResolveCaller =
    options.resolveCaller ?? (() => options.caller ?? DEV_CALLER);
  const audit = options.audit ?? auditSinkFromEnv();
  const transport = options.transport ?? 'stdio';

  const server = new McpServer({ name: 'ekg-mcp', version: '0.1.0' });

  // Emit one audit event per call, best-effort — auditing must never throw
  // into the response path, but a gap must be visible, not silent (P0-7).
  function recordAudit(
    tool: string,
    args: unknown,
    extra: { authInfo?: AuthInfo } | undefined,
    result: unknown,
    errored: boolean,
  ): void {
    try {
      const caller = resolveCaller(extra?.authInfo);
      const { ids, outcome } = result ? summarizeResult(result) : { ids: [], outcome: 'error' as const };
      audit.record({
        ts: new Date().toISOString(),
        tenantId: caller.tenantId,
        principal: caller.principals[0] ?? 'unknown',
        tool,
        transport,
        args: summarizeArgs(args),
        ...(ids.length > 0 ? { resultIds: ids } : {}),
        outcome: errored ? 'error' : outcome,
      });
    } catch {
      /* identity unresolvable or sink unavailable — drop rather than fail the call */
    }
  }

  // Register a tool with audit wrapped around it. The generic mirrors
  // server.registerTool, so each handler keeps its Zod-inferred argument types
  // and no tool can be registered outside the audit boundary.
  function register<InputArgs extends ZodRawShapeCompat>(
    name: string,
    config: { title: string; description: string; inputSchema: InputArgs },
    cb: ToolCallback<InputArgs>,
  ): void {
    server.registerTool(name, config, (async (args, extra) => {
      try {
        const result = await cb(args, extra);
        recordAudit(name, args, extra, result, false);
        return result;
      } catch (err) {
        recordAudit(name, args, extra, undefined, true);
        throw err;
      }
    }) as ToolCallback<InputArgs>);
  }

  register(
    'search',
    {
      title: 'Search firm engineering knowledge',
      description:
        "Search the firm's engineering knowledge graph (projects, design details, specs, standards, " +
        'lessons learned, experts). Results include provenance and a workspace-app URL — always cite them. ' +
        'Results carrying a "warning" field are superseded/deprecated and the warning must be relayed to the user. ' +
        'If the response has no_results=true, say the firm graph has no answer; never substitute general knowledge. ' +
        'Pass `role` (a focus lens the firm admin defined, by name or id) to pivot ranking toward the knowledge ' +
        'that kind of work cares about — it only re-ranks, never hides results.',
      inputSchema: {
        query: z.string().describe('Natural-language or keyword query'),
        types: z
          .array(z.string())
          .optional()
          .describe('Optional entity-type filter, e.g. ["design-detail", "lesson-learned"]'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Optional tag filter — results must carry every listed tag, e.g. ["firestop"]'),
        role: z
          .string()
          .optional()
          .describe(
            'Optional retrieval role / focus lens (name or id), e.g. "Façade & Fire Safety". ' +
              'Boosts items the firm admin configured that lens to favor; ignored if unknown.',
          ),
        limit: z.number().int().min(1).max(25).optional(),
      },
    },
    async ({ query, types, tags, role, limit }, extra) => {
      const caller = resolveCaller(extra?.authInfo);
      const boostRole = await resolveRole(store, caller.tenantId, role);
      const hits = await store.search(caller, query, { types, tags, limit, boostRole });
      if (hits.length === 0) {
        return asContent({ results: [], no_results: true, guidance: NO_RESULTS_GUIDANCE });
      }
      return asContent({
        results: hits.map(searchResult),
        ...(boostRole ? { focusedBy: boostRole.name } : {}),
      });
    },
  );

  register(
    'fetch',
    {
      title: 'Fetch a knowledge item',
      description:
        'Fetch the full record for a knowledge-graph entity by id (ids come from search/traverse results). ' +
        'Returns properties, provenance, related entities, and the document section index. Long documents ' +
        'are split into passages (sections) — pass `section` to retrieve one passage in full, with its ' +
        'page/sheet/spec-section anchor for citation.',
      inputSchema: {
        id: z.string().describe('Entity id, e.g. "detail:cw-firestop-02"'),
        section: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Section ordinal (from the sections list) to return in full instead of the preview'),
      },
    },
    async ({ id, section }, extra) => {
      const caller = resolveCaller(extra?.authInfo);
      const entity = await store.getEntity(caller, id);
      if (!entity) {
        return asContent({ error: 'not_found', id });
      }
      const [related, chunks] = await Promise.all([
        store.neighbors(caller, id),
        store.getChunks(caller, id),
      ]);

      // A specific section in full (cited to its page/section), or the
      // entity preview when none requested (ADR 0006).
      const picked = section !== undefined ? chunks.find((c) => c.ordinal === section) : undefined;
      const provenance = citation(entity);
      if (picked) provenance.anchor = { ...provenance.anchor, ...picked.anchor };

      return asContent({
        id: entity.id,
        title: entity.title,
        text: picked?.text ?? entity.content ?? entity.summary ?? '',
        ...(picked ? { section: { ordinal: picked.ordinal, heading: picked.heading, anchor: picked.anchor } } : {}),
        url: appUrl(entity),
        metadata: {
          type: entity.type,
          properties: entity.properties,
          tags: entity.tags,
          provenance,
          // Section index so the model can pull the exact passage it needs.
          ...(chunks.length > 0
            ? {
                sectionCount: chunks.length,
                previewTruncated: (entity.content?.length ?? 0) < chunksTextLength(chunks),
                sections: chunks.slice(0, 60).map((c) => ({
                  ordinal: c.ordinal,
                  heading: c.heading,
                  anchor: c.anchor,
                })),
              }
            : {}),
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

  register(
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
    async ({ entityId, relationshipType }, extra) => {
      const caller = resolveCaller(extra?.authInfo);
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

  register(
    'find_experts',
    {
      title: 'Find firm experts on a topic',
      description:
        'Find the people in the firm who hold knowledge on a topic or discipline, each with the ' +
        'evidence for it — the details, specs, and lessons they authored that match the query. ' +
        'Use when the user asks who knows about X, who to ask, or who has done Y before. Every expert ' +
        'and every piece of evidence carries provenance and a workspace-app URL — cite them. ' +
        'If the response has no_results=true, tell the user the firm has no expert on record for this ' +
        'topic; never name someone the graph does not support.',
      inputSchema: {
        query: z.string().describe('Topic, discipline, or problem, e.g. "curtain wall firestop"'),
        discipline: z
          .string()
          .optional()
          .describe('Optional discipline filter, e.g. "facade engineering"'),
        limit: z.number().int().min(1).max(25).optional(),
      },
    },
    async ({ query, discipline, limit }, extra) => {
      const caller = resolveCaller(extra?.authInfo);
      // Cast a wide net for relevant knowledge, then resolve who authored it.
      // Expertise is read from the graph (authored-by edges, plus people who
      // match the query directly), never asserted — every expert ships with
      // the items that ground it (P0-8). v0 limitation: authorship recorded
      // only as `provenance.author` strings (no authored-by edge) is not yet
      // resolved to a person entity — that lands when ingest emits the edges.
      const hits = await store.search(caller, query, { limit: 15 });

      interface Expert {
        person: Entity;
        score: number;
        evidence: Map<string, { entity: Entity; score: number }>;
      }
      const experts = new Map<string, Expert>();
      const record = (person: Entity, score: number, source?: Entity) => {
        let e = experts.get(person.id);
        if (!e) {
          e = { person, score: 0, evidence: new Map() };
          experts.set(person.id, e);
        }
        e.score += score;
        if (source && !e.evidence.has(source.id)) {
          e.evidence.set(source.id, { entity: source, score });
        }
      };

      for (const hit of hits) {
        if (hit.entity.type === 'person') {
          // A person who matched the query directly (e.g. tagged "expert").
          record(hit.entity, hit.score);
          continue;
        }
        // Who authored this matching item? `authored-by` points item → person.
        const authors = await store.neighbors(caller, hit.entity.id, 'authored-by');
        for (const a of authors) {
          if (a.entity.type === 'person') record(a.entity, hit.score, hit.entity);
        }
      }

      let ranked = [...experts.values()];
      if (discipline) {
        const needle = discipline.toLowerCase();
        ranked = ranked.filter((e) => {
          const d = String(e.person.properties.discipline ?? '').toLowerCase();
          return d.includes(needle) || (e.person.tags ?? []).some((t) => t.toLowerCase().includes(needle));
        });
      }
      ranked.sort((a, b) => b.score - a.score || b.evidence.size - a.evidence.size);
      ranked = ranked.slice(0, limit ?? 5);

      if (ranked.length === 0) {
        return asContent({
          experts: [],
          no_results: true,
          guidance:
            'The firm knowledge graph records no expert on this topic. Tell the user the firm graph ' +
            'has no one on record — do NOT name a person the graph does not support (PRD P0-8).',
        });
      }

      return asContent({
        experts: ranked.map((e) => ({
          id: e.person.id,
          name: e.person.title,
          url: appUrl(e.person),
          summary: e.person.summary,
          discipline: e.person.properties.discipline,
          tags: e.person.tags,
          provenance: citation(e.person),
          // The authored knowledge that grounds this expertise: the model can
          // cite *why* we call them an expert, with stale items flagged.
          evidence: [...e.evidence.values()]
            .sort((a, b) => b.score - a.score)
            .map((ev) => relatedRef(ev.entity)),
        })),
      });
    },
  );

  register(
    'get_project_context',
    {
      title: 'Get the full context of a project',
      description:
        'Assemble a structured briefing for one project in a single call: the details and documents ' +
        'used on it, the specifications that apply, the issues and lessons learned, the standards its ' +
        'work complies with, the people who worked on it, and the client. Use when the user asks about ' +
        'a specific project. Pass projectId (from a search/traverse result) or query (the project name). ' +
        'Every item carries provenance and a workspace-app URL — cite them; items with a "warning" field ' +
        'are superseded/deprecated and the warning must be relayed.',
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe('Project entity id, e.g. "project:riverside" (from search/traverse results)'),
        query: z
          .string()
          .optional()
          .describe('Project name to resolve, used when projectId is unknown, e.g. "Riverside"'),
      },
    },
    async ({ projectId, query }, extra) => {
      const caller = resolveCaller(extra?.authInfo);
      // Resolve the project by id, or by name when the caller only knows it.
      let project: Entity | undefined;
      if (projectId) {
        project = await store.getEntity(caller, projectId);
        if (!project) return asContent({ error: 'not_found', projectId });
        if (project.type !== 'project') {
          return asContent({ error: 'not_a_project', id: project.id, type: project.type });
        }
      } else if (query) {
        const hits = await store.search(caller, query, { types: ['project'], limit: 5 });
        if (hits.length === 0) {
          return asContent({
            project: null,
            no_results: true,
            guidance:
              'No project in the firm knowledge graph matches this name. Tell the user the firm graph ' +
              'has no such project; do not substitute general knowledge (PRD P0-8).',
          });
        }
        project = hits[0].entity;
      } else {
        return asContent({ error: 'missing_argument', message: 'Pass projectId or query.' });
      }

      const neighbors = await store.neighbors(caller, project.id);

      type Ref = ReturnType<typeof relatedRef>;
      const detailsAndDocuments: Ref[] = [];
      const specifications: Ref[] = [];
      const issuesAndLessons: Ref[] = [];
      const otherRelated: Array<Ref & { relationship: string; direction: 'in' | 'out' }> = [];
      // Used items seed the second-degree lookups (who authored them, what
      // they comply with).
      const usedItems: Entity[] = [];

      for (const n of neighbors) {
        const ref = relatedRef(n.entity);
        if (n.relationship.type === 'used-in' && n.direction === 'in') {
          detailsAndDocuments.push(ref);
          usedItems.push(n.entity);
        } else if (n.relationship.type === 'applies-to' && n.direction === 'in') {
          specifications.push(ref);
        } else if (n.relationship.type === 'had-issue' && n.direction === 'out') {
          issuesAndLessons.push(ref);
        } else {
          otherRelated.push({ ...ref, relationship: n.relationship.type, direction: n.direction });
        }
      }

      // Second degree, bounded to the project's used items: the people who
      // authored them (the project team) and the standards they comply with.
      const team = new Map<string, Ref>();
      const standards = new Map<string, Ref>();
      for (const item of usedItems) {
        const links = await store.neighbors(caller, item.id);
        for (const l of links) {
          if (l.relationship.type === 'authored-by' && l.entity.type === 'person') {
            team.set(l.entity.id, relatedRef(l.entity));
          } else if (l.relationship.type === 'complies-with') {
            standards.set(l.entity.id, relatedRef(l.entity));
          }
        }
      }

      return asContent({
        project: {
          id: project.id,
          title: project.title,
          url: appUrl(project),
          summary: project.summary,
          type: project.type,
          properties: project.properties,
          tags: project.tags,
          provenance: citation(project),
        },
        client: project.properties.client,
        detailsAndDocuments,
        specifications,
        standards: [...standards.values()],
        issuesAndLessons,
        team: [...team.values()],
        ...(otherRelated.length > 0 ? { otherRelated } : {}),
        counts: {
          detailsAndDocuments: detailsAndDocuments.length,
          specifications: specifications.length,
          standards: standards.size,
          issuesAndLessons: issuesAndLessons.length,
          team: team.size,
        },
      });
    },
  );

  register(
    'ingest_document',
    {
      title: 'Ingest a document into firm knowledge',
      description:
        'Add a document (.pdf, .md, .txt) to the firm knowledge graph as an UNVERIFIED candidate — ' +
        'a curator must verify it in the workspace app before it counts as firm knowledge. ' +
        'Use when the user asks to add/ingest/file a document. For drawing sheets the result includes ' +
        'rendered images and instructions: describe the sheet, then call save_description.',
      inputSchema: {
        path: z
          .string()
          .describe('Path to the file on the machine running this MCP server'),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Sheet/page to render for description (default 1); re-call for other pages'),
        describe: z
          .boolean()
          .optional()
          .describe(
            'Force sheet rendering for description. Drawing sheets are auto-detected from ' +
              'sheet-number filenames and scans; pass true for drawing PDFs that are not (e.g. DOT standard plans)',
          ),
      },
    },
    async ({ path, page, describe }, extra) => {
      const caller = resolveCaller(extra?.authInfo);
      const filePath = isAbsolute(path) ? path : resolve(path);
      if (!existsSync(filePath)) {
        return asContent({ error: 'not_found', path: filePath });
      }
      if (!KNOWN_EXTENSIONS.has(extname(filePath).toLowerCase())) {
        return asContent({
          error: 'unsupported_extension',
          supported: [...KNOWN_EXTENSIONS],
        });
      }

      // OCR image-only PDFs when an engine is available so a scanned sheet's
      // description can be grounded and its text searched (review #1). Honest
      // no-op when no engine is installed — the scan stays needs-ocr.
      const ocr = await getPageOcr();
      const candidate = await buildCandidate(filePath, {
        tenantId: caller.tenantId,
        pipeline: 'mcp-gateway',
        ...(ocr ? { ocr } : {}),
      });
      await store.upsertEntity(candidate.entity, candidate.chunks);
      const entity = candidate.entity;

      // Cross-sheet callouts → `references` edges (ingestion Phase B),
      // resolved against what this tenant's graph already knows — a sheet
      // added from chat links to sheets ingested earlier.
      let referencesLinked = 0;
      let referencesUnresolved: string[] = [];
      if (candidate.references && candidate.references.length > 0) {
        const known = await store.list(caller);
        const { edges, unresolved } = buildReferenceEdges(
          [candidate],
          sheetIndex([...known, entity]),
          caller.tenantId,
        );
        for (const edge of edges) await store.upsertRelationship(edge);
        referencesLinked = edges.length;
        referencesUnresolved = unresolved;
      }

      // Drawing sheets (sheet-number anchor) and scans benefit from a visual
      // description by the calling model — the user's own AI subscription
      // does the reading; the gateway never needs an API key (ADR 0005).
      const isDrawing =
        candidate.parseStatus !== undefined &&
        (describe === true ||
          candidate.classification.anchor?.sheet !== undefined ||
          // Image-only PDFs (scans) still get a visual description even when OCR
          // recovered their text — the two are complementary (grounding now works).
          candidate.imageOnly === true);
      let images: { label: string; png: Buffer }[] = [];
      let rasterNote: string | undefined;
      if (isDrawing) {
        try {
          // Own-code vector renderer first — no external binary required
          // (ADR 0009); poppler is an automatic fallback only for image-only
          // pages our renderer cannot draw.
          const result = await rasterizeSheetForVision(filePath, page ?? 1);
          images = result.images;
          if (result.note) rasterNote = result.note;
        } catch (err) {
          rasterNote = `rasterization failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // VLM fusion (Phase C, ADR 0007): deterministic vector facts for the
      // rendered page, fed to the describing model as ground truth so it
      // narrates on top of them instead of re-reading identifiers from
      // pixels. A bonus — never block ingestion if extraction fails.
      let sheetFacts: SheetFacts | null = null;
      if (images.length > 0 && candidate.parseStatus === 'extracted') {
        try {
          sheetFacts = await extractSheetFacts(new Uint8Array(readFileSync(filePath)), page ?? 1);
        } catch {
          /* facts are enrichment, not a precondition */
        }
      }
      // Persist the rendered page's facts so save_description can verify the
      // model's annotations against them too — the parser feeds the prompt
      // AND checks the reading (ADR 0008). Chunks preserved (omitted arg).
      if (sheetFacts) {
        entity.properties.parserFacts = sheetFacts;
        await store.upsertEntity(entity);
      }

      const status = {
        status: 'queued_unverified',
        id: entity.id,
        title: entity.title,
        type: entity.type,
        tags: entity.tags,
        ...(candidate.parseStatus ? { parseStatus: candidate.parseStatus } : {}),
        ...(candidate.pageCount !== undefined ? { pageCount: candidate.pageCount } : {}),
        ...(referencesLinked > 0 ? { crossSheetReferencesLinked: referencesLinked } : {}),
        ...(referencesUnresolved.length > 0
          ? { crossSheetReferencesUnresolved: referencesUnresolved }
          : {}),
        url: appUrl(entity),
        imagesAttached: images.length,
        ...(sheetFacts ? { deterministicFacts: sheetFacts } : {}),
        ...(rasterNote ? { note: rasterNote } : {}),
        guidance:
          'Queued as unverified — a curator must verify it at the workspace /curation page before it is firm knowledge.' +
          (images.length > 0
            ? ' Sheet images follow: describe the sheet, then call save_description.'
            : ''),
      };

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(status, null, 2) },
          ...images.map((img) => ({
            type: 'image' as const,
            data: img.png.toString('base64'),
            mimeType: 'image/png' as const,
          })),
          ...(images.length > 0
            ? [
                {
                  type: 'text' as const,
                  text:
                    (sheetFacts ? `${formatSheetFacts(sheetFacts)}\n\n` : '') +
                    `Sheet renderings above (${images.map((i) => i.label).join('; ')}). ` +
                    'Describe what is drafted: views/details present, components, materials, and what the ' +
                    'annotations say. Then call save_description with `description` (plain language) and ' +
                    '`annotations` (labels, dimensions, callouts quoted VERBATIM from the sheet). Rules: ' +
                    'quote, never paraphrase identifiers or dimensions; do NOT count symbols or report ' +
                    'quantities; do NOT infer dimensions that are not printed; if a region is illegible, ' +
                    'say so instead of guessing. Make each quoted dimension or identifier ONE atomic ' +
                    "annotation — the bare printed value alone (e.g. `18'-11\"`), not bundled with " +
                    'descriptive words; put that context in the description. Atomic quotes verify; bundled ones do not.',
                },
              ]
            : []),
        ],
      };
    },
  );

  register(
    'save_description',
    {
      title: 'Save an AI-generated sheet description',
      description:
        'Store your description of an ingested drawing sheet. Quoted annotations are mechanically ' +
        'checked against the document text layer; ungrounded ones are flagged for curator review. ' +
        'The description is stored as unverified, machine-generated content.',
      inputSchema: {
        entityId: z.string().describe('Entity id returned by ingest_document'),
        description: z
          .string()
          .min(1)
          .describe('Plain-language description of what is drafted on the sheet'),
        annotations: z
          .array(z.string())
          .describe('Labels, dimensions, and callouts quoted VERBATIM from the sheet'),
        sheet: z
          .object({
            sheetNumber: z.string().optional(),
            title: z.string().optional(),
            discipline: z.string().optional(),
            revision: z.string().optional(),
          })
          .optional()
          .describe('Title-block metadata read from the sheet, if legible'),
      },
    },
    async ({ entityId, description, annotations, sheet }, extra) => {
      const caller = resolveCaller(extra?.authInfo);
      const entity = await store.getEntity(caller, entityId);
      if (!entity) {
        return asContent({ error: 'not_found', entityId });
      }

      // Ground against TWO sources, so the parser and vision model collaborate
      // (ADR 0008): the full document text (all chunks, not the bounded preview
      // — a description of page 200 must still be checkable, ADR 0006) AND the
      // deterministic parser facts stored at ingest. A quote the text layer
      // mangles (stacked fractions, ± suffixes) still grounds if the geometry
      // parse independently found it.
      const chunks = await store.getChunks(caller, entityId);
      const groundingSource = chunks.length > 0 ? chunksToText(chunks) : entity.content;
      const parserFacts = entity.properties.parserFacts as SheetFacts | undefined;
      const report = groundAnnotations(annotations, groundingSource, parserFacts);
      const updated: Entity = {
        ...entity,
        summary: `[AI-generated description — unverified] ${description}`.slice(0, 700),
        properties: {
          ...entity.properties,
          drawingDescription: description,
          descriptionSource: 'gateway-client-model',
          descriptionAnnotations: report.grounded,
          ...(report.parserConfirmed.length > 0
            ? { descriptionParserConfirmed: report.parserConfirmed }
            : {}),
          ...(report.ungrounded.length > 0
            ? { descriptionUngrounded: report.ungrounded }
            : {}),
          ...(sheet && Object.keys(sheet).length > 0 ? { sheet } : {}),
        },
        provenance: {
          ...entity.provenance,
          modifiedAt: new Date().toISOString(),
          // New machine-generated content always re-enters the curation queue.
          reviewStatus: 'unverified',
        },
      };
      await store.upsertEntity(updated);

      const confirmedNote =
        report.parserConfirmed.length > 0
          ? ` ${report.parserConfirmed.length} of them were independently confirmed by the geometry parser (strongest evidence).`
          : '';
      const guidance = !report.groundable
        ? 'No text layer or parser facts to ground against (scanned sheet) — the whole description is low-confidence pending curator review. Tell the user it is an unverified machine reading.'
        : report.ungrounded.length > 0
          ? `Some annotations were NOT confirmed by the document text layer or the geometry parse (listed in ungrounded). They are stored for curator review only — do not present them to the user as facts from the document.${confirmedNote}`
          : `All quoted annotations were confirmed against the document.${confirmedNote} Still unverified until a curator approves it.`;

      return asContent({
        entityId,
        url: appUrl(updated),
        stored: true,
        reviewStatus: 'unverified',
        groundable: report.groundable,
        grounded: report.grounded,
        parserConfirmed: report.parserConfirmed,
        ungrounded: report.ungrounded,
        guidance,
      });
    },
  );

  return server;
}
