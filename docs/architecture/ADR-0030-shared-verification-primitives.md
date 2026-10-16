# ADR-0030 — Email and phone verification share a small set of primitives, not a framework

Status: ACCEPTED
Date: 2026-10-08
Checkpoint: ID-003

## Context

ID-002 built the email verification (one challenge per send, keyed hashes, single use under a row lock, cooldown and caps counted from the challenge rows, a Valkey limiter, two-phase delivery). ID-003 needs the same hardened properties for SMS codes. The two channels are alike in how a one-time code is generated, hashed, compared, limited and counted, and different in almost everything else: the magic link, the canonical value (address versus E.164 and a country), the uniqueness rule (one account per verified address versus a configurable number of accounts per phone), the line-type policy, the delivery cost (an SMS costs money), the policy values, the error vocabulary and the tables. The question is how much to share.

## Decision

- **Share the channel-neutral primitives, in two small modules of `@bananagig/accounts`.** `verification-crypto.ts`: the CSPRNG numeric code (`generateNumericCode`), the keyed hash with an injective, length-prefixed encoding (`hmacHex`) and the constant-time comparison (`hashesEqual`). `verification-core.ts`: the pure evaluation of the resend cooldown and the hour and day caps from an account's challenge timestamps (`evaluateSendWindows`), the construction of the per-request rate rules (`requestRules`, buckets named `<channel>-verification:account|ip|device`) and the consumption of a rule set with the limiter's outcome as data (`consumeRules`). None of them reads a clock or the database and none logs.
- **Keep everything else per channel.** Each channel owns its tables, its guard triggers and invariants, its SQL, its hash DOMAIN string (`bananagig:email-code:v1`, `bananagig:phone-code:v1`, so a hash can never verify in the other channel; the code hash is also bound to the challenge id), its policy type and parser, its typed errors, its events and audit actions, its delivery port and its service. The services are two classes with the same shape, not one parameterized engine.
- **No shared supertable and no inheritance.** `email_contacts` and `phone_contacts` (and their challenge tables) stay separate: the columns that differ (the canonical value and its constraint, the country, the line-type snapshot, the magic-token hash, the consumption method) are real, the uniqueness rules differ in kind, foreign keys from audit rows stay precise, and a polymorphic table would trade a few repeated columns for nullable columns, a discriminator and weaker constraints (see NORMALIZATION_LOG, ID-003).
- **Refactoring ID-002 is allowed only with proof.** The email service was moved onto the shared modules in ID-003; the proof is the unchanged ID-002 test suites (the 213 service integration tests, the crypto unit tests, the hash known-answer values pinned against independent `node:crypto` computations) and the unchanged hash values.

## Alternatives considered

- Copy the email service for the phone: two diverging copies of security code; a fix in one would be forgotten in the other. Rejected for the shared primitives.
- One generic `VerificationService<Channel>` driven by a channel descriptor: the descriptor would need the SQL, the guards, the uniqueness policy and the errors, so it would become a second language for what the services say directly, and every channel difference would be a hook. Rejected as over-generalization.
- A shared `contacts` and `verification_challenges` supertable pair with a channel column: nullable columns per channel, a CHECK per channel, no single canonical-value constraint, cross-channel foreign keys. Rejected (see the normalization review).

## Consequences

A future channel (a messaging app, a backup email) reuses the primitives and adds its own tables and service. A change to the hash encoding is a coordinated change of the shared module and invalidates open challenges of both channels (they expire in minutes).

## Migration / compatibility

No schema change for this decision. The email hash values are unchanged.

## Related files

- `packages/accounts/src/verification-crypto.ts`
- `packages/accounts/src/verification-core.ts`
- `packages/accounts/src/email-crypto.ts`
- `packages/accounts/src/phone-crypto.ts`
- `packages/accounts/src/email-verification.ts`
- `packages/accounts/src/phone-verification.ts`
- `docs/architecture/ADR-0028-email-verification-challenge-code-and-magic-link.md`
- `docs/architecture/ADR-0029-reusable-rate-limit-foundation.md`
