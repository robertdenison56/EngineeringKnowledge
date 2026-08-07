import { appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Immutable audit trail (PRD P0-7): who did what, through which surface, and
 * which knowledge items were touched. One event per gateway tool call and per
 * workspace-app mutation, so the trail covers every path that can read or
 * change the graph — not just the MCP gateways. The dev sink appends JSONL to
 * a file (or stderr); production swaps in a tamper-evident store without
 * touching the call sites.
 */
export interface AuditEvent {
  /** ISO 8601 timestamp. */
  ts: string;
  /** Tenant the caller belongs to. */
  tenantId: string;
  /** The calling user principal (the token's subject). */
  principal: string;
  /** Operation invoked, e.g. "search" (gateway tool) or "verify_entity" (app action). */
  tool: string;
  /** Surface the call arrived on, e.g. "http", "stdio", or "web". */
  transport: string;
  /** Redacted argument summary — enough to know what was asked. */
  args?: Record<string, unknown>;
  /** Ids of the entities surfaced to or changed by the caller. */
  resultIds?: string[];
  /**
   * `denied` is an authorization refusal (the caller lacked the role the
   * operation requires) — distinct from `error` so the trail separates
   * "refused an unauthorized write" from "the call blew up" (PRD P0-7).
   */
  outcome: 'ok' | 'no_results' | 'error' | 'denied';
  /**
   * Full snapshot of destroyed data (reject/merge), so a curator mistake is
   * recoverable from the trail even after the row is gone.
   */
  snapshot?: unknown;
}

export interface AuditSink {
  record(event: AuditEvent): void;
}

class FileAuditSink implements AuditSink {
  constructor(private readonly path: string) {}
  record(event: AuditEvent): void {
    try {
      appendFileSync(this.path, `${JSON.stringify(event)}\n`);
    } catch (err) {
      // Never let an audit-write failure break a response — but say so loudly,
      // because a silent gap in the audit trail is itself a P0-7 problem.
      console.error('ekg-audit: audit write failed', err);
    }
  }
}

class StderrAuditSink implements AuditSink {
  record(event: AuditEvent): void {
    console.error(`AUDIT ${JSON.stringify(event)}`);
  }
}

/**
 * Build the audit sink from the environment. Precedence:
 *
 *   1. EKG_AUDIT_LOG — an explicit append-only JSONL file always wins.
 *   2. `fallbackPath` — a surface's own default file (the workspace app passes
 *      `.data/audit.jsonl` next to its default database). Because an explicit
 *      fallback outranks the DB-derived default below, a consumer that already
 *      picks its own file keeps exactly its current behavior and can never be
 *      double-pointed at two files.
 *   3. Derived from EKG_DB_PATH — when the graph lives in a real database file
 *      (set, not ':memory:'), audit defaults to `audit.jsonl` in the same
 *      directory. This keeps the MCP gateway's trail durable next to the data
 *      it covers instead of silently vanishing to stderr when EKG_AUDIT_LOG is
 *      forgotten (P0-7).
 *   4. stderr — in-memory/unset-DB dev runs, captured by the host's log
 *      pipeline and never silently dropped.
 */
export function auditSinkFromEnv(fallbackPath?: string): AuditSink {
  const dbPath = process.env.EKG_DB_PATH;
  const dbDerived =
    dbPath && dbPath !== ':memory:' ? join(dirname(resolve(dbPath)), 'audit.jsonl') : undefined;
  const path = process.env.EKG_AUDIT_LOG ?? fallbackPath ?? dbDerived;
  return path ? new FileAuditSink(path) : new StderrAuditSink();
}
