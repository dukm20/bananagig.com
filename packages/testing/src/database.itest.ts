import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, sql, type Database } from '@bananagig/database';
import { ensureTestDatabase } from './index';

let db: Database;
beforeAll(async () => {
  db = createDatabase(await ensureTestDatabase());
  await db.query('DROP TABLE IF EXISTS tx_probe');
  await db.query('CREATE TABLE tx_probe (id int PRIMARY KEY, note text NOT NULL)'); // scratch table in the test database only
});
afterAll(async () => {
  await db.query('DROP TABLE IF EXISTS tx_probe');
  await db.close();
});
const count = async () => Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM tx_probe'))[0]!.n);

describe('database', () => {
  it('health check passes against a live database', async () => {
    expect(await db.health()).toEqual({ ok: true });
  });
  it('reports unhealthy for an unreachable database', async () => {
    const bad = createDatabase('postgres://nobody:x@127.0.0.1:1/none');
    expect((await bad.health(1500)).ok).toBe(false);
    await bad.close();
  });
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
  it('applies the requested isolation level and exposes the correlation id to the transaction', async () => {
    const r = await db.transaction(
      async (trx) => {
        const iso = await sql<{ transaction_isolation: string }>`SHOW transaction_isolation`.execute(trx);
        const cid = await sql<{ v: string }>`SELECT current_setting('app.correlation_id', true) AS v`.execute(trx);
        return { iso: iso.rows[0]!.transaction_isolation, cid: cid.rows[0]!.v };
      },
      { isolationLevel: 'serializable', correlationId: 'corr-itest-12345' },
    );
    expect(r).toEqual({ iso: 'serializable', cid: 'corr-itest-12345' });
  });
});
