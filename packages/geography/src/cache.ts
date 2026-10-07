// Generation-based read cache for geography reference data. PostgreSQL is the source of truth; Valkey is only an accelerator.
//  - Reference data changes rarely, so entries are long-lived (default TTL 300 s) and invalidated by ONE counter: `bg:{env}:geo:gen`.
//    The counter is bumped AFTER any committed change and is part of every entry key (`bg:{env}:geo:v1:<what>:<gen>`), so invalidation is
//    instant and a slow reader that started before the bump can only write under a dead key. The generation is always read BEFORE the database.
//    The key also carries the content locale generation (`bg:{env}:content:locgen`): public reads list only locales that are ACTIVE in the
//    content registry, which changes without any geography write.
//  - A lost bump (the cache was unreachable at that moment) is bounded by the TTL: stale entries expire on their own.
//  - Only ACTIVE (public) data is ever cached, only for keys that exist (misses are never cached), so callers cannot grow the key space.
//    Management reads bypass the cache entirely (callers decide; this module never looks at roles).
//  - Every cache failure degrades to a database read. Every call has its own deadline; when the generation read does not answer the rest of
//    the cache is skipped for that request, so a hung cache costs one deadline per read at most, and never changes a result.
import type { ConfigCache } from '@bananagig/configuration';

export const DEFAULT_GEO_CACHE_TTL_SECONDS = 300;
export const GEO_CACHE_DEADLINE_MS = 250;

export const genKey = (env: string): string => `bg:${env}:geo:gen`;
/**
 * The content registry's locale generation (bumped by content on every locale registration or activation change). Public geography reads only
 * advertise ACTIVE locales, so a locale change must invalidate them too; the geography key therefore carries both generations.
 */
export const contentLocaleGenKey = (env: string): string => `bg:${env}:content:locgen`;
export const entryKey = (env: string, what: string, gen: string, localeGen = '0'): string => `bg:${env}:geo:v1:${what}:${gen}.${localeGen}`;

type Outcome<T> = { ok: true; value: T } | { ok: false };

/** Runs a cache call with a deadline. Failure and timeout both yield { ok: false }; never throws and never waits longer than `ms`. */
function bounded<T>(op: () => Promise<T>, ms: number): Promise<Outcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = (async () => op())().then(
    (value): Outcome<T> => ({ ok: true, value }),
    (): Outcome<T> => ({ ok: false }),
  );
  const deadline = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), ms);
  });
  return Promise.race([guarded, deadline]).finally(() => clearTimeout(timer));
}

/** Bumps the generation after a committed change. Never throws; never waits beyond the deadline. */
export async function invalidateGeography(cache: ConfigCache | undefined, env: string, deadlineMs = GEO_CACHE_DEADLINE_MS): Promise<void> {
  if (!cache) return;
  await bounded(() => cache.incr(genKey(env)), deadlineMs);
}

export interface CachedReadArgs<T> {
  cache?: ConfigCache;
  env: string;
  /** Names the cached value, for example `country:US`. Must come from a bounded set (validated codes of existing rows). */
  what: string;
  ttlSeconds?: number;
  deadlineMs?: number;
  /** Reads the database. Returns null for "nothing to cache" (not found, not visible). Errors propagate. */
  load: () => Promise<T | null>;
  /** Validates a cached value (a poisoned or malformed entry is treated as a miss). */
  parse: (raw: unknown) => T | null;
}

export type ReadSource = 'cache' | 'db';

/** Reads through the cache. Returns where the value came from (useful for tests and metrics). */
export async function cachedRead<T>(a: CachedReadArgs<T>): Promise<{ value: T | null; source: ReadSource }> {
  const cache = a.cache;
  if (!cache) return { value: await a.load(), source: 'db' };
  const deadline = a.deadlineMs ?? GEO_CACHE_DEADLINE_MS;
  const g = await bounded(() => cache.mget([genKey(a.env), contentLocaleGenKey(a.env)]), deadline);
  if (!g.ok) return { value: await a.load(), source: 'db' }; // the cache is not answering: do not wait for it again
  const key = entryKey(a.env, a.what, g.value[0] ?? '0', g.value[1] ?? '0');
  const hit = await bounded(() => cache.get(key), deadline);
  if (hit.ok && hit.value) {
    try {
      const v = a.parse((JSON.parse(hit.value) as { v: unknown }).v);
      if (v !== null) return { value: v, source: 'cache' };
    } catch {
      // malformed entry: treat as a miss
    }
  }
  const value = await a.load();
  if (value !== null && hit.ok) await bounded(() => cache.set(key, JSON.stringify({ v: value }), a.ttlSeconds ?? DEFAULT_GEO_CACHE_TTL_SECONDS), deadline);
  return { value, source: 'db' };
}
