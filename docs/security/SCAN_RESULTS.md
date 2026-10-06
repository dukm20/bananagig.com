# Security Scan Results

Scans run during INF-002 on 2026-10-05 with Trivy 0.65.0 (vulnerability DB current at scan time) and `pnpm audit`. Reproduce with the commands at the end.

## Container images (built from this repo, `bananagig/<app>:dev`)

| Image | OS | HIGH/CRITICAL findings |
|---|---|---|
| bananagig/web | Alpine 3.24.2 | **0** |
| bananagig/api | Alpine 3.24.2 | **0** |
| bananagig/worker | Alpine 3.24.2 | **0** |

Baseline before INF-002 (INF-001 images, `node:24-alpine` with npm left in): HIGH findings in npm's own bundled dependencies, namely `ip-address` 10.2.0 (CVE-2026-69192, fix 10.3.1), `tar` 7.5.19 (CVE-2026-73566, fix 7.5.21), `undici` 6.27.0 (CVE-2026-19534, fix 6.28.1+), and an undici cache-disclosure advisory. Risk decision: **removed rather than ignored**. npm, corepack and yarn are not needed at runtime, so the runtime stage deletes them; no ignore entries exist.

Limits: api, worker and smoke ship as one bundled JavaScript file, so an image scan cannot see the npm packages inside the bundle. Those are covered by the dependency scan below.

## Dependencies (installed lockfile)

`pnpm audit --prod` (what ships): **1 low** advisory; nothing HIGH or CRITICAL. *(INF-002 record. That one low was the `@babel/core` advisory below; it was resolved in CI-001, after which `pnpm audit --prod` reports no vulnerabilities.)*

`pnpm audit` (including dev tooling), after remediation:

| Severity | Package | Advisory | Fix available | Reached via | Risk decision |
|---|---|---|---|---|---|
| high | braces <=3.0.3 | GHSA-vfj7-8cjw-p6xm | **No** | `@asyncapi/cli` > spectral-cli > fast-glob > micromatch | Dev-only (CI spec validation). Never in an image. Accepted; re-check at each dependency refresh |
| moderate | ajv <6.14.0 | GHSA-v88g-cgmw-v5xw, GHSA-2g4f-4pwh-qvx6 | Upstream pinned to old ajv | AsyncAPI CLI toolchain | Dev-only. Accepted |
| moderate | sprintf-js <=1.1.3 | GHSA-hp3w-g68c-fv3c | **No** | AsyncAPI CLI toolchain | Dev-only. Accepted |
| low | @babel/core <=7.29.0 | GHSA-4x5r-pxfx-6jf8 | Upstream pinned | AsyncAPI CLI toolchain | Dev-only. Accepted at INF-002. **RESOLVED in CI-001** (override, see below) |

Remediated in INF-002 with `pnpm-workspace.yaml` overrides and an upgrade (no suppressions):

- `simple-git` -> >=4.0.1 and `@simple-git/argv-parser` -> >=2.0.1 (critical and high advisories).
- `jsonpath-plus` -> >=10.3.0 (critical and high).
- `vitest` 3 -> 5.0.3 (cleared the critical `tinypool` advisories).

Review date for the accepted dev-tool findings: next dependency refresh, no later than the INF-003 checkpoint. The AsyncAPI CLI is the source of all accepted findings; if it keeps shipping unfixable advisories, replace it with `@asyncapi/parser` called directly.

A `trivy fs` scan of `pnpm-lock.yaml` reported 0 HIGH/CRITICAL (its advisory data differs from the npm audit feed, so both are listed).

Also: the INF-001 note that the Postgres Dockerfile runs as root (Trivy AVD-DS-0002) is a documented, commented exception (upstream gosu entrypoint).

## CI-001 (2026-10-05): @babel/core advisory resolved

| Field | Value |
|---|---|
| Advisory | GHSA-4x5r-pxfx-6jf8 (arbitrary file read via sourceMappingURL comment) |
| Affected package | `@babel/core` |
| Previous vulnerable range | <= 7.29.0 (installed: 7.12.9) |
| Fixed version | >= 7.29.6 (installed after fix: 7.29.7) |
| Severity | low |
| Resolution | `pnpm-workspace.yaml` override `"@asyncapi/generator-react-sdk>@babel/core": "^7.29.6"` |

**Why it was reported as a production finding.** `@asyncapi/generator-react-sdk@1.1.3` (dev tooling, reached through `@asyncapi/cli`) pins `@babel/core` to exactly `7.12.9`, and that was the only copy in the lockfile. `next` declares `@babel/core` as an optional peer of `styled-jsx`, and pnpm satisfied that peer with the same 7.12.9 copy, so `pnpm audit --prod` reported `apps/web > next > styled-jsx > @babel/core`. The web image never contained it (Trivy reported 0 HIGH/CRITICAL on all three images at INF-002, and again after this fix); the finding came from the lockfile graph, not the shipped code.

**Why this is not a "new" advisory.** It was already recorded above and in DEBT-0007 as an accepted dev-tooling finding at INF-002. What changed is that the CI workflow runs `pnpm audit --prod` as a gate (nonzero exit on any finding) and CI executed for the first time on 2026-10-06 (UTC) at commit 17b6b8d; run #1 failed at that step. The local exit code (1) had never been enforced before then.

**Why the override is safe.**
- Scoped to the one parent that pins the old version (`parent>child` selector) instead of a global `@babel/core` override. After install there is a single `@babel/core` (7.29.7), and pnpm re-resolved `styled-jsx`'s optional peer to it.
- The range is `^7.29.6`, not `>=7.29.6`. The open-ended range was tried first and resolved to `@babel/core` 8.0.6, a new major that violates the `^7` peer ranges of the Babel plugins (`pnpm peers check` reported unmet peers). `^7.29.6` leaves peers clean.
- Tested on both paths: `@asyncapi/generator-react-sdk` loads and transforms JSX with `@babel/preset-env` and `@babel/preset-react` on 7.29.7; `pnpm asyncapi:validate`, `pnpm specs:check`, `pnpm build` (Next.js) and the full unit, integration and smoke suites pass.

Result after the fix: `pnpm audit --prod` reports no vulnerabilities; `pnpm audit` (including dev tooling) reports 4 (braces high; ajv x2 and sprintf-js moderate), all still accepted under DEBT-0007. The audit threshold was not changed. Rebuilt web, api and worker images: 0 HIGH/CRITICAL.

## Reproduce

```bash
for i in web api worker; do
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock:ro -v trivy-cache:/root/.cache \
    aquasec/trivy:0.65.0 image --severity HIGH,CRITICAL bananagig/$i:dev
done
pnpm audit --prod
pnpm audit
docker run --rm -v "$PWD":/src:ro aquasec/trivy:0.65.0 fs --scanners vuln,misconfig,secret --severity HIGH,CRITICAL --skip-dirs node_modules /src
```
