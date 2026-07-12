import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_OPERATION_RETENTION,
  type BeforeImage,
  type OperationJournal,
  type OperationMeta,
  type OperationRecord,
  type OperationSummary,
  type RecordKey,
} from '@ekg/core';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_ops_tenant_created ON operations(tenant_id, status, created_at DESC);
CREATE TABLE IF NOT EXISTS operation_entries (
  op_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  record_key TEXT NOT NULL,
  before_json TEXT NOT NULL,
  PRIMARY KEY (op_id, record_key)
);
CREATE INDEX IF NOT EXISTS idx_entries_op ON operation_entries(op_id, seq);
CREATE INDEX IF NOT EXISTS idx_entries_key ON operation_entries(record_key);
`;

interface OpRow {
  id: string;
  tenant_id: string;
  label: string;
  kind: string;
  actor: string;
  created_at: string;
  status: string;
  entry_count: number;
}

/**
 * SQLite-backed {@link OperationJournal}, living in the SAME database file as the
 * graph it journals (constructed over the store's connection via
 * `SqliteGraphStore.createJournal()`), so before-images survive restarts and
 * stay consistent with the data. Before-images are stored as JSON, mirroring how
 * the store already serializes entities/provenance/acl into TEXT columns.
 *
 * `PRIMARY KEY (op_id, record_key)` makes `INSERT OR IGNORE` enforce
 * first-write-wins per record for free — the earliest image is the pre-operation
 * truth even when a record is written more than once in one operation.
 */
export class SqliteOperationJournal implements OperationJournal {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(SCHEMA);
  }

  begin(meta: OperationMeta): void {
    this.db
      .prepare(
        `INSERT INTO operations (id, tenant_id, label, kind, actor, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(meta.id, meta.tenantId, meta.label, meta.kind, meta.actor, meta.createdAt);
  }

  record(opId: string, key: RecordKey, image: BeforeImage): void {
    const seq = (
      this.db
        .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM operation_entries WHERE op_id = ?')
        .get(opId) as { n: number }
    ).n;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO operation_entries (op_id, seq, record_key, before_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(opId, seq, key, JSON.stringify(image));
  }

  commit(opId: string, keep: number = DEFAULT_OPERATION_RETENTION): void {
    const count = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM operation_entries WHERE op_id = ?')
        .get(opId) as { n: number }
    ).n;
    if (count === 0) {
      this.db.prepare('DELETE FROM operations WHERE id = ?').run(opId);
      return;
    }
    const op = this.db.prepare('SELECT tenant_id FROM operations WHERE id = ?').get(opId) as
      | { tenant_id: string }
      | undefined;
    if (!op) return;
    this.db.exec('BEGIN');
    try {
      this.db.prepare("UPDATE operations SET status = 'active' WHERE id = ?").run(opId);
      // Prune active operations beyond the newest `keep` for this tenant.
      const stale = this.db
        .prepare(
          `SELECT id FROM operations
           WHERE tenant_id = ? AND status = 'active'
           ORDER BY created_at DESC, rowid DESC
           LIMIT -1 OFFSET ?`,
        )
        .all(op.tenant_id, keep) as unknown as { id: string }[];
      const delEntries = this.db.prepare('DELETE FROM operation_entries WHERE op_id = ?');
      const delOp = this.db.prepare('DELETE FROM operations WHERE id = ?');
      for (const { id } of stale) {
        delEntries.run(id);
        delOp.run(id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  list(tenantId: string, limit?: number): OperationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT o.*, (SELECT COUNT(*) FROM operation_entries e WHERE e.op_id = o.id) AS entry_count
         FROM operations o
         WHERE o.tenant_id = ? AND o.status = 'active'
         ORDER BY o.created_at DESC, o.rowid DESC
         LIMIT ?`,
      )
      .all(tenantId, limit ?? -1) as unknown as OpRow[];
    return rows.map(toSummary);
  }

  get(opId: string): OperationRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT o.*, (SELECT COUNT(*) FROM operation_entries e WHERE e.op_id = o.id) AS entry_count
         FROM operations o WHERE o.id = ?`,
      )
      .get(opId) as OpRow | undefined;
    if (!row) return undefined;
    const entries = this.db
      .prepare('SELECT record_key, before_json FROM operation_entries WHERE op_id = ? ORDER BY seq')
      .all(opId) as unknown as { record_key: string; before_json: string }[];
    return {
      ...toSummary(row),
      entries: entries.map((e) => ({ key: e.record_key, image: JSON.parse(e.before_json) as BeforeImage })),
    };
  }

  markUndone(opId: string): void {
    this.db.prepare("UPDATE operations SET status = 'undone' WHERE id = ?").run(opId);
  }

  newerActiveKeys(opId: string): Set<RecordKey> {
    const target = this.db
      .prepare('SELECT tenant_id, created_at FROM operations WHERE id = ?')
      .get(opId) as { tenant_id: string; created_at: string } | undefined;
    const keys = new Set<RecordKey>();
    if (!target) return keys;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.record_key
         FROM operation_entries e JOIN operations o ON e.op_id = o.id
         WHERE o.tenant_id = ? AND o.status = 'active' AND o.id != ?
           AND (o.created_at > ? OR (o.created_at = ? AND o.id > ?))`,
      )
      .all(target.tenant_id, opId, target.created_at, target.created_at, opId) as unknown as {
      record_key: string;
    }[];
    for (const r of rows) keys.add(r.record_key);
    return keys;
  }
}

function toSummary(row: OpRow): OperationSummary {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    label: row.label,
    kind: row.kind as OperationSummary['kind'],
    actor: row.actor,
    createdAt: row.created_at,
    status: row.status as OperationSummary['status'],
    entryCount: row.entry_count,
  };
}
