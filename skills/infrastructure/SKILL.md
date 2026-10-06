# Infrastructure (Docker Compose platform)

## Purpose

Operate and extend the local container platform: services, profiles, ports, health, images, scans.

## When to use

- Adding or changing a Compose service, image, volume, port, or Caddy route.
- Changing observability wiring (Collector, Prometheus, Loki, Tempo, Grafana).
- Anything that makes `pnpm smoke` or a clean start fail.

## Canonical files

- `compose.yaml`, `compose.dev.yaml`, `Dockerfile`, `.env.example`, `.env.host.example`
- `infra/` (per-service config: `caddy`, `otel`, `prometheus`, `grafana`, `loki`, `tempo`, `flagd`, `keycloak`, `seaweedfs`, `postgres`)
- `scripts/dev.mjs`, `apps/smoke/src/index.ts`
- `docs/engineering/CONTAINER_ARCHITECTURE.md`, `docs/engineering/OPEN_SOURCE_STACK.md`, `docs/engineering/LOCAL_DEVELOPMENT.md`, `docs/security/SCAN_RESULTS.md`

## Architecture rules

- One concern per container; explicit image tags; one network `bananagig-net`.
- Compose service keys are descriptive role names, container names use `bananagig-<role>`, and technology identity remains documented separately (`docs/engineering/CONTAINER_ARCHITECTURE.md`, `docs/engineering/OPEN_SOURCE_STACK.md`). Internal addressing uses the service key (`postgres-db:5432`, `nats-events:4222`), never `container_name`. Volumes and telemetry `service.name` values are not renamed with roles.
- Profiles: `core` (default), `observability`, `search`, `devtools`, `tools` (smoke). Put a service in the narrowest profile that fits.
- Publish host ports only on `127.0.0.1`. Production-like containers publish none; Caddy is the single entry. Dev-only ports go in `compose.dev.yaml`.
- Apps run non-root, read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`. The web container gets an explicit minimal environment, never `env_file`.
- Every long-running service needs a healthcheck unless its image is distroless (collector, flagd): then the smoke test must verify it by connectivity.
- No secrets in images or git; development defaults must look obviously fake (`*_dev_only`).
- Keycloak (`keycloak-auth`) is configured from `infra/keycloak/bananagig-realm.json` only; its issuer is pinned with `KC_HOSTNAME`. The public identity host in Caddy exposes only `/realms/bananagig/*` and `/resources/*`; the admin console is on a dev-only host. See `skills/identity/SKILL.md`.

## Implementation pattern

1. Add the service to `compose.yaml` with image tag, profile, healthcheck, network, and named volume if stateful.
2. Add its config under `infra/<service>/` and mount read-only.
3. Add a real connectivity check to `apps/smoke/src/index.ts` (not just "container is up") and add it to the `order` list.
4. Add the variable to `.env.example` (group comment) and, if host-reachable in dev, to `compose.dev.yaml` with an offset port and `.env.host.example`.
5. Update `docs/engineering/OPEN_SOURCE_STACK.md` (license, replacement boundary) and CONTAINER_ARCHITECTURE.
6. Verify from zero: `pnpm stack:reset && pnpm stack:all`, migrate, `pnpm smoke`.

## Commands

```bash
pnpm stack:up          # core profile          pnpm stack:all   # every profile
pnpm stack:down        # keep volumes          pnpm stack:reset # destroy volumes
pnpm stack:ps | pnpm stack:logs
pnpm smoke             # runs inside the network, 22 checks
docker compose up -d --force-recreate <service-key>   # after editing a bind-mounted file
```

## Testing requirements

- A change is not done until a cold start (`stack:reset` then `stack:all`) and `pnpm smoke` pass; warm restarts hide init-ordering bugs (LRN-0003).
- The smoke test must verify behaviour (query, round trip, trace found), not container status.
- Image changes: rebuild and scan (`docs/security/SCAN_RESULTS.md` has the commands); runtime stage must keep npm removed.

## Data-model considerations

Compose services add no tables. A service that stores state (queue, cache, search) must have its authority documented in `docs/data/DATA_MODEL.md` ("Stores and authority"): PostgreSQL is authoritative; others are derived.

## Common failure modes

- Bind-mounted config not applying: recreate the service (LRN-0005).
- `up --wait` failing on one-shot containers (LRN-0004).
- Cold-start-only failures from readiness races (LRN-0003).
- Port collisions with other projects on the machine (LRN-0009); check `lsof -iTCP:<port> -sTCP:LISTEN`.
- Fresh install failing on pnpm build-script approvals (LRN-0010).
- Realm edits not applying because `--import-realm` skips an existing realm (LRN-0013): `pnpm identity:sync` or `pnpm stack:reset`.

## Known BananaGig-specific lessons

- flagd server and provider SDK versions must be bumped together (LRN-0001).
- Keycloak's built-in `admin-cli` enables the password grant in every realm; the realm file disables it (LRN-0014).
- PostGIS comes from a custom image because upstream has no arm64 build (LRN-0002).
- Image scans do not see bundled dependencies; also run the lockfile audit (LRN-0008).
- Distroless images (otel-collector, flagd) cannot have shell healthchecks (DEBT-0009).
- Fix audit findings with a scoped, major-capped override (`"parent>child": "^x.y.z"`) and check `pnpm peers check`; an open `>=` range can adopt a new major. Run `pnpm audit --prod` and read its exit code before calling a finding accepted (LRN-0018).

## Do not

- Do not publish internal service ports to all interfaces or add `privileged: true`.
- Do not put secrets or real credentials in `.env.example`, compose files or images.
- Do not use `latest` tags.
- Do not route `/internal/*` through Caddy.

## Related ADRs

ADR-0001, ADR-0003, ADR-0005, ADR-0007

## Last reviewed

2026-10-05 (CI-001)
