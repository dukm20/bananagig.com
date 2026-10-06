// Resolution caching and last-known-good (LKG) for content. PostgreSQL is the source of truth; Valkey is only an accelerator.
//  - The RESOLVED (un-rendered) entry is cached per key, requested locale and context. Rendering happens per call.
//  - An entry is valid until `validUntil` = the next instant any applicable published version starts/ends, capped by the TTL.
//  - Publication, activation and entry (de)activation bump a per-entry generation; any locale change bumps the locale generation.
//    Both are part of the cache key, so invalidation is instant and a slow reader cannot resurrect stale data.
//  - CRITICAL (and LEGAL) entries are never cached and never served from LKG. `at` lookups bypass both.
//  - LKG is used ONLY when the database cannot be reached, only for STANDARD entries, all-or-nothing per batch and within the max age.
//    A definitive "no content" or "unknown entry" answer from the database is authoritative and never replaced by LKG.
//  - Every Valkey failure degrades to a miss or a no-op: a cache outage can neither change a result nor hold a request. The Valkey adapter bounds
//    every command (timeout + circuit breaker); on top of that every call made here has its own deadline, and the independent writes of one
//    batch run in parallel, so even a cache implementation without those bounds delays a response by at most a few deadlines, never per key.
//  - Only requests whose cache key space is bounded by data the operators control are cached: the requested locale (and market default locale)
//    must be an ACTIVE locale and every context scope reference must match a published version of the requested entries. Anything else is
//    served from the database every time and writes neither a resolution entry nor a last-known-good entry, so anonymous callers cannot grow
//    the key space by varying the locale or context.
import { contextHash, type ConfigCache } from '@bananagig/configuration';
import type { ContentContext } from '@bananagig/contracts';
import { ContentError } from './errors';
import type { BatchResult, ResolvedContent } from './resolver';

export type Source = 'cache' | 'db' | 'lkg';
export type MissingCode = 'ENTRY_NOT_FOUND' | 'NO_CONTENT';

// ---------------------------------------------------------------- keys
export const entryGenKey = (env: string, entryKey: string): string => `bg:${env}:content:gen:${entryKey}`;
export const localeGenKey = (env: string): string => `bg:${env}:content:locgen`;
export const resolutionKey = (env: string, entryKey: string, entryGen: string, locGen: string, locale: string, ctxHash: string): string =>
  `bg:${env}:content:v1:${entryKey}:${entryGen}:${locGen}:${locale}:${ctxHash}`;
export const lkgKey = (env: string, entryKey: string, locale: string, ctxHash: string): string => `bg:${env}:content:lkg:${entryKey}:${locale}:${ctxHash}`;

/** Upper bound for each individual cache call made from this module (the adapter has its own, tighter, per-command bound). */
export const CACHE_CALL_DEADLINE_MS = 250;

/** Runs a cache operation with a deadline. Failure and timeout both yield `fallback`; never throws and never waits longer than `ms`. */
function bounded<T>(op: () => Promise<T>, fallback: T, ms = CACHE_CALL_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = (async () => op())().catch(() => fallback);
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([guarded, deadline]).finally(() => clearTimeout(timer));
}

/** Bumps the generation of one entry (publication, activation, entry activation/deactivation). Never throws; never waits beyond the deadline. */
export const invalidateEntry = (cache: ConfigCache | undefined, env: string, entryKey: string): Promise<void> =>
  cache ? bounded(() => cache.incr(entryGenKey(env, entryKey)), undefined) : Promise.resolve();
/** Bumps the locale generation (any locale registration or activation change). Never throws; never waits beyond the deadline. */
export const invalidateLocales = (cache: ConfigCache | undefined, env: string): Promise<void> =>
  cache ? bounded(() => cache.incr(localeGenKey(env)), undefined) : Promise.resolve();

// ---------------------------------------------------------------- serialization
interface Wire extends Omit<ResolvedContent, 'effectiveFrom' | 'effectiveTo'> {
  effectiveFrom: string;
  effectiveTo: string | null;
}
const ser = (r: ResolvedContent): string =>
  JSON.stringify({ ...r, effectiveFrom: r.effectiveFrom.toISOString(), effectiveTo: r.effectiveTo?.toISOString() ?? null } satisfies Wire);
function de(s: string): ResolvedContent {
  const o = JSON.parse(s) as Wire;
  if (typeof o !== 'object' || o === null || typeof o.versionId !== 'string' || typeof o.body !== 'string') throw new Error('malformed cache entry');
  return { ...o, effectiveFrom: new Date(o.effectiveFrom), effectiveTo: o.effectiveTo ? new Date(o.effectiveTo) : null };
}
/** Only STANDARD, non-LEGAL entries may ever be stored (defense in depth: criticality alone should already exclude legal copy). */
const cacheable = (r: ResolvedContent): boolean => r.criticality === 'STANDARD' && r.contentType !== 'LEGAL';

const CONNECTIVITY_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
/**
 * Whether an error means "the database could not answer": connection failures, pool exhaustion, timeouts, server shutdown or crash.
 * Typed ContentErrors, programming errors, SQL-level rejections (syntax, data, integrity classes) and unrecognized errors are NOT outages,
 * so a bug can never be masked by serving last-known-good copy. Only outages may trigger LKG (and map to UNAVAILABLE).
 */
export function isDatabaseOutage(err: unknown): boolean {
  if (err instanceof ContentError) return false;
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError || err instanceof SyntaxError) return false;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (CONNECTIVITY_CODES.has(code) || /^(08|53|57|58)[0-9A-Z]{3}$/.test(code))) return true;
  if (typeof code === 'string' && /^(22|23|25|40|42)[0-9A-Z]{3}$/.test(code)) return false;
  return err instanceof Error && /connect|connection|timeout|timed out|terminat|socket|ECONN/i.test(err.message);
}

export interface PolicyArgs {
  keys: string[];
  /** Canonical requested locale. */
  locale: string;
  ctx: ContentContext;
  /** Explicit evaluation time bypasses the cache and LKG (historical or future lookups are always authoritative). */
  at?: Date;
  cache?: ConfigCache;
  env: string;
  cacheTtlSeconds: number;
  lkgMaxAgeSeconds: number;
  load: (keys: string[]) => Promise<BatchResult>;
  now?: () => number;
  /** Deadline of each cache call (default CACHE_CALL_DEADLINE_MS). */
  cacheDeadlineMs?: number;
}
export interface PolicyResult {
  resolved: Map<string, ResolvedContent>;
  sources: Map<string, Source>;
  /** Definitive database answers for keys without usable content. */
  missing: Map<string, MissingCode>;
  /** The keys in `missing` (NO_CONTENT) whose entry is INTERNAL: callers without INTERNAL visibility must report them as ENTRY_NOT_FOUND. */
  internalMissing: Set<string>;
}

export async function resolveWithPolicy(a: PolicyArgs): Promise<PolicyResult> {
  const now = a.now ?? Date.now;
  const resolved = new Map<string, ResolvedContent>();
  const sources = new Map<string, Source>();
  const missing = new Map<string, MissingCode>();
  const internalMissing = new Set<string>();
  const deadline = a.cacheDeadlineMs ?? CACHE_CALL_DEADLINE_MS;
  const mget = (keys: string[]): Promise<(string | null)[]> =>
    bounded(
      () => a.cache!.mget(keys),
      keys.map(() => null),
      deadline,
    );
  const useCache = !a.at && !!a.cache;
  const ch = contextHash(a.ctx);
  const gens = new Map<string, string>();
  let locGen = '0';
  let misses = [...a.keys];

  if (useCache) {
    const genVals = await mget([localeGenKey(a.env), ...a.keys.map((k) => entryGenKey(a.env, k))]);
    locGen = genVals[0] ?? '0';
    a.keys.forEach((k, i) => gens.set(k, genVals[i + 1] ?? '0'));
    const entries = await mget(a.keys.map((k) => resolutionKey(a.env, k, gens.get(k)!, locGen, a.locale, ch)));
    misses = [];
    a.keys.forEach((k, i) => {
      const raw = entries[i];
      if (raw) {
        try {
          const e = JSON.parse(raw) as { r: string; validUntil: number | null };
          const r = de(e.r);
          // Valid while at least one second remains before the next boundary: a value must never outlive the instant it stops applying.
          if (cacheable(r) && (e.validUntil === null || e.validUntil - 1000 > now())) {
            resolved.set(k, r);
            sources.set(k, 'cache');
            return;
          }
        } catch {
          // malformed entry: treat as a miss
        }
      }
      misses.push(k);
    });
  }
  if (!misses.length) return { resolved, sources, missing, internalMissing };

  let batch: BatchResult;
  try {
    batch = await a.load(misses);
  } catch (err) {
    if (!isDatabaseOutage(err)) throw err;
    // The database could not answer. Serve last-known-good only if EVERY missing key has a fresh STANDARD one.
    if (!a.at && a.cache) {
      const raws = await mget(misses.map((k) => lkgKey(a.env, k, a.locale, ch)));
      const usable: ResolvedContent[] = [];
      for (const raw of raws) {
        const r = raw ? parseLkg(raw, a.lkgMaxAgeSeconds, now()) : null;
        if (!r) break;
        usable.push(r);
      }
      if (usable.length === misses.length) {
        misses.forEach((k, i) => {
          resolved.set(k, usable[i]!);
          sources.set(k, 'lkg');
        });
        return { resolved, sources, missing, internalMissing };
      }
    }
    // The cause is the driver's message (connection or SQL error text); it never contains copy.
    throw new ContentError('UNAVAILABLE', 'the content database is unavailable and no safe last-known-good content exists', {
      keys: misses,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  for (const k of batch.unknown) missing.set(k, 'ENTRY_NOT_FOUND');
  for (const m of batch.missing) {
    missing.set(m.key, 'NO_CONTENT');
    if (m.sensitivity === 'INTERNAL') internalMissing.add(m.key);
  }
  const ttl = batch.nextChangeAt ? Math.min(a.cacheTtlSeconds, Math.floor((batch.nextChangeAt.getTime() - now()) / 1000)) : a.cacheTtlSeconds;
  const writes: Promise<void>[] = [];
  for (const [k, r] of batch.resolved) {
    resolved.set(k, r);
    sources.set(k, 'db');
    // Requests outside the bounded key space (inactive requested locale, unknown context references) are never written, see the header.
    if (a.cache && !a.at && batch.cacheable && cacheable(r)) {
      if (ttl > 1 && useCache)
        writes.push(
          bounded(
            () =>
              a.cache!.set(
                resolutionKey(a.env, k, gens.get(k) ?? '0', locGen, a.locale, ch),
                JSON.stringify({ r: ser(r), validUntil: batch.nextChangeAt ? batch.nextChangeAt.getTime() : null }),
                ttl,
              ),
            undefined,
            deadline,
          ),
        );
      writes.push(
        bounded(() => a.cache!.set(lkgKey(a.env, k, a.locale, ch), JSON.stringify({ r: ser(r), storedAt: now() }), a.lkgMaxAgeSeconds), undefined, deadline),
      );
    }
  }
  // Independent writes run in parallel: the cost of a degraded cache is one deadline per batch, not one per key.
  await Promise.all(writes);
  return { resolved, sources, missing, internalMissing };
}

function parseLkg(raw: string, maxAgeSeconds: number, nowMs: number): ResolvedContent | null {
  try {
    const e = JSON.parse(raw) as { r: string; storedAt: number };
    const r = de(e.r);
    if (!cacheable(r)) return null;
    if (typeof e.storedAt !== 'number' || nowMs - e.storedAt > maxAgeSeconds * 1000) return null;
    // Copy whose own end has passed is not served: after its end the database would have answered with a successor or no content.
    if (r.effectiveTo && r.effectiveTo.getTime() <= nowMs) return null;
    return r;
  } catch {
    return null;
  }
}
