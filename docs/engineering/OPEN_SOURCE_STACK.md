# Open-Source Stack

Compose service keys are descriptive role names and container names are `bananagig-<service key>` (see `CONTAINER_ARCHITECTURE.md`); this table keeps the technology identity so either can change independently. Licenses are as published by each upstream project; verify before any production decision. "Local-only" means not a production candidate in its current configuration.

| Component | Compose service (container `bananagig-<service>`) | Purpose | License | Official project | Why selected | Replacement boundary | Local / production |
|---||---|---|---|---|---|---|---|
| PostgreSQL 17 | `postgres-db` | Authoritative transactional database | PostgreSQL License | https://www.postgresql.org | Mature, ACID, rich constraints | SQL + `DATABASE_URL`; managed Postgres is a drop-in | Production candidate |
| PostGIS 3.6 | `postgres-db` (extension) | Geospatial types and functions | GPL-2.0-or-later | https://postgis.net | De facto Postgres geo extension | Used only through SQL; extension, not a service | Production candidate |
| Valkey 8.1 | `valkey-cache` | Cache, derived state, rate limits (never authoritative) | BSD-3-Clause | https://valkey.io | Open fork of Redis, protocol-compatible | `VALKEY_URL`; any Redis-protocol server | Production candidate |
| Keycloak 26.3 | `keycloak-auth` | Identity and access (OIDC) | Apache-2.0 | https://www.keycloak.org | Full IdP without building auth | OIDC standard; any OIDC provider (issuer, audience and JWKS are configuration; ADR-0013) | Candidate (`start`, not `start-dev`) |
| NATS 2.11 + JetStream | `nats-events` | Messaging and durable event streams | Apache-2.0 | https://nats.io | Light, single binary, persistence built in | `NATS_URL`; subject convention is portable | Production candidate |
| SeaweedFS 3.93 | `seaweedfs-storage` | S3-compatible object storage | Apache-2.0 | https://github.com/seaweedfs/seaweedfs | Small footprint, S3 API, permissive license | Anything speaking S3 (`S3_ENDPOINT`) | Local; production may use managed S3 |
| OpenSearch 2.19 | `opensearch-search` | Search projection (not source of truth) | Apache-2.0 | https://opensearch.org | Open search engine with a permissive license | `OPENSEARCH_URL`; rebuildable from Postgres | Candidate (security plugin is disabled locally) |
| flagd | `flagd-flags` | OpenFeature-compliant flag service | Apache-2.0 | https://flagd.dev | Vendor-neutral flag evaluation | OpenFeature SDK abstracts the provider | Production candidate |
| OpenTelemetry Collector (contrib) | `otel-collector` | Telemetry ingest and routing | Apache-2.0 | https://opentelemetry.io | Vendor-neutral OTLP pipeline | OTLP endpoint swap | Production candidate |
| Prometheus | `prometheus-metrics` | Metrics storage and scrape | Apache-2.0 | https://prometheus.io | Standard metrics store | `/metrics` exposition is portable | Production candidate |
| Grafana | `grafana-dashboard` | Dashboards and datasource UI | AGPL-3.0 | https://grafana.com/oss/grafana | Single UI for metrics, logs, traces | Datasources are config only | Candidate (note AGPL) |
| Loki | `loki-logs` | Log storage | AGPL-3.0 | https://grafana.com/oss/loki | Cheap label-indexed logs, OTLP ingest | OTLP logs through the Collector | Candidate (note AGPL) |
| Tempo | `tempo-traces` | Trace storage | AGPL-3.0 | https://grafana.com/oss/tempo | OTLP-native trace storage | OTLP traces through the Collector | Candidate (note AGPL) |
| Mailpit | `mailpit-email` | Local SMTP sink and inbox | MIT | https://mailpit.axllent.org | Catches mail so none leaves the machine | SMTP host/port env vars | Local-only |
| Caddy | `caddy-proxy` | Local reverse proxy | Apache-2.0 | https://caddyserver.com | Tiny config, no TLS setup needed locally | Any HTTP proxy or ingress | Local; production candidate |
| pg-boss | `worker-service` (library) | Durable background jobs on Postgres | MIT | https://github.com/timgit/pg-boss | No extra broker; transactional with app data | Isolated in the worker | Production candidate |
| Trivy | (not a service; run on demand) | Image and config scanning | Apache-2.0 | https://trivy.dev | Single scanner for images, fs, IaC | Dev/CI tool only | Tooling |

**Not used:** a Kafka-style broker (explicitly excluded). NATS JetStream covers the event backbone.

**Source-of-truth rules:** PostgreSQL is authoritative. Valkey and OpenSearch hold derived data that can be rebuilt. SeaweedFS holds media blobs; Postgres holds only their metadata.

**Postgres image note:** the official `postgis/postgis` image has no linux/arm64 build, so `infra/postgres/Dockerfile` installs PostGIS from the PGDG repo onto the official `postgres` image.

**Licensing note:** Grafana, Loki and Tempo are AGPL-3.0. Running them unmodified as separate services is typically fine, but get a licensing review before offering them as part of a hosted product.
