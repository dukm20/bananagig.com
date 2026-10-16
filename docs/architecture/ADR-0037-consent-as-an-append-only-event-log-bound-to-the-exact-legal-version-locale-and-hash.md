# ADR-0037 — Consent is an append-only event log bound to the exact legal version, locale and hash

Status: ACCEPTED
Date: 2026-10-16
Checkpoint: ID-005

## Context

The PRD requires that "legal and consent texts are versioned; each acceptance records the exact version" (SV-02.04), that the sign-up consent stores the consent version and time (CU-03), that a person can see their consent history with document versions and dates (CU-09.22) and that optional consents are never pre-ticked (R-13). The content registry (CFG-002, ADR-0018 and ADR-0020) already owns the legal text: LEGAL entries with immutable, hashed, localized versions that never fall back to another language and are never cached. What was missing is the account's relationship to a version: that it accepted or withdrew, when, in which language, and proof of which text. The record is legal evidence: it must not be editable after the fact, must not be able to point at a text that was not in force, and must survive a later suspicion about the text itself. The same record must also answer "is this account compliant now?" after a newer version is published.

## Decision

- **CFG-002 owns the document, this layer owns the account's relationship to a version.** No legal text is copied anywhere (not into identity tables, audit rows, events or logs). A record holds the version id, the locale and the SHA-256 of the immutable version it refers to.
- **ONE append-only table, `identity.consent_events`, is both the acceptance record and the history.** Each row is `ACCEPTED` or `WITHDRAWN`, numbered per (account, purpose) by `event_seq`. Current consent is DERIVED from the latest event; there is no `current_accepted` column. A correction is a new event; UPDATE, DELETE and TRUNCATE are refused by trigger (the audit tables' pattern).
- **A composite foreign key binds the event to the exact version.** `(version_id, locale, body_sha256)` references `content.versions (version_id, locale, body_sha256)` through an additive unique constraint on the version table. The version is immutable and never deleted, so the database proves that the stored locale and hash are those of the accepted text; a service bug cannot store a hash that disagrees with the version. The text is read through the version id when it is needed.
- **Eligibility is enforced by the database, not only by the service.** A BEFORE INSERT trigger accepts an `ACCEPTED` event only for a version that is in force at the instant of the insert: purpose ACTIVE, the version belongs to the purpose's document, PLATFORM scope, published, entry and locale active, effective window containing the database clock. "In force" has ONE definition, the SQL function `identity.consent_version_state`, used by the trigger and by every service query, and it mirrors the content resolver (parity is tested against `ContentService.resolve`). The trigger share-locks the version row before it reads the clock, so a publication that closes the window serializes with the accept: either the accept lands first and is a valid historical fact, or the publication lands first and the accept is refused. The trigger also overwrites `occurred_at` with that instant. Sequence rules in the same trigger (next number only, first event ACCEPTED, no duplicate acceptance, no older version, a withdrawal carries the version it withdraws and only for a withdrawable purpose) keep the history from forking or contradicting itself.
- **The hash covers the SOURCE of the version.** The version id, locale and hash identify the immutable template body; the page shows the rendered, sanitized output of that same version. The evidence of an acceptance is the immutable source version; the rendered output is a deterministic function of the source and the renderer, guarded by a pinned rendering test of a LEGAL fixture. Hashing the rendered output at accept time would be stronger and is future work (DEBT-0078).
- **Information control on the accept path.** A version that is unknown or unpublished is one uniform not-found; a version that is not in force is refused as not current BEFORE its locale or hash are compared, so the class of an error never reveals the locale or hash of a stale or scheduled version.
- **Idempotent, serialized writes.** The service locks the account row `FOR UPDATE`, reads the latest event, decides (no-op or insert) and inserts; the audit row and the outbox event are written in the same transaction. Accepting the version already accepted is `changed: false`; a unique violation on the sequence key is re-read and is idempotent when the winner is the same acceptance.
- **The person is shown the text, and accepts exactly that.** The accept request names the version id, the locale and the hash the person was shown; the server verifies them against the immutable version and refuses a mismatch instead of repairing it (`CONSENT_LOCALE_MISMATCH`, `CONSENT_HASH_MISMATCH`). The web page offers Accept only when the public resolver's version id and hash equal the API's requirement.
- **No personal data beyond the account reference.** No raw IP address, user agent or client timestamp; the time is the database's; the optional application session id is tied to the same account by a composite foreign key.

## Alternatives considered

- **An acceptance table plus a current-state table** (the common "acceptances" and "current_consents" pair): two writes to keep consistent, a current flag that can drift from the log, and an acceptance row that is easy to update in place. A single derived log cannot disagree with itself. Rejected.
- **A boolean (or timestamp) per purpose on the account**: loses which version, which language and which text, loses history, and cannot show what happened across versions. It cannot satisfy SV-02.04. Rejected.
- **Storing the legal text (or a snapshot) with the acceptance**: the version is already immutable and never deleted, so the reference is equivalent to a copy for the text and its identity, without duplicating large legal documents per account and without a second source of truth for the wording. CFG-002's own snapshots reach the same conclusion. Rejected.
- **Storing `version_id` alone and trusting the latest version**: without the locale and hash in the key nothing proves they match the text, and "the latest version at the time" is not recoverable if the resolver rules change. Rejected for the composite key. Treating "whatever is latest" as what the person saw is the failure this record exists to prevent.
- **Eligibility only in the service**: a second writer, a script or a later feature would bypass it, and a publication racing the accept could leave a record for a version that was not in force. Rejected; the trigger is the arbiter and the service pre-checks only to give a precise error.
- **A separate "current" definition in the service** (re-implementing the resolver's window logic in TypeScript): two definitions drift. Rejected for the shared SQL function.
- **Updating a row on withdrawal**: destroys the evidence of the acceptance. Rejected; a withdrawal is a new event.

## Consequences

Every acceptance and withdrawal is a permanent row, an audit row and an outbox event; none is ever deleted, so legal records may need a retention and erasure decision against privacy requests that does not exist yet (DEBT-0081, DEBT-0045, DEBT-0057). A version referenced by a consent event can never be deleted, which the content model already guarantees. The history of a person is bounded to the newest 200 events in the API response. The full text of a historical version is not exposed by this layer (the version can be read by id from the content registry by a future console, DEBT-0078). Cross-language equivalence of acceptances is not modelled, so a language switch can require a new acceptance under the stricter modes (DEBT-0079). Only PLATFORM-scope versions of the consent documents can be accepted. Late concurrent changes of a locale or entry activation racing an accept are not serialized by a lock (a benign historical fact, DEBT-0081). The check relies on the default READ COMMITTED isolation of the write transaction (the read models use a read-only REPEATABLE READ snapshot), and on the lock order entry, then version, that publication uses: the trigger must not lock entries or locales after the version row.

## Migration / compatibility

Migration `0013_consent.sql` (forward-only, one transaction): the additive unique constraint on `content.versions`, the in-force function, two LEGAL entry shells without versions, `identity.consent_purposes` (TERMS_OF_SERVICE and PRIVACY_POLICY seeded), `identity.consent_events` with its guards, the audit extension (two actions, a nullable `consent_event_id` with a composite foreign key and a check), four configuration parameters and 40 managed content entries. No existing row is rewritten. A fresh environment has no published version of either document, so nothing can be accepted until Legal publishes (the evaluator reports `DOCUMENT_UNAVAILABLE`).

## Related files

- `db/migrations/0013_consent.sql`
- `packages/contracts/src/consent.ts`
- `packages/accounts/src/consent-service.ts`
- `packages/accounts/src/consent-evaluate.ts`
- `apps/api/src/modules/consent/routes.ts`
- `apps/web/src/app/consents/page.tsx`
- `docs/engineering/CONSENT.md`
- `docs/engineering/CONTENT.md`
- `docs/architecture/ADR-0018-content-registry-model.md`
- `docs/architecture/ADR-0025-application-account-and-keycloak-identity-separation.md`
