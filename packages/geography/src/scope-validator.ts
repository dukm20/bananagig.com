// Scope reference validation for configuration and content (COUNTRY and MARKET scopes), implemented on top of the geography registry.
// The interface is declared here structurally (the configuration package declares the same shape; no package imports the other).
import type { GeographyService } from './service';
import { GeographyError } from './errors';
import { scopeReferenceProblem } from './validation';

export type ScopeReferenceResult = { valid: true } | { valid: false; reason: string };
export interface ScopeReferenceValidator {
  validate(scopeType: string, scopeRef: string | null | undefined): Promise<ScopeReferenceResult>;
}

/** The ONE reason ever returned: it must not tell the caller (any admin role may create configuration or content drafts) which case applied. */
export const SCOPE_REFERENCE_INVALID_REASON = 'the scope reference is not valid';

/**
 * COUNTRY and MARKET references must be in canonical form (US, la-oc: matched by exact string downstream), must exist, and must be PLANNED
 * or ACTIVE (INACTIVE is retired). Any other scope type is not geography's domain and is reported valid. Database outages are NOT turned
 * into "invalid": the typed UNAVAILABLE error propagates so callers can fail the operation instead of rejecting good input.
 *
 * Unknown, INACTIVE and non-canonical references all return the SAME generic reason: configuration and content authors do not hold
 * geography-read, so a specific message ("does not exist", "is INACTIVE") would let them read the registry's state. What stays observable is
 * inherent to the contract: a reference that is accepted is PLANNED or ACTIVE (a PLANNED market such as la-oc validates before it is public),
 * and a rejected one is anything else; the reason carries no further detail.
 */
export function createGeographyScopeReferenceValidator(service: Pick<GeographyService, 'getCountry' | 'getMarket'>): ScopeReferenceValidator {
  const invalidReference: ScopeReferenceResult = { valid: false, reason: SCOPE_REFERENCE_INVALID_REASON };
  return {
    async validate(scopeType, scopeRef) {
      if (scopeType !== 'COUNTRY' && scopeType !== 'MARKET') return { valid: true };
      if (scopeReferenceProblem(scopeType, scopeRef)) return invalidReference;
      try {
        const status =
          scopeType === 'COUNTRY'
            ? (await service.getCountry(scopeRef as string, { management: true })).status
            : (await service.getMarket(scopeRef as string, { management: true })).status;
        return status === 'INACTIVE' ? invalidReference : { valid: true };
      } catch (err) {
        if (err instanceof GeographyError && (err.code === 'COUNTRY_NOT_FOUND' || err.code === 'MARKET_NOT_FOUND')) return invalidReference;
        throw err;
      }
    },
  };
}
