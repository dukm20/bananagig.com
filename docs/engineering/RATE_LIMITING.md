# Rate limiting

The rate-limit foundation (ID-002, ADR-0029) is the facility security-sensitive endpoints share. Email verification uses it now; phone verification (ID-003) and the public address endpoints (DEBT-0030) can use it without changes to the package.

## Model

`RateLimiter.consume(rules, { cost })` (`packages/platform/src/rate-limit.ts`). A **rule** is `(name, key, limit, windowSeconds)`: the counter `bananagig:rl:<name>:<key>` allows `limit` hits per fixed window; the window starts at the first hit and the counter expires with it. A request names one rule **per dimension** (account, source address, target address, device) and `consume` is **all or nothing**: one atomic script checks every rule first and increments every rule only if each has room. Concurrent requests therefore cannot both take the last slot, and a refused request never spends the quota of the dimensions that would have passed.

| Dimension | Rule name | Key |
|---|---|---|
| account | `email-verification:account` | the account id (a uuid) |
| source address | `email-verification:ip` | `hashDimension(secret, 'ip', request.ip)` |
| device or session | `email-verification:device` | `hashDimension(secret, 'device', id)` (no device id exists yet; the service accepts one) |
| target address | `email-verification:address` | `hashDimension(secret, 'email', canonicalAddress)` |

Keys are opaque. Raw addresses and IPs never become Valkey keys (`hashDimension` is a keyed, truncated HMAC). A refusal reports only `retryAfterSeconds`; the refusing dimension is never named to a client.

## Decision

`consume` returns `{ allowed, limitedBy?, retryAfterSeconds }`. It never returns `allowed` on a failure: if Valkey cannot answer within 150 ms, or the reply is malformed, it throws `RateLimiterUnavailableError` (a circuit breaker then fails fast for two seconds, so a dead Valkey does not add its timeout to every request). **The caller decides what an outage means:**

- operations that send mail or create work **fail closed** (set the address, send a verification);
- operations that are bounded elsewhere may **fail open** (confirm a code: the wrong-attempt counter in PostgreSQL is authoritative).

Per-account limits that must survive a Valkey flush (resend cooldown, hourly and daily caps, attempts) are counted from PostgreSQL. Valkey adds the dimensions PostgreSQL cannot see.

## Limits are configuration

Never hardcode a limit. The values are CFG-001 parameters read at the call site (`verification.email.requests.max_per_hour`, `verification.email.address.max_per_hour`, and the code-policy parameters). A new feature adds its own parameters through a change request or a seeded migration.

## Implementations

| Class | Use |
|---|---|
| `ValkeyRateLimiter(client, { prefix, commandTimeoutMs, breakerCooldownMs })` | deployments (`createValkey(cfg)` client); the key prefix is overridable for tests |
| `MemoryRateLimiter(now)` | unit tests and single-process development; same semantics, injectable clock, `unavailable` flag |

Accepted limits: fixed windows allow up to twice the limit across a window boundary; the script touches several keys, so a clustered Valkey needs hash tags (the deployment is one node). Sliding windows or token buckets can replace the script behind the same interface.

## Using it for a new endpoint

```ts
const decision = await limiter.consume([
  { name: 'phone-verification:account', key: accountId, limit: policy.requestsPerHour, windowSeconds: 3600 },
  { name: 'phone-verification:ip', key: hashDimension(secret, 'ip', request.ip), limit: policy.requestsPerHour, windowSeconds: 3600 },
]); // throws RateLimiterUnavailableError: choose deny or allow for THIS operation
if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds); // 429 + Retry-After
```

## How DEBT-0030 (public address endpoints) can use it

DEBT-0030 stays OPEN: ID-002 does not apply the limiter to the public endpoints. To close it:

1. Add the limit parameters (for example `api.public.address.max_per_minute`) through a change request.
2. Add a Fastify `preHandler` on `/geography/addresses/validate`, `/geography/addresses/format` and the public format and area reads that builds `[{ name: 'public:ip', key: hashDimension(secret, 'ip', request.ip), limit, windowSeconds: 60 }]` and answers `429 RATE_LIMITED` with `Retry-After` (fail open or closed per endpoint: these reads are cheap, so a short outage can fail open with an alert).
3. Make the client address trustworthy first: the API runs with `trustProxy: true`, which accepts a client-supplied `X-Forwarded-For` (DEBT-0055). Set the exact number of proxy hops before relying on the IP dimension for abuse defense.
4. Add integration tests with a real Valkey (the pattern in `packages/platform/src/rate-limit.itest.ts`) and a public-endpoint 429 test.

## Tests

`packages/platform/src/rate-limit.test.ts` (semantics with an injected clock and a fake client, breaker, failure handling) and `rate-limit.itest.ts` (real Valkey: atomicity under concurrency, all-or-nothing counters, TTL, window expiry, unreachable client). The service-level behaviour (dimensions, fail closed or open) is covered in `packages/accounts/src/email-verification.itest.ts` and `apps/api/src/account-email.itest.ts`.
