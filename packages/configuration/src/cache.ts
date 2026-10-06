// Resolution caching and last-known-good (LKG). PostgreSQL is the source of truth; Valkey is only an accelerator.
//  - A cache entry is valid until `validUntil` = the next instant any applicable value starts/ends, capped by the TTL.
//  - Publication bumps a per-parameter generation, which is part of the entry key (instant invalidation).
//  - CRITICAL parameters are never cached and never served from LKG.
//  - LKG is used ONLY when the database cannot be reached. A definitive "no value" from the database is authoritative.
import { createHash } from 'node:crypto';
import type { ConfigContext } from '@bananagig/contracts';
import { recordConfigError, recordConfigResolution } from '@bananagig/observability';
import { ConfigurationError } from './errors';
import { assertComplete, type BatchResult, type Resolved } from './resolver';

export interface ConfigCache {
  get(key: string): Promise<string | null>;
  mget(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  incr(key: string): Promise<void>;
}

interface ValkeyLike {
  get(k: string): Promise<string | null>;
  mget(...k: string[]): Promise<(string | null)[]>;
  set(k: string, v: string, mode: 'EX', s: number): Promise<unknown>;
  incr(k: string): Promise<unknown>;
}

export interface ValkeyCacheOptions {
  /** Upper bound for every cache command. A command that has not answered by then degrades to a miss/no-op. Default 100 ms. */
  commandTimeoutMs?: number;
  /** After one failure or timeout every command short-circuits for this long, then a single probe command is let through. Default 5000 ms. */
  breakerCooldownMs?: number;
  /** Clock for the breaker (tests). Default Date.now. */
  now?: () => number;
}
export const DEFAULT_CACHE_COMMAND_TIMEOUT_MS = 100;
export const DEFAULT_CACHE_BREAKER_COOLDOWN_MS = 5000;

/**
 * Valkey adapter. Every failure degrades to a miss/no-op: a cache outage can never change a result, and it is bounded so it cannot slow one either.
 *  - Every command is raced against a timeout (a hung or unreachable server cannot hold a request).
 *  - A circuit breaker opens after one failure or timeout: for the cooldown all commands return the degraded result immediately (no I/O), then ONE
 *    probe command is let through; its success closes the breaker, its failure re-opens it. Concurrent commands during the probe short-circuit.
 */
export class ValkeyConfigCache implements ConfigCache {
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  /** 0 = closed. Otherwise the breaker is open until this instant, after which the next command is the probe. */
  private openUntil = 0;
  private probing = false;

  constructor(
    private readonly client: ValkeyLike,
    options: ValkeyCacheOptions = {},
  ) {
    this.timeoutMs = options.commandTimeoutMs ?? DEFAULT_CACHE_COMMAND_TIMEOUT_MS;
    this.cooldownMs = options.breakerCooldownMs ?? DEFAULT_CACHE_BREAKER_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  private async guarded<T>(run: () => Promise<T>, degraded: () => T): Promise<T> {
    const t = this.now();
    let probe = false;
    if (this.openUntil !== 0) {
      if (t < this.openUntil || this.probing) return degraded();
      this.probing = probe = true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<T> | undefined;
    try {
      pending = run();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('cache command timed out')), this.timeoutMs);
      });
      const result = await Promise.race([pending, timeout]);
      this.openUntil = 0;
      return result;
    } catch {
      // A command that lost the race may still reject later; it must never surface as an unhandled rejection.
      pending?.catch(() => undefined);
      this.openUntil = this.now() + this.cooldownMs;
      return degraded();
    } finally {
      if (timer) clearTimeout(timer);
      if (probe) this.probing = false;
    }
  }

  async get(key: string): Promise<string | null> {
    return this.guarded(
      () => this.client.get(key),
      () => null,
    );
  }
  async mget(keys: string[]): Promise<(string | null)[]> {
    if (!keys.length) return [];
    return this.guarded(
      () => this.client.mget(...keys),
      () => keys.map(() => null),
    );
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.guarded(
      () => this.client.set(key, value, 'EX', Math.max(1, Math.floor(ttlSeconds))),
      () => undefined,
    );
  }
  async incr(key: string): Promise<void> {
    await this.guarded(
      () => this.client.incr(key),
      () => undefined,
    );
  }
}

/** In-memory cache for tests; `fail` simulates a Valkey outage. */
export class MemoryConfigCache implements ConfigCache {
  readonly data = new Map<string, string>();
  fail = false;
  async get(key: string): Promise<string | null> {
    return this.fail ? null : (this.data.get(key) ?? null);
  }
  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => (this.fail ? null : (this.data.get(k) ?? null)));
  }
  async set(key: string, value: string): Promise<void> {
    if (!this.fail) this.data.set(key, value);
  }
  async incr(key: string): Promise<void> {
    if (!this.fail) this.data.set(key, String(Number(this.data.get(key) ?? 0) + 1));
  }
}

export const contextHash = (ctx: ConfigContext): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(ctx)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest('hex')
    .slice(0, 16);

const ser = (r: Resolved): string => JSON.stringify({ ...r, effectiveFrom: r.effectiveFrom.toISOString(), effectiveTo: r.effectiveTo?.toISOString() ?? null });
const de = (s: string): Resolved => {
  const o = JSON.parse(s) as Resolved & { effectiveFrom: string; effectiveTo: string | null };
  return { ...o, effectiveFrom: new Date(o.effectiveFrom), effectiveTo: o.effectiveTo ? new Date(o.effectiveTo) : null };
};

export interface PolicyArgs {
  keys: string[];
  ctx: ConfigContext;
  /** Explicit evaluation time bypasses the cache and LKG (historical or future lookups are always authoritative). */
  at?: Date;
  cache?: ConfigCache;
  env: string;
  cacheTtlSeconds: number;
  lkgMaxAgeSeconds: number;
  load: (keys: string[]) => Promise<BatchResult>;
  now?: () => number;
}
export type Source = 'cache' | 'db' | 'lkg';

export async function resolveWithPolicy(a: PolicyArgs): Promise<{ resolved: Map<string, Resolved>; sources: Map<string, Source> }> {
  const now = a.now ?? Date.now;
  const resolved = new Map<string, Resolved>();
  const sources = new Map<string, Source>();
  const useCache = !a.at && !!a.cache;
  const ch = contextHash(a.ctx);
  const gens = new Map<string, string>();
  let misses = [...a.keys];

  if (useCache) {
    const genVals = await a.cache!.mget(a.keys.map((k) => `bg:${a.env}:cfg:gen:${k}`));
    a.keys.forEach((k, i) => gens.set(k, genVals[i] ?? '0'));
    const entries = await a.cache!.mget(a.keys.map((k) => `bg:${a.env}:cfg:v1:${k}:${gens.get(k)}:${ch}`));
    misses = [];
    a.keys.forEach((k, i) => {
      const raw = entries[i];
      if (raw) {
        const e = JSON.parse(raw) as { r: string; validUntil: number | null };
        if (e.validUntil === null || e.validUntil - 1000 > now()) {
          resolved.set(k, de(e.r));
          sources.set(k, 'cache');
          recordConfigResolution('cache');
          return;
        }
      }
      misses.push(k);
    });
  }
  if (!misses.length) return { resolved, sources };

  let batch: BatchResult;
  try {
    batch = await a.load(misses);
  } catch (err) {
    if (err instanceof ConfigurationError) throw err;
    // The database could not answer. Serve last-known-good only if EVERY missing key has one (all STANDARD, within max age).
    if (!a.at && a.cache) {
      const lkg = await a.cache.mget(misses.map((k) => `bg:${a.env}:cfg:lkg:${k}:${ch}`));
      if (lkg.every((v) => v !== null)) {
        misses.forEach((k, i) => {
          resolved.set(k, de(lkg[i]!));
          sources.set(k, 'lkg');
          recordConfigResolution('lkg');
        });
        recordConfigError('LKG_SERVED');
        return { resolved, sources };
      }
    }
    recordConfigError('UNAVAILABLE');
    // The cause is the driver's message (connection/SQL error text); it never contains configuration values.
    throw new ConfigurationError('UNAVAILABLE', 'configuration database is unavailable and no safe last-known-good value exists', {
      keys: misses,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    assertComplete(batch);
  } catch (err) {
    if (err instanceof ConfigurationError) recordConfigError(err.code);
    throw err;
  }
  const ttl = batch.nextChangeAt ? Math.min(a.cacheTtlSeconds, Math.floor((batch.nextChangeAt.getTime() - now()) / 1000)) : a.cacheTtlSeconds;
  for (const [k, r] of batch.resolved) {
    resolved.set(k, r);
    sources.set(k, 'db');
    recordConfigResolution('db');
    if (a.cache && r.criticality === 'STANDARD' && !a.at) {
      if (ttl > 1)
        await a.cache.set(
          `bg:${a.env}:cfg:v1:${k}:${gens.get(k) ?? '0'}:${ch}`,
          JSON.stringify({ r: ser(r), validUntil: batch.nextChangeAt ? batch.nextChangeAt.getTime() : null }),
          ttl,
        );
      await a.cache.set(`bg:${a.env}:cfg:lkg:${k}:${ch}`, ser(r), a.lkgMaxAgeSeconds);
    }
  }
  return { resolved, sources };
}

export const invalidateParameter = (cache: ConfigCache | undefined, env: string, key: string): Promise<void> =>
  cache ? cache.incr(`bg:${env}:cfg:gen:${key}`) : Promise.resolve();
