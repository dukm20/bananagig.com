# API Conventions

## Versioning policy

- All product endpoints live under **`/api/v1/`**. No business routes at the root.
- Operational endpoints stay unversioned: `/healthz`, `/readyz`, `/version`, `/metrics`. `/internal/*` is for infrastructure and is blocked by Caddy.
- Within `v1`, changes must be backward compatible: adding optional fields, endpoints, or enum values that clients are told to tolerate. Removing/renaming fields or changing semantics requires `/api/v2/`, run side by side until clients migrate.
- Deprecations are announced in the OpenAPI document (`deprecated: true`) before removal.

## Success envelope (`/api/v1`)

```json
{ "data": { "...": "..." }, "meta": { "correlationId": "..." } }
```

Operational endpoints return their own small documents (see OpenAPI).

## Error model

Every non-2xx response has this shape (`ErrorResponse` in `@bananagig/contracts`):

```json
{ "error": { "code": "VALIDATION_FAILED", "category": "VALIDATION", "message": "...", "correlationId": "...", "details": {} } }
```

| Category | HTTP | Use |
|---|---|---|
| VALIDATION | 400 | Malformed or invalid input |
| AUTHENTICATION | 401 | Missing/invalid identity |
| AUTHORIZATION | 403 | Identity is known but not allowed |
| NOT_FOUND | 404 | Resource or route does not exist |
| CONFLICT | 409 | State conflict, duplicate, concurrency |
| RATE_LIMIT | 429 | Throttled |
| DEPENDENCY | 503 | A required downstream is unavailable |
| INTERNAL | 500 | Unexpected failure |

`code` is a stable machine-readable string. Only generic codes exist today (`ROUTE_NOT_FOUND`, `VALIDATION_FAILED`, `BAD_REQUEST`, `RATE_LIMITED`, `INTERNAL_ERROR`); business codes are added with their features. Throw `AppError(category, code, message, details?)` from services. Unexpected exceptions become `INTERNAL_ERROR` with a generic message; **stack traces and internal messages are logged, never returned**.

## Correlation

- Header: `x-correlation-id`.
- Inbound values are accepted only if they match `^[A-Za-z0-9._-]{8,128}$`; otherwise a UUID is generated.
- The id is echoed in the response header and in `meta.correlationId` / `error.correlationId`, added to every log line and span (`correlation.id`), set as `app.correlation_id` inside DB transactions, stored in pg-boss job data (`_meta.correlationId`) and sent as the NATS `x-correlation-id` header.
- The web API client sends a fresh correlation id per server-side call.

## OpenAPI

- Contract: `docs/api/openapi.yaml`, OpenAPI **3.1**.
- **Source of truth: the code.** The document is generated from the real Fastify route schemas (built from zod contracts) by `pnpm specs:generate`. Do not hand-edit it.
- CI runs `pnpm specs:check` (fails if the committed file differs from what the code generates) and `pnpm openapi:lint` (Redocly). This removes hand-maintained drift.
- Adding an endpoint: add the contract to `@bananagig/contracts`, declare the route with `schema` via `schemaOf()`, run `pnpm specs:generate`, commit the regenerated file.
- The Redocly `security-defined` rule is enforced: every operation declares its security.

## Authentication and authorization

- Protected routes require `Authorization: Bearer <Keycloak access token for audience bananagig-api>` and use the guards in `apps/api/src/plugins/auth.ts`. Public routes declare `security: []` in OpenAPI; protected ones declare the `bearerAuth` scheme.
- **401 AUTHENTICATION**: `AUTHENTICATION_REQUIRED` (no token) or `INVALID_TOKEN` (malformed, forged, wrong issuer/audience/type, expired), with `WWW-Authenticate: Bearer realm="bananagig"`. **403 AUTHORIZATION**: `INSUFFICIENT_PERMISSIONS`. **503 DEPENDENCY**: `AUTH_PROVIDER_UNAVAILABLE` when the key set cannot be fetched.
- Guards authenticate first (401 before 403). Responses never include provider payloads or token content; the correlation id is preserved on every failure.
- Roles in tokens are identity roles (`customer`, `provider`); business permissions are application data. See `IDENTITY.md`.

## Current endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | liveness |
| GET | `/readyz` | readiness (critical dependencies) |
| GET | `/version` | service, version, commit, build time, environment |
| GET | `/api/v1/system/info` | service/environment/version/uptime (enveloped) |
| GET | `/api/v1/system/whoami` | caller identity: subject, client, audience, realm roles, auth context (requires a valid token) |
