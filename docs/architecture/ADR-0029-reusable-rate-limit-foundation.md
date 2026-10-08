# ADR-0029 — A reusable rate-limit foundation: atomic multi-dimension counters in Valkey, limits from configuration, the caller decides how an outage fails

Status: ACCEPTED
Date: 2026-10-07
Checkpoint: ID-002

## Context

SV-03.04 asks for rate limits by account, phone, IP and device on code requests. No rate limiting existed (DEBT-0030: no limit on any public endpoint, including the address endpoints). Verification sends email, so an abuser can flood a mailbox or burn the provider budget from many accounts or addresses; the limit has to count dimensions PostgreSQL cannot see (source address, target address across accounts, device). Valkey is available and non-authoritative (ADR-0003).

## Decision

- **A port and two implementations.** `RateLimiter.consume(rules, { cost })` in `@bananagig/platform`; `ValkeyRateLimiter` for deployments and `MemoryRateLimiter` for tests and single-process development. A rule is `(name, key, limit, windowSeconds)`; a request names several rules at once, one per dimension.
- **Atomic, all or nothing.** One Lua script checks EVERY rule first and increments them all only when each has room, so concurrent requests cannot both take the last slot and a refused request never spends the quota of the dimensions that would have passed. Fixed windows (the window starts at the first hit); the accepted trade-off is up to twice the limit across a window boundary. The script touches several keys, which a clustered Valkey would need hash tags for (the deployment is a single node).
- **Privacy.** Rule keys are opaque: an account id, or a keyed hash of an IP, device id or email address (`hashDimension`, truncated HMAC). Raw addresses and IPs never become Valkey keys. A refusal never says which dimension refused.
- **The caller decides what an outage means.** The limiter never returns "allowed" on error: it throws `RateLimiterUnavailableError` (command timeout 150 ms, a circuit breaker so a dead Valkey does not add its timeout to every request). Operations that send mail or create work (set the address, send) FAIL CLOSED; confirmation fails open, because an authoritative limit exists elsewhere (the attempt counter in PostgreSQL, ADR-0028).
- **Limits are configuration.** The values are CFG-001 parameters (`verification.email.requests.max_per_hour`, `verification.email.address.max_per_hour`, plus the six code-policy parameters). Authoritative per-account limits (cooldown, hour, day) are counted from PostgreSQL and survive a Valkey flush.
- **DEBT-0030 stays OPEN.** The facility exists but is not applied to the public address endpoints in ID-002 (the checkpoint's own condition). How DEBT-0030 uses it is documented in `docs/engineering/RATE_LIMITING.md`: a Fastify `preHandler` builds `[{ name: 'public:ip', key: hashDimension(...), ... }]` from `request.ip` and the limit from a new parameter, and answers 429 with `Retry-After`; the IP is only as good as `trustProxy` (DEBT-0055).

## Alternatives considered

- `@fastify/rate-limit`: per-route in-process or Redis counters, one dimension per rule and no all-or-nothing across dimensions; the limits would live in route options (code), not in configuration. Rejected as the foundation; it can still be used for the blunt public-endpoint cap if DEBT-0030 prefers it.
- Counting only in PostgreSQL: authoritative for per-account limits (and used for them) but cannot see source address or target address across accounts without a write per request. Rejected as the only mechanism.
- Sliding windows or token buckets: smoother, more state and more script. Deferred; the interface does not change.
- Failing open everywhere: an outage would silently remove the protection of the operations that send mail. Rejected.

## Consequences

Valkey becomes a dependency of the verification send path (a Valkey outage stops email verification sends, by design). The IP dimension relies on the API seeing the real client address (DEBT-0055).

## Migration / compatibility

No schema change. The `bananagig:rl:` key prefix is reserved for the limiter.

## Related files

- `packages/platform/src/rate-limit.ts`
- `packages/accounts/src/email-verification.ts`
- `packages/accounts/src/email-crypto.ts`
- `docs/engineering/RATE_LIMITING.md`
- `docs/project/TECH_DEBT.md`
- `docs/architecture/ADR-0003-valkey-non-authoritative.md`
