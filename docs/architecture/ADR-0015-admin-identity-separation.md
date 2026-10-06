# ADR-0015 — Admin identity is structurally separate; identity roles are not application permissions

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: INF-004

## Context

Administrative access must not be reachable by mixing roles into ordinary customer/provider accounts, and fine-grained business permissions change too often and are too business-specific for IdP roles.

## Decision

Admin sign-in uses its own Keycloak client (`bananagig-admin`) with a separate redirect host, shorter token and session lifetimes and its own browser flow with an OTP step (conditional in development, required in production builds). Admin capability is a client role on that client (`admin-console-access`), never a realm role, and admin tokens carry no customer/provider roles; the API distinguishes the context through `azp` (`authContext`). Realm roles are limited to the identity facts `customer` and `provider`. Detailed permissions (for example finance or trust administration) live in application data and are enforced by the API.

## Alternatives considered

- One client with admin as another realm role: a customer session assumptions and token lifetimes would apply to administrators.
- Separate realm for admins: stronger isolation but doubles identity operations; revisit if compliance demands it.
- Detailed business roles in Keycloak: slow to change and invisible to the application's audit trail.

## Consequences

Two token contexts to reason about. An admin app, invitations and detailed permissions are future work (AD-07). Production must build the realm with OTP enforced (`pnpm identity:build-prod`).

## Migration / compatibility

None; additive.

## Related files

- `infra/keycloak/bananagig-realm.json`
- `scripts/lib/realm.mjs`
- `apps/api/src/plugins/auth.ts`
- `docs/engineering/IDENTITY.md`
