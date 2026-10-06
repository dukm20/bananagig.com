import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@bananagig/config';
import { Worker } from './worker';
import { withJobMeta, jobHandler } from './runtime/job';
import { runWithCorrelation } from '@bananagig/observability';

const cfg = loadConfig({ service: 'bananagig-worker', env: { NODE_ENV: 'test', WORKER_ID: 'w-test', WORKER_CONCURRENCY: '3' } });
const fake = () => {
  const boss = { on: vi.fn(), start: vi.fn(), createQueue: vi.fn(), work: vi.fn(), stop: vi.fn(), send: vi.fn() };
  const nats = {
    connection: vi.fn(async () => ({
      subscribe: () => ({
        [Symbol.asyncIterator]: async function* () {
          /* no messages */
        },
      }),
    })),
    connected: true,
    ensureEventStream: vi.fn(),
    close: vi.fn(),
  };
  const database = { health: vi.fn(async () => ({ ok: true })) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const worker = new Worker({ cfg, database, nats, boss } as any);
  return { boss, nats, database, worker };
};

describe('worker lifecycle', () => {
  it('starts job and event runtimes with configured concurrency and reports ready', async () => {
    const { boss, worker } = fake();
    expect(await worker.readiness()).toMatchObject({ jobs: 'down' });
    await worker.start();
    expect(boss.start).toHaveBeenCalled();
    expect(boss.work).toHaveBeenCalledWith('infra.ping', { localConcurrency: 3 }, expect.any(Function));
    expect(worker.identity).toBe('w-test');
    expect(await worker.readiness()).toEqual({ postgres: 'up', jobs: 'up', events: 'up' });
  });
  it('stops gracefully and reports not ready afterwards', async () => {
    const { boss, nats, worker } = fake();
    await worker.start();
    await worker.stop();
    expect(boss.stop).toHaveBeenCalledWith({ graceful: true, timeout: 10000 });
    expect(nats.close).toHaveBeenCalled();
    expect((await worker.readiness()).jobs).toBe('down');
    await worker.stop(); // idempotent
    expect(boss.stop).toHaveBeenCalledTimes(1);
  });
  it('reports postgres down when the database is unreachable', async () => {
    const { database, worker } = fake();
    database.health.mockResolvedValue({ ok: false });
    await worker.start();
    expect((await worker.readiness()).postgres).toBe('down');
  });
});

describe('job correlation', () => {
  it('stamps correlation id on job data and restores it in the handler', async () => {
    const data = runWithCorrelation('corr-abcdef123', () => withJobMeta({ x: 1 }));
    expect(data._meta.correlationId).toBe('corr-abcdef123');
    const { getCorrelationId } = await import('@bananagig/observability');
    let seen: string | undefined;
    await jobHandler('t', async () => {
      seen = getCorrelationId();
    })([{ id: '1', data } as never]);
    expect(seen).toBe('corr-abcdef123');
  });
});

describe('configuration activation job', () => {
  it('registers a durable queue, a minute schedule and an idempotent handler', async () => {
    const { registerConfigurationJobs, CONFIGURATION_ACTIVATION_QUEUE, CONFIGURATION_ACTIVATION_CRON } = await import('./jobs/configuration');
    const handlers: Record<string, (jobs: unknown[]) => Promise<void>> = {};
    const boss = {
      createQueue: vi.fn(),
      schedule: vi.fn(),
      work: vi.fn(async (name: string, _o: unknown, h: (jobs: unknown[]) => Promise<void>) => void (handlers[name] = h)),
    };
    const activateDue = vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerConfigurationJobs(boss as any, { activateDue } as any);
    expect(boss.createQueue).toHaveBeenCalledWith(CONFIGURATION_ACTIVATION_QUEUE);
    expect(boss.schedule).toHaveBeenCalledWith(CONFIGURATION_ACTIVATION_QUEUE, CONFIGURATION_ACTIVATION_CRON);
    await handlers[CONFIGURATION_ACTIVATION_QUEUE]!([{ id: '1', data: null }]);
    await handlers[CONFIGURATION_ACTIVATION_QUEUE]!([{ id: '2', data: null }]); // running again with nothing due is harmless
    expect(activateDue).toHaveBeenCalledTimes(2);
  });
});
