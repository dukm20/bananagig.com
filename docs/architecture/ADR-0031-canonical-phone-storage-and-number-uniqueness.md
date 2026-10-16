# ADR-0031 — The phone number is stored as E.164 with its country; how many accounts may verify one number is configuration

Status: ACCEPTED
Date: 2026-10-08
Checkpoint: ID-003

## Context

The PRD stores phones in E.164 (CU-03), derives entry, formatting and validation from the country lookup (SV-10.07), verifies by an SMS code (SV-03), allows one verified phone per account and role and caps the number of accounts that may verify the same phone by a market parameter (`verification.phone.max_accounts_per_number`, default 1; SV-03.02), and lets a market block virtual and high-risk lines. Keycloak is the authentication authority and must not become a phone store (ADR-0013, ADR-0025, ADR-0027). Geography holds the dialing code per country, and a calling code is not a country (`+1` is shared by the US and Canada).

## Decision

- **BananaGig owns the phone contact.** `identity.phone_contacts` (migration 0011), parallel to the email contact (ADR-0027): status `PENDING`, `VERIFIED`, `REPLACEMENT_PENDING`, `DISABLED`; `is_primary`; `source` (`USER_ENTERED`); the replacement candidate keeps the verified primary active until it verifies. The number is never written to Keycloak, a token, an event or a log; the owner sees it masked.
- **One canonical form: E.164, plus the country.** The stored value is `+` and 7 to 15 digits, produced by ONE function (`canonicalizePhone`) over the proven library libphonenumber-js (MIT, pinned 1.13.14, no dependencies, the `min` metadata). There is no custom dialing rule and no hardcoded calling code. Input is Unicode-normalized, restricted to digits and punctuation, validated against the numbering plan, and an extension or a non-geographic range is refused. The country (`country_code`, ISO alpha-2) is the region the library resolves FROM THE NUMBER, stored with a foreign key to `geography.countries`. No national-number copy is stored: it is derivable from E.164 and the country.
- **Geography decides availability.** A number is accepted only when its country is ACTIVE in geography and the country's configured dialing code equals the number's calling code; the default country of a national-format number is the caller's choice or, when omitted, the only ACTIVE country (launch: the United States). Country-scoped policy resolves with the number's country; accounts have no market yet, so the market scope applies once they do (DEBT-0063).
- **Uniqueness is data, enforced twice.** Pending claims are never unique and never count. The number of accounts that may hold one number VERIFIED is the parameter `verification.phone.max_accounts_per_number` (PLATFORM default 1, overridable per COUNTRY and MARKET), so it cannot be a unique index. The service serializes verifications of one number under a transaction advisory lock (`pg_advisory_xact_lock` on `phone:<E.164>`), counts the OTHER accounts that hold it, and refuses with `PHONE_UNAVAILABLE` only AFTER a correct code (before that, add and send answer identically whatever any other account holds: no enumeration, no takeover). The guard trigger takes the same lock and enforces the value the service passes in a transaction setting (`app.phone_max_accounts`, 1 to 5) or a structural ceiling of 5, so raw SQL cannot exceed it.
- **The line type is a snapshot.** When the country/market policy blocks any line type, the number is classified by the `PhoneIntelligence` port (ADR-0032) before anything is stored or sent; the result is stored on the contact (`line_type`, `line_type_checked_at`) and re-applied at send and confirm without calling the vendor again. A lookup that fails is a refusal.

## Alternatives considered

- A partial unique index on the verified number: correct only for a maximum of one and wrong as soon as a market raises it; the PRD makes it market policy. Rejected.
- Storing the number as typed plus a normalized copy, or the national number beside E.164: derived duplicates that can drift and double the personal data. Rejected.
- Deriving the country from the calling code or the dialing code alone: wrong for shared calling codes. Rejected for the library's region.
- A custom phone-rule table in geography (DEBT-0038): hand-maintained rules would lag the numbering plans the library tracks. Deferred; the library is the rule source.
- Allowing the first verifier to be displaced by a later one: a lost phone number becomes an account takeover vector. Rejected; contested numbers go to support (DEBT-0061).

## Consequences

Numbering rules update with the library (a dependency bump), not with an admin edit (DEBT-0038 stays open for editable rules). The structural ceiling of 5 accounts per number is a schema constant; raising it is a migration.

## Migration / compatibility

Migration `0011_phone_verification.sql` (forward-only): two tables, guards, deferred invariants, the audit extension, ten parameters and the phone copy.

## Related files

- `db/migrations/0011_phone_verification.sql`
- `packages/accounts/src/phone.ts`
- `packages/accounts/src/phone-verification.ts`
- `packages/accounts/src/phone-policy.ts`
- `packages/contracts/src/phone.ts`
- `docs/engineering/PHONE_VERIFICATION.md`
- `docs/architecture/ADR-0027-application-email-contact-ownership-and-uniqueness.md`
