// Secrets of the email verification (ID-002): generation of the one-time code and the magic-link token, their keyed hashes, and the constant-time compare.
//
//  - Randomness comes from the operating system CSPRNG only (node:crypto randomInt / randomBytes). Math.random is never used.
//  - A code is a fixed number of decimal digits, drawn digit by digit with randomInt (uniform, leading zeros allowed). A token is 256 random bits, base64url.
//  - What is STORED is HMAC-SHA-256 with a server secret that lives outside the database (VERIFICATION_HASH_SECRET). A plain SHA-256 of a 6-digit code could be
//    reversed from a leaked table in a millisecond; the keyed hash cannot be attacked offline without the secret. Every hash is domain-separated, and the code
//    hash is bound to its challenge id so two challenges with the same code do not share a hash.
//  - Comparisons of secrets and hashes are constant-time (timingSafeEqual).
//  - Nothing here logs. Callers must not log what these functions return or accept.
import { randomBytes } from 'node:crypto';
import { EMAIL_CODE_SHAPE, EMAIL_TOKEN_SHAPE } from '@bananagig/contracts';
import { generateNumericCode, hashesEqual, hmacHex } from './verification-crypto';

// the channel-neutral primitives live in verification-crypto.ts (ADR-0030); the email module keeps its own hash domains and its public names
export { hashesEqual };

/** A uniformly random numeric code of exactly `length` digits (4 to 10), for example `048213`. */
export const generateVerificationCode = (length: number): string => generateNumericCode(length);

/** A 256-bit random magic-link token as 43 unpadded base64url characters. */
export function generateMagicToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Keyed hash of a code, bound to its challenge. */
export const hashVerificationCode = (secret: string, challengeId: string, code: string): string =>
  hmacHex(secret, 'bananagig:email-code:v1', challengeId, code);
/** Keyed hash of a magic-link token (the lookup key of a link confirmation). */
export const hashMagicToken = (secret: string, token: string): string => hmacHex(secret, 'bananagig:email-link:v1', token);
/**
 * Keyed, truncated hash of an abuse-limit dimension value (a client IP, a device id, a canonical email address or phone number), so the raw value never becomes a Valkey
 * key. 128 bits are plenty for a counter key. `dimension` separates the spaces (an IP can never collide with an address).
 */
export const hashDimension = (secret: string, dimension: 'ip' | 'email' | 'device' | 'phone', value: string): string =>
  hmacHex(secret, 'bananagig:rate-dimension:v1', dimension, value).slice(0, 32);

export const isCodeShape = (v: unknown): v is string => typeof v === 'string' && EMAIL_CODE_SHAPE.test(v);
export const isTokenShape = (v: unknown): v is string => typeof v === 'string' && EMAIL_TOKEN_SHAPE.test(v);
