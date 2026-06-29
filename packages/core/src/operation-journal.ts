import type { Chunk, Entity, Relationship } from './ontology.js';

/**
 * Change journal for admin/curator undo (PRD P0-9). Every mutation that runs
 * inside an operation records a BEFORE-IMAGE of each record it touches; undo
 * replays those images to restore the prior state — including a whole bulk
 * import as one reversible unit. The journal is a sibling of the graph store,
 * not part of it: the decorator ({@link JournaledGraphStore}) captures into it
 * and the executor ({@link undoOperation}) replays from it, so neither store
 * backend needs to know undo exists.
 */

/**
 * Namespaced key for a single touched record, so conflict detection never
 * confuses an entity id with a setting key. One image per key per operation
 * (first-write-wins captures the true pre-operation state).
 *   `entity:<id>` | `chunks:<id>` | `rel:<id>` | `setting:<tenant>/<key>`
 */
export type RecordKey = string;

export const entityKey = (id: string): RecordKey => `entity:${id}`;
export const chunksKey = (id: string): RecordKey => `chunks:${id}`;
export const relKey = (id: string): RecordKey => `rel:${id}`;
export const settingKey = (tenantId: string, key: string): RecordKey =>
  `setting:${tenantId}/${key}`;

/** The id half of a `entity:`/`chunks:`/`rel:` key. */
export function keyId(key: RecordKey): string {
  return key.slice(key.indexOf(':') + 1);
}

/**
 * The pre-operation state of one record. `existed: false` is a tombstone —
 * the record was created by the operation, so undo deletes it. Entity field
 * state and chunk state are tracked under separate keys (`entity:` / `chunks:`)
 * because `upsertEntity` can change fields while leaving chunks untouched
 * (ADR 0006); the executor rejoins them per entity id at undo time.
 */
export type BeforeImage =
  | { kind: 'entity'; existed: boolean; entity?: Entity }
  | { kind: 'chunks'; chunks: Chunk[] }
  | { kind: 'rel'; existed: boolean; rel?: Relationship }
  | { kind: 'setting'; tenantId: string; key: string; existed: boolean; value?: string };

/** The set of mutating actions an operation can wrap (drives the label/icon). */
export type OperationKind =
  | 'ingest-uploads'
  | 'import-csv'
  | 'edit-entity'
  | 'merge-entities'
  | 'remove-relationship'
  | 'verify-entity'
  | 'reject-entity'
  | 'supersede-entity'
  | 'deprecate-entity'
  | 'restore-entity'
  | 'capture-knowledge'
  | 'set-firm-name'
  | 'create-role'
  | 'update-role'
  | 'delete-role'
  | 'add-suggested-roles';

export type OperationStatus = 'pending' | 'active' | 'undone';

/** Metadata for the recent-changes list (no before-images loaded). */
export interface OperationSummary {
  id: string;
  tenantId: string;
  /** Human label, e.g. "Imported 12 documents". */
  label: string;
  kind: OperationKind;
  /** Principal that ran it, e.g. `user:dev`. */
  actor: string;
  /** ISO 8601 — supplied by the caller so the core stays clock-free. */
  createdAt: string;
  status: OperationStatus;
  /** How many records the operation touched (its undo footprint). */
  entryCount: number;
}

export interface OperationEntry {
  key: RecordKey;
  image: BeforeImage;
}

/** A summary plus the before-images needed to undo it. */
export interface OperationRecord extends OperationSummary {
  entries: OperationEntry[];
}

export interface OperationMeta {
  id: string;
  tenantId: string;
  label: string;
  kind: OperationKind;
  actor: string;
  createdAt: string;
}

/** How many operations to retain per tenant; older ones are pruned on commit. */
export const DEFAULT_OPERATION_RETENTION = 100;

export interface OperationJournal {
  /** Open an operation in `pending` state, before any mutation records into it. */
  begin(meta: OperationMeta): void;
  /** Record one record's before-image; first write per key wins (pre-op truth). */
  record(opId: string, key: RecordKey, image: BeforeImage): void;
  /**
   * Finalize: drop the operation if it recorded nothing (so a failed action
   * leaves no trace), otherwise mark it `active` and prune older ops beyond
   * `keep` for its tenant.
   */
  commit(opId: string, keep?: number): void;
  /** Active operations for a tenant, newest first. */
  list(tenantId: string, limit?: number): OperationSummary[];
  /** Full record with before-images, for undo. */
  get(opId: string): OperationRecord | undefined;
  markUndone(opId: string): void;
  /**
   * Keys touched by any active operation NEWER than `opId` (same tenant) —
   * undoing an older op that clashes with these would clobber the newer change,
   * so the executor blocks it unless forced.
   */
  newerActiveKeys(opId: string): Set<RecordKey>;
}

/**
 * True when `a` is newer than `b` by (createdAt, seq). Ties on the millisecond
 * createdAt break by a monotonic insertion sequence — NOT the random UUID id —
 * so two operations committed in the same millisecond still order
 * deterministically by when they happened. Otherwise "undo last" could target
 * the wrong one of two same-millisecond operations.
 */
function isNewer(
  a: { createdAt: string; seq: number },
  b: { createdAt: string; seq: number },
): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.seq > b.seq;
}

interface MemOp extends OperationMeta {
  status: OperationStatus;
  entries: Map<RecordKey, BeforeImage>;
  /** Monotonic insertion order — the deterministic tie-break within a createdAt. */
  seq: number;
}

/**
 * Dev/test journal mirroring {@link SqliteOperationJournal}. Holds before-images
 * by reference (no serialization) — fine for the ephemeral in-memory store.
 */
export class InMemoryOperationJournal implements OperationJournal {
  private ops = new Map<string, MemOp>();
  /** Monotonic counter for deterministic same-millisecond ordering. */
  private seq = 0;

  begin(meta: OperationMeta): void {
    this.ops.set(meta.id, { ...meta, status: 'pending', entries: new Map(), seq: this.seq++ });
  }

  record(opId: string, key: RecordKey, image: BeforeImage): void {
    const op = this.ops.get(opId);
    if (!op) return;
    if (!op.entries.has(key)) op.entries.set(key, image);
  }

  commit(opId: string, keep: number = DEFAULT_OPERATION_RETENTION): void {
    const op = this.ops.get(opId);
    if (!op) return;
    if (op.entries.size === 0) {
      this.ops.delete(opId);
      return;
    }
    op.status = 'active';
    const active = [...this.ops.values()]
      .filter((o) => o.tenantId === op.tenantId && o.status === 'active')
      .sort((a, b) => (isNewer(a, b) ? -1 : 1));
    for (const stale of active.slice(keep)) this.ops.delete(stale.id);
  }

  list(tenantId: string, limit?: number): OperationSummary[] {
    const out = [...this.ops.values()]
      .filter((o) => o.tenantId === tenantId && o.status === 'active')
      .sort((a, b) => (isNewer(a, b) ? -1 : 1))
      .map(toSummary);
    return limit === undefined ? out : out.slice(0, limit);
  }

  get(opId: string): OperationRecord | undefined {
    const op = this.ops.get(opId);
    if (!op) return undefined;
    return {
      ...toSummary(op),
      entries: [...op.entries.entries()].map(([key, image]) => ({ key, image })),
    };
  }

  markUndone(opId: string): void {
    const op = this.ops.get(opId);
    if (op) op.status = 'undone';
  }

  newerActiveKeys(opId: string): Set<RecordKey> {
    const target = this.ops.get(opId);
    const keys = new Set<RecordKey>();
    if (!target) return keys;
    for (const op of this.ops.values()) {
      if (op.tenantId !== target.tenantId || op.status !== 'active') continue;
      if (op.id === target.id || !isNewer(op, target)) continue;
      for (const key of op.entries.keys()) keys.add(key);
    }
    return keys;
  }
}

function toSummary(op: MemOp): OperationSummary {
  return {
    id: op.id,
    tenantId: op.tenantId,
    label: op.label,
    kind: op.kind,
    actor: op.actor,
    createdAt: op.createdAt,
    status: op.status,
    entryCount: op.entries.size,
  };
}
