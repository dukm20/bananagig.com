# ADR-0006 — Fastify modular API with OpenAPI generated from code

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: INF-002

## Context

A production-capable TypeScript API was needed. NestJS was the preferred option, but images are built as esbuild single-file bundles.

## Decision

Use Fastify 5 with one folder per domain module (`routes.ts` for HTTP, `service.ts` for logic). Route schemas are built from `@bananagig/contracts` zod types, and `docs/api/openapi.yaml` (OpenAPI 3.1) is generated from the real routes and drift-checked in CI. Product routes live under `/api/v1`.

## Alternatives considered

- NestJS: its DI needs `emitDecoratorMetadata`, which esbuild does not emit; adopting it means a different compiler and heavier builds.
- Hand-written OpenAPI: drifts from the code.

## Consequences

Structure comes from convention (documented, lint-enforced boundaries) rather than a framework. Revisit if a concrete need for Nest's DI appears.

## Migration / compatibility

None; no product API existed.

## Related files

- `docs/engineering/APPLICATION_ARCHITECTURE.md`
- `docs/engineering/API_CONVENTIONS.md`
- `apps/api/src/app.ts`
- `scripts/generate-specs.mjs`
- `docs/api/openapi.yaml`
