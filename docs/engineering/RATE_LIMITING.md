# Rate limiting

The rate-limit foundation (ID-002, ADR-0029) is the facility security-sensitive endpoints share. Email verification (ID-002), phone verification (ID-003) and the public password-reset request (ID-004) use it; the public address endpoints (DEBT-0030) can use it without changes to the package.

## Model

`RateLimiter.consume(rules, { cost })` (`packages/platform/src/rate-limit.ts`). A **rule** is `(name, key, limit, windowSeconds)`: the counter `bananagig:rl:<name>:<key>` allows `limit` hits per fixed window; the window starts at the first hit and the counter expires with it. A request names one rule **per dimension** (account, source address, target address, device) and `consume` is **all or nothing**: one atomic script checks every rule first and increments every rule only if each has room. Concurrent requests therefore cannot both take the last slot, and a refused request never spends the quota of the dimensions that would have passed.

| Dimension | Rule name | Key |
|---|---|---|
| account | `email-verification:account` | the account id (a uuid) |
| source address | `email-verification:ip` | `hashDimension(secret, 'ip', request.ip)` |
| device or session | `email-verification:device` | `hashDimension(secret, 'device', id)`; since ID-004 the id is the application device id of the request's session (`request.securitySession.accountDeviceId`, passed by the routes' `requestContext`), absent until the browser has registered (DEBT-0054) |
| target address | `email-verification:address` | `hashDimension(secret, 'email', canonicalAddress)` |
| account (phone, ID-003) | `phone-verification:account` | the account id (a uuid) |
| source address (phone) | `phone-verification:ip` | `hashDimension(secret, 'ip', request.ip)` |
| device or session (phone) | `phone-verification:device` | `hashDimension(secret, 'device', id)`; fed with the application device id of the session since ID-004, like email |
| target number (phone) | `phone-verification:number` | `hashDimension(secret, 'phone', e164)`: an HMAC of the canonical E.164, never the raw number; counted across all accounts, on send only (setting a number sends nothing) |
| target address (password reset, ID-004) | `password-reset:email` | `hashDimension(secret, 'email', canonicalAddress)`; for an address that cannot be canonical, the hash of what was sent (so garbage cannot dodge the limit). Public endpoint, no account |
| source address (password reset) | `password-reset:ip` | `hashDimension(secret, 'ip', request.ip)`; only as good as `TRUSTED_PROXY_HOPS` |

Both password-reset rules use `reset_link.max_requests_per_hour` (default 5, an engineering assumption, DEBT-0070) with a 3600-second window and are consumed together (all or nothing) BEFORE anything that depends on whether the address belongs to an account, so the caller waits for the same work in every case. A refusal is `429 ACCOUNT_PASSWORD_RESET_RATE_LIMITED` with `Retry-After`; an unreachable limiter FAILS CLOSED (`503 ACCOUNT_UNAVAILABLE`, reason `RATE_LIMITER_UNAVAILABLE`) because each accepted request can send an email. The per-address bucket can be burned by a third party who knows the address; that is uniform on purpose so the endpoint reveals nothing (DEBT-0073). The device dimension is not used by the public endpoint (there is no session).

Keys are opaque. Raw addresses and IPs never become Valkey keys (`hashDimension` is a keyed, truncated HMAC). A refusal reports only `retryAfterSeconds`; the refusing dimension is never named to a client.

## Decision

`consume` returns `{ allowed, limitedBy?, retryAfterSeconds }`. It never returns `allowed` on a failure: if Valkey cannot answer within 150 ms, or the reply is malformed, it throws `RateLimiterUnavailableError` (a circuit breaker then fails fast for two seconds, so a dead Valkey does not add its timeout to every request). **The caller decides what an outage means:**

- operations that send mail or create work **fail closed** (set the address, send a verification, request a password reset);
- operations that are bounded elsewhere may **fail open** (confirm a code: the wrong-attempt counter in PostgreSQL is authoritative).

Per-account limits that must survive a Valkey flush (resend cooldown, hourly and daily caps, attempts) are counted from PostgreSQL. Valkey adds the dimensions PostgreSQL cannot see.

## Limits are configuration

Never hardcode a limit. The values are CFG-001 parameters read at the call site (`verification.email.requests.max_per_hour`, `verification.email.address.max_per_hour`, `reset_link.max_requests_per_hour`, and the code-policy parameters). A new feature adds its own parameters through a change request or a seeded migration.

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
3. Make the client address trustworthy first (DEBT-0055): ID-003 replaced `trustProxy: true` with the exact trusted-hop model described in "Trusted proxy model (DEBT-0055)" below, and the phone buckets use it (`phone-verification:account|ip|device|number` in the table above). DEBT-0055 is RESOLVED by ID-003 apart from these two deployment invariants (see `TECH_DEBT.md`).and of DEBT-0030.
4. Add integration tests with a real Valkey (the pattern in `packages/platform/src/rate-limit.itest.ts`) and a public-endpoint 429 test.

## Trusted proxy model (DEBT-0055)

Decision: ADR-0033. The source-address dimension counts `request.ip`, so the API must know the real client address and a client must not be able to choose it.

- **Hop count.** `TRUSTED_PROXY_HOPS` (0 to 4) is the exact number of reverse proxies in front of the API. `apps/api/src/app.ts` passes Fastify `trustHops(hops)`, which trusts a hop while `hop < hops`: with 0 hops `request.ip` is the socket address, with 1 hop it is the LAST `X-Forwarded-For` entry (the one the proxy wrote), and a client-chosen leftmost entry is never used. Development defaults to 1; production must set it explicitly (the API refuses to start without it).
- **The proxy replaces the header.** `infra/caddy/Caddyfile` sets `header_up X-Forwarded-For {remote_host}` on its upstreams, so a client-sent header is discarded rather than appended to. The web server forwards one value (`clientIpOf` in `apps/web/src/lib/auth/email-handlers.ts` takes the last entry) to the API, which trusts that one hop.
- **The API is reachable only through the proxy.** This is a deployment invariant that code cannot enforce: Compose publishes no API port (only Caddy listens on the host) and production must keep the API on a private network. Behind a CDN plus Caddy the value is 2 and both tiers must replace or append correctly.
- **How it is tested.** Unit semantics in `apps/api/src/trust-proxy.test.ts` (0, 1 and 2 hops, spoofed chains, IPv6, configuration defaults and the production requirement); a static test of the Caddyfile and the compose files in the same file (header replaced, no published API port); and the `Phone verification` smoke scenario (`apps/smoke/src/index.ts`), which sends a spoofed `X-Forwarded-For` through Caddy and asserts that no rate-limit bucket was created for the spoofed address.
DEBT-0055 is RESOLVED by ID-003 apart from these two deployment invariants (see `TECH_DEBT.md`).

## Tests

`packages/platform/src/rate-limit.test.ts` (semantics with an injected clock and a fake client, breaker, failure handling) and `rate-limit.itest.ts` (real Valkey: atomicity under concurrency, all-or-nothing counters, TTL, window expiry, unreachable client). The service-level behaviour (dimensions, fail closed or open) is covered in `packages/accounts/src/email-verification.itest.ts` and `apps/api/src/account-email.itest.ts`.
