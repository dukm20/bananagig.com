# ADR-0007 — Single-file bundles for services, standalone output for web

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: INF-001

## Context

Runtime images should be small, secret-free and fast to build.

## Decision

api, worker and smoke are bundled by esbuild into one `index.js` and run on `node:alpine` with no `node_modules`. web uses Next.js `standalone` output. npm, corepack and yarn are removed from runtime images. All run as non-root with a read-only root filesystem.

## Alternatives considered

- Ship `node_modules`: larger images and more scanned surface.
- Distroless Node: no shell for healthchecks.

## Consequences

Bundled dependencies are invisible to image scans, so a lockfile audit is mandatory (LRN-0008). Decorator-metadata frameworks are out (ADR-0006). Local development does not use these images (`pnpm dev`).

## Migration / compatibility

None.

## Related files

- `Dockerfile`
- `scripts/bundle.mjs`
- `docs/security/SCAN_RESULTS.md`
- `apps/web/next.config.ts`
