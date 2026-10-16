// The phone-specific hash domain (ID-003). The channel-neutral primitives are in verification-crypto.ts (ADR-0030); the DOMAIN string below separates the phone code
// hashes from the email code hashes: a code hash copied between an email and a phone challenge can never verify (the hash is also bound to the challenge id).
import { hmacHex } from './verification-crypto';

/** Keyed hash of an SMS code, bound to its challenge. The plaintext code is never stored. */
export const hashPhoneCode = (secret: string, challengeId: string, code: string): string => hmacHex(secret, 'bananagig:phone-code:v1', challengeId, code);
