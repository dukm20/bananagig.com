import { describe, expect, it } from 'vitest';
import { MemoryConfigCache, contextHash, type ConfigCache } from '@bananagig/configuration';
import {
  CACHE_CALL_DEADLINE_MS,
  entryGenKey,
  invalidateEntry,
  invalidateLocales,
  isDatabaseOutage,
  lkgKey,
  localeGenKey,
  resolutionKey,
  resolveWithPolicy,
  type PolicyArgs,
} from './cache';
import { ContentError } from './errors';
import type { BatchResult, ResolvedContent } from './resolver';

const T0 = Date.parse('2030-01-01T00:00:00Z');
const resolved = (key: string, over: Partial<ResolvedContent> = {}): ResolvedContent => ({
  key,
  entryId: `id-${key}`,
  contentType: 'UI_LABEL',
  sensitivity: 'PUBLIC',
  criticality: 'STANDARD',
  requestedLocale: 'en-US',
  resolvedLocale: 'en-US',
  fallback: { applied: false, chain: ['en-US'] },
  version: 1,
  versionId: `v-${key}`,
  sourceScope: 'PLATFORM',
  scopeRef: null,
  effectiveFrom: new Date(T0 - 86_400_000),
  effectiveTo: null,
  body: `body of ${key}`,
  bodySha256: 'sha',
  variables: [],
  ...over,
});
const batchOf = (items: ResolvedContent[], over: Partial<BatchResult> = {}): BatchResult => ({
  resolved: new Map(items.map((i) => [i.key, i])),
  missing: [],
  unknown: [],
  nextChangeAt: null,
  at: new Date(T0),
  cacheable: true,
  ...over,
});

/** A scripted database: counts loads and serves whatever `answer` returns (or throws). */
function harness<C extends ConfigCache = MemoryConfigCache>(
  answer: (keys: string[]) => BatchResult | Error,
  cache: C = new MemoryConfigCache() as unknown as C,
) {
  const state = { loads: [] as string[][], now: T0 };
  const run = (over: Partial<PolicyArgs> & Pick<PolicyArgs, 'keys'>) =>
    resolveWithPolicy({
      locale: 'en-US',
      ctx: {},
      cache,
      env: 'test',
      cacheTtlSeconds: 30,
      lkgMaxAgeSeconds: 3600,
      now: () => state.now,
      load: async (keys) => {
        state.loads.push(keys);
        const a = answer(keys);
        if (a instanceof Error) throw a;
        return a;
      },
      ...over,
    });
  return { cache, state, run };
}
/** Records the TTL of every resolution entry written (MemoryConfigCache itself ignores TTLs). */
class TtlSpy extends MemoryConfigCache {
  readonly ttls: number[] = [];
  override async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (key.includes(':v1:')) this.ttls.push(ttlSeconds as number);
    return super.set(key, value);
  }
}
const outage = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), { code: 'ECONNREFUSED' });

describe('cache keys', () => {
  it('follow the documented layout', () => {
    expect(entryGenKey('prod', 'brand.name')).toBe('bg:prod:content:gen:brand.name');
    expect(localeGenKey('prod')).toBe('bg:prod:content:locgen');
    expect(resolutionKey('prod', 'brand.name', '3', '7', 'es-MX', 'abc')).toBe('bg:prod:content:v1:brand.name:3:7:es-MX:abc');
    expect(lkgKey('prod', 'brand.name', 'es-MX', 'abc')).toBe('bg:prod:content:lkg:brand.name:es-MX:abc');
  });
});

describe('resolution cache', () => {
  it('serves the second read from the cache and reports the source per key', async () => {
    const h = harness((keys) => batchOf(keys.map((k) => resolved(k))));
    const first = await h.run({ keys: ['a.b', 'c.d'] });
    expect([...first.sources.values()]).toEqual(['db', 'db']);
    const second = await h.run({ keys: ['a.b', 'c.d'] });
    expect([...second.sources.values()]).toEqual(['cache', 'cache']);
    expect(second.resolved.get('a.b')).toEqual(resolved('a.b')); // dates revived
    expect(second.resolved.get('a.b')!.effectiveFrom).toBeInstanceOf(Date);
    expect(h.state.loads).toEqual([['a.b', 'c.d']]);
  });

  it('only the missing keys of a batch go to the database', async () => {
    const h = harness((keys) => batchOf(keys.map((k) => resolved(k))));
    await h.run({ keys: ['a.b'] });
    const r = await h.run({ keys: ['a.b', 'c.d'] });
    expect([r.sources.get('a.b'), r.sources.get('c.d')]).toEqual(['cache', 'db']);
    expect(h.state.loads).toEqual([['a.b'], ['c.d']]);
  });

  it('keys cache entries by requested locale and context', async () => {
    const h = harness((keys) => batchOf(keys.map((k) => resolved(k))));
    await h.run({ keys: ['a.b'] });
    expect((await h.run({ keys: ['a.b'], locale: 'es-MX' })).sources.get('a.b')).toBe('db');
    expect((await h.run({ keys: ['a.b'], ctx: { market: 'us-ca' } })).sources.get('a.b')).toBe('db');
    expect((await h.run({ keys: ['a.b'], ctx: { market: 'us-ca', marketDefaultLocale: 'es-US' } })).sources.get('a.b')).toBe('db');
    expect((await h.run({ keys: ['a.b'], ctx: { market: 'us-ca' } })).sources.get('a.b')).toBe('cache');
    expect(contextHash({ market: 'us-ca' })).not.toBe(contextHash({ market: 'us-ca', marketDefaultLocale: 'es-US' } as never));
  });

  it('an entry generation bump (publication, activation) invalidates only that entry; a locale generation bump invalidates all', async () => {
    const h = harness((keys) => batchOf(keys.map((k) => resolved(k))));
    await h.run({ keys: ['a.b', 'c.d'] });
    await invalidateEntry(h.cache, 'test', 'a.b');
    const afterEntry = await h.run({ keys: ['a.b', 'c.d'] });
    expect([afterEntry.sources.get('a.b'), afterEntry.sources.get('c.d')]).toEqual(['db', 'cache']);
    await invalidateLocales(h.cache, 'test');
    const afterLocale = await h.run({ keys: ['a.b', 'c.d'] });
    expect([afterLocale.sources.get('a.b'), afterLocale.sources.get('c.d')]).toEqual(['db', 'db']);
  });

  it('is valid only until the next boundary (minus one second of safety) and its TTL is capped by it', async () => {
    const cache = new TtlSpy();
    const h = harness(
      (keys) =>
        batchOf(
          keys.map((k) => resolved(k)),
          { nextChangeAt: new Date(T0 + 10_000) },
        ),
      cache,
    );
    await h.run({ keys: ['a.b'] });
    expect(cache.ttls).toEqual([10]); // min(30s TTL, 10s to the boundary)
    h.state.now = T0 + 8_900;
    expect((await h.run({ keys: ['a.b'] })).sources.get('a.b')).toBe('cache');
    h.state.now = T0 + 9_100; // less than one second before the version ends or a newer one starts
    expect((await h.run({ keys: ['a.b'] })).sources.get('a.b')).toBe('db');
    h.state.now = T0 + 10_500; // past the boundary
    expect((await h.run({ keys: ['a.b'] })).sources.get('a.b')).toBe('db');
  });

  it('does not cache an entry whose boundary is within the safety margin', async () => {
    const h = harness((keys) =>
      batchOf(
        keys.map((k) => resolved(k)),
        { nextChangeAt: new Date(T0 + 1_500) },
      ),
    );
    await h.run({ keys: ['a.b'] });
    expect([...h.cache.data.keys()].filter((k) => k.includes(':v1:'))).toEqual([]);
    expect((await h.run({ keys: ['a.b'] })).sources.get('a.b')).toBe('db');
  });

  it('with no upcoming boundary the entry lives for the TTL', async () => {
    const cache = new TtlSpy();
    const h = harness((keys) => batchOf(keys.map((k) => resolved(k))), cache);
    await h.run({ keys: ['a.b'], cacheTtlSeconds: 45 });
    expect(cache.ttls).toEqual([45]);
  });

  it('CRITICAL entries are never cached and never stored as last-known-good', async () => {
    const h = harness((keys) => batchOf(keys.map((k) => resolved(k, { criticality: 'CRITICAL' }))));
    await h.run({ keys: ['a.b'] });
    await h.run({ keys: ['a.b'] });
    expect(h.state.loads).toHaveLength(2);
    expect([...h.cache.data.keys()].filter((k) => k.includes(':v1:') || k.includes(':lkg:'))).toEqual([]);
  });

  it('LEGAL entries are never cached even if mislabelled STANDARD (defense in depth)', async () => {
    const h = harness((keys) => batchOf(keys.map((k) => resolved(k, { contentType: 'LEGAL', criticality: 'STANDARD' }))));
    await h.run({ keys: ['a.b'] });
    expect([...h.cache.data.keys()].filter((k) => k.includes(':v1:') || k.includes(':lkg:'))).toEqual([]);
  });

  it('a poisoned cache entry that claims CRITICAL or LEGAL is ignored', async () => {
    const h = harness((keys) => batchOf(keys.map((k) => resolved(k))));
    await h.run({ keys: ['a.b'] });
    const key = [...h.cache.data.keys()].find((k) => k.includes(':v1:'))!;
    const bad = JSON.parse(h.cache.data.get(key)!);
    bad.r = JSON.stringify({ ...JSON.parse(bad.r), criticality: 'CRITICAL' });
    h.cache.data.set(key, JSON.stringify(bad));
    expect((await h.run({ keys: ['a.b'] })).sources.get('a.b')).toBe('db');
  });

  it('a malformed cache entry is a miss, never an error', async () => {
    const h = harness((keys) => batchOf(keys.map((k) => resolved(k))));
    await h.run({ keys: ['a.b'] });
    for (const k of h.cache.data.keys()) if (k.includes(':v1:')) h.cache.data.set(k, '{not json');
    expect((await h.run({ keys: ['a.b'] })).sources.get('a.b')).toBe('db');
  });

  it('an explicit `at` bypasses cache and LKG completely (no reads, no writes)', async () => {
    const h = harness((keys) => batchOf(keys.map((k) => resolved(k))));
    await h.run({ keys: ['a.b'] }); // populates cache + LKG
    const poisonKey = [...h.cache.data.keys()].find((k) => k.includes(':v1:'))!;
    const poisoned = JSON.parse(h.cache.data.get(poisonKey)!);
    poisoned.r = JSON.stringify({ ...JSON.parse(poisoned.r), body: 'POISON' }); // a valid entry: it WOULD be served if the cache were read
    h.cache.data.set(poisonKey, JSON.stringify(poisoned));
    expect((await h.run({ keys: ['a.b'] })).resolved.get('a.b')!.body).toBe('POISON'); // sanity: normal reads do hit it
    const before = new Map(h.cache.data);
    const r = await h.run({ keys: ['a.b'], at: new Date(T0 + 60_000) });
    expect(r.sources.get('a.b')).toBe('db');
    expect(r.resolved.get('a.b')!.body).toBe('body of a.b');
    expect(h.state.loads).toHaveLength(2);
    for (const [k, v] of before) expect(h.cache.data.get(k)).toBe(v); // nothing rewritten
    const fresh = harness((keys) => batchOf(keys.map((k) => resolved(k))));
    await fresh.run({ keys: ['a.b'], at: new Date(T0) });
    expect(fresh.cache.data.size).toBe(0);
  });

  it('works without any cache', async () => {
    const h = harness((keys) => batchOf(keys.map((k) => resolved(k))));
    const r = await h.run({ keys: ['a.b'], cache: undefined });
    expect(r.sources.get('a.b')).toBe('db');
  });

  it('passes definitive database answers through: unknown and no-content keys are reported, never cached', async () => {
    const h = harness((keys) =>
      batchOf(
        keys.filter((k) => k === 'ok.key').map((k) => resolved(k)),
        { unknown: ['gone.key'], missing: [{ key: 'empty.key', entryId: 'e', criticality: 'STANDARD', sensitivity: 'PUBLIC' }] },
      ),
    );
    const r = await h.run({ keys: ['ok.key', 'gone.key', 'empty.key'] });
    expect([...r.resolved.keys()]).toEqual(['ok.key']);
    expect(Object.fromEntries(r.missing)).toEqual({ 'gone.key': 'ENTRY_NOT_FOUND', 'empty.key': 'NO_CONTENT' });
    await h.run({ keys: ['gone.key', 'empty.key'] });
    expect(h.state.loads).toEqual([
      ['ok.key', 'gone.key', 'empty.key'],
      ['gone.key', 'empty.key'],
    ]);
  });
});

describe('last-known-good (database outage)', () => {
  /** Warm the cache for the given entries, then drop the resolution entries so the next read must go to the database. */
  async function warm(items: ResolvedContent[], cache = new MemoryConfigCache()) {
    let down = false;
    const h = harness((keys) => (down ? outage() : batchOf(keys.map((k) => items.find((i) => i.key === k) ?? resolved(k)))), cache);
    await h.run({ keys: items.map((i) => i.key) });
    for (const k of [...cache.data.keys()]) if (k.includes(':v1:')) cache.data.delete(k);
    down = true;
    return h;
  }

  it('serves STANDARD entries from LKG when the database cannot be reached', async () => {
    const h = await warm([resolved('a.b'), resolved('c.d')]);
    const r = await h.run({ keys: ['a.b', 'c.d'] });
    expect([...r.sources.values()]).toEqual(['lkg', 'lkg']);
    expect(r.resolved.get('c.d')).toEqual(resolved('c.d'));
  });

  it('is all-or-nothing: one key without LKG fails the whole batch with UNAVAILABLE', async () => {
    const h = await warm([resolved('a.b')]);
    await expect(h.run({ keys: ['a.b', 'never.seen'] })).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { keys: ['a.b', 'never.seen'] } });
  });

  it('never serves CRITICAL entries from LKG (nothing is stored), and one CRITICAL key fails a mixed batch', async () => {
    const h = await warm([resolved('std.key'), resolved('crit.key', { criticality: 'CRITICAL' })]);
    expect((await h.run({ keys: ['std.key'] })).sources.get('std.key')).toBe('lkg');
    await expect(h.run({ keys: ['crit.key'] })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(h.run({ keys: ['std.key', 'crit.key'] })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('refuses LKG older than the maximum age', async () => {
    const h = await warm([resolved('a.b')]);
    h.state.now = T0 + 3_599_000;
    expect((await h.run({ keys: ['a.b'] })).sources.get('a.b')).toBe('lkg');
    h.state.now = T0 + 3_601_000;
    await expect(h.run({ keys: ['a.b'] })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('refuses LKG whose own end has passed', async () => {
    const h = await warm([resolved('a.b', { effectiveTo: new Date(T0 + 5_000) })]);
    h.state.now = T0 + 4_000;
    expect((await h.run({ keys: ['a.b'] })).sources.get('a.b')).toBe('lkg');
    h.state.now = T0 + 6_000;
    await expect(h.run({ keys: ['a.b'] })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('LKG is for the same requested locale and context only', async () => {
    const h = await warm([resolved('a.b')]);
    await expect(h.run({ keys: ['a.b'], locale: 'es-MX' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(h.run({ keys: ['a.b'], ctx: { market: 'us-ca' } })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('is never used for explicit `at` lookups', async () => {
    const h = await warm([resolved('a.b')]);
    await expect(h.run({ keys: ['a.b'], at: new Date(T0) })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('is never used for a definitive "no content" or "unknown entry" answer from the database', async () => {
    let healthy = true;
    const h = harness((keys) =>
      healthy
        ? batchOf(keys.map((k) => resolved(k)))
        : batchOf([], { missing: [{ key: 'a.b', entryId: 'e', criticality: 'STANDARD', sensitivity: 'PUBLIC' }], unknown: ['c.d'] }),
    );
    await h.run({ keys: ['a.b', 'c.d'] }); // LKG now exists for both
    for (const k of [...h.cache.data.keys()]) if (k.includes(':v1:')) h.cache.data.delete(k);
    healthy = false; // the database answers, definitively, that there is nothing
    const r = await h.run({ keys: ['a.b', 'c.d'] });
    expect(r.resolved.size).toBe(0);
    expect(Object.fromEntries(r.missing)).toEqual({ 'a.b': 'NO_CONTENT', 'c.d': 'ENTRY_NOT_FOUND' });
  });

  it('only outages trigger LKG: typed errors, programming errors and SQL rejections propagate untouched', async () => {
    for (const err of [
      new ContentError('VALIDATION_FAILED', 'x'),
      new TypeError('bug'),
      Object.assign(new Error('bad sql'), { code: '42601' }),
      Object.assign(new Error('bad data'), { code: '22P02' }),
    ]) {
      const h = harness(() => err);
      await h.run({ keys: ['a.b'] }).catch(() => undefined);
      const lkg = harness(() => batchOf([resolved('a.b')]), h.cache);
      await lkg.run({ keys: ['a.b'] }); // LKG exists
      for (const k of [...h.cache.data.keys()]) if (k.includes(':v1:')) h.cache.data.delete(k);
      await expect(h.run({ keys: ['a.b'] })).rejects.toBe(err);
    }
    expect(isDatabaseOutage(outage())).toBe(true);
    expect(isDatabaseOutage(Object.assign(new Error('57P01 terminating'), { code: '57P01' }))).toBe(true);
    expect(isDatabaseOutage(Object.assign(new Error('timeout'), { code: '57014' }))).toBe(true);
    expect(isDatabaseOutage(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isDatabaseOutage(new TypeError('x'))).toBe(false);
    expect(isDatabaseOutage(new Error('boom'))).toBe(false); // unrecognized errors are bugs, not outages
    expect(isDatabaseOutage(Object.assign(new Error('x'), { code: '40001' }))).toBe(false);
    expect(isDatabaseOutage(Object.assign(new Error('x'), { code: '53300' }))).toBe(true);
    expect(isDatabaseOutage(new ContentError('NO_CONTENT', 'x'))).toBe(false);
    expect(isDatabaseOutage(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
  });

  it('the UNAVAILABLE error carries identifiers only (no copy)', async () => {
    const h = await warm([resolved('a.b', { body: 'SECRET-COPY-SENTINEL' })]);
    const err = (await h.run({ keys: ['never.seen'] }).catch((e) => e)) as ContentError;
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain('SECRET-COPY-SENTINEL');
    expect(err.details.keys).toEqual(['never.seen']);
  });
});

describe('Valkey outage', () => {
  it('degrades to database reads and never changes a result', async () => {
    const cache = new MemoryConfigCache();
    const h = harness((keys) => batchOf(keys.map((k) => resolved(k))), cache);
    await h.run({ keys: ['a.b'] });
    cache.fail = true;
    const r = await h.run({ keys: ['a.b'] });
    expect(r.sources.get('a.b')).toBe('db');
    expect(r.resolved.get('a.b')).toEqual(resolved('a.b'));
    await expect(invalidateEntry(cache, 'test', 'a.b')).resolves.toBeUndefined();
    await expect(invalidateLocales(cache, 'test')).resolves.toBeUndefined();
  });

  it('with the cache AND the database down there is no LKG: UNAVAILABLE', async () => {
    const cache = new MemoryConfigCache();
    let down = false;
    const h = harness((keys) => (down ? outage() : batchOf(keys.map((k) => resolved(k)))), cache);
    await h.run({ keys: ['a.b'] });
    cache.fail = true;
    down = true;
    await expect(h.run({ keys: ['a.b'] })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('a cache whose invalidation throws does not break callers', async () => {
    const throwing = { get: async () => null, mget: async () => [], set: async () => undefined, incr: async () => Promise.reject(new Error('down')) };
    await expect(invalidateEntry(throwing, 'test', 'a.b')).resolves.toBeUndefined();
    await expect(invalidateLocales(throwing, 'test')).resolves.toBeUndefined();
    await expect(invalidateEntry(undefined, 'test', 'a.b')).resolves.toBeUndefined();
  });
});

describe('INTERNAL entries without content', () => {
  it('reports which NO_CONTENT keys belong to INTERNAL entries (so the service can hide them like unknown keys)', async () => {
    const h = harness((keys) =>
      batchOf([], {
        missing: keys.map((k) => ({
          key: k,
          entryId: `id-${k}`,
          criticality: 'STANDARD' as const,
          sensitivity: k.startsWith('int.') ? ('INTERNAL' as const) : ('PUBLIC' as const),
        })),
      }),
    );
    const r = await h.run({ keys: ['int.draft', 'pub.draft'] });
    expect(Object.fromEntries(r.missing)).toEqual({ 'int.draft': 'NO_CONTENT', 'pub.draft': 'NO_CONTENT' });
    expect([...r.internalMissing]).toEqual(['int.draft']);
  });
});

describe('requests outside the bounded cache key space', () => {
  it('a non-cacheable batch is returned correctly but writes neither a resolution entry nor last-known-good', async () => {
    const h = harness((keys) =>
      batchOf(
        keys.map((k) => resolved(k)),
        { cacheable: false },
      ),
    );
    for (let i = 0; i < 3; i++) {
      const r = await h.run({ keys: ['a.b', 'c.d'], locale: `x${i}-US`, ctx: { market: `unknown-${i}` } });
      expect([...r.sources.values()]).toEqual(['db', 'db']);
      expect(r.resolved.get('a.b')).toEqual(resolved('a.b'));
    }
    expect(h.cache.data.size).toBe(0); // not even a generation counter is written
    expect(h.state.loads).toHaveLength(3);
  });

  it('a cacheable batch still writes both entries (same call, only the flag differs)', async () => {
    const h = harness((keys) => batchOf(keys.map((k) => resolved(k))));
    await h.run({ keys: ['a.b'] });
    expect([...h.cache.data.keys()].some((k) => k.includes(':v1:'))).toBe(true);
    expect([...h.cache.data.keys()].some((k) => k.includes(':lkg:'))).toBe(true);
  });
});

/** A cache whose calls never answer, or answer only after `delayMs` (then fail or succeed); counts calls. */
function stalled(kind: 'hang' | 'slow-fail' | 'slow-ok', delayMs = 3000) {
  const calls = { n: 0 };
  const go = <T>(ok: T): Promise<T> => {
    calls.n++;
    if (kind === 'hang') return new Promise<T>(() => undefined);
    return new Promise<T>((resolve, reject) => setTimeout(() => (kind === 'slow-fail' ? reject(new Error('ECONNREFUSED')) : resolve(ok)), delayMs));
  };
  const cache = {
    get: () => go<string | null>(null),
    mget: (keys: string[]) => go(keys.map(() => null as string | null)),
    set: () => go<void>(undefined),
    incr: () => go<void>(undefined),
  };
  return { cache, calls };
}

describe('a cache that does not answer (bounded I/O, never per-key delays)', () => {
  for (const kind of ['hang', 'slow-fail', 'slow-ok'] as const) {
    it(`${kind}: resolving 8 keys completes within a few deadlines and returns the database result`, async () => {
      const { cache, calls } = stalled(kind);
      const keys = Array.from({ length: 8 }, (_, i) => `k${i}.x`);
      const h = harness((ks) => batchOf(ks.map((k) => resolved(k))), cache);
      const t = Date.now();
      const r = await h.run({ keys, cacheDeadlineMs: 40 });
      const took = Date.now() - t;
      expect(took).toBeLessThan(500); // 2 reads + 1 parallel write phase, each bounded by 40 ms; serial writes would be 16 deadlines
      expect([...r.sources.values()]).toEqual(Array(8).fill('db'));
      expect([...r.resolved.keys()]).toEqual(keys);
      expect(calls.n).toBe(2 + 16); // 2 reads + (resolution + LKG) x 8 keys, all started together
    });
  }

  it('the writes of one batch are started in parallel', async () => {
    const inFlight = { max: 0, now: 0 };
    const cache = new MemoryConfigCache();
    const set = cache.set.bind(cache);
    cache.set = async (k: string, v: string) => {
      inFlight.max = Math.max(inFlight.max, ++inFlight.now);
      await new Promise((r) => setTimeout(r, 20));
      await set(k, v);
      inFlight.now--;
    };
    const h = harness((ks) => batchOf(ks.map((k) => resolved(k))), cache);
    await h.run({ keys: ['a.b', 'c.d', 'e.f', 'g.h'] });
    expect(inFlight.max).toBe(8);
  });

  it('invalidation never waits beyond its deadline when the cache hangs or fails slowly', async () => {
    for (const kind of ['hang', 'slow-fail'] as const) {
      const { cache } = stalled(kind);
      const t = Date.now();
      await invalidateEntry(cache, 'test', 'a.b');
      await invalidateLocales(cache, 'test');
      expect(Date.now() - t, kind).toBeLessThan(CACHE_CALL_DEADLINE_MS * 2 + 400);
    }
  });

  it('last-known-good lookups during a database outage are bounded too (and fail typed when the cache cannot answer)', async () => {
    const { cache } = stalled('hang');
    const h = harness(() => outage(), cache);
    const t = Date.now();
    await expect(h.run({ keys: ['a.b'], cacheDeadlineMs: 40 })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(Date.now() - t).toBeLessThan(600);
  });
});
