// Unit tests of the channel-neutral verification mechanics (ID-003, ADR-0030): the resend cooldown and the hour/day caps evaluated from a list of timestamps
// (evaluateSendWindows), the construction of the abuse-limit rules (requestRules) and their consumption over the RateLimiter port (consumeRules). Pure
// functions plus the in-memory limiter; no database, no network, no real clock.
import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter, RateLimiterUnavailableError, type RateDecision, type RateLimiter, type RateRule } from '@bananagig/platform';
import { hashDimension } from './email-crypto';
import { ceilSeconds, consumeRules, evaluateSendWindows, requestRules, type SendWindowInput } from './verification-core';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date('2026-03-04T12:00:00.000Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

const input = (over: Partial<SendWindowInput> = {}): SendWindowInput => ({
  lastIssued: null,
  created: [],
  now: NOW,
  resendSeconds: 30,
  maxPerHour: 5,
  maxPerDay: 10,
  ...over,
});
/** `n` creation times spaced `gapMs` apart, the newest `newestAgoMs` before now, oldest first. */
const series = (n: number, newestAgoMs: number, gapMs: number): Date[] => Array.from({ length: n }, (_, i) => ago(newestAgoMs + (n - 1 - i) * gapMs));

// ====================================================================== ceilSeconds
describe('ceilSeconds', () => {
  it.each([
    [1, 1],
    [999, 1],
    [1000, 1],
    [1001, 2],
    [1999, 2],
    [2000, 2],
    [2001, 3],
    [29_999, 30],
    [30_000, 30],
    [30_001, 31],
    [59_999, 60],
    [HOUR, 3600],
    [HOUR + 1, 3601],
    [DAY, 86_400],
  ])('rounds %i ms up to %i seconds', (ms, seconds) => {
    expect(ceilSeconds(ms)).toBe(seconds);
  });
  it.each([0, -1, -999, -100_000, 0.4])('never answers less than one second (%d ms)', (ms) => {
    expect(ceilSeconds(ms)).toBe(1);
  });
});

// ====================================================================== evaluateSendWindows: no history
describe('evaluateSendWindows: nothing to refuse', () => {
  it('allows a first send (no history at all)', () => {
    expect(evaluateSendWindows(input())).toBeNull();
  });
  it('allows a send when the only history is a failed delivery (no lastIssued) older than the cooldown', () => {
    expect(evaluateSendWindows(input({ lastIssued: null, created: [ago(MIN)] }))).toBeNull();
  });
  it('does not apply the cooldown when lastIssued is null, even when a very recent (failed) row exists in created', () => {
    expect(evaluateSendWindows(input({ lastIssued: null, created: [ago(1)] }))).toBeNull();
  });
  it('allows a send when the last issued challenge is older than the cooldown', () => {
    expect(evaluateSendWindows(input({ lastIssued: ago(31 * SEC), created: [ago(31 * SEC)] }))).toBeNull();
  });
});

// ====================================================================== cooldown
describe('evaluateSendWindows: the resend cooldown', () => {
  it('refuses a send in the same instant, with the whole cooldown to wait', () => {
    expect(evaluateSendWindows(input({ lastIssued: NOW, created: [NOW] }))).toEqual({ kind: 'COOLDOWN', retryAfterSeconds: 30 });
  });
  it.each([
    [1, 30],
    [500, 30],
    [999, 30],
    [1000, 29],
    [1001, 29],
    [10_000, 20],
    [10_001, 20],
    [29_000, 1],
    [29_001, 1],
    [29_500, 1],
    [29_999, 1],
  ])('refuses a send %i ms after the last one with a retry-after of %i s', (elapsedMs, retry) => {
    expect(evaluateSendWindows(input({ lastIssued: ago(elapsedMs), created: [ago(elapsedMs)] }))).toEqual({ kind: 'COOLDOWN', retryAfterSeconds: retry });
  });
  it('allows the send exactly at resendSeconds (the boundary is open)', () => {
    expect(evaluateSendWindows(input({ lastIssued: ago(30 * SEC), created: [ago(30 * SEC)] }))).toBeNull();
  });
  it('refuses one millisecond before resendSeconds, with a retry-after of one second', () => {
    expect(evaluateSendWindows(input({ lastIssued: ago(30 * SEC - 1), created: [ago(30 * SEC - 1)] }))).toEqual({ kind: 'COOLDOWN', retryAfterSeconds: 1 });
  });
  it('allows the send one millisecond after resendSeconds', () => {
    expect(evaluateSendWindows(input({ lastIssued: ago(30 * SEC + 1), created: [ago(30 * SEC + 1)] }))).toBeNull();
  });
  it('uses the configured cooldown, not a fixed one', () => {
    const base = { lastIssued: ago(40 * SEC), created: [ago(40 * SEC)] };
    expect(evaluateSendWindows(input({ ...base, resendSeconds: 60 }))).toEqual({ kind: 'COOLDOWN', retryAfterSeconds: 20 });
    expect(evaluateSendWindows(input({ ...base, resendSeconds: 40 }))).toBeNull();
    expect(evaluateSendWindows(input({ ...base, resendSeconds: 41 }))).toEqual({ kind: 'COOLDOWN', retryAfterSeconds: 1 });
    expect(evaluateSendWindows(input({ ...base, resendSeconds: 3600 }))).toEqual({ kind: 'COOLDOWN', retryAfterSeconds: 3560 });
  });
  it('does not apply any cooldown when resendSeconds is 0, even for a send in the same instant', () => {
    expect(evaluateSendWindows(input({ resendSeconds: 0, lastIssued: NOW, created: [NOW] }))).toBeNull();
    expect(evaluateSendWindows(input({ resendSeconds: 0, lastIssued: ago(1), created: [ago(1)] }))).toBeNull();
  });
  it('treats a lastIssued in the future (clock skew) as a cooldown of the full time plus the skew', () => {
    const future = new Date(NOW.getTime() + 5 * SEC);
    expect(evaluateSendWindows(input({ lastIssued: future, created: [future] }))).toEqual({ kind: 'COOLDOWN', retryAfterSeconds: 35 });
  });
  it('never returns a retry-after below one second', () => {
    for (const elapsed of [29_999, 29_998, 29_990]) {
      const r = evaluateSendWindows(input({ lastIssued: ago(elapsed), created: [ago(elapsed)] }));
      expect(r?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });
});

// ====================================================================== hour cap
describe('evaluateSendWindows: the hour cap', () => {
  it('allows a send while the requests in the last hour are below the cap', () => {
    expect(evaluateSendWindows(input({ lastIssued: ago(10 * MIN), created: series(4, 10 * MIN, 5 * MIN) }))).toBeNull();
  });
  it('refuses at the cap (5 in the last hour) and waits until the oldest leaves the window', () => {
    const created = series(5, 10 * MIN, 10 * MIN); // 50, 40, 30, 20, 10 minutes ago
    expect(evaluateSendWindows(input({ lastIssued: ago(10 * MIN), created }))).toEqual({ kind: 'HOUR_CAP', retryAfterSeconds: 10 * 60 });
  });
  it('waits for the (count - cap + 1)-th oldest request when the count exceeds the cap', () => {
    // 7 requests, cap 5: the slot frees when the 3rd oldest (7 - 5 + 1) leaves the window
    const created = [ago(55 * MIN), ago(50 * MIN), ago(45 * MIN), ago(30 * MIN), ago(20 * MIN), ago(10 * MIN), ago(5 * MIN)];
    const r = evaluateSendWindows(input({ lastIssued: ago(5 * MIN), created }));
    expect(r).toEqual({ kind: 'HOUR_CAP', retryAfterSeconds: 15 * 60 });
  });
  it('is the cap-th newest request that decides, whatever the older ones', () => {
    const created = [ago(59 * MIN), ago(58 * MIN), ago(57 * MIN), ago(40 * MIN), ago(30 * MIN), ago(20 * MIN), ago(10 * MIN), ago(5 * MIN)];
    // 8 in the window, cap 5: the 4th oldest (8 - 5 + 1) = 40 minutes ago leaves in 20 minutes
    expect(evaluateSendWindows(input({ lastIssued: ago(5 * MIN), created }))).toEqual({ kind: 'HOUR_CAP', retryAfterSeconds: 20 * 60 });
  });
  it('treats a request exactly one hour old as outside the window', () => {
    const created = [ago(HOUR), ago(40 * MIN), ago(30 * MIN), ago(20 * MIN), ago(10 * MIN)];
    expect(evaluateSendWindows(input({ lastIssued: ago(10 * MIN), created }))).toBeNull();
  });
  it('treats a request one millisecond younger than an hour as inside the window, with a retry-after of one second', () => {
    const created = [ago(HOUR - 1), ago(40 * MIN), ago(30 * MIN), ago(20 * MIN), ago(10 * MIN)];
    expect(evaluateSendWindows(input({ lastIssued: ago(10 * MIN), created }))).toEqual({ kind: 'HOUR_CAP', retryAfterSeconds: 1 });
  });
  it('rounds the retry-after up to the next second', () => {
    const created = [ago(HOUR - 1500), ago(40 * MIN), ago(30 * MIN), ago(20 * MIN), ago(10 * MIN)];
    expect(evaluateSendWindows(input({ lastIssued: ago(10 * MIN), created }))).toEqual({ kind: 'HOUR_CAP', retryAfterSeconds: 2 });
  });
  it('lets a send through one millisecond after the oldest left the window', () => {
    const created = [ago(HOUR + 1), ago(40 * MIN), ago(30 * MIN), ago(20 * MIN), ago(10 * MIN)];
    expect(evaluateSendWindows(input({ lastIssued: ago(10 * MIN), created }))).toBeNull();
  });
  it('uses the configured cap', () => {
    const created = series(3, 10 * MIN, 10 * MIN);
    expect(evaluateSendWindows(input({ maxPerHour: 3, lastIssued: ago(10 * MIN), created }))?.kind).toBe('HOUR_CAP');
    expect(evaluateSendWindows(input({ maxPerHour: 4, lastIssued: ago(10 * MIN), created }))).toBeNull();
  });
  it('with a cap of 1 refuses after one request in the hour and waits for that request to leave', () => {
    expect(evaluateSendWindows(input({ maxPerHour: 1, resendSeconds: 0, created: [ago(20 * MIN)] }))).toEqual({ kind: 'HOUR_CAP', retryAfterSeconds: 40 * 60 });
  });
  it('counts failed deliveries that are part of `created` (they are not part of lastIssued)', () => {
    const created = series(5, 2 * MIN, MIN);
    expect(evaluateSendWindows(input({ lastIssued: null, created }))).toEqual({ kind: 'HOUR_CAP', retryAfterSeconds: (60 - 6) * 60 });
  });
  it('ignores requests older than the hour for the hour cap', () => {
    const created = [ago(3 * HOUR), ago(2 * HOUR), ago(90 * MIN), ago(70 * MIN), ago(61 * MIN), ago(10 * MIN)];
    expect(evaluateSendWindows(input({ lastIssued: ago(10 * MIN), created }))).toBeNull();
  });
});

// ====================================================================== day cap
describe('evaluateSendWindows: the day cap', () => {
  const wide = { maxPerHour: 1000, resendSeconds: 0 };
  it('allows a send while the requests in the last day are below the cap', () => {
    expect(evaluateSendWindows(input({ ...wide, maxPerDay: 4, created: series(3, 2 * HOUR, 3 * HOUR) }))).toBeNull();
  });
  it('refuses at the cap (10 in the last day) and waits until the oldest leaves the window', () => {
    const created = series(10, 2 * HOUR, 2 * HOUR); // 20, 18, ... 2 hours ago
    expect(evaluateSendWindows(input({ ...wide, maxPerDay: 10, created }))).toEqual({ kind: 'DAY_CAP', retryAfterSeconds: 4 * 3600 });
  });
  it('waits for the (count - cap + 1)-th oldest request when the count exceeds the cap', () => {
    const created = [ago(23 * HOUR), ago(20 * HOUR), ago(15 * HOUR), ago(10 * HOUR), ago(5 * HOUR)];
    // 5 in the window, cap 3: the 3rd oldest (5 - 3 + 1) = 15 hours ago leaves in 9 hours
    expect(evaluateSendWindows(input({ ...wide, maxPerDay: 3, created }))).toEqual({ kind: 'DAY_CAP', retryAfterSeconds: 9 * 3600 });
  });
  it('treats a request exactly 24 hours old as outside the window', () => {
    const created = [ago(DAY), ago(10 * HOUR), ago(5 * HOUR)];
    expect(evaluateSendWindows(input({ ...wide, maxPerDay: 3, created }))).toBeNull();
  });
  it('treats a request one millisecond younger than 24 hours as inside the window', () => {
    const created = [ago(DAY - 1), ago(10 * HOUR), ago(5 * HOUR)];
    expect(evaluateSendWindows(input({ ...wide, maxPerDay: 3, created }))).toEqual({ kind: 'DAY_CAP', retryAfterSeconds: 1 });
  });
  it('ignores requests older than a day for the day cap', () => {
    const created = [ago(5 * DAY), ago(3 * DAY), ago(2 * DAY), ago(25 * HOUR), ago(5 * HOUR)];
    expect(evaluateSendWindows(input({ ...wide, maxPerDay: 2, created }))).toBeNull();
  });
  it('counts the requests of the last hour towards the day as well', () => {
    const created = series(3, 5 * MIN, 5 * MIN);
    expect(evaluateSendWindows(input({ ...wide, maxPerDay: 3, created }))).toEqual({ kind: 'DAY_CAP', retryAfterSeconds: Math.ceil((DAY - 15 * MIN) / SEC) });
  });
  it('with a day cap of 1 refuses after one request in the day', () => {
    expect(evaluateSendWindows(input({ ...wide, maxPerDay: 1, created: [ago(2 * HOUR)] }))).toEqual({ kind: 'DAY_CAP', retryAfterSeconds: 22 * 3600 });
  });
});

// ====================================================================== precedence
describe('evaluateSendWindows: cooldown, then hour cap, then day cap', () => {
  const overHourAndDay = series(12, 20 * SEC, 4 * MIN); // newest 20 s ago, 12 requests in under an hour
  it('reports the cooldown when all three would refuse', () => {
    const r = evaluateSendWindows(input({ lastIssued: ago(20 * SEC), created: overHourAndDay, maxPerHour: 5, maxPerDay: 10 }));
    expect(r?.kind).toBe('COOLDOWN');
    expect(r?.retryAfterSeconds).toBe(10);
  });
  it('reports the hour cap when the cooldown has passed and both caps would refuse', () => {
    const created = series(12, 2 * MIN, 4 * MIN);
    expect(evaluateSendWindows(input({ lastIssued: ago(2 * MIN), created, maxPerHour: 5, maxPerDay: 10 }))?.kind).toBe('HOUR_CAP');
  });
  it('reports the day cap only when the hour cap does not refuse', () => {
    const created = series(10, 2 * HOUR, 2 * HOUR);
    expect(evaluateSendWindows(input({ lastIssued: ago(2 * HOUR), created, maxPerHour: 5, maxPerDay: 10 }))?.kind).toBe('DAY_CAP');
  });
  it('reports the cooldown even when the cooldown wait is longer than the cap wait', () => {
    const created = series(5, MIN, 10 * MIN); // newest 1 min ago, the oldest 41 min ago: the hour wait is 19 min
    const r = evaluateSendWindows(input({ lastIssued: ago(MIN), created, resendSeconds: 3600 }));
    expect(r).toEqual({ kind: 'COOLDOWN', retryAfterSeconds: 59 * 60 });
  });
  it('reports the hour cap, not the day cap, when only the hour wait is shorter', () => {
    const created = series(10, 5 * MIN, 5 * MIN);
    expect(evaluateSendWindows(input({ lastIssued: ago(5 * MIN), created, maxPerHour: 5, maxPerDay: 10 }))?.kind).toBe('HOUR_CAP');
  });
  it('is a pure function: the same input gives the same answer and the input is not modified', () => {
    const created = series(5, 10 * MIN, 10 * MIN);
    const copy = created.map((d) => d.getTime());
    const i = input({ lastIssued: ago(10 * MIN), created });
    expect(evaluateSendWindows(i)).toEqual(evaluateSendWindows(i));
    expect(created.map((d) => d.getTime())).toEqual(copy);
    expect(i.now.getTime()).toBe(NOW.getTime());
  });
  it('reads no clock: a different `now` moves the answer', () => {
    const created = series(5, 10 * MIN, 10 * MIN);
    const a = evaluateSendWindows(input({ lastIssued: ago(10 * MIN), created }));
    const later = evaluateSendWindows(input({ lastIssued: ago(10 * MIN), created, now: new Date(NOW.getTime() + 5 * MIN) }));
    expect(a).toEqual({ kind: 'HOUR_CAP', retryAfterSeconds: 600 });
    expect(later).toEqual({ kind: 'HOUR_CAP', retryAfterSeconds: 300 });
  });
});

// ====================================================================== requestRules
describe('requestRules', () => {
  const hashKey = 'k'.repeat(32);
  const ip = '203.0.113.77';
  const device = 'device-4f9a1c2e';
  const account = '7c0e9d44-5b1a-4a3e-9f27-0a1b2c3d4e5f';

  it('always has the account rule, keyed by the account id', () => {
    expect(requestRules('phone-verification', hashKey, account, {}, 30)).toEqual([
      { name: 'phone-verification:account', key: account, limit: 30, windowSeconds: 3600 },
    ]);
  });
  it('adds the ip rule only when an address is given', () => {
    const rules = requestRules('phone-verification', hashKey, account, { clientIp: ip }, 30);
    expect(rules.map((r) => r.name)).toEqual(['phone-verification:account', 'phone-verification:ip']);
  });
  it('adds the device rule only when a device id is given', () => {
    const rules = requestRules('phone-verification', hashKey, account, { deviceId: device }, 30);
    expect(rules.map((r) => r.name)).toEqual(['phone-verification:account', 'phone-verification:device']);
  });
  it('adds account, ip and device in that order when all are given', () => {
    const rules = requestRules('phone-verification', hashKey, account, { clientIp: ip, deviceId: device }, 30);
    expect(rules.map((r) => r.name)).toEqual(['phone-verification:account', 'phone-verification:ip', 'phone-verification:device']);
  });
  it.each([
    ['an empty ip', { clientIp: '' }],
    ['an undefined ip', { clientIp: undefined }],
    ['an empty device', { deviceId: '' }],
    ['an undefined device', { deviceId: undefined }],
    ['both empty', { clientIp: '', deviceId: '' }],
  ])('adds no rule for %s', (_label, ctx) => {
    expect(requestRules('p', hashKey, account, ctx, 30).map((r) => r.name)).toEqual(['p:account']);
  });
  it.each(['phone-verification', 'email-verification', 'x', 'channel:sub'])('names the buckets <prefix>:account|ip|device for the prefix %s', (prefix) => {
    const names = requestRules(prefix, hashKey, account, { clientIp: ip, deviceId: device }, 5).map((r) => r.name);
    expect(names).toEqual([`${prefix}:account`, `${prefix}:ip`, `${prefix}:device`]);
  });
  it('keys the ip and the device with hashDimension, truncated to 32 hex characters', () => {
    const rules = requestRules('p', hashKey, account, { clientIp: ip, deviceId: device }, 30);
    expect(rules[1]!.key).toBe(hashDimension(hashKey, 'ip', ip));
    expect(rules[2]!.key).toBe(hashDimension(hashKey, 'device', device));
    expect(rules[1]!.key).toMatch(/^[0-9a-f]{32}$/);
    expect(rules[2]!.key).toMatch(/^[0-9a-f]{32}$/);
  });
  it('never puts the raw ip or device id into any key or name', () => {
    const rules = requestRules('p', hashKey, account, { clientIp: ip, deviceId: device }, 30);
    for (const r of rules) {
      expect(r.key).not.toContain(ip);
      expect(r.name).not.toContain(ip);
      expect(r.key).not.toContain(device);
      expect(r.name).not.toContain(device);
      expect(JSON.stringify(r)).not.toContain(ip);
      expect(JSON.stringify(r)).not.toContain(device);
    }
  });
  it('gives the ip and the device different keys even for the same value', () => {
    const rules = requestRules('p', hashKey, account, { clientIp: 'same-value', deviceId: 'same-value' }, 30);
    expect(rules[1]!.key).not.toBe(rules[2]!.key);
  });
  it('depends on the hash key: another key gives other counter keys', () => {
    const a = requestRules('p', hashKey, account, { clientIp: ip }, 30);
    const b = requestRules('p', 'j'.repeat(32), account, { clientIp: ip }, 30);
    expect(a[1]!.key).not.toBe(b[1]!.key);
    expect(a[0]!.key).toBe(b[0]!.key);
  });
  it('is deterministic for the same input', () => {
    expect(requestRules('p', hashKey, account, { clientIp: ip, deviceId: device }, 30)).toEqual(
      requestRules('p', hashKey, account, { clientIp: ip, deviceId: device }, 30),
    );
  });
  it.each([1, 5, 30, 1000, 100_000])('gives every rule the limit %i and a window of 3600 seconds', (limit) => {
    for (const r of requestRules('p', hashKey, account, { clientIp: ip, deviceId: device }, limit)) {
      expect(r.limit).toBe(limit);
      expect(r.windowSeconds).toBe(3600);
    }
  });
  it('produces rules the rate limiter accepts (names and keys are valid opaque identifiers)', async () => {
    const limiter = new MemoryRateLimiter();
    const rules = requestRules('phone-verification', hashKey, account, { clientIp: '2001:db8::1', deviceId: 'dev id with spaces?' }, 30);
    await expect(limiter.consume(rules)).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
  });
});

// ====================================================================== consumeRules
describe('consumeRules', () => {
  const rule = (over: Partial<RateRule> = {}): RateRule => ({ name: 'test:account', key: 'acct-1', limit: 2, windowSeconds: 100, ...over });

  it('allows when there is no limiter (tests of the database limits alone)', async () => {
    await expect(consumeRules(undefined, [rule()])).resolves.toEqual({ kind: 'ALLOWED' });
    await expect(consumeRules(undefined, [])).resolves.toEqual({ kind: 'ALLOWED' });
  });
  it('allows while the limit has room and counts every call', async () => {
    const limiter = new MemoryRateLimiter();
    await expect(consumeRules(limiter, [rule()])).resolves.toEqual({ kind: 'ALLOWED' });
    await expect(consumeRules(limiter, [rule()])).resolves.toEqual({ kind: 'ALLOWED' });
  });
  it('refuses with the retry-after of the limiter once the limit is reached', async () => {
    let now = 1_000_000;
    const limiter = new MemoryRateLimiter(() => now);
    await consumeRules(limiter, [rule({ limit: 1, windowSeconds: 60 })]);
    now += 10_000;
    await expect(consumeRules(limiter, [rule({ limit: 1, windowSeconds: 60 })])).resolves.toEqual({ kind: 'REFUSED', retryAfterSeconds: 50 });
  });
  it('allows again after the window has passed', async () => {
    let now = 1_000_000;
    const limiter = new MemoryRateLimiter(() => now);
    await consumeRules(limiter, [rule({ limit: 1, windowSeconds: 60 })]);
    now += 61_000;
    await expect(consumeRules(limiter, [rule({ limit: 1, windowSeconds: 60 })])).resolves.toEqual({ kind: 'ALLOWED' });
  });
  it('keeps the keys apart: another subject has its own budget', async () => {
    const limiter = new MemoryRateLimiter();
    await consumeRules(limiter, [rule({ key: 'a', limit: 1 })]);
    await expect(consumeRules(limiter, [rule({ key: 'b', limit: 1 })])).resolves.toEqual({ kind: 'ALLOWED' });
    await expect(consumeRules(limiter, [rule({ key: 'a', limit: 1 })])).resolves.toMatchObject({ kind: 'REFUSED' });
  });
  it('refuses when any one of several rules is exhausted, and spends nothing on the others', async () => {
    const limiter = new MemoryRateLimiter();
    await consumeRules(limiter, [rule({ name: 'test:ip', key: 'ip-1', limit: 1 })]);
    const both = [rule({ name: 'test:account', key: 'acct', limit: 5 }), rule({ name: 'test:ip', key: 'ip-1', limit: 1 })];
    await expect(consumeRules(limiter, both)).resolves.toMatchObject({ kind: 'REFUSED' });
    // the account counter was not spent by the refused request: five more fit
    for (let i = 0; i < 5; i++)
      await expect(consumeRules(limiter, [rule({ name: 'test:account', key: 'acct', limit: 5 })])).resolves.toEqual({ kind: 'ALLOWED' });
    await expect(consumeRules(limiter, [rule({ name: 'test:account', key: 'acct', limit: 5 })])).resolves.toMatchObject({ kind: 'REFUSED' });
  });
  it('reports UNAVAILABLE when the limiter is unreachable, never ALLOWED', async () => {
    const limiter = new MemoryRateLimiter();
    limiter.unavailable = true;
    await expect(consumeRules(limiter, [rule()])).resolves.toEqual({ kind: 'UNAVAILABLE' });
  });
  it('recovers when the limiter is reachable again', async () => {
    const limiter = new MemoryRateLimiter();
    limiter.unavailable = true;
    await consumeRules(limiter, [rule()]);
    limiter.unavailable = false;
    await expect(consumeRules(limiter, [rule()])).resolves.toEqual({ kind: 'ALLOWED' });
  });
  it('reports UNAVAILABLE for invalid rules (the limiter throws RateLimiterUnavailableError)', async () => {
    const limiter = new MemoryRateLimiter();
    await expect(consumeRules(limiter, [])).resolves.toEqual({ kind: 'UNAVAILABLE' });
    await expect(consumeRules(limiter, [rule({ key: 'has space' })])).resolves.toEqual({ kind: 'UNAVAILABLE' });
    await expect(consumeRules(limiter, [rule({ limit: 0 })])).resolves.toEqual({ kind: 'UNAVAILABLE' });
  });
  it('reports UNAVAILABLE for a custom limiter that throws RateLimiterUnavailableError', async () => {
    const limiter: RateLimiter = { consume: () => Promise.reject(new RateLimiterUnavailableError()) };
    await expect(consumeRules(limiter, [rule()])).resolves.toEqual({ kind: 'UNAVAILABLE' });
  });
  it('rethrows an error that is not the limiter-unavailable error (a bug must not look like an outage or an allow)', async () => {
    const boom = new Error('unexpected failure');
    const limiter: RateLimiter = { consume: () => Promise.reject(boom) };
    await expect(consumeRules(limiter, [rule()])).rejects.toBe(boom);
  });
  it('rethrows a TypeError and a non-Error value as they are', async () => {
    const typeError = new TypeError('bad');
    await expect(consumeRules({ consume: () => Promise.reject(typeError) }, [rule()])).rejects.toBe(typeError);
    await expect(consumeRules({ consume: () => Promise.reject('plain string') }, [rule()])).rejects.toBe('plain string');
  });
  it('rethrows an error that only looks like the limiter error (same name, another class)', async () => {
    const lookalike = Object.assign(new Error('looks alike'), { name: 'RateLimiterUnavailableError' });
    await expect(consumeRules({ consume: () => Promise.reject(lookalike) }, [rule()])).rejects.toBe(lookalike);
  });
  it('passes the rules to the limiter unchanged and consumes once', async () => {
    const seen: (readonly RateRule[])[] = [];
    const decision: RateDecision = { allowed: true, retryAfterSeconds: 0 };
    const limiter: RateLimiter = {
      consume: (rules) => {
        seen.push(rules);
        return Promise.resolve(decision);
      },
    };
    const rules = [rule(), rule({ name: 'test:ip', key: 'ip' })];
    await consumeRules(limiter, rules);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(rules);
  });
  it('maps a refused decision to its retry-after seconds only (no rule name, no key)', async () => {
    const limiter: RateLimiter = { consume: () => Promise.resolve({ allowed: false, limitedBy: 'test:ip', retryAfterSeconds: 42 }) };
    const outcome = await consumeRules(limiter, [rule()]);
    expect(outcome).toEqual({ kind: 'REFUSED', retryAfterSeconds: 42 });
  });
});
