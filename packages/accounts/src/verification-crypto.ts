// The channel-neutral primitives of every one-time-code verification (email since ID-002, phone since ID-003, ADR-0030): the CSPRNG code, the keyed hash with an
// injective encoding, and the constant-time compare. What differs per channel stays in its own module: the DOMAIN string that separates the hash spaces, the
// challenge state machine, the delivery and the policy. Nothing here logs; callers must not log what these functions return or accept.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const CODE_LENGTH_MIN = 4;
export const CODE_LENGTH_MAX = 10;

/** A uniformly random numeric code of exactly `length` digits (4 to 10), for example `048213`, from the operating-system CSPRNG (never Math.random). */
export function generateNumericCode(length: number): string {
  if (!Number.isInteger(length) || length < CODE_LENGTH_MIN || length > CODE_LENGTH_MAX)
    throw new RangeError('the code length must be an integer from 4 to 10');
  let code = '';
  for (let i = 0; i < length; i++) code += String(randomInt(0, 10));
  return code;
}

/**
 * HMAC-SHA-256 hex over a domain and length-prefixed parts, keyed with a server secret that lives outside the database. Every part is length-prefixed, so the
 * encoding is injective: ('a', 'b<NUL>c') and ('a<NUL>b', 'c') can never produce the same input. A plain hash of a 6-digit code could be reversed from a leaked
 * table in a millisecond; the keyed hash cannot be attacked offline without the secret.
 */
export const hmacHex = (secret: string, domain: string, ...parts: string[]): string =>
  createHmac('sha256', secret)
    .update(`${domain}\0${parts.map((p) => `${p.length}:${p}`).join('\0')}`)
    .digest('hex');

/** Constant-time equality of two lower-case hex SHA-256 strings (false for any other shape, without leaking where they differ). */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length !== 64 || b.length !== 64) return false;
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}
