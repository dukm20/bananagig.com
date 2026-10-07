// Provider-neutral address adapter boundary. No vendor is selected in this checkpoint: these interfaces are what a production autocomplete, geocoder
// or address verification adapter will implement, and the deterministic in-memory mocks below (no network) are what tests and CI use. Which provider
// serves a country is decided by the `providers` resolvers handed to AddressService (a per-country configuration value in a later checkpoint).
//
// A provider that fails, times out, or returns something unusable is treated as UNAVAILABLE by the service and the flow falls back to manual entry,
// so an adapter must throw (or return null) rather than guess. Adapters receive address data and must never log it.
import type { AddressInput, NormalizedAddressDto } from '@bananagig/contracts';

export interface AddressSuggestionQuery {
  countryCode: string;
  /** What the person has typed so far. */
  text: string;
  locale?: string;
  limit?: number;
}
export interface AddressSuggestion {
  /** Opaque, provider-defined. */
  suggestionId: string;
  /** Display text of the suggestion. */
  label: string;
}
/** Structured fields a provider resolved a suggestion to. The service validates them against the country format like any other input. */
export interface ProviderAddress {
  address: AddressInput;
  /** Provider's own identifier of the place (stored as provider_reference). */
  providerReference?: string | null;
}
export interface AddressAutocompleteProvider {
  /** Lower-case adapter code (stored as provider_code), for example `mock`. */
  readonly code: string;
  suggest(query: AddressSuggestionQuery): Promise<AddressSuggestion[]>;
  resolve(suggestionId: string, context: { countryCode: string; locale?: string }): Promise<ProviderAddress | null>;
}

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  /** IANA name; stored only when it is a registered ACTIVE time zone. */
  timeZone?: string | null;
  providerReference?: string | null;
}
export interface GeocoderProvider {
  readonly code: string;
  /** null when the address cannot be located. */
  geocode(address: NormalizedAddressDto): Promise<GeocodeResult | null>;
}

export type VerificationVerdict = 'VERIFIED' | 'INVALID' | 'UNKNOWN';
/** Address verification vendor boundary (deliverability checks). Implemented by a later checkpoint; the contract is fixed here. */
export interface AddressValidationProvider {
  readonly code: string;
  validate(address: NormalizedAddressDto): Promise<{ verdict: VerificationVerdict; providerReference?: string | null }>;
}

/** Resolvers that choose the provider for a country (undefined: none configured, the manual path is used). */
export interface AddressProviders {
  autocomplete?: (countryCode: string) => AddressAutocompleteProvider | undefined;
  geocoder?: (countryCode: string) => GeocoderProvider | undefined;
  validation?: (countryCode: string) => AddressValidationProvider | undefined;
}

export class ProviderUnavailableError extends Error {
  constructor(message = 'the address provider is unavailable') {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export const isValidCoordinate = (latitude: unknown, longitude: unknown): boolean =>
  typeof latitude === 'number' &&
  typeof longitude === 'number' &&
  Number.isFinite(latitude) &&
  Number.isFinite(longitude) &&
  latitude >= -90 &&
  latitude <= 90 &&
  longitude >= -180 &&
  longitude <= 180;

// ---------------------------------------------------------------- deterministic mocks (no network; tests and CI)
export interface MockPlace {
  id: string;
  countryCode: string;
  label: string;
  address: AddressInput;
  latitude?: number;
  longitude?: number;
  timeZone?: string;
}
const key = (a: { countryCode: string; addressLine1?: string; locality?: string; postalCode?: string }): string =>
  [a.countryCode, a.addressLine1 ?? '', a.locality ?? '', a.postalCode ?? ''].map((s) => s.trim().toLowerCase()).join('|');

/** An in-memory autocomplete provider over a fixed list of places. `failing` makes every call throw ProviderUnavailableError. */
export class MockAddressAutocompleteProvider implements AddressAutocompleteProvider {
  readonly code: string;
  failing = false;
  readonly calls: string[] = [];
  constructor(
    private readonly places: readonly MockPlace[],
    code = 'mock',
  ) {
    this.code = code;
  }
  async suggest(q: AddressSuggestionQuery): Promise<AddressSuggestion[]> {
    this.calls.push('suggest');
    if (this.failing) throw new ProviderUnavailableError();
    const needle = q.text.trim().toLowerCase();
    return this.places
      .filter((p) => p.countryCode === q.countryCode && p.label.toLowerCase().includes(needle))
      .slice(0, q.limit ?? 5)
      .map((p) => ({ suggestionId: p.id, label: p.label }));
  }
  async resolve(id: string, context: { countryCode: string }): Promise<ProviderAddress | null> {
    this.calls.push('resolve');
    if (this.failing) throw new ProviderUnavailableError();
    const p = this.places.find((x) => x.id === id && x.countryCode === context.countryCode);
    return p ? { address: p.address, providerReference: p.id } : null;
  }
}

/** An in-memory geocoder keyed by normalized street, locality and postal code. */
export class MockGeocoder implements GeocoderProvider {
  readonly code: string;
  failing = false;
  readonly calls: string[] = [];
  constructor(
    private readonly places: readonly MockPlace[],
    code = 'mock',
  ) {
    this.code = code;
  }
  async geocode(address: NormalizedAddressDto): Promise<GeocodeResult | null> {
    this.calls.push('geocode');
    if (this.failing) throw new ProviderUnavailableError();
    const wanted = key({
      countryCode: address.countryCode,
      addressLine1: address.addressLine1,
      locality: address.locality ?? '',
      postalCode: address.postalCode ?? '',
    });
    const p = this.places.find((x) => x.latitude !== undefined && x.longitude !== undefined && key({ ...x.address, countryCode: x.countryCode }) === wanted);
    return p ? { latitude: p.latitude!, longitude: p.longitude!, timeZone: p.timeZone ?? null, providerReference: p.id } : null;
  }
}

/** An in-memory verification provider: addresses of the listed places are VERIFIED, everything else UNKNOWN (or INVALID when `rejectUnknown`). */
export class MockAddressValidationProvider implements AddressValidationProvider {
  readonly code: string;
  failing = false;
  rejectUnknown = false;
  constructor(
    private readonly places: readonly MockPlace[],
    code = 'mock',
  ) {
    this.code = code;
  }
  async validate(address: NormalizedAddressDto): Promise<{ verdict: VerificationVerdict; providerReference?: string | null }> {
    if (this.failing) throw new ProviderUnavailableError();
    const wanted = key({
      countryCode: address.countryCode,
      addressLine1: address.addressLine1,
      locality: address.locality ?? '',
      postalCode: address.postalCode ?? '',
    });
    const p = this.places.find((x) => key({ ...x.address, countryCode: x.countryCode }) === wanted);
    return p ? { verdict: 'VERIFIED', providerReference: p.id } : { verdict: this.rejectUnknown ? 'INVALID' : 'UNKNOWN' };
  }
}
