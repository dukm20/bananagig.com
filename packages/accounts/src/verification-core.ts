// The channel-neutral policy mechanics shared by the email and the phone verification (ID-003, ADR-0030): evaluation of the resend cooldown and the hour/day caps from
// the rows of one account's challenges, and the construction and consumption of the abuse-limit rules. Pure functions and one thin wrapper over the RateLimiter port.
// What stays per channel: the tables, the SQL, the delivery, the typed errors and the policy values. Nothing here logs, reads a clock or touches the database.
import { RateLimiterUnavailableError, type RateLimiter, type RateRule } from '@bananagig/platform';
import { hashDimension } from './email-crypto';

export const ceilSeconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

export interface SendWindowInput {
  /** Creation time of the account's newest challenge that is neither FAILED nor used (a delivery in flight counts, a failed one does not), or null. */
  lastIssued: Date | null;
  /** Creation times of every challenge of the account in the last day (failed deliveries included), oldest first. */
  created: readonly Date[];
  /** The database clock. */
  now: Date;
  resendSeconds: number;
  maxPerHour: number;
  maxPerDay: number;
}
export type SendWindowRefusal = { kind: 'COOLDOWN' | 'HOUR_CAP' | 'DAY_CAP'; retryAfterSeconds: number };

/** The first of cooldown, hour cap, day cap that refuses a new send, with the seconds until it would be accepted; null when the send may proceed. */
export function evaluateSendWindows(i: SendWindowInput): SendWindowRefusal | null {
  if (i.lastIssued) {
    const waitMs = i.lastIssued.getTime() + i.resendSeconds * 1000 - i.now.getTime();
    if (waitMs > 0) return { kind: 'COOLDOWN', retryAfterSeconds: ceilSeconds(waitMs) };
  }
  const capWait = (windowMs: number, cap: number): number => {
    const inWindow = i.created.filter((t) => t.getTime() > i.now.getTime() - windowMs);
    if (inWindow.length < cap) return 0;
    // the slot frees when the (count - cap + 1)-th oldest request leaves the window
    return inWindow[inWindow.length - cap]!.getTime() + windowMs - i.now.getTime();
  };
  const hourWait = capWait(3_600_000, i.maxPerHour);
  if (hourWait > 0) return { kind: 'HOUR_CAP', retryAfterSeconds: ceilSeconds(hourWait) };
  const dayWait = capWait(86_400_000, i.maxPerDay);
  if (dayWait > 0) return { kind: 'DAY_CAP', retryAfterSeconds: ceilSeconds(dayWait) };
  return null;
}

export interface LimitContext {
  /** The client address as the API sees it (hashed before it becomes a counter key). */
  clientIp?: string;
  /** A device or session identifier, where the caller has one. */
  deviceId?: string;
}

/**
 * The per-request rules of one channel: the account, the source address and the device, each limited to `requestsPerHour` per hour. `prefix` names the bucket
 * family (`email-verification`, `phone-verification`). Keys are opaque: an account id, or a keyed hash of an address or an id.
 */
export function requestRules(prefix: string, secret: string, accountId: string, ctx: LimitContext, requestsPerHour: number): RateRule[] {
  const rules: RateRule[] = [{ name: `${prefix}:account`, key: accountId, limit: requestsPerHour, windowSeconds: 3600 }];
  if (ctx.clientIp) rules.push({ name: `${prefix}:ip`, key: hashDimension(secret, 'ip', ctx.clientIp), limit: requestsPerHour, windowSeconds: 3600 });
  if (ctx.deviceId) rules.push({ name: `${prefix}:device`, key: hashDimension(secret, 'device', ctx.deviceId), limit: requestsPerHour, windowSeconds: 3600 });
  return rules;
}

export type LimitOutcome = { kind: 'ALLOWED' } | { kind: 'REFUSED'; retryAfterSeconds: number } | { kind: 'UNAVAILABLE' };

/** Consumes the rules. A missing limiter allows (tests of the database limits alone); an unreachable one is reported, never treated as allowed. */
export async function consumeRules(limiter: RateLimiter | undefined, rules: RateRule[]): Promise<LimitOutcome> {
  if (!limiter) return { kind: 'ALLOWED' };
  try {
    const decision = await limiter.consume(rules);
    return decision.allowed ? { kind: 'ALLOWED' } : { kind: 'REFUSED', retryAfterSeconds: decision.retryAfterSeconds };
  } catch (err) {
    if (err instanceof RateLimiterUnavailableError) return { kind: 'UNAVAILABLE' };
    throw err;
  }
}
