import { appendFileSync } from 'node:fs';

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
  outcome: 'ok' | 'no_results' | 'error';
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
 * Build the audit sink from the environment. EKG_AUDIT_LOG points at an
 * append-only JSONL file (the immutable audit trail); without it, events go to
 * stderr so they are captured by the host's log pipeline and never silently
 * dropped. `fallbackPath` lets a surface pick its own default file (the
 * workspace app audits next to its database) while still honoring the env var.
 */
export function auditSinkFromEnv(fallbackPath?: string): AuditSink {
  const path = process.env.EKG_AUDIT_LOG ?? fallbackPath;
  return path ? new FileAuditSink(path) : new StderrAuditSink();
}
