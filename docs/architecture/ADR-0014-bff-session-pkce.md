# ADR-0014 — Browser authentication: Authorization Code + PKCE with a server-side session

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: INF-004

## Context

Single-page apps that keep access tokens in browser storage expose them to XSS. The web app is server-rendered and has a back end (Next.js) that can hold secrets and tokens.

## Decision

The web app is a confidential-style back end for a public Keycloak client: Authorization Code with PKCE S256 only (no implicit flow, no password grant, no client secret), state and nonce validated, single-use login transactions bound to the browser by an HttpOnly cookie. Tokens are held server-side in Valkey; the browser receives only an opaque HttpOnly SameSite=Lax session cookie (`__Host-` and Secure on https). The web back end calls the API with the session's bearer token. Logout is POST-only with an Origin check, and sessions are refreshed server-side.

## Alternatives considered

- Tokens in localStorage or JS-readable cookies: XSS-exposed.
- Encrypted cookie holding the tokens: size limits, tokens still travel to the browser.
- Confidential client with a secret: a secret adds nothing to PKCE for a public, server-side flow and must be managed.

## Consequences

The web app now needs Valkey (session records only; non-authoritative, ADR-0003) and the identity package. Interactive login needs the container stack because the issuer is pinned to the public URL (DEBT-0020). Valkey loss signs users out.

## Migration / compatibility

No sessions existed before.

## Related files

- `apps/web/src/lib/auth/handlers.ts`
- `apps/web/src/lib/auth/store.ts`
- `packages/identity/src/oidc.ts`
- `docs/engineering/IDENTITY.md`
