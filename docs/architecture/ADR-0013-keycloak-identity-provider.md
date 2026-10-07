# ADR-0013 — Keycloak is the identity provider and owns authentication only

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: INF-004

## Context

BananaGig needs standards-based login, MFA and token issuance without building credential storage. Business data about people (profiles, preferences, consents, permissions) must stay in the product database where it can be modelled, audited and queried.

## Decision

Keycloak (OIDC) owns authentication, credentials, protocol sessions, MFA factors and token issuance. The BananaGig database owns profiles, role-specific data, preferences, consents, business relationships and application permissions. The two are linked by the immutable Keycloak `sub`, stored later as an external identity reference (`identity.external_identities`, unique on provider + subject). Tokens carry only identity claims (sub, roles, audience); no profile data is duplicated into Keycloak or into tokens.

## Alternatives considered

- Build credentials and sessions in the application: security-critical code we would have to own and audit.
- Store full profiles in Keycloak attributes: couples business data to the IdP and makes it hard to query or change.
- Managed SaaS identity: lock-in (ADR-0005 prefers open source).

## Consequences

The IdP is swappable behind OIDC (issuer, audience and JWKS are configuration). Authentication outages affect authenticated routes only. No user table existed at INF-004; ID-001 added the application account model (`identity.accounts`, `identity.external_identities`, ADR-0025 and ADR-0026) without mirroring anything Keycloak owns.

## Migration / compatibility

Replaces the empty `bananagig-dev` placeholder realm with `bananagig`; local-only data, so nothing migrated.

## Related files

- `infra/keycloak/bananagig-realm.json`
- `docs/engineering/IDENTITY.md`
- `packages/identity/src/verifier.ts`
- `compose.yaml`
