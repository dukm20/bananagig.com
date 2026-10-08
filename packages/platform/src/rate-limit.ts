// Reusable rate-limit foundation (ID-002, docs/engineering/RATE_LIMITING.md). Counters live in Valkey; the decision is made by ONE atomic script, so
// concurrent requests cannot both pass the last slot. This is the generic facility security-sensitive endpoints share (email verification now; the public
// address endpoints of DEBT-0030 and phone verification later).
//
// Model: fixed windows. A RULE is (name, key, limit, windowSeconds): the counter `rl:<name>:<key>` allows `limit` hits per window; the window starts at
// the first hit. A request names SEVERAL rules at once (one per dimension: account, IP, email hash, device). `consume` checks ALL rules first and only if
// every rule has room increments them ALL, atomically, so a refused request never uses up the quota of the dimensions that would have passed.
//
// Privacy: a rule key is an OPAQUE identifier (an account id, or a keyed hash of an IP or an email address). Raw addresses and IPs never become Valkey keys.
//
// Failure semantics: this module never decides what an outage means. When Valkey cannot answer in time `consume` throws RateLimiterUnavailableError and the
// CALLER chooses (deny for operations that cost money or send mail, allow only where an authoritative limit exists elsewhere, for example the attempt counter
// in PostgreSQL). A circuit breaker keeps a dead Valkey from adding its timeout to every request.
//
// Known limits (documented, accepted): fixed windows allow up to twice the limit across a window boundary; the script touches several keys, so a clustered
// Valkey would need hash tags (the deployment is a single node).

export interface RateRule {
  /** Bucket name, for example `email-verification:account`. Lower-case words and colons. */
  name: string;
  /** The opaque subject of the counter (an id or a keyed hash), never a raw address or IP. */
  key: string;
  /** Hits allowed per window (a positive integer). */
  limit: number;
  /** Window length in seconds (a positive integer). */
  windowSeconds: number;
}

export interface RateDecision {
  allowed: boolean;
  /** The first rule (in the order given) that had no room, when refused. */
  limitedBy?: string;
  /** Seconds until the refusing window resets (0 when allowed). */
  retryAfterSeconds: number;
}

export class RateLimiterUnavailableError extends Error {
  constructor(message = 'the rate limiter is unavailable') {
    super(message);
    this.name = 'RateLimiterUnavailableError';
  }
}

export interface RateLimiter {
  /**
   * Counts one hit (or `cost` hits) against every rule when ALL have room, otherwise counts nothing and reports the first rule without room.
   * Throws RateLimiterUnavailableError when the counters cannot be reached or the rules are invalid.
   */
  consume(rules: readonly RateRule[], options?: { cost?: number }): Promise<RateDecision>;
}

const NAME = /^[a-z][a-z0-9:_-]{0,79}$/;
const KEY = /^[A-Za-z0-9._:@=-]{1,128}$/;
function assertRules(rules: readonly RateRule[], cost: number): void {
  if (rules.length === 0 || rules.length > 8) throw new RateLimiterUnavailableError('between 1 and 8 rate rules are required');
  if (!Number.isSafeInteger(cost) || cost < 1) throw new RateLimiterUnavailableError('the cost must be a positive integer');
  for (const r of rules) {
    if (!NAME.test(r.name) || !KEY.test(r.key)) throw new RateLimiterUnavailableError('a rate rule has an invalid name or key');
    if (!Number.isSafeInteger(r.limit) || r.limit < 1 || !Number.isSafeInteger(r.windowSeconds) || r.windowSeconds < 1)
      throw new RateLimiterUnavailableError('a rate rule has an invalid limit or window');
  }
}

/** Atomic check-all-then-increment-all. KEYS: counters. ARGV: limit and window seconds per key, then the cost. Returns {allowed, ruleIndex, retryMs}. */
export const RATE_LIMIT_SCRIPT = `
local n = #KEYS
local cost = tonumber(ARGV[2 * n + 1])
for i = 1, n do
  local current = tonumber(redis.call('GET', KEYS[i]) or '0')
  if current + cost > tonumber(ARGV[2 * i - 1]) then
    local ttl = redis.call('PTTL', KEYS[i])
    if ttl < 0 then
      ttl = tonumber(ARGV[2 * i]) * 1000
      redis.call('PEXPIRE', KEYS[i], ttl)
    end
    return {0, i, ttl}
  end
end
for i = 1, n do
  redis.call('INCRBY', KEYS[i], cost)
  if redis.call('PTTL', KEYS[i]) < 0 then redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[2 * i]) * 1000) end
end
return {1, 0, 0}
`;

interface ValkeyEvalLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface ValkeyRateLimiterOptions {
  /** Key prefix. Default `bananagig:rl:`. */
  prefix?: string;
  /** Upper bound for the script call. Default 150 ms. */
  commandTimeoutMs?: number;
  /** After a failure every call fails immediately for this long, then one probe is let through. Default 2000 ms. */
  breakerCooldownMs?: number;
  now?: () => number;
}

/** Valkey-backed limiter. Every failure surfaces as RateLimiterUnavailableError (never as an allow). */
export class ValkeyRateLimiter implements RateLimiter {
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private openUntil = 0;
  private probing = false;

  constructor(
    private readonly client: ValkeyEvalLike,
    options: ValkeyRateLimiterOptions = {},
  ) {
    this.prefix = options.prefix ?? 'bananagig:rl:';
    this.timeoutMs = options.commandTimeoutMs ?? 150;
    this.cooldownMs = options.breakerCooldownMs ?? 2000;
    this.now = options.now ?? Date.now;
  }

  async consume(rules: readonly RateRule[], options: { cost?: number } = {}): Promise<RateDecision> {
    const cost = options.cost ?? 1;
    assertRules(rules, cost);
    const t = this.now();
    let probe = false;
    if (this.openUntil !== 0) {
      if (t < this.openUntil || this.probing) throw new RateLimiterUnavailableError();
      this.probing = probe = true;
    }
    const keys = rules.map((r) => `${this.prefix}${r.name}:${r.key}`);
    const args: (string | number)[] = [];
    for (const r of rules) args.push(r.limit, r.windowSeconds);
    args.push(cost);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      pending = this.client.eval(RATE_LIMIT_SCRIPT, keys.length, ...keys, ...args);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('rate limiter timed out')), this.timeoutMs);
      });
      const reply = await Promise.race([pending, timeout]);
      if (!Array.isArray(reply) || reply.length !== 3) throw new Error('unexpected rate limiter reply');
      const [allowed, index, retryMs] = reply.map(Number) as [number, number, number];
      this.openUntil = 0;
      return allowed === 1
        ? { allowed: true, retryAfterSeconds: 0 }
        : { allowed: false, limitedBy: rules[index - 1]?.name, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
    } catch {
      pending?.catch(() => undefined);
      this.openUntil = this.now() + this.cooldownMs;
      throw new RateLimiterUnavailableError();
    } finally {
      if (timer) clearTimeout(timer);
      if (probe) this.probing = false;
    }
  }
}

/** In-process limiter with the same semantics (unit tests and single-process development). Not shared between processes. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly counters = new Map<string, { count: number; resetAt: number }>();
  /** When set, every call fails like an unreachable Valkey. */
  unavailable = false;

  constructor(private readonly now: () => number = Date.now) {}

  async consume(rules: readonly RateRule[], options: { cost?: number } = {}): Promise<RateDecision> {
    const cost = options.cost ?? 1;
    assertRules(rules, cost);
    if (this.unavailable) throw new RateLimiterUnavailableError();
    const t = this.now();
    const live = (r: RateRule) => {
      const id = `${r.name}:${r.key}`;
      const c = this.counters.get(id);
      return c && c.resetAt > t ? c : undefined;
    };
    for (const r of rules) {
      const c = live(r);
      if (c && c.count + cost > r.limit) return { allowed: false, limitedBy: r.name, retryAfterSeconds: Math.max(1, Math.ceil((c.resetAt - t) / 1000)) };
      if (!c && cost > r.limit) return { allowed: false, limitedBy: r.name, retryAfterSeconds: r.windowSeconds };
    }
    for (const r of rules) {
      const c = live(r);
      if (c) c.count += cost;
      else this.counters.set(`${r.name}:${r.key}`, { count: cost, resetAt: t + r.windowSeconds * 1000 });
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
