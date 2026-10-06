import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@bananagig/config';
import { Worker } from '../worker';
import { CONTENT_ACTIVATION_CRON, CONTENT_ACTIVATION_QUEUE, registerContentJobs } from './content';

const fakeBoss = () => {
  const handlers: Record<string, (jobs: unknown[]) => Promise<void>> = {};
  const boss = {
    createQueue: vi.fn(),
    schedule: vi.fn(),
    work: vi.fn(async (name: string, _o: unknown, h: (jobs: unknown[]) => Promise<void>) => void (handlers[name] = h)),
  };
  return { boss, handlers };
};

describe('content activation job', () => {
  it('registers a durable queue, an every-minute schedule and a handler', async () => {
    const { boss, handlers } = fakeBoss();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerContentJobs(boss as any, { activateDue: vi.fn() } as any, 2);
    expect(CONTENT_ACTIVATION_QUEUE).toBe('content.activate-due');
    expect(CONTENT_ACTIVATION_CRON).toBe('* * * * *');
    expect(boss.createQueue).toHaveBeenCalledWith(CONTENT_ACTIVATION_QUEUE);
    expect(boss.schedule).toHaveBeenCalledWith(CONTENT_ACTIVATION_QUEUE, CONTENT_ACTIVATION_CRON);
    expect(boss.work).toHaveBeenCalledWith(CONTENT_ACTIVATION_QUEUE, { localConcurrency: 2 }, expect.any(Function));
    expect(Object.keys(handlers)).toEqual([CONTENT_ACTIVATION_QUEUE]);
  });
  it('calls activateDue on every run; running again with nothing due is harmless', async () => {
    const { boss, handlers } = fakeBoss();
    const activateDue = vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerContentJobs(boss as any, { activateDue } as any);
    await handlers[CONTENT_ACTIVATION_QUEUE]!([{ id: '1', data: null }]);
    await handlers[CONTENT_ACTIVATION_QUEUE]!([{ id: '2', data: null }]);
    expect(activateDue).toHaveBeenCalledTimes(2);
  });
  it('lets an activation failure surface so pg-boss records the failure and retries', async () => {
    const { boss, handlers } = fakeBoss();
    const activateDue = vi.fn().mockRejectedValue(new Error('database unavailable'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerContentJobs(boss as any, { activateDue } as any);
    await expect(handlers[CONTENT_ACTIVATION_QUEUE]!([{ id: '1', data: null }])).rejects.toThrow('database unavailable');
  });
});

describe('worker wiring', () => {
  const cfg = loadConfig({ service: 'bananagig-worker', env: { NODE_ENV: 'test', WORKER_ID: 'w-test' } });
  const build = (withContent: boolean) => {
    const boss = { on: vi.fn(), start: vi.fn(), createQueue: vi.fn(), schedule: vi.fn(), work: vi.fn(), stop: vi.fn(), send: vi.fn() };
    const nats = { connection: vi.fn(), connected: true, ensureEventStream: vi.fn(), close: vi.fn() };
    const database = { health: vi.fn(async () => ({ ok: true })) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const worker = new Worker({ cfg, database, nats, boss, ...(withContent ? { content: { activateDue: vi.fn() } } : {}) } as any);
    return { boss, nats, worker };
  };
  it('registers the content activation job at start when a content service is provided', async () => {
    const { boss, nats, worker } = build(true);
    nats.connection.mockResolvedValue({ subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) });
    await worker.start();
    expect(boss.createQueue).toHaveBeenCalledWith(CONTENT_ACTIVATION_QUEUE);
    expect(boss.schedule).toHaveBeenCalledWith(CONTENT_ACTIVATION_QUEUE, CONTENT_ACTIVATION_CRON);
  });
  it('does not register it without a content service', async () => {
    const { boss, nats, worker } = build(false);
    nats.connection.mockResolvedValue({ subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) });
    await worker.start();
    expect(boss.schedule).not.toHaveBeenCalled();
  });
});
