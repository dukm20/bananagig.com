import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@bananagig/config';
import { PROVIDER_GIG_MEDIA_POLICY_KEYS, PROVIDER_GIG_OPTIONS_POLICY_KEYS, PROVIDER_GIG_POLICY_KEYS } from '@bananagig/contracts';
import { DEFAULT_GIG_MEDIA_POLICY, GigError } from '@bananagig/provider';
import { Worker } from '../worker';
import { GIG_MEDIA_CLEANUP_CRON, GIG_MEDIA_CLEANUP_LIMIT, GIG_MEDIA_CLEANUP_QUEUE, createWorkerGigPolicy, registerGigMediaJobs } from './gig-media';

// every log call of the code under test is captured (mutation-testing additions: the job logs counts only, and only when it did something)
const logSink = vi.hoisted(() => ({ calls: [] as { level: string; message: string; attrs: Record<string, unknown> }[] }));
vi.mock('@bananagig/observability', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    log: (level: string, message: string, attrs: Record<string, unknown> = {}) => {
      logSink.calls.push({ level, message, attrs });
    },
  };
});

const fakeBoss = () => {
  const handlers: Record<string, (jobs: unknown[]) => Promise<void>> = {};
  const boss = {
    createQueue: vi.fn(),
    schedule: vi.fn(),
    work: vi.fn(async (name: string, _o: unknown, h: (jobs: unknown[]) => Promise<void>) => void (handlers[name] = h)),
  };
  return { boss, handlers };
};

describe('gig media clean-up job', () => {
  it('registers a durable queue, an every-15-minutes schedule and a handler', async () => {
    const { boss, handlers } = fakeBoss();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerGigMediaJobs(boss as any, { cleanup: vi.fn() }, 2);
    expect(GIG_MEDIA_CLEANUP_QUEUE).toBe('provider.gig-media-cleanup');
    expect(GIG_MEDIA_CLEANUP_CRON).toBe('*/15 * * * *');
    expect(boss.createQueue).toHaveBeenCalledWith(GIG_MEDIA_CLEANUP_QUEUE);
    expect(boss.schedule).toHaveBeenCalledWith(GIG_MEDIA_CLEANUP_QUEUE, GIG_MEDIA_CLEANUP_CRON);
    expect(boss.work).toHaveBeenCalledWith(GIG_MEDIA_CLEANUP_QUEUE, { localConcurrency: 2 }, expect.any(Function));
    expect(Object.keys(handlers)).toEqual([GIG_MEDIA_CLEANUP_QUEUE]);
  });
  it('runs the clean-up with the batch limit on every run; running again with nothing to do is harmless', async () => {
    const { boss, handlers } = fakeBoss();
    const cleanup = vi
      .fn()
      .mockResolvedValueOnce({ abandoned: 3, deleted: 1, reconciled: 2 })
      .mockResolvedValueOnce({ abandoned: 0, deleted: 0, reconciled: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerGigMediaJobs(boss as any, { cleanup });
    await handlers[GIG_MEDIA_CLEANUP_QUEUE]!([{ id: '1', data: null }]);
    await handlers[GIG_MEDIA_CLEANUP_QUEUE]!([{ id: '2', data: null }]);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledWith({ limit: GIG_MEDIA_CLEANUP_LIMIT });
    expect(GIG_MEDIA_CLEANUP_LIMIT).toBeGreaterThan(0);
  });
  it('keeps its batch inside what the service accepts (the service clamps at 1000) and logs counts only, and only when it did something', async () => {
    expect(GIG_MEDIA_CLEANUP_LIMIT).toBeGreaterThan(0);
    expect(GIG_MEDIA_CLEANUP_LIMIT).toBeLessThanOrEqual(1000);
    const { boss, handlers } = fakeBoss();
    const cleanup = vi
      .fn()
      .mockResolvedValueOnce({ abandoned: 0, deleted: 0, reconciled: 0 })
      .mockResolvedValueOnce({ abandoned: 3, deleted: 1 })
      .mockResolvedValueOnce({ abandoned: 0, deleted: 0, reconciled: 4 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerGigMediaJobs(boss as any, { cleanup });
    logSink.calls.length = 0;
    await handlers[GIG_MEDIA_CLEANUP_QUEUE]!([{ id: '1', data: null }]);
    expect(logSink.calls.filter((c) => c.message === 'gig photos cleaned up')).toEqual([]);
    await handlers[GIG_MEDIA_CLEANUP_QUEUE]!([{ id: '2', data: null }]);
    await handlers[GIG_MEDIA_CLEANUP_QUEUE]!([{ id: '3', data: null }]);
    expect(logSink.calls.filter((c) => c.message === 'gig photos cleaned up').map((c) => c.attrs)).toEqual([
      { abandoned: 3, deleted: 1, reconciled: 0 },
      { abandoned: 0, deleted: 0, reconciled: 4 },
    ]);
  });
  it('lets a failure surface so pg-boss records it and retries', async () => {
    const { boss, handlers } = fakeBoss();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await registerGigMediaJobs(boss as any, { cleanup: vi.fn().mockRejectedValue(new Error('database unavailable')) });
    await expect(handlers[GIG_MEDIA_CLEANUP_QUEUE]!([{ id: '1', data: null }])).rejects.toThrow('database unavailable');
  });
});

describe('the worker policy over the configuration registry', () => {
  const entries = (): [string, unknown][] => [
    ...Object.entries(DEFAULT_GIG_MEDIA_POLICY).map(([k, v]): [string, unknown] => [
      PROVIDER_GIG_MEDIA_POLICY_KEYS[k as keyof typeof PROVIDER_GIG_MEDIA_POLICY_KEYS],
      v,
    ]),
  ];
  const config = (over: Record<string, unknown> = {}, drop: string[] = []) => ({
    resolveMany: vi.fn(async (keys: string[]) => ({
      values: new Map(
        [...entries(), ...Object.entries(over)].filter(([k]) => keys.includes(k) && !drop.includes(k)).map(([k, v]) => [k, { value: v }] as const),
      ),
    })),
  });
  it('reads exactly the media keys and parses them strictly', async () => {
    const c = config();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const policy = await createWorkerGigPolicy(c as any).media();
    expect(policy).toEqual(DEFAULT_GIG_MEDIA_POLICY);
    expect(c.resolveMany.mock.calls[0]![0].sort()).toEqual(Object.values(PROVIDER_GIG_MEDIA_POLICY_KEYS).sort());
  });
  it('fails closed (UNAVAILABLE) on a missing, malformed or unreadable value: no code default', async () => {
    const missing = config({}, [PROVIDER_GIG_MEDIA_POLICY_KEYS.orphanGraceSeconds]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(createWorkerGigPolicy(missing as any).media()).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_INVALID' } });
    const bad = config({ [PROVIDER_GIG_MEDIA_POLICY_KEYS.orphanGraceSeconds]: -5 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(createWorkerGigPolicy(bad as any).media()).rejects.toBeInstanceOf(GigError);
    const down = { resolveMany: vi.fn(async () => Promise.reject(new Error('redis down'))) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(createWorkerGigPolicy(down as any).media()).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { reason: 'POLICY_UNREADABLE' } });
  });
  it('reads the base and options policies from their own keys', async () => {
    const c = { resolveMany: vi.fn(async () => ({ values: new Map() })) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = createWorkerGigPolicy(c as any);
    await expect(p.policy()).rejects.toBeInstanceOf(GigError);
    await expect(p.options()).rejects.toBeInstanceOf(GigError);
    expect(c.resolveMany.mock.calls.map((x: unknown[]) => (x[0] as string[]).slice().sort())).toEqual([
      Object.values(PROVIDER_GIG_POLICY_KEYS).sort(),
      Object.values(PROVIDER_GIG_OPTIONS_POLICY_KEYS).sort(),
    ]);
  });
});

describe('worker wiring', () => {
  const cfg = loadConfig({ service: 'bananagig-worker', env: { NODE_ENV: 'test', WORKER_ID: 'w-test' } });
  const build = (withMedia: boolean) => {
    const boss = { on: vi.fn(), start: vi.fn(), createQueue: vi.fn(), schedule: vi.fn(), work: vi.fn(), stop: vi.fn(), send: vi.fn() };
    const nats = { connection: vi.fn(), connected: true, ensureEventStream: vi.fn(), close: vi.fn() };
    const database = { health: vi.fn(async () => ({ ok: true })) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const worker = new Worker({ cfg, database, nats, boss, ...(withMedia ? { gigMedia: { cleanup: vi.fn() } } : {}) } as any);
    nats.connection.mockResolvedValue({ subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) });
    return { boss, worker };
  };
  it('registers the clean-up job at start when a media cleaner is provided', async () => {
    const { boss, worker } = build(true);
    await worker.start();
    expect(boss.createQueue).toHaveBeenCalledWith(GIG_MEDIA_CLEANUP_QUEUE);
    expect(boss.schedule).toHaveBeenCalledWith(GIG_MEDIA_CLEANUP_QUEUE, GIG_MEDIA_CLEANUP_CRON);
  });
  it('does not register it without one', async () => {
    const { boss, worker } = build(false);
    await worker.start();
    expect(boss.schedule).not.toHaveBeenCalled();
  });
});
