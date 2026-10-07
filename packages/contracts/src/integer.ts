// The ONE strict parser for integers that arrive as text (path parameters, query strings). Canonical base-10 only: digits, no sign, no leading zeros,
// no whitespace, no decimal point, no exponent, no hexadecimal or other radix, no separators, no Infinity or NaN. The text is checked lexically BEFORE
// it is converted, so nothing like `Number('1e3')`, `parseInt('0x10')` or Ajv's type coercion ever decides what a number is.
import { z } from 'zod';

/** `0`, or a digit 1 to 9 followed by digits. */
export const DECIMAL_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;
/** At most 15 digits keeps every accepted value an exact JavaScript integer (2^53 has 16). */
export const MAX_DECIMAL_INTEGER_DIGITS = 15;

export interface IntegerBounds {
  /** Inclusive; default 0 (identifiers and versions are never negative). */
  min?: number;
  /** Inclusive; default Number.MAX_SAFE_INTEGER. */
  max?: number;
}

/**
 * Parses canonical base-10 integer text. Returns the number, or null when the input is not a string, is not canonical, or is outside the bounds.
 * Never throws and never converts text that failed the lexical check.
 */
export function parseDecimalInteger(raw: unknown, bounds: IntegerBounds = {}): number | null {
  if (typeof raw !== 'string' || raw.length > MAX_DECIMAL_INTEGER_DIGITS || !DECIMAL_INTEGER_PATTERN.test(raw)) return null;
  const value = Number(raw);
  const { min = 0, max = Number.MAX_SAFE_INTEGER } = bounds;
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

/** The same rule as a zod schema: text in, number out (for contract-level tests and for callers that validate with zod). */
export const decimalIntegerParam = (bounds: IntegerBounds = {}) =>
  z.string().transform((raw, ctx) => {
    const value = parseDecimalInteger(raw, bounds);
    if (value === null) ctx.addIssue({ code: 'custom', message: decimalIntegerMessage(bounds) });
    return value ?? z.NEVER;
  });

/** The message every API layer uses for a rejected integer (it never contains the rejected text). */
export const decimalIntegerMessage = ({ min = 0, max = Number.MAX_SAFE_INTEGER }: IntegerBounds = {}): string =>
  `must be a base-10 integer from ${min} to ${max}, written without sign, leading zeros, decimals, exponent, radix prefix or whitespace`;

/** Address format versions in a path (`/address-formats/:version/publication`). */
export const ADDRESS_FORMAT_VERSION_BOUNDS = { min: 1, max: 100000 } as const satisfies IntegerBounds;
