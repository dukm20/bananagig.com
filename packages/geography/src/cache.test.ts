import { describe, expect, it } from 'vitest';
import { MemoryConfigCache, type ConfigCache } from '@bananagig/configuration';
import { DEFAULT_GEO_CACHE_TTL_SECONDS, cachedRead, contentLocaleGenKey, entryKey, genKey, invalidateGeography } from './cache';

const parse = (raw: unknown) => (typeof raw === 'object' && raw !== null && 'n' in raw ? (raw as { n: number }) : null);
class Spy extends MemoryConfigCache {
  ttls: number[] = [];
  override async set(key: string, value: string, ttl?: number): Promise<void> {
    this.ttls.push(ttl as number);
    await super.set(key, value);
  }
}
const read = (cache: ConfigCache | undefined, loads: { n: number }, over: Partial<Parameters<typeof cachedRead<{ n: number }>>[0]> = {}) =>
  cachedRead<{ n: number }>({
    cache,
    env: 'test',
    what: 'country:US',
    parse,
    deadlineMs: 50,
    load: async () => {
      loads.n++;
      return { n: loads.n };
    },
    ...over,
  });

describe('geography cache keys and generations', () => {
  it('keys follow bg:{env}:geo:v1:<what>:<gen>; the generation counter is bg:{env}:geo:gen', () => {
    expect(genKey('prod')).toBe('bg:prod:geo:gen');
    expect(entryKey('prod', 'market:la-oc', '7', '3')).toBe('bg:prod:geo:v1:market:la-oc:7.3');
    expect(contentLocaleGenKey('prod')).toBe('bg:prod:content:locgen');
  });

  it('a second read is a cache hit; the entry is stored under the generation key with the default TTL (a lost bump is bounded by it)', async () => {
    const cache = new Spy();
    const loads = { n: 0 };
    expect(await read(cache, loads)).toEqual({ value: { n: 1 }, source: 'db' });
    expect(await read(cache, loads)).toEqual({ value: { n: 1 }, source: 'cache' });
    expect(loads.n).toBe(1);
    expect([...cache.data.keys()]).toEqual(['bg:test:geo:v1:country:US:0.0']);
    expect(cache.ttls).toEqual([DEFAULT_GEO_CACHE_TTL_SECONDS]);
    expect(DEFAULT_GEO_CACHE_TTL_SECONDS).toBe(300);
  });

  it('bumping the generation makes the next read a miss under a new key; the locale generation does the same', async () => {
    const cache = new MemoryConfigCache();
    const loads = { n: 0 };
    await read(cache, loads);
    await invalidateGeography(cache, 'test');
    expect(cache.data.get('bg:test:geo:gen')).toBe('1');
    expect((await read(cache, loads)).source).toBe('db');
    expect(cache.data.has('bg:test:geo:v1:country:US:1.0')).toBe(true);
    expect((await read(cache, loads)).source).toBe('cache');
    await cache.incr(contentLocaleGenKey('test'));
    expect((await read(cache, loads)).source).toBe('db');
    expect(cache.data.has('bg:test:geo:v1:country:US:1.1')).toBe(true);
  });

  it('different values are cached independently and null results (misses) are never cached', async () => {
    const cache = new MemoryConfigCache();
    const loads = { n: 0 };
    await read(cache, loads, { what: 'a' });
    await read(cache, loads, { what: 'b' });
    expect(loads.n).toBe(2);
    expect(await read(cache, loads, { what: 'c', load: async () => null })).toEqual({ value: null, source: 'db' });
    expect([...cache.data.keys()].some((k) => k.includes(':c:'))).toBe(false);
  });

  it('malformed or invalid entries are misses and are overwritten', async () => {
    const cache = new MemoryConfigCache();
    const loads = { n: 0 };
    await read(cache, loads);
    const key = 'bg:test:geo:v1:country:US:0.0';
    for (const bad of ['{nope', JSON.stringify({ v: 'x' }), JSON.stringify({})]) {
      cache.data.set(key, bad);
      expect((await read(cache, loads)).source).toBe('db');
    }
    expect((await read(cache, loads)).source).toBe('cache');
  });

  it('without a cache every read goes to the load function', async () => {
    const loads = { n: 0 };
    await read(undefined, loads);
    await read(undefined, loads);
    expect(loads.n).toBe(2);
    await expect(invalidateGeography(undefined, 'test')).resolves.toBeUndefined();
  });

  it('a failing cache (memory .fail) never changes the result; load errors propagate', async () => {
    const cache = new MemoryConfigCache();
    cache.fail = true;
    const loads = { n: 0 };
    expect((await read(cache, loads)).source).toBe('db');
    await expect(read(cache, loads, { load: async () => Promise.reject(new Error('db down')) })).rejects.toThrow('db down');
  });

  it('a hanging or slow-failing cache costs at most one deadline per read and per invalidation', async () => {
    const never = () => new Promise<never>(() => undefined);
    const hang: ConfigCache = { get: never, mget: never, set: never, incr: never };
    const slowFail: ConfigCache = {
      get: () => new Promise((_, r) => setTimeout(() => r(new Error('x')), 2000)),
      mget: () => new Promise((_, r) => setTimeout(() => r(new Error('x')), 2000)),
      set: never,
      incr: () => new Promise((_, r) => setTimeout(() => r(new Error('x')), 2000)),
    };
    for (const cache of [hang, slowFail]) {
      const loads = { n: 0 };
      const t0 = Date.now();
      expect(await read(cache, loads)).toEqual({ value: { n: 1 }, source: 'db' });
      await invalidateGeography(cache, 'test', 50);
      expect(Date.now() - t0).toBeLessThan(600);
    }
  });

  it('a throwing cache implementation is treated as an outage, not an error', async () => {
    const throwing: ConfigCache = {
      get: () => {
        throw new Error('sync throw');
      },
      mget: () => {
        throw new Error('sync throw');
      },
      set: () => {
        throw new Error('sync throw');
      },
      incr: () => {
        throw new Error('sync throw');
      },
    };
    expect((await read(throwing, { n: 0 })).source).toBe('db');
    await expect(invalidateGeography(throwing, 'test')).resolves.toBeUndefined();
  });
});
