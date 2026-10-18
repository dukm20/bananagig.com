# BananaGig Production Engineering Standard (repository form)

Owner: the repository owner (human). Established by checkpoint ENG-GOV-001 on 2026-10-18.
Sources: `BananaGig_Production_Engineering_Standard.docx` (v1.0, 18 October 2026) and `BananaGig_Claude_Code_Master_Prompt.md` in this folder. This file is their operational form for this repository; the audit that produced it is [`GOVERNANCE_AUDIT.md`](GOVERNANCE_AUDIT.md) and the plan that follows from it is [`GOVERNANCE_REMEDIATION_PLAN.md`](GOVERNANCE_REMEDIATION_PLAN.md).

**This document is a standard, not evidence.** It does not say that BananaGig passes it. The audit records where it does not, and no agent or person may claim a control exists (a hook, a CI gate, a GitHub setting, a deployment, a test result) until it has been verified in the actual repository or account.

## 1. Executive policy

No code is production-ready because Claude generated it or because a feature appears to work. A change is ready only when deterministic quality gates pass, the risk has been reviewed, the rollout and recovery are safe, and the evidence is recorded. The goal is failure prevention, containment and recovery, not a promise of zero crashes.

If production safety is not demonstrated, the status is **NOT READY**. A failed check is reported, never hidden, and a durable fix is never replaced by a temporary shortcut to finish a task.

## 2. Core safeguards and where they stand

| Safeguard | Standard | Mechanism in this repository | State (audit 2026-10-18) |
|---|---|---|---|
| Source of truth | Version-controlled requirements, decisions, contracts, tests | `docs/product/*`, `docs/architecture/ADR-*`, generated OpenAPI/AsyncAPI, `docs/data/*`, tests | In place |
| No permanent temporary fixes | Approval, ticket, owner, expiry, removal plan, flag | [`TEMPORARY_MITIGATIONS.md`](TEMPORARY_MITIGATIONS.md); `docs/project/TECH_DEBT.md` for known limits | Register created; entries await owner approval |
| Change isolation | Feature branch, minimal scope, reviewed diff, PR, protected `main` | Direct pushes to `main`; no PR has ever been opened | **Not in place** (needs a GitHub ruleset, see [`GITHUB_SETTINGS.md`](GITHUB_SETTINGS.md)) |
| Quality gates | Lint, format, strict typecheck, unit/integration/E2E, security, production build | `ci.yml` (blocking) plus `governance.yml` and CodeQL (advisory) | Partial |
| Runtime resilience | Bounded retries, timeouts, idempotency, transactions, recovery, observability | Outbox, advisory locks, DB timeouts, rate-limiter breaker | Partial; gaps in the remediation plan |
| Data safety | Expand/contract migrations, backups, concurrency controls, rollback/roll-forward | Forward-only checksum-guarded migrations, `pnpm db:backup-test` (not in CI) | Partial |
| Release control | Staging, approval, staged rollout, health checks, recovery rehearsal | None yet: there is no deployment | Not applicable until the first deployment checkpoint |

## 3. Risk classification

Classify every change before coding and record the class in the checkpoint report. Escalate one class when a change spans several services, changes a public API or database contract, or affects users who already have bookings.

| Class | Scope | Required |
|---|---|---|
| **P0 critical** | Money movement, webhooks, refunds, ledger; BananaDrop pricing, tiers and price protection; booking capacity and concurrency; **identity, authentication, authorization, sessions, consent, verification evidence, secrets and sensitive data** | Independent human review, dedicated failure tests (see section 6), a rollout and recovery plan |
| **P1 high** | Provider availability, dispatch and location, cancellation workflows, user notifications, **database migrations**, the outbox and worker, configuration and content publishing, media and object storage | Integration tests, a rollout plan |
| **P2 standard** | Visual styling, static content, isolated non-critical UX, documentation | Baseline checks and regression review |

Today the P0 code in the repository is the identity, account, session, consent, trust and provider-media code. The money, booking and BananaDrop code does not exist yet; its P0 gates (section 6) are acceptance criteria for the checkpoints that build it.

## 4. Temporary mitigations

A mitigation is anything that stands in for the durable fix: a feature flag that hides a defect, a fail-closed stub, a proxy rule instead of authentication, a retry instead of idempotency, a widened timeout. **Unregistered mitigations are rejected.**

- Register it in [`TEMPORARY_MITIGATIONS.md`](TEMPORARY_MITIGATIONS.md) with: ID, issue, root cause, customer risk, owner, approver, introduction date, expiry or review date, removal condition, protective flag or configuration, tests, monitoring, status.
- A source comment that marks temporary work carries the register ID (`MIT-nnnn`); a bare `TODO`, `FIXME` or `HACK` is a finding of `pnpm governance:scan`.
- Aged mitigations are reviewed monthly and an expired ACTIVE mitigation fails the scan.
- A production-incident exception needs explicit authorization by the owner and corrective work afterwards. An agent never grants its own exception.
- Known limits that are not mitigations (a feature not built yet) stay in `TECH_DEBT.md`.

## 5. Claude Code configuration model

| Layer | Purpose | Where |
|---|---|---|
| `CLAUDE.md` | Short mandatory rules and architecture; detailed playbooks live in `docs/engineering` and `skills/*` | repository root |
| Permissions | `deny`/`ask` rules for secrets and destructive commands | `.claude/settings.json` |
| PreToolUse hooks | Parse structured input and guard risky commands and protected paths | `.claude/hooks/` (tested by `scripts/claude-hooks.test.mjs`) |
| PostToolUse and Stop hooks | Record verification evidence and warn about unverified changes. **Advisory only** | `.claude/hooks/` |
| CI and GitHub rulesets | Enforce checks, review and branch protection **independently of Claude** | `.github/`, repository settings |
| Credentials | Production credentials and deploy rights are separate from the local coding agent's permissions and least-privilege | owner-managed |

Hooks are local guardrails: they can be bypassed by someone with local control, they snapshot at session start, and they are never release enforcement. CI and GitHub rulesets are the enforcement.

## 6. Minimum verification matrix

Every change: diff review, formatter, lint, typecheck, the relevant tests, a secrets scan, a production build. Record command, exit code and counts; separate **not run** from **passed**.

| Applies to | Required evidence |
|---|---|
| API / domain | Input validation; authentication and authorization; compatibility with the generated OpenAPI; negative and integration tests |
| Database | Forward migration; backward-compatibility window; backup and recovery check; concurrency checks; Data Model Review Gate (`CLAUDE.md`) |
| Payments (when built) | Duplicate and out-of-order webhooks; ledger reconciliation; retry and idempotency; refund tests |
| BananaDrops (when built) | Concurrent enrollment; tier-boundary behaviour; price floors; published tier-version snapshots; customer price protection; audit trail; replay and idempotency of tier transitions |
| Booking and capacity (when built) | No double booking under concurrency; cancellation and reschedule state machines; recovery after restart |
| Critical runtime | Dependency failure; timeout; worker restart; partial failure; queue saturation; structured alerts |
| Release | Staging smoke test; canary or gradual rollout; rollback or roll-forward plan; owner sign-off |

Commands of this repository (never placeholders): `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`, `pnpm deps:check`, `pnpm specs:check`, `pnpm openapi:lint`, `pnpm asyncapi:validate`, `pnpm data-model:check`, `pnpm skills:check`, `pnpm project-state:check`, `pnpm governance:scan`, `pnpm secrets:scan` (needs Docker), `pnpm smoke` (needs the stack), `pnpm checkpoint:finalize <ID>`.

## 7. Change workflow and definition of done

1. **Discover**: read `CLAUDE.md`, `PROJECT_STATE.md`, the relevant skills and ADRs; baseline `git status`; never assume a script or directory exists.
2. **Plan**: root cause or requirement, impacted contracts, risk class, test plan, rollout and recovery.
3. **Implement**: on a branch where the ruleset requires it, narrowly scoped and typed; never bypass a control.
4. **Verify**: repository-native commands; record command, exit code and counts.
5. **Review**: the diff, security and data impact, CI, the mitigation register.
6. **Release**: only after required checks and approval; staged; rollback ready.

Completion statuses (use exactly these):
- **BLOCKED**: cannot proceed without a decision or access.
- **NOT READY**: evidence is missing or a check failed.
- **READY FOR REVIEW**: local evidence is satisfactory; nothing merged.
- **RELEASE CANDIDATE**: CI, review and staging passed.
- **PRODUCTION VERIFIED**: rollout and post-release checks complete.

Every checkpoint report states: scope and baseline commit; findings with severity, evidence and root cause; files changed and why; commands run with results and the checks skipped; security, availability, data-integrity and compatibility impact; temporary mitigations with owner, expiry and approval status; deploy and rollback considerations; status; next actions.

## 8. Release control

Claude cannot approve its own high-risk release. Merging, deploying, rotating credentials, changing GitHub or production settings, deleting data and emergency exceptions are human decisions. An agent that is blocked on one of them reports BLOCKED and asks.

## 9. Adoption checkpoints

| Checkpoint | Content | State |
|---|---|---|
| A | Non-destructive audit | Done (2026-10-18), [`GOVERNANCE_AUDIT.md`](GOVERNANCE_AUDIT.md) |
| B | Constitution, review rubric, mitigation register; policy gates in advisory mode, tuned for false positives | ENG-GOV-001 (this checkpoint) |
| C | Enforce CI, branch protection, high-risk regression tests; prove gates fail on isolated negative fixtures | Planned, needs owner decisions, [`GOVERNANCE_REMEDIATION_PLAN.md`](GOVERNANCE_REMEDIATION_PLAN.md) |
| D | Hardening: fault injection, replay tests, staged rollout, monitoring, incident drills | Planned |
| E | Repeat the risk audit each milestone; revisit aged mitigations monthly | Standing |
