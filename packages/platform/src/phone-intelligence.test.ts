// Unit tests of the phone intelligence boundary (ID-003): the deterministic DEV/TEST classifier (the last three digits pick the line type), the failing lookup,
// and the production default that classifies every number as UNKNOWN.
import { PHONE_LINE_TYPES } from '@bananagig/contracts';
import { describe, expect, it } from 'vitest';
import { FakePhoneIntelligence, PhoneIntelligenceError, UnknownPhoneIntelligence, type PhoneIntelligence } from './phone-intelligence';

// typed as the port, so the tests call it exactly as the service does (number and country)
const fake: PhoneIntelligence = new FakePhoneIntelligence();

describe('FakePhoneIntelligence', () => {
  it.each([
    ['901', 'VOIP'],
    ['902', 'VIRTUAL'],
    ['903', 'LANDLINE'],
    ['904', 'HIGH_RISK'],
  ] as const)('classifies a number ending in %s as %s', async (suffix, lineType) => {
    expect(await fake.lookup(`+12025550${suffix}`, 'US')).toEqual({ lineType });
    expect(await fake.lookup(`+4420718389${suffix.slice(0, 1)}${suffix}`, 'GB')).toEqual({ lineType });
  });
  it('throws a PhoneIntelligenceError for a number ending in 905', async () => {
    await expect(fake.lookup('+12025550905', 'US')).rejects.toBeInstanceOf(PhoneIntelligenceError);
    await expect(fake.lookup('+12025550905', 'US')).rejects.toMatchObject({ name: 'PhoneIntelligenceError' });
  });
  it('the 905 failure message names no number', async () => {
    try {
      await fake.lookup('+12025550905', 'US');
      throw new Error('expected the lookup to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(PhoneIntelligenceError);
      expect((err as Error).message).not.toContain('2025550905');
      expect((err as Error).message).toBe('the phone lookup is unavailable');
    }
  });
  it.each(['+12025550142', '+12025550100', '+12025550000', '+12025550900', '+12025550906', '+12025550999', '+12025550142', '+442071838750', '+4915112345678'])(
    'classifies %s as MOBILE',
    async (e164) => {
      expect(await fake.lookup(e164, 'US')).toEqual({ lineType: 'MOBILE' });
    },
  );
  it.each([
    ['+19015550142', 'a 901 prefix in the area code'],
    ['+19025550142', 'a 902 prefix in the area code'],
    ['+19035550142', 'a 903 prefix in the area code'],
    ['+19045550142', 'a 904 prefix in the area code'],
    ['+19055550142', 'a 905 prefix in the area code'],
    ['+19015559011', 'a 901 in the middle'],
    ['+19015559021', 'a 902 in the middle'],
    ['+19015559051', 'a 905 in the middle'],
    ['+19015559019', 'a 901 followed by a digit'],
    ['+19015559049', 'a 904 followed by a digit'],
    ['+19015559059', 'a 905 followed by a digit'],
    ['+19015559010', 'a 901 followed by a zero'],
    ['+19015559090', 'a 90 near the end'],
    ['+19015559910', 'a 991 then a zero'],
    ['+19015550190', 'a 190 ending'],
  ])('looks only at the last three digits: %s (%s) is MOBILE', async (e164) => {
    expect(await fake.lookup(e164, 'US')).toEqual({ lineType: 'MOBILE' });
  });
  it('picks the line type by the final three digits whatever the country or length', async () => {
    expect(await fake.lookup('+442071838901', 'GB')).toEqual({ lineType: 'VOIP' });
    expect(await fake.lookup('+442071838902', 'GB')).toEqual({ lineType: 'VIRTUAL' });
    expect(await fake.lookup('+4915112345903', 'DE')).toEqual({ lineType: 'LANDLINE' });
    expect(await fake.lookup('+919876543904', 'IN')).toEqual({ lineType: 'HIGH_RISK' });
    await expect(fake.lookup('+61412345905', 'AU')).rejects.toBeInstanceOf(PhoneIntelligenceError);
  });
  it('ignores the country argument', async () => {
    for (const country of ['US', 'CA', 'GB', '', 'ZZ']) {
      expect(await fake.lookup('+12025550901', country)).toEqual({ lineType: 'VOIP' });
    }
  });
  it('is deterministic: the same number gets the same answer every time', async () => {
    for (const e164 of ['+12025550901', '+12025550902', '+12025550903', '+12025550904', '+12025550142']) {
      const first = await fake.lookup(e164, 'US');
      for (let i = 0; i < 5; i += 1) expect(await fake.lookup(e164, 'US')).toEqual(first);
    }
  });
  it('is stateless: two instances answer alike', async () => {
    expect(await new FakePhoneIntelligence().lookup('+12025550903')).toEqual(await new FakePhoneIntelligence().lookup('+12025550903'));
  });
  it('fails on every repeated 905 lookup', async () => {
    for (let i = 0; i < 3; i += 1) await expect(fake.lookup('+12025550905', 'US')).rejects.toBeInstanceOf(PhoneIntelligenceError);
  });
  it('only ever returns a known line type', async () => {
    for (let n = 0; n < 1000; n += 7) {
      const e164 = `+1202555${String(n).padStart(4, '0')}`;
      try {
        const { lineType } = await fake.lookup(e164, 'US');
        expect(PHONE_LINE_TYPES).toContain(lineType);
      } catch (err) {
        expect(err).toBeInstanceOf(PhoneIntelligenceError);
        expect(e164.endsWith('905')).toBe(true);
      }
    }
  });
  it('returns an object with a lineType key only', async () => {
    expect(Object.keys(await fake.lookup('+12025550142', 'US'))).toEqual(['lineType']);
  });
  it('never returns UNKNOWN (the offline classifier always decides)', async () => {
    for (const suffix of ['000', '142', '900', '901', '902', '903', '904', '906', '999']) {
      const result = await fake.lookup(`+12025550${suffix}`, 'US');
      expect(result.lineType).not.toBe('UNKNOWN');
    }
  });
});

describe('PhoneIntelligenceError', () => {
  it('is an Error with a fixed default message and name', () => {
    const err = new PhoneIntelligenceError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PhoneIntelligenceError');
    expect(err.message).toBe('the phone lookup is unavailable');
  });
  it('accepts a custom message', () => {
    expect(new PhoneIntelligenceError('timeout').message).toBe('timeout');
  });
});

describe('UnknownPhoneIntelligence', () => {
  const unknown: PhoneIntelligence = new UnknownPhoneIntelligence();
  it.each(['+12025550142', '+12025550901', '+12025550902', '+12025550903', '+12025550904', '+12025550905', '+442071838750'])(
    'classifies %s as UNKNOWN',
    async (e164) => {
      expect(await unknown.lookup(e164, 'US')).toEqual({ lineType: 'UNKNOWN' });
    },
  );
  it('always answers UNKNOWN and never throws', async () => {
    for (let i = 0; i < 5; i += 1) expect(await unknown.lookup('+12025550905', 'US')).toEqual({ lineType: 'UNKNOWN' });
  });
  it('is deterministic across instances', async () => {
    expect(await new UnknownPhoneIntelligence().lookup()).toEqual(await unknown.lookup('+12025550901', 'US'));
  });
});
