# ADR-0033 — The API trusts an exact number of reverse-proxy hops, and the proxy replaces X-Forwarded-For

Status: ACCEPTED
Date: 2026-10-08
Checkpoint: ID-003

## Context

DEBT-0055: the API ran Fastify with `trustProxy: true`, so `request.ip` was the first `X-Forwarded-For` entry, which any client can set. The verification limits count the (hashed) client address as one dimension. For email that was a weakness; for SMS it is a cost problem: an attacker who rotates the header gets a new bucket per request and defeats the source-address limit that stops one client from creating accounts and sending to many numbers.

## Decision

- **Trust a count, not everything.** `TRUSTED_PROXY_HOPS` (0 to 4) is the exact number of reverse proxies in front of the API. The API passes Fastify the function `hop < hops`, so `request.ip` is the first address that is not a trusted proxy: with 1 hop the LAST `X-Forwarded-For` entry (the one the proxy wrote), with 0 hops always the socket address. A client-chosen leftmost entry is never read. Production MUST set it (no default; the API refuses to start without it); development defaults to 1 (Caddy, or the web server calling the API).
- **The proxy replaces, it does not append.** Caddy sets `header_up X-Forwarded-For {remote_host}` on every upstream (web and API), so a client-sent header is discarded and the only entry is the connection address as Caddy saw it. The web server forwards exactly one value (the last entry it received) to the API, which trusts that one hop.
- **The topology is part of the contract.** The API must be reachable only through the trusted hop: Compose publishes no API port (only Caddy listens on the host), and production must keep the API on a private network. This is a deployment invariant that cannot be enforced in code; it is documented in `docs/engineering/RATE_LIMITING.md` and tested statically (the Caddyfile and the compose file) and end to end (the smoke test sends a spoofed header through Caddy and asserts no rate-limit bucket was created for it).

## Alternatives considered

- `trustProxy: true`: trusts every hop, including a client-supplied leftmost entry. Rejected (this was the defect).
- Reading only the socket address: every user behind the proxy would share one bucket (a global lockout at the limit). Rejected.
- A CIDR allow-list of proxy addresses: precise but ties the config to addresses that change in container networks. Possible later; the hop count is enough for one proxy tier.
- A shared secret header between the proxy and the API: stronger against a reachable API, more moving parts. Deferred; the network invariant is the control today.

## Consequences

Behind a CDN plus Caddy the production value is 2 and both tiers must replace or append correctly. A deployment that exposes the API directly while TRUSTED_PROXY_HOPS is 1 lets a client choose its address (one chosen entry); the static and smoke checks exist to catch the Compose case.

## Migration / compatibility

No schema change. `.env.example` gains `TRUSTED_PROXY_HOPS=1`; production configuration must add it.

## Related files

- `apps/api/src/app.ts`
- `packages/config/src/index.ts`
- `infra/caddy/Caddyfile`
- `apps/web/src/lib/auth/email-handlers.ts`
- `docs/engineering/RATE_LIMITING.md`
- `docs/architecture/ADR-0029-reusable-rate-limit-foundation.md`
