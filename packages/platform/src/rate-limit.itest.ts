// Integration tests of the Valkey rate limiter against a REAL Valkey (pnpm dev:deps): the Lua script is the unit under test here, because atomicity cannot
// be proven with a fake. Every test uses its own random key prefix so tests (and repeated runs) never share a counter, and the file removes its keys at the
// end. The unit tests (rate-limit.test.ts) cover the key layout, reply parsing and the breaker against a fake client.
import { randomUUID } from 'node:crypto';
import { Redis } from 'iovalkey';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RateLimiterUnavailableError, ValkeyRateLimiter, type RateRule } from './rate-limit';

const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://127.0.0.1:16379';
const FILE_PREFIX = `bananagig:rltest:${randomUUID()}:`;

let client: Redis;
const extraClients: Redis[] = [];

beforeAll(async () => {
  client = new Redis(VALKEY_URL, { maxRetriesPerRequest: 2 });
  client.on('error', () => undefined);
  expect(await client.ping(), `Valkey must be reachable at ${VALKEY_URL} (pnpm dev:deps)`).toBe('PONG');
});
afterAll(async () => {
  if (client && client.status === 'ready') {
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${FILE_PREFIX}*`, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await client.del(...keys);
    } while (cursor !== '0');
  }
  for (const extra of extraClients) extra.disconnect();
  if (client) await client.quit().catch(() => client.disconnect());
});

// ---------------------------------------------------------------- helpers
/** A limiter on its own random prefix, so no two tests share a counter. */
function fresh(options: { commandTimeoutMs?: number } = {}) {
  const prefix = `${FILE_PREFIX}${randomUUID()}:`;
  const limiter = new ValkeyRateLimiter(client, { prefix, commandTimeoutMs: options.commandTimeoutMs ?? 5000 });
  const keyOf = (rule: Pick<RateRule, 'name' | 'key'>) => `${prefix}${rule.name}:${rule.key}`;
  return {
    prefix,
    limiter,
    keyOf,
    count: async (rule: Pick<RateRule, 'name' | 'key'>) => client.get(keyOf(rule)),
    pttl: async (rule: Pick<RateRule, 'name' | 'key'>) => client.pttl(keyOf(rule)),
  };
}
const rule = (over: Partial<RateRule> = {}): RateRule => ({ name: 'itest:account', key: 'acct-1', limit: 5, windowSeconds: 100, ...over });

// ====================================================================== atomicity
describe('ValkeyRateLimiter against a real Valkey: atomicity', () => {
  it('lets exactly the limit through when 20 requests race for 5 slots', async () => {
    const { limiter, count } = fresh();
    const r = rule({ limit: 5 });
    const decisions = await Promise.all(Array.from({ length: 20 }, () => limiter.consume([r])));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(5);
    const refused = decisions.filter((d) => !d.allowed);
    expect(refused).toHaveLength(15);
    for (const d of refused) {
      expect(d.limitedBy).toBe(r.name);
      expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(d.retryAfterSeconds).toBeLessThanOrEqual(r.windowSeconds);
    }
    expect(await count(r)).toBe('5'); // refused requests counted nothing
  });
  it('holds across two separate connections racing for the same counter', async () => {
    const prefix = `${FILE_PREFIX}${randomUUID()}:`;
    const other = new Redis(VALKEY_URL, { maxRetriesPerRequest: 2 });
    other.on('error', () => undefined);
    extraClients.push(other);
    const a = new ValkeyRateLimiter(client, { prefix, commandTimeoutMs: 5000 });
    const b = new ValkeyRateLimiter(other, { prefix, commandTimeoutMs: 5000 });
    const r = rule({ limit: 7 });
    const decisions = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b).consume([r])));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(7);
    expect(await client.get(`${prefix}${r.name}:${r.key}`)).toBe('7');
  });
  it('lets exactly the limit through under a cost larger than one', async () => {
    const { limiter, count } = fresh();
    const r = rule({ limit: 10 });
    const decisions = await Promise.all(Array.from({ length: 12 }, () => limiter.consume([r], { cost: 3 })));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(3); // 3 x 3 = 9; a fourth would reach 12
    expect(await count(r)).toBe('9');
  });
  it('is atomic across SEVERAL rules: 30 racing requests, the tightest rule decides, the wider rule is charged only for the allowed ones', async () => {
    const { limiter, count } = fresh();
    const wide = rule({ name: 'itest:wide', limit: 10 });
    const narrow = rule({ name: 'itest:narrow', limit: 3 });
    const decisions = await Promise.all(Array.from({ length: 30 }, () => limiter.consume([wide, narrow])));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(3);
    for (const d of decisions.filter((x) => !x.allowed)) expect(d.limitedBy).toBe('itest:narrow');
    expect(await count(wide)).toBe('3'); // not 10, not 30
    expect(await count(narrow)).toBe('3');
  });
  it('keeps independent keys independent under load', async () => {
    const { limiter } = fresh();
    const rules = Array.from({ length: 5 }, (_, i) => rule({ key: `acct-${i}`, limit: 2 }));
    const decisions = await Promise.all(rules.flatMap((r) => Array.from({ length: 6 }, () => limiter.consume([r]).then((d) => ({ key: r.key, d })))));
    for (const r of rules)
      expect(
        decisions.filter((x) => x.key === r.key && x.d.allowed),
        r.key,
      ).toHaveLength(2);
  });
});

// ====================================================================== all-or-nothing
describe('ValkeyRateLimiter against a real Valkey: several rules are all-or-nothing', () => {
  it('does not move the counter of a rule that had room when another rule refuses (verified with GET)', async () => {
    const { limiter, count } = fresh();
    const a = rule({ name: 'itest:a', limit: 5 });
    const b = rule({ name: 'itest:b', limit: 1 });
    expect(await limiter.consume([a, b])).toStrictEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await count(a)).toBe('1');
    expect(await count(b)).toBe('1');
    for (let i = 0; i < 5; i++) {
      const refused = await limiter.consume([a, b]);
      expect(refused.allowed).toBe(false);
      expect(refused.limitedBy).toBe('itest:b');
    }
    expect(await count(a)).toBe('1'); // the five refusals charged nothing
    expect(await count(b)).toBe('1');
    // so a still holds exactly four more
    for (let i = 0; i < 4; i++) expect((await limiter.consume([a])).allowed, `a ${i + 1}`).toBe(true);
    expect((await limiter.consume([a])).allowed).toBe(false);
    expect(await count(a)).toBe('5');
  });
  it('is all-or-nothing whichever position the exhausted rule has', async () => {
    for (const exhaustedFirst of [true, false]) {
      const { limiter, count } = fresh();
      const full = rule({ name: 'itest:full', limit: 1 });
      const roomy = rule({ name: 'itest:roomy', limit: 9 });
      await limiter.consume([full]);
      const refused = await limiter.consume(exhaustedFirst ? [full, roomy] : [roomy, full]);
      expect(refused.limitedBy, String(exhaustedFirst)).toBe('itest:full');
      expect(await count(roomy), String(exhaustedFirst)).toBeNull(); // never even created
    }
  });
  it('does not create the counters of a refused request', async () => {
    const { limiter, keyOf } = fresh();
    const full = rule({ name: 'itest:full', limit: 1 });
    const other = rule({ name: 'itest:other', limit: 9 });
    await limiter.consume([full]);
    await limiter.consume([other, full]);
    expect(await client.exists(keyOf(other))).toBe(0);
  });
  it('names the FIRST refusing rule and reports ITS retry time', async () => {
    const { limiter, keyOf } = fresh();
    const short = rule({ name: 'itest:short', limit: 1, windowSeconds: 100 });
    const long = rule({ name: 'itest:long', limit: 1, windowSeconds: 1000 });
    await limiter.consume([short]);
    await limiter.consume([long]);
    const shortFirst = await limiter.consume([short, long]);
    expect(shortFirst.limitedBy).toBe('itest:short');
    expect(shortFirst.retryAfterSeconds).toBeGreaterThanOrEqual(99);
    expect(shortFirst.retryAfterSeconds).toBeLessThanOrEqual(100);
    const longFirst = await limiter.consume([long, short]);
    expect(longFirst.limitedBy).toBe('itest:long');
    expect(longFirst.retryAfterSeconds).toBeGreaterThanOrEqual(999);
    expect(longFirst.retryAfterSeconds).toBeLessThanOrEqual(1000);
    expect(await client.pttl(keyOf(short))).toBeLessThanOrEqual(100_000);
  });
  it('charges every one of eight rules exactly once', async () => {
    const { limiter, count } = fresh();
    const rules = Array.from({ length: 8 }, (_, i) => rule({ name: `itest:r${i}`, limit: 3 }));
    expect((await limiter.consume(rules)).allowed).toBe(true);
    for (const r of rules) expect(await count(r), r.name).toBe('1');
  });
  it('applies the cost to every rule and refuses without charging when any rule cannot take it', async () => {
    const { limiter, count } = fresh();
    const wide = rule({ name: 'itest:wide', limit: 10 });
    const narrow = rule({ name: 'itest:narrow', limit: 5 });
    expect((await limiter.consume([wide, narrow], { cost: 3 })).allowed).toBe(true);
    expect(await count(wide)).toBe('3');
    expect(await count(narrow)).toBe('3');
    const refused = await limiter.consume([wide, narrow], { cost: 3 }); // narrow: 3 + 3 > 5
    expect(refused.limitedBy).toBe('itest:narrow');
    expect(await count(wide)).toBe('3');
    expect(await count(narrow)).toBe('3');
    expect((await limiter.consume([wide, narrow], { cost: 2 })).allowed).toBe(true);
    expect(await count(narrow)).toBe('5');
  });
});

// ====================================================================== cost
describe('ValkeyRateLimiter against a real Valkey: cost', () => {
  it('counts the cost against the limit', async () => {
    const { limiter, count } = fresh();
    const r = rule({ limit: 10 });
    expect((await limiter.consume([r], { cost: 4 })).allowed).toBe(true);
    expect(await count(r)).toBe('4');
    expect((await limiter.consume([r], { cost: 4 })).allowed).toBe(true);
    expect(await count(r)).toBe('8');
    expect((await limiter.consume([r], { cost: 4 })).allowed).toBe(false);
    expect(await count(r)).toBe('8');
    expect((await limiter.consume([r], { cost: 2 })).allowed).toBe(true);
    expect(await count(r)).toBe('10');
    expect((await limiter.consume([r], { cost: 1 })).allowed).toBe(false);
  });
  it('refuses a cost above the limit on a fresh key, creates nothing and reports the whole window', async () => {
    const { limiter, keyOf } = fresh();
    const r = rule({ limit: 3, windowSeconds: 77 });
    const refused = await limiter.consume([r], { cost: 4 });
    expect(refused).toStrictEqual({ allowed: false, limitedBy: r.name, retryAfterSeconds: 77 });
    expect(await client.exists(keyOf(r))).toBe(0);
  });
  it('allows a cost equal to the limit exactly once', async () => {
    const { limiter } = fresh();
    const r = rule({ limit: 4 });
    expect((await limiter.consume([r], { cost: 4 })).allowed).toBe(true);
    expect((await limiter.consume([r], { cost: 1 })).allowed).toBe(false);
  });
});

// ====================================================================== expiry
describe('ValkeyRateLimiter against a real Valkey: expiry', () => {
  it('sets a TTL on the first hit: positive and never longer than the window', async () => {
    const { limiter, pttl, keyOf } = fresh();
    const r = rule({ windowSeconds: 100 });
    expect(await client.exists(keyOf(r))).toBe(0);
    await limiter.consume([r]);
    const ttl = await pttl(r);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(100_000);
    expect(ttl).toBeGreaterThan(90_000);
  });
  it('gives every rule of a request its own window length', async () => {
    const { limiter, pttl } = fresh();
    const minute = rule({ name: 'itest:minute', windowSeconds: 60 });
    const hour = rule({ name: 'itest:hour', windowSeconds: 3600 });
    await limiter.consume([minute, hour]);
    expect(await pttl(minute)).toBeLessThanOrEqual(60_000);
    expect(await pttl(minute)).toBeGreaterThan(50_000);
    expect(await pttl(hour)).toBeLessThanOrEqual(3_600_000);
    expect(await pttl(hour)).toBeGreaterThan(3_500_000);
  });
  it('does not push the window back on later hits: the window starts at the first hit', async () => {
    const { limiter, pttl, keyOf } = fresh();
    const r = rule({ limit: 10, windowSeconds: 100 });
    await limiter.consume([r]);
    await client.pexpire(keyOf(r), 5000); // pretend most of the window has passed
    await limiter.consume([r]);
    await limiter.consume([r], { cost: 2 });
    const ttl = await pttl(r);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5000);
  });
  it('gives a counter that has no TTL one on its next allowed hit, and keeps counting from its value', async () => {
    const { limiter, pttl, count, keyOf } = fresh();
    const r = rule({ limit: 5, windowSeconds: 120 });
    await client.set(keyOf(r), '2'); // no expiry: a counter that lost its TTL
    expect(await pttl(r)).toBe(-1);
    expect((await limiter.consume([r])).allowed).toBe(true);
    expect(await count(r)).toBe('3');
    const ttl = await pttl(r);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120_000);
  });
  it('reports the whole window as the retry time for a refused counter that has no TTL', async () => {
    const { limiter, keyOf } = fresh();
    const r = rule({ limit: 3, windowSeconds: 45 });
    await client.set(keyOf(r), '3');
    const refused = await limiter.consume([r]);
    expect(refused).toStrictEqual({ allowed: false, limitedBy: r.name, retryAfterSeconds: 45 });
  });
  it('lets a counter start over after its window really ends (one 1.2 s wait)', async () => {
    const { limiter, count } = fresh();
    const r = rule({ limit: 2, windowSeconds: 1 });
    expect((await limiter.consume([r])).allowed).toBe(true);
    expect((await limiter.consume([r])).allowed).toBe(true);
    const refused = await limiter.consume([r]);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await count(r)).toBeNull(); // the key expired by itself
    expect((await limiter.consume([r])).allowed).toBe(true);
    expect(await count(r)).toBe('1');
    expect((await limiter.consume([r])).allowed).toBe(true);
    expect((await limiter.consume([r])).allowed).toBe(false);
  });
});

// ====================================================================== retry-after
describe('ValkeyRateLimiter against a real Valkey: retryAfterSeconds', () => {
  it('reflects the remaining TTL of the refusing counter', async () => {
    const { limiter, keyOf } = fresh();
    const r = rule({ limit: 1, windowSeconds: 100 });
    await limiter.consume([r]);
    const fullWindow = await limiter.consume([r]);
    expect(fullWindow.retryAfterSeconds).toBeGreaterThanOrEqual(99);
    expect(fullWindow.retryAfterSeconds).toBeLessThanOrEqual(100);
    await client.pexpire(keyOf(r), 30_000);
    const thirty = await limiter.consume([r]);
    expect(thirty.retryAfterSeconds).toBeGreaterThanOrEqual(29);
    expect(thirty.retryAfterSeconds).toBeLessThanOrEqual(30);
    await client.pexpire(keyOf(r), 5500);
    const six = await limiter.consume([r]);
    expect(six.retryAfterSeconds).toBeGreaterThanOrEqual(5);
    expect(six.retryAfterSeconds).toBeLessThanOrEqual(6);
  });
  it('never reports less than one second, even with milliseconds left', async () => {
    const { limiter, keyOf } = fresh();
    const r = rule({ limit: 1, windowSeconds: 100 });
    await limiter.consume([r]);
    await client.pexpire(keyOf(r), 400);
    const refused = await limiter.consume([r]);
    if (!refused.allowed)
      expect(refused.retryAfterSeconds).toBe(1); // (a slow machine may have let the 400 ms pass)
    else expect(refused.retryAfterSeconds).toBe(0);
  });
  it('reports a whole number of seconds', async () => {
    const { limiter, keyOf } = fresh();
    const r = rule({ limit: 1, windowSeconds: 100 });
    await limiter.consume([r]);
    await client.pexpire(keyOf(r), 12_345);
    const refused = await limiter.consume([r]);
    expect(Number.isInteger(refused.retryAfterSeconds)).toBe(true);
  });
});

// ====================================================================== key layout
describe('ValkeyRateLimiter against a real Valkey: keys', () => {
  it('stores each counter under <prefix><name>:<key>', async () => {
    const { limiter, keyOf } = fresh();
    const a = rule({ name: 'itest:layout', key: 'abc.def_1:x@y=z-9' });
    await limiter.consume([a]);
    expect(await client.get(keyOf(a))).toBe('1');
    expect(keyOf(a)).toMatch(/:itest:layout:abc\.def_1:x@y=z-9$/);
  });
  it('uses the default prefix when none is given', async () => {
    const limiter = new ValkeyRateLimiter(client, { commandTimeoutMs: 5000 });
    const r = rule({ name: 'itest:defaultprefix', key: randomUUID() });
    await limiter.consume([r]);
    try {
      expect(await client.get(`bananagig:rl:${r.name}:${r.key}`)).toBe('1');
    } finally {
      await client.del(`bananagig:rl:${r.name}:${r.key}`);
    }
  });
  it('keeps the same key under two rule names apart', async () => {
    const { limiter } = fresh();
    for (let i = 0; i < 5; i++) await limiter.consume([rule({ name: 'itest:one' })]);
    expect((await limiter.consume([rule({ name: 'itest:one' })])).allowed).toBe(false);
    expect((await limiter.consume([rule({ name: 'itest:two' })])).allowed).toBe(true);
  });
  it('rejects an invalid rule before it reaches Valkey', async () => {
    const { limiter } = fresh();
    await expect(limiter.consume([rule({ key: 'has space' })])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });
});

// ====================================================================== unreachable Valkey
describe('ValkeyRateLimiter against an unreachable Valkey', () => {
  function deadClient() {
    // port 1 refuses connections; lazyConnect keeps the constructor quiet and maxRetriesPerRequest 0 stops the client queueing commands for ever
    const dead = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    dead.on('error', () => undefined);
    extraClients.push(dead);
    return dead;
  }

  it('fails with RateLimiterUnavailableError within the command timeout, and never with an allow', async () => {
    const dead = deadClient();
    const limiter = new ValkeyRateLimiter(dead, { commandTimeoutMs: 300 });
    const started = Date.now();
    const outcome = await limiter.consume([rule()]).then(
      (decision) => decision,
      (err: unknown) => err,
    );
    expect(outcome).toBeInstanceOf(RateLimiterUnavailableError);
    expect(Date.now() - started).toBeLessThan(300 + 700);
  });
  it('then short-circuits: the next calls fail at once without touching the client', async () => {
    const dead = deadClient();
    const evalSpy = vi.spyOn(dead, 'eval');
    const limiter = new ValkeyRateLimiter(dead, { commandTimeoutMs: 300, breakerCooldownMs: 60_000 });
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    expect(evalSpy).toHaveBeenCalledTimes(1);
    const started = Date.now();
    for (let i = 0; i < 5; i++) await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    expect(Date.now() - started).toBeLessThan(100);
    expect(evalSpy).toHaveBeenCalledTimes(1);
  });
  it('fails closed on a client that was closed', async () => {
    const closed = new Redis(VALKEY_URL, { maxRetriesPerRequest: 0 });
    closed.on('error', () => undefined);
    await closed.ping();
    await closed.quit();
    const limiter = new ValkeyRateLimiter(closed, { commandTimeoutMs: 300 });
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });
  it('recovers through the probe once Valkey is reachable again', async () => {
    const clock = { now: 100_000 };
    const prefix = `${FILE_PREFIX}${randomUUID()}:`;
    const flaky = { reachable: false };
    const proxy = {
      eval: (script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> =>
        flaky.reachable ? client.eval(script, numKeys, ...args) : Promise.reject(new Error('unreachable')),
    };
    const limiter = new ValkeyRateLimiter(proxy, { prefix, breakerCooldownMs: 2000, now: () => clock.now, commandTimeoutMs: 5000 });
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    flaky.reachable = true;
    await expect(limiter.consume([rule()])).rejects.toBeInstanceOf(RateLimiterUnavailableError); // still inside the cooldown
    clock.now += 2000;
    expect((await limiter.consume([rule()])).allowed).toBe(true); // the probe reaches the real Valkey
    expect(await client.get(`${prefix}itest:account:acct-1`)).toBe('1');
    expect((await limiter.consume([rule()])).allowed).toBe(true); // closed again
  });
});
