// The content registry's `MarketDefaultsProvider` port, implemented here without importing the content package (structural typing).
import type { GeographyService } from './service';
import { GeographyError } from './errors';
import { isCountryCode, isMarketCode } from './validation';

export interface MarketDefaultsProvider {
  /** The default locale of the market, or null when the market is unknown or not in effect. */
  defaultLocale(marketCode: string): Promise<string | null>;
  /** Whether the COUNTRY or MARKET reference is visible to the public: it exists, is ACTIVE and (markets) in effect, as the public API shows it. */
  isVisible(scopeType: 'COUNTRY' | 'MARKET', ref: string): Promise<boolean>;
}
export interface MarketDefaultsProviderOptions {
  /** Memo lifetime (default 60 s). */
  ttlMs?: number;
  /** Upper bound of memoized entries per kind (default 500); the oldest entries are dropped first. */
  maxEntries?: number;
  now?: () => number;
}
export const DEFAULT_PROVIDER_TTL_MS = 60_000;

/**
 * A bounded in-process memo with stale-on-error and single-flight lookups, keyed by already-validated references (arbitrary input never gets
 * here, so it cannot grow the memo). If `fetch` fails, the last memoized value is served even when stale (and nothing is cached); with no value to
 * serve the error propagates. Concurrent lookups of one key share one query.
 */
function memoized<T>(fetch: (key: string) => Promise<T>, ttl: number, max: number, now: () => number): (key: string) => Promise<T> {
  const memo = new Map<string, { value: T; expires: number }>();
  const inflight = new Map<string, Promise<T>>();
  return (key) => {
    const hit = memo.get(key);
    if (hit && hit.expires > now()) return Promise.resolve(hit.value);
    let p = inflight.get(key);
    if (!p) {
      p = fetch(key)
        .then((value) => {
          memo.delete(key);
          memo.set(key, { value, expires: now() + ttl });
          while (memo.size > max) memo.delete(memo.keys().next().value as string);
          return value;
        })
        .catch((err) => {
          if (hit) return hit.value; // stale beats unavailable
          throw err;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  };
}

/**
 * Looks up the default locale of an ACTIVE market that is in effect (public view), and whether a country or market is publicly visible. Both are
 * answered from the PUBLIC service reads, so "visible" is exactly what the public geography API shows. Results, including "unknown" (null/false),
 * are memoized in-process for 60 s. If the database errors, the last memoized value is served even when stale (and nothing is cached); with no
 * value to serve the typed error propagates (the content service degrades `defaultLocale` to "no market default" and treats an `isVisible` failure
 * as NOT visible: fail closed). Concurrent lookups share one query. A market's visibility reuses the default-locale memo (one public read answers both).
 */
export function createMarketDefaultsProvider(
  service: Pick<GeographyService, 'getMarket'> & Partial<Pick<GeographyService, 'getCountry'>>,
  options: MarketDefaultsProviderOptions = {},
): MarketDefaultsProvider {
  const ttl = options.ttlMs ?? DEFAULT_PROVIDER_TTL_MS;
  const max = options.maxEntries ?? 500;
  const now = options.now ?? Date.now;

  const marketLocale = memoized(
    async (code: string): Promise<string | null> => {
      try {
        return (await service.getMarket(code)).defaultLocale;
      } catch (err) {
        if (err instanceof GeographyError && err.code === 'MARKET_NOT_FOUND') return null;
        throw err;
      }
    },
    ttl,
    max,
    now,
  );
  const countryVisible = memoized(
    async (code: string): Promise<boolean> => {
      if (!service.getCountry) return false; // no country lookup available: nothing can be proven visible (fail closed)
      try {
        await service.getCountry(code);
        return true;
      } catch (err) {
        if (err instanceof GeographyError && err.code === 'COUNTRY_NOT_FOUND') return false;
        throw err;
      }
    },
    ttl,
    max,
    now,
  );

  return {
    async defaultLocale(marketCode) {
      if (!isMarketCode(marketCode)) return null; // never memoized: arbitrary input must not grow the memo
      return marketLocale(marketCode);
    },
    async isVisible(scopeType, ref) {
      if (scopeType === 'MARKET') return isMarketCode(ref) && (await marketLocale(ref)) !== null;
      if (scopeType === 'COUNTRY') return isCountryCode(ref) && countryVisible(ref);
      return false;
    },
  };
}
