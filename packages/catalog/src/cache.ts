// Generation-based read cache for the public catalogue. PostgreSQL is the source of truth; Valkey is only an accelerator.
//  - A market's public snapshot (its enabled, ACTIVE categories and service types in order, as CONTENT KEYS and codes, never text) is cached under
//    `bg:{env}:cat:v1:market:<code>:<generation>`. The generation counter `bg:{env}:cat:gen` is bumped AFTER any committed catalogue change, so invalidation is
//    instant and a slow reader that started before the bump can only write under a dead key. The generation is read BEFORE the database.
//  - The snapshot does not depend on the locale (text is resolved by the content registry, which has its own cache keyed by locale and content generation) and does
//    not embed the market's own visibility (the caller checks that through the geography gate, which has its own generation), so neither a locale change nor a
//    market activation needs to touch this cache.
//  - A lost bump is bounded by the TTL. Only snapshots of public markets are cached, only for codes that passed the market gate (the key space is the set of markets).
//    Management reads bypass the cache. Every cache failure degrades to a database read; every call has a deadline.
import type { ConfigCache } from '@bananagig/configuration';

export const DEFAULT_CATALOG_CACHE_TTL_SECONDS = 300;
export const CATALOG_CACHE_DEADLINE_MS = 250;

export const catalogGenKey = (env: string): string => `bg:${env}:cat:gen`;
export const catalogEntryKey = (env: string, what: string, gen: string): string => `bg:${env}:cat:v1:${what}:${gen}`;

type Outcome<T> = { ok: true; value: T } | { ok: false };

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
export async function invalidateCatalog(cache: ConfigCache | undefined, env: string, deadlineMs = CATALOG_CACHE_DEADLINE_MS): Promise<void> {
  if (!cache) return;
  await bounded(() => cache.incr(catalogGenKey(env)), deadlineMs);
}

export interface CachedReadArgs<T> {
  cache?: ConfigCache;
  env: string;
  /** Names the cached value, for example `market:la-oc`. Must come from a bounded set (codes that passed the market gate). */
  what: string;
  ttlSeconds?: number;
  deadlineMs?: number;
  load: () => Promise<T>;
  /** Validates a cached value (a poisoned or malformed entry is treated as a miss). */
  parse: (raw: unknown) => T | null;
}
export type ReadSource = 'cache' | 'db';

export async function cachedRead<T>(a: CachedReadArgs<T>): Promise<{ value: T; source: ReadSource }> {
  const cache = a.cache;
  if (!cache) return { value: await a.load(), source: 'db' };
  const deadline = a.deadlineMs ?? CATALOG_CACHE_DEADLINE_MS;
  const g = await bounded(() => cache.get(catalogGenKey(a.env)), deadline);
  if (!g.ok) return { value: await a.load(), source: 'db' }; // the cache is not answering: do not wait for it again
  const key = catalogEntryKey(a.env, a.what, g.value ?? '0');
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
  if (hit.ok) await bounded(() => cache.set(key, JSON.stringify({ v: value }), a.ttlSeconds ?? DEFAULT_CATALOG_CACHE_TTL_SECONDS), deadline);
  return { value, source: 'db' };
}
