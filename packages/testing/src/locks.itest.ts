import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyRowLock, isRetryableConcurrencyError, sql, type Database, type Kysely, type Trx } from '@bananagig/database';
import { createIsolatedDatabase, deferred, rejection, type Deferred, type IsolatedDatabase } from './index';

type Probe = Kysely<{ lock_probe: { id: number; note: string } }>;
const probe = (trx: Trx) => trx as unknown as Probe;

let iso: IsolatedDatabase;
let db: Database;
beforeAll(async () => {
  iso = await createIsolatedDatabase();
  db = iso.database;
  await db.query('CREATE TABLE lock_probe (id int PRIMARY KEY, note text NOT NULL)');
  await db.query("INSERT INTO lock_probe VALUES (1, 'a'), (2, 'b'), (3, 'c')");
});
afterAll(async () => {
  await iso.drop();
});

/** Holds FOR UPDATE on the given ids until release() is called. */
async function hold(ids: number[]) {
  const locked = deferred();
  const release = deferred();
  const done = db.transaction(async (trx) => {
    await sql`SELECT * FROM lock_probe WHERE id = ANY(${ids}) FOR UPDATE`.execute(trx);
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  return { release: () => release.resolve(), done };
}

describe('row locks', () => {
  it('FOR UPDATE NOWAIT fails immediately when the row is locked', async () => {
    const h = await hold([1]);
    const err = (await rejection(
      db.transaction((trx) => applyRowLock(probe(trx).selectFrom('lock_probe').selectAll().where('id', '=', 1), 'update', 'nowait').execute()),
    )) as { code?: string };
    expect(err.code).toBe('55P03');
    h.release();
    await h.done;
  });
  it('FOR UPDATE waits for the holder and then proceeds', async () => {
    const h = await hold([2]);
    const waiter = db.transaction((trx) => applyRowLock(probe(trx).selectFrom('lock_probe').selectAll().where('id', '=', 2), 'update').execute(), {
      lockTimeoutMs: 5000,
    });
    let finished = false;
    void waiter.then(() => (finished = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(finished).toBe(false); // still blocked
    h.release();
    expect((await waiter).map((r) => r.id)).toEqual([2]);
    await h.done;
  });
  it('SKIP LOCKED returns only rows nobody holds (queue-style claiming)', async () => {
    const h = await hold([1]);
    const rows = await db.transaction((trx) => applyRowLock(probe(trx).selectFrom('lock_probe').selectAll().orderBy('id'), 'update', 'skip locked').execute());
    expect(rows.map((r) => r.id)).toEqual([2, 3]);
    h.release();
    await h.done;
  });
  it('FOR SHARE allows concurrent shared locks but blocks FOR UPDATE', async () => {
    const locked = deferred();
    const release = deferred();
    const holder = db.transaction(async (trx) => {
      await applyRowLock(probe(trx).selectFrom('lock_probe').selectAll().where('id', '=', 3), 'share').execute();
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const share = await db.transaction((trx) => applyRowLock(probe(trx).selectFrom('lock_probe').selectAll().where('id', '=', 3), 'share', 'nowait').execute());
    expect(share).toHaveLength(1);
    const err = (await rejection(
      db.transaction((trx) => applyRowLock(probe(trx).selectFrom('lock_probe').selectAll().where('id', '=', 3), 'update', 'nowait').execute()),
    )) as { code?: string };
    expect(err.code).toBe('55P03');
    release.resolve();
    await holder;
  });
  it('FOR NO KEY UPDATE does not block FOR KEY SHARE (what foreign-key checks take)', async () => {
    const locked = deferred();
    const release = deferred();
    const holder = db.transaction(async (trx) => {
      await applyRowLock(probe(trx).selectFrom('lock_probe').selectAll().where('id', '=', 1), 'no key update').execute();
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const rows = await db.transaction((trx) =>
      applyRowLock(probe(trx).selectFrom('lock_probe').selectAll().where('id', '=', 1), 'key share', 'nowait').execute(),
    );
    expect(rows).toHaveLength(1);
    release.resolve();
    await holder;
  });
  it('detects deadlocks as retryable concurrency errors', async () => {
    const aHas1 = deferred();
    const bHas2 = deferred();
    const a = db.transaction(async (trx) => {
      await sql`SELECT * FROM lock_probe WHERE id = 1 FOR UPDATE`.execute(trx);
      aHas1.resolve();
      await bHas2.promise;
      await sql`SELECT * FROM lock_probe WHERE id = 2 FOR UPDATE`.execute(trx);
    });
    const b = db.transaction(async (trx) => {
      await aHas1.promise;
      await sql`SELECT * FROM lock_probe WHERE id = 2 FOR UPDATE`.execute(trx);
      bHas2.resolve();
      await sql`SELECT * FROM lock_probe WHERE id = 1 FOR UPDATE`.execute(trx);
    });
    const results = await Promise.all([rejection(a), rejection(b)]);
    const failures = results.filter(Boolean);
    expect(failures).toHaveLength(1); // PostgreSQL aborts exactly one victim
    expect(isRetryableConcurrencyError(failures[0])).toBe(true);
    expect((failures[0] as { code?: string }).code).toBe('40P01');
  });
  it('SERIALIZABLE aborts write skew with a retryable serialization failure', async () => {
    await db.query('CREATE TABLE skew (id serial PRIMARY KEY, grp int NOT NULL)');
    const oneRead = deferred();
    const twoRead = deferred();
    const t = (own: Deferred, other: Deferred) =>
      db.transaction(
        async (trx) => {
          await sql`SELECT count(*) FROM skew WHERE grp = 1`.execute(trx);
          own.resolve();
          await other.promise;
          await sql`INSERT INTO skew (grp) VALUES (1)`.execute(trx);
        },
        { isolationLevel: 'serializable' },
      );
    const results = await Promise.all([rejection(t(oneRead, twoRead)), rejection(t(twoRead, oneRead))]);
    const failures = results.filter(Boolean);
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures.every(isRetryableConcurrencyError)).toBe(true);
  });
});

describe('advisory locks', () => {
  it('withAdvisoryLock runs once and refuses while another session holds the lock', async () => {
    const entered = deferred();
    const release = deferred();
    const first = db.withAdvisoryLock('maintenance', 42, async () => {
      entered.resolve();
      await release.promise;
      return 'first';
    });
    await entered.promise;
    expect(await db.withAdvisoryLock('maintenance', 42, async () => 'second')).toEqual({ acquired: false });
    expect(await db.withAdvisoryLock('maintenance', 43, async () => 'other-id')).toEqual({ acquired: true, result: 'other-id' });
    release.resolve();
    expect(await first).toEqual({ acquired: true, result: 'first' });
    expect(await db.withAdvisoryLock('maintenance', 42, async () => 'again')).toEqual({ acquired: true, result: 'again' }); // released
  });
  it('advisoryXactLock requires a transaction and serializes holders until commit', async () => {
    expect((await rejection(db.advisoryXactLock('projectionRebuild', 1))) as Error).toBeInstanceOf(Error);
    const order: string[] = [];
    const locked = deferred();
    const release = deferred();
    const a = db.transaction(async () => {
      await db.advisoryXactLock('projectionRebuild', 7);
      order.push('a-locked');
      locked.resolve();
      await release.promise;
      order.push('a-done');
    });
    await locked.promise;
    const b = db.transaction(
      async () => {
        await db.advisoryXactLock('projectionRebuild', 7);
        order.push('b-locked');
      },
      { lockTimeoutMs: 5000 },
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(order).toEqual(['a-locked']);
    release.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a-locked', 'a-done', 'b-locked']);
  });
});
