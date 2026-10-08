// Unit tests of the rate limiter (ID-002): the in-memory limiter's semantics with an injected clock, and the Valkey limiter against a fake client (key and
// argument layout, reply parsing, fail-closed errors, timeout and the circuit breaker). The real atomicity of the Lua script is proven against a real
// Valkey in rate-limit.itest.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRateLimiter, RATE_LIMIT_SCRIPT, RateLimiterUnavailableError, ValkeyRateLimiter, type RateDecision, type RateRule } from './rate-limit';

const rule = (over: Partial<RateRule> = {}): RateRule => ({ name: 'email-verification:account', key: 'acct-1', limit: 3, windowSeconds: 60, ...over });
const allowed: RateDecision = { allowed: true, retryAfterSeconds: 0 };

// ====================================================================== MemoryRateLimiter
describe('MemoryRateLimiter: one rule', () => {
  function setup() {
    const clock = { now: 1_000_000 };
    return { clock, limiter: new MemoryRateLimiter(() => clock.now) };
  }

  it('allows up to the limit, then refuses with the rule name and the seconds until the window resets', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) expect(await limiter.consume([rule()]), `hit ${i + 1}`).toStrictEqual(allowed);
    expect(await limiter.consume([rule()])).toStrictEqual({ allowed: false, limitedBy: 'email-verification:account', retryAfterSeconds: 60 });
  });
  it('keeps refusing until the window ends', async () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 3; i++) await limiter.consume([rule()]);
    for (const advance of [1, 1000, 30_000, 59_999]) {
      clock.now = 1_000_000 + advance;
      expect((await limiter.consume([rule()])).allowed, `${advance} ms`).toBe(false);
    }
  });
  it('counts down the retry time as the window runs out and never reports less than one second', async () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 3; i++) await limiter.consume([rule()]);
    const retry = async (ms: number) => {
      clock.now = 1_000_000 + ms;
      return (await limiter.consume([rule()])).retryAfterSeconds;
    };
    expect(await retry(0)).toBe(60);
    expect(await retry(10_000)).toBe(50);
    expect(await retry(10_001)).toBe(50);
    expect(await retry(58_999)).toBe(2);
    expect(await retry(59_000)).toBe(1);
    expect(await retry(59_500)).toBe(1);
    expect(await retry(59_999)).toBe(1);
  });
  it('opens a fresh window exactly when the old one ends', async () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 3; i++) await limiter.consume([rule()]);
    expect((await limiter.consume([rule()])).allowed).toBe(false);
    clock.now = 1_000_000 + 60_000;
    expect(await limiter.consume([rule()])).toStrictEqual(allowed);
  });
  it('gives a full quota again in the new window, and no more', async () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 3; i++) await limiter.consume([rule()]);
    clock.now += 60_000;
    for (let i = 0; i < 3; i++) expect((await limiter.consume([rule()])).allowed, `hit ${i + 1}`).toBe(true);
    expect((await limiter.consume([rule()])).allowed).toBe(false);
  });
  it('starts the window at the FIRST hit and does not slide it on later hits', async () => {
    const { limiter, clock } = setup();
    await limiter.consume([rule({ limit: 2 })]);
    clock.now += 30_000;
    await limiter.consume([rule({ limit: 2 })]);
    clock.now += 29_000; // 59 s after the first hit
    expect((await limiter.consume([rule({ limit: 2 })])).retryAfterSeconds).toBe(1);
    clock.now += 1_000; // 60 s after the first hit
    expect((await limiter.consume([rule({ limit: 2 })])).allowed).toBe(true);
  });
  it('does not extend the window when a request is refused', async () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 3; i++) await limiter.consume([rule()]);
    for (let i = 0; i < 20; i++) {
      clock.now += 2_000;
      await limiter.consume([rule()]);
    }
    clock.now = 1_000_000 + 60_000;
    expect((await limiter.consume([rule()])).allowed).toBe(true);
  });
  it('keeps separate counters per key', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) await limiter.consume([rule({ key: 'acct-1' })]);
    expect((await limiter.consume([rule({ key: 'acct-1' })])).allowed).toBe(false);
    expect((await limiter.consume([rule({ key: 'acct-2' })])).allowed).toBe(true);
  });
  it('keeps separate counters per rule name', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) await limiter.consume([rule({ name: 'a:one' })]);
    expect((await limiter.consume([rule({ name: 'a:one' })])).allowed).toBe(false);
    expect((await limiter.consume([rule({ name: 'a:two' })])).allowed).toBe(true);
  });
  it('allows a limit of one exactly once per window', async () => {
    const { limiter, clock } = setup();
    expect((await limiter.consume([rule({ limit: 1, windowSeconds: 10 })])).allowed).toBe(true);
    expect((await limiter.consume([rule({ limit: 1, windowSeconds: 10 })])).allowed).toBe(false);
    clock.now += 10_000;
    expect((await limiter.consume([rule({ limit: 1, windowSeconds: 10 })])).allowed).toBe(true);
  });
  it('uses the window length of each call (the rule is data, not state)', async () => {
    const { limiter } = setup();
    await limiter.consume([rule({ limit: 1, windowSeconds: 3600 })]);
    expect(await limiter.consume([rule({ limit: 1, windowSeconds: 3600 })])).toStrictEqual({
      allowed: false,
      limitedBy: 'email-verification:account',
      retryAfterSeconds: 3600,
    });
  });
  it('works with the real clock when none is injected', async () => {
    const limiter = new MemoryRateLimiter();
    const r = rule({ key: `real-${Math.random()}`, limit: 1 });
    expect((await limiter.consume([r])).allowed).toBe(true);
    const refused = await limiter.consume([r]);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
  });
});

describe('MemoryRateLimiter: cost', () => {
  it('counts the cost against the limit', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    const r = rule({ limit: 5 });
    expect((await limiter.consume([r], { cost: 2 })).allowed).toBe(true);
    expect((await limiter.consume([r], { cost: 2 })).allowed).toBe(true);
    expect((await limiter.consume([r], { cost: 2 })).allowed).toBe(false);
    expect((await limiter.consume([r], { cost: 1 })).allowed).toBe(true);
    expect((await limiter.consume([r], { cost: 1 })).allowed).toBe(false);
  });
  it('allows a cost exactly equal to the limit once', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    expect((await limiter.consume([rule({ limit: 4 })], { cost: 4 })).allowed).toBe(true);
    expect((await limiter.consume([rule({ limit: 4 })], { cost: 1 })).allowed).toBe(false);
  });
  it('refuses a cost above the limit in a fresh window, reporting the whole window, and consumes nothing', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    const r = rule({ limit: 3, windowSeconds: 90 });
    expect(await limiter.consume([r], { cost: 4 })).toStrictEqual({ allowed: false, limitedBy: r.name, retryAfterSeconds: 90 });
    for (let i = 0; i < 3; i++) expect((await limiter.consume([r])).allowed, `hit ${i + 1}`).toBe(true);
    expect((await limiter.consume([r])).allowed).toBe(false);
  });
  it('refuses a cost that does not fit, leaves the counter unchanged and reports the rule', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    const r = rule({ limit: 5 });
    await limiter.consume([r], { cost: 4 });
    expect((await limiter.consume([r], { cost: 2 })).limitedBy).toBe(r.name);
    expect((await limiter.consume([r], { cost: 1 })).allowed).toBe(true);
  });
  it('applies the same cost to every rule', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    const a = rule({ name: 'a:rule', limit: 10 });
    const b = rule({ name: 'b:rule', limit: 3 });
    expect((await limiter.consume([a, b], { cost: 2 })).allowed).toBe(true);
    expect((await limiter.consume([a, b], { cost: 2 })).limitedBy).toBe('b:rule');
    // a was charged once only (2 of 10): eight more fit, nine do not
    expect((await limiter.consume([a], { cost: 8 })).allowed).toBe(true);
    expect((await limiter.consume([a], { cost: 1 })).allowed).toBe(false);
  });
});

describe('MemoryRateLimiter: several rules are all-or-nothing', () => {
  const a = rule({ name: 'x:account', key: 'k', limit: 5 });
  const b = rule({ name: 'x:address', key: 'k', limit: 1 });
  const c = rule({ name: 'x:ip', key: 'k', limit: 5 });

  it('counts every rule when all have room', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    expect(await limiter.consume([a, b, c])).toStrictEqual(allowed);
    // each rule was charged exactly once: a and c have 4 left, b has none
    for (let i = 0; i < 4; i++) expect((await limiter.consume([a])).allowed, `a ${i + 1}`).toBe(true);
    expect((await limiter.consume([a])).allowed).toBe(false);
    for (let i = 0; i < 4; i++) expect((await limiter.consume([c])).allowed, `c ${i + 1}`).toBe(true);
    expect((await limiter.consume([c])).allowed).toBe(false);
    expect((await limiter.consume([b])).allowed).toBe(false);
  });
  it('a refused request does NOT use up the quota of the rules that had room', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    await limiter.consume([a, b, c]); // b is now exhausted; a and c have used 1
    for (let i = 0; i < 10; i++) expect((await limiter.consume([a, b, c])).limitedBy, `refusal ${i + 1}`).toBe('x:address');
    // had the refusals counted, a would be spent: it must still hold exactly 4
    for (let i = 0; i < 4; i++) expect((await limiter.consume([a])).allowed, `a ${i + 1}`).toBe(true);
    expect((await limiter.consume([a])).allowed).toBe(false);
    for (let i = 0; i < 4; i++) expect((await limiter.consume([c])).allowed, `c ${i + 1}`).toBe(true);
    expect((await limiter.consume([c])).allowed).toBe(false);
  });
  it('is all-or-nothing whichever position the exhausted rule has', async () => {
    for (const order of [
      [b, a, c],
      [a, b, c],
      [a, c, b],
    ]) {
      const limiter = new MemoryRateLimiter(() => 0);
      await limiter.consume([b]); // exhaust b alone
      const refused = await limiter.consume(order);
      expect(refused.allowed).toBe(false);
      expect(refused.limitedBy).toBe('x:address');
      // a and c are untouched: five hits each still fit
      for (let i = 0; i < 5; i++) expect((await limiter.consume([a, c])).allowed, `${order.map((r) => r.name).join(',')} hit ${i + 1}`).toBe(true);
      expect((await limiter.consume([a, c])).allowed).toBe(false);
    }
  });
  it('is all-or-nothing when the cost fits one rule and not another', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    const wide = rule({ name: 'w:wide', limit: 10 });
    const narrow = rule({ name: 'n:narrow', limit: 2 });
    expect((await limiter.consume([wide, narrow], { cost: 3 })).limitedBy).toBe('n:narrow');
    expect((await limiter.consume([wide], { cost: 10 })).allowed).toBe(true);
  });
  it('names the FIRST refusing rule in the order given', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    const one = rule({ name: 'r:one', limit: 1 });
    const two = rule({ name: 'r:two', limit: 1 });
    const open = rule({ name: 'r:open', limit: 5 });
    const other = rule({ name: 'r:other', limit: 5 });
    await limiter.consume([one]);
    await limiter.consume([two]);
    expect((await limiter.consume([open, one, two])).limitedBy).toBe('r:one');
    expect((await limiter.consume([open, two, one])).limitedBy).toBe('r:two');
    expect((await limiter.consume([two, open, one])).limitedBy).toBe('r:two');
    expect((await limiter.consume([open, other, two])).limitedBy).toBe('r:two');
  });
  it('reports the retry time of the first refusing rule, not the longest one', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    const short = rule({ name: 'r:short', limit: 1, windowSeconds: 60 });
    const long = rule({ name: 'r:long', limit: 1, windowSeconds: 3600 });
    await limiter.consume([short]);
    await limiter.consume([long]);
    expect((await limiter.consume([short, long])).retryAfterSeconds).toBe(60);
    expect((await limiter.consume([long, short])).retryAfterSeconds).toBe(3600);
  });
  it('charges the same rule listed twice twice, so duplicates are never free', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    const r = rule({ limit: 3 });
    expect((await limiter.consume([r, r])).allowed).toBe(true);
    expect((await limiter.consume([r])).allowed).toBe(true);
    expect((await limiter.consume([r])).allowed).toBe(false);
  });
  it('resets each rule on its own window', async () => {
    const clock = { now: 0 };
    const limiter = new MemoryRateLimiter(() => clock.now);
    const minute = rule({ name: 'w:minute', limit: 1, windowSeconds: 60 });
    const hour = rule({ name: 'w:hour', limit: 2, windowSeconds: 3600 });
    expect((await limiter.consume([minute, hour])).allowed).toBe(true);
    clock.now = 60_000;
    expect((await limiter.consume([minute, hour])).allowed).toBe(true);
    clock.now = 120_000;
    expect((await limiter.consume([minute, hour])).limitedBy).toBe('w:hour');
    clock.now = 3_600_000;
    expect((await limiter.consume([minute, hour])).allowed).toBe(true);
  });
});

describe('MemoryRateLimiter: invalid rules are an error, never an allow', () => {
  const longName = `a${'b'.repeat(79)}`;
  const invalid: [string, RateRule[], { cost?: number }?][] = [
    ['no rules', []],
    ['nine rules', Array.from({ length: 9 }, (_, i) => rule({ name: `r:${i}` }))],
    ['an empty name', [rule({ name: '' })]],
    ['an upper-case name', [rule({ name: 'Email:Account' })]],
    ['a name that starts with a digit', [rule({ name: '1email' })]],
    ['a name that starts with a colon', [rule({ name: ':email' })]],
    ['a name with a space', [rule({ name: 'email account' })]],
    ['a name with a slash', [rule({ name: 'email/account' })]],
    ['a name of 81 characters', [rule({ name: `a${'b'.repeat(80)}` })]],
    ['a name with a newline', [rule({ name: 'email\naccount' })]],
    ['an empty key', [rule({ key: '' })]],
    ['a key of 129 characters', [rule({ key: 'k'.repeat(129) })]],
    ['a key with a space', [rule({ key: 'a b' })]],
    ['a key with a slash', [rule({ key: 'a/b' })]],
    ['a key with a star (a glob character)', [rule({ key: 'a*' })]],
    ['a key with a newline', [rule({ key: 'a\nb' })]],
    ['a key with a non-ASCII letter', [rule({ key: `caf${String.fromCodePoint(0xe9)}` })]],
    ['a key with a brace (a Redis hash tag character)', [rule({ key: '{a}' })]],
    ['a zero limit', [rule({ limit: 0 })]],
    ['a negative limit', [rule({ limit: -1 })]],
    ['a fractional limit', [rule({ limit: 1.5 })]],
    ['a NaN limit', [rule({ limit: Number.NaN })]],
    ['an infinite limit', [rule({ limit: Number.POSITIVE_INFINITY })]],
    ['a numeric string limit', [rule({ limit: '5' as unknown as number })]],
    ['a zero window', [rule({ windowSeconds: 0 })]],
    ['a negative window', [rule({ windowSeconds: -60 })]],
    ['a fractional window', [rule({ windowSeconds: 0.5 })]],
    ['a NaN window', [rule({ windowSeconds: Number.NaN })]],
    ['an infinite window', [rule({ windowSeconds: Number.POSITIVE_INFINITY })]],
    ['a numeric string window', [rule({ windowSeconds: '60' as unknown as number })]],
    ['a valid rule and an invalid one', [rule(), rule({ name: 'Bad Name' })]],
    ['a cost of zero', [rule()], { cost: 0 }],
    ['a negative cost', [rule()], { cost: -1 }],
    ['a fractional cost', [rule()], { cost: 1.5 }],
    ['a NaN cost', [rule()], { cost: Number.NaN }],
    ['an infinite cost', [rule()], { cost: Number.POSITIVE_INFINITY }],
  ];
  it.each(invalid)('%s -> RateLimiterUnavailableError', async (_label, rules, options) => {
    const limiter = new MemoryRateLimiter(() => 0);
    await expect(limiter.consume(rules, options)).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });
  it('accepts the boundary values: 8 rules, a name of 80 characters, a key of 128, the key punctuation . _ : @ = -', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    expect(longName).toHaveLength(80);
    expect(await limiter.consume(Array.from({ length: 8 }, (_, i) => rule({ name: `r:${i}` })))).toStrictEqual(allowed);
    expect((await limiter.consume([rule({ name: longName })])).allowed).toBe(true);
    expect((await limiter.consume([rule({ key: 'k'.repeat(128) })])).allowed).toBe(true);
    expect((await limiter.consume([rule({ key: 'A1.b_c:d@e=f-g' })])).allowed).toBe(true);
    expect((await limiter.consume([rule({ name: 'a0_b-c:d' })])).allowed).toBe(true);
  });
  it('charges nothing for a request that has one invalid rule among valid ones', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    const good = rule({ limit: 2 });
    await expect(limiter.consume([good, rule({ name: 'Bad Name' })])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    await expect(limiter.consume([good], { cost: 0 })).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    expect((await limiter.consume([good])).allowed).toBe(true);
    expect((await limiter.consume([good])).allowed).toBe(true);
    expect((await limiter.consume([good])).allowed).toBe(false);
  });
});

describe('MemoryRateLimiter: unavailable', () => {
  it('fails every call like an unreachable Valkey while the flag is set', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    limiter.unavailable = true;
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    await expect(limiter.consume([rule()], { cost: 2 })).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    await expect(limiter.consume([rule(), rule({ name: 'b:two' })])).rejects.toThrow('the rate limiter is unavailable');
  });
  it('is off by default and recovers when the flag is cleared', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    expect(limiter.unavailable).toBe(false);
    limiter.unavailable = true;
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    limiter.unavailable = false;
    expect(await limiter.consume([rule()])).toStrictEqual(allowed);
  });
  it('counts nothing while unavailable and keeps the earlier counts across the outage', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    const r = rule({ limit: 2 });
    await limiter.consume([r]);
    limiter.unavailable = true;
    for (let i = 0; i < 5; i++) await expect(limiter.consume([r])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    limiter.unavailable = false;
    expect((await limiter.consume([r])).allowed).toBe(true); // 2 of 2
    expect((await limiter.consume([r])).allowed).toBe(false);
  });
  it('is never an allow: the outcome is a throw, not a decision', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    limiter.unavailable = true;
    let decision: RateDecision | undefined;
    try {
      decision = await limiter.consume([rule()]);
    } catch {
      /* expected */
    }
    expect(decision).toBeUndefined();
  });
});

describe('RateLimiterUnavailableError', () => {
  it('is an Error with a stable name and message', () => {
    const err = new RateLimiterUnavailableError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RateLimiterUnavailableError');
    expect(err.message).toBe('the rate limiter is unavailable');
  });
  it('accepts a custom message', () => {
    expect(new RateLimiterUnavailableError('custom').message).toBe('custom');
  });
});

// ====================================================================== ValkeyRateLimiter
interface EvalCall {
  script: string;
  numKeys: number;
  args: (string | number)[];
}
function fakeClient(handler: (call: EvalCall) => unknown = () => [1, 0, 0]) {
  const calls: EvalCall[] = [];
  return {
    calls,
    eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
      const call = { script, numKeys, args };
      calls.push(call);
      return Promise.resolve().then(() => handler(call));
    },
  };
}
/** A bad reply may only fail closed or refuse: it must never be an allow. */
async function neverAllowed(limiter: ValkeyRateLimiter, rules: RateRule[]): Promise<void> {
  const outcome = await limiter.consume(rules).then(
    (decision) => decision,
    (err: unknown) => err,
  );
  if (outcome instanceof RateLimiterUnavailableError) return;
  expect((outcome as RateDecision).allowed).toBe(false);
}

describe('RATE_LIMIT_SCRIPT', () => {
  it('is a non-empty Lua source that checks every key before it increments any', () => {
    expect(typeof RATE_LIMIT_SCRIPT).toBe('string');
    expect(RATE_LIMIT_SCRIPT.trim().length).toBeGreaterThan(100);
    expect(RATE_LIMIT_SCRIPT).toContain('INCRBY');
    expect(RATE_LIMIT_SCRIPT).toContain('PEXPIRE');
    expect(RATE_LIMIT_SCRIPT).toContain('PTTL');
    expect(RATE_LIMIT_SCRIPT).toContain("redis.call('GET'");
    expect(RATE_LIMIT_SCRIPT.indexOf("redis.call('GET'")).toBeLessThan(RATE_LIMIT_SCRIPT.indexOf('INCRBY'));
    expect(RATE_LIMIT_SCRIPT.indexOf('return {0, i, ttl}')).toBeLessThan(RATE_LIMIT_SCRIPT.indexOf('INCRBY'));
  });
  it('returns the three-element reply the limiter parses', () => {
    expect(RATE_LIMIT_SCRIPT).toContain('return {1, 0, 0}');
    expect(RATE_LIMIT_SCRIPT).toContain('return {0, i, ttl}');
  });
  it('sets an expiry on a counter that has none, so no key can live forever', () => {
    expect(RATE_LIMIT_SCRIPT).toMatch(/PTTL[^\n]*< 0 then[^\n]*PEXPIRE/);
  });
});

describe('ValkeyRateLimiter: the script call', () => {
  it('passes the script, the number of keys, the prefixed keys in rule order, then limit and window per rule, then the cost', async () => {
    const client = fakeClient();
    const limiter = new ValkeyRateLimiter(client);
    const rules = [
      rule({ name: 'ev:account', key: 'acct-1', limit: 30, windowSeconds: 3600 }),
      rule({ name: 'ev:address', key: 'hash-9', limit: 5, windowSeconds: 86_400 }),
      rule({ name: 'ev:ip', key: 'ip.hash', limit: 100, windowSeconds: 60 }),
    ];
    await limiter.consume(rules);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual({
      script: RATE_LIMIT_SCRIPT,
      numKeys: 3,
      args: ['bananagig:rl:ev:account:acct-1', 'bananagig:rl:ev:address:hash-9', 'bananagig:rl:ev:ip:ip.hash', 30, 3600, 5, 86_400, 100, 60, 1],
    });
  });
  it('builds each key as <prefix><name>:<key>', async () => {
    const client = fakeClient();
    await new ValkeyRateLimiter(client).consume([rule({ name: 'a:b', key: 'c:d' })]);
    expect(client.calls[0]!.args[0]).toBe('bananagig:rl:a:b:c:d');
  });
  it('uses a custom prefix', async () => {
    const client = fakeClient();
    await new ValkeyRateLimiter(client, { prefix: 'test-prefix:' }).consume([rule({ name: 'n', key: 'k' })]);
    expect(client.calls[0]!.args[0]).toBe('test-prefix:n:k');
  });
  it('passes the cost last, after every limit/window pair', async () => {
    const client = fakeClient();
    const limiter = new ValkeyRateLimiter(client);
    await limiter.consume([rule({ name: 'a:x', limit: 7, windowSeconds: 70 })], { cost: 3 });
    expect(client.calls[0]!.args).toEqual(['bananagig:rl:a:x:acct-1', 7, 70, 3]);
    await limiter.consume([rule({ name: 'a:x' }), rule({ name: 'a:y' })], { cost: 4 });
    expect(client.calls[1]!.args.slice(-1)).toEqual([4]);
    expect(client.calls[1]!.numKeys).toBe(2);
    expect(client.calls[1]!.args).toHaveLength(2 + 2 * 2 + 1);
  });
  it('defaults the cost to one', async () => {
    const client = fakeClient();
    await new ValkeyRateLimiter(client).consume([rule()]);
    expect(client.calls[0]!.args.slice(-1)).toEqual([1]);
  });
  it('makes exactly one round trip per consume, whatever the number of rules', async () => {
    const client = fakeClient();
    await new ValkeyRateLimiter(client).consume(Array.from({ length: 8 }, (_, i) => rule({ name: `r:${i}` })));
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.numKeys).toBe(8);
  });
  it('never puts a raw address in a key unless the caller did (keys are opaque, validated characters)', async () => {
    const client = fakeClient();
    await expect(new ValkeyRateLimiter(client).consume([rule({ key: 'someone@example.com/path' })])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    expect(client.calls).toHaveLength(0);
  });
});

describe('ValkeyRateLimiter: replies', () => {
  const two = [rule({ name: 'v:one', limit: 5 }), rule({ name: 'v:two', limit: 5 }), rule({ name: 'v:three', limit: 5 })];

  it('parses [1, 0, 0] as allowed', async () => {
    const decision = await new ValkeyRateLimiter(fakeClient(() => [1, 0, 0])).consume(two);
    expect(decision).toStrictEqual(allowed);
  });
  it.each([
    [1, 'v:one'],
    [2, 'v:two'],
    [3, 'v:three'],
  ])('parses [0, %s, ms] as refused by %s', async (index, name) => {
    const decision = await new ValkeyRateLimiter(fakeClient(() => [0, index, 12_000])).consume(two);
    expect(decision).toStrictEqual({ allowed: false, limitedBy: name, retryAfterSeconds: 12 });
  });
  it.each([
    [0, 1],
    [1, 1],
    [500, 1],
    [999, 1],
    [1000, 1],
    [1001, 2],
    [1999, 2],
    [2000, 2],
    [59_001, 60],
    [60_000, 60],
    [3_600_000, 3600],
    [86_400_000, 86_400],
    [-1, 1],
    [-2000, 1],
  ])('turns %s ms into %s second(s): rounded up, at least one', async (ms, seconds) => {
    const decision = await new ValkeyRateLimiter(fakeClient(() => [0, 1, ms])).consume(two);
    expect(decision.retryAfterSeconds).toBe(seconds);
    expect(decision.allowed).toBe(false);
  });
  it('accepts numbers delivered as strings (some clients return bulk strings)', async () => {
    expect(await new ValkeyRateLimiter(fakeClient(() => ['1', '0', '0'])).consume(two)).toStrictEqual(allowed);
    expect(await new ValkeyRateLimiter(fakeClient(() => ['0', '2', '1500'])).consume(two)).toStrictEqual({
      allowed: false,
      limitedBy: 'v:two',
      retryAfterSeconds: 2,
    });
  });
  it('is never an allow for a reply whose first element is not 1', async () => {
    for (const first of [0, 2, -1, 'no', null, undefined, '', Number.NaN]) {
      const decision = await new ValkeyRateLimiter(fakeClient(() => [first, 1, 1000])).consume(two);
      expect(decision.allowed, String(first)).toBe(false);
    }
  });
  it('reports a refusal without a rule name when the index is outside the rules, but still refuses', async () => {
    for (const index of [0, 4, 99, -1]) {
      const decision = await new ValkeyRateLimiter(fakeClient(() => [0, index, 1000])).consume(two);
      expect(decision.allowed, String(index)).toBe(false);
      expect(decision.limitedBy, String(index)).toBeUndefined();
    }
  });
  it.each([
    ['a number', 1],
    ['a string', 'OK'],
    ['null', null],
    ['undefined', undefined],
    ['an object', { allowed: 1 }],
    ['an empty array', []],
    ['an array of one', [1]],
    ['an array of two', [1, 0]],
    ['an array of four', [1, 0, 0, 0]],
    ['a nested array', [[1, 0, 0]]],
  ])('a malformed reply (%s) is RateLimiterUnavailableError, never an allow', async (_label, reply) => {
    const limiter = new ValkeyRateLimiter(fakeClient(() => reply));
    await expect(limiter.consume(two)).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });
  it('never allows for a reply of the right length whose content is garbage', async () => {
    const replies: unknown[] = [
      ['x', 'y', 'z'],
      [Number.NaN, 0, 0],
      [[], [], []],
      [{}, {}, {}],
      ['yes', 0, 0],
      [2, 0, 0],
      [-1, 0, 0],
      [0, 'x', 'y'],
    ];
    for (const reply of replies) await neverAllowed(new ValkeyRateLimiter(fakeClient(() => reply)), two);
  });
});

describe('ValkeyRateLimiter: failures fail closed', () => {
  afterEach(() => vi.useRealTimers());

  it('turns a rejected command into RateLimiterUnavailableError without leaking the cause', async () => {
    const limiter = new ValkeyRateLimiter(
      fakeClient(() => {
        throw new Error('ECONNREFUSED 10.0.0.9:6379 password=hunter2');
      }),
    );
    const err = await limiter.consume([rule()]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimiterUnavailableError);
    expect((err as Error).message).toBe('the rate limiter is unavailable');
    expect(JSON.stringify(err) + String(err) + (err as Error).stack).not.toContain('hunter2');
  });
  it.each([
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 5],
  ])('turns a command rejected with %s into RateLimiterUnavailableError', async (_label, thrown) => {
    const limiter = new ValkeyRateLimiter(fakeClient(() => Promise.reject(thrown)));
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });
  it('turns a client that throws before returning a promise into RateLimiterUnavailableError', async () => {
    const limiter = new ValkeyRateLimiter({
      eval(): Promise<unknown> {
        throw new Error('client closed');
      },
    });
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });
  it('gives up after the command timeout (150 ms by default) with RateLimiterUnavailableError', async () => {
    vi.useFakeTimers();
    const client = fakeClient(() => new Promise(() => undefined));
    const limiter = new ValkeyRateLimiter(client);
    let settled = false;
    const result = limiter.consume([rule()]).then(
      () => {
        settled = true;
        return 'allowed';
      },
      (err: unknown) => {
        settled = true;
        return err;
      },
    );
    await vi.advanceTimersByTimeAsync(149);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await result).toBeInstanceOf(RateLimiterUnavailableError);
  });
  it('honors a custom command timeout', async () => {
    vi.useFakeTimers();
    const limiter = new ValkeyRateLimiter(
      fakeClient(() => new Promise(() => undefined)),
      { commandTimeoutMs: 1000 },
    );
    const result = limiter.consume([rule()]).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeInstanceOf(RateLimiterUnavailableError);
  });
  it('leaves no timer behind after a success or a failure', async () => {
    vi.useFakeTimers();
    await new ValkeyRateLimiter(fakeClient()).consume([rule()]);
    expect(vi.getTimerCount()).toBe(0);
    await new ValkeyRateLimiter(fakeClient(() => Promise.reject(new Error('x')))).consume([rule()]).catch(() => undefined);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('raises no unhandled rejection when the command rejects LATE, after the timeout already failed the call', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      let rejectLate: (e: Error) => void = () => undefined;
      const client = fakeClient(() => new Promise((_, reject) => (rejectLate = reject)));
      const limiter = new ValkeyRateLimiter(client, { commandTimeoutMs: 5 });
      await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
      rejectLate(new Error('late failure'));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
  it('ignores a late SUCCESS after the timeout: the call stays failed and the breaker stays open', async () => {
    const clock = { now: 10_000 };
    let resolveLate: (v: unknown) => void = () => undefined;
    let hang = true;
    const client = fakeClient(() => (hang ? new Promise((resolve) => (resolveLate = resolve)) : [1, 0, 0]));
    const limiter = new ValkeyRateLimiter(client, { commandTimeoutMs: 5, breakerCooldownMs: 2000, now: () => clock.now });
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    hang = false;
    resolveLate([1, 0, 0]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    clock.now += 1000;
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    expect(client.calls).toHaveLength(1);
  });
});

describe('ValkeyRateLimiter: circuit breaker', () => {
  function breakerSetup(cooldown = 2000) {
    const clock = { now: 10_000 };
    let mode: 'fail' | 'ok' = 'fail';
    const client = fakeClient(() => (mode === 'fail' ? Promise.reject(new Error('down')) : [1, 0, 0]));
    const limiter = new ValkeyRateLimiter(client, { breakerCooldownMs: cooldown, now: () => clock.now });
    return { clock, client, limiter, setMode: (m: 'fail' | 'ok') => (mode = m) };
  }

  it('after one failure, calls fail immediately WITHOUT touching the client until the cooldown ends', async () => {
    const { clock, client, limiter } = breakerSetup();
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    expect(client.calls).toHaveLength(1);
    for (const advance of [0, 1, 500, 1999]) {
      clock.now = 10_000 + advance;
      await expect(limiter.consume([rule()]), `${advance} ms`).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    }
    expect(client.calls).toHaveLength(1);
  });
  it('lets exactly one probe through when the cooldown ends, and a successful probe closes the breaker', async () => {
    const { clock, client, limiter, setMode } = breakerSetup();
    await limiter.consume([rule()]).catch(() => undefined);
    setMode('ok');
    clock.now = 10_000 + 2000;
    expect(await limiter.consume([rule()])).toStrictEqual(allowed);
    expect(client.calls).toHaveLength(2);
    // closed: every call reaches the client again, with no clock movement
    expect(await limiter.consume([rule()])).toStrictEqual(allowed);
    expect(await limiter.consume([rule()])).toStrictEqual(allowed);
    expect(client.calls).toHaveLength(4);
  });
  it('holds every other call back while the probe is in flight', async () => {
    const clock = { now: 10_000 };
    let release: (v: unknown) => void = () => undefined;
    let phase: 'fail' | 'probe' | 'ok' = 'fail';
    const client = fakeClient(() => {
      if (phase === 'fail') return Promise.reject(new Error('down'));
      if (phase === 'probe') return new Promise((resolve) => (release = resolve));
      return [1, 0, 0];
    });
    const limiter = new ValkeyRateLimiter(client, { breakerCooldownMs: 2000, commandTimeoutMs: 10_000, now: () => clock.now });
    await limiter.consume([rule()]).catch(() => undefined);
    clock.now += 2000;
    phase = 'probe';
    const probe = limiter.consume([rule()]);
    await Promise.resolve();
    expect(client.calls).toHaveLength(2);
    for (let i = 0; i < 5; i++) await expect(limiter.consume([rule()]), `concurrent ${i + 1}`).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    expect(client.calls).toHaveLength(2);
    phase = 'ok';
    release([1, 0, 0]);
    expect(await probe).toStrictEqual(allowed);
    expect(await limiter.consume([rule()])).toStrictEqual(allowed);
    expect(client.calls).toHaveLength(3);
  });
  it('re-opens for a full cooldown when the probe fails', async () => {
    const { clock, client, limiter } = breakerSetup();
    await limiter.consume([rule()]).catch(() => undefined);
    clock.now += 2000;
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError); // the probe, fails
    expect(client.calls).toHaveLength(2);
    clock.now += 1999;
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    expect(client.calls).toHaveLength(2);
    clock.now += 1;
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError); // the next probe
    expect(client.calls).toHaveLength(3);
  });
  it('lets a new probe through after a failed probe once its cooldown ends', async () => {
    const { clock, client, limiter, setMode } = breakerSetup();
    await limiter.consume([rule()]).catch(() => undefined);
    clock.now += 2000;
    await limiter.consume([rule()]).catch(() => undefined);
    setMode('ok');
    clock.now += 2000;
    expect(await limiter.consume([rule()])).toStrictEqual(allowed);
    expect(client.calls).toHaveLength(3);
  });
  it('honors a custom cooldown', async () => {
    const { clock, client, limiter } = breakerSetup(500);
    await limiter.consume([rule()]).catch(() => undefined);
    clock.now += 499;
    await limiter.consume([rule()]).catch(() => undefined);
    expect(client.calls).toHaveLength(1);
    clock.now += 1;
    await limiter.consume([rule()]).catch(() => undefined);
    expect(client.calls).toHaveLength(2);
  });
  it('uses a two-second cooldown by default', async () => {
    const clock = { now: 50_000 };
    const client = fakeClient(() => Promise.reject(new Error('down')));
    const limiter = new ValkeyRateLimiter(client, { now: () => clock.now });
    await limiter.consume([rule()]).catch(() => undefined);
    clock.now += 1999;
    await limiter.consume([rule()]).catch(() => undefined);
    expect(client.calls).toHaveLength(1);
    clock.now += 1;
    await limiter.consume([rule()]).catch(() => undefined);
    expect(client.calls).toHaveLength(2);
  });
  it('is opened by a timeout as well as by a rejection', async () => {
    const clock = { now: 10_000 };
    const client = fakeClient(() => new Promise(() => undefined));
    const limiter = new ValkeyRateLimiter(client, { commandTimeoutMs: 5, now: () => clock.now });
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    expect(client.calls).toHaveLength(1);
  });
  it('is opened by a malformed reply too', async () => {
    const clock = { now: 10_000 };
    const client = fakeClient(() => 'garbage');
    const limiter = new ValkeyRateLimiter(client, { now: () => clock.now });
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    expect(client.calls).toHaveLength(1);
  });
  it('is NOT opened by a refusal: a refused request is a healthy answer', async () => {
    const clock = { now: 10_000 };
    const client = fakeClient(() => [0, 1, 5000]);
    const limiter = new ValkeyRateLimiter(client, { now: () => clock.now });
    for (let i = 0; i < 4; i++) expect((await limiter.consume([rule()])).allowed).toBe(false);
    expect(client.calls).toHaveLength(4);
  });
  it('is NOT opened by invalid rules, which are refused before any command is issued', async () => {
    const { client, limiter, setMode } = breakerSetup();
    setMode('ok');
    await expect(limiter.consume([])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    await expect(limiter.consume([rule({ name: 'Bad Name' })])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    await expect(limiter.consume([rule()], { cost: 0 })).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    expect(client.calls).toHaveLength(0);
    expect(await limiter.consume([rule()])).toStrictEqual(allowed);
    expect(client.calls).toHaveLength(1);
  });
  it('short-circuits every rule set while open, whatever the rules are', async () => {
    const { clock, client, limiter } = breakerSetup();
    await limiter.consume([rule()]).catch(() => undefined);
    clock.now += 1;
    await expect(limiter.consume([rule({ name: 'other:rule', key: 'other' })])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    await expect(limiter.consume([rule(), rule({ name: 'b:two' })], { cost: 3 })).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    expect(client.calls).toHaveLength(1);
  });
  it('a success while closed does not disturb a healthy limiter (no cooldown is ever applied)', async () => {
    const clock = { now: 10_000 };
    const client = fakeClient();
    const limiter = new ValkeyRateLimiter(client, { now: () => clock.now });
    for (let i = 0; i < 5; i++) expect(await limiter.consume([rule()])).toStrictEqual(allowed);
    expect(client.calls).toHaveLength(5);
  });
});
