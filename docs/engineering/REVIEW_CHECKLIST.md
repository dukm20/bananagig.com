# BananaGig review checklist

Use this for every change before it is called READY FOR REVIEW, and as the rubric of a human or independent reviewer. A box is ticked only with evidence (a command and its result, a file and line, a query); "not run" and "not applicable" are written, never implied. Standard: [`PRODUCTION_STANDARD.md`](PRODUCTION_STANDARD.md).

## 0. Scope
- [ ] Baseline commit and `git status` recorded; only files needed for this change are modified; the full diff was read and unrelated changes are none (or listed).
- [ ] Risk class stated (P0 / P1 / P2) and escalated where the change spans services, changes a public API or database contract, or affects existing bookings.
- [ ] Existing API, database, pricing, payment, booking and security contracts are preserved, or the approval for the change is quoted.

## 1. Shortcuts and honesty
- [ ] No unapproved workaround, hardcoded business value, mock in a production path, disabled or skipped test, ignored error, auth bypass or silent configuration override.
- [ ] Any temporary mitigation is registered in `TEMPORARY_MITIGATIONS.md` (ID, owner, approver, expiry, removal condition, flag, tests, monitoring) and its ID is in the code comment.
- [ ] No claim of a passing test, build, security check, deployment, GitHub setting or production state without a command or query that proved it in this change.

## 2. Correctness and safety
- [ ] Inputs validated at the boundary; typed errors; no raw driver or SQL text in responses, audit rows, events or logs.
- [ ] Authentication and authorization on every new route; ownership comes from the verified token, never from the request; another account's resource is 404.
- [ ] Money and time: integer minor units, one currency source, no floats; UTC timestamps; database clock for expiry and ordering.
- [ ] Idempotent where retried or replayed (events, jobs, webhooks, finalize-style calls); a stale write is detected (revision, version or lock).
- [ ] Transactions: one unit of work, lock order documented and followed, no I/O to another system inside a transaction that holds locks.
- [ ] Every external call has a timeout and, where retry-safe, a bounded retry with jitter; failure of a dependency degrades or fails closed, never fails open.
- [ ] Background work survives a restart; graceful shutdown drains with a deadline.

## 3. Data
- [ ] Forward-only migration; applied migrations untouched; the Data Model Review Gate documents are updated (`DATA_MODEL`, `DATA_DICTIONARY`, `ERD`, `CHANGELOG`, `NORMALIZATION_LOG`, snapshot).
- [ ] Backward-compatibility window considered (old code against the new schema and the reverse); backup and recovery path stated for destructive changes.
- [ ] Concurrency tests for new write paths (two sessions, lock waiters).

## 4. Security and privacy
- [ ] No secret, token, key, signed URL or personal data in code, tests, fixtures, logs, traces, errors, audit rows or events; secret scan clean.
- [ ] Provider- or user-written text is rendered as text only and normalised on input.
- [ ] Rate limiting considered for new public or expensive routes; the gap is registered if absent.

## 5. Tests
- [ ] New behaviour has unit and integration tests, including the negative and failure paths and the race that the design claims to handle.
- [ ] No test was skipped, weakened, retried to green or given a longer timeout to pass; a flaky failure was reproduced and explained with isolated reruns before being called unrelated.
- [ ] Commands run, with exit codes and counts: format, lint, typecheck, unit, integration, build, specs, `governance:scan`, `secrets:scan`, smoke where relevant. Not-run checks are listed with the reason.

## 6. Operations
- [ ] Logs are structured and free of sensitive values; metrics or alerts exist for new failure modes (or the gap is registered).
- [ ] Deploy and rollback (or roll-forward) are described; feature flags or configuration that protect the change are named.
- [ ] The completion status is one of BLOCKED, NOT READY, READY FOR REVIEW, RELEASE CANDIDATE, PRODUCTION VERIFIED, and it is the honest one.

## 7. Reviewer sign-off (P0 and P1)
- [ ] An independent reviewer (not the author, not the same agent) read the diff and the evidence and recorded findings. For P0 changes this review is a human's.
