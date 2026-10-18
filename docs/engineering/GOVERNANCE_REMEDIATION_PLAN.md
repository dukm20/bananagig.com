# Governance remediation plan

Prioritized from the audit ([`GOVERNANCE_AUDIT.md`](GOVERNANCE_AUDIT.md)). Standard: [`PRODUCTION_STANDARD.md`](PRODUCTION_STANDARD.md). Each item is an increment with its own approval; nothing here changes production behaviour until its checkpoint is approved. "Owner" means a decision or action only the repository owner can take (credentials, GitHub settings, visibility, approvals).

Status key: **DONE** (in ENG-GOV-001, verified there), **OWNER** (needs the owner), **PLANNED** (code or configuration change, needs approval to start).

## Checkpoint B: ENG-GOV-001 (this checkpoint, advisory mode)

| ID | Item | Findings | State |
|---|---|---|---|
| B-1 | Constitution, production standard, review checklist, mitigation register, audit and this plan | A-02, A-15 | DONE |
| B-2 | Repository Claude Code settings and tested hooks (destructive commands, protected paths, secrets, disabled tests, verification evidence) | A-02 | DONE (local guardrail only; see the hook README for limits) |
| B-3 | Advisory CI: secret scan, policy scan, CodeQL, dependency review, workflow lint, Dependabot; workflow `permissions`, SHA-pinned actions, timeouts | A-03, A-12 | DONE (advisory; flip to required in C-2) |
| B-4 | CODEOWNERS file | A-01 | DONE (inert until C-1) |
| B-5 | Manual GitHub setup instructions | A-01 | DONE, see [`GITHUB_SETTINGS.md`](GITHUB_SETTINGS.md); applying them is OWNER |

## Checkpoint C: enforcement (needs the owner)

| ID | Item | Findings | State |
|---|---|---|---|
| C-1 | Apply the `main` ruleset (pull request, 1 approval, required checks `verify` and `compose-smoke`, code-owner review, no force push, linear history, optionally signed commits) and adopt a pull-request workflow for checkpoints | A-01 | OWNER (needs GitHub access) |
| C-2 | Enable secret scanning, push protection and Dependabot alerts; **add `pnpm governance:scan` and the gitleaks scan to the blocking `verify` job or require the `governance.yml` jobs in the ruleset** (today nothing blocks on them); run the PR secret scan with the base branch's `.gitleaks.toml`; add `trivy fs` secret and misconfiguration scanning; run the scan in `--strict` mode once the allowlist entries have a real reviewer | A-03, A-12 | OWNER then PLANNED |
| C-3 | Negative-fixture proof that the gates fail on a skipped test, a changed contract, a fake secret, an unpinned action and an applied-migration edit | A-02, A-03 | DONE for the local commands (red-team, 2026-10-18); repeat on GitHub once the checks are required |
| C-7 | `data-model:check` in `ci.yml` is silent when the base ref is empty (first push or force push to `main`: the immutability check compares HEAD to HEAD): derive the base from the merge-base with the default branch, or fail loudly when it cannot be determined | A-01 | PLANNED |
| C-8 | Make the allowlist and the register tamper-evident: CODEOWNERS review is the only control against a diff that edits the scanner's allowlist, ratchet or register together with the change they excuse | A-02 | OWNER (needs C-1) |
| C-4 | Decide repository visibility (public today), add SECURITY.md and a licence decision | A-01 | OWNER |
| C-5 | Review and prune the user-level Claude permissions (160 allow rules from other projects) | A-02 | OWNER (outside the repository) |
| C-6 | Approve, change or remove MIT-0001 to MIT-0006 | register | OWNER |

## Hardening checkpoints (production code; each needs approval)

| ID | Priority | Item | Findings | Proposed checkpoint |
|---|---|---|---|---|
| R-04 | P1 | Production configuration validation: require Valkey, S3, SMTP and NATS where used; refuse development values (`dev_only`), non-https public URLs, the development bucket and `.localhost` mail sender; reject `DB_STATEMENT_TIMEOUT_MS=0`; constructor guards on every fake adapter | A-04, A-05 | ENG-GOV-002 |
| R-05 | P1 | A CI job that boots the built images with `NODE_ENV=production` and production-shaped environment using the disabled adapters, with a reduced smoke | A-05 | ENG-GOV-002 |
| R-06 | P1 | Register `/internal/diagnostics` only outside production (or require an internal credential), remove the SMTP send and the disabled TLS verification from the production path, block or move `/metrics` | A-06 | ENG-GOV-002 |
| R-07 | P1 | Timeouts and lifecycle: web to API fetch, S3 and OpenSearch timeouts, Fastify request and connection timeouts and body limit, `unhandledRejection` handlers, shutdown deadline, advisory-lock release | A-07 | ENG-GOV-003 |
| R-08 | P1 | Migration job and a readiness check that the applied schema version is at least the build's | A-08 | ENG-GOV-003 or the first deployment checkpoint |
| R-09 | P1 | Metrics (HTTP, outbox backlog and age, job failures), worker readiness that reflects the relay, Prometheus alert rules | A-09 | ENG-GOV-004 |
| R-10 | P1 | Migrator and DML-only runtime database roles; revoke UPDATE and DELETE on audit tables for the runtime role | A-13 | before any production data (deployment checkpoint) |
| R-11 | P1 | Rate-limit policy per route class (DEBT-0030); separate Valkey (or no eviction) for sessions and counters | A-10 | own checkpoint |
| R-12 | P1 | Baseline security headers with tests (CSP, HSTS, nosniff, Referrer-Policy, Permissions-Policy) | A-11 | ENG-GOV-004 |
| R-13 | P1/P2 | Digest-pinned images, Trivy on every image, SBOM, licence check, resolve the dev-tooling advisory, harden third-party containers, minimise `env_file` | A-12, A-18 | ENG-GOV-004 |
| R-14 | P2 | Adopt type-aware promise rules, coverage reporting then thresholds, stop using `--passWithNoTests` (ratchet baseline of 18 in the scan allowlist), review the conditional skip. **Measured 2026-10-18** (throwaway config, 457 files): `no-floating-promises` 0 violations; `no-misused-promises` 2 (`apps/web/src/app/provider/gigs/page.tsx:34`, `packages/platform/src/health-server.ts:16`); `@vitest/coverage-v8` is not installed, so no coverage figures exist yet | A-15 | ENG-GOV-002 |
| R-15 | P2 | Outbox dead-letter and maximum attempts, dedup window above the backoff cap, ordering, idempotency table (DEBT-0013) | A-14 | before payments or webhooks |
| R-16 | P0 gates | When payments, BananaDrops and booking are built, their acceptance tests (standard section 6) are part of those checkpoints' definition of ready | domains not built | each domain checkpoint |
| R-17 | P2 | Log redaction by value and for `email`, `phone`, `ip`, `subject`; encrypt refresh tokens at rest; code-level floor for `require_clean_scan`; remove stale comments and duplicated policy defaults | A-16 to A-19 | ENG-GOV-004 |

Order of attack: C-1, C-2 and C-6 are owner actions and unlock the independent enforcement; then R-04, R-05, R-06 (the production configuration and the one unauthenticated side-effecting route), R-07, R-08; then R-09 to R-13; R-16 applies from the first money, BananaDrop or booking checkpoint.

## Review cadence

Repeat the audit at each milestone (standard checkpoint E). Aged mitigations are reviewed monthly (first review 2026-11-18). Update this plan and `GOVERNANCE_AUDIT.md` in the checkpoint that changes the state of an item.
