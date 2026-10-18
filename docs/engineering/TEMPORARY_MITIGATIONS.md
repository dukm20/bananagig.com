# Temporary mitigations register

Rule (Production Engineering Standard, section 3; [`PRODUCTION_STANDARD.md`](PRODUCTION_STANDARD.md) section 4): **every approved temporary mitigation is recorded here, and an unregistered mitigation is rejected.** A mitigation stands in for a durable fix (a flag that hides a defect, a fail-closed stub, a proxy rule instead of authentication, a widened timeout). A feature that has simply not been built is a known limit in `docs/project/TECH_DEBT.md`, not a mitigation.

`pnpm governance:scan` checks this file: each entry has every required field, an ACTIVE entry is not past its expiry date, and a `MIT-nnnn` id mentioned in source or tests exists here.

## Fields and statuses

Every entry is a `## MIT-nnnn — title` heading followed by these lines, each starting with the field name and a colon:

`Status`, `Issue`, `Root cause`, `Customer risk`, `Owner`, `Approver`, `Introduced`, `Expiry/review date`, `Removal condition`, `Protection/flag`, `Tests`, `Monitoring`.

- **Status**: `PROPOSED` (recorded, not yet approved: it counts as unapproved), `ACTIVE` (approved by the named approver), `EXPIRED` (past its date and not renewed: remove it or renew with a new approval), `REMOVED` (the durable fix landed; keep the entry as history).
- **Approver**: a human. An agent never writes its own name here and never changes `PROPOSED` to `ACTIVE`. `PENDING` means the owner has not decided.
- **Expiry/review date**: `YYYY-MM-DD`. Aged mitigations are reviewed monthly.
- A production-incident exception needs the owner's explicit authorization, a register entry, and corrective work afterwards.

## Register

The entries below were found by the ENG-GOV-001 audit on 2026-10-18. They are existing behaviours of the repository that act as mitigations; all are **PROPOSED** and wait for the repository owner to approve, change or remove them. Approval is not implied by their existence.

## MIT-0001 — Operational diagnostics endpoint hidden by a proxy rule instead of authentication

Status: PROPOSED
Issue: `GET /internal/diagnostics` (API and worker) is registered unconditionally and unauthenticated; it writes and deletes an S3 object, sends a real SMTP message and reports the database version. The only protection is the Caddy rule that answers 404 for `/internal/*` on the API host.
Root cause: the diagnostics were built for the local stack, and an authenticated or environment-gated route was deferred (DEBT-0004). The route is also not gated by `NODE_ENV`.
Customer risk: if the API is ever reachable without that proxy rule, any caller triggers side effects on production dependencies and learns infrastructure details.
Owner: repository owner (to confirm)
Approver: PENDING (repository owner)
Introduced: 2026-10-05 (INF-002)
Expiry/review date: 2026-11-18
Removal condition: register the route only outside production, or require an internal credential, and remove the SMTP send and the disabled TLS verification from the production path (remediation plan item R-06).
Protection/flag: Caddy `@internal path /internal/*` returns 404 on `api.localhost`; no port of the API is published.
Tests: smoke asserts the route is not reachable through the proxy; no test asserts it is absent in production.
Monitoring: none.

## MIT-0002 — Development-grade identity and infrastructure posture of the local stack

Status: PROPOSED
Issue: Keycloak runs `start-dev`, OpenSearch runs with its security plugin disabled, the proxy has `auto_https off`, Valkey and NATS have no authentication, and the realm file contains development users, a direct-grant test client and development secrets.
Root cause: the platform so far runs only locally and in CI (DEBT-0004, DEBT-0016). There is no production realm provisioning or secret manager.
Customer risk: none while only local; unacceptable if this stack is exposed or promoted as it is.
Owner: repository owner (to confirm)
Approver: PENDING (repository owner)
Introduced: 2026-10-05 (INF-001, INF-004)
Expiry/review date: 2026-11-18
Removal condition: a production deployment checkpoint provisions a production realm (the repository already builds one with `pnpm identity:build-prod`), a secret manager, TLS, and authenticated Valkey and NATS, and production configuration validation refuses development values (remediation plan items R-04, R-05).
Protection/flag: `buildProductionRealm` strips development clients, users and secrets; the production configuration refuses fake adapters and two development secrets; no port except Caddy and Postgres is published, on 127.0.0.1.
Tests: `pnpm identity:check` lints the realm; configuration unit tests cover the production refusals.
Monitoring: none.

## MIT-0003 — Runtime database access uses the Postgres superuser

Status: PROPOSED
Issue: the API and worker connect as the bootstrap superuser, so triggers that make audit tables append-only can be disabled by the runtime role.
Root cause: separate migrator and runtime roles were designed but not created (DEBT-0012).
Customer risk: a flaw in application code could alter or delete audit history or bypass guards.
Owner: repository owner (to confirm)
Approver: PENDING (repository owner)
Introduced: 2026-10-05 (INF-003)
Expiry/review date: 2026-11-18
Removal condition: a migrator role and a DML-only runtime role, with UPDATE and DELETE revoked on audit tables, before any production data exists (remediation plan item R-10).
Protection/flag: guard triggers and CHECK constraints in every migration; the database is not published beyond 127.0.0.1.
Tests: model integration tests prove the guards hold for the roles the tests use; none runs as a least-privilege role.
Monitoring: none.

## MIT-0004 — Temporary administrator permission strategy

Status: PROPOSED
Issue: administrator permissions are Keycloak client roles on one admin client, and the registries' `owner_role` is metadata only.
Root cause: the permission model for staff is a later checkpoint (DEBT-0021, DEBT-0028).
Customer risk: coarse staff permissions; no separation beyond the named client roles.
Owner: repository owner (to confirm)
Approver: PENDING (repository owner)
Introduced: 2026-10-05 (CFG-001, CFG-002)
Expiry/review date: 2026-11-18
Removal condition: the administration checkpoint replaces the temporary strategies with the real role model and enforces owner roles.
Protection/flag: every admin route requires an admin-context token and a named permission; two-person approval on configuration and content changes.
Tests: API permission tests per route class.
Monitoring: audit rows on every change.

## MIT-0005 — Fail-closed disabled adapters in place of production scanners and providers

Status: PROPOSED
Issue: there is no production malware scanner, external verification provider, SMS provider or email provider. The production configuration selects disabled adapters that fail closed, so evidence documents and provider photos cannot be attached in production while `require_clean_scan` is true.
Root cause: vendors are not selected (DEBT-0049, DEBT-0059, DEBT-0087, DEBT-0099).
Customer risk: providers cannot upload documents or photos in production; if an administrator sets a `require_clean_scan` value to false, unscanned files are accepted (no code-level floor).
Owner: repository owner (to confirm)
Approver: PENDING (repository owner)
Introduced: 2026-10-17 (TRUST-001, CAT-004)
Expiry/review date: 2026-11-18
Removal condition: production adapters are implemented and the clean-scan requirement cannot be turned off in production configuration.
Protection/flag: configuration refuses fake adapters in production; `trust.verification.require_clean_scan` and `provider.gig.media.require_clean_scan` are true as seeded and changes need a second approver.
Tests: configuration, trust and media tests cover the disabled and ERROR paths.
Monitoring: none.

## MIT-0006 — Temporary web screens until the design-system retrofit

Status: PROPOSED
Issue: every screen built so far is a minimal functional placeholder (account area, provider registration, verification, Gig editor with variants, add-ons and photos).
Root cause: the product direction places the full design-system retrofit (UI-BASE-001) after the BananaDrop core (DEBT-0094, DEBT-0101, `docs/product/ROADMAP.md`).
Customer risk: usability and accessibility polish only; the screens are accessible by structure but have not had a screen-reader or visual review.
Owner: repository owner (to confirm)
Approver: PENDING (repository owner)
Introduced: 2026-10-16 (ACC-001 onward)
Expiry/review date: 2026-11-18
Removal condition: UI-BASE-001 retrofits every existing screen.
Protection/flag: none needed; the screens only expose owner-scoped data and contain no business logic in the client.
Tests: page and handler unit tests, structural accessibility checks.
Monitoring: none.
