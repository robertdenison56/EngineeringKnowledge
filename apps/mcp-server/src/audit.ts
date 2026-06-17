import { appendFileSync } from 'node:fs';

/**
 * Immutable per-request audit trail (PRD P0-7): who asked what, through which
 * gateway, and which knowledge items came back. Every tool call emits one
 * event, wired once at the handler boundary so no tool can be added without
 * being audited. The dev sink appends JSONL to a file (or stderr); production
 * swaps in a tamper-evident store without touching the call sites.
 */
export interface AuditEvent {
  /** ISO 8601 timestamp. */
  ts: string;
  /** Tenant the caller belongs to. */
  tenantId: string;
  /** The calling user principal (the token's subject). */
  principal: string;
  /** Tool invoked, e.g. "search". */
  tool: string;
  /** Gateway transport the call arrived on, e.g. "http" or "stdio". */
  transport: string;
  /** Redacted argument summary — enough to know what was asked. */
  args?: Record<string, unknown>;
  /** Ids of the entities surfaced to the caller. */
  resultIds?: string[];
  outcome: 'ok' | 'no_results' | 'error';
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
      console.error('ekg-mcp: audit write failed', err);
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
 * dropped.
 */
export function auditSinkFromEnv(): AuditSink {
  const path = process.env.EKG_AUDIT_LOG;
  return path ? new FileAuditSink(path) : new StderrAuditSink();
}
