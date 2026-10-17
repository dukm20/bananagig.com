// Integration tests of SecurityService.getSummary (ACC-001): the light security summary of the account area (second factor, live session count, trust of the current
// browser), over a real, freshly migrated PostgreSQL database (migration 0012 with its session and device guards), the FakeSecurityIdentityProvider (Keycloak as seen by
// the service, with failure injection and a call log) and the StaticSecurityPolicyProvider.
//
// Time: the DATABASE clock decides liveness. Windows are exercised without sleeping: session rows are CRAFTED by SQL with explicit past timestamps (29 and 31 days ago
// against the 30-day keep-signed-in window) and the policy is changed through the provider.
//
// The count must be the SAME definition as the session list (live = not revoked, and either the current session or seen inside the window) but is a pure read: it
// closes nothing, calls the identity provider for the second-factor state ONCE and never for the sessions.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '@bananagig/database';
import { MemoryRateLimiter } from '@bananagig/platform';
import { createIsolatedDatabase, rejection, type IsolatedDatabase } from '@bananagig/testing';
import {
  AccountError,
  AccountService,
  FakeSecurityIdentityProvider,
  SEEDED_SECURITY_POLICY,
  SecurityService,
  StaticSecurityPolicyProvider,
  type CurrentSession,
  type SecurityPolicy,
  type SecurityPolicyProvider,
} from './index';

// every log call of the code under test is captured here (and nothing is printed)
const logSink = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('@bananagig/observability', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    log: (level: string, message: string, attrs: Record<string, unknown> = {}) => {
      logSink.lines.push(JSON.stringify({ level, message, ...attrs }));
    },
  };
});

const ISSUER = 'http://auth.localhost:8080/realms/bananagig';
const DAY = 86_400;
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';

class TestPolicy implements SecurityPolicyProvider {
  private readonly inner = new StaticSecurityPolicyProvider({ ...SEEDED_SECURITY_POLICY });
  failure: unknown;
  async policy(): Promise<SecurityPolicy> {
    if (this.failure !== undefined) throw this.failure;
    return this.inner.policy();
  }
  set(over: Partial<SecurityPolicy>): void {
    this.inner.set({ ...SEEDED_SECURITY_POLICY, ...over });
  }
  reset(): void {
    this.failure = undefined;
    this.inner.set({ ...SEEDED_SECURITY_POLICY });
  }
}

let iso: IsolatedDatabase;
let bigDb: Database;
let accounts: AccountService;
let svc: SecurityService;
const provider = new FakeSecurityIdentityProvider();
const policy = new TestPolicy();
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => iso.database.query<T>(text, params);
const authNow = (): number => Math.floor(Date.now() / 1000) + 2;
const FACTS = () => ({ authTime: authNow() });

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  bigDb = createDatabase(iso.url, { role: 'tests', overrides: { poolMax: 30, connectionTimeoutMs: 30_000 } });
  accounts = new AccountService({ database: bigDb });
});
afterAll(async () => {
  await bigDb?.close();
  await iso?.drop();
});
beforeEach(() => {
  provider.reset();
  policy.reset();
  logSink.lines.length = 0;
  svc = new SecurityService({
    database: bigDb,
    policy,
    identityProvider: provider,
    rateLimiter: new MemoryRateLimiter(() => Date.now()),
    hashSecret: 'security-summary-test-hmac-'.repeat(2),
  });
});
afterEach(async () => {
  await svc.drain();
});

// ---------------------------------------------------------------- fixtures
interface Acct {
  id: string;
  subject: string;
}
async function newAccount(): Promise<Acct> {
  const subject = randomUUID();
  const id = (await accounts.ensureAccountForIdentity({ providerType: 'KEYCLOAK', issuer: ISSUER, subject, identityRoles: ['customer'] })).accountId;
  return { id, subject };
}
const curOf = (accountId: string, sid: string): CurrentSession => ({ accountId, keycloakSessionId: sid });
const newSid = (): string => `kc-sid-${randomUUID()}`;
/** The first request of a login: creates the application session. */
async function login(a: Acct): Promise<CurrentSession> {
  const sid = newSid();
  await svc.observeSession({ accountId: a.id, keycloakSessionId: sid, authTime: authNow() });
  return curOf(a.id, sid);
}
/** A login whose browser is registered (the web server's call after the callback). */
async function loginWithDevice(a: Acct, ua = CHROME): Promise<{ cur: CurrentSession; deviceId: string }> {
  const cur = await login(a);
  const reg = await svc.registerSession({ ...cur, deviceSecret: randomBytes(32).toString('base64url'), userAgent: ua });
  expect(reg.deviceId).not.toBeNull();
  return { cur, deviceId: reg.deviceId! };
}
interface Crafted {
  lastSeenAgoSec?: number;
  revoked?: boolean;
}
/** Inserts a session row with explicit times (time travel by SQL: an INSERT is free). */
async function craft(accountId: string, o: Crafted = {}): Promise<CurrentSession> {
  const sid = newSid();
  const seen = o.lastSeenAgoSec ?? 0;
  await q(
    `INSERT INTO identity.application_sessions (account_id, keycloak_session_id, created_at, last_seen_at, revoked_at, revocation_reason)
     VALUES ($1, $2, clock_timestamp() - make_interval(secs => $3::float8), clock_timestamp() - make_interval(secs => $4::float8),
             CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END, CASE WHEN $5::boolean THEN 'SIGN_OUT' ELSE NULL END)`,
    [accountId, sid, Math.max(3600, seen + 1), seen, o.revoked ?? false],
  );
  return curOf(accountId, sid);
}
const sessionRows = (accountId: string) =>
  q('SELECT * FROM identity.application_sessions WHERE account_id = $1 ORDER BY created_at, application_session_id', [accountId]);
const snapshot = async (accountId: string) => ({
  sessions: await sessionRows(accountId),
  devices: await q('SELECT * FROM identity.account_devices WHERE account_id = $1 ORDER BY first_seen_at, account_device_id', [accountId]),
  audit: (await q<{ n: number }>('SELECT count(*)::int AS n FROM identity.account_audit_events WHERE account_id = $1', [accountId]))[0]!.n,
  events: (await q<{ n: number }>('SELECT count(*)::int AS n FROM integration.outbox_events WHERE aggregate_id = $1', [accountId]))[0]!.n,
});
const summary = (cur: CurrentSession) => svc.getSummary(cur, FACTS());
const fails = async (p: Promise<unknown>, code: string, details?: Record<string, unknown>): Promise<AccountError> => {
  const e = await rejection(p);
  expect(e, `expected AccountError ${code}`).toBeInstanceOf(AccountError);
  expect((e as AccountError).code).toBe(code);
  if (details) expect((e as AccountError).details).toEqual(details);
  return e as AccountError;
};
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

// ====================================================================== the shape
describe('getSummary: the shape', () => {
  it('returns exactly mfa{available,enabled}, activeSessionCount and currentBrowserTrusted, with plain types and nothing else', async () => {
    const a = await newAccount();
    const cur = await login(a);
    provider.setUser(a.subject, { otpConfigured: true });
    const s = await summary(cur);
    expect(s).toEqual({ mfa: { available: true, enabled: true }, activeSessionCount: 1, currentBrowserTrusted: false });
    expect(Object.keys(s).sort()).toEqual(['activeSessionCount', 'currentBrowserTrusted', 'mfa']);
    expect(Object.keys(s.mfa).sort()).toEqual(['available', 'enabled']);
    expect(typeof s.activeSessionCount).toBe('number');
    expect(Number.isInteger(s.activeSessionCount)).toBe(true);
  });

  it('never carries a session id, a Keycloak subject, a device id, a hash or a timestamp', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    await svc.trustCurrentDevice(d.cur);
    provider.setUser(a.subject, { otpConfigured: true, recoveryCodesConfigured: true });
    const text = JSON.stringify(await summary(d.cur));
    for (const needle of [d.cur.keycloakSessionId, a.subject, a.id, d.deviceId]) expect(text).not.toContain(needle);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|[0-9a-f]{32}|\d{4}-\d{2}-\d{2}T/);
  });
});

// ====================================================================== the second factor
describe('getSummary: mfa', () => {
  it('enabled follows totpConfigured of the identity provider: off, then on, then off again', async () => {
    const a = await newAccount();
    const cur = await login(a);
    expect((await summary(cur)).mfa).toEqual({ available: true, enabled: false });
    provider.setUser(a.subject, { otpConfigured: true });
    expect((await summary(cur)).mfa).toEqual({ available: true, enabled: true });
    provider.setUser(a.subject, { otpConfigured: false });
    expect((await summary(cur)).mfa).toEqual({ available: true, enabled: false });
  });

  it('recovery codes alone are not a second factor: enabled stays false when only recovery codes are configured, and recovery codes do not change it when the app is on', async () => {
    const a = await newAccount();
    const cur = await login(a);
    provider.setUser(a.subject, { otpConfigured: false, recoveryCodesConfigured: true });
    expect((await summary(cur)).mfa).toEqual({ available: true, enabled: false });
    provider.setUser(a.subject, { otpConfigured: true, recoveryCodesConfigured: false });
    expect((await summary(cur)).mfa).toEqual({ available: true, enabled: true });
  });

  it("answers per account: another account's second factor never shows", async () => {
    const [a, b] = [await newAccount(), await newAccount()];
    const [ca, cb] = [await login(a), await login(b)];
    provider.setUser(b.subject, { otpConfigured: true });
    expect((await summary(ca)).mfa.enabled).toBe(false);
    expect((await summary(cb)).mfa.enabled).toBe(true);
  });

  it('available is false and enabled is false when the identity provider fails, even though a second factor exists (enabled then means "unknown"); the rest of the summary is still returned', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    await svc.trustCurrentDevice(d.cur);
    await login(a);
    provider.setUser(a.subject, { otpConfigured: true, recoveryCodesConfigured: true });
    provider.failNext('getUserSecurity', Number.POSITIVE_INFINITY);
    const s = await summary(d.cur);
    expect(s).toEqual({ mfa: { available: false, enabled: false }, activeSessionCount: 2, currentBrowserTrusted: true });
    provider.clearFailures();
    expect((await summary(d.cur)).mfa).toEqual({ available: true, enabled: true });
  });

  it('available is false when no identity provider is configured (the null provider) and when the account has no Keycloak link at all', async () => {
    const a = await newAccount();
    const cur = await login(a);
    provider.setUser(a.subject, { otpConfigured: true });
    provider.available = false;
    expect((await summary(cur)).mfa).toEqual({ available: false, enabled: false });
    expect(provider.callsOf('getUserSecurity')).toEqual([]);
    provider.available = true;
    // an account created without a login link (no external identity)
    const c = await iso.database.pool.connect();
    let linkless: string;
    try {
      await c.query('BEGIN');
      linkless = (await c.query("INSERT INTO identity.accounts (status) VALUES ('PENDING') RETURNING account_id")).rows[0].account_id as string;
      await c.query(
        "INSERT INTO identity.account_status_history (account_id, from_status, to_status, reason, actor, correlation_id) VALUES ($1, NULL, 'PENDING', NULL, 'test', 'test')",
        [linkless],
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const own = await craft(linkless);
    expect((await summary(own)).mfa).toEqual({ available: false, enabled: false });
  });

  it('writes nothing when the provider is down (the unknown state is not recorded as a change)', async () => {
    const a = await newAccount();
    const cur = await login(a);
    provider.setUser(a.subject, { otpConfigured: true, recoveryCodesConfigured: true, passwordChangedAt: new Date(Date.now() + 3_600_000) });
    const before = await snapshot(a.id);
    provider.failNext('getUserSecurity', Number.POSITIVE_INFINITY);
    await summary(cur);
    expect(await snapshot(a.id)).toEqual(before);
    expect(logSink.lines.join('\n')).toContain('could not be read');
  });

  it('asks the identity provider ONCE per summary for the second-factor state, never for the session list, never to end a session, and never sends mail', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    await login(a);
    provider.addSession(a.subject, d.cur.keycloakSessionId);
    provider.calls.length = 0;
    await summary(d.cur);
    expect(provider.calls).toEqual([{ method: 'getUserSecurity', subject: a.subject }]);
    expect(provider.callsOf('listSessions')).toEqual([]);
    expect(provider.callsOf('endSession')).toEqual([]);
    expect(provider.callsOf('endAllSessions')).toEqual([]);
    expect(provider.sentResetEmails).toEqual([]);
    expect(provider.endedSessions).toEqual([]);
    // a second call asks again (no cache), and still never for the sessions
    await summary(d.cur);
    expect(provider.callsOf('getUserSecurity')).toHaveLength(2);
    expect(provider.callsOf('listSessions')).toEqual([]);
  });

  it('does not wait for a slow session listing of the identity provider: with listSessions held, the summary still completes', async () => {
    const a = await newAccount();
    const cur = await login(a);
    const release = provider.hold('listSessions');
    try {
      const done = await Promise.race([summary(cur).then(() => 'done'), new Promise<string>((r) => setTimeout(() => r('waited'), 3000))]);
      expect(done).toBe('done');
    } finally {
      release();
    }
  });
});

// ====================================================================== the live session count
describe('getSummary: activeSessionCount', () => {
  it('counts the current session alone as 1 and every additional live session of the account', async () => {
    const a = await newAccount();
    const cur = await login(a);
    expect((await summary(cur)).activeSessionCount).toBe(1);
    await login(a);
    await craft(a.id, { lastSeenAgoSec: 120 });
    expect((await summary(cur)).activeSessionCount).toBe(3);
  });

  it('excludes revoked sessions, however recently they were seen, and counts them again never', async () => {
    const a = await newAccount();
    const cur = await login(a);
    await craft(a.id, { lastSeenAgoSec: 5, revoked: true });
    await craft(a.id, { lastSeenAgoSec: 60, revoked: true });
    const live = await craft(a.id, { lastSeenAgoSec: 30 });
    expect((await summary(cur)).activeSessionCount).toBe(2);
    // a real revocation through the service drops the count at once
    await svc.revokeSession(
      cur,
      (
        await q<{ application_session_id: string }>('SELECT application_session_id FROM identity.application_sessions WHERE keycloak_session_id = $1', [
          live.keycloakSessionId,
        ])
      )[0]!.application_session_id,
    );
    expect((await summary(cur)).activeSessionCount).toBe(1);
  });

  it('excludes a session idle beyond the keep-signed-in window (31 days against 30) and includes one inside it (29 days), by the database clock', async () => {
    const a = await newAccount();
    const cur = await login(a);
    await craft(a.id, { lastSeenAgoSec: 29 * DAY });
    await craft(a.id, { lastSeenAgoSec: 31 * DAY });
    await craft(a.id, { lastSeenAgoSec: 400 * DAY });
    expect((await summary(cur)).activeSessionCount).toBe(2);
  });

  it('follows the policy window: a longer window brings an older session back, a shorter one drops a recent one', async () => {
    const a = await newAccount();
    const cur = await login(a);
    await craft(a.id, { lastSeenAgoSec: 50 * DAY });
    await craft(a.id, { lastSeenAgoSec: 10 * DAY });
    expect((await summary(cur)).activeSessionCount).toBe(2); // 30 days: the current and the 10-day-old one
    policy.set({ keepSignedInDays: 60 });
    expect((await summary(cur)).activeSessionCount).toBe(3);
    policy.set({ keepSignedInDays: 7 });
    expect((await summary(cur)).activeSessionCount).toBe(1);
  });

  it('always includes the CURRENT session, even when its row is idle beyond the window', async () => {
    const a = await newAccount();
    const current = await craft(a.id, { lastSeenAgoSec: 40 * DAY });
    await craft(a.id, { lastSeenAgoSec: 45 * DAY });
    await craft(a.id, { lastSeenAgoSec: 20 * DAY });
    expect((await summary(current)).activeSessionCount).toBe(2); // the current (idle 40 days) and the 20-day-old one; the 45-day-old one is out
  });

  it("never counts another account's sessions, live or not, current or not", async () => {
    const [a, b] = [await newAccount(), await newAccount()];
    const curA = await login(a);
    for (let i = 0; i < 4; i++) await login(b);
    await craft(b.id, { lastSeenAgoSec: 5 });
    expect((await summary(curA)).activeSessionCount).toBe(1);
    const curB = await login(b);
    expect((await summary(curB)).activeSessionCount).toBe(6);
    expect((await summary(curA)).activeSessionCount).toBe(1);
  });

  it('is the same number the session list shows (the same definition of live), compared before the list closes the expired rows', async () => {
    const a = await newAccount();
    const cur = await login(a);
    await craft(a.id, { lastSeenAgoSec: 10 });
    await craft(a.id, { lastSeenAgoSec: 29 * DAY });
    await craft(a.id, { lastSeenAgoSec: 31 * DAY });
    await craft(a.id, { lastSeenAgoSec: 1, revoked: true });
    provider.available = false;
    const counted = (await summary(cur)).activeSessionCount;
    const listed = (await svc.listSessions(cur)).sessions.length;
    expect(counted).toBe(3);
    expect(counted).toBe(listed);
    expect((await summary(cur)).activeSessionCount).toBe(listed);
  });

  it('is a pure read of the sessions: it closes nothing (an idle row stays live), touches no last_seen_at and revokes nothing, unlike the session list', async () => {
    const a = await newAccount();
    const cur = await login(a);
    const idle = await craft(a.id, { lastSeenAgoSec: 31 * DAY });
    const before = await sessionRows(a.id);
    await summary(cur);
    await summary(cur);
    expect(await sessionRows(a.id)).toEqual(before);
    const row = (
      await q<{ revoked_at: Date | null }>('SELECT revoked_at FROM identity.application_sessions WHERE keycloak_session_id = $1', [idle.keycloakSessionId])
    )[0]!;
    expect(row.revoked_at).toBeNull();
  });

  it('counts a bulk of live sessions exactly (no list limit applies to the count)', async () => {
    const a = await newAccount();
    const cur = await login(a);
    await q(
      `INSERT INTO identity.application_sessions (account_id, keycloak_session_id, created_at, last_seen_at)
       SELECT $1, 'bulk-' || $2 || '-' || i, clock_timestamp() - interval '2 days', clock_timestamp() - make_interval(secs => i) FROM generate_series(1, 230) AS i`,
      [a.id, randomUUID()],
    );
    expect((await summary(cur)).activeSessionCount).toBe(231);
  });

  it('counts after a "sign out everywhere" exactly the sessions that remain', async () => {
    const a = await newAccount();
    const cur = await login(a);
    await login(a);
    await login(a);
    expect((await summary(cur)).activeSessionCount).toBe(3);
    provider.available = false;
    await svc.revokeAllSessions(cur, { includeCurrent: false });
    expect((await summary(cur)).activeSessionCount).toBe(1);
  });
});

// ====================================================================== the trust of the current browser
describe('getSummary: currentBrowserTrusted', () => {
  it('is false for a session without a registered browser and for a registered but untrusted browser', async () => {
    const a = await newAccount();
    expect((await summary(await login(a))).currentBrowserTrusted).toBe(false);
    const d = await loginWithDevice(a);
    expect((await summary(d.cur)).currentBrowserTrusted).toBe(false);
  });

  it('follows the device trust: true after trusting the browser, false after untrusting it, true again after trusting it again', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    await svc.trustCurrentDevice(d.cur);
    expect((await summary(d.cur)).currentBrowserTrusted).toBe(true);
    await svc.untrustCurrentDevice(d.cur);
    expect((await summary(d.cur)).currentBrowserTrusted).toBe(false);
    await svc.trustCurrentDevice(d.cur);
    expect((await summary(d.cur)).currentBrowserTrusted).toBe(true);
  });

  it('is false once the trust window has ended (by the database clock) and true again when the window is renewed', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    await svc.trustCurrentDevice(d.cur);
    await q(
      `UPDATE identity.account_devices SET trusted_at = clock_timestamp() - interval '40 days', trusted_until = clock_timestamp() - interval '10 days' WHERE account_device_id = $1`,
      [d.deviceId],
    );
    expect((await summary(d.cur)).currentBrowserTrusted).toBe(false);
    await q(
      `UPDATE identity.account_devices SET trusted_at = clock_timestamp(), trusted_until = clock_timestamp() + interval '1 day' WHERE account_device_id = $1`,
      [d.deviceId],
    );
    expect((await summary(d.cur)).currentBrowserTrusted).toBe(true);
  });

  it("is about THIS browser only: another trusted browser of the same account does not make the current one trusted, and another account's trusted browser never does", async () => {
    const [a, b] = [await newAccount(), await newAccount()];
    const trusted = await loginWithDevice(a, CHROME);
    await svc.trustCurrentDevice(trusted.cur);
    const mine = await loginWithDevice(a, SAFARI);
    const theirs = await loginWithDevice(b, CHROME);
    await svc.trustCurrentDevice(theirs.cur);
    expect((await summary(mine.cur)).currentBrowserTrusted).toBe(false);
    expect((await summary(trusted.cur)).currentBrowserTrusted).toBe(true);
    expect((await summary(await login(a))).currentBrowserTrusted).toBe(false);
  });

  it("is false after the browser is removed (its sessions are revoked with it, so the removed browser's own session is refused rather than reported as trusted)", async () => {
    const a = await newAccount();
    const admin = await login(a);
    const d = await loginWithDevice(a, SAFARI);
    await svc.trustCurrentDevice(d.cur);
    await svc.removeDevice(admin, d.deviceId);
    await fails(summary(d.cur), 'SESSION_REVOKED');
    expect((await summary(admin)).currentBrowserTrusted).toBe(false);
  });
});

// ====================================================================== refusals
describe('getSummary: sessions that cannot ask', () => {
  it('refuses a session that was never seen, one of another account and a revoked one (SESSION_NOT_FOUND, SESSION_NOT_FOUND, SESSION_REVOKED) and returns no count', async () => {
    const [a, b] = [await newAccount(), await newAccount()];
    const theirs = await login(b);
    await fails(summary(curOf(a.id, newSid())), 'SESSION_NOT_FOUND');
    await fails(summary(curOf(a.id, theirs.keycloakSessionId)), 'SESSION_NOT_FOUND');
    const keep = await login(a);
    const gone = await craft(a.id, { revoked: true });
    await fails(summary(gone), 'SESSION_REVOKED');
    expect((await summary(keep)).activeSessionCount).toBe(1);
  });

  it('refuses an unknown account with SESSION_NOT_FOUND and lets no database detail through', async () => {
    const e = await fails(summary(curOf(randomUUID(), newSid())), 'SESSION_NOT_FOUND');
    expect(e.message).toBe('the session was not found');
    expect(e.details).toEqual({});
  });

  it('fails closed when the policy is unavailable (POLICY_UNAVAILABLE) without echoing the cause', async () => {
    const a = await newAccount();
    const cur = await login(a);
    policy.failure = new Error('secret-connection-string-in-the-error');
    const e = await fails(summary(cur), 'UNAVAILABLE', { reason: 'POLICY_UNAVAILABLE' });
    expect(e.message).not.toContain('secret-connection-string');
    expect(logSink.lines.join('\n')).not.toContain('secret-connection-string');
  });

  it('logs nothing that identifies the session, the subject or the account', async () => {
    const a = await newAccount();
    const cur = await login(a);
    provider.setUser(a.subject, { otpConfigured: true });
    provider.failNext('getUserSecurity', 1);
    await summary(cur);
    await summary(cur);
    const text = logSink.lines.join('\n');
    for (const needle of [cur.keycloakSessionId, a.subject, a.id, sha(cur.keycloakSessionId)]) expect(text).not.toContain(needle);
  });
});

// ====================================================================== concurrency
describe('getSummary: concurrency', () => {
  it('returns the identical summary to 25 parallel calls for one session', async () => {
    const a = await newAccount();
    const d = await loginWithDevice(a);
    await svc.trustCurrentDevice(d.cur);
    await login(a);
    await craft(a.id, { lastSeenAgoSec: 120 });
    provider.setUser(a.subject, { otpConfigured: true });
    const results = await Promise.all(Array.from({ length: 25 }, () => summary(d.cur)));
    for (const r of results) expect(r).toEqual({ mfa: { available: true, enabled: true }, activeSessionCount: 3, currentBrowserTrusted: true });
  });

  it('counts a value between the before and the after while sessions are revoked in parallel, and settles on the final count', async () => {
    const a = await newAccount();
    const cur = await login(a);
    const others: CurrentSession[] = [];
    for (let i = 0; i < 12; i++) others.push(await craft(a.id, { lastSeenAgoSec: 10 + i }));
    const ids = (
      await q<{ application_session_id: string }>(
        'SELECT application_session_id FROM identity.application_sessions WHERE account_id = $1 AND keycloak_session_id <> $2',
        [a.id, cur.keycloakSessionId],
      )
    ).map((r) => r.application_session_id);
    provider.available = false;
    const [counts] = await Promise.all([
      Promise.all(Array.from({ length: 24 }, () => summary(cur).then((s) => s.activeSessionCount))),
      Promise.all(ids.map((id) => svc.revokeSession(cur, id))),
    ]);
    for (const n of counts) expect(n).toBeGreaterThanOrEqual(1);
    for (const n of counts) expect(n).toBeLessThanOrEqual(13);
    expect((await summary(cur)).activeSessionCount).toBe(1);
  });
});
