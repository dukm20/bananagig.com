// Composition helpers for the catalogue (CAT-001): the ports of CatalogService and of the configuration scope references that need other packages, wired in the API
// composition root. They live here (not in the packages) so `catalog` never imports `geography` and `configuration` never imports `catalog`.
import { CatalogError, type MarketGate } from '@bananagig/catalog';
import { GeographyError, type GeographyService } from '@bananagig/geography';

/**
 * The public visibility of a market is decided by the geography registry and by nothing else: a market is public while it is ACTIVE and in effect (the same rule as
 * GET /geography/markets/:code, cached by geography's own generation). Everything else (unknown, PLANNED, INACTIVE, outside its window) is "not public". A geography outage
 * is a typed catalogue UNAVAILABLE, never "not public" (a good market must not look unknown) and never a default.
 */
export function createMarketGate(geography: Pick<GeographyService, 'getMarket'>): MarketGate {
  return {
    async publicMarket(code) {
      try {
        const market = await geography.getMarket(code);
        return { code: market.code, defaultLocale: market.defaultLocale };
      } catch (err) {
        if (err instanceof GeographyError && err.code === 'MARKET_NOT_FOUND') return null;
        if (err instanceof GeographyError && err.code === 'UNAVAILABLE') throw new CatalogError('UNAVAILABLE', 'the market registry is unavailable');
        throw err;
      }
    },
  };
}

type ScopeCheck = { valid: true } | { valid: false; reason: string };
interface ScopeValidator {
  validate(scopeType: string, scopeRef: string | null | undefined): Promise<ScopeCheck>;
}
/**
 * One scope reference validator out of several owners: each implementation reports `{ valid: true }` for the scope types it does not own (geography: COUNTRY and MARKET,
 * the catalogue: CATEGORY), so the first refusal wins and a type nobody owns stays valid (DEBT-0024 until the remaining scope domains exist).
 */
export function composeScopeReferenceValidators(validators: readonly ScopeValidator[]): ScopeValidator {
  return {
    async validate(scopeType, scopeRef) {
      for (const v of validators) {
        const r = await v.validate(scopeType, scopeRef);
        if (!r.valid) return r;
      }
      return { valid: true };
    },
  };
}
