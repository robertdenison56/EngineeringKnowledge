import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { auditSinkFromEnv, type AuditEvent, type AuditSink } from '@ekg/core';
import { DEV_CALLER } from './store';

/**
 * Workspace-app slice of the P0-7 audit trail. Every server action that
 * mutates the graph (verify, reject, edit, merge, ACL, lifecycle, capture,
 * upload) records one event with the same schema the MCP gateway writes, so
 * one trail covers every surface that can change firm knowledge. Defaults to
 * `.data/audit.jsonl` next to the database; EKG_AUDIT_LOG relocates it (and
 * can point at the same file the gateway uses).
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
    tenantId: DEV_CALLER.tenantId,
    principal: DEV_CALLER.principals[0] ?? 'unknown',
    transport: 'web',
    tool,
    ...(options.args ? { args: options.args } : {}),
    ...(options.resultIds && options.resultIds.length > 0 ? { resultIds: options.resultIds } : {}),
    outcome: options.outcome ?? 'ok',
    ...(options.snapshot !== undefined ? { snapshot: options.snapshot } : {}),
  });
}
