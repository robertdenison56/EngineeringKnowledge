import { existsSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  DEMO_TENANT,
  InMemoryGraphStore,
  seedDemo,
  type Caller,
  type Chunk,
  type Entity,
  type GraphStore,
  type SearchHit,
} from '@ekg/core';
import {
  KNOWN_EXTENSIONS,
  buildCandidate,
  buildReferenceEdges,
  chunksToText,
  groundAnnotations,
  rasterizeSheet,
  rasterizerAvailable,
  sheetIndex,
} from '@ekg/ingestion';

/**
 * The canonical gateway (PRD P0-3). One MCP server serves Claude, ChatGPT,
 * and Microsoft 365 Copilot. `search` and `fetch` are named and shaped to
 * meet the ChatGPT connector spec; `traverse` exposes the graph structure.
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
  } else if (process.env.EKG_DB_PATH && process.env.EKG_DB_PATH !== ':memory:') {
    // Share the same persistent database the workspace app curates, so the
    // gateway serves curator-approved knowledge (point it at the app's
    // .data/ekg.db). Falls back to the seeded demo graph when unset.
    const { SqliteGraphStore, providerFromEnv } = await import('@ekg/store-sqlite');
    const sqlite = new SqliteGraphStore(process.env.EKG_DB_PATH, {
      embeddings: providerFromEnv(),
    });
    if (sqlite.countEntities(DEMO_TENANT) === 0) await seedDemo(sqlite);
    store = sqlite;
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
        tags: z
          .array(z.string())
          .optional()
          .describe('Optional tag filter — results must carry every listed tag, e.g. ["firestop"]'),
        limit: z.number().int().min(1).max(25).optional(),
      },
    },
    async ({ query, types, tags, limit }) => {
      const hits = await store.search(caller, query, { types, tags, limit });
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
    async ({ id, section }) => {
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

  server.registerTool(
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
    async ({ path, page, describe }) => {
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

      const candidate = await buildCandidate(filePath, {
        tenantId: caller.tenantId,
        pipeline: 'mcp-gateway',
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
          candidate.parseStatus === 'needs-ocr');
      let images: { label: string; png: Buffer }[] = [];
      let rasterNote: string | undefined;
      if (isDrawing) {
        if (!rasterizerAvailable()) {
          rasterNote =
            'pdftoppm (poppler) is not installed on the gateway host — sheet images unavailable, description skipped.';
        } else {
          try {
            images = rasterizeSheet(filePath, { page: page ?? 1 });
          } catch (err) {
            rasterNote = `rasterization failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
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
                    `Sheet renderings above (${images.map((i) => i.label).join('; ')}). ` +
                    'Describe what is drafted: views/details present, components, materials, and what the ' +
                    'annotations say. Then call save_description with `description` (plain language) and ' +
                    '`annotations` (labels, dimensions, callouts quoted VERBATIM from the sheet). Rules: ' +
                    'quote, never paraphrase identifiers or dimensions; do NOT count symbols or report ' +
                    'quantities; do NOT infer dimensions that are not printed; if a region is illegible, ' +
                    'say so instead of guessing.',
                },
              ]
            : []),
        ],
      };
    },
  );

  server.registerTool(
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
    async ({ entityId, description, annotations, sheet }) => {
      const entity = await store.getEntity(caller, entityId);
      if (!entity) {
        return asContent({ error: 'not_found', entityId });
      }

      // Ground against the full document text (all chunks), not the bounded
      // entity preview — a description of page 200 must still be checkable
      // (ADR 0006). Falls back to the preview for chunkless entities.
      const chunks = await store.getChunks(caller, entityId);
      const groundingSource = chunks.length > 0 ? chunksToText(chunks) : entity.content;
      const report = groundAnnotations(annotations, groundingSource);
      const updated: Entity = {
        ...entity,
        summary: `[AI-generated description — unverified] ${description}`.slice(0, 700),
        properties: {
          ...entity.properties,
          drawingDescription: description,
          descriptionSource: 'gateway-client-model',
          descriptionAnnotations: report.grounded,
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

      const guidance = !report.groundable
        ? 'No text layer to ground against (scanned sheet) — the whole description is low-confidence pending curator review. Tell the user it is an unverified machine reading.'
        : report.ungrounded.length > 0
          ? 'Some annotations were NOT found in the document text layer (listed in ungrounded). They are stored for curator review only — do not present them to the user as facts from the document.'
          : 'All quoted annotations were found in the document text layer. Still unverified until a curator approves it.';

      return asContent({
        entityId,
        url: appUrl(updated),
        stored: true,
        reviewStatus: 'unverified',
        groundable: report.groundable,
        grounded: report.grounded,
        ungrounded: report.ungrounded,
        guidance,
      });
    },
  );

  return server;
}
