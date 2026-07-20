import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AuditEvent } from '@ekg/core/audit';
import { parseAuditJsonl } from './analytics';

/**
 * Reads the audit trail the analytics aggregate over. Resolution mirrors the
 * WRITE side exactly (`lib/audit.ts` → `auditSinkFromEnv(fallback)`):
 * `EKG_AUDIT_LOG` wins, else the app's own `.data/audit.jsonl`. Guide 06 wires
 * the gateway at the same file, so one trail covers web + stdio + http — which
 * is what makes "per-gateway adoption" measurable at all.
 */
export function auditLogPath(): string {
  return process.env.EKG_AUDIT_LOG ?? path.join(process.cwd(), '.data', 'audit.jsonl');
}

/** How much of the tail to parse — enough for months of dev-scale traffic. */
const MAX_BYTES = 8 * 1024 * 1024;

export interface AuditTrailSlice {
  events: AuditEvent[];
  /** Where the trail was read from — disclosed on the page. */
  sourcePath: string;
  exists: boolean;
  /** True when the file outgrew MAX_BYTES and only the tail was parsed. */
  truncated: boolean;
}

/**
 * Parse (the tail of) the audit JSONL. A file larger than MAX_BYTES is read
 * from the end — the page discloses the truncation instead of silently
 * presenting a partial window as "all time".
 */
export function readAuditTrail(maxBytes = MAX_BYTES): AuditTrailSlice {
  const sourcePath = auditLogPath();
  if (!existsSync(sourcePath)) {
    return { events: [], sourcePath, exists: false, truncated: false };
  }
  const size = statSync(sourcePath).size;
  const truncated = size > maxBytes;
  const readFrom = truncated ? size - maxBytes : 0;
  const length = size - readFrom;
  const buffer = Buffer.alloc(length);
  const fd = openSync(sourcePath, 'r');
  try {
    readSync(fd, buffer, 0, length, readFrom);
  } finally {
    closeSync(fd);
  }
  let text = buffer.toString('utf8');
  // A mid-file start almost certainly lands mid-line; drop the torn head.
  if (truncated) text = text.slice(text.indexOf('\n') + 1);
  return { events: parseAuditJsonl(text), sourcePath, exists: true, truncated };
}
