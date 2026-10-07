// Ports that let geography (which depends on this package, never the reverse) feed the content service. Both are optional: without them the
// service behaves exactly as before (no market default derivation, no COUNTRY/MARKET reference validation, no visibility filtering).
export type { ScopeReferenceCheck, ScopeReferenceValidator } from '@bananagig/configuration';

export interface MarketDefaultsProvider {
  /** The default locale (canonical tag) of the market with this code, or null when the market is unknown or has no usable default. */
  defaultLocale(marketCode: string): Promise<string | null>;
  /**
   * Optional. Whether the COUNTRY or MARKET reference is VISIBLE to the public: it exists, is ACTIVE and (markets) is in effect, i.e. exactly what
   * the public geography API shows. The content service uses it for PUBLIC resolution (`includeInternal: false`) to drop a context member that
   * the caller may not know about, so a PLANNED, INACTIVE or unknown market all behave like no market at all (platform scope only) and cannot be
   * told apart. Management callers never consult it. A provider that omits the method disables the filter; one that throws makes the member
   * count as NOT visible (fail closed).
   */
  isVisible?(scopeType: 'COUNTRY' | 'MARKET', ref: string): Promise<boolean>;
}
