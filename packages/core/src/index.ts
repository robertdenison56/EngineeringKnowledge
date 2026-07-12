export * from './ontology.js';
export * from './graph-store.js';
// Audit's sink writes JSONL via node:fs, so its runtime lives behind the
// '@ekg/core/audit' subpath — the barrel stays importable from client
// bundles (the web app's components import '@ekg/core'). Types are erased
// at compile time and safe to re-export here.
export type { AuditEvent, AuditSink } from './audit.js';
export * from './roles.js';
export * from './matching.js';
export * from './embeddings.js';
export * from './memory-store.js';
export * from './operation-journal.js';
export * from './journaled-store.js';
export * from './undo-executor.js';
export * from './seed.js';
export * from './golden.js';
