# ADR-0008 — Product tables live in per-domain PostgreSQL schemas

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: INF-002

## Context

Many domains (identity, catalog, booking, finance, ...) will share one database.

## Decision

Product tables go in logical schemas per domain (`identity`, `configuration`, `catalog`, `provider`, `booking`, `finance`, ...), created by the migration of the first feature that needs them. `public` keeps only infrastructure objects (`schema_migrations`, PostGIS).

## Alternatives considered

- Everything in `public`: collides with extension objects and blurs ownership.
- Database per domain: breaks cross-domain transactions.

## Consequences

Qualified names everywhere (`booking.reservation`). Cross-schema foreign keys are allowed where the relationship is real. The data-model gate documents each schema.

## Migration / compatibility

No schemas were created; nothing needs them yet.

## Related files

- `docs/data/DATA_MODEL.md`
- `docs/data/DATA_MODEL_GUARDRAILS.md`
