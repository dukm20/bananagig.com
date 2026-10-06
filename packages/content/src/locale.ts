// Locale canonicalization and the deterministic fallback chain (docs/engineering/CONTENT.md).
import { canonicalizeLocale, type FallbackPolicy } from '@bananagig/contracts';
import { ContentError } from './errors';

export { canonicalizeLocale };

function mustCanonicalize(tag: unknown, what: string): string {
  const canonical = canonicalizeLocale(tag);
  if (!canonical) throw new ContentError('VALIDATION_FAILED', `${what} is not a supported BCP 47 locale tag`, { reason: 'INVALID_LOCALE', field: what });
  return canonical;
}

/** Progressive truncation: zh-Hant-TW -> [zh-Hant-TW, zh-Hant, zh]; es-MX -> [es-MX, es]; es -> [es]. */
export function truncateLocale(tag: string): string[] {
  const parts = mustCanonicalize(tag, 'locale').split('-');
  const out: string[] = [];
  for (let n = parts.length; n >= 1; n--) out.push(parts.slice(0, n).join('-'));
  return out;
}

export interface FallbackChainInput {
  requested: string;
  policy: FallbackPolicy;
  /** The market's default locale, when the caller knows it. Only used by the CHAIN policy. */
  marketDefaultLocale?: string | null;
  platformDefault: string;
  /** When given, only these (active) locales are kept: inactive locales are skipped and not reported. */
  active?: ReadonlySet<string>;
}

/**
 * The ordered locales considered for an entry.
 *  CHAIN         = dedupe(trunc(requested) ++ trunc(marketDefaultLocale?) ++ trunc(platformDefault))
 *  LANGUAGE_ONLY = trunc(requested)
 *  EXACT         = [requested]
 * Deterministic; duplicates removed preserving first occurrence; filtered to the active set when one is given.
 */
export function buildFallbackChain(input: FallbackChainInput): string[] {
  const requested = mustCanonicalize(input.requested, 'requested locale');
  let chain: string[];
  switch (input.policy) {
    case 'EXACT':
      chain = [requested];
      break;
    case 'LANGUAGE_ONLY':
      chain = truncateLocale(requested);
      break;
    case 'CHAIN': {
      chain = truncateLocale(requested);
      if (input.marketDefaultLocale) chain.push(...truncateLocale(mustCanonicalize(input.marketDefaultLocale, 'market default locale')));
      chain.push(...truncateLocale(mustCanonicalize(input.platformDefault, 'platform default locale')));
      break;
    }
    default:
      throw new ContentError('VALIDATION_FAILED', 'Unknown fallback policy', { reason: 'INVALID_FALLBACK_POLICY' });
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const locale of chain) {
    if (seen.has(locale)) continue;
    seen.add(locale);
    if (input.active && !input.active.has(locale)) continue;
    out.push(locale);
  }
  return out;
}
