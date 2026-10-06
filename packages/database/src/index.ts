// PostgreSQL access: pool policy, Kysely query builder, transaction helper, locking helpers, health, telemetry hooks.
// Explicit SQL and explicit transactions: callers own transaction boundaries and row locks. Repositories never open
// transactions on their own. Contains no business models. Must not import web or application packages.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { ADVISORY_NAMESPACES, type AdvisoryNamespace } from './locks';
import { resolvePolicy, type PolicyOverrides, type PoolPolicy, type PoolRole } from './policy';

export * from './locks';
export * from './policy';

/** Application tables register here as features add them. Empty until a feature adds tables. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DatabaseSchema {}

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  /** Default: read committed. See docs/data/DATABASE_CONVENTIONS.md for when to use the others. */
  isolationLevel?: IsolationLevel;
  readOnly?: boolean;
  /** Per-statement timeout for this transaction (SET LOCAL statement_timeout). */
  timeoutMs?: number;
  /** Maximum time to wait for any lock inside this transaction (SET LOCAL lock_timeout). */
  lockTimeoutMs?: number;
  /** Stored in the `app.correlation_id` setting so audit triggers can read it later. */
  correlationId?: string;
}

export interface QueryEvent {
  sql: string;
  durationMs: number;
  error?: unknown;
}
export interface TransactionEvent {
  durationMs: number;
  outcome: 'commit' | 'rollback';
  isolationLevel: IsolationLevel;
  readOnly: boolean;
  error?: unknown;
}
export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
  max: number;
}

export interface DatabaseOptions {
  role?: PoolRole;
  overrides?: PolicyOverrides;
  onQuery?: (e: QueryEvent) => void;
  onTransaction?: (e: TransactionEvent) => void;
  /** Connection-level errors (idle client errors, failed connects). */
  onPoolError?: (err: Error) => void;
  /** Supplies the correlation id when TransactionOptions.correlationId is absent. */
  correlationIdProvider?: () => string | undefined;
}

export type Trx = Transaction<DatabaseSchema>;
export class TransactionOptionError extends Error {}

interface ActiveTx {
  trx: Trx;
  isolationLevel: IsolationLevel;
  readOnly: boolean;
}

export class Database {
  readonly pool: pg.Pool;
  readonly kysely: Kysely<DatabaseSchema>;
  readonly policy: PoolPolicy;
  private readonly active = new AsyncLocalStorage<ActiveTx>();

  constructor(
    connectionString: string,
    private readonly opts: DatabaseOptions = {},
  ) {
    this.policy = resolvePolicy(opts.role ?? 'api', opts.overrides);
    this.pool = new pg.Pool({
      connectionString,
      max: this.policy.max,
      idleTimeoutMillis: this.policy.idleTimeoutMs,
      connectionTimeoutMillis: this.policy.connectionTimeoutMs,
      statement_timeout: this.policy.statementTimeoutMs,
      lock_timeout: this.policy.lockTimeoutMs,
      idle_in_transaction_session_timeout: this.policy.idleInTransactionTimeoutMs,
      application_name: this.policy.applicationName,
    });
    this.pool.on('error', (err) => opts.onPoolError?.(err)); // idle client errors must not crash the process
    this.kysely = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool: this.pool }),
      log: (event) => {
        opts.onQuery?.({ sql: event.query.sql, durationMs: event.queryDurationMillis, error: event.level === 'error' ? event.error : undefined });
      },
    });
  }

  /** The current transaction if called inside `transaction()`, otherwise the pool-backed builder. */
  get db(): Kysely<DatabaseSchema> {
    return this.active.getStore()?.trx ?? this.kysely;
  }

  get inTransaction(): boolean {
    return this.active.getStore() !== undefined;
  }

  poolStats(): PoolStats {
    return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount, max: this.policy.max };
  }

  /**
   * Runs fn in a transaction; commits on resolve, rolls back on throw.
   * Nesting: an inner call JOINS the outer transaction (no savepoint). An inner call may not ask for a different
   * isolation level or for read-write inside a read-only transaction: that throws TransactionOptionError.
   * Timeouts and correlation id of the outer call apply.
   */
  async transaction<T>(fn: (trx: Trx) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const outer = this.active.getStore();
    if (outer) {
      if (options.isolationLevel && options.isolationLevel !== outer.isolationLevel) {
        throw new TransactionOptionError(
          `nested transaction requested isolation "${options.isolationLevel}" but the enclosing transaction uses "${outer.isolationLevel}"`,
        );
      }
      if (options.readOnly === false && outer.readOnly)
        throw new TransactionOptionError('nested transaction requested read-write inside a read-only transaction');
      return fn(outer.trx);
    }
    const isolationLevel = options.isolationLevel ?? 'read committed';
    const readOnly = options.readOnly ?? false;
    let builder = this.kysely.transaction().setIsolationLevel(isolationLevel);
    if (readOnly) builder = builder.setAccessMode('read only');
    const started = performance.now();
    let outcome: TransactionEvent['outcome'] = 'commit';
    let failure: unknown;
    try {
      return await builder.execute(async (trx) => {
        const correlationId = options.correlationId ?? this.opts.correlationIdProvider?.();
        if (correlationId) await sql`SELECT set_config('app.correlation_id', ${correlationId}, true)`.execute(trx);
        if (options.timeoutMs !== undefined) await sql`SELECT set_config('statement_timeout', ${String(options.timeoutMs)}, true)`.execute(trx);
        if (options.lockTimeoutMs !== undefined) await sql`SELECT set_config('lock_timeout', ${String(options.lockTimeoutMs)}, true)`.execute(trx);
        return this.active.run({ trx, isolationLevel, readOnly }, () => fn(trx));
      });
    } catch (err) {
      outcome = 'rollback';
      failure = err;
      throw err;
    } finally {
      this.opts.onTransaction?.({ durationMs: performance.now() - started, outcome, isolationLevel, readOnly, error: failure });
    }
  }

  /**
   * Transaction-scoped advisory lock (released at commit/rollback). Blocks until acquired (bounded by lock_timeout).
   * Must be called inside `transaction()`.
   */
  async advisoryXactLock(namespace: AdvisoryNamespace, id = 0): Promise<void> {
    if (!this.inTransaction) throw new TransactionOptionError('advisoryXactLock must be called inside database.transaction()');
    await sql`SELECT pg_advisory_xact_lock(${ADVISORY_NAMESPACES[namespace]}, ${id})`.execute(this.db);
  }

  /**
   * Runs fn only if a session-level advisory lock can be taken without waiting (singleton tasks, controlled rebuilds).
   * Returns { acquired: false } when another session holds it. The lock is always released.
   */
  async withAdvisoryLock<T>(namespace: AdvisoryNamespace, id: number, fn: () => Promise<T>): Promise<{ acquired: true; result: T } | { acquired: false }> {
    const client = await this.pool.connect();
    const ns = ADVISORY_NAMESPACES[namespace];
    try {
      const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [ns, id]);
      if (!rows[0]?.ok) return { acquired: false };
      try {
        return { acquired: true, result: await fn() };
      } finally {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [ns, id]);
      }
    } finally {
      client.release();
    }
  }

  /** Raw parameterized query helper for infrastructure code. */
  async query<R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> {
    return (await this.pool.query(text, params)).rows as R[];
  }

  /** Readiness probe: can we run a trivial query within the timeout? */
  async health(timeoutMs = 2000): Promise<{ ok: boolean; error?: string }> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.pool.query('SELECT 1'),
        new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`timeout ${timeoutMs}ms`)), timeoutMs))),
      ]);
      return { ok: true };
    } catch (err) {
      this.opts.onPoolError?.(err instanceof Error ? err : new Error(String(err)));
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    await this.kysely.destroy();
  }
}

export const createDatabase = (url: string, opts?: DatabaseOptions): Database => new Database(url, opts);
export { sql };
export type { Kysely } from 'kysely';
