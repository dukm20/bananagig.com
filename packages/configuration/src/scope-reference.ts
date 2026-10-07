// Port: proves that a COUNTRY or MARKET scope reference names something real. Implemented by the geography package (which depends on this one),
// so configuration and content never import geography. Both services work unchanged when no validator is supplied.
import type { ScopeType } from '@bananagig/contracts';

export type ScopeReferenceCheck = { valid: true } | { valid: false; reason: string };

export interface ScopeReferenceValidator {
  /** Scope types the implementation does not own (PLATFORM and anything else) must return `{ valid: true }`. */
  validate(scopeType: ScopeType, scopeRef: string): Promise<ScopeReferenceCheck>;
}
