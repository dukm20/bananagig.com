# Configuration registry

## Purpose

Read, define and change product configuration (business values) through the registry instead of hardcoding them.

## When to use

- A feature needs a business value (window, limit, rate, rule, unit definition) that could change or differ by market, category, plan, provider, gig or drop.
- Defining a new parameter, adding an allowed scope, or changing validation or approval policy.
- Reading a value in a service, or recording which values applied to something (snapshot).
- Touching the `configuration` schema, its API, events, cache or activation job.

## Canonical files

- `db/migrations/0004_configuration_registry.sql`, `docs/data/DATA_DICTIONARY.md`
- `packages/configuration/src/service.ts`, `resolver.ts`, `cache.ts`, `values.ts`
- `packages/contracts/src/configuration.ts`
- `apps/api/src/modules/configuration/routes.ts`, `apps/api/src/plugins/auth.ts`
- `apps/worker/src/jobs/configuration.ts`
- `docs/engineering/CONFIGURATION.md`

## Architecture rules

- Business values live in the registry, never in code, env vars or flagd (ADR-0016). Runtime wiring stays in `packages/config`; rollout switches stay in flagd.
- No default column: the PLATFORM-scope value is the default. Every parameter needs a PLATFORM value before it can resolve.
- The most specific scope wins. A parameter may be overridden only at levels in `parameter_scopes`. `scope_ref` is opaque with no foreign key; validate existence in the owning domain (DEBT-0024).
- Values are changed only through change requests. Versions are immutable and never withdrawn; correct with a new version. A new version starts after the latest of the holder.
- "Current" is derived from timestamps. Never add a stored current value or make resolution depend on the activation job.
- Anything that must be reproducible later (a booking, a quote, a payout) stores a snapshot id, not a copied value.
- CRITICAL parameters are never cached or served from last-known-good. Mark money, legal and safety values CRITICAL.
- Values may be sensitive: events, logs and audit carry identifiers only; mark SENSITIVE parameters accordingly.
- Use the canonical encodings (DECIMAL as string, DURATION `{amount, unit}`, MONEY `{amount_minor, currency}`). No floats for money or rates.

## Implementation pattern

1. Define the parameter in the owning checkpoint (key `domain.name`, type, rules, sensitivity, policy, criticality, allowed scopes) through `createParameter` or the API; seed through a change-controlled path, never an ad hoc migration of business values.
2. Read: `configuration.value<T>(key, { market: id })`, or `resolveMany` for several keys (3 queries per batch).
3. Record: `createSnapshot({ keys, context, purpose }, actor)` and store the returned id.
4. Change: create draft, submit, approve (second approver when required), publish. Future-dated publishes become SCHEDULED and are activated by the job.
5. After changing the API or events, run `pnpm specs:generate` and the spec checks.

## Commands

```bash
pnpm --filter @bananagig/configuration test
pnpm test:integration                 # real PostgreSQL (and Valkey when reachable)
pnpm specs:generate && pnpm specs:check
pnpm data-model:check <CHECKPOINT>    # after any change to the configuration schema
pnpm smoke                            # includes the Configuration Registry scenario
```

## Testing requirements

- Unit: value validation per type, resolver selection by specificity and time, cache policy (boundary expiry, CRITICAL bypass, LKG only on outage).
- Integration (real database): full workflow, approval policies, self-approval refused, overlap and timeline rules, concurrent publish, immutability triggers, snapshot stability, audit and outbox rows.
- API: 401 before 400, 403 for missing client role and for customer tokens, redaction, unknown fields rejected.
- Use `devtest.*` keys only in tests; they exist only when `allowTestKeys` is on.

## Data-model considerations

Any change to `configuration.*` goes through the Data Model Review Gate (normalization log, dictionary, ERD, snapshot). Do not add a default column, a mutable current value, or foreign keys from `scope_ref` into domain tables without an ADR. History is retained; there is no purge.

## Common failure modes

- `NO_VALUE`: no PLATFORM version is effective yet (a future-dated first version has not started).
- `CONFLICT` on publish: the start is not after the latest version of the holder, or two publishes raced.
- `SCOPE_NOT_ALLOWED`: the level is not in `parameter_scopes`.
- `UNAVAILABLE`: database down and no safe last-known-good (CRITICAL or never resolved before).
- Stale value for up to one TTL after a Valkey outage ends: entries are bounded by the next effective boundary and generation bumps; use `at` for authoritative lookups.
- Integration failures from leftover state: use isolated databases via `@bananagig/testing`.

## Known BananaGig-specific lessons

- Overlap prevention is a gist exclusion constraint, so versions need an explicit `effective_to` closure; the trigger allows exactly one such closure.
- Guards run in `preValidation` so unauthenticated callers get 401 before body validation.
- Fastify must not strip unknown fields (`removeAdditional: false`), or typos silently succeed.

## Do not

- Do not hardcode business values or seed future business defaults in migrations.
- Do not read or write `configuration.*` tables from other domains; use the service.
- Do not cache or fall back for CRITICAL parameters.
- Do not put values in events, logs or audit rows.
- Do not use the temporary client-role permissions as the long-term model (DEBT-0021).

## Related ADRs

ADR-0016, ADR-0017 (builds on ADR-0001, ADR-0003, ADR-0012)

## Last reviewed

2026-10-06 (CFG-001A)
