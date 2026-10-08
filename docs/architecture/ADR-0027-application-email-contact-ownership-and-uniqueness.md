# ADR-0027 — The email contact is owned by BananaGig, verified by BananaGig, and an identity provider's email claim is never trusted by default

Status: ACCEPTED
Date: 2026-10-07
Checkpoint: ID-002

## Context

ADR-0025 kept contact data out of the account until a verification model existed. The PRD needs a verified email before bookings, chat and reviews (CU-03.06, SV-03), a verified email per account (SV-03.02), a replacement that is verified before it replaces the old address and notifies the old one (CU-09.15), and Apple or Google sign-in emails that the provider reports as verified to count as verified (CU-03). Keycloak also holds a login email, and its tokens carry no email claim (claim minimization, ADR-0013, ADR-0025). Questions: who owns the marketplace contact, when may an address be VERIFIED without BananaGig sending a code, what may two accounts hold at the same time, and what does "replace" mean while the old address must stay active.

## Decision

- **BananaGig owns the contact.** `identity.email_contacts` (migration 0010) stores the canonical address, a status (`PENDING`, `VERIFIED`, `REPLACEMENT_PENDING`, `DISABLED`), `is_primary`, `source` (`USER_ENTERED` or `IDP_VERIFIED`), `verified_at` and the disable reason. It is not a copy of the Keycloak email: the login email stays in Keycloak and is not mirrored. Verification state is not stored on `identity.accounts` (it would duplicate lifecycle state); the account-level `emailVerificationStatus` (`NONE`, `PENDING`, `VERIFIED`) is derived from the contact rows.
- **Trust boundary: nothing is VERIFIED except by proof.** A contact becomes VERIFIED in exactly two ways: the person proves the mailbox with the code or the magic link, or a TRUSTED identity provider reports the address verified. The second is one pure, tested function (`decideIdpEmail`): the claim must canonicalize, `email_verified` must be exactly the boolean `true`, and the login must have been brokered through a provider that BananaGig explicitly trusts to verify addresses (`trustedProviders`, empty by default; Google and Apple are the PRD's intent). A Keycloak realm user never counts, whatever its `emailVerified` says (an import or an administrator can set it). Everything else is at most a suggestion and is never persisted. It applies only when the account has no email contact yet and the address is not VERIFIED elsewhere. It is not wired to any HTTP path in ID-002 (tokens carry no email claim); the first caller is a future brokered-login flow.
- **One canonical form.** `canonicalizeEmail` (contracts) is the only place an address is normalized: trimmed, domain IDNA-mapped to lower-case ASCII, local part a lower-cased dot-atom (ASCII only), dots and `+tags` kept (no Gmail folding), at most 254 characters. The canonical address is the comparison key, the uniqueness key and the delivery address; no second "display" form is stored. Folding the local part is a documented policy: mailbox providers do, and a case-sensitive reading would allow two verified identities that differ only by case.
- **Uniqueness is deliberate and enforced by the database.** A VERIFIED address belongs to at most ONE account (partial unique index). PENDING claims are NOT unique across accounts: a pending claim proves nothing, so it must neither block the real owner nor reveal that anyone else holds the address. Per account: at most one primary, at most one open candidate, one live row per address. When a person proves a mailbox that another account already verified, the confirmation fails with `ACCOUNT_EMAIL_UNAVAILABLE`; there is NO takeover and no silent transfer (recovery for a lost mailbox is a support process, DEBT-0051). That typed answer is given only after the code or link was proven; adding the address and sending the verification answer identically whatever any other account holds.
- **Replacement keeps the old address active.** Changing the address inserts a `REPLACEMENT_PENDING` candidate; the verified primary stays `VERIFIED` and primary until the candidate verifies. Verification disables the old primary (`REPLACED`) and promotes the candidate in one transaction; an abandoned or superseded candidate disappears without touching the primary; setting the primary address again withdraws a pending change. A database guard refuses to disable a primary unless a replacement is being verified, and a deferred trigger keeps the whole-account invariants at commit (an account that replaced its primary still has one).
- **Privacy.** The address is personal data: it is returned only to its owner and only MASKED (`c***@b***.localhost`), never in a public view, an event, a log line or an audit `changes` object (audit names the contact id and the masked form).

## Alternatives considered

- Trusting the Keycloak `email` and `email_verified` claims directly: an administrator, a realm import or a misconfigured provider could mint a verified marketplace contact; the claim is also absent from tokens by design. Rejected for an explicit trusted-provider list.
- Copying the verification fields onto `identity.accounts`: duplicates lifecycle state, cannot represent a pending replacement next to the verified address, and leaves no history. Rejected.
- Storing the address as typed plus a normalized copy: a derived duplicate that can drift and doubles the personal data. Rejected; one canonical column.
- Making pending claims globally unique (first come first served): lets an attacker squat someone's address and confirms to them that the address is in use. Rejected.
- Letting a newly proven mailbox take the address over from another account: turns a lost mailbox or an attacker with mailbox access into an account takeover vector for the earlier holder. Rejected; contested addresses go to support.
- Replacing the address in place and re-verifying: leaves the account with an unverified or no address during the change, contradicting CU-09.15. Rejected.
- Gmail-style dot and plus normalization: provider-specific and wrong for other domains. Rejected.

## Consequences

An address verified on one account cannot be verified on another until the first account releases it (there is no release flow yet). `REPLACED` and `SUPERSEDED` rows are kept as history (no deletion, DEBT-0045 covers retention). Brokered social login needs a follow-up that feeds `bootstrapIdpEmail`.

## Migration / compatibility

Migration `0010_email_verification.sql` (forward-only): two new tables with guards and deferred triggers, one wider CHECK and one new nullable column on `identity.account_audit_events`. No existing row changes.

## Related files

- `db/migrations/0010_email_verification.sql`
- `packages/contracts/src/email.ts`
- `packages/accounts/src/email-policy.ts`
- `packages/accounts/src/email-verification.ts`
- `docs/engineering/EMAIL_VERIFICATION.md`
- `docs/data/DATA_MODEL.md`
- `docs/data/NORMALIZATION_LOG.md`
- `docs/architecture/ADR-0013-keycloak-identity-provider.md`
- `docs/architecture/ADR-0025-application-account-and-keycloak-identity-separation.md`
