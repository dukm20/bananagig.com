# ADR-0005 — Open-source-first infrastructure on Docker Compose

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: INF-001

## Context

The project wants minimal vendor lock-in and a fully reproducible local environment.

## Decision

Prefer open-source components (Postgres/PostGIS, Valkey, Keycloak, NATS, SeaweedFS, OpenSearch, flagd/OpenFeature, OpenTelemetry, Prometheus/Grafana/Loki/Tempo, Mailpit, Caddy). Applications talk to them through standard protocols (SQL, OIDC, S3, OTLP, OpenFeature) so each is replaceable.

## Alternatives considered

- Managed cloud services from the start: faster, but locks in and cannot run offline.

## Consequences

A heavy local stack (profiles keep the default light). Grafana, Loki and Tempo are AGPL (DEBT-0008). Replacement boundaries are listed per component.

## Migration / compatibility

None.

## Related files

- `docs/engineering/OPEN_SOURCE_STACK.md`
- `compose.yaml`
- `docs/engineering/CONTAINER_ARCHITECTURE.md`
