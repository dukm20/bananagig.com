// Accept-Language negotiation for registry content. Pure functions, no I/O.
import { canonicalizeLocale } from '@bananagig/contracts';

/** Hostile or absurd headers are cut here rather than parsed. */
export const MAX_ACCEPT_LANGUAGE_LENGTH = 1000;
/** At most this many locales are returned (RFC 9110 allows arbitrarily long lists; browsers send a handful). */
export const MAX_ACCEPT_LANGUAGE_LOCALES = 10;

/** RFC 5646 / RFC 9110 language range shape: 1-8 letters, then any number of 1-8 alphanumeric subtags. */
const LANGUAGE_RANGE = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;
const Q_VALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/** Canonical form of `tag`, truncating unsupported trailing subtags until the supported subset accepts it; null when nothing is left. */
function reduceToSupported(tag: string): string | null {
  if (!LANGUAGE_RANGE.test(tag)) return null;
  const parts = tag.split('-');
  for (let n = parts.length; n >= 1; n--) {
    const canonical = canonicalizeLocale(parts.slice(0, n).join('-'));
    if (canonical !== null) return canonical;
  }
  return null;
}

/**
 * Parses an Accept-Language header into canonical locales ordered by preference (RFC 9110 section 12.5.4).
 *
 * - q-values order the result (descending); equal q-values keep header order (stable), so the result is deterministic.
 * - `q=0` means "not acceptable" and is dropped. A malformed q-value drops that entry.
 * - `*` and tags that are not even a syntactically valid language range (underscores, padding, garbage) are dropped.
 * - Unsupported trailing subtags are TRUNCATED, not fatal: de-CH-1996 -> de-CH, en-US-x-foo -> en-US, zh-Hant-TW-u-ca-chinese -> zh-Hant-TW.
 *   A tag that cannot be reduced to the supported subset (language[-Script][-REGION]) at all, such as `x-klingon`, is dropped.
 * - A tag listed twice keeps its first position and its highest q-value.
 * - Header length and result length are capped.
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (typeof header !== 'string' || header.length === 0) return [];
  const entries = new Map<string, { q: number; index: number }>();
  let index = 0;
  for (const raw of header.slice(0, MAX_ACCEPT_LANGUAGE_LENGTH).split(',')) {
    const [tagPart, ...params] = raw.split(';');
    const locale = reduceToSupported((tagPart ?? '').trim());
    if (locale === null) continue;
    let q = 1;
    let valid = true;
    for (const param of params) {
      const m = /^\s*q\s*=\s*(\S+)\s*$/i.exec(param);
      if (!m) continue; // unknown parameters are ignored
      if (Q_VALUE.test(m[1]!)) q = Number(m[1]);
      else valid = false;
    }
    if (!valid || q <= 0) continue;
    const existing = entries.get(locale);
    if (existing) existing.q = Math.max(existing.q, q);
    else entries.set(locale, { q, index: index++ });
  }
  return [...entries.entries()]
    .sort(([, a], [, b]) => b.q - a.q || a.index - b.index)
    .slice(0, MAX_ACCEPT_LANGUAGE_LOCALES)
    .map(([locale]) => locale);
}

/** The most preferred acceptable locale, or undefined when the header carries none. */
export function negotiateLocale(header: string | null | undefined): string | undefined {
  return parseAcceptLanguage(header)[0];
}

/** The locale itself, then its progressive truncations: zh-Hant-TW -> [zh-Hant-TW, zh-Hant, zh]; es-MX -> [es-MX, es]. */
function truncations(locale: string): string[] {
  const parts = locale.split('-');
  return parts.map((_, i) => parts.slice(0, parts.length - i).join('-'));
}

/**
 * Chooses the requested locale among the ACTIVE locales: the first preference (in preference order) that is active itself or whose language-level
 * truncation is active, e.g. `fr-FR, es-US;q=0.8` with es-US active and fr inactive gives es-US. Returns undefined when nothing matches.
 * A preference never matches a different region of the same language (es-MX does not match an active es-US; the API's fallback chain handles that).
 */
export function negotiateAgainst(preferences: readonly string[], activeLocales: Iterable<string>): string | undefined {
  const active = new Set(activeLocales);
  for (const preference of preferences) {
    const match = truncations(preference).find((candidate) => active.has(candidate));
    if (match !== undefined) return match;
  }
  return undefined;
}
