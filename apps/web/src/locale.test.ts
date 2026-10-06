import { describe, expect, it } from 'vitest';
import { MAX_ACCEPT_LANGUAGE_LENGTH, MAX_ACCEPT_LANGUAGE_LOCALES, negotiateAgainst, negotiateLocale, parseAcceptLanguage } from './lib/locale';

describe('parseAcceptLanguage', () => {
  it('orders by q-value, keeping header order for ties', () => {
    expect(parseAcceptLanguage('fr;q=0.5, en-US, de;q=0.8, es-MX')).toEqual(['en-US', 'es-MX', 'de', 'fr']);
    expect(parseAcceptLanguage('de;q=0.8, fr;q=0.8, es;q=0.8')).toEqual(['de', 'fr', 'es']);
  });
  it('canonicalizes case and tolerates whitespace', () => {
    expect(parseAcceptLanguage(' EN-us ;  q=0.9 , zh-hant-tw;Q=1')).toEqual(['zh-Hant-TW', 'en-US']);
  });
  it('drops q=0, malformed q-values, wildcards and invalid tags', () => {
    expect(parseAcceptLanguage('en;q=0, fr;q=0.000, de;q=abc, es;q=1.5, *, *;q=0.5, en_US, x-klingon-foo-bar, 12, ;q=1, it')).toEqual(['it']);
  });
  // Behavior change (R4#6): unsupported subtags used to drop the whole tag; they are now truncated.
  it('truncates unsupported subtags (variants, extensions, private use) instead of dropping the tag', () => {
    expect(parseAcceptLanguage('de-CH-1996')).toEqual(['de-CH']);
    expect(parseAcceptLanguage('en-US-x-foo')).toEqual(['en-US']);
    expect(parseAcceptLanguage('en-US-x-private, zh-Hant-TW-u-ca-chinese, pt-BR')).toEqual(['en-US', 'zh-Hant-TW', 'pt-BR']);
    expect(parseAcceptLanguage('sl-rozaj-biske, de-DE-1901;q=0.5, ja-JP-u-ca-japanese;q=0.8')).toEqual(['sl', 'ja-JP', 'de-DE']);
    expect(parseAcceptLanguage('DE-ch-1996')).toEqual(['de-CH']);
  });
  it('merges a truncated tag with the same locale listed plainly (first position, highest q)', () => {
    expect(parseAcceptLanguage('en-US-x-foo;q=0.4, fr;q=0.6, en-US;q=0.9')).toEqual(['en-US', 'fr']);
  });
  it('drops tags that cannot be reduced to the supported subset, or are not language ranges at all', () => {
    expect(parseAcceptLanguage('x-klingon-foo-bar, i-klingon, 123-US, en_US-x, en-US_x, a-b-c, toolonglanguagetag-US, en-@@')).toEqual([]);
    expect(parseAcceptLanguage('x-private, de-CH-1996-')).toEqual([]);
  });
  it('keeps the canonical output form and the caps with truncation', () => {
    const many = Array.from(
      { length: 40 },
      (_, i) => `a${String.fromCharCode(97 + (i % 26))}-${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}-x-${i}`,
    ).join(',');
    const parsed = parseAcceptLanguage(many);
    expect(parsed.length).toBeLessThanOrEqual(MAX_ACCEPT_LANGUAGE_LOCALES);
    expect(parsed.every((l) => /^[a-z]{2}-[A-Z]{2}$/.test(l))).toBe(true);
  });
  it('de-duplicates, keeping the first position and the highest q', () => {
    expect(parseAcceptLanguage('en;q=0.4, fr;q=0.6, EN;q=0.9')).toEqual(['en', 'fr']);
    expect(parseAcceptLanguage('en, fr, en;q=0.1')).toEqual(['en', 'fr']);
  });
  it('ignores unknown parameters', () => {
    expect(parseAcceptLanguage('en;foo=bar;q=0.3, fr;level=1')).toEqual(['fr', 'en']);
  });
  it('is deterministic for the same input', () => {
    const header = 'a1, fr;q=0.7, en-GB;q=0.7, de;q=0.9, es;q=0.7';
    expect(parseAcceptLanguage(header)).toEqual(parseAcceptLanguage(header));
    expect(parseAcceptLanguage(header)).toEqual(['de', 'fr', 'en-GB', 'es']);
  });
  it('returns [] for missing, empty and garbage input without throwing', () => {
    for (const bad of [undefined, null, '', ' ', ',,,', ';;;', '\u0000\u0001', 'q=1', '{"a":1}', 42 as unknown as string])
      expect(parseAcceptLanguage(bad)).toEqual([]);
  });
  it('caps the number of locales and the header length', () => {
    const many = Array.from(
      { length: 50 },
      (_, i) => `a${String.fromCharCode(97 + (i % 26))}-${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`,
    ).join(',');
    expect(parseAcceptLanguage(many).length).toBeLessThanOrEqual(MAX_ACCEPT_LANGUAGE_LOCALES);
    const padded = `${' '.repeat(MAX_ACCEPT_LANGUAGE_LENGTH)}en`;
    expect(parseAcceptLanguage(padded)).toEqual([]);
  });
});

describe('negotiateLocale', () => {
  it('returns the top preference', () => {
    expect(negotiateLocale('es-MX;q=0.4, de-DE')).toBe('de-DE');
  });
  it('returns undefined when nothing is acceptable', () => {
    expect(negotiateLocale('*')).toBeUndefined();
    expect(negotiateLocale(undefined)).toBeUndefined();
    expect(negotiateLocale('en;q=0')).toBeUndefined();
  });
});

describe('negotiateAgainst', () => {
  it('returns the first preference that is active', () => {
    expect(negotiateAgainst(['fr-FR', 'es-US', 'en-US'], ['en-US', 'es-US'])).toBe('es-US');
    expect(negotiateAgainst(['en-US', 'es-US'], ['es-US', 'en-US'])).toBe('en-US');
  });
  it('matches a preference through its language-level truncation, most specific first', () => {
    expect(negotiateAgainst(['es-MX'], ['en-US', 'es'])).toBe('es');
    expect(negotiateAgainst(['zh-Hant-TW'], ['zh-Hant', 'zh'])).toBe('zh-Hant');
    expect(negotiateAgainst(['zh-Hant-TW'], ['zh'])).toBe('zh');
    expect(negotiateAgainst(['es-MX'], ['es-MX', 'es'])).toBe('es-MX');
  });
  it('lets an earlier preference win through its truncation over a later exact match', () => {
    expect(negotiateAgainst(['fr-CA', 'en-US'], ['fr', 'en-US'])).toBe('fr');
  });
  it('never matches a different region or script of the same language', () => {
    expect(negotiateAgainst(['es-MX'], ['es-US'])).toBeUndefined();
    expect(negotiateAgainst(['zh-Hans'], ['zh-Hant'])).toBeUndefined();
    expect(negotiateAgainst(['en-GB'], ['en-US'])).toBeUndefined();
  });
  it('returns undefined for no preferences or no active locales and accepts any iterable', () => {
    expect(negotiateAgainst([], ['en-US'])).toBeUndefined();
    expect(negotiateAgainst(['en-US'], [])).toBeUndefined();
    expect(negotiateAgainst(['de'], new Set(['de', 'en-US']))).toBe('de');
  });
  it('composes with the parser: variants are truncated before matching', () => {
    expect(negotiateAgainst(parseAcceptLanguage('fr-FR, de-CH-1996;q=0.9, es-US;q=0.8'), ['en-US', 'de-CH'])).toBe('de-CH');
    expect(negotiateAgainst(parseAcceptLanguage('fr-FR, es-US;q=0.8'), ['en-US', 'es-US'])).toBe('es-US');
  });
});
