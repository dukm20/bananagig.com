// Unit tests of the provider boundary: the deterministic in-memory mocks (no network) and the coordinate guard.
import { describe, expect, it } from 'vitest';
import type { NormalizedAddressDto } from '@bananagig/contracts';
import {
  MockAddressAutocompleteProvider,
  MockAddressValidationProvider,
  MockGeocoder,
  ProviderUnavailableError,
  isValidCoordinate,
  type MockPlace,
} from './address-providers';

const PLACES: MockPlace[] = [
  {
    id: 'p1',
    countryCode: 'US',
    label: '1600 Amphitheatre Pkwy, Mountain View, CA',
    address: { countryCode: 'US', addressLine1: '1600 Amphitheatre Pkwy', locality: 'Mountain View', administrativeArea: 'CA', postalCode: '94043' },
    latitude: 37.422,
    longitude: -122.084,
    timeZone: 'America/Los_Angeles',
  },
  {
    id: 'p2',
    countryCode: 'US',
    label: '1 Infinite Loop, Cupertino, CA',
    address: { countryCode: 'US', addressLine1: '1 Infinite Loop', locality: 'Cupertino', administrativeArea: 'CA', postalCode: '95014' },
    latitude: 37.33,
    longitude: -122.03,
  },
  {
    id: 'p3',
    countryCode: 'US',
    label: '1 Main St, Springfield, IL (no coordinates)',
    address: { countryCode: 'US', addressLine1: '1 Main St', locality: 'Springfield', administrativeArea: 'IL', postalCode: '62701' },
  },
  {
    id: 'p4',
    countryCode: 'QA',
    label: '1600 Amphitheatre Pkwy, Elsewhere',
    address: { countryCode: 'QA', addressLine1: '1600 Amphitheatre Pkwy', locality: 'Mountain View', postalCode: '94043' },
    latitude: 1,
    longitude: 2,
  },
];
const normalized = (over: Partial<NormalizedAddressDto> = {}): NormalizedAddressDto => ({
  countryCode: 'US',
  organization: null,
  addressLine1: '1600 Amphitheatre Pkwy',
  addressLine2: null,
  dependentLocality: null,
  locality: 'Mountain View',
  administrativeAreaCode: 'CA',
  administrativeAreaName: 'California',
  postalCode: '94043',
  sortingCode: null,
  ...over,
});

describe('ProviderUnavailableError', () => {
  it('is an Error with a fixed name and a default message that carries no data', () => {
    const e = new ProviderUnavailableError();
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ProviderUnavailableError);
    expect(e.name).toBe('ProviderUnavailableError');
    expect(e.message).toBe('the address provider is unavailable');
    expect(new ProviderUnavailableError('custom').message).toBe('custom');
  });
});

describe('isValidCoordinate', () => {
  it('accepts the boundaries of the valid range', () => {
    expect(isValidCoordinate(0, 0)).toBe(true);
    expect(isValidCoordinate(90, 180)).toBe(true);
    expect(isValidCoordinate(-90, -180)).toBe(true);
    expect(isValidCoordinate(37.422, -122.084)).toBe(true);
  });
  it('rejects values just outside the range', () => {
    expect(isValidCoordinate(90.0001, 0)).toBe(false);
    expect(isValidCoordinate(-90.0001, 0)).toBe(false);
    expect(isValidCoordinate(0, 180.0001)).toBe(false);
    expect(isValidCoordinate(0, -180.0001)).toBe(false);
  });
  it('rejects NaN and the infinities in either position', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(isValidCoordinate(bad, 0), String(bad)).toBe(false);
      expect(isValidCoordinate(0, bad), String(bad)).toBe(false);
    }
  });
  it('rejects anything that is not a number', () => {
    for (const bad of ['37.4', null, undefined, {}, [], true, 10n]) {
      expect(isValidCoordinate(bad, 0)).toBe(false);
      expect(isValidCoordinate(0, bad)).toBe(false);
    }
    expect(isValidCoordinate(undefined, undefined)).toBe(false);
  });
});

describe('MockAddressAutocompleteProvider', () => {
  const make = () => new MockAddressAutocompleteProvider(PLACES);

  it('has a lower-case code, `mock` by default', () => {
    expect(make().code).toBe('mock');
    expect(new MockAddressAutocompleteProvider(PLACES, 'acme').code).toBe('acme');
  });
  it('suggests places whose label contains the typed text, case-insensitively, as id and label', async () => {
    expect(await make().suggest({ countryCode: 'US', text: 'AMPHI' })).toEqual([{ suggestionId: 'p1', label: PLACES[0]!.label }]);
    expect(await make().suggest({ countryCode: 'US', text: '  cupertino ' })).toEqual([{ suggestionId: 'p2', label: PLACES[1]!.label }]);
  });
  it('filters by country', async () => {
    expect((await make().suggest({ countryCode: 'US', text: '1600' })).map((s) => s.suggestionId)).toEqual(['p1']);
    expect((await make().suggest({ countryCode: 'QA', text: '1600' })).map((s) => s.suggestionId)).toEqual(['p4']);
    expect(await make().suggest({ countryCode: 'GB', text: '1600' })).toEqual([]);
  });
  it('returns nothing for a text that matches no label', async () => {
    expect(await make().suggest({ countryCode: 'US', text: 'zzz-nothing' })).toEqual([]);
  });
  it('limits the result (default 5, or the given limit)', async () => {
    const many = new MockAddressAutocompleteProvider(Array.from({ length: 8 }, (_, i) => ({ ...PLACES[0]!, id: `m${i}`, label: `Main St ${i}` })));
    expect(await many.suggest({ countryCode: 'US', text: 'main' })).toHaveLength(5);
    expect(await many.suggest({ countryCode: 'US', text: 'main', limit: 2 })).toHaveLength(2);
    expect(await many.suggest({ countryCode: 'US', text: 'main', limit: 20 })).toHaveLength(8);
    expect((await many.suggest({ countryCode: 'US', text: 'main', limit: 2 })).map((s) => s.suggestionId)).toEqual(['m0', 'm1']);
    expect(await many.suggest({ countryCode: 'US', text: 'main', limit: 0 })).toEqual([]);
  });
  it('resolves a suggestion to its structured address and the place id as provider reference', async () => {
    expect(await make().resolve('p2', { countryCode: 'US' })).toEqual({ address: PLACES[1]!.address, providerReference: 'p2' });
  });
  it('resolves nothing for an unknown id or an id of another country', async () => {
    expect(await make().resolve('nope', { countryCode: 'US' })).toBeNull();
    expect(await make().resolve('p4', { countryCode: 'US' })).toBeNull();
    expect(await make().resolve('p1', { countryCode: 'QA' })).toBeNull();
  });
  it('records its calls', async () => {
    const p = make();
    await p.suggest({ countryCode: 'US', text: 'a' });
    await p.resolve('p1', { countryCode: 'US' });
    expect(p.calls).toEqual(['suggest', 'resolve']);
  });
  it('throws ProviderUnavailableError from suggest and resolve while `failing`, and recovers when it is reset', async () => {
    const p = make();
    p.failing = true;
    await expect(p.suggest({ countryCode: 'US', text: 'a' })).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(p.resolve('p1', { countryCode: 'US' })).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(p.calls).toEqual(['suggest', 'resolve']); // the attempts are still counted
    p.failing = false;
    await expect(p.suggest({ countryCode: 'US', text: 'amphi' })).resolves.toHaveLength(1);
  });
});

describe('MockGeocoder', () => {
  const make = () => new MockGeocoder(PLACES);

  it('has a lower-case code, `mock` by default', () => {
    expect(make().code).toBe('mock');
    expect(new MockGeocoder(PLACES, 'geo').code).toBe('geo');
  });
  it('geocodes a known address by street, locality and postal code', async () => {
    expect(await make().geocode(normalized())).toEqual({ latitude: 37.422, longitude: -122.084, timeZone: 'America/Los_Angeles', providerReference: 'p1' });
  });
  it('matches case-insensitively and ignores surrounding spaces', async () => {
    const out = await make().geocode(normalized({ addressLine1: '  1600 AMPHITHEATRE pkwy ', locality: 'mountain view ' }));
    expect(out?.providerReference).toBe('p1');
  });
  it('returns a null time zone when the place has none', async () => {
    expect(await make().geocode(normalized({ addressLine1: '1 Infinite Loop', locality: 'Cupertino', postalCode: '95014' }))).toEqual({
      latitude: 37.33,
      longitude: -122.03,
      timeZone: null,
      providerReference: 'p2',
    });
  });
  it('returns null (a miss) for an unknown address, a different postal code, or another country', async () => {
    expect(await make().geocode(normalized({ addressLine1: '99 Nowhere Rd' }))).toBeNull();
    expect(await make().geocode(normalized({ postalCode: '00000' }))).toBeNull();
    expect(await make().geocode(normalized({ countryCode: 'GB' }))).toBeNull();
  });
  it('returns the place of the right country when two countries share street, locality and postal code', async () => {
    expect((await make().geocode(normalized({ countryCode: 'QA' })))?.providerReference).toBe('p4');
  });
  it('never locates a place that has no coordinates', async () => {
    expect(await make().geocode(normalized({ addressLine1: '1 Main St', locality: 'Springfield', postalCode: '62701' }))).toBeNull();
  });
  it('treats missing locality and postal code as empty', async () => {
    expect(await make().geocode(normalized({ locality: null, postalCode: null }))).toBeNull();
  });
  it('records its calls and throws ProviderUnavailableError while `failing`', async () => {
    const g = make();
    await g.geocode(normalized());
    expect(g.calls).toEqual(['geocode']);
    g.failing = true;
    await expect(g.geocode(normalized())).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(g.calls).toEqual(['geocode', 'geocode']);
  });
});

describe('MockAddressValidationProvider', () => {
  const make = () => new MockAddressValidationProvider(PLACES);

  it('has a lower-case code, `mock` by default', () => {
    expect(make().code).toBe('mock');
    expect(new MockAddressValidationProvider(PLACES, 'verify').code).toBe('verify');
  });
  it('VERIFIES an address of a listed place, with the place id as reference (also without coordinates)', async () => {
    expect(await make().validate(normalized())).toEqual({ verdict: 'VERIFIED', providerReference: 'p1' });
    expect(await make().validate(normalized({ addressLine1: '1 Main St', locality: 'Springfield', postalCode: '62701' }))).toEqual({
      verdict: 'VERIFIED',
      providerReference: 'p3',
    });
  });
  it('is case-insensitive like the geocoder', async () => {
    expect((await make().validate(normalized({ locality: 'MOUNTAIN VIEW' }))).verdict).toBe('VERIFIED');
  });
  it('answers UNKNOWN for any other address, or INVALID when it rejects unknown addresses', async () => {
    const v = make();
    expect(await v.validate(normalized({ addressLine1: '99 Nowhere Rd' }))).toEqual({ verdict: 'UNKNOWN' });
    v.rejectUnknown = true;
    expect(await v.validate(normalized({ addressLine1: '99 Nowhere Rd' }))).toEqual({ verdict: 'INVALID' });
    expect((await v.validate(normalized())).verdict).toBe('VERIFIED'); // a listed place is still verified
  });
  it('does not verify an address of another country', async () => {
    expect((await make().validate(normalized({ countryCode: 'GB' }))).verdict).toBe('UNKNOWN');
  });
  it('throws ProviderUnavailableError while `failing`', async () => {
    const v = make();
    v.failing = true;
    await expect(v.validate(normalized())).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
