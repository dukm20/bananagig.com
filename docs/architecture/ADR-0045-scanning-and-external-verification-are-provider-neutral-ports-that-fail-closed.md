# ADR-0045 — Malware scanning and external verification are provider-neutral ports whose production defaults fail closed; no vendor is simulated

Status: ACCEPTED
Date: 2026-10-18
Checkpoint: TRUST-001

## Context

Verification needs two things the platform does not have: a malware scanner for uploaded evidence and, for some checks (identity, background), an external provider that runs the check (ID.me may be one). Neither vendor is chosen, no contract or response shape is known, and a stand-in that "works" in production would be a security hole (an unscanned file treated as scanned, a check "passed" that nobody ran).

## Decision

- **Both are ports** in `@bananagig/trust`: `EvidenceScanner.scan` and `VerificationProvider` (create, status, cancel, summary). The domain names no vendor and no SDK.
- **Fail closed in production.** `TRUST_SCANNER` and `TRUST_EXTERNAL_PROVIDER` default to `disabled` in production: the scanner reports an error (with `trust.verification.require_clean_scan` true, nothing can be attached) and the external provider reports itself unavailable. The `fake` adapters are refused by the production configuration check.
- **The development adapters are honest stand-ins.** The fake scanner marks a file clean unless it contains the standard, harmless EICAR antivirus test string (so the infected path is testable for real); the fake external provider reports PENDING then APPROVED unless a test sets an outcome. They are named fakes, selected by configuration, and never the default outside DEV/TEST.
- **Only structured state crosses the boundary.** An external verification stores the adapter name, the provider's identifier and a status snapshot; a relayed decision is recorded as a review by `external:<adapter>`. No vendor payload and no personal attribute is stored, and only the server's pull through the adapter can change a requirement (a caller cannot assert a decision). A callback or webhook, when a vendor needs one, will verify the vendor's signature behind this same port (DEBT-0087).
- **No production vendor adapter is built.** The vendor's contract and credentials do not exist; assuming a response shape would be invention.

## Alternatives considered

- **A scanner that always says clean in production, to unblock demos.** Rejected: it would silently remove the safety control.
- **Hard-code ID.me.** Rejected: unknown contract, secrets, and a single-vendor dependency in a domain package.
- **Store the vendor's full response for "evidence".** Rejected: it would copy sensitive attributes into a generic JSON column; structured fields only.

## Consequences

- Production cannot accept evidence or run external checks until real adapters and configuration exist; this is intended and recorded (DEBT-0087).
- Adding a vendor is one adapter and one configuration value; no schema change.

## Migration / compatibility

No schema change beyond `external_verifications` in `0019`. New optional settings `TRUST_SCANNER` and `TRUST_EXTERNAL_PROVIDER` (documented in `.env.example`); the production configuration check refuses `fake`.

## Related files

- `packages/trust/src/adapters.ts`
- `packages/trust/src/types.ts`
- `packages/config/src/index.ts`
- `docs/engineering/TRUST_VERIFICATION.md`
- `docs/architecture/ADR-0044-verification-evidence-lives-in-private-object-storage-with-server-verified-immutable-metadata.md`
