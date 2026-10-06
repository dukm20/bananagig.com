# Data Model (as of INF-002)

No business tables exist. This document describes only what is present in the database, verified against a live database (`\dt` on schemas after `pnpm migrate` and a worker start). INF-002 added **no migration and no tables**.

## Schemas

| Schema | Owner | Contents | Notes |
|---|---|---|---|
| `public` | mixed | `schema_migrations` (application-owned), `spatial_ref_sys` (PostGIS) | `public` is not used for product tables (see decision below) |
| `pgboss` | pg-boss | 13 infrastructure tables (`job`, `queue`, `schedule`, `subscription`, `version`, `bam`, `warning`, `queue_stats*`, ...) | Created by the worker on start. Never write to it directly; use the pg-boss API. Holds the infrastructure queue `infra.ping` |
| database `keycloak` | Keycloak | Identity provider tables | Separate database and role; not part of the product database |

Extensions: `plpgsql`, `postgis 3.6`.

## Application-owned tables

| Table | Columns | Constraints |
|---|---|---|
| `public.schema_migrations` | `filename text`, `checksum text NOT NULL`, `applied_at timestamptz NOT NULL DEFAULT now()` | PK `(filename)` |

Purpose: records applied migrations; the runner (`scripts/migrate.mjs`) refuses to run when an applied file's SHA-256 changes.

## Migration ownership

- Application migrations: `db/migrations/NNNN_description.sql`, applied forward-only by `scripts/migrate.mjs`, tracked in `public.schema_migrations`. Latest: `0001_infra_baseline.sql` (`CREATE EXTENSION IF NOT EXISTS postgis`).
- `pgboss.*`: owned and migrated by pg-boss itself.
- Keycloak: owned and migrated by Keycloak.

## Decision: where product tables live

**Future product tables go in logical PostgreSQL schemas per domain, not in `public`.** Planned schemas (created by the migration of the first feature that needs each, not before): `identity`, `configuration`, `catalog`, `provider`, `booking`, `finance`, and so on, mirroring the API module folders.

Reasons: clear ownership and permissions per domain, readable names (`booking.reservation`), simple per-domain review in the data-model gate, no collisions with extension and infrastructure objects in `public`, and an easier path to extracting a domain later. Cross-schema foreign keys are allowed where the domain relationship is real. `public` keeps only infrastructure (`schema_migrations`, PostGIS objects). No schema was created in INF-002 because nothing needs one yet.

## Normalization review (INF-002)

The only application-owned table is `schema_migrations`: atomic columns (1NF), single-column key so no partial dependencies (2NF), `checksum` and `applied_at` depend only on `filename` (3NF/BCNF). No duplicate concepts, no derived or denormalized fields, no nullable columns. Infrastructure schemas are third-party designs and out of scope.

## Stores and authority

| Store | Role | Authoritative? |
|---|---|---|
| PostgreSQL | Transactional state, jobs (pg-boss) | **Yes** |
| Valkey | Cache, derived state, rate limits | No (rebuildable, TTL on every key) |
| OpenSearch | Search projection | No (rebuilt from PostgreSQL) |
| NATS JetStream | Event transport | No (events originate from the outbox in PostgreSQL) |
| SeaweedFS (S3) | Media/blobs | Authoritative for blob bytes; PostgreSQL holds metadata |

## ERD

No relationships between application tables exist yet. Each feature checkpoint updates this document and the ERD (rules: `DATA_MODEL_GUARDRAILS.md`).
