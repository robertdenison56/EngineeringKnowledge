import type { AuditEvent } from '@ekg/core/audit';

/**
 * Usage analytics over the P0-7 audit trail (PRD P1-4, user story 11).
 *
 * Pure aggregation — the audit JSONL is the single source, nothing here
 * invents data the trail doesn't hold. Query "themes" are exact normalized
 * query strings grouped and counted, deterministically; no model in the loop.
 * Only type-only imports from @ekg/core so the module (and its tests) load
 * under Node's native type stripping.
 */

/** Gateway tools that surface knowledge to an assistant (vs. mutating it). */
export const READ_TOOLS = new Set([
  'search',
  'fetch',
  'traverse',
  'find_experts',
  'get_project_context',
]);

/** The workspace app's own transport label — everything else is a gateway. */
export const WEB_TRANSPORT = 'web';

export interface TransportUsage {
  transport: string;
  calls: number;
  /** Distinct principals seen on this transport — the honest adoption number. */
  principals: number;
  lastTs?: string;
}

export interface ToolUsage {
  tool: string;
  calls: number;
  errors: number;
}

export interface QueryStat {
  /** Latest raw spelling of the normalized query group. */
  query: string;
  count: number;
  lastTs: string;
}

export interface CitationStat {
  id: string;
  count: number;
}

export interface UsageAnalytics {
  totalCalls: number;
  distinctPrincipals: number;
  errorCount: number;
  /** Timestamps actually covered — so the page can disclose the window. */
  firstTs?: string;
  lastTs?: string;
  byTransport: TransportUsage[];
  byTool: ToolUsage[];
  topQueries: QueryStat[];
  /** Queries the graph had no answer for — the "capture this" signal. */
  zeroResultQueries: QueryStat[];
  /** Most-cited items across assistant surfaces (event-level counts). */
  topCited: CitationStat[];
}

export interface AnalyzeOptions {
  tenantId: string;
  /** Keep events at or after this ISO timestamp. */
  since?: string;
  /** List length for the top-N tables (default 10). */
  topN?: number;
}

/**
 * Tolerant JSONL parse: one malformed line (a torn write, a truncated tail)
 * must not hide the rest of the trail. Only object lines with the fields the
 * aggregations key on are kept.
 */
export function parseAuditJsonl(text: string): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AuditEvent;
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.ts === 'string' &&
        typeof parsed.tenantId === 'string' &&
        typeof parsed.tool === 'string'
      ) {
        events.push(parsed);
      }
    } catch {
      /* skip torn/foreign lines */
    }
  }
  return events;
}

function normalizeQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim();
}

function queryOf(event: AuditEvent): string | undefined {
  const q = event.args?.query;
  return typeof q === 'string' && q.trim() !== '' ? q : undefined;
}

function topQueryStats(byNorm: Map<string, QueryStat>, topN: number): QueryStat[] {
  return [...byNorm.values()]
    .sort((a, b) => b.count - a.count || b.lastTs.localeCompare(a.lastTs))
    .slice(0, topN);
}

/**
 * Event-level citation counts for one tenant: in how many assistant tool
 * results (read tools on non-web transports) each entity id appeared. The
 * workspace app's own reads are curation activity, not "cited in answers",
 * so `web` is excluded on purpose.
 */
export function citationCounts(events: AuditEvent[], tenantId: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.tenantId !== tenantId) continue;
    if (e.transport === WEB_TRANSPORT || !READ_TOOLS.has(e.tool)) continue;
    if (!Array.isArray(e.resultIds)) continue;
    for (const id of new Set(e.resultIds)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/** Aggregate one tenant's slice of the audit trail. */
export function analyzeUsage(events: AuditEvent[], options: AnalyzeOptions): UsageAnalytics {
  const { tenantId, since, topN = 10 } = options;
  const scoped = events
    .filter((e) => e.tenantId === tenantId && (!since || e.ts >= since))
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const principals = new Set<string>();
  const transports = new Map<string, { calls: number; principals: Set<string>; lastTs?: string }>();
  const tools = new Map<string, ToolUsage>();
  const queries = new Map<string, QueryStat>();
  const zeroResults = new Map<string, QueryStat>();
  let errorCount = 0;

  for (const e of scoped) {
    principals.add(e.principal);

    const t = transports.get(e.transport) ?? { calls: 0, principals: new Set<string>() };
    t.calls += 1;
    t.principals.add(e.principal);
    t.lastTs = e.ts;
    transports.set(e.transport, t);

    const tool = tools.get(e.tool) ?? { tool: e.tool, calls: 0, errors: 0 };
    tool.calls += 1;
    if (e.outcome === 'error') tool.errors += 1;
    tools.set(e.tool, tool);
    if (e.outcome === 'error') errorCount += 1;

    const q = queryOf(e);
    if (q && READ_TOOLS.has(e.tool)) {
      const norm = normalizeQuery(q);
      const bump = (map: Map<string, QueryStat>) => {
        const stat = map.get(norm) ?? { query: q, count: 0, lastTs: e.ts };
        stat.count += 1;
        stat.lastTs = e.ts;
        stat.query = q; // keep the latest raw spelling
        map.set(norm, stat);
      };
      bump(queries);
      if (e.outcome === 'no_results') bump(zeroResults);
    }
  }

  const cited = citationCounts(scoped, tenantId);

  return {
    totalCalls: scoped.length,
    distinctPrincipals: principals.size,
    errorCount,
    firstTs: scoped[0]?.ts,
    lastTs: scoped[scoped.length - 1]?.ts,
    byTransport: [...transports.entries()]
      .map(([transport, v]) => ({
        transport,
        calls: v.calls,
        principals: v.principals.size,
        lastTs: v.lastTs,
      }))
      .sort((a, b) => b.calls - a.calls),
    byTool: [...tools.values()].sort((a, b) => b.calls - a.calls),
    topQueries: topQueryStats(queries, topN),
    zeroResultQueries: topQueryStats(zeroResults, topN),
    topCited: [...cited.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
      .slice(0, topN),
  };
}
