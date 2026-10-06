# API (Fastify, contracts, OpenAPI)

## Purpose

Add or change HTTP endpoints following the BananaGig API conventions.

## When to use

- Adding a route, module, DTO, or error code.
- Changing error handling, correlation, or readiness behaviour.
- Regenerating or validating the OpenAPI/AsyncAPI documents.

## Canonical files

- `apps/api/src/app.ts`, `apps/api/src/index.ts`, `apps/api/src/errors.ts`, `apps/api/src/schema.ts`
- `apps/api/src/plugins/correlation.ts`, `apps/api/src/plugins/errors.ts`, `apps/api/src/plugins/auth.ts`
- `apps/api/src/modules/system/routes.ts`, `apps/api/src/modules/system/service.ts`
- `packages/contracts/src/index.ts`, `scripts/generate-specs.mjs`, `docs/api/openapi.yaml`, `docs/events/asyncapi.yaml`
- `docs/engineering/API_CONVENTIONS.md`, `docs/engineering/EVENT_CONVENTIONS.md`

## Architecture rules

- Product routes only under `/api/v1/`; health/readiness/version/metrics stay at the root; `/internal/*` is never proxied.
- One folder per domain in `apps/api/src/modules/<domain>/`: `routes.ts` (HTTP only), `service.ts` (logic, no Fastify imports). Create a module folder only when implementing that domain.
- Contracts live in `@bananagig/contracts` (zod), never database entities. Routes build their schema from them with `schemaOf()`.
- Success responses under `/api/v1` use `{ data, meta: { correlationId } }`; errors use `ErrorResponse` with one of the 8 categories. Throw `AppError(category, code, message, details?)`.
- Readiness checks critical dependencies only (API: PostgreSQL). Optional outages must not fail `/readyz`.
- Cross-cutting plugins use `fastify-plugin`; route modules stay encapsulated (LRN-0006).
- Protected routes use the guards in `apps/api/src/plugins/auth.ts` (`requireAuthenticated`, `requireRealmRole`, `requireAnyRole`, `requireClientRole`, `requireAuthContext`) and declare `security: [{ bearerAuth: [] }]`; public routes declare `security: []`. 401 is AUTHENTICATION, 403 is AUTHORIZATION; no provider payloads are returned. Details: `skills/identity/SKILL.md`.

## Implementation pattern

1. Add the request/response zod schemas to `packages/contracts`.
2. Create or extend `apps/api/src/modules/<domain>/routes.ts`; declare `schema` (operationId, summary, tags, response via `schemaOf()`, plus `errorResponses`).
3. Put logic in `service.ts`; use `database.transaction` for writes.
4. Register the module in `apps/api/src/app.ts` with the right prefix (`API_PREFIX` for versioned routes).
5. `pnpm specs:generate`, then commit the regenerated `docs/api/openapi.yaml`.

## Commands

```bash
pnpm --filter @bananagig/api test
pnpm specs:generate && pnpm specs:check
pnpm openapi:lint && pnpm asyncapi:validate
curl -s localhost:3211/api/v1/system/info    # when running `pnpm dev`
```

## Testing requirements

- Every endpoint: success, validation error, not-found/other applicable error category, and correlation id echo; use `app.inject()` (see `apps/api/src/api.test.ts`).
- `pnpm specs:check` must pass: a route change without regenerated OpenAPI fails CI.
- Unexpected errors must return `INTERNAL_ERROR` with no stack or internal message.

## Data-model considerations

Services never write SQL in routes. Persistence changes go through the database skill and its review gate. DTOs are public contracts and must not mirror table columns by accident.

## Common failure modes

- Hooks or the error handler silently not applying (missing `fp`, LRN-0006).
- `pnpm specs:check` drift after editing a route schema.
- Putting a business route at the root or exposing `/internal/*`.
- Making `/readyz` depend on Valkey/NATS/OpenSearch, which turns optional outages into API outages.

## Known BananaGig-specific lessons

- NestJS was rejected because esbuild bundling cannot emit decorator metadata (ADR-0006).
- Correlation id: header `x-correlation-id`, accepted only if it matches `^[A-Za-z0-9._-]{8,128}$`.
- OpenAPI `security-defined` lint is off until the first protected endpoint exists (`redocly.yaml`).

## Do not

- Do not hand-edit generated spec files.
- Do not return stack traces or raw exception messages.
- Do not invent business error codes outside the feature that needs them.
- Do not import `@bananagig/web` or put database types in contracts.
- Do not trust a route to be private because it is unlisted or because the UI hides it: add a guard.

## Related ADRs

ADR-0006, ADR-0004, ADR-0013

## Last reviewed

2026-10-05 (INF-004)
