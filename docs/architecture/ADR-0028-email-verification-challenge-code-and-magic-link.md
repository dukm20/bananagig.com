# ADR-0028 — Email verification is one challenge per send, with a code and a magic link, keyed hashes at rest, single use under a row lock, and two-phase delivery

Status: ACCEPTED
Date: 2026-10-07
Checkpoint: ID-002

## Context

The PRD (SV-03.01, CU-03) sends a one-time code and a magic link in the same email; entering the code or opening the link marks the address verified; codes are single use and stored only as hashes; the code length, validity, resend wait, send caps and wrong-attempt maximum are configuration. Problems to settle: what a "challenge" is across resends, how a 6-digit code can be hashed safely, how a code and a link racing verify exactly once, how a mail scanner that prefetches the link must not verify anything, where the token may travel, and what happens when the mail server fails after the challenge is committed.

## Decision

- **One challenge per send.** `identity.email_verification_challenges` has one row per verification email. A resend creates a NEW challenge (new code, new token) and supersedes the open one in the same transaction; at most one challenge per contact is open (partial unique index). The number of sends in a window is therefore the number of rows (no counter to drift) and the history of sends is kept.
- **Keyed hashes, never plaintext.** The code and the 256-bit magic token are shown once, in the email. The database stores HMAC-SHA-256 of each, keyed with a server secret held outside the database (`VERIFICATION_HASH_SECRET`, a deployment secret and not product configuration); the code hash is bound to its challenge id, hashes are domain-separated, and comparisons are constant-time. A plain SHA-256 of a 6-digit code could be reversed from a leaked table in a millisecond; the keyed hash cannot be attacked offline without the secret. Rotating the secret invalidates open challenges, which expire in minutes. Codes and tokens come from the operating system CSPRNG.
- **Policy is configuration.** Code length, validity, resend wait, hourly and daily caps and the attempt maximum are the `verification.email.*` parameters of CFG-001 (CRITICAL, `SECOND_APPROVER`, owner security; PRD defaults 6 digits, 10 minutes, 30 s, 5 per hour, 10 per day, 5 attempts). The service reads them fresh and fails closed when they are unavailable. The cooldown and the caps are counted per ACCOUNT from the challenge rows (changing the address does not reset them).
- **Single use under a row lock.** Every confirmation takes the account row, the account's contacts, then the challenge row `FOR UPDATE`. A code and a link racing, two clients submitting the same code, and a resend racing a verify run one after the other; the loser finds the address verified and gets an idempotent success with no second audit row or event. Wrong codes are counted under the same lock and committed even though the call fails; the attempt that reaches the maximum locks the challenge.
- **The link is a fragment, and opening it verifies nothing.** The link is `<web>/verify-email#token=<token>`. A URL fragment is never sent to a server, so the token reaches no access log, trace, proxy or Referer header. The page reads it in the browser, removes it from the address bar and shows a button; the web server POSTs the token in a body to `POST /account/email/verification/confirm-link`. A GET that changed state would be triggered by mail scanners and link previewers. A person who is not signed in signs in and opens the link again (the fragment does not survive the login redirect, deliberately: the token is never stored in the login transaction).
- **Two-phase delivery.** The challenge commits first, the message is delivered OUTSIDE any transaction through the `EmailSender` port (a slow relay never holds a lock), then the outcome is recorded. A failed delivery closes its challenge (`DELIVERY_FAILED`: the code never reached anyone) and does not start the resend cooldown; the hour and day caps still count it, so failing deliveries are bounded. A crash between commit and recording leaves a `PENDING` delivery whose code is still valid; the worst case is an earlier resend.
- **Provider neutrality.** The identity service depends on the `EmailSender` port (`to`, template key and version, typed variables, correlation id). SMTP (Mailpit locally and in CI) is an adapter; a production provider is another class behind the same port (DEBT-0049). Rendering is a second port: the composition root renders `account.email.verification.subject` and `.body` from the content registry (CFG-002); the identity service holds no copy.

## Alternatives considered

- One long-lived challenge per contact that is re-armed on resend: loses the send history, needs a counter that can drift, and a re-armed row would have to mutate its hash. Rejected.
- A plain SHA-256 or bcrypt of the code: SHA-256 is reversible for 10^6 values; bcrypt costs CPU on every attempt for a value that is already rate-limited and short-lived. Rejected for HMAC with a secret outside the database.
- Putting the token in the query string: reaches access logs, traces and Referer headers. Rejected for the fragment.
- A GET link that verifies on open: link scanners and previewers would verify addresses nobody confirmed. Rejected.
- Sending inside the transaction: holds the account lock while an SMTP relay is slow or down. Rejected.
- Verification state (attempts, locks) in Valkey: lost on restart and not restart-proof; PostgreSQL is authoritative (ADR-0001). The Valkey limiter adds dimensions the database cannot see (ADR-0029); it does not replace the database counters.

## Consequences

A token travels in a fragment, so the magic link needs JavaScript in the browser (the code path works without it). Deliverability and bounce handling (SV-03.03) are not modelled. The HMAC key is a new deployment secret (production sets its own; it has a development placeholder).

## Migration / compatibility

Migration `0010_email_verification.sql` seeds the eight parameters and the 34 content entries through the real workflows. `.env.example` gains `VERIFICATION_HASH_SECRET`.

## Related files

- `db/migrations/0010_email_verification.sql`
- `packages/accounts/src/email-crypto.ts`
- `packages/accounts/src/email-verification.ts`
- `packages/platform/src/email.ts`
- `apps/api/src/modules/account/email-routes.ts`
- `apps/api/src/modules/account/email-wiring.ts`
- `apps/web/src/app/verify-email/page.tsx`
- `docs/engineering/EMAIL_VERIFICATION.md`
- `docs/architecture/ADR-0016-configuration-registry-design.md`
- `docs/architecture/ADR-0018-content-registry-model.md`
