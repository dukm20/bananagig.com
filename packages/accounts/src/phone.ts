// THE canonicalization of a phone number (ID-003, docs/engineering/PHONE_VERIFICATION.md): country-aware input in, E.164 out. Every comparison, uniqueness check,
// lookup key and SMS recipient uses its result. The numbering rules (what is a valid number in which country, how a national number reads, which region a shared
// calling code such as +1 belongs to) come from libphonenumber-js (MIT, pinned); there is NO custom dialing rule and no hardcoded calling code in this file.
//
// Policy:
//  - the input is Unicode-normalized (NFKC: full-width digits and spaces become ASCII), trimmed, and may contain only digits, one leading plus sign, spaces,
//    dots, dashes and parentheses; letters, extension markers (`x12`, `ext. 5`) and everything else are refused, so a number cannot smuggle text;
//  - an international number (`+...`) needs no country; a NATIONAL number is read in the country the caller names (the market default of the form);
//  - the number must be VALID for its numbering plan (not merely well-formed) and belong to a real country (non-geographic ranges such as +800 are refused);
//  - the result is `+` and the digits, with the ISO country the library resolved FROM THE NUMBER (a +1 number is US or CA by its area code), not the hint.
// The result carries a code only, never the rejected value.
import { getCountries, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';
import { PHONE_INPUT_MAX_LENGTH, containsForbiddenText, isE164, type PhoneIssueCode } from '@bananagig/contracts';

export interface CanonicalPhone {
  /** E.164, for example `+12025550142`. */
  e164: string;
  /** ISO 3166-1 alpha-2 country the number belongs to (resolved from the number). */
  countryCode: string;
  /** The calling code without the plus sign (`1`), to cross-check against the country's configured dialing code. */
  callingCode: string;
}
export type CanonicalPhoneResult = ({ ok: true } & CanonicalPhone) | { ok: false; code: PhoneIssueCode };

// digits, plus (first position only), space, dot, dash and parentheses: nothing else reaches the parser
const ALLOWED = /^\+?[0-9 .\-()]+$/;
const ISO_ALPHA2 = /^[A-Z]{2}$/;
// the countries the numbering data knows; the library does not throw for an unknown one, it just fails to parse, which would read as INVALID_NUMBER
const KNOWN_COUNTRIES: ReadonlySet<string> = new Set(getCountries());

/**
 * Parses and canonicalizes a phone number. `defaultCountry` (ISO alpha-2) is the country a national-format number is read in; it is ignored for a number that
 * starts with `+`. Idempotent: canonicalizing the E.164 output gives the same number.
 */
export function canonicalizePhone(raw: unknown, defaultCountry?: string): CanonicalPhoneResult {
  if (typeof raw !== 'string') return { ok: false, code: 'REQUIRED' };
  if (raw.length > PHONE_INPUT_MAX_LENGTH) return { ok: false, code: 'TOO_LONG' };
  if (containsForbiddenText(raw)) return { ok: false, code: 'INVALID_CHARACTERS' };
  const input = raw.normalize('NFKC').trim();
  if (input === '') return { ok: false, code: 'REQUIRED' };
  if (!ALLOWED.test(input) || input.indexOf('+', 1) !== -1) return { ok: false, code: 'INVALID_CHARACTERS' };
  const international = input.startsWith('+');
  let country: CountryCode | undefined;
  if (!international) {
    if (defaultCountry === undefined) return { ok: false, code: 'COUNTRY_REQUIRED' };
    if (!ISO_ALPHA2.test(defaultCountry) || !KNOWN_COUNTRIES.has(defaultCountry)) return { ok: false, code: 'COUNTRY_NOT_SUPPORTED' };
    country = defaultCountry as CountryCode;
  }
  let parsed;
  try {
    parsed = parsePhoneNumberFromString(input, country);
  } catch {
    // defensive: the country was checked above, but the library may still throw on malformed input
    return { ok: false, code: 'COUNTRY_NOT_SUPPORTED' };
  }
  if (!parsed || !parsed.isValid() || parsed.ext !== undefined) return { ok: false, code: 'INVALID_NUMBER' };
  if (parsed.country === undefined) return { ok: false, code: 'COUNTRY_NOT_SUPPORTED' }; // a non-geographic range (+800, +882, ...)
  if (!isE164(parsed.number)) return { ok: false, code: 'INVALID_NUMBER' };
  return { ok: true, e164: parsed.number, countryCode: parsed.country, callingCode: parsed.countryCallingCode };
}
