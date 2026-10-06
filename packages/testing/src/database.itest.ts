import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectionBudget,
  createDatabase,
  POOL_POLICIES,
  sql,
  TransactionOptionError,
  type Database,
  type QueryEvent,
  type TransactionEvent,
} from '@bananagig/database';
import { createIsolatedDatabase, deferred, rejection, urlForDatabase, type IsolatedDatabase } from './index';

let iso: IsolatedDatabase;
let db: Database;
const count = async () => Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM tx_probe'))[0]!.n);

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  db = iso.database;
  await db.query('CREATE TABLE tx_probe (id int PRIMARY KEY, note text NOT NULL)'); // scratch table in this test's own database
});
afterAll(async () => {
  await iso.drop();
});

describe('database basics', () => {
  it('health check passes against a live database', async () => {
    expect(await db.health()).toEqual({ ok: true });
  });
  it('reports unhealthy for an unreachable database and notifies the pool-error hook', async () => {
    const errors: Error[] = [];
    const bad = createDatabase('postgres://nobody:x@127.0.0.1:1/none', { role: 'tests', onPoolError: (e) => errors.push(e) });
    expect((await bad.health(1500)).ok).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    await bad.close();
  });
  it('uses the role pool policy and exposes pool stats', async () => {
    expect(db.policy).toMatchObject({ max: POOL_POLICIES.tests.max, applicationName: 'bananagig-tests' });
    const app = (await db.query<{ application_name: string }>('SHOW application_name'))[0]!;
    expect(app.application_name).toBe('bananagig-tests');
    expect(db.poolStats().max).toBe(POOL_POLICIES.tests.max);
  });
  it('keeps the worst-case connection budget within the server max_connections', async () => {
    const max = Number((await db.query<{ max_connections: string }>('SHOW max_connections'))[0]!.max_connections);
    const reserved = Number(
      (await db.query<{ superuser_reserved_connections: string }>('SHOW superuser_reserved_connections'))[0]!.superuser_reserved_connections,
    );
    const budget = connectionBudget();
    expect(budget.total).toBeLessThanOrEqual(max - reserved);
  });
});

describe('transactions', () => {
  it('commits a successful transaction', async () => {
    await db.transaction(async (trx) => {
      await sql`INSERT INTO tx_probe VALUES (1, 'kept')`.execute(trx);
    });
    expect(await count()).toBe(1);
  });
  it('rolls back everything when the callback throws', async () => {
    await expect(
      db.transaction(async (trx) => {
        await sql`INSERT INTO tx_probe VALUES (2, 'lost')`.execute(trx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await count()).toBe(1);
  });
  it('rolls back on a constraint violation', async () => {
    await expect(
      db.transaction(async (trx) => {
        await sql`INSERT INTO tx_probe VALUES (3, 'lost')`.execute(trx);
        await sql`INSERT INTO tx_probe VALUES (1, 'duplicate pk')`.execute(trx);
      }),
    ).rejects.toThrow();
    expect(await count()).toBe(1);
  });
  it('joins nested transactions to the outer one (outer rollback undoes inner work)', async () => {
    await expect(
      db.transaction(async () => {
        await db.transaction(async (inner) => {
          await sql`INSERT INTO tx_probe VALUES (4, 'inner')`.execute(inner);
        });
        throw new Error('outer fails');
      }),
    ).rejects.toThrow('outer fails');
    expect(await count()).toBe(1);
  });
  it('rejects a nested call that asks for a different isolation level or read-write inside read-only', async () => {
    const a = await rejection(db.transaction(() => db.transaction(async () => undefined, { isolationLevel: 'serializable' })));
    expect(a).toBeInstanceOf(TransactionOptionError);
    const b = await rejection(db.transaction(() => db.transaction(async () => undefined, { readOnly: false }), { readOnly: true }));
    expect(b).toBeInstanceOf(TransactionOptionError);
  });
  it('defaults to read committed and applies explicit isolation levels', async () => {
    const iso = async (level?: 'repeatable read' | 'serializable') =>
      db.transaction(
        async (trx) => (await sql<{ transaction_isolation: string }>`SHOW transaction_isolation`.execute(trx)).rows[0]!.transaction_isolation,
        level ? { isolationLevel: level } : {},
      );
    expect(await iso()).toBe('read committed');
    expect(await iso('repeatable read')).toBe('repeatable read');
    expect(await iso('serializable')).toBe('serializable');
  });
  it('read-only transactions reject writes', async () => {
    const err = (await rejection(db.transaction((trx) => sql`INSERT INTO tx_probe VALUES (5, 'nope')`.execute(trx), { readOnly: true }))) as { code?: string };
    expect(err.code).toBe('25006'); // read_only_sql_transaction
    expect(await count()).toBe(1);
  });
  it('exposes the correlation id to the transaction (explicit option and provider)', async () => {
    const read = (trx: Parameters<Parameters<Database['transaction']>[0]>[0]) =>
      sql<{ v: string }>`SELECT current_setting('app.correlation_id', true) AS v`.execute(trx).then((r) => r.rows[0]!.v);
    expect(await db.transaction(read, { correlationId: 'corr-itest-12345' })).toBe('corr-itest-12345');
    const withProvider = createDatabase(iso.url, { role: 'tests', correlationIdProvider: () => 'from-provider-1' });
    expect(await withProvider.transaction(read)).toBe('from-provider-1');
    await withProvider.close();
  });
  it('emits transaction and query events', async () => {
    const tx: TransactionEvent[] = [];
    const q: QueryEvent[] = [];
    const observed = createDatabase(iso.url, { role: 'tests', onTransaction: (e) => tx.push(e), onQuery: (e) => q.push(e) });
    await observed.transaction((trx) => sql`SELECT 1`.execute(trx));
    await rejection(observed.transaction(async () => Promise.reject(new Error('x')), { isolationLevel: 'repeatable read' }));
    expect(tx.map((e) => [e.outcome, e.isolationLevel])).toEqual([
      ['commit', 'read committed'],
      ['rollback', 'repeatable read'],
    ]);
    expect(q.length).toBeGreaterThan(0);
    await observed.close();
  });
});

describe('timeouts', () => {
  it('statement_timeout from the pool policy cancels long statements', async () => {
    const fast = createDatabase(iso.url, { role: 'tests', overrides: { statementTimeoutMs: 200 } });
    const started = Date.now();
    const err = (await rejection(fast.query('SELECT pg_sleep(3)'))) as { code?: string };
    expect(err.code).toBe('57014'); // query_canceled
    expect(Date.now() - started).toBeLessThan(2500);
    await fast.close();
  });
  it('a per-transaction timeout overrides the pool default', async () => {
    const err = (await rejection(db.transaction((trx) => sql`SELECT pg_sleep(3)`.execute(trx), { timeoutMs: 200 }))) as { code?: string };
    expect(err.code).toBe('57014');
  });
  it('a per-transaction lock timeout bounds lock waits', async () => {
    const locked = deferred();
    const release = deferred();
    const holder = db.transaction(async (trx) => {
      await sql`SELECT * FROM tx_probe WHERE id = 1 FOR UPDATE`.execute(trx);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const err = (await rejection(db.transaction((trx) => sql`SELECT * FROM tx_probe WHERE id = 1 FOR UPDATE`.execute(trx), { lockTimeoutMs: 200 }))) as {
      code?: string;
    };
    expect(err.code).toBe('55P03'); // lock_not_available
    release.resolve();
    await holder;
  });
  it('connection acquisition is bounded by the connection timeout', async () => {
    const tiny = createDatabase(iso.url, { role: 'tests', overrides: { poolMax: 1, connectionTimeoutMs: 300 } });
    const hold = deferred();
    const release = deferred();
    const holder = tiny.transaction(async () => {
      hold.resolve();
      await release.promise;
    });
    await hold.promise;
    const err = (await rejection(tiny.query('SELECT 1'))) as Error;
    expect(err.message).toMatch(/timeout/i);
    release.resolve();
    await holder;
    await tiny.close();
  });
});

describe('isolation', () => {
  it('uses a database that is not the developer database', async () => {
    expect(iso.name.startsWith('bananagig_t_')).toBe(true);
    expect(iso.url).not.toBe(urlForDatabase('bananagig'));
    const rows = await db.query<{ n: string }>('SELECT count(*) AS n FROM public.schema_migrations');
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(3); // migrated from zero, not copied from dev data
  });
});
