# ADR-0003 — Valkey is a non-authoritative cache

Status: ACCEPTED
Date: 2026-10-05
Checkpoint: INF-001

## Context

A cache and rate-limit store is needed, but it must never become a hidden source of truth.

## Decision

Valkey (Redis protocol) holds only cache and temporary derived state. Keys follow `bg:<env>:<domain>:<key>`, every key has a TTL, and persistence is disabled. Bookings, balances, credits, subscriptions, reservations and tax state must never live there.

## Alternatives considered

- Redis: license changes make Valkey the safer open fork.
- No cache: simplest, but rate limiting and derived caching would need another home later.

## Consequences

Losing Valkey loses only performance, never data. Code must degrade when it is down (the API readiness check deliberately ignores it).

## Migration / compatibility

None.

## Related files

- `docs/engineering/CONTAINER_ARCHITECTURE.md`
- `packages/platform/src/checks.ts`
- `compose.yaml`
