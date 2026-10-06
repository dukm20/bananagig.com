// Row-locking and advisory-lock helpers. Policy: docs/data/DATABASE_CONVENTIONS.md (locking, advisory locks).
import type { SelectQueryBuilder } from 'kysely';

/** Lock strength, weakest to strongest: key share < share < no key update < update. */
export type RowLockStrength = 'key share' | 'share' | 'no key update' | 'update';
/** What to do when a row is already locked: wait (bounded by lock_timeout), fail at once, or skip the row. */
export type RowLockWait = 'wait' | 'nowait' | 'skip locked';

/**
 * Applies a row lock clause to a SELECT. Allowed uses:
 *  - 'update'         : the row's non-key data will change or the row will be deleted (default for invariant-bearing rows
 *                       such as balances: read-then-write inside one transaction).
 *  - 'no key update'  : update non-key columns while allowing concurrent inserts of rows that reference this row via FK.
 *  - 'share'          : guarantee the row is not modified until commit, without modifying it.
 *  - 'key share'      : guarantee the key is not changed or the row deleted (what FK checks take).
 * Waiting:
 *  - 'wait'        default; always combine with a lock timeout (TransactionOptions.lockTimeoutMs or the pool policy).
 *  - 'nowait'      user-facing paths that should fail fast with a CONFLICT instead of queueing.
 *  - 'skip locked' ONLY for queue-like work distribution (outbox relay, job claiming). Never for balances, credit lots,
 *                  reservations or any read that must see every row: skipping silently hides rows.
 * Callers lock rows in a consistent order (table by table, then primary key ascending) to avoid deadlocks, and never hold
 * a lock across a network call.
 */
export function applyRowLock<DB, TB extends keyof DB, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  strength: RowLockStrength = 'update',
  wait: RowLockWait = 'wait',
): SelectQueryBuilder<DB, TB, O> {
  let q = strength === 'update' ? qb.forUpdate() : strength === 'no key update' ? qb.forNoKeyUpdate() : strength === 'share' ? qb.forShare() : qb.forKeyShare();
  if (wait === 'nowait') q = q.noWait();
  else if (wait === 'skip locked') q = q.skipLocked();
  return q;
}

/** PostgreSQL lock_not_available / deadlock_detected / query_canceled (statement or lock timeout) / serialization failure. */
export const PG_ERROR = { lockNotAvailable: '55P03', deadlockDetected: '40P01', serializationFailure: '40001', queryCanceled: '57014' } as const;

/** True when the error is a retryable concurrency failure (serialization failure or deadlock). */
export function isRetryableConcurrencyError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === PG_ERROR.serializationFailure || code === PG_ERROR.deadlockDetected;
}

/**
 * Registry of advisory-lock namespaces (first int of the two-int key). Adding one requires a docs update
 * (docs/data/DATABASE_CONVENTIONS.md). The migration runner uses the single-bigint key form, a separate key space.
 * Advisory locks are for singleton tasks and rebuilds only, never a substitute for row locks on financial state.
 */
export const ADVISORY_NAMESPACES = { maintenance: 1, projectionRebuild: 2, outboxPurge: 3 } as const;
export type AdvisoryNamespace = keyof typeof ADVISORY_NAMESPACES;
