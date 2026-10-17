// Scope reference validation for the CATEGORY configuration scope (CFG-001), implemented on top of the catalogue. The interface is declared here structurally (the
// configuration package declares the same shape; no package imports the other). DEBT-0024: the same port geography implements for COUNTRY and MARKET.
import { CATALOG_CODE_PATTERN, CATALOG_CODE_MAX, CATALOG_CODE_MIN } from '@bananagig/contracts';
import type { CatalogService } from './service';
import { CatalogError } from './errors';

export type ScopeReferenceResult = { valid: true } | { valid: false; reason: string };
export interface ScopeReferenceValidator {
  validate(scopeType: string, scopeRef: string | null | undefined): Promise<ScopeReferenceResult>;
}

/** The ONE reason ever returned: it must not tell the caller (any admin role may create configuration drafts) which case applied. */
export const CATEGORY_SCOPE_REFERENCE_INVALID_REASON = 'the scope reference is not valid';

/**
 * A CATEGORY reference must be the canonical category code (matched by exact string downstream), must exist and must not be RETIRED (DRAFT, ACTIVE and INACTIVE are
 * valid: configuration can be prepared before a category launches, like a PLANNED market). Any other scope type is not the catalogue's domain and is reported valid.
 * Database outages are NOT turned into "invalid": the typed UNAVAILABLE error propagates.
 */
export function createCatalogScopeReferenceValidator(service: Pick<CatalogService, 'getCategory'>): ScopeReferenceValidator {
  // a FRESH object per call: a caller that edits a result must not change what the next caller gets
  const invalidReference = (): ScopeReferenceResult => ({ valid: false, reason: CATEGORY_SCOPE_REFERENCE_INVALID_REASON });
  return {
    async validate(scopeType, scopeRef) {
      if (scopeType !== 'CATEGORY') return { valid: true };
      if (typeof scopeRef !== 'string' || scopeRef.length < CATALOG_CODE_MIN || scopeRef.length > CATALOG_CODE_MAX || !CATALOG_CODE_PATTERN.test(scopeRef))
        return invalidReference();
      try {
        const category = await service.getCategory(scopeRef);
        return category.status === 'RETIRED' ? invalidReference() : { valid: true };
      } catch (err) {
        if (err instanceof CatalogError && err.code === 'CATEGORY_NOT_FOUND') return invalidReference();
        throw err;
      }
    },
  };
}
