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

`code` is a stable machine-readable string. Generic codes: `ROUTE_NOT_FOUND`, `VALIDATION_FAILED`, `BAD_REQUEST`, `RATE_LIMITED`, `INTERNAL_ERROR`, and the two router-level codes `PATH_PARAMETER_TOO_LONG` and `BAD_URL` (below). Business codes are added with their features: the content registry uses `CONTENT_<code>` (`CONTENT_ENTRY_NOT_FOUND`, `CONTENT_NO_CONTENT`, `CONTENT_VALIDATION_FAILED`, `CONTENT_TEMPLATE_ERROR`, `CONTENT_UNAVAILABLE`, and so on; the list is in `docs/engineering/CONTENT.md`) plus `CONTENT_RESPONSE_TOO_LARGE` (400, VALIDATION: `POST /api/v1/content/resolve-many` would serve more than 500000 characters of template source; applies to all callers and is checked before rendering). The geography registry uses `GEOGRAPHY_<code>` (`GEOGRAPHY_COUNTRY_NOT_FOUND`, `GEOGRAPHY_MARKET_NOT_FOUND`, `GEOGRAPHY_VALIDATION_FAILED`, `GEOGRAPHY_INVALID_STATE`, `GEOGRAPHY_NOT_READY` (409), `GEOGRAPHY_UNAVAILABLE`, and so on; the list is in `docs/engineering/GEOGRAPHY.md`); its `details` carry identifiers, field names and machine-readable reasons only (constraint names and driver causes are stripped). Note that `RATE_LIMITED` is defined but no rate limiting exists in the API yet.

### Integer path and query parameters

An integer that arrives as text (a path parameter such as `:version`, or a query value) is canonical base-10 text or it is rejected: digits only, no sign, no leading zeros (`0` alone is fine), no whitespace, decimal point, exponent, radix prefix (`0x`), separators, `Infinity` or `NaN`, at most 15 digits. Fastify's Ajv runs with type coercion on, which would read `1e3` as 1000, `1.0`, `+1` and `01` as 1 and `0x10` as 16, so the text is checked lexically BEFORE conversion by the one shared parser `parseDecimalInteger` (`packages/contracts/src/integer.ts`), in a `preValidation` hook `strictIntegerParams` (`apps/api/src/plugins/strict-params.ts`) listed after the authorization hook (401 and 403 still win) and before the body check. A rejection is the standard `VALIDATION_FAILED` envelope with `details.issues[].path` `params.<name>` (or `querystring.<name>`) and a fixed message that never contains the rejected text. The route schema documents the same bounds with `integerParamSchema`. `enforceStrictIntegerParams` (an `onRoute` guard registered first in `buildApp`) fails closed: it refuses to register a route whose `params` or `querystring` schema has a numeric property not covered by the hook, declares a numeric type outside `properties` (`allOf`, `oneOf`, `anyOf`, `additionalProperties`, `patternProperties`, `if`), or uses any `$ref`, because none of those can be tied to a hook by name. The hook must be a direct entry of the route's own `preValidation` list (a plugin-level or wrapped hook is not recognized). Scope: path and query text only; integer and boolean values in request BODIES are still coerced by Ajv on the configuration and content routes (DEBT-0043), and the geography routes validate the raw body with `strictBody`.

### Router-level failures and path parameters

Path parameters are limited to 192 characters by the router (`maxParamLength` in `apps/api/src/app.ts`; content keys are at most 160 characters, so every valid key fits). Failures raised by the router before any hook runs (a path parameter over the limit, a malformed URL component) use the standard error envelope and carry the correlation id: 400 `PATH_PARAMETER_TOO_LONG` or `BAD_URL`, category VALIDATION. (Fastify's own non-standard body with status 414 or 400 is no longer returned; `frameworkErrors` in `apps/api/src/plugins/errors.ts` handles it.) Throw `AppError(category, code, message, details?)` from services. Unexpected exceptions become `INTERNAL_ERROR` with a generic message; **stack traces and internal messages are logged, never returned**.

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
- Public routes that show more to privileged callers (content resolve, the geography reads) use `optionalAuthenticated()` in `preValidation`: no Authorization header is anonymous, a presented token must be valid (401 otherwise), and a valid token without the registry's read role is still anonymous; the route, not the guard, decides what the privileged view adds. The hook sets `Vary: Authorization` before anything can answer, so every response of such a route (success, 401, 404) carries it: the body differs between anonymous and privileged callers and a shared cache must key on the credential. For geography, `geography-write` implies `geography-read` (`hasGeographyPermission`), so a write-only administrator gets the management view the mutation responses already show.
- Fastify's ajv step coerces types by default (it stays on for query strings), so `{"active":1}` would silently become `true`. Management bodies that must be exactly the contract are validated first with the strict zod schema in a `preValidation` hook listed after the authorization guard (`strictBody` in the geography routes): 401 and 403 still win over 400, and a wrongly typed body is a 400. Free text typed by administrators (names, reasons) goes through the contracts `adminText` rule, which rejects control, bidirectional-override and unpaired surrogate characters and blank text.
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
