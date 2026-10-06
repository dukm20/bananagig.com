import { describe, expect, it } from 'vitest';
import { FALLBACK_POLICIES } from '@bananagig/contracts';
import { ContentError } from './errors';
import { buildFallbackChain, canonicalizeLocale, truncateLocale } from './locale';

describe('canonicalizeLocale', () => {
  it.each([
    ['en-US', 'en-US'],
    ['EN-us', 'en-US'],
    ['en-us', 'en-US'],
    ['es', 'es'],
    ['ES', 'es'],
    ['zh-hant-tw', 'zh-Hant-TW'],
    ['ZH-HANT', 'zh-Hant'],
    ['es-419', 'es-419'],
    ['fil', 'fil'],
  ])('canonicalizes %s -> %s', (input, expected) => {
    expect(canonicalizeLocale(input)).toBe(expected);
  });

  it.each([
    'en_US',
    '',
    'e',
    'english',
    'en-',
    '-US',
    'en-US-x-private',
    'en-US-POSIX-extra',
    'en-U',
    'en-Latn-US-1996',
    '1n-US',
    'en US',
    '  en-GB ',
    'en-US\n',
    ' fr-CA',
    'x'.repeat(30),
  ])('rejects %j', (input) => {
    expect(canonicalizeLocale(input)).toBeNull();
  });

  it('rejects non-strings', () => {
    for (const v of [null, undefined, 5, {}, [], ['en']]) expect(canonicalizeLocale(v)).toBeNull();
  });
});

describe('truncateLocale', () => {
  it('truncates progressively', () => {
    expect(truncateLocale('zh-Hant-TW')).toEqual(['zh-Hant-TW', 'zh-Hant', 'zh']);
    expect(truncateLocale('es-MX')).toEqual(['es-MX', 'es']);
    expect(truncateLocale('es')).toEqual(['es']);
  });
  it('canonicalizes its input and rejects invalid tags', () => {
    expect(truncateLocale('ZH-hant-tw')).toEqual(['zh-Hant-TW', 'zh-Hant', 'zh']);
    expect(() => truncateLocale('en_US')).toThrow(ContentError);
    try {
      truncateLocale('nope!');
    } catch (e) {
      expect((e as ContentError).code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('buildFallbackChain', () => {
  const base = { platformDefault: 'en-US' };

  it('CHAIN: requested, its truncations, market default, platform default', () => {
    expect(buildFallbackChain({ ...base, requested: 'es-MX', policy: 'CHAIN', marketDefaultLocale: 'es-US' })).toEqual(['es-MX', 'es', 'es-US', 'en-US', 'en']);
  });
  it('CHAIN without a market default goes to the platform default', () => {
    expect(buildFallbackChain({ ...base, requested: 'es-MX', policy: 'CHAIN' })).toEqual(['es-MX', 'es', 'en-US', 'en']);
    expect(buildFallbackChain({ ...base, requested: 'es-MX', policy: 'CHAIN', marketDefaultLocale: null })).toEqual(['es-MX', 'es', 'en-US', 'en']);
  });
  it('CHAIN handles zh-Hant-TW', () => {
    expect(buildFallbackChain({ ...base, requested: 'zh-Hant-TW', policy: 'CHAIN' })).toEqual(['zh-Hant-TW', 'zh-Hant', 'zh', 'en-US', 'en']);
  });
  it('CHAIN dedupes preserving the first occurrence', () => {
    expect(buildFallbackChain({ ...base, requested: 'en-US', policy: 'CHAIN', marketDefaultLocale: 'en-US' })).toEqual(['en-US', 'en']);
    expect(buildFallbackChain({ ...base, requested: 'es-US', policy: 'CHAIN', marketDefaultLocale: 'es-US' })).toEqual(['es-US', 'es', 'en-US', 'en']);
    expect(buildFallbackChain({ ...base, requested: 'es', policy: 'CHAIN', marketDefaultLocale: 'es-MX' })).toEqual(['es', 'es-MX', 'en-US', 'en']);
  });
  it('LANGUAGE_ONLY is only the truncations of the requested locale', () => {
    expect(buildFallbackChain({ ...base, requested: 'es-MX', policy: 'LANGUAGE_ONLY', marketDefaultLocale: 'fr-CA' })).toEqual(['es-MX', 'es']);
    expect(buildFallbackChain({ ...base, requested: 'zh-Hant-TW', policy: 'LANGUAGE_ONLY' })).toEqual(['zh-Hant-TW', 'zh-Hant', 'zh']);
  });
  it('EXACT is only the requested locale', () => {
    expect(buildFallbackChain({ ...base, requested: 'es-MX', policy: 'EXACT', marketDefaultLocale: 'es-US' })).toEqual(['es-MX']);
  });
  it('canonicalizes the requested locale', () => {
    expect(buildFallbackChain({ ...base, requested: 'ES-mx', policy: 'EXACT' })).toEqual(['es-MX']);
  });
  it('keeps only active locales and reports the chain after filtering', () => {
    const active = new Set(['es', 'en-US']);
    expect(buildFallbackChain({ ...base, requested: 'es-MX', policy: 'CHAIN', marketDefaultLocale: 'es-US', active })).toEqual(['es', 'en-US']);
    expect(buildFallbackChain({ ...base, requested: 'es-MX', policy: 'LANGUAGE_ONLY', active })).toEqual(['es']);
  });
  it('an inactive requested locale is skipped; EXACT then has an empty chain', () => {
    expect(buildFallbackChain({ ...base, requested: 'fr-FR', policy: 'EXACT', active: new Set(['en-US']) })).toEqual([]);
    expect(buildFallbackChain({ ...base, requested: 'fr-FR', policy: 'CHAIN', active: new Set(['en-US']) })).toEqual(['en-US']);
    expect(buildFallbackChain({ ...base, requested: 'fr-FR', policy: 'LANGUAGE_ONLY', active: new Set(['en-US']) })).toEqual([]);
  });
  it('is deterministic and does not depend on set ordering', () => {
    const a = buildFallbackChain({ ...base, requested: 'es-MX', policy: 'CHAIN', active: new Set(['en-US', 'es', 'es-MX']) });
    const b = buildFallbackChain({ ...base, requested: 'es-MX', policy: 'CHAIN', active: new Set(['es-MX', 'es', 'en-US']) });
    expect(a).toEqual(b);
    expect(a).toEqual(['es-MX', 'es', 'en-US']);
  });
  it('rejects invalid locales and policies', () => {
    expect(() => buildFallbackChain({ ...base, requested: 'es_MX', policy: 'CHAIN' })).toThrow(ContentError);
    expect(() => buildFallbackChain({ ...base, requested: 'es', policy: 'CHAIN', marketDefaultLocale: 'bad_tag' })).toThrow(ContentError);
    expect(() => buildFallbackChain({ requested: 'es', policy: 'CHAIN', platformDefault: 'bad_tag' })).toThrow(ContentError);
    expect(() => buildFallbackChain({ ...base, requested: 'es', policy: 'WHATEVER' as never })).toThrow(ContentError);
  });
  it('covers every fallback policy in the contract', () => {
    for (const policy of FALLBACK_POLICIES) {
      const chain = buildFallbackChain({ ...base, requested: 'de-DE', policy, marketDefaultLocale: 'de-AT' });
      expect(chain[0]).toBe('de-DE');
      expect(new Set(chain).size).toBe(chain.length);
    }
  });
});
