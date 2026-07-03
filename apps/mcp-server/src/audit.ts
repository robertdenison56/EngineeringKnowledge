/**
 * Gateway audit trail (PRD P0-7). The event shape and sinks live in @ekg/core
 * so the workspace app's mutations audit into the same trail with the same
 * schema; this module re-exports them for the gateway's call sites.
 */
export { auditSinkFromEnv, type AuditEvent, type AuditSink } from '@ekg/core';
