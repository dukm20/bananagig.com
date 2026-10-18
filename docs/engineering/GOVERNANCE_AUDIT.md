# Governance audit (ENG-GOV-001, Phase A)

Baseline: commit `ac99156` (2026-10-18). Read-only: nothing was changed to produce these findings. Standard: [`PRODUCTION_STANDARD.md`](PRODUCTION_STANDARD.md). Plan: [`GOVERNANCE_REMEDIATION_PLAN.md`](GOVERNANCE_REMEDIATION_PLAN.md).

**Result: NOT READY for production. No P0 finding.** Severity: P0 = could lose money or data, or expose sensitive data in production; P1 = a serious reliability or security weakness, or a control a production release needs; P2 = hygiene.

How the evidence was gathered: the lead read the repository's governance surface (CLAUDE.md, scripts, CI, TypeScript and ESLint configuration, `.claude`, git hooks) and re-verified the headline claims below by direct command; two independent read-only agents scanned the code (shortcuts, reliability) and the security and supply chain (including unauthenticated GitHub reads). Items marked **(verified)** were re-checked by the lead by direct command or file read; the rest rest on an agent's reading of the cited file and are leads for review, not proof.

## What exists, and what does not

Does not exist in code or schema: Stripe or any payment provider, webhooks, ledger, refunds, payouts, bookings, capacity and availability, cancellation workflows, the BananaDrop domain (only the template flag `pricing_drop_eligible`). Their P0 gates (standard section 6) are therefore acceptance criteria for the checkpoints that build them, not defects of existing code.

Exists: identity, accounts, sessions and MFA, consent, catalogue, Gig templates, provider registration, verification and evidence, Gigs with variants, add-ons and photos, the outbox and worker, configuration and content registries.

## Temporary fixes and shortcuts

- Zero `TODO`, `FIXME` or `HACK` markers in tracked source **(verified)**; no skipped, `.only` or `.todo` tests except one conditional skip (`packages/content/src/content.itest.ts:1701`, real-Valkey test, **verified**).
- No `@ts-ignore`, `@ts-nocheck` or `as any` in production code; a handful of justified `eslint-disable` and `as unknown as` casts.
- Known shortcuts live in `docs/project/TECH_DEBT.md` (101 entries, none HIGH). They lack the standard's owner, approver and expiry fields. The de facto mitigations are now proposed in [`TEMPORARY_MITIGATIONS.md`](TEMPORARY_MITIGATIONS.md) (MIT-0001 to MIT-0006), all awaiting owner approval.

## Findings

IDs are referenced by the remediation plan.

### P1

| ID | Finding | Evidence | Documented |
|---|---|---|---|
| A-01 | `main` is unprotected: no ruleset, no required checks or reviews, no CODEOWNERS, no pull request ever, unsigned commits. The repository is **public**, no SECURITY.md, no LICENSE. CI only checks after the push. | Live unauthenticated GET: `protected:false`, `rulesets: []` **(verified)**; `/pulls?state=all` empty; CODEOWNERS 404 | DEBT-0001 (understated) |
| A-02 | No repository agent safeguards: no `.claude/` directory, no hooks, no deny rules, no git hooks. The user-level settings hold 160 accumulated allow rules from other projects, no deny and no ask rules. The "never edit an applied migration" rule is enforced only after the fact in CI. | `ls .claude` fails; `.git/hooks` has samples only **(verified)** | none |
| A-03 | No secret scanning in CI or in any hook. The only scanner is a regex inside `scripts/commit-checkpoint.mjs`, used only by that script, with a bypass (`SAFE_VALUE` accepts any match containing "test", "dummy", "example"...). History (88 commits) is clean. | `ci.yml`; `scripts/commit-checkpoint.mjs:55-95` | none |
| A-04 | Production configuration accepts unsafe values: `ROLE_REQUIRED` omits Valkey, S3, SMTP and NATS for the API and Valkey and S3 for the worker (an empty Valkey URL connects to localhost); the S3 bucket defaults to the development bucket; `http://` public URLs are accepted and make cookies non-Secure; the development database password and S3 keys are not refused; `DB_STATEMENT_TIMEOUT_MS=0` is allowed. | `packages/config/src/index.ts` (`ROLE_REQUIRED`) **(verified)** | partly DEBT-0016 |
| A-05 | The production code path is never exercised: `NODE_ENV` defaults to `development`, compose's `env_file` overrides the image's `production`, so every production refusal (fake adapters, development secrets, trusted proxy hops) is covered by unit tests only, never by booting the images. | `packages/config/src/index.ts:12`; compose/CI | partly DEBT-0004 |
| A-06 | `/internal/diagnostics` is registered unconditionally, unauthenticated, with side effects (S3 write and delete, a real SMTP send with TLS verification disabled, database version); protected only by a Caddy 404 rule. `/metrics` is reachable through the proxy. | `apps/api/src/app.ts:256` **(verified)**; `infra/caddy/Caddyfile` | DEBT-0004 (without the side effects) |
| A-07 | Missing timeouts and lifecycle control: the web to API `fetch` has no timeout **(verified)**; S3 clients and an OpenSearch fetch have none; Fastify has no request or connection timeout; no `unhandledRejection` or `uncaughtException` handler; no overall shutdown deadline; the advisory-lock release path returns a possibly locked connection to the pool. | `apps/web/src/lib/api-client.ts`; `packages/platform/src/clients.ts`; `apps/api/src/index.ts`; `packages/database/src/index.ts` | DEBT-0006 (web drain only) |
| A-08 | No migration deployment path (migrations run from the host only) and API readiness is `SELECT 1`: an image can report ready against an unmigrated or newer database. | `apps/api/src/index.ts`; compose; Dockerfile | partly DEBT-0014 |
| A-09 | No operational alerting: no HTTP, outbox-backlog or job-failure metrics, no Prometheus rules; the worker stays ready when the relay stalls. | `packages/observability/src/index.ts`; `infra/prometheus/prometheus.yml` | partly DEBT-0075 |
| A-10 | Rate limiting covers only email, phone and password reset. Valkey holds sessions and counters together under LRU eviction (inference, not tested). | `apps/api/src/index.ts` limiter wiring; `compose.yaml` | DEBT-0030 (understates) |
| A-11 | Security headers are minimal: only `frame-ancestors` and `X-Frame-Options`; no HSTS, nosniff, Permissions-Policy or full CSP; a sanitised-HTML renderer has no CSP behind it. | `apps/web/next.config.ts` | comment only |
| A-12 | Supply-chain gaps: no Dependabot, dependency-review, SAST, SBOM or licence check; Trivy covers 3 of about 19 images; images pinned by tag not digest; workflow without `permissions:`, timeouts or concurrency, actions pinned by tag; one high advisory in dev tooling unblocked. | `.github/workflows/ci.yml` **(verified)** | DEBT-0005, DEBT-0007, DEBT-0008 |
| A-13 | The runtime database user is a Postgres superuser; Valkey and NATS have no authentication; refresh tokens are stored in Valkey as plaintext JSON. | `.env.example`; `compose.yaml`; `apps/web/src/lib/auth/types.ts` | DEBT-0012, DEBT-0004 |

### P2

| ID | Finding |
|---|---|
| A-14 | Outbox: poison events retry forever (no dead letter, no maximum attempts); the JetStream duplicate window (120 s) is shorter than the backoff cap (300 s); the purge error is swallowed; `NatsClient.connection()` can open two connections on first use. |
| A-15 | Test and lint governance: no coverage thresholds; ESLint is not type-aware, so `no-floating-promises` is not enforced **(verified)**; every workspace test script uses `--passWithNoTests`; one conditional test skip; two stale `it.fails` comments (the defects are fixed); a stale agent-coordination comment in `gig-service.ts`. |
| A-16 | Fail-closed behaviour depends on a configuration value: with `require_clean_scan=false` unscanned documents and photos are accepted; there is no code-level floor in production. |
| A-17 | Log redaction works by key name only (no `email`, `phone`, `ip`, `subject`); the generic error log is unfiltered. No leak was found. |
| A-18 | Container hygiene: hardening (`read_only`, `cap_drop`, `no-new-privileges`) only on the app images; `env_file: .env` gives the API and worker every secret of `.env`; no `HEALTHCHECK` in the Dockerfile; no resource limits. |
| A-19 | Policy defaults (`DEFAULT_GIG_*_POLICY`) duplicate the seeded values and can drift; used by test providers only. |
| A-20 | CI hardening details (permissions, SHA pins, timeouts) are covered by A-12 and are being addressed in this checkpoint. |

## Gap matrix against the standard

| Control | State | Evidence |
|---|---|---|
| Lint, format | Present | `ci.yml`; ESLint recommended only |
| Strict typecheck | Present | `strict`, `noUncheckedIndexedAccess` |
| Unit and integration tests | Present | `pnpm test`, `pnpm test:integration`; no coverage threshold |
| End-to-end | Partial | `pnpm smoke` against the real stack; no browser tests |
| Production build | Present | `pnpm build`, image builds |
| Dependency scan | Partial | `pnpm audit --prod` blocking |
| Secret scan | **Absent** (advisory CI job added by ENG-GOV-001) | A-03 |
| SAST | **Absent** (advisory CodeQL added) | A-12 |
| Container scan | Partial | Trivy on web, api and worker |
| Migration validation | Partial | immutability and checksums; no compatibility test |
| API contract | Partial | drift, lint and validation; no breaking-change diff |
| Protected branch, required reviews, environment approvals | **Absent** | A-01 |
| CODEOWNERS | File added by ENG-GOV-001; **inert** until a ruleset requires code-owner review | A-01 |
| Claude permissions and hooks | Added by ENG-GOV-001; local guardrails only | A-02 |
| Temporary-mitigation register | Created; entries await approval | `TEMPORARY_MITIGATIONS.md` |

## Checked and found sound

No secret or key in tracked files or history; every API route guarded or deliberately public; strict token verification; Origin checks on every web POST and PKCE with state and nonce; no CORS exposure; trusted-proxy hops are exact; the error envelope leaks no internals; frozen lockfile in CI and Docker; migrations are checksum-guarded, forward-only and justified when destructive; every domain event goes through the transactional outbox; the rate limiter fails closed; two-phase delivery for email and SMS; configuration-driven policies have no code default and fail closed; app containers run non-root with a read-only root filesystem.

## Could not verify

- GitHub: whether secret scanning, push protection and Dependabot alerts are enabled, the default `GITHUB_TOKEN` permission and the branch-protection details (`gh` is not installed and there is no token; unauthenticated reads returned 401).
- Live response headers of the running stack, and the production realm or any production environment.
- pnpm 12.9.1 built-in defaults for release-age and trust policies.
- Fastify and pg-boss library defaults (from library knowledge, not run).
- Valkey eviction behaviour under a flood (inference).
- Per-route authorization of the 26 public operations beyond the OpenAPI declarations.

## Validation of the Checkpoint B safeguards (independent red-team, 2026-10-18)

An independent read-only agent attacked the safeguards in isolated copies (hostile hook inputs, negative fixtures for each gate; no credentials, no dev database, no push). Statement of what is **demonstrated**, honestly:

| Safeguard | Demonstrated | Not demonstrated or limited |
|---|---|---|
| Hooks stop accidental destructive commands, applied-migration edits, `.env` writes, secrets in written content, disabled tests via Write/Edit | The straightforward cases (several hundred probes, plus live headless runs) | Not a defence against a determined actor: the red-team found bypasses (heredoc `$(...)`, pipe into a shell, git option abbreviations such as `git reset --har`, ANSI-C quoting, brace expansion, `cp` into the migrations directory, case-insensitive paths on macOS, split secrets). These were reported to the hook owner for repair in this checkpoint; the remaining out-of-scope limits are listed in `.claude/hooks/README.md` |
| `Read`/`Edit` permission denies for `.env` and `.env.host` | Work at any depth, case-insensitively | |
| `pnpm governance:scan` fails on skipped tests, unregistered markers, `@ts-ignore`, unpinned actions, workflows without `permissions:`, incomplete or expired register entries, ratchet growth | The claimed rule shapes (exit 1 on each negative fixture, exit 0 on the clean control) | Evasions of R1/R4 and the self-editable register and allowlist (repaired in this checkpoint where detectable; the rest depends on review/CODEOWNERS) |
| `pnpm secrets:scan` (pinned gitleaks) | Fails on committed fake secrets, including after the file is removed (history is scanned); passes when the history is clean | A pull request can allowlist its own secret in `.gitleaks.toml` unless CI reads the base branch's config (repaired in `governance.yml`) |
| `specs:check` blocks a changed contract | Yes, and it is already blocking in `ci.yml` | |
| Applied-migration immutability | Fails with a base ref | **Silent in CI when the base ref is empty** (first push or force push to `main`): `data-model:check` then compares HEAD to HEAD. The database checksum guard needs a database and was not run |
| "CI blocks a controlled test skip, an exposed test secret and an unapproved bypass" (Master Prompt, Phase D) | **Not true today.** The gates fail correctly when run, but `ci.yml`'s blocking `verify` job runs neither `governance:scan` nor `secrets:scan`, every `governance.yml` job and `codeql.yml` are `continue-on-error`, and no ruleset requires any check | Becomes true only when the owner makes them required (plan items C-1 and C-2) |

Overall status of Checkpoint B: **NOT READY as an enforced control set.** The tooling is real and tested; nothing new is enforced by GitHub yet.

