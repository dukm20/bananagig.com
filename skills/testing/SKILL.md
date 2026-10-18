# Testing

## Purpose

Choose and write the right test level, and run the same gates CI runs.

## When to use

- Adding any code that needs tests, or deciding between unit, integration and smoke tests.
- Debugging a failing gate before finalizing a checkpoint.

## Canonical files

- `vitest.integration.config.ts`, `scripts/governance.test.mjs`, `scripts/migrate.test.mjs`
- `apps/api/src/api.test.ts`, `apps/web/src/web.test.tsx`, `apps/worker/src/worker.test.ts`, `apps/worker/src/worker.itest.ts`, `apps/worker/src/outbox.itest.ts`, `packages/testing/src/locks.itest.ts`, `packages/testing/src/migrations.itest.ts`, `packages/testing/src/postgis.itest.ts`
- `packages/testing/src/index.ts`, `packages/testing/src/database.itest.ts`
- `apps/smoke/src/index.ts`, `.github/workflows/ci.yml`
- `packages/testing/src/mailpit.ts` (read a delivered email from Mailpit and extract the code and link), `packages/accounts/src/email-verification.itest.ts` and `apps/api/src/account-email.itest.ts` (patterns for races, crafted rows and secret scans)
- `packages/testing/src/sms.ts` (`@bananagig/testing/sms`: `FakeSmsInbox`, `openFakeSmsInbox`, `extractSmsCode`; the ID-003 counterpart of the Mailpit helper), `apps/api/src/trust-proxy.test.ts` (proxy-trust semantics and the Caddyfile, static)
- ID-003 phone suites (patterns for crafted rows, guard triggers, races on one number and secret scans): `packages/testing/src/phone-model.itest.ts` (database), `packages/accounts/src/phone-verification.itest.ts` (service), `apps/api/src/account-phone.itest.ts` (HTTP), with unit suites `phone.test.ts`, `phone-policy.test.ts`, `verification-core.test.ts` and `apps/api/src/account-phone.test.ts`
- ID-004 suites (patterns for revocation, the watermark, step-up, Keycloak fakes and live Keycloak): `packages/testing/src/security-model.itest.ts` (database), `packages/accounts/src/security-service.itest.ts` (service), `apps/api/src/security.itest.ts` (HTTP), `packages/identity/src/keycloak-security.itest.ts` (live Keycloak), unit suites `apps/api/src/security.test.ts`, `packages/accounts/src/security-{device,policy,fakes}.test.ts`, `packages/identity/src/{keycloak-admin,authorize-extras}.test.ts`, `apps/web/src/{security-handlers.test.ts,security.test.tsx}`, `scripts/identity-realm.test.mjs`, `apps/api/src/spec-completeness.test.ts`; fakes in `packages/accounts/src/security-fakes.ts`
- CAT-004 suites (patterns for object-store flows, reference-aware clean-up and lock waiters): `packages/provider/src/gig-media.itest.ts` (a `MemoryObjectStore` subclass with test hooks and a scripted scanner), `packages/provider/src/gig-media.test.ts` (pure signature/dimension parsers with hostile input), `apps/worker/src/gig-media.itest.ts` (the scheduled job), `packages/testing/src/gig-options-media-model.itest.ts` (guards, lock order against a catalogue transaction, `lockWaiters`), `apps/api/src/gig-options-media.itest.ts`

## Architecture rules

- Unit tests (`*.test.ts[x]`): no infrastructure, fast, run by `pnpm test` in each workspace.
- Integration tests (`*.itest.ts`): real Postgres and NATS via `pnpm dev:deps`; each test FILE creates its own freshly migrated database with `createIsolatedDatabase()` (never the dev database); run by `pnpm test:integration` (it starts dependencies itself).
- Smoke (`pnpm smoke`): runs inside the Compose network and proves real connectivity across all services.
- Contract checks: `pnpm specs:check`, `pnpm openapi:lint`, `pnpm asyncapi:validate`; boundaries: `pnpm deps:check`.
- Test helpers live in `@bananagig/testing` and are never imported by production code. Identity test helpers (`@bananagig/identity/testing`: forged tokens, scripted PKCE login, dev password grant) are DEV/TEST ONLY and ESLint forbids importing them from production code.
- **Policy gates are tests of the repository itself (ENG-GOV-001).** `pnpm governance:scan` fails on skipped or disabled tests, unregistered to-do, fix-me and hack marker comments, `@ts-ignore`, workflow without `permissions:` or with an unpinned action, new `--passWithNoTests`, an expired or incomplete mitigation entry and a stale allowlist entry (`scripts/governance-allowlist.json`: every entry needs a justification and matches something, or the scan fails); `pnpm secrets:scan` runs the pinned gitleaks image over full history with `.gitleaks.toml` (narrow regex-plus-path allowlists only). The hook scripts in `.claude/hooks` are tested with structured stdin fixtures in `scripts/claude-hooks.test.mjs`, including false positives and fail-safe behaviour on malformed input. A failed Bash command reaches a `PostToolUseFailure` event, not `PostToolUse`, so verification-evidence hooks register for both and infer success from the event type.

## Implementation pattern

1. Prefer a unit test with `app.inject()` / fakes; add an integration test when behaviour depends on Postgres or NATS semantics (transactions, locks, queues).
2. Use `createIsolatedDatabase()` from `@bananagig/testing`: it migrates a fresh `bananagig_t_*` database from zero and `drop()` removes it in `afterAll`. Create scratch tables inside it freely. Stale databases from crashed runs are removed by the integration global setup.
   Create every pool of an integration test with `createTestPool(url, max)`, never `new pg.Pool`: `pool.end()` returns before the server has seen the clients leave, and the `DROP DATABASE ... WITH (FORCE)` that follows can deliver 57P01 to a closing idle client, which without a pool `error` listener is an uncaught exception that fails the run although every test passed (LRN-0051).
   In a smoke scenario wait about 2.6 s after a sign-out-everywhere before the next login of that user: inside 2 s of the watermark a new session is refused unless the identity provider confirms it (LRN-0052). To reproduce a CI smoke failure rebuild the SERVICES (`docker compose up -d --build api-service worker-service web-app`) and check their creation time first.
3. Add a smoke check only for new infrastructure connectivity.
4. Before finalizing run the full gate set below.

## Commands

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm test:integration
pnpm specs:check && pnpm openapi:lint && pnpm asyncapi:validate && pnpm deps:check
pnpm stack:all && pnpm smoke
pnpm checkpoint:finalize <ID> --skill-update=UPDATED|NOT_REQUIRED
```

## Testing requirements

- A bug fix includes a regression test that fails without the fix.
- Error-path tests are required (rollback, standard error model, graceful stop), not just happy paths.
- Auth tests: forged tokens for unit tests; real Keycloak (`keycloak.itest.ts`, `auth.itest.ts`) for protocol and end-to-end behavior; `pnpm test:integration` starts `keycloak-auth`.
- Concurrency tests use deferred barriers (`deferred()` in `@bananagig/testing`) to force interleavings, never sleeps alone.
- Never assert on secrets or unstable values (timestamps, generated ids) without normalizing them.

## Data-model considerations

Schema changes also need constraint-violation and rollback tests, and the data-model gate (`pnpm data-model:check <ID>`). Tests must not depend on data left in the dev database; every integration file starts from migrations-from-zero.

## Common failure modes

- Integration tests failing with `CONNECTION_REFUSED`: dependencies are not running with dev ports (`pnpm dev:deps`; a full `stack:all` recreate removes the dev port mappings).
- Tests passing against a stale built workspace: run `pnpm build` before typecheck in CI (turbo handles it).
- Hitting another project's server on a common port (LRN-0009).

## Known BananaGig-specific lessons

- A test's default 5 s timeout is a wall-clock ceiling too: a CPU-heavy test (maximum-size templates, many parallel callers) that takes 0.6 s on a developer machine took more than 5 s on the loaded CI runner. Give such a package an explicit `testTimeout` in its own `vitest.config.ts` (`packages/content`, CI-004) and keep the assertions deterministic. Read the failing test from the public check-run annotations (LRN-0028).
- Vitest 5 is required; vitest 3 pulled critical `tinypool` advisories (`docs/security/SCAN_RESULTS.md`).
- Governance scripts are tested against scratch git repositories in `scripts/governance.test.mjs`.
- Conditional rendering (a display template with optional parts) is tested over EVERY subset of present fields with invariants (balanced brackets, nothing dangling, each value once and in order), plus a differential test of the new renderer against the old one on inputs the change must not affect; a hand-picked full-address case hides the bug (GEO-002A). To prove an error message does not echo the input, compare it with the fixed message text; a short needle such as `1` or `-` is also in the static text and fails for the wrong reason.
- Numeric path and query parameters are tested at the HTTP boundary with the non-canonical forms Ajv coercion would accept (`1e3`, `1.0`, `+1`, `01`, ` 1`, `0x10`, `Infinity`), including percent-encoded and Unicode digits, and the test asserts the service was never called.
- Tests that copy the real migrations must derive numbering from the directory, not hardcode the latest version. Use isolated databases for anything that mutates shared timelines (activation, concurrency). Use `devtest.*` parameter keys, which exist only when `allowTestKeys` is on. The real-Valkey cache test self-skips when Valkey is unreachable; say so in reports.
- Content tests: count database queries with the `onQuery` hook of `createIsolatedDatabase` (a batch resolve must stay at 3 queries), prove time-derived resolution with a short real delay and `at`, force races with deterministic interleavings, and use `devtest.*` entry keys. Web tests use `apps/web/src/testing/content-stub.ts`, which validates requests and responses with the contracts schemas. Keep an XSS vector corpus (`packages/content/src/markup.test.ts`) and add every new vector to it.

- Race tests for guard triggers (`packages/testing/src/geography-seed.itest.ts`) use two real `pg` clients: the first holds an open transaction, the second statement is started without awaiting it, the test polls `pg_stat_activity` until it is blocked on a lock, then commits the first and asserts the second failed on the committed state; mutation-check such tests by removing the lock. The one lock inversion that remains (a raw SQL zone deactivation against a market activation) is proved as a genuine deadlock in `packages/geography/src/geography.itest.ts`: one side must fail as a retryable `CONFLICT` (`CONCURRENT_UPDATE`), nothing half-written, and the retry succeeds. Guard failures are asserted on the DETAIL key `geography_rule:<KEY>`, never on message text. Reference-data tests create `devtest-*` markets and the country `ZZ` (only with `allowTestKeys`; entities cannot be deleted, so smoke and tests use unique codes per run and reuse `ZZ` and the private-use locale `qaa`).

- Concurrent integration runs collide through the global setup that drops idle test databases; run `pnpm test:integration` alone or use a private config without `globalSetup` for parallel runs (LRN-0022). Cache outage tests need a hanging or slow-failing client and a real client on a dead port, not only an instant-failure fake (LRN-0019).

- Run the CI governance step exactly as CI does before pushing a schema change: `pnpm skills:check`, then `pnpm project-state:check --base=<previous remote head>` and `pnpm data-model:check --base=<previous remote head>` with NO checkpoint id and the full real SHA. The first CI run had an empty base, so the git-diff rules had never run; a mistyped base now fails instead of silently selecting baseline mode (LRN-0023).
- Never assert wall-clock time in a unit test (CI failed at 3.6 s against 0.3 s locally): assert counts; use order-of-magnitude ceilings for catastrophic-backtracking guards. The failing assertion of a CI job is readable in its public check-run annotations when the log needs authentication (LRN-0028).

- Get-or-create races (the first request of a person, ID-001, `apps/api/src/account.itest.ts`): fire N parallel callers at one new identity (20 in the API test) and assert the invariants, not the interleaving: exactly one account, one identity link and one creation history row, every caller got the same account id, one `account-created` event; repeat the file several times because a single green run proves little; also run parallel first requests of several distinct subjects and assert one account each. The database file `packages/testing/src/identity-model.itest.ts` proves the guard keys by their `identity_rule:<KEY>` DETAIL and the two deferred status-history checks at COMMIT (a missing row, a stray row, a `from_status` gap and a newest row against the status fail; a transaction through a transient status passes).
- Privacy is asserted by log capture, not by reading code: run the account routes with a capturing logger and assert that no token segment, Keycloak subject of the account's login or typed name appears anywhere in the output, in any response body, audit `changes`, event payload or error (compare against the fixed message, not a short needle), and that the schema holds no login subject outside the link table (an actor string `admin:<subject>` names who acted and is a different value; the outage log line carries the SQLSTATE or error class only).
- A coerced-body regression table (DEBT-0043 for new bodies): for every new body, list the values Ajv coercion would have accepted (`1`, `true`, `null`, `"1e3"`, extra keys, an `accountId`, non-object bodies, wrong-case enums) and assert each is a 400 with the standard envelope and that nothing was written (the integration test compares the whole state before and after; a unit test with a fake service asserts the service was never called; `apps/api/src/strict-body.test.ts` covers the shared helpers).
- Email tests read the REAL delivered message: `waitForMailpitMessages(to)` and `extractVerification(message)` from `@bananagig/testing` (Mailpit API `MAILPIT_API_URL`, default `http://127.0.0.1:18025`; SMTP `SMTP_HOST`/`SMTP_PORT` from `.env.host`). Use a unique address per test (`name-${randomUUID()}@example.test`) so reruns never collide.
- Time-dependent rules (expiry, cooldown) are tested without sleeping: insert a row with explicit past `created_at`/`expires_at` and hashes computed with the production hash function, or lower the policy through a fake provider. The database clock decides, so never rely on the application clock.
- Prove "exactly once" with real concurrency: `Promise.all` of the competing calls on separate pool connections, repeated in a loop with fresh accounts, asserting one `changed: true`, ONE audit row and ONE outbox event. Prove "never exceeds the maximum" the same way (N concurrent wrong codes, `attempt_count` ends at the maximum).
- Secret scans: dump the challenge/contact/audit/outbox rows as JSON and capture every `log` call (`vi.mock('@bananagig/observability')`) and assert the plaintext code, the token, both hashes and the full address are absent; only the masked form and ids may appear.
- An unchanged integration file that fails on a time comparison or times out may be Docker Desktop clock drift (LRN-0041): compare `date +%s` on the host with `docker exec bananagig-postgres-db date +%s`, and rerun the file alone once they agree. Take both sides of a time comparison from the database clock (`clock_timestamp()`).
- The full smoke run is limited by PRODUCT limits, not by flakiness: the Email and Phone verification scenarios send from one customer.dev, and the per-account hourly send cap (5) is counted in PostgreSQL, so they pass about twice per hour locally (the scenarios clear only their own Valkey source-address buckets). Do not weaken a limit to run smoke more often; wait for the window or run a single scenario's logic in an integration test. The Consent scenario has no such cap and is repeatable.
- SMS tests read the REAL message the API "sent" through the Valkey fake sink (`SMS_TRANSPORT=fake`, Valkey from `pnpm dev:deps`, default `redis://127.0.0.1:16379`): `openFakeSmsInbox()` and `inbox.wait(e164)` then `extractSmsCode(message.body)` from `@bananagig/testing/sms` (`FakeSmsInbox`). Use a unique number per test (US test numbers `+1202555xxxx`; the last three digits 901 to 905 select the fake line type, so avoid them unless the test is about line types) and `inbox.clear(e164)` when a test sends twice. The sink holds plaintext codes by design; it is DEV/TEST only and nothing in production code reads it.
- Do NOT run `pnpm test:integration` while other agents, a running stack or a developer need the dev database untouched: its first step (`scripts/dev.mjs --deps-only`) runs `scripts/migrate.mjs` against the dev database. To run single files use the vitest command with the integration config: `node --env-file-if-exists=.env.host node_modules/vitest/vitest.mjs run -c vitest.integration.config.ts <file>`. `dropStaleTestDatabases` (the integration global setup) now skips a test database whose name embeds the pid of a live process (`bananagig_t_<pid>_...`), so concurrent runs no longer drop each other's databases; a database of a crashed run (dead pid) is still dropped. Prefer one file per concurrent run.
- Advisory-lock race pattern (the accounts-per-number cap, ID-003): create the accounts, give each a pending contact for the SAME number, then `Promise.all` N verifications (more than the cap, on separate pool connections) and assert the invariants, not the interleaving: exactly `cap` accounts end VERIFIED, the rest get the typed refusal and nothing changed for them, one audit row and one outbox event per success; repeat in a loop with fresh accounts and numbers. Prove the trigger as the second line with raw SQL that ignores the service pre-check and expects `identity_rule:PHONE_NUMBER_CAP`. Mutation-check the test by removing the lock: it must fail.
- Testing session revocation (ID-004): forge tokens with `signToken(keys, { sid, authTime | authTimeAgoSec, acr })` (`@bananagig/identity/testing`) and call any `requireAccount` route: revoke one `sid` and assert THAT token is refused on its very next request while a token with another `sid` still works, measure the latency, and assert a never-seen session with an `auth_time` older than the watermark is refused at first sight. `FakeSecurityIdentityProvider` stands in for Keycloak: `setUser`, `addSession`, `failNext('endSession', n)`, `hold('sendPasswordResetEmail')` returns a release function (proves a caller does not wait for the provider), `calls`, `endedSessions`, `sentResetEmails`; `StaticSecurityPolicyProvider` serves a policy. Await `drain()` before asserting detached work. Live Keycloak tests clean up what they create (the smoke scenario `Sessions and security` always removes the second factor it enrolled for `provider.dev`).
- Time in security tests: `auth_time` is whole seconds and comes from another clock, so the watermark tolerates 2 s; wait past it (or craft rows) instead of racing it, and take both sides of a database-time comparison from `clock_timestamp()` (LRN-0041).
- A scripted Keycloak admin client test uses an injected `fetch` and clock and asserts the failure CODES and that no body, token, secret, URL or id ever reaches an error; a realm linter test mutates a copy of the realm file for every rule (positive and negative cases).
- Consent tests (ID-005): the API integration test and the smoke scenario publish a LEGAL version only through the real content workflow with TWO approvers (the author cannot approve), the accounts package (which does not depend on the content service) crafts versions by SQL in the states the workflow leaves them in with the content guard triggers enabled, and a pinned rendering test of a LEGAL markdown fixture fails on purpose when the renderer or sanitizer changes a legal document's output; craft old or odd events by disabling the guard trigger as the table owner and say so in the test; hold real locks in both orders to prove an accept against a publication, and run 25 parallel accepts to prove ONE event; test `identity.consent_version_state` against `ContentService.resolve` for parity over every version status and window; evaluator logic is a pure table-driven unit test (every status x mode x locale x role); `StaticConsentPolicyProvider` (`set`, `unset`, `failure`, `reads`) replaces configuration. A fresh database has no LEGAL version, so every required purpose is DOCUMENT_UNAVAILABLE until a test publishes one (LRN-0047, LRN-0048).
- Role-driven behaviour (ACC-001, LRN-0054): when the seed gives every role the same data, compare the API with an SQL oracle for the role in use and prove the effect with ONE reversible flip of a seeded row (precondition that restores the seed, `finally` that restores it and never swallows a failure); extra rows only in isolated databases. For streamed Next pages assert the not-found CONTENT, not the status (LRN-0053). A mutation check by an independent author found two real defects in this checkpoint: keep the habit of breaking the production line a test claims to cover.

- Object-store and cleanup flows (CAT-004, `packages/provider/src/gig-media.itest.ts`): subclass `MemoryObjectStore` from `@bananagig/platform` with switches a test flips (fail every `delete`, fail `head` or signing, a hook before `head` and one after `readVersioned` to replace the object or start a competing call at an exact point) and a scripted scanner (`CLEAN`, `INFECTED`, `ERROR`, throws). Best-effort deletion must be reported (counts-only log) and never thrown, and the reconciliation job must repair it on the next run: assert the one-way database marker (`objects_removed_at`) stays NULL while deletes fail and is set after they succeed. Leak checks dump the audit and outbox rows as JSON and capture every `log` call and assert no object key, signed URL, hash, asset id, provider name or alt text appears.
- Two clocks, one decides: an authorization window is written with the DATABASE `now()` and compared with it, so test expiry by ageing the row in SQL (`UPDATE ... SET upload_expires_at = ...`, `ready_at = now() - interval`), never by sleeping, and prove independence by giving the fake store a clock a day behind and a day ahead (the store's presigned-URL clock must not make a fresh authorization look expired nor keep an expired one alive). For a scheduled worker job (`provider.gig-media-cleanup`) call the service method directly in the service tests and, in the worker itest, poll the observable outcome (a terminal status or a removal marker) with a bounded `until(...)` loop instead of waiting for the cron.
- Concurrency around a sweep and an attach uses real lock waiters, not luck (the geography pattern above): hold `FOR UPDATE` on the account row or `FOR SHARE` on the asset in a second client, run the sweep and assert the busy row is SKIPPED (not waited for) and is swept on the next run once truly unreferenced; start the competing statement without awaiting it and poll `pg_stat_activity` until it waits (`lockWaiters` in `packages/testing/src/gig-options-media-model.itest.ts`); a database model test also runs the guards' lock order against a concurrent catalogue transaction (no deadlock). Authorizations, finalizations and sweeps run together must end only in success or a stale-revision answer, never a conflict.

## Do not

- Do not point tests at the dev database or leave scratch tables behind.
- Do not skip failing tests to make a gate pass.
- Do not call real external services from tests.
- Do not read verification secrets from the database in a test (they are hashes): take them from the delivered message, the fake SMS sink or the `EmailSender` / `SmsSender` double.
- Do not add a test skip, `.only`, `it.fails` or a longer timeout to get green; a failure under load is called flaky only after isolated reruns pass, and a guard is never weakened to pass a suite.

## Related ADRs
ADR-0004, ADR-0006, ADR-0025, ADR-0034, ADR-0035, ADR-0036, ADR-0037, ADR-0039, ADR-0047

## Last reviewed
2026-10-18 (ENG-GOV-001)
