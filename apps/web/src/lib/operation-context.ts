import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Caller, OperationContext, OperationJournal, OperationKind } from '@ekg/core';

/**
 * Request-scoped operation grouping for undo (PRD P0-9). A server action wraps
 * its mutating body in {@link runInOperation}; every `store.*` write that runs
 * inside — even across awaits and across a whole bulk-import loop — shares one
 * operation id, so the {@link JournaledGraphStore} files all their before-images
 * under it and the batch undoes as a single unit.
 *
 * AsyncLocalStorage gives true per-request isolation: two concurrent uploads get
 * two independent operations with no cross-talk — strictly safer than a module
 * variable. This module is server-only (node:async_hooks) and never imported by
 * a client component.
 *
 * The ALS is pinned to globalThis so the decorator (which captured the accessor
 * at store-init) and `runInOperation` always share ONE instance — Next dev can
 * otherwise load this module twice and silently break context propagation.
 */
const globalForAls = globalThis as unknown as {
  __ekgOperationAls?: AsyncLocalStorage<OperationContext>;
};
const als = (globalForAls.__ekgOperationAls ??= new AsyncLocalStorage<OperationContext>());

/** The operation the current async call tree runs inside, if any. */
export function currentOperation(): OperationContext | undefined {
  return als.getStore();
}

export interface OperationMetaInput {
  label: string;
  kind: OperationKind;
  caller: Caller;
}

/**
 * Run `fn` as one journaled operation. Opens the operation, binds it to the
 * async context, and finalizes on the way out — `commit` drops the operation if
 * nothing was recorded (a failed action leaves no trace) and keeps a partial
 * batch otherwise (still undoable). A thrown `redirect()`/`notFound()` is a
 * control-flow signal raised AFTER the mutation, so we finalize and re-raise it
 * unchanged.
 */
export async function runInOperation<T>(
  journal: OperationJournal,
  meta: OperationMetaInput,
  fn: () => Promise<T>,
): Promise<T> {
  const opId = randomUUID();
  const actor = meta.caller.principals.find((p) => p.startsWith('user:')) ?? meta.caller.principals[0] ?? 'unknown';
  journal.begin({
    id: opId,
    tenantId: meta.caller.tenantId,
    label: meta.label,
    kind: meta.kind,
    actor,
    createdAt: new Date().toISOString(),
  });
  try {
    const result = await als.run({ opId, caller: meta.caller }, fn);
    journal.commit(opId);
    return result;
  } catch (err) {
    journal.commit(opId);
    throw err;
  }
}
