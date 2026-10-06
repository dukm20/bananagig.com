// PostgreSQL access: pool, Kysely query builder, transaction helper, health check.
// Explicit SQL and explicit transactions: callers control isolation and row locks (FOR UPDATE).
// Contains no business models. Must not import web or application packages.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';

/** Application tables register here as features add them. Empty at INF-002. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DatabaseSchema {}

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';
export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  /** Stored in the `app.correlation_id` setting for the transaction so audit triggers can read it later. */
  correlationId?: string;
}
export interface QueryEvent {
  sql: string;
  durationMs: number;
  error?: unknown;
}
export interface DatabaseOptions {
  max?: number;
  onQuery?: (e: QueryEvent) => void;
  /** Supplies the correlation id when TransactionOptions.correlationId is absent. */
  correlationIdProvider?: () => string | undefined;
}

export type Trx = Transaction<DatabaseSchema>;

export class Database {
  readonly pool: pg.Pool;
  readonly kysely: Kysely<DatabaseSchema>;
  private readonly active = new AsyncLocalStorage<Trx>();

  constructor(
    connectionString: string,
    private readonly opts: DatabaseOptions = {},
  ) {
    this.pool = new pg.Pool({ connectionString, max: opts.max ?? 5 });
    this.pool.on('error', () => undefined); // idle client errors must not crash the process
    this.kysely = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool: this.pool }),
      log: (event) => {
        opts.onQuery?.({
          sql: event.query.sql,
          durationMs: event.queryDurationMillis,
          error: event.level === 'error' ? event.error : undefined,
        });
      },
    });
  }

  /** The current transaction if called inside `transaction()`, otherwise the pool-backed builder. */
  get db(): Kysely<DatabaseSchema> {
    return this.active.getStore() ?? this.kysely;
  }

  /**
   * Runs fn in a transaction; commits on resolve, rolls back on throw.
   * Nested calls join the outer transaction (isolation options of the outer call win).
   */
  async transaction<T>(fn: (trx: Trx) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const outer = this.active.getStore();
    if (outer) return fn(outer);
    const builder = this.kysely.transaction();
    const configured = options.isolationLevel ? builder.setIsolationLevel(options.isolationLevel) : builder;
    return configured.execute(async (trx) => {
      const correlationId = options.correlationId ?? this.opts.correlationIdProvider?.();
      if (correlationId) await sql`SELECT set_config('app.correlation_id', ${correlationId}, true)`.execute(trx);
      return this.active.run(trx, () => fn(trx));
    });
  }

  /** Raw parameterized query helper for infrastructure code. */
  async query<R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> {
    return (await this.pool.query(text, params)).rows as R[];
  }

  /** Readiness probe: can we run a trivial query within the timeout? */
  async health(timeoutMs = 2000): Promise<{ ok: boolean; error?: string }> {
    try {
      await Promise.race([this.pool.query('SELECT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${timeoutMs}ms`)), timeoutMs))]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async close(): Promise<void> {
    await this.kysely.destroy();
  }
}

export const createDatabase = (url: string, opts?: DatabaseOptions): Database => new Database(url, opts);
export { sql };
