# Technical Debt

Every knowingly postponed item is recorded here, not buried in completion reports. IDs are permanent. Statuses: OPEN, IN_PROGRESS, ACCEPTED (a conscious, documented risk), RESOLVED (keep the entry).

## DEBT-0001 — CI workflow never executed

Status: OPEN
Severity: MEDIUM
Introduced by: INF-001
Owner/domain: infrastructure
Description: `.github/workflows/ci.yml` (verify, integration, compose-smoke, Trivy, governance) is written but has never run. A remote `origin` (github.com/dukm20/bananagig.com) was configured in `.git/config` outside the checkpoints (not by the checkpoint tooling), but nothing has been pushed, so no run exists. Everything the workflow runs was verified locally.
Why deferred: pushing is a separate explicit human decision; checkpoint tooling never pushes.
Exit criteria: a remote exists, the first push is made by the owner, the workflow runs green on a PR, and branch protection requires it.
Target checkpoint: first checkpoint after a remote is configured

## DEBT-0002 — Transactional outbox not implemented

Status: OPEN
Severity: MEDIUM
Introduced by: INF-002
Owner/domain: worker / database
Description: The guardrails require a transactional outbox, but there is no outbox table and no relay loop. Only the `OutboxRelay` and `EventPublisher` ports and `NatsEventPublisher` exist.
Why deferred: no product event exists to publish; a table without a producer would be speculative schema.
Exit criteria: first event-producing feature adds the outbox table (migration + data-model gate), a relay using `FOR UPDATE SKIP LOCKED`, idempotent consumers, and an ADR.
Target checkpoint: the first checkpoint that emits a domain event

## DEBT-0003 — PWA is manifest-only

Status: OPEN
Severity: LOW
Introduced by: INF-002
Owner/domain: web
Description: The web app has a manifest but no icons and no service worker, so it is not installable and has no offline behavior.
Why deferred: no product screens to cache; icons need brand assets.
Exit criteria: brand icons, service worker strategy decided (ADR), installability verified.
Target checkpoint: first customer-facing web checkpoint

## DEBT-0004 — Development-only security posture of local stack

Status: ACCEPTED
Severity: MEDIUM
Introduced by: INF-001
Owner/domain: infrastructure
Description: Keycloak runs `start-dev`, OpenSearch has its security plugin disabled, Caddy serves plain HTTP, and development credentials are in `.env.example`. `/internal/diagnostics` has no authentication (it relies on not being routed by Caddy).
Why deferred: local development convenience; production deployment is out of scope so far.
Exit criteria: a production deployment design with TLS, real secrets management, Keycloak `start`, OpenSearch security, and authenticated or removed diagnostics.
Target checkpoint: production deployment checkpoint

## DEBT-0005 — Images pinned by tag, not digest

Status: OPEN
Severity: LOW
Introduced by: INF-001
Owner/domain: infrastructure
Description: Compose and the Dockerfile pin explicit tags (for example `valkey/valkey:8.1-alpine`, `node:24-alpine`) but not content digests, so a tag could change underneath a build.
Why deferred: digests need a refresh process (Renovate/Dependabot) that is not set up.
Exit criteria: digests pinned with automated update PRs.
Target checkpoint: first checkpoint after CI runs (DEBT-0001)

## DEBT-0006 — Web container does not drain on SIGTERM

Status: OPEN
Severity: LOW
Introduced by: INF-002
Owner/domain: web
Description: The Next.js standalone server exits with code 143 on SIGTERM instead of draining in-flight requests. api and worker shut down gracefully.
Why deferred: the web tier is stateless and Compose restarts are fast; Next has no supported drain hook.
Exit criteria: a small wrapper/custom server that stops accepting and drains, or an upstream hook.
Target checkpoint: production deployment checkpoint

## DEBT-0007 — Accepted advisories in dev-only tooling

Status: ACCEPTED
Severity: LOW
Introduced by: INF-002
Owner/domain: infrastructure
Description: `pnpm audit` still reports braces (high, no patch), ajv, sprintf-js and @babel/core through the AsyncAPI CLI toolchain. Dev/CI only; never in an image. See `docs/security/SCAN_RESULTS.md`.
Why deferred: no fixed versions are available upstream.
Exit criteria: re-audit at each dependency refresh; replace the AsyncAPI CLI with `@asyncapi/parser` if findings persist.
Target checkpoint: INF-003

## DEBT-0008 — AGPL licensing review for Grafana, Loki, Tempo

Status: OPEN
Severity: LOW
Introduced by: INF-001
Owner/domain: infrastructure
Description: Grafana, Loki and Tempo are AGPL-3.0. Fine as unmodified internal tools, but a hosted offering needs a licensing review.
Why deferred: no hosted offering yet.
Exit criteria: documented legal sign-off or replacement of the Grafana stack components.
Target checkpoint: production deployment checkpoint

## DEBT-0009 — otel-collector and flagd have no Compose healthcheck

Status: ACCEPTED
Severity: LOW
Introduced by: INF-001
Owner/domain: infrastructure
Description: Both images are distroless (no shell), so no container healthcheck exists; the smoke test verifies them by connectivity instead.
Why deferred: no supported shell-free healthcheck.
Exit criteria: upstream health binaries, or a sidecar/healthcheck wrapper image.
Target checkpoint: production deployment checkpoint

## DEBT-0010 — INF-001 bootstrap verified from a copied tree, not a fresh git clone

Status: OPEN
Severity: LOW
Introduced by: INF-002
Owner/domain: infrastructure
Description: The clean bootstrap was proven by copying `git ls-files -co --exclude-standard` into an empty directory and running install, checks, build, stack start, migrate and smoke. A real `git clone` could not be tested because no commit exists.
Why deferred: the baseline commit awaits the user's approval.
Exit criteria: after the baseline commit, repeat the sequence from `git clone`.
Target checkpoint: INF-003

## DEBT-0011 — Web telemetry not verified end to end

Status: OPEN
Severity: LOW
Introduced by: INF-002
Owner/domain: web / observability
Description: `instrumentation.ts` registers the OpenTelemetry SDK and the web logger exists, but page-request traces (Tempo) and web logs (Loki) were not asserted by the smoke test.
Why deferred: only API and worker telemetry were required for the checkpoint.
Exit criteria: smoke test finds a web trace in Tempo and a web log line in Loki.
Target checkpoint: first customer-facing web checkpoint
