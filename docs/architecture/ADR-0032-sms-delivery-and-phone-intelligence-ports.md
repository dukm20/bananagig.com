# ADR-0032 — SMS delivery and phone intelligence are provider-neutral ports; the only adapters are a Valkey sink for development and tests and a disabled transport

Status: ACCEPTED
Date: 2026-10-08
Checkpoint: ID-003

## Context

The PRD requires an SMS partner for verification and security codes with fraud and spend controls (SV-03.04) and lets a market block numbers the partner classifies as non-mobile, virtual or high-risk (SV-03.02). No vendor is selected, CI must not call a real vendor, and a verification SMS carries a credential. Local development, the integration tests and the smoke test (which runs in a different container from the API) all need to read the SMS the API "sent".

## Decision

- **`SmsSender` is the domain port** (`to` in E.164, a template key, typed variables, locale, correlation id). `RenderingSmsSender` renders the text through the `SmsRenderer` port (the composition root implements it over the content registry, CFG-002: `sms.verification.phone.body` with typed variables, no link, no account id, one short segment) and hands the text to the vendor-facing `SmsTransport` port. A vendor adapter is one class implementing `SmsTransport`; none is chosen (DEBT-0059).
- **Two adapters exist.** `ValkeyFakeSmsTransport` (DEV and TEST only) appends the text to a Valkey list keyed by a SHA-256 of the number with a 15-minute TTL, so the API container can send and a test or the smoke test can read it (`FakeSmsInbox`, `@bananagig/testing`). It holds the plaintext code by design and refuses to be constructed in production. `DisabledSmsTransport` delivers nothing and fails every send as a non-retryable delivery failure; it is the production default until a provider exists. Configuration (`SMS_TRANSPORT=fake|disabled`) refuses `fake` in production.
- **`PhoneIntelligence` is the classification port** (`MOBILE`, `LANDLINE`, `VOIP`, `VIRTUAL`, `UNKNOWN`, `HIGH_RISK`). `FakePhoneIntelligence` (DEV and TEST) classifies deterministically from the last three digits so tests choose a line type by choosing a number; `UnknownPhoneIntelligence` classifies everything UNKNOWN (the production default until a vendor exists, DEBT-0060). `PHONE_INTELLIGENCE=fake|unknown`, `fake` refused in production. The policy that BLOCKS line types is configuration, not adapter code.
- **Failure semantics.** A failed lookup or a lookup slower than five seconds is `PHONE_RISK_UNAVAILABLE` (the market blocks line types, so an unclassified number cannot be accepted: fail closed, retryable). A failed SMS delivery closes its challenge (`DELIVERY_FAILED`), starts no cooldown, and is `PHONE_DELIVERY_FAILED`.

## Alternatives considered

- A fake SMS table in PostgreSQL: a table of plaintext codes in the authoritative store, even if only in development, and one the production schema should never carry. Rejected for Valkey, which is non-authoritative and expires.
- An in-process fake: the smoke test runs in another container and cannot read it. Rejected.
- An HTTP fake SMS service container (like Mailpit): one more service for a list of strings. Rejected for the Valkey list.
- Putting the vendor SDK in the identity service: couples the domain to a vendor and to its failure modes. Rejected for the ports.
- Failing open when the lookup is unavailable: lets a vendor outage disable the line-type policy. Rejected.

## Consequences

Phone verification in production sends nothing until a provider is configured (every send fails clearly); a vendor needs one `SmsTransport` class, one `PhoneIntelligence` class and the two settings. The fake sink needs Valkey (already a dependency of the limiter).

## Migration / compatibility

No schema change. `.env.example` gains `SMS_TRANSPORT` and `PHONE_INTELLIGENCE`.

## Related files

- `packages/platform/src/sms.ts`
- `packages/platform/src/phone-intelligence.ts`
- `packages/testing/src/sms.ts`
- `apps/api/src/modules/account/phone-wiring.ts`
- `packages/config/src/index.ts`
- `docs/engineering/PHONE_VERIFICATION.md`
- `docs/architecture/ADR-0028-email-verification-challenge-code-and-magic-link.md`
