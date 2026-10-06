import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValkeyConfigCache } from './cache';

// The adapter's job: a Valkey outage may degrade the cache to misses, but must never slow a request down or change a result.
// A scripted client stands in for iovalkey. `mode` is switched by each test.
type Mode = 'ok' | 'hang' | 'slow-reject' | 'fast-reject' | 'throw';
function scripted(initial: Mode = 'ok') {
  const state = { mode: initial as Mode, calls: 0, store: new Map<string, string>() };
  const run = <T>(value: () => T): Promise<T> => {
    state.calls++;
    switch (state.mode) {
      case 'hang':
        return new Promise<T>(() => undefined);
      case 'slow-reject':
        return new Promise<T>((_, reject) => setTimeout(() => reject(new Error('ECONNREFUSED slow')), 400));
      case 'fast-reject':
        return Promise.reject(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      case 'throw':
        throw new Error('client exploded synchronously');
      default:
        return Promise.resolve(value());
    }
  };
  const client = {
    get: (k: string) => run(() => state.store.get(k) ?? null),
    mget: (...ks: string[]) => run(() => ks.map((k) => state.store.get(k) ?? null)),
    set: (k: string, v: string, _mode: 'EX', _s: number) => run(() => (state.store.set(k, v), 'OK')),
    incr: (k: string) => run(() => (state.store.set(k, String(Number(state.store.get(k) ?? 0) + 1)), 1)),
  };
  return { client, state };
}
const elapsed = async (fn: () => Promise<unknown>): Promise<number> => {
  const t = Date.now();
  await fn();
  return Date.now() - t;
};

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);
process.on('unhandledRejection', onUnhandled);
afterEach(() => {
  vi.useRealTimers();
});

describe('ValkeyConfigCache with a healthy server', () => {
  it('keeps the plain semantics: get, mget, set (ttl floored, at least 1 second) and incr', async () => {
    const { client, state } = scripted();
    const sets: number[] = [];
    const cache = new ValkeyConfigCache({ ...client, set: (k, v, m, s) => (sets.push(s), client.set(k, v, m, s)) });
    await cache.set('a', '1', 30.9);
    await cache.set('b', '2', 0.2);
    expect(sets).toEqual([30, 1]);
    expect(await cache.get('a')).toBe('1');
    expect(await cache.get('missing')).toBeNull();
    expect(await cache.mget(['a', 'b', 'missing'])).toEqual(['1', '2', null]);
    await cache.incr('gen');
    await cache.incr('gen');
    expect(await cache.get('gen')).toBe('2');
    const before = state.calls;
    expect(await cache.mget([])).toEqual([]); // no round trip for an empty batch
    expect(state.calls).toBe(before);
  });
});

describe('ValkeyConfigCache during an outage (bounded I/O)', () => {
  it('a client that never answers: every command degrades within the timeout, and after the first one the breaker short-circuits without I/O', async () => {
    const { client, state } = scripted('hang');
    const cache = new ValkeyConfigCache(client, { commandTimeoutMs: 40, breakerCooldownMs: 60_000 });
    const first = await elapsed(async () => expect(await cache.mget(['a', 'b'])).toEqual([null, null]));
    expect(first).toBeGreaterThanOrEqual(30);
    expect(first).toBeLessThan(400);
    expect(state.calls).toBe(1);
    // 200 further commands (a batch of 100 keys writes two values each) cost nothing and never touch the client
    const rest = await elapsed(async () => {
      for (let i = 0; i < 50; i++) {
        expect(await cache.get('a')).toBeNull();
        expect(await cache.mget(['a'])).toEqual([null]);
        await cache.set('a', 'v', 30);
        await cache.incr('gen');
      }
    });
    expect(rest).toBeLessThan(100);
    expect(state.calls).toBe(1);
  });

  it('a client that rejects slowly is cut off at the timeout (not after its own delay) and its late rejection is not unhandled', async () => {
    const { client, state } = scripted('slow-reject');
    const cache = new ValkeyConfigCache(client, { commandTimeoutMs: 30, breakerCooldownMs: 60_000 });
    const took = await elapsed(async () => expect(await cache.get('a')).toBeNull());
    expect(took).toBeLessThan(300);
    expect(state.calls).toBe(1);
    await new Promise((r) => setTimeout(r, 500)); // the slow rejection now fires
    expect(unhandled).toEqual([]);
  });

  it('a fast failure (connection refused) and a synchronous throw also open the breaker', async () => {
    for (const mode of ['fast-reject', 'throw'] as const) {
      const { client, state } = scripted(mode);
      const cache = new ValkeyConfigCache(client, { commandTimeoutMs: 50, breakerCooldownMs: 60_000 });
      expect(await cache.get('a')).toBeNull();
      await cache.set('a', 'v', 5);
      await cache.incr('gen');
      expect(await cache.mget(['a', 'b'])).toEqual([null, null]);
      expect(state.calls, mode).toBe(1);
    }
  });

  it('every command degrades to its own neutral result while the breaker is open (miss, miss list, no-op)', async () => {
    const { client } = scripted('fast-reject');
    const cache = new ValkeyConfigCache(client, { commandTimeoutMs: 50, breakerCooldownMs: 60_000 });
    await cache.get('x'); // opens
    expect(await cache.get('x')).toBeNull();
    expect(await cache.mget(['x', 'y', 'z'])).toEqual([null, null, null]);
    await expect(cache.set('x', 'v', 3)).resolves.toBeUndefined();
    await expect(cache.incr('x')).resolves.toBeUndefined();
  });

  it('recovers: after the cooldown one probe goes through, its success closes the breaker and normal service resumes', async () => {
    const { client, state } = scripted('fast-reject');
    let now = 1_000_000;
    const cache = new ValkeyConfigCache(client, { commandTimeoutMs: 50, breakerCooldownMs: 5_000, now: () => now });
    expect(await cache.get('k')).toBeNull();
    expect(state.calls).toBe(1);
    state.mode = 'ok';
    state.store.set('k', 'v');
    now += 4_999; // still cooling down: the healthy server is not consulted yet
    expect(await cache.get('k')).toBeNull();
    expect(state.calls).toBe(1);
    now += 2; // cooldown over: the next command is the probe
    expect(await cache.get('k')).toBe('v');
    expect(state.calls).toBe(2);
    expect(await cache.mget(['k'])).toEqual(['v']); // closed again: no more short-circuiting
    await cache.set('n', '1', 10);
    expect(state.store.get('n')).toBe('1');
    expect(state.calls).toBe(4);
  });

  it('a failed probe re-opens the breaker for another full cooldown', async () => {
    const { client, state } = scripted('fast-reject');
    let now = 0;
    const cache = new ValkeyConfigCache(client, { commandTimeoutMs: 50, breakerCooldownMs: 1_000, now: () => now });
    await cache.get('k');
    now = 1_001;
    await cache.get('k'); // the probe, still failing
    expect(state.calls).toBe(2);
    now = 2_000; // within the new cooldown (probe failed at 1001, so open until 2001)
    await cache.get('k');
    expect(state.calls).toBe(2);
    now = 2_002;
    state.mode = 'ok';
    expect(await cache.get('k')).toBeNull(); // probe succeeds (key absent)
    expect(state.calls).toBe(3);
    await cache.get('k');
    expect(state.calls).toBe(4);
  });

  it('only one probe is in flight: concurrent commands during the probe degrade immediately', async () => {
    const { client, state } = scripted('fast-reject');
    let now = 0;
    const cache = new ValkeyConfigCache(client, { commandTimeoutMs: 200, breakerCooldownMs: 1_000, now: () => now });
    await cache.get('k');
    now = 1_500;
    state.mode = 'hang'; // the probe will hang until its timeout
    const probe = cache.get('k');
    const others = await Promise.all([cache.get('a'), cache.mget(['a', 'b']), cache.incr('g')]);
    expect(others[0]).toBeNull();
    expect(state.calls).toBe(2); // the initial failure plus the single probe
    await probe;
    expect(state.calls).toBe(2);
  });

  it('a probe that times out re-opens the breaker', async () => {
    const { client, state } = scripted('fast-reject');
    let now = 0;
    const cache = new ValkeyConfigCache(client, { commandTimeoutMs: 25, breakerCooldownMs: 1_000, now: () => now });
    await cache.get('k');
    now = 1_500;
    state.mode = 'hang';
    await cache.get('k'); // probe times out
    expect(state.calls).toBe(2);
    await cache.get('k'); // open again
    expect(state.calls).toBe(2);
  });
});
