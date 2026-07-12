import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { auditSinkFromEnv, type AuditEvent, type AuditSink } from '@ekg/core/audit';
import type { Caller } from '@ekg/core';

/**
 * Workspace-app slice of the P0-7 audit trail. Every mutating operation the
 * app runs ({@link runAsOperation} in lib/store.ts) records one event with the
 * same schema the MCP gateway writes, so one trail covers every surface that
 * can change firm knowledge — attributed to the request's authenticated
 * caller, never a fixed identity. Defaults to `.data/audit.jsonl` next to the
 * database; EKG_AUDIT_LOG relocates it (and can point at the same file the
 * gateway uses).
 */
const globalForAudit = globalThis as unknown as { __ekgAudit?: AuditSink };

function sink(): AuditSink {
  if (!globalForAudit.__ekgAudit) {
    const fallback = path.join(process.cwd(), '.data', 'audit.jsonl');
    if (!process.env.EKG_AUDIT_LOG) mkdirSync(path.dirname(fallback), { recursive: true });
    globalForAudit.__ekgAudit = auditSinkFromEnv(fallback);
  }
  return globalForAudit.__ekgAudit;
}

export function auditAction(
  caller: Caller,
  tool: string,
  options: {
    args?: Record<string, unknown>;
    resultIds?: string[];
    outcome?: AuditEvent['outcome'];
    snapshot?: unknown;
  } = {},
): void {
  sink().record({
    ts: new Date().toISOString(),
    tenantId: caller.tenantId,
    principal: caller.principals[0] ?? 'unknown',
    transport: 'web',
    tool,
    ...(options.args ? { args: options.args } : {}),
    ...(options.resultIds && options.resultIds.length > 0 ? { resultIds: options.resultIds } : {}),
    outcome: options.outcome ?? 'ok',
    ...(options.snapshot !== undefined ? { snapshot: options.snapshot } : {}),
  });
}
