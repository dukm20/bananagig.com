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
- Put authorization guards in `preValidation` so 401 precedes 400 (LRN-0017), keep `removeAdditional: false` so unknown fields are rejected (LRN-0016), and map domain errors through a module `toAppError`. Configuration permissions use `requireConfigurationPermission(read|write|approve)`.
- Content permissions use `requireContentPermission(read|write|approve)` plus `assertContentLegal` for LEGAL-owned entries (looked up from the stored entry, never from the request). The content resolve routes and active-locale list are public (`security: []`) behind `optionalAuthenticated()`: no Authorization header means anonymous, a presented token must be valid (401 otherwise), and a valid token without `content-read` is still anonymous. Anonymous callers get PUBLIC entries only and never `at` or the template. Batch endpoints omit keys they cannot serve instead of failing the batch (see `docs/engineering/CONTENT.md`).
- Geography follows the same pattern (`requireGeographyPermission(read|write)`, `hasGeographyPermission`, public reads behind `optionalAuthenticated()`; `docs/engineering/GEOGRAPHY.md`): a caller without the admin context plus `geography-read` (or `geography-write`, which implies read) is anonymous and sees ACTIVE rows and public fields only (`effectiveTo` is null publicly), and the DTO mappers build every response field by field. `optionalAuthenticated()` adds `Vary: Authorization` to every response of the route (401 and 404 included). Management bodies are validated by a strict zod `preValidation` hook (`strictBody`, after the guard) before ajv can coerce them, so `{"active":1}` is a 400; administrator free text uses the contracts `adminText` rule. Error codes are `GEOGRAPHY_<code>`. Path parameters are validated by the route schema, so a non-canonical code (`/countries/us`, `/markets/LA-OC`) is a 400, not a 404.

## Do not

- Do not hand-edit generated spec files.
- Do not return stack traces or raw exception messages.
- Do not invent business error codes outside the feature that needs them.
- Do not import `@bananagig/web` or put database types in contracts.
- Do not trust a route to be private because it is unlisted or because the UI hides it: add a guard.
- Integers that arrive as text (path parameters, query strings) use the one strict parser: `strictIntegerParams({ name: bounds })` in `preValidation` (after the authorization hook) plus `integerParamSchema(bounds)` in the route schema; never rely on Ajv coercion, which reads `1e3` as 1000 and `0x10` as 16 (LRN-0032). `enforceStrictIntegerParams` makes a route with an unguarded numeric `params`/`querystring` property, a numeric type outside `properties`, or any `$ref` in those schemas fail to register (the hook must be a direct entry of the route's own `preValidation`), so adding one without the hook fails in every test that builds the app. It does not cover request bodies: Ajv still coerces body integers and booleans on the configuration and content routes (DEBT-0043); use `strictBody` there.
- Endpoints that receive personal data and persist nothing (address validate/format, `docs/engineering/ADDRESSES.md`) are stateless POSTs: `Cache-Control: no-store`, a small `bodyLimit`, `strictBody` first, errors and issues carry field names and codes only (never the rejected value), no logging of the body (the app has `logger: false`; keep it so), and no sibling route that reads a persisted record until its access policy exists.

## Related ADRs

ADR-0006, ADR-0004, ADR-0013, ADR-0024

## Last reviewed

2026-10-07 (GEO-002A)
