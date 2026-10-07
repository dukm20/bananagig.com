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

## Architecture rules

- Unit tests (`*.test.ts[x]`): no infrastructure, fast, run by `pnpm test` in each workspace.
- Integration tests (`*.itest.ts`): real Postgres and NATS via `pnpm dev:deps`; each test FILE creates its own freshly migrated database with `createIsolatedDatabase()` (never the dev database); run by `pnpm test:integration` (it starts dependencies itself).
- Smoke (`pnpm smoke`): runs inside the Compose network and proves real connectivity across all services.
- Contract checks: `pnpm specs:check`, `pnpm openapi:lint`, `pnpm asyncapi:validate`; boundaries: `pnpm deps:check`.
- Test helpers live in `@bananagig/testing` and are never imported by production code. Identity test helpers (`@bananagig/identity/testing`: forged tokens, scripted PKCE login, dev password grant) are DEV/TEST ONLY and ESLint forbids importing them from production code.

## Implementation pattern

1. Prefer a unit test with `app.inject()` / fakes; add an integration test when behaviour depends on Postgres or NATS semantics (transactions, locks, queues).
2. Use `createIsolatedDatabase()` from `@bananagig/testing`: it migrates a fresh `bananagig_t_*` database from zero and `drop()` removes it in `afterAll`. Create scratch tables inside it freely. Stale databases from crashed runs are removed by the integration global setup.
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

## Do not

- Do not point tests at the dev database or leave scratch tables behind.
- Do not skip failing tests to make a gate pass.
- Do not call real external services from tests.

## Related ADRs

ADR-0004, ADR-0006, ADR-0025

## Last reviewed

2026-10-07 (ID-001)
