import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@bananagig/config';
import { NatsClient } from '@bananagig/platform';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bananagig/testing';
import { Worker } from './worker';

// Real Postgres + NATS (pnpm dev:deps). pg-boss and the outbox live in this file's own isolated database.
let worker: Worker;
let iso: IsolatedDatabase;
beforeAll(async () => {
  iso = await createIsolatedDatabase();
  const cfg = loadConfig({
    service: 'bananagig-worker',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: iso.url,
      NATS_URL: process.env.NATS_URL ?? 'nats://localhost:14222',
      WORKER_ID: 'itest',
      OUTBOX_POLL_INTERVAL_MS: '100',
    },
  });
  worker = new Worker({ cfg, database: iso.database, nats: new NatsClient(cfg), boss: new PgBoss({ connectionString: iso.url, max: 3 }) });
  await worker.start();
});
afterAll(async () => {
  await worker.stop();
  await iso.drop();
});

describe('worker (integration)', () => {
  it('starts and reports ready', async () => {
    expect(await worker.readiness()).toEqual({ postgres: 'up', jobs: 'up', events: 'up' });
  });
  it('round-trips an infrastructure job, event and outbox-relayed event with correlation', async () => {
    const r = await worker.selfTest();
    expect(r).toMatchObject({ job: true, event: true, outbox: true });
  });
  it('stops gracefully and then reports not ready', async () => {
    const t = Date.now();
    await worker.stop();
    expect(Date.now() - t).toBeLessThan(12000);
    expect((await worker.readiness()).jobs).toBe('down');
  });
});
