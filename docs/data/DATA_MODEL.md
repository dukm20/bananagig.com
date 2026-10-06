# Data Model (as of INF-003)

Describes what exists in the database today, verified against a database migrated from zero. No business tables exist. Conventions: `DATABASE_CONVENTIONS.md`; migration rules: `MIGRATION_POLICY.md`; review rules: `DATA_MODEL_GUARDRAILS.md`; exact structure: `SCHEMA_SNAPSHOT.sql`.

## Schemas and ownership

| Schema | Class | Contents | Notes |
|---|---|---|---|
| `public` | application (bookkeeping) + extension | `schema_migrations` (application); `spatial_ref_sys` and PostGIS objects (extension) | Infrastructure only; product tables never go here (ADR-0008) |
| `integration` | **application** | `outbox_events` | Created in INF-003; cross-domain integration infrastructure |
| `pgboss` | infrastructure (pg-boss) | 13 tables, queue `infra.ping` | Created by the worker on start; never altered by our migrations |
| database `keycloak` | infrastructure (Keycloak) | Identity provider tables | Separate database and role |

Extensions: `plpgsql`, `postgis 3.6`. **Deferred schemas** (created by the first feature that needs them): identity, configuration, geography, catalog, provider, capacity, search, booking, finance, banana_credit, subscription, tax, messaging, trust, admin, audit.

## Application-owned tables

### `public.schema_migrations`
Migration bookkeeping. Columns: `version integer` (PK), `filename text` (unique), `checksum text`, `applied_at timestamptz`, `duration_ms integer` (nullable; NULL for 0001). Checks: `version > 0`, filename must match the zero-padded version, `duration_ms >= 0`. Rows are never updated or deleted.

### `integration.outbox_events`
Generic transactional outbox. One row per domain event, inserted in the same transaction as the state change; relayed to NATS JetStream by the worker; `published_at` marks completion. Key `outbox_event_id uuid` (also the event id and the JetStream message id). No foreign keys by design (domain-agnostic; `aggregate_id` is text). Partial indexes serve the relay (`idx_outbox_events__pending`) and retention purge (`idx_outbox_events__published_at`). Checks guard event-type format, version/type consistency, actor type, object payload, attempt counts. Business events do not exist yet; only the infrastructure `bananagig.infra.ping.v1` is produced (by the worker self-test).

## Migrations

| File | Content |
|---|---|
| `0001_infra_baseline.sql` | PostGIS extension (immutable; predates the header rule) |
| `0002_database_foundation.sql` | `schema_migrations`: `version` as primary key, `duration_ms`, naming/consistency constraints |
| `0003_integration_outbox.sql` | `integration` schema and `outbox_events` |

Latest migration: `0003_integration_outbox.sql`. Ownership: application migrations are applied by `pnpm migrate`; `pgboss.*` by pg-boss; Keycloak by Keycloak.

## Intentional denormalization

| Where | What | Why | How drift is prevented |
|---|---|---|---|
| `schema_migrations.version` | derived from `filename` prefix | numeric ordering and a compact primary key | `ck_schema_migrations__filename_matches_version` |
| `outbox_events.event_version` | derived from the `event_type` suffix | the event envelope carries the version explicitly | `ck_outbox_events__version_matches_type` |

## Stores and authority

| Store | Role | Authoritative? |
|---|---|---|
| PostgreSQL | Transactional state, jobs (pg-boss), **committed events (outbox)** | **Yes** |
| NATS JetStream | Event transport (stream `BANANAGIG_EVENTS`, 7-day retention, 2-minute duplicate window) | No: events originate from the outbox |
| Valkey | Cache, derived state, rate limits | No (rebuildable, TTL on every key) |
| OpenSearch | Search projection | No (rebuilt from PostgreSQL) |
| SeaweedFS (S3) | Media/blobs | Authoritative for blob bytes; PostgreSQL holds metadata |

## Identity boundary (INF-004: no schema change)

Keycloak (database `keycloak`, infrastructure-owned) owns credentials, protocol sessions and MFA factors. BananaGig will reference identities by the immutable Keycloak `sub` in a future `identity.external_identities` table (unique on provider + subject), created by the first persisted account feature (ID-001) through the Data Model Review Gate. No user or profile table exists and none was needed for INF-004. Web sessions live in Valkey (non-authoritative, TTL on every key). See `docs/engineering/IDENTITY.md`.

## ERD

See `ERD.md`.
