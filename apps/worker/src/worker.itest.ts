import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@bananagig/config';
import { createDatabase } from '@bananagig/database';
import { NatsClient } from '@bananagig/platform';
import { ensureTestDatabase } from '@bananagig/testing';
import { Worker } from './worker';

// Real Postgres + NATS (pnpm dev:deps). Uses the isolated bananagig_test database for pg-boss.
let worker: Worker;
let database: ReturnType<typeof createDatabase>;
beforeAll(async () => {
  const url = await ensureTestDatabase();
  const cfg = loadConfig({
    service: 'bananagig-worker',
    env: { NODE_ENV: 'test', DATABASE_URL: url, NATS_URL: process.env.NATS_URL ?? 'nats://localhost:14222', WORKER_ID: 'itest' },
  });
  database = createDatabase(url);
  worker = new Worker({ cfg, database, nats: new NatsClient(cfg), boss: new PgBoss(url) });
  await worker.start();
});
afterAll(async () => {
  await worker.stop();
  await database.close();
});

describe('worker (integration)', () => {
  it('starts and reports ready', async () => {
    expect(await worker.readiness()).toEqual({ postgres: 'up', jobs: 'up', events: 'up' });
  });
  it('round-trips an infrastructure job and event with correlation', async () => {
    const r = await worker.selfTest();
    expect(r).toMatchObject({ job: true, event: true });
  });
  it('stops gracefully and then reports not ready', async () => {
    const t = Date.now();
    await worker.stop();
    expect(Date.now() - t).toBeLessThan(12000);
    expect((await worker.readiness()).jobs).toBe('down');
  });
});
