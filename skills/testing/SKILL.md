# Testing

## Purpose

Choose and write the right test level, and run the same gates CI runs.

## When to use

- Adding any code that needs tests, or deciding between unit, integration and smoke tests.
- Debugging a failing gate before finalizing a checkpoint.

## Canonical files

- `vitest.integration.config.ts`, `scripts/governance.test.mjs`, `scripts/migrate.test.mjs`
- `apps/api/src/api.test.ts`, `apps/web/src/web.test.tsx`, `apps/worker/src/worker.test.ts`, `apps/worker/src/worker.itest.ts`
- `packages/testing/src/index.ts`, `packages/testing/src/database.itest.ts`
- `apps/smoke/src/index.ts`, `.github/workflows/ci.yml`

## Architecture rules

- Unit tests (`*.test.ts[x]`): no infrastructure, fast, run by `pnpm test` in each workspace.
- Integration tests (`*.itest.ts`): real Postgres and NATS via `pnpm dev:deps`; use the isolated `bananagig_test` database only; run by `pnpm test:integration` (it starts dependencies itself).
- Smoke (`pnpm smoke`): runs inside the Compose network and proves real connectivity across all services.
- Contract checks: `pnpm specs:check`, `pnpm openapi:lint`, `pnpm asyncapi:validate`; boundaries: `pnpm deps:check`.
- Test helpers live in `@bananagig/testing` and are never imported by production code.

## Implementation pattern

1. Prefer a unit test with `app.inject()` / fakes; add an integration test when behaviour depends on Postgres or NATS semantics (transactions, locks, queues).
2. Use `ensureTestDatabase()` for DB access; create scratch tables inside the test and drop them.
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
- Never assert on secrets or unstable values (timestamps, generated ids) without normalizing them.

## Data-model considerations

Schema changes also need constraint-violation and rollback tests, and the data-model gate (`pnpm data-model:check <ID>`). Tests must not depend on data left in the dev database.

## Common failure modes

- Integration tests failing with `CONNECTION_REFUSED`: dependencies are not running with dev ports (`pnpm dev:deps`; a full `stack:all` recreate removes the dev port mappings).
- Tests passing against a stale built workspace: run `pnpm build` before typecheck in CI (turbo handles it).
- Hitting another project's server on a common port (LRN-0009).

## Known BananaGig-specific lessons

- Vitest 5 is required; vitest 3 pulled critical `tinypool` advisories (`docs/security/SCAN_RESULTS.md`).
- Governance scripts are tested against scratch git repositories in `scripts/governance.test.mjs`.

## Do not

- Do not point tests at the dev database or leave scratch tables behind.
- Do not skip failing tests to make a gate pass.
- Do not call real external services from tests.

## Related ADRs

ADR-0004, ADR-0006

## Last reviewed

2026-10-05 (META-001)
