# ADR-0017 — Configuration resolution caching, last-known-good and temporary permissions

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: CFG-001

## Context

Configuration is read on hot paths. PostgreSQL is authoritative (ADR-0001) and Valkey is non-authoritative (ADR-0003). Some parameters (money, legal windows) must never be served stale; others may tolerate a short database outage. Application roles and permissions do not exist yet (identity is only Keycloak, ADR-0013 to ADR-0015).

## Decision

- **Resolver**: three queries per batch regardless of the number of keys; most specific scope wins; `NO_VALUE` from the database is authoritative.
- **Cache** in Valkey, keyed by environment, parameter key, parameter generation and context hash. Lookups with an explicit evaluation time (`at`) bypass the cache and LKG. Publishing a version bumps the per-parameter generation, which instantly invalidates old entries. An entry is valid until the next effective boundary (the next moment any applicable value starts or ends), capped by `CONFIG_CACHE_TTL_SECONDS` (30).
- **CRITICAL parameters are never cached** and never served from last-known-good.
- **Last-known-good (LKG)** applies only when the database is unreachable (not on missing values), only to STANDARD parameters, only up to `CONFIG_LKG_MAX_AGE_SECONDS` (86400), and all-or-nothing per batch. Otherwise the caller gets `UNAVAILABLE` with the driver message (no values).
- **Temporary permission model**: the admin identity context plus client roles `configuration-read`, `configuration-write`, `configuration-approve` on `bananagig-admin`. It is a stopgap until application RBAC exists (DEBT-0021). Route guards run in `preValidation` so 401 precedes 400.
- **Test keys**: `devtest.*` keys exist only when `allowTestKeys` is on (non-production).
- **Sensitive values** are redacted in API responses, logs and events.

## Alternatives considered

- Cache everything with a fixed TTL: could serve a value past its effective boundary.
- Serve LKG on any error: would hide missing configuration and serve unapproved stale money values.
- Pub/sub invalidation: more moving parts; the generation counter gives the same effect with one key.
- Build application RBAC first: out of scope, blocks the registry.

## Consequences

Correctness never depends on the cache or the activation job. A Valkey outage degrades to direct database reads. Cross-instance invalidation relies on the shared generation counter in Valkey (DEBT-0022 notes the limits). Replacing the permission model later requires changing only `requireConfigurationPermission`.

## Migration / compatibility

None (no schema impact). New environment variables `CONFIG_CACHE_TTL_SECONDS`, `CONFIG_LKG_MAX_AGE_SECONDS`.

## Related files

- `packages/configuration/src/cache.ts`
- `packages/configuration/src/resolver.ts`
- `apps/api/src/plugins/auth.ts`
- `docs/engineering/CONFIGURATION.md`
