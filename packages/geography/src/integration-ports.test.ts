import { describe, expect, it } from 'vitest';
import { GeographyError } from './errors';
import { createGeographyScopeReferenceValidator, SCOPE_REFERENCE_INVALID_REASON } from './scope-validator';
import { createMarketDefaultsProvider } from './market-defaults-provider';

const missing = (kind: 'COUNTRY' | 'MARKET') => new GeographyError(kind === 'COUNTRY' ? 'COUNTRY_NOT_FOUND' : 'MARKET_NOT_FOUND', 'nf');
const fakeService = (countries: Record<string, string>, markets: Record<string, { status: string; defaultLocale: string }>) => ({
  getCountry: async (c: string) => {
    if (!countries[c]) throw missing('COUNTRY');
    return { status: countries[c] } as never;
  },
  getMarket: async (c: string, o?: { management?: boolean }) => {
    const m = markets[c];
    if (!m || (!o?.management && m.status !== 'ACTIVE')) throw missing('MARKET');
    return m as never;
  },
});

describe('scope reference validator', () => {
  const v = createGeographyScopeReferenceValidator(
    fakeService(
      { US: 'ACTIVE', CA: 'PLANNED', FR: 'INACTIVE' },
      { 'la-oc': { status: 'PLANNED', defaultLocale: 'en-US' }, retired: { status: 'INACTIVE', defaultLocale: 'en-US' } },
    ),
  );
  it('accepts existing PLANNED and ACTIVE references in canonical form', async () => {
    expect(await v.validate('COUNTRY', 'US')).toEqual({ valid: true });
    expect(await v.validate('COUNTRY', 'CA')).toEqual({ valid: true });
    expect(await v.validate('MARKET', 'la-oc')).toEqual({ valid: true });
  });
  it('rejects non-canonical, unknown and INACTIVE references with ONE generic reason that reveals nothing about the registry', async () => {
    const generic = { valid: false, reason: 'the scope reference is not valid' };
    expect(SCOPE_REFERENCE_INVALID_REASON).toBe(generic.reason);
    for (const [t, r] of [
      ['COUNTRY', 'us'], // non-canonical
      ['COUNTRY', 'USA'],
      ['MARKET', 'LA-OC'],
      ['MARKET', 'la_oc'],
      ['COUNTRY', null], // missing
      ['MARKET', undefined],
      ['COUNTRY', 'QQ'], // unknown
      ['MARKET', 'nowhere'],
      ['COUNTRY', 'FR'], // INACTIVE
      ['MARKET', 'retired'],
    ] as const)
      expect(await v.validate(t, r), `${t} ${String(r)}`).toEqual(generic);
    // the message is the same for every case, so it cannot carry the reference, the status or the word "exist"
    expect(SCOPE_REFERENCE_INVALID_REASON).not.toMatch(/INACTIVE|PLANNED|ACTIVE|retired|exist|QQ|FR|nowhere/i);
  });
  it('PLANNED and ACTIVE references validate (inherent: a market is usable in configuration and content before it is public)', async () => {
    for (const [t, r] of [
      ['COUNTRY', 'US'], // ACTIVE
      ['COUNTRY', 'CA'], // PLANNED
      ['MARKET', 'la-oc'], // PLANNED
    ] as const)
      expect(await v.validate(t, r), `${t} ${r}`).toEqual({ valid: true });
  });
  it('other scope types are not geography’s domain; unavailable errors propagate instead of becoming "invalid"', async () => {
    expect(await v.validate('PLATFORM', null)).toEqual({ valid: true });
    expect(await v.validate('USER', 'abc')).toEqual({ valid: true });
    const down = createGeographyScopeReferenceValidator({
      getCountry: async () => Promise.reject(new GeographyError('UNAVAILABLE', 'down')),
      getMarket: async () => Promise.reject(new GeographyError('UNAVAILABLE', 'down')),
    });
    await expect(down.validate('COUNTRY', 'US')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

describe('market defaults provider', () => {
  it('returns the market default locale, null for unknown markets and for malformed codes (never queried)', async () => {
    let calls = 0;
    const svc = {
      getMarket: async (c: string) => {
        calls++;
        if (c !== 'la-oc') throw missing('MARKET');
        return { defaultLocale: 'es-US' } as never;
      },
    };
    const p = createMarketDefaultsProvider(svc);
    expect(await p.defaultLocale('la-oc')).toBe('es-US');
    expect(await p.defaultLocale('nowhere')).toBeNull();
    expect(await p.defaultLocale('Bad Code')).toBeNull();
    expect(calls).toBe(2);
  });
  it('memoizes (including unknown) for 60 s, then asks again', async () => {
    let t = 0;
    let calls = 0;
    const svc = {
      getMarket: async (c: string) => {
        calls++;
        if (c === 'gone') throw missing('MARKET');
        return { defaultLocale: `v${calls}` } as never;
      },
    };
    const p = createMarketDefaultsProvider(svc, { now: () => t });
    expect(await p.defaultLocale('m')).toBe('v1');
    expect(await p.defaultLocale('gone')).toBeNull();
    t += 59_999;
    expect(await p.defaultLocale('m')).toBe('v1');
    expect(await p.defaultLocale('gone')).toBeNull();
    expect(calls).toBe(2);
    t += 2;
    expect(await p.defaultLocale('m')).toBe('v3');
  });
  it('serves the stale value when the database errors and rethrows when there is nothing to serve', async () => {
    let t = 0;
    let down = false;
    const svc = {
      getMarket: async () => {
        if (down) throw new GeographyError('UNAVAILABLE', 'down');
        return { defaultLocale: 'en-US' } as never;
      },
    };
    const p = createMarketDefaultsProvider(svc, { now: () => t });
    expect(await p.defaultLocale('m')).toBe('en-US');
    down = true;
    t += 3_600_000;
    expect(await p.defaultLocale('m')).toBe('en-US');
    await expect(p.defaultLocale('other')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    down = false;
    expect(await p.defaultLocale('other')).toBe('en-US');
  });
  it('concurrent lookups share one query; the memo is bounded', async () => {
    let calls = 0;
    const svc = {
      getMarket: async (c: string) => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return { defaultLocale: c } as never;
      },
    };
    const p = createMarketDefaultsProvider(svc, { maxEntries: 2 });
    expect(await Promise.all([p.defaultLocale('a'), p.defaultLocale('a'), p.defaultLocale('a')])).toEqual(['a', 'a', 'a']);
    expect(calls).toBe(1);
    await p.defaultLocale('b');
    await p.defaultLocale('c'); // evicts a
    await p.defaultLocale('a');
    expect(calls).toBe(4);
  });
});

describe('market defaults provider: visibility (isVisible)', () => {
  /** A public-read fake: only ACTIVE rows are found, exactly like the real service's public view. */
  const publicService = (markets: Record<string, string>, countries: Record<string, string>) => {
    const calls = { market: 0, country: 0 };
    return {
      calls,
      service: {
        getMarket: async (c: string) => {
          calls.market++;
          if (markets[c] === undefined) throw missing('MARKET');
          return { defaultLocale: markets[c] } as never;
        },
        getCountry: async (c: string) => {
          calls.country++;
          if (countries[c] === undefined) throw missing('COUNTRY');
          return { status: countries[c] } as never;
        },
      },
    };
  };

  it('a market is visible when the public read finds it; unknown and PLANNED/INACTIVE (not found publicly) are not; malformed references never reach the service', async () => {
    const { service, calls } = publicService({ live: 'en-US' }, { US: 'ACTIVE' });
    const p = createMarketDefaultsProvider(service);
    expect(await p.isVisible('MARKET', 'live')).toBe(true);
    expect(await p.isVisible('MARKET', 'planned-or-unknown')).toBe(false);
    expect(await p.isVisible('MARKET', 'Bad Code')).toBe(false);
    expect(await p.isVisible('MARKET', 'LIVE')).toBe(false);
    expect(calls.market).toBe(2);
  });

  it('a country is visible when the public read finds it', async () => {
    const { service, calls } = publicService({}, { US: 'ACTIVE' });
    const p = createMarketDefaultsProvider(service);
    expect(await p.isVisible('COUNTRY', 'US')).toBe(true);
    expect(await p.isVisible('COUNTRY', 'CA')).toBe(false); // not found publicly (PLANNED or unknown)
    expect(await p.isVisible('COUNTRY', 'us')).toBe(false);
    expect(await p.isVisible('COUNTRY', 'USA')).toBe(false);
    expect(calls.country).toBe(2);
    expect(await p.isVisible('PLATFORM' as never, 'x')).toBe(false); // not geography's domain: nothing is proven visible
  });

  it('market visibility shares the default-locale memo (one public read answers both) and both are memoized for the TTL', async () => {
    let t = 0;
    const { service, calls } = publicService({ live: 'es-US' }, { US: 'ACTIVE' });
    const p = createMarketDefaultsProvider(service, { now: () => t });
    expect(await p.defaultLocale('live')).toBe('es-US');
    expect(await p.isVisible('MARKET', 'live')).toBe(true);
    expect(await p.isVisible('MARKET', 'gone')).toBe(false);
    expect(await p.defaultLocale('gone')).toBeNull();
    expect(calls.market).toBe(2);
    expect(await p.isVisible('COUNTRY', 'US')).toBe(true);
    expect(await p.isVisible('COUNTRY', 'US')).toBe(true);
    expect(calls.country).toBe(1);
    t += 60_001;
    expect(await p.isVisible('MARKET', 'live')).toBe(true);
    expect(calls.market).toBe(3);
  });

  it('visibility follows the reference data once the memo expires (activated -> visible, retired -> hidden)', async () => {
    let t = 0;
    const markets: Record<string, string> = {};
    const { service } = publicService(markets, {});
    const p = createMarketDefaultsProvider(service, { now: () => t });
    expect(await p.isVisible('MARKET', 'm')).toBe(false); // PLANNED: not found publicly
    markets.m = 'en-US'; // activated
    expect(await p.isVisible('MARKET', 'm')).toBe(false); // still memoized
    t += 60_001;
    expect(await p.isVisible('MARKET', 'm')).toBe(true);
    delete markets.m; // retired
    t += 60_001;
    expect(await p.isVisible('MARKET', 'm')).toBe(false);
  });

  it('serves the stale answer when the database errors and propagates the typed error with nothing to serve (the content service then fails closed)', async () => {
    let t = 0;
    let down = false;
    const service = {
      getMarket: async () => {
        if (down) throw new GeographyError('UNAVAILABLE', 'down');
        return { defaultLocale: 'en-US' } as never;
      },
      getCountry: async () => {
        if (down) throw new GeographyError('UNAVAILABLE', 'down');
        return { status: 'ACTIVE' } as never;
      },
    };
    const p = createMarketDefaultsProvider(service, { now: () => t });
    expect(await p.isVisible('MARKET', 'm')).toBe(true);
    expect(await p.isVisible('COUNTRY', 'US')).toBe(true);
    down = true;
    t += 3_600_000;
    expect(await p.isVisible('MARKET', 'm')).toBe(true);
    expect(await p.isVisible('COUNTRY', 'US')).toBe(true);
    await expect(p.isVisible('MARKET', 'never-seen')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(p.isVisible('COUNTRY', 'QQ')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('a service without a country lookup proves no country visible; the memo is bounded for countries too', async () => {
    const onlyMarkets = createMarketDefaultsProvider({ getMarket: async () => ({ defaultLocale: 'en-US' }) as never });
    expect(await onlyMarkets.isVisible('COUNTRY', 'US')).toBe(false);
    let calls = 0;
    const p = createMarketDefaultsProvider(
      {
        getMarket: async () => ({ defaultLocale: 'en-US' }) as never,
        getCountry: async () => {
          calls++;
          return { status: 'ACTIVE' } as never;
        },
      },
      { maxEntries: 2 },
    );
    await p.isVisible('COUNTRY', 'AA');
    await p.isVisible('COUNTRY', 'BB');
    await p.isVisible('COUNTRY', 'CC'); // evicts AA
    await p.isVisible('COUNTRY', 'AA');
    expect(calls).toBe(4);
  });
});
