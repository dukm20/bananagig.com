// ID-004 sessions, devices, step-up, MFA status, security timeline and password reset over HTTP, on the REAL stack of services: the real Fastify app (buildApp), the real
// AccountService, EmailVerificationService, PhoneVerificationService and SecurityService on one real, isolated PostgreSQL (migration 0012 seeds the six security.* values and
// the security copy), the real configuration registry (CRITICAL limits read fresh), the real auth plugin and forged-but-signed tokens carrying `sid`, `auth_time` and `acr`.
// Keycloak is the FakeSecurityIdentityProvider (the live Keycloak behaviour is another suite); the rate limiter is the in-memory one behind a recording wrapper; email and SMS are
// recording doubles (no Mailpit, no Valkey). The account and the session come from the verified token only.
//
// What this file proves end to end: the first authenticated request creates the application session and the same `sid` reuses it; a revoked session is refused with
// 401 SESSION_REVOKED on the very next request on ANY account route although its access token is still valid; "sign out everywhere" takes effect at once, including for a
// Keycloak session the API has never seen (the revocation watermark); the step-up protocol (RFC 9470) in front of the trust and MFA routes; the trusted-browser window; the
// timeline and its cursor; the observed MFA and password transitions; the public password reset (identical answer for every input, limits that fail closed, the detached
// Keycloak call); that no route accepts or echoes an account id, a subject or a Keycloak session id; HTTP-level concurrency; and a secrecy sweep over every response, audit row,
// outbox payload and captured log line.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  AccountService,
  EmailVerificationService,
  FakeSecurityIdentityProvider,
  PhoneVerificationService,
  SEEDED_SECURITY_POLICY,
  SecurityService,
  hashDeviceSecret,
  hashDimension,
  type PhoneCountryDirectory,
  type SecurityIdentityProvider,
  type SecurityPolicy,
  type SecurityPolicyProvider,
} from '@bananagig/accounts';
import { loadConfig } from '@bananagig/config';
import { ConfigurationService, MemoryConfigCache } from '@bananagig/configuration';
import {
  ACR_MFA,
  ACR_PASSWORD,
  CORRELATION_HEADER,
  DeviceRemovedResponse,
  DeviceTrustResponse,
  ErrorResponse,
  MfaEnrollmentResponse,
  PasswordResetAcceptedResponse,
  RegisteredSessionResponse,
  SECURITY_ACTIVITY_TYPES,
  SECURITY_EVENTS,
  SecurityActivityResponse,
  SecurityDevicesResponse,
  SecurityOverviewResponse,
  SecuritySessionsResponse,
  SessionRevokedResponse,
  SessionsRevokedAllResponse,
  SignedOutResponse,
  StepUpDetails,
  securityActivityLabelKey,
} from '@bananagig/contracts';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { FakePhoneIntelligence, MemoryRateLimiter, RecordingEmailSender, RecordingSmsSender, type RateLimiter, type RateRule } from '@bananagig/platform';
import { sql } from '@bananagig/database';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';
import { createVerificationLinkBuilder, createVerificationPolicyProvider } from './modules/account/email-wiring';
import { createPhonePolicyProvider } from './modules/account/phone-wiring';
import { createSecurityPolicyProvider, createUnavailableSecurityIdentityProvider } from './modules/security/wiring';
import { accountPlugin, requireAccount } from './plugins/account';
import { authPlugin } from './plugins/auth';
import { correlationPlugin } from './plugins/correlation';
import { errorPlugin } from './plugins/errors';
import { requireMfa, requireRecentAuthentication, requireStepUp } from './plugins/step-up';

// ---------------------------------------------------------------- the real stack
const HASH_KEY = 'itest-security-hash-key-'.concat('k'.repeat(28));
const envFor = (hops?: number) => ({
  NODE_ENV: 'test',
  VERIFICATION_HASH_SECRET: HASH_KEY,
  ...(hops === undefined ? {} : { TRUSTED_PROXY_HOPS: String(hops) }),
});
const cfg = loadConfig({ service: 'bananagig-api', env: envFor() });
const REALM = cfg.identity.realm;

/** Wraps the in-memory limiter and records every rule set it was asked to consume, so a test can see WHICH dimensions a service used and with what keys. */
class RecordingLimiter implements RateLimiter {
  readonly log: RateRule[][] = [];
  readonly inner = new MemoryRateLimiter();
  consume(rules: readonly RateRule[], options?: { cost?: number }) {
    this.log.push(rules.map((r) => ({ ...r })));
    return this.inner.consume(rules, options);
  }
  /** Every rule of every consume call, flattened. */
  get rules(): RateRule[] {
    return this.log.flat();
  }
  rulesNamed(name: string): RateRule[] {
    return this.rules.filter((r) => r.name === name);
  }
}

let iso: IsolatedDatabase;
let keys: TestKeys;
let app: FastifyInstance;
let accounts: AccountService;
let configuration: ConfigurationService;
let security: SecurityService;
let realPolicy: SecurityPolicyProvider;
const provider = new FakeSecurityIdentityProvider();
const limiter = new RecordingLimiter();
const emailSender = new RecordingEmailSender();
const smsSender = new RecordingSmsSender();
/** When set, the policy provider of the main app serves this instead of the configuration registry (a configuration change, or an outage when it throws). */
let policyOverride: (() => Promise<SecurityPolicy>) | null = null;
const policyProvider: SecurityPolicyProvider = { policy: () => (policyOverride ? policyOverride() : realPolicy.policy()) };
const extraApps: FastifyInstance[] = [];

const usOnly: PhoneCountryDirectory = {
  active: async (alpha2) => (alpha2 === 'US' ? { dialingCode: '+1' } : null),
  defaultCountry: async () => 'US',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Res {
  method: string;
  url: string;
  status: number;
  body: Json;
  headers: Record<string, unknown>;
  raw: string;
  /** The correlation id the request carried. */
  cid: string;
}
/** Every response of the file, so the last tests can prove the secrecy and caching rules over ALL of them. */
const transcript: Res[] = [];
/** Everything that must never show up anywhere else. */
const secrets = {
  tokens: [] as string[],
  sids: [] as string[],
  subjects: [] as string[],
  emails: [] as string[],
  ips: [] as string[],
  devices: [] as string[],
  userAgents: [] as string[],
};

interface Tok {
  token: string;
  sid: string;
  authTime?: number;
}
interface Actor {
  label: string;
  sub: string;
  accountId: string;
  ip: string;
  /** The first session of the actor (its sid is registered with the fake identity provider like a real login). */
  t0: Tok;
}
interface MintOptions {
  sid?: string | null;
  /** epoch seconds; null = the claim is absent; default 5 seconds ago */
  authTime?: number | null;
  acr?: string;
  expiresInSec?: number;
  claims?: Record<string, unknown>;
  /** false: the Keycloak session is not known to the fake identity provider (its list lacks it) */
  inProvider?: boolean;
}
interface CallOptions {
  body?: unknown;
  /** Sent verbatim with a JSON content type. */
  rawBody?: string;
  headers?: Record<string, string>;
  app?: FastifyInstance;
  /** The forwarded client address; null sends none. Default: the actor's own unique address. */
  ip?: string | null;
  /** The token to present (default: the actor's first session); null sends no Authorization header; a string is sent verbatim. */
  as?: Tok | string | null;
  cid?: string;
}

let ipCounter = 0;
const nextIp = (): string => {
  ipCounter += 1;
  const ip = `198.18.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
  secrets.ips.push(ip);
  return ip;
};
const appNow = (): number => Math.floor(Date.now() / 1000);

async function mint(a: Pick<Actor, 'sub'>, o: MintOptions = {}): Promise<Tok> {
  const sid = o.sid === null ? undefined : (o.sid ?? randomUUID());
  const authTime = o.authTime === null ? undefined : (o.authTime ?? appNow() - 5);
  const token = await signToken(keys, {
    claims: { sub: a.sub, azp: 'bananagig-web', realm_access: { roles: ['customer'] }, ...o.claims },
    ...(sid === undefined ? { omit: ['sid'] } : { sid }),
    ...(authTime === undefined ? {} : { authTime }),
    ...(o.acr === undefined ? {} : { acr: o.acr }),
    ...(o.expiresInSec === undefined ? {} : { expiresInSec: o.expiresInSec }),
  });
  secrets.tokens.push(token);
  if (sid !== undefined) {
    secrets.sids.push(sid);
    if (o.inProvider !== false) provider.addSession(a.sub, sid);
  }
  return { token, sid: sid ?? '', authTime };
}

async function call(actor: Actor | undefined, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, o: CallOptions = {}): Promise<Res> {
  const hasBody = o.body !== undefined || o.rawBody !== undefined;
  const as = o.as === undefined ? actor?.t0 : o.as;
  const token = as === null || as === undefined ? undefined : typeof as === 'string' ? as : as.token;
  const ip = o.ip === undefined ? actor?.ip : (o.ip ?? undefined);
  const cid = o.cid ?? o.headers?.[CORRELATION_HEADER] ?? randomUUID();
  const path = url.startsWith('/api/') ? url : `/api/v1${url}`;
  const r = await (o.app ?? app).inject({
    method,
    url: path,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(ip ? { 'x-forwarded-for': ip } : {}),
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      [CORRELATION_HEADER]: cid,
      ...o.headers,
    },
    ...(hasBody ? { payload: o.rawBody ?? JSON.stringify(o.body) } : {}),
  });
  let body: Json;
  try {
    body = JSON.parse(r.body);
  } catch {
    body = undefined;
  }
  const res: Res = { method, url: path, status: r.statusCode, body, headers: r.headers, raw: r.body, cid };
  transcript.push(res);
  return res;
}

// ---------------------------------------------------------------- contract shapes
const SHAPES: Record<string, z.ZodType> = {
  registerAccountSecuritySession: RegisteredSessionResponse,
  getAccountSecurity: SecurityOverviewResponse,
  listAccountSecuritySessions: SecuritySessionsResponse,
  revokeAccountSecuritySession: SessionRevokedResponse,
  revokeAllAccountSecuritySessions: SessionsRevokedAllResponse,
  signOutCurrentAccountSecuritySession: SignedOutResponse,
  listAccountSecurityDevices: SecurityDevicesResponse,
  trustCurrentAccountSecurityDevice: DeviceTrustResponse,
  untrustCurrentAccountSecurityDevice: DeviceTrustResponse,
  removeAccountSecurityDevice: DeviceRemovedResponse,
  listAccountSecurityActivity: SecurityActivityResponse,
  startAccountSecurityMfaEnrollment: MfaEnrollmentResponse,
  requestPasswordReset: PasswordResetAcceptedResponse,
};
const shapeChecked = new Set<string>();
const OP = {
  register: 'registerAccountSecuritySession',
  overview: 'getAccountSecurity',
  sessions: 'listAccountSecuritySessions',
  revoke: 'revokeAccountSecuritySession',
  revokeAll: 'revokeAllAccountSecuritySessions',
  signOut: 'signOutCurrentAccountSecuritySession',
  devices: 'listAccountSecurityDevices',
  trust: 'trustCurrentAccountSecurityDevice',
  untrust: 'untrustCurrentAccountSecurityDevice',
  removeDevice: 'removeAccountSecurityDevice',
  activity: 'listAccountSecurityActivity',
  mfa: 'startAccountSecurityMfaEnrollment',
  reset: 'requestPasswordReset',
} as const;

/** A 200 (or the given success status) with the standard envelope; with an operation id the body must also equal its contract exactly (no field missing, none extra). */
const ok = (r: Res, op?: string, status = 200): Json => {
  expect(r.status, r.raw).toBe(status);
  expect(Object.keys(r.body).sort(), r.raw).toEqual(['data', 'meta']);
  expect(r.body.meta.correlationId).toBe(r.headers[CORRELATION_HEADER]);
  if (op) {
    const parsed = SHAPES[op]!.safeParse(r.body);
    expect(parsed.success, `${op}: ${r.raw}`).toBe(true);
    if (parsed.success) expect(JSON.parse(JSON.stringify(parsed.data)), `${op} carries no field outside its contract`).toEqual(r.body);
    shapeChecked.add(op);
  }
  return r.body.data;
};
const fail = (r: Res, status: number, code: string): Json => {
  expect(r.status, r.raw).toBe(status);
  expect(ErrorResponse.safeParse(r.body).success, r.raw).toBe(true);
  expect(r.body.error.code, r.raw).toBe(code);
  expect(r.body.error.correlationId, 'the error carries the correlation id of the request').toBe(r.headers[CORRELATION_HEADER]);
  return r.body.error;
};
const SESSION_REVOKED_CHALLENGE = `Bearer realm="${REALM}", error="invalid_token"`;
/** 401 SESSION_REVOKED with the Bearer invalid_token challenge and the managed message key. */
const revoked = (r: Res): Json => {
  const e = fail(r, 401, 'SESSION_REVOKED');
  expect(e.category).toBe('AUTHENTICATION');
  expect(r.headers['www-authenticate']).toBe(SESSION_REVOKED_CHALLENGE);
  expect(e.details).toEqual({ messageKey: 'account.security.error.session_revoked' });
  return e;
};
const stepUpChallenge = (maxAge: number, acr?: string): string =>
  `Bearer realm="${REALM}", error="insufficient_user_authentication", error_description="A more recent or stronger authentication is required", max_age="${maxAge}"${
    acr ? `, acr_values="${acr}"` : ''
  }`;
/** 401 STEP_UP_REQUIRED with the exact RFC 9470 challenge and the StepUpDetails of the contract. */
const stepUp = (r: Res, requirement: 'RECENT_AUTHENTICATION' | 'MFA' = 'RECENT_AUTHENTICATION', maxAge = 900): Json => {
  const e = fail(r, 401, 'STEP_UP_REQUIRED');
  expect(e.category).toBe('AUTHENTICATION');
  expect(r.headers['www-authenticate']).toBe(stepUpChallenge(maxAge, requirement === 'MFA' ? ACR_MFA : undefined));
  const { messageKey, ...rest } = e.details;
  expect(messageKey).toBe('account.security.error.step_up_required');
  expect(StepUpDetails.parse(rest)).toEqual(rest);
  expect(rest).toEqual(requirement === 'MFA' ? { requirement, maxAgeSeconds: maxAge, acrValues: ACR_MFA } : { requirement, maxAgeSeconds: maxAge });
  return e;
};
/** The shape of a JSON value with every scalar replaced by its type: two answers with the same shape differ in values only. */
const shape = (v: unknown): unknown =>
  v === null ? null : Array.isArray(v) ? v.map(shape) : typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v;

// ---------------------------------------------------------------- routes
const SEC = '/account/security';
const overview = (a: Actor, o?: CallOptions) => call(a, 'GET', SEC, o);
const sessionsOf = (a: Actor, o?: CallOptions) => call(a, 'GET', `${SEC}/sessions`, o);
const devicesOf = (a: Actor, o?: CallOptions) => call(a, 'GET', `${SEC}/devices`, o);
const revokeOne = (a: Actor, id: string, o?: CallOptions) => call(a, 'DELETE', `${SEC}/sessions/${id}`, o);
const revokeAll = (a: Actor, body: unknown = {}, o?: CallOptions) => call(a, 'POST', `${SEC}/sessions/revoke-all`, { ...o, body });
const signOut = (a: Actor, o?: CallOptions) => call(a, 'POST', `${SEC}/sessions/current/sign-out`, o);
const trustDevice = (a: Actor, o?: CallOptions) => call(a, 'POST', `${SEC}/devices/current/trust`, o);
const untrustDevice = (a: Actor, o?: CallOptions) => call(a, 'DELETE', `${SEC}/devices/current/trust`, o);
const removeDevice = (a: Actor, id: string, o?: CallOptions) => call(a, 'DELETE', `${SEC}/devices/${id}`, o);
const activity = (a: Actor, query = '', o?: CallOptions) => call(a, 'GET', `${SEC}/activity${query}`, o);
const enroll = (a: Actor, method: unknown, o?: CallOptions) => call(a, 'POST', `${SEC}/mfa/enrollment`, { ...o, body: { method } });
const registerDevice = (a: Actor, device: unknown, userAgent?: unknown, o?: CallOptions) =>
  call(a, 'POST', `${SEC}/sessions/current`, { ...o, body: { device, ...(userAgent === undefined ? {} : { userAgent }) } });
const me = (a: Actor, o?: CallOptions) => call(a, 'GET', '/account/me', o);
const resetPassword = (email: unknown, o?: CallOptions) => call(undefined, 'POST', '/auth/password-reset', { ...o, body: { email } });

// ---------------------------------------------------------------- the database
const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => iso.database.query<T>(text, params);
const count = async (text: string, params: unknown[] = []): Promise<number> =>
  Number((await q<{ n: string }>(`SELECT count(*) AS n FROM (${text}) x`, params))[0]!.n);
const dbEpoch = async (): Promise<number> => Number((await q<{ e: number }>('SELECT extract(epoch FROM clock_timestamp())::float8 AS e'))[0]!.e);
interface SessionRow {
  application_session_id: string;
  account_id: string;
  keycloak_session_id: string;
  account_device_id: string | null;
  revoked_at: Date | null;
  revocation_reason: string | null;
  created_at: Date;
  last_seen_at: Date;
}
const sessionRows = (accountId: string) =>
  q<SessionRow>(`SELECT * FROM identity.application_sessions WHERE account_id = $1 ORDER BY created_at, application_session_id`, [accountId]);
const sessionRowOf = async (sid: string): Promise<SessionRow | undefined> =>
  (await q<SessionRow>('SELECT * FROM identity.application_sessions WHERE keycloak_session_id = $1', [sid]))[0];
interface DeviceRow {
  account_device_id: string;
  device_hash: string;
  browser_family: string;
  os_family: string;
  device_class: string;
  trusted_at: Date | null;
  trusted_until: Date | null;
  removed_at: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
}
const deviceRows = (accountId: string) =>
  q<DeviceRow>('SELECT * FROM identity.account_devices WHERE account_id = $1 ORDER BY first_seen_at, account_device_id', [accountId]);
const auditOf = (accountId: string, like = '%') =>
  q<{
    action: string;
    actor: string;
    changes: Json;
    correlation_id: string;
    application_session_id: string | null;
    account_device_id: string | null;
    occurred_at: Date;
  }>(
    `SELECT action, actor, changes, correlation_id, application_session_id, account_device_id, occurred_at FROM identity.account_audit_events
      WHERE account_id = $1 AND action LIKE $2 ORDER BY occurred_at, audit_event_id`,
    [accountId, like],
  );
const actionsOf = async (accountId: string, like = '%'): Promise<string[]> => (await auditOf(accountId, like)).map((r) => r.action);
/** The observed second-factor transitions (not the enrolment requests). */
const mfaActions = async (accountId: string): Promise<string[]> => (await actionsOf(accountId)).filter((x) => /^MFA_(ENABLED|DISABLED)$/.test(x));
const recoveryActions = async (accountId: string): Promise<string[]> =>
  (await actionsOf(accountId)).filter((x) => /^RECOVERY_CODES_(ENABLED|DISABLED)$/.test(x));
const eventsOf = (accountId: string, type = '%') =>
  q<{ event_type: string; payload_json: Json; actor_id: string; correlation_id: string }>(
    `SELECT event_type, payload_json, actor_id, correlation_id FROM integration.outbox_events WHERE aggregate_id = $1 AND event_type LIKE $2 ORDER BY created_at, event_type`,
    [accountId, type],
  );
const watermarkOf = async (accountId: string): Promise<number | null> => {
  const r = (
    await q<{ e: number | null }>('SELECT extract(epoch FROM sessions_not_before)::float8 AS e FROM identity.accounts WHERE account_id = $1', [accountId])
  )[0]!;
  return r.e;
};
/** Counters of everything the security layer writes, to prove a refused request changed nothing. */
const writes = async () => ({
  sessions: await count('SELECT 1 FROM identity.application_sessions'),
  devices: await count('SELECT 1 FROM identity.account_devices'),
  audit: await count('SELECT 1 FROM identity.account_audit_events'),
  events: await count('SELECT 1 FROM integration.outbox_events'),
  accounts: await count('SELECT 1 FROM identity.accounts'),
  revoked: await count('SELECT 1 FROM identity.application_sessions WHERE revoked_at IS NOT NULL'),
  trusted: await count('SELECT 1 FROM identity.account_devices WHERE trusted_until IS NOT NULL'),
  watermarks: await count('SELECT 1 FROM identity.accounts WHERE sessions_not_before IS NOT NULL'),
});

// ---------------------------------------------------------------- actors and flows
async function newActor(label: string, first: MintOptions = {}): Promise<Actor> {
  const sub = `itest-${label}-${randomUUID()}`;
  secrets.subjects.push(sub);
  const a: Actor = { label, sub, accountId: '', ip: nextIp(), t0: undefined as unknown as Tok };
  provider.setUser(sub);
  a.t0 = await mint(a, first);
  const created = await me(a); // the account and its first session are created by the first authenticated request
  expect(created.status, created.raw).toBe(200);
  a.accountId = created.body.data.accountId;
  return a;
}
/** A further Keycloak session (login) of the same person, seen by the API from its first request on. */
async function login(a: Actor, o: MintOptions = {}): Promise<Tok> {
  const t = await mint(a, o);
  expect((await me(a, { as: t })).status).toBe(200);
  return t;
}
/** A login made AFTER the account's latest sign-out-everywhere: its auth_time is later than the watermark. */
async function freshLogin(a: Actor): Promise<Tok> {
  const wm = await watermarkOf(a.accountId);
  return login(a, wm === null ? {} : { authTime: Math.ceil(wm) + 3 });
}
/** The application session id of a token (as the sessions listing shows it). */
const sessionIdOf = async (a: Actor, t: Tok): Promise<string> => {
  const row = await sessionRowOf(t.sid);
  expect(row, 'the session has been seen').toBeDefined();
  expect(row!.account_id).toBe(a.accountId);
  return row!.application_session_id;
};

const newSecret = (): string => {
  const s = randomBytes(32).toString('base64url');
  secrets.devices.push(s);
  return s;
};
const UA = {
  chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  safariIpad: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  operaLinux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0',
  chromeAndroidPhone: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  chromeAndroidTablet: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  curl: 'curl/8.7.1',
};
/** Registers a browser for the actor's session (default: the first one); a fresh secret unless one is given. Returns the device id. */
async function withDevice(a: Actor, o: { as?: Tok; secret?: string; ua?: string } = {}): Promise<{ deviceId: string; secret: string }> {
  const secret = o.secret ?? newSecret();
  const r = await registerDevice(a, secret, o.ua ?? UA.chromeWindows, { as: o.as });
  const data = ok(r, OP.register);
  expect(data.deviceId, r.raw).toEqual(expect.any(String));
  return { deviceId: data.deviceId, secret };
}
/** Makes the trust window of a device end in the past (the test superuser; the guard allows trust columns to change). */
const expireTrust = (deviceId: string) =>
  q(
    `UPDATE identity.account_devices SET trusted_at = clock_timestamp() - interval '40 days', trusted_until = clock_timestamp() - interval '1 day' WHERE account_device_id = $1`,
    [deviceId],
  );

async function verifyEmail(a: Actor, address = `reset-${randomUUID()}@example.test`): Promise<string> {
  secrets.emails.push(address);
  ok(await call(a, 'POST', '/account/email', { body: { email: address } }));
  const before = emailSender.sent.length;
  ok(await call(a, 'POST', '/account/email/verification/send', { body: {} }));
  const code = String(emailSender.sent[before]!.variables.verification_code);
  expect(ok(await call(a, 'POST', '/account/email/verification/confirm-code', { body: { code } })).changed).toBe(true);
  return address;
}
const phoneNumbers = new Set<string>();
const newPhone = (): string => {
  for (;;) {
    const n = `+1${['202', '212', '303', '404', '505'][randomInt(5)]}555${randomInt(10)}${String(randomInt(0, 900)).padStart(3, '0')}`;
    if (!phoneNumbers.has(n)) {
      phoneNumbers.add(n);
      return n;
    }
  }
};
async function verifyPhone(a: Actor): Promise<string> {
  const number = newPhone();
  ok(await call(a, 'POST', '/account/phone', { body: { phone: number } }));
  const before = smsSender.sent.length;
  ok(await call(a, 'POST', '/account/phone/verification/send', { body: {} }));
  const code = String(smsSender.sent[before]!.variables.verification_code);
  expect(ok(await call(a, 'POST', '/account/phone/verification/confirm-code', { body: { code } })).changed).toBe(true);
  return number;
}

// ---------------------------------------------------------------- variants of the app over the same database
interface Variant {
  provider?: SecurityIdentityProvider;
  touchSeconds?: number;
  graceSeconds?: number;
  limiter?: RateLimiter;
  hops?: number;
  policy?: SecurityPolicyProvider;
}
const verifierFor = () =>
  createTokenVerifier({ issuer: TEST_ISSUER, apiAudience: 'bananagig-api', jwks: keys.getKey, webClientId: 'bananagig-web', adminClientId: 'bananagig-admin' });
async function makeApp(v: Variant = {}): Promise<{ app: FastifyInstance; security: SecurityService }> {
  const appCfg = loadConfig({ service: 'bananagig-api', env: envFor(v.hops) });
  const sec = new SecurityService({
    database: iso.database,
    policy: v.policy ?? policyProvider,
    identityProvider: v.provider ?? provider,
    rateLimiter: v.limiter ?? limiter,
    hashSecret: HASH_KEY,
    ...(v.touchSeconds === undefined ? {} : { touchSeconds: v.touchSeconds }),
    ...(v.graceSeconds === undefined ? {} : { reconcileGraceSeconds: v.graceSeconds }),
  });
  const emailVerification = new EmailVerificationService({
    database: iso.database,
    policy: createVerificationPolicyProvider(configuration),
    sender: emailSender,
    linkFor: createVerificationLinkBuilder(appCfg.identity.webPublicUrl),
    hashSecret: HASH_KEY,
    rateLimiter: v.limiter ?? limiter,
  });
  const phoneVerification = new PhoneVerificationService({
    database: iso.database,
    policy: createPhonePolicyProvider(configuration),
    sender: smsSender,
    intelligence: new FakePhoneIntelligence(),
    countries: usOnly,
    hashSecret: HASH_KEY,
    rateLimiter: v.limiter ?? limiter,
  });
  const instance = await buildApp({
    cfg: appCfg,
    verifier: verifierFor(),
    configuration,
    accounts,
    emailVerification,
    phoneVerification,
    security: sec,
    readiness: async () => ({}),
  });
  await instance.ready();
  extraApps.push(instance);
  return { app: instance, security: sec };
}

// ---------------------------------------------------------------- log capture (for the whole file)
const logLines: string[] = [];
function captureLogs(): void {
  const capture = (...a: unknown[]) => void logLines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(capture);
}

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  keys = await createTestKeys('k1');
  configuration = new ConfigurationService({ database: iso.database, cache: new MemoryConfigCache(), env: 'test', allowTestKeys: true });
  accounts = new AccountService({ database: iso.database, lastSeenTouchSeconds: 0 });
  realPolicy = createSecurityPolicyProvider(configuration);
  captureLogs();
  const made = await makeApp();
  app = made.app;
  security = made.security;
});
afterAll(async () => {
  for (const a of extraApps) await a.close();
  await iso?.drop();
});

// ====================================================================== seeded policy
describe('seeded policy (migration 0012) through the real configuration registry', () => {
  it('serves the six security values: 3 PRD defaults and 3 assumptions', async () => {
    expect(await realPolicy.policy()).toEqual(SEEDED_SECURITY_POLICY);
    expect(await security.getPolicy()).toEqual({
      trustedBrowserDays: 30,
      keepSignedInDays: 30,
      stepUpValidMinutes: 15,
      activityLogDays: 90,
      resetLinkValidityMinutes: 60,
      resetMaxRequestsPerHour: 5,
    });
  });
});

// ====================================================================== session creation and reuse
describe('the application session: created by the first authenticated request, reused by the same sid', () => {
  it('the very first request of a login creates exactly one session, one SESSION_CREATED audit row and one session-created event', async () => {
    const a = await newActor('create');
    const rows = await sessionRows(a.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ keycloak_session_id: a.t0.sid, account_device_id: null, revoked_at: null, revocation_reason: null });
    const audit = await auditOf(a.accountId, 'SESSION%');
    expect(audit.map((r) => r.action)).toEqual(['SESSION_CREATED']);
    expect(audit[0]!.application_session_id).toBe(rows[0]!.application_session_id);
    expect(audit[0]!.actor).toBe(`account:${a.accountId}`);
    const events = await eventsOf(a.accountId, 'bananagig.identity.session-%');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: SECURITY_EVENTS.sessionCreated,
      payload_json: { accountId: a.accountId, applicationSessionId: rows[0]!.application_session_id, accountDeviceId: null },
    });
  });

  it('is observable through GET /account/security/sessions: one ACTIVE current session, no browser yet, not trusted', async () => {
    const a = await newActor('observe');
    const data = ok(await sessionsOf(a), OP.sessions);
    expect(data.reconciled).toBe(true);
    expect(data.sessions).toHaveLength(1);
    const row = (await sessionRows(a.accountId))[0]!;
    expect(data.sessions[0]).toEqual({
      sessionId: row.application_session_id,
      current: true,
      status: 'ACTIVE',
      device: null,
      deviceId: null,
      createdAt: row.created_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      trusted: false,
      trustedUntil: null,
    });
    // the id shown is the application id, never the Keycloak sid
    expect(data.sessions[0].sessionId).not.toBe(a.t0.sid);
  });

  it('the same sid reuses the session: any number of requests and any number of tokens of that session leave one row, one audit row and one event', async () => {
    const a = await newActor('reuse');
    const again = await mint(a, { sid: a.t0.sid }); // a refreshed access token of the same Keycloak session
    for (let i = 0; i < 4; i++) ok(await me(a));
    ok(await me(a, { as: again }));
    ok(await sessionsOf(a, { as: again }), OP.sessions);
    expect(await sessionRows(a.accountId)).toHaveLength(1);
    expect(await actionsOf(a.accountId, 'SESSION%')).toEqual(['SESSION_CREATED']);
    expect(await eventsOf(a.accountId, 'bananagig.identity.session-%')).toHaveLength(1);
    const listed = ok(await sessionsOf(a, { as: again }), OP.sessions);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0].current).toBe(true);
  });

  it('does not write on every request: last_seen_at is touched at most once per touch interval (60 s)', async () => {
    const a = await newActor('touch');
    const before = (await sessionRows(a.accountId))[0]!.last_seen_at;
    for (let i = 0; i < 3; i++) ok(await me(a));
    expect((await sessionRows(a.accountId))[0]!.last_seen_at.toISOString()).toBe(before.toISOString());
  });

  it('touches last_seen_at on a request when the touch interval has elapsed (an app configured with a 0 s interval)', async () => {
    const v = await makeApp({ touchSeconds: 0 });
    const a = await newActor('touch0');
    const before = (await sessionRows(a.accountId))[0]!.last_seen_at;
    await new Promise((r) => setTimeout(r, 15));
    ok(await me(a, { app: v.app }));
    expect((await sessionRows(a.accountId))[0]!.last_seen_at.getTime()).toBeGreaterThan(before.getTime());
  });

  it('a second sid is a second session; the list shows the current one first and the rest by last activity, and `current` follows the token', async () => {
    const a = await newActor('two');
    const s2 = await login(a);
    const s3 = await login(a);
    const ids = {
      s1: await sessionIdOf(a, a.t0),
      s2: await sessionIdOf(a, s2),
      s3: await sessionIdOf(a, s3),
    };
    expect(new Set(Object.values(ids)).size).toBe(3);
    expect(await sessionRows(a.accountId)).toHaveLength(3);
    expect(await actionsOf(a.accountId, 'SESSION%')).toEqual(['SESSION_CREATED', 'SESSION_CREATED', 'SESSION_CREATED']);

    const seenFromS1 = ok(await sessionsOf(a), OP.sessions).sessions.map((s: Json) => [s.sessionId, s.current]);
    expect(seenFromS1).toEqual([
      [ids.s1, true],
      [ids.s3, false],
      [ids.s2, false],
    ]);
    const seenFromS2 = ok(await sessionsOf(a, { as: s2 }), OP.sessions).sessions.map((s: Json) => [s.sessionId, s.current]);
    expect(seenFromS2).toEqual([
      [ids.s2, true],
      [ids.s3, false],
      [ids.s1, false],
    ]);
  });

  it('a sid that already belongs to ANOTHER account is refused as a revoked session and never reassigned or leaked', async () => {
    const owner = await newActor('sid-owner');
    const thief = await newActor('sid-thief');
    const stolen = await mint(thief, { sid: owner.t0.sid, inProvider: false });
    revoked(await me(thief, { as: stolen }));
    revoked(await sessionsOf(thief, { as: stolen }));
    // the owner is unaffected and the row still belongs to the owner
    ok(await me(owner));
    expect((await sessionRowOf(owner.t0.sid))!.revoked_at).toBeNull();
    expect(await sessionRows(thief.accountId)).toHaveLength(1); // only the thief's own first session
  });

  it('a session id that cannot be a Keycloak session id (too long, with a space or a control character) is a 400 and creates nothing', async () => {
    const a = await newActor('badsid');
    const before = await writes();
    for (const sid of ['x'.repeat(101), 'has space', `ctl${String.fromCharCode(1)}char`, `tab${String.fromCharCode(9)}x`]) {
      const t = await mint(a, { sid, inProvider: false });
      const e = fail(await me(a, { as: t }), 400, 'ACCOUNT_VALIDATION_FAILED');
      expect(e.category).toBe('VALIDATION');
      expect(JSON.stringify(e)).not.toContain(sid.slice(0, 20) === 'xxxxxxxxxxxxxxxxxxxx' ? 'xxxxxxxxxxxxxxxxxxxx' : sid);
    }
    expect(await writes()).toEqual(before);
    // 100 characters is the limit and is fine
    const edge = await mint(a, { sid: 'y'.repeat(100), inProvider: false });
    ok(await me(a, { as: edge }));
  });

  it('a token without a sid is a 401 INVALID_TOKEN with the Bearer invalid_token challenge on every account route, and creates no session', async () => {
    const a = await newActor('nosid');
    const noSid = await mint(a, { sid: null });
    const before = await writes();
    for (const [method, url, body] of [
      ['GET', '/account/me', undefined],
      ['GET', '/account/email', undefined],
      ['GET', '/account/phone', undefined],
      ['GET', SEC, undefined],
      ['GET', `${SEC}/sessions`, undefined],
      ['GET', `${SEC}/devices`, undefined],
      ['GET', `${SEC}/activity`, undefined],
      ['POST', `${SEC}/sessions/revoke-all`, {}],
      ['POST', `${SEC}/sessions/current`, { device: newSecret() }],
      ['POST', `${SEC}/devices/current/trust`, undefined],
      ['POST', `${SEC}/mfa/enrollment`, { method: 'TOTP' }],
    ] as const) {
      const r = await call(a, method, url, { as: noSid, body });
      const e = fail(r, 401, 'INVALID_TOKEN');
      expect(e.category, url).toBe('AUTHENTICATION');
      expect(r.headers['www-authenticate'], url).toBe(SESSION_REVOKED_CHALLENGE);
    }
    expect(await writes()).toEqual(before);
    // an empty sid is no sid either
    const empty = await mint(a, { sid: '' });
    fail(await me(a, { as: empty }), 401, 'INVALID_TOKEN');
  });

  it('a missing, malformed, tampered, expired or wrong-context token never reaches the session layer', async () => {
    const a = await newActor('badtokens');
    const before = await writes();
    const good = a.t0.token;
    const parts = good.split('.');
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()), sid: randomUUID() })).toString('base64url')}.${parts[2]}`;
    const expired = await mint(a, { expiresInSec: -60 });
    const other = await mint(a, { claims: { azp: 'bananagig-dev-test' } });
    const fakeAdmin = await mint(a, {
      claims: { azp: 'bananagig-admin', resource_access: { 'bananagig-admin': { roles: ['admin-console-access'] } } },
    });
    fail(await me(a, { as: null }), 401, 'AUTHENTICATION_REQUIRED');
    fail(await me(a, { as: '', headers: { authorization: 'Bearer' } }), 401, 'INVALID_TOKEN');
    fail(await me(a, { as: tampered }), 401, 'INVALID_TOKEN');
    fail(await me(a, { as: expired }), 401, 'INVALID_TOKEN');
    fail(await me(a, { as: 'not-a-jwt' }), 401, 'INVALID_TOKEN');
    fail(await me(a, { as: other }), 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED');
    fail(await me(a, { as: fakeAdmin }), 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED');
    // a refused request created no session, no matter how valid the sid looked
    expect(await sessionRowOf(other.sid)).toBeUndefined();
    expect(await sessionRowOf(fakeAdmin.sid)).toBeUndefined();
    const after = await writes();
    expect(after.sessions).toBe(before.sessions);
    expect(after.devices).toBe(before.devices);
  });
});

// ====================================================================== revoking one session
describe('revoking one session', () => {
  it('DELETE one session: THAT token is refused on its very next request on ANY account route, the other token keeps working', async () => {
    const a = await newActor('revoke-one');
    const s2 = await login(a);
    const s2id = await sessionIdOf(a, s2);
    const r = await revokeOne(a, s2id);
    expect(ok(r, OP.revoke)).toEqual({ sessionId: s2id, changed: true, current: false, keycloak: 'ENDED' });
    expect(provider.endedSessions).toContain(s2.sid);

    // the access token is still cryptographically valid for minutes; the registry refuses it on every route, whatever the body
    const before = await writes();
    const fakeId = randomUUID();
    const routes: [string, string, unknown][] = [
      ['GET', '/account/me', undefined],
      ['PUT', '/account/profile', { givenName: 'X' }],
      ['POST', '/account/active-role', { role: 'CUSTOMER' }],
      ['GET', '/account/email', undefined],
      ['POST', '/account/email', { email: 'x@example.test' }],
      ['POST', '/account/email/verification/send', {}],
      ['POST', '/account/email/verification/confirm-code', { code: '123456' }],
      ['POST', '/account/email/verification/confirm-link', { token: 'x'.repeat(43) }],
      ['GET', '/account/phone', undefined],
      ['POST', '/account/phone', { phone: '+12025550142' }],
      ['POST', '/account/phone/verification/send', {}],
      ['POST', '/account/phone/verification/confirm-code', { code: '123456' }],
      ['GET', SEC, undefined],
      ['GET', `${SEC}/sessions`, undefined],
      ['DELETE', `${SEC}/sessions/${fakeId}`, undefined],
      ['POST', `${SEC}/sessions/revoke-all`, {}],
      ['POST', `${SEC}/sessions/current`, { device: newSecret() }],
      ['POST', `${SEC}/sessions/current/sign-out`, undefined],
      ['GET', `${SEC}/devices`, undefined],
      ['POST', `${SEC}/devices/current/trust`, undefined],
      ['DELETE', `${SEC}/devices/current/trust`, undefined],
      ['DELETE', `${SEC}/devices/${fakeId}`, undefined],
      ['GET', `${SEC}/activity`, undefined],
      ['POST', `${SEC}/mfa/enrollment`, { method: 'TOTP' }],
    ];
    for (const [method, url, body] of routes) revoked(await call(a, method as 'GET', url, { as: s2, body }));
    // even a body that would be a 400 for a live session: authentication first
    revoked(await call(a, 'POST', `${SEC}/sessions/revoke-all`, { as: s2, body: { includeCurrent: 'yes' } }));
    revoked(await call(a, 'POST', `${SEC}/sessions/current`, { as: s2, body: { nope: 1 } }));
    revoked(await call(a, 'GET', `${SEC}/activity?limit=0`, { as: s2 }));
    expect(await writes()).toEqual(before);

    // the other token of the account is untouched
    ok(await me(a));
    expect(ok(await sessionsOf(a), OP.sessions).sessions.map((s: Json) => s.sessionId)).toEqual([await sessionIdOf(a, a.t0)]);
  });

  it('records SESSION_REVOKED (reason REVOKED_BY_USER) and a session-revoked event once, with the application session id', async () => {
    const a = await newActor('revoke-audit');
    const s2 = await login(a);
    const id = await sessionIdOf(a, s2);
    ok(await revokeOne(a, id), OP.revoke);
    const audit = await auditOf(a.accountId, 'SESSION_REVOKED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ application_session_id: id, changes: { reason: 'REVOKED_BY_USER' } });
    const events = await eventsOf(a.accountId, SECURITY_EVENTS.sessionRevoked);
    expect(events.map((e) => e.payload_json)).toEqual([{ accountId: a.accountId, applicationSessionId: id, reason: 'REVOKED_BY_USER' }]);
    expect(await sessionRowOf(s2.sid)).toMatchObject({ revocation_reason: 'REVOKED_BY_USER' });
  });

  it('is idempotent: revoking again answers 200 changed=false, retries the provider, and writes nothing', async () => {
    const a = await newActor('revoke-twice');
    const s2 = await login(a);
    const id = await sessionIdOf(a, s2);
    ok(await revokeOne(a, id), OP.revoke);
    const before = await writes();
    // nothing changes in the database; the identity provider is asked again (best effort, it may have failed the first time)
    expect(ok(await revokeOne(a, id), OP.revoke)).toEqual({ sessionId: id, changed: false, current: false, keycloak: 'ENDED' });
    expect(await writes()).toEqual(before);
  });

  it('accepts the id in upper case (a UUID is case-insensitive) and answers for the same session', async () => {
    const a = await newActor('revoke-case');
    const s2 = await login(a);
    const id = await sessionIdOf(a, s2);
    expect(ok(await revokeOne(a, id.toUpperCase()), OP.revoke)).toEqual({ sessionId: id, changed: true, current: false, keycloak: 'ENDED' });
    revoked(await me(a, { as: s2 }));
  });

  it('a revoked session never returns: not with a later token of the same sid, not after the account is revoked-all, and not after a watermark-clean login', async () => {
    const a = await newActor('revoke-sticky');
    const s2 = await login(a);
    ok(await revokeOne(a, await sessionIdOf(a, s2)), OP.revoke);
    const refreshed = await mint(a, { sid: s2.sid, authTime: appNow() + 30 }); // same Keycloak session, fresh token
    revoked(await me(a, { as: refreshed }));
    expect((await sessionRowOf(s2.sid))!.revoked_at).not.toBeNull();
  });

  it('revoking the CURRENT session is allowed: current=true, and the same token is refused next', async () => {
    const a = await newActor('revoke-self');
    const keep = await login(a);
    const id = await sessionIdOf(a, a.t0);
    expect(ok(await revokeOne(a, id), OP.revoke)).toEqual({ sessionId: id, changed: true, current: true, keycloak: 'ENDED' });
    revoked(await me(a));
    ok(await me(a, { as: keep }));
  });

  it('a path id that is not a canonical UUID is a 400 naming the parameter and never the value; an unknown or foreign id is a 404 that cannot be told apart', async () => {
    const a = await newActor('revoke-ids');
    const b = await newActor('revoke-ids-b');
    const foreign = await sessionIdOf(b, b.t0);
    const before = await writes();
    for (const bad of [
      'not-a-uuid',
      '123',
      'g'.repeat(36),
      `${randomUUID()}x`,
      randomUUID().replace(/-/g, ''),
      '%20',
      "'; DROP TABLE identity.application_sessions; --",
    ]) {
      const r = await revokeOne(a, encodeURIComponent(bad));
      const e = fail(r, 400, 'VALIDATION_FAILED');
      expect(JSON.stringify(e)).not.toContain(bad);
      expect(e.details.issues[0].path).toBe('params.sessionId');
    }
    const unknown = fail(await revokeOne(a, randomUUID()), 404, 'ACCOUNT_SESSION_NOT_FOUND');
    const ofB = fail(await revokeOne(a, foreign), 404, 'ACCOUNT_SESSION_NOT_FOUND');
    expect(unknown.category).toBe('NOT_FOUND');
    expect(unknown.message).toBe(ofB.message);
    expect(unknown.details).toEqual(ofB.details);
    expect(unknown.details).toEqual({ messageKey: 'account.security.error.session_not_found' });
    expect(await writes()).toEqual(before);
    // B's session was not touched
    expect((await sessionRowOf(b.t0.sid))!.revoked_at).toBeNull();
    ok(await me(b));
  });

  it('a path that is too long for the router is a 400 in the standard envelope', async () => {
    const a = await newActor('revoke-long');
    const r = await revokeOne(a, 'a'.repeat(300));
    expect(r.status).toBe(400);
    expect(ErrorResponse.safeParse(r.body).success).toBe(true);
    expect(r.body.error.code).toBe('PATH_PARAMETER_TOO_LONG');
  });
});

// ====================================================================== revoke-all and the watermark
describe('sign out everywhere (revoke-all) and the revocation watermark', () => {
  it('default excludes the current session: every other session is refused at once (well under one second), the current one keeps working', async () => {
    const a = await newActor('all');
    const others = [await login(a), await login(a), await login(a), await login(a)];
    const started = performance.now();
    const r = await revokeAll(a, {});
    expect(ok(r, OP.revokeAll)).toEqual({ revokedCount: 4, keycloak: 'ENDED' });
    for (const t of others) revoked(await me(a, { as: t }));
    const elapsed = performance.now() - started;
    expect(elapsed, `revoke-all and the next requests of four sessions took ${Math.round(elapsed)} ms (the PRD allows a minute)`).toBeLessThan(1000);
    ok(await me(a));
    expect(ok(await sessionsOf(a), OP.sessions).sessions).toHaveLength(1);
    // the provider was asked to end exactly the others
    expect(provider.endedSessions).toEqual(expect.arrayContaining(others.map((t) => t.sid)));
    expect(provider.endedSessions).not.toContain(a.t0.sid);
  });

  it('an empty body, `{}` and {"includeCurrent":false} are the same default; includeCurrent true revokes the caller too', async () => {
    for (const [i, body] of ([{}, { includeCurrent: false }] as const).entries()) {
      const a = await newActor(`all-default-${i}`);
      const other = await login(a);
      expect(ok(await revokeAll(a, body), OP.revokeAll).revokedCount).toBe(1);
      revoked(await me(a, { as: other }));
      ok(await me(a));
    }
    const a = await newActor('all-nobody');
    const other = await login(a);
    // a POST with no body at all is refused (the contract asks for an object); the web server sends `{}`
    fail(await call(a, 'POST', `${SEC}/sessions/revoke-all`), 400, 'VALIDATION_FAILED');
    ok(await me(a, { as: other }));

    const c = await newActor('all-current');
    const second = await login(c);
    const r = await revokeAll(c, { includeCurrent: true });
    expect(ok(r, OP.revokeAll)).toEqual({ revokedCount: 2, keycloak: 'ENDED' });
    revoked(await me(c));
    revoked(await me(c, { as: second }));
    expect(provider.callsOf('endAllSessions').some((x) => x.subject === c.sub)).toBe(true);
  });

  it('audits one SESSION_REVOKED per session (reason SIGN_OUT_EVERYWHERE) and one SESSIONS_REVOKED_ALL, with matching events, and raises the watermark', async () => {
    const a = await newActor('all-audit');
    const s2 = await login(a);
    const s3 = await login(a);
    expect(await watermarkOf(a.accountId)).toBeNull();
    const ids = [await sessionIdOf(a, s2), await sessionIdOf(a, s3)];
    ok(await revokeAll(a, {}), OP.revokeAll);
    const perSession = await auditOf(a.accountId, 'SESSION_REVOKED');
    expect(perSession.map((r) => r.application_session_id).sort()).toEqual([...ids].sort());
    expect(perSession.every((r) => r.changes.reason === 'SIGN_OUT_EVERYWHERE')).toBe(true);
    const all = await auditOf(a.accountId, 'SESSIONS_REVOKED_ALL');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ application_session_id: null, changes: { revokedCount: 2, includeCurrent: false } });
    const events = await eventsOf(a.accountId, 'bananagig.identity.sessions-revoked-all.v1');
    expect(events.map((e) => e.payload_json)).toEqual([{ accountId: a.accountId, revokedCount: 2, includeCurrent: false }]);
    expect((await eventsOf(a.accountId, SECURITY_EVENTS.sessionRevoked)).length).toBe(2);
    expect(await watermarkOf(a.accountId)).not.toBeNull();
  });

  it('is idempotent and harmless with nothing to revoke: revokedCount 0, keycloak NOT_NEEDED, still one more SESSIONS_REVOKED_ALL row', async () => {
    const a = await newActor('all-empty');
    expect(ok(await revokeAll(a, {}), OP.revokeAll)).toEqual({ revokedCount: 0, keycloak: 'NOT_NEEDED' });
    expect(ok(await revokeAll(a, {}), OP.revokeAll)).toEqual({ revokedCount: 0, keycloak: 'NOT_NEEDED' });
    ok(await me(a));
  });

  it('WATERMARK: a Keycloak session the API has NEVER seen is refused at its first request when its auth_time is older than the sign-out-everywhere; a later login is accepted', async () => {
    const a = await newActor('wm');
    const now = await dbEpoch();
    const unseenOld = await mint(a, { authTime: Math.floor(now) - 300 });
    const unseenOlder = await mint(a, { authTime: Math.floor(now) - 3600 });
    const unseenNoAuthTime = await mint(a, { authTime: null });
    expect(await watermarkOf(a.accountId)).toBeNull();

    ok(await revokeAll(a, {}), OP.revokeAll);
    const wm = (await watermarkOf(a.accountId))!;
    expect(wm).toBeGreaterThan(now - 1);

    const before = await writes();
    for (const t of [unseenOld, unseenOlder, unseenNoAuthTime]) {
      revoked(await me(a, { as: t }));
      revoked(await sessionsOf(a, { as: t })); // and again: no row appeared in between
    }
    for (const t of [unseenOld, unseenOlder, unseenNoAuthTime]) expect(await sessionRowOf(t.sid), 'no session row for a refused first sight').toBeUndefined();
    expect(await writes()).toEqual(before);

    // a login after the sign-out has a later auth_time and is a normal new session
    const later = await mint(a, { authTime: Math.ceil(wm) + 1 });
    ok(await me(a, { as: later }));
    expect(await sessionRowOf(later.sid)).toBeDefined();
    // the current session (seen before, auth_time older than the watermark) is governed by its own row and keeps working
    ok(await me(a));
  });

  it('the watermark only gates FIRST sight: a session that already has a row is governed by its own revoked_at, and without a watermark a token without auth_time is accepted', async () => {
    const plain = await newActor('wm-none');
    const noAuthTime = await mint(plain, { authTime: null });
    ok(await me(plain, { as: noAuthTime }));
    ok(await me(plain, { as: noAuthTime }));

    const a = await newActor('wm-seen');
    const seen = await login(a, { authTime: appNow() - 400 });
    ok(await revokeAll(a, { includeCurrent: false }), OP.revokeAll);
    revoked(await me(a, { as: seen })); // revoked by its row
    const keep = (await watermarkOf(a.accountId))!;
    const next = await login(a, { authTime: Math.ceil(keep) + 1 });
    // a LATER revoke-all moves the watermark forward only
    ok(await revokeAll(a, {}), OP.revokeAll);
    revoked(await me(a, { as: next }));
    expect((await watermarkOf(a.accountId))!).toBeGreaterThanOrEqual(keep);
  });

  it('measures the "sign out everywhere" latency against a never-seen session as well: all refused within one second of the call', async () => {
    const a = await newActor('wm-latency');
    const seen = [await login(a), await login(a), await login(a)];
    const now = await dbEpoch();
    const unseen = [await mint(a, { authTime: Math.floor(now) - 60 }), await mint(a, { authTime: Math.floor(now) - 90 })];
    const started = performance.now();
    ok(await revokeAll(a, {}), OP.revokeAll);
    const results = await Promise.all([...seen, ...unseen].map((t) => me(a, { as: t })));
    const elapsed = performance.now() - started;
    for (const r of results) revoked(r);
    expect(elapsed, `${Math.round(elapsed)} ms`).toBeLessThan(1000);
  });

  it('includeCurrent=true: the caller is signed out too and a re-login with the SAME sid stays refused, while a genuinely new login (later auth_time) works', async () => {
    const a = await newActor('wm-self');
    ok(await revokeAll(a, { includeCurrent: true }), OP.revokeAll);
    revoked(await me(a));
    const wm = (await watermarkOf(a.accountId))!;
    revoked(await me(a, { as: await mint(a, { sid: a.t0.sid, authTime: Math.ceil(wm) + 5 }) }));
    ok(await me(a, { as: await mint(a, { authTime: Math.ceil(wm) + 1 }) }));
  });

  it('a refused first sight does not poison the account: the user can still revoke-all from a working session and list sessions', async () => {
    const a = await newActor('wm-recover');
    const now = await dbEpoch();
    const unseen = await mint(a, { authTime: Math.floor(now) - 100 });
    ok(await revokeAll(a, {}), OP.revokeAll);
    revoked(await me(a, { as: unseen }));
    ok(await sessionsOf(a), OP.sessions);
    ok(await revokeAll(a, {}), OP.revokeAll);
  });

  it('strict body: includeCurrent must be a boolean, nothing else is accepted, and nothing is written for a refused body', async () => {
    const a = await newActor('all-strict');
    await login(a);
    const before = await writes();
    const bad: unknown[] = [
      { includeCurrent: 1 },
      { includeCurrent: 0 },
      { includeCurrent: 'true' },
      { includeCurrent: 'false' },
      { includeCurrent: null },
      { includeCurrent: [] },
      { includeCurrent: {} },
      { includeCurrent: true, extra: 1 },
      { accountId: randomUUID() },
      { subject: a.sub },
      { sid: a.t0.sid },
      { keycloakSessionId: a.t0.sid },
      { IncludeCurrent: true },
      [],
      [{ includeCurrent: true }],
      'true',
      42,
      true,
      null,
    ];
    for (const body of bad) {
      const r = await revokeAll(a, body);
      const e = fail(r, 400, 'VALIDATION_FAILED');
      expect(e.category).toBe('VALIDATION');
    }
    expect(fail(await call(a, 'POST', `${SEC}/sessions/revoke-all`, { rawBody: '{"includeCurrent": tru' }), 400, 'BAD_REQUEST').category).toBe('VALIDATION');
    expect(await writes()).toEqual(before);
    ok(await me(a));
  });

  it('a suspended account cannot sign out everywhere (403 first); once reactivated the sessions are still its own', async () => {
    const a = await newActor('all-suspended');
    const other = await login(a);
    await accounts.changeStatus(a.accountId, 'SUSPENDED', { actor: 'system:itest', reason: 'integration test' });
    fail(await revokeAll(a, {}), 403, 'ACCOUNT_SUSPENDED');
    expect((await sessionRowOf(other.sid))!.revoked_at).toBeNull();
    await accounts.changeStatus(a.accountId, 'ACTIVE', { actor: 'system:itest' });
    ok(await revokeAll(a, {}), OP.revokeAll);
  });
});

// ====================================================================== sign-out of the current session
describe('signing out of the current session', () => {
  it('revokes the session with reason SIGN_OUT, ends the Keycloak session, and the same token is refused next', async () => {
    const a = await newActor('so');
    const other = await login(a);
    const id = await sessionIdOf(a, a.t0);
    expect(ok(await signOut(a), OP.signOut)).toEqual({ changed: true, keycloak: 'ENDED' });
    expect(provider.endedSessions).toContain(a.t0.sid);
    revoked(await me(a));
    ok(await me(a, { as: other }));
    expect((await sessionRowOf(a.t0.sid))!.revocation_reason).toBe('SIGN_OUT');
    const audit = await auditOf(a.accountId, 'SESSION_REVOKED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ application_session_id: id, changes: { reason: 'SIGN_OUT' } });
    expect((await eventsOf(a.accountId, SECURITY_EVENTS.sessionRevoked)).map((e) => e.payload_json)).toEqual([
      { accountId: a.accountId, applicationSessionId: id, reason: 'SIGN_OUT' },
    ]);
  });

  it('repeating it is a 401 SESSION_REVOKED like any other request of a revoked session, and writes nothing', async () => {
    const a = await newActor('so-twice');
    ok(await signOut(a), OP.signOut);
    const before = await writes();
    revoked(await signOut(a));
    expect(await writes()).toEqual(before);
  });

  it('takes no body: none or {} is fine, anything else is a 400 and the session survives', async () => {
    const a = await newActor('so-body');
    for (const body of [{ x: 1 }, [], 'x', 1, null, { accountId: a.accountId }]) {
      fail(await call(a, 'POST', `${SEC}/sessions/current/sign-out`, { body }), 400, 'VALIDATION_FAILED');
    }
    ok(await me(a));
    expect(ok(await call(a, 'POST', `${SEC}/sessions/current/sign-out`, { body: {} }), OP.signOut).changed).toBe(true);
  });

  it('works when Keycloak cannot be reached: the application session is revoked all the same and the answer says UNAVAILABLE', async () => {
    const a = await newActor('so-down');
    provider.failNext('endSession');
    expect(ok(await signOut(a), OP.signOut)).toEqual({ changed: true, keycloak: 'UNAVAILABLE' });
    revoked(await me(a));
  });

  it('is available while the policy is unavailable (a sign-out needs no configuration)', async () => {
    const a = await newActor('so-policy');
    policyOverride = async () => {
      throw new Error('configuration down');
    };
    try {
      expect(ok(await signOut(a), OP.signOut).changed).toBe(true);
    } finally {
      policyOverride = null;
    }
  });
});

// ====================================================================== isolation between accounts
describe('isolation between accounts', () => {
  it("another account's sessions and devices are never listed, never revocable and never described", async () => {
    const a = await newActor('iso-a');
    const b = await newActor('iso-b');
    const bSecond = await login(b);
    const bDevice = await withDevice(b);
    const bSessions = (await sessionRows(b.accountId)).map((r) => r.application_session_id);
    const listA = ok(await sessionsOf(a), OP.sessions);
    expect(listA.sessions).toHaveLength(1);
    expect(JSON.stringify(listA)).not.toContain(bSessions[0]!);
    expect(ok(await devicesOf(a), OP.devices).devices).toEqual([]);
    for (const id of bSessions) fail(await revokeOne(a, id), 404, 'ACCOUNT_SESSION_NOT_FOUND');
    fail(await removeDevice(a, bDevice.deviceId), 404, 'ACCOUNT_DEVICE_NOT_FOUND');
    // B is untouched
    ok(await me(b));
    ok(await me(b, { as: bSecond }));
    expect(ok(await devicesOf(b), OP.devices).devices).toHaveLength(1);
    expect((await deviceRows(b.accountId))[0]!.removed_at).toBeNull();
    expect(await auditOf(b.accountId, 'SESSION_REVOKED')).toHaveLength(0);
    // and A's revoke-all never reaches B
    ok(await revokeAll(a, { includeCurrent: true }), OP.revokeAll);
    ok(await me(b));
    ok(await me(b, { as: bSecond }));
    expect(await watermarkOf(b.accountId)).toBeNull();
  });

  it('two accounts that present the same device secret have independent devices: different hashes, no shared trust, no shared removal', async () => {
    const a = await newActor('shared-a');
    const b = await newActor('shared-b');
    const secret = newSecret();
    const da = (await withDevice(a, { secret })).deviceId;
    const db = (await withDevice(b, { secret })).deviceId;
    expect(da).not.toBe(db);
    const [ra] = await deviceRows(a.accountId);
    const [rb] = await deviceRows(b.accountId);
    expect(ra!.device_hash).toBe(hashDeviceSecret(HASH_KEY, a.accountId, secret));
    expect(rb!.device_hash).toBe(hashDeviceSecret(HASH_KEY, b.accountId, secret));
    expect(ra!.device_hash).not.toBe(rb!.device_hash);
    expect(ra!.device_hash).toMatch(/^[0-9a-f]{64}$/);
    ok(await trustDevice(a), OP.trust);
    expect(ok(await devicesOf(b), OP.devices).devices[0].trusted).toBe(false);
    ok(await removeDevice(a, da), OP.removeDevice);
    expect(ok(await devicesOf(b), OP.devices).devices[0]).toMatchObject({ deviceId: db, trusted: false });
    ok(await me(b));
  });
});

// ====================================================================== admin context and account status
describe('context and account status gates', () => {
  const adminClaims = (sub: string) => ({
    sub,
    azp: 'bananagig-admin',
    resource_access: { 'bananagig-admin': { roles: ['admin-console-access', 'content-read', 'geography-read'] } },
    realm_access: { roles: [] },
  });

  it('the admin-context token is a 403 ACCOUNT_CONTEXT_NOT_SUPPORTED on every security route and leaves no account, session or device row', async () => {
    const before = await writes();
    const sub = `itest-admin-${randomUUID()}`;
    secrets.subjects.push(sub);
    const admin: Actor = { label: 'admin', sub, accountId: '', ip: nextIp(), t0: await mint({ sub }, { claims: adminClaims(sub) }) };
    const id = randomUUID();
    for (const [method, url, body] of [
      ['GET', SEC, undefined],
      ['GET', `${SEC}/sessions`, undefined],
      ['DELETE', `${SEC}/sessions/${id}`, undefined],
      ['POST', `${SEC}/sessions/revoke-all`, {}],
      ['POST', `${SEC}/sessions/current`, { device: newSecret() }],
      ['POST', `${SEC}/sessions/current/sign-out`, undefined],
      ['GET', `${SEC}/devices`, undefined],
      ['POST', `${SEC}/devices/current/trust`, undefined],
      ['DELETE', `${SEC}/devices/current/trust`, undefined],
      ['DELETE', `${SEC}/devices/${id}`, undefined],
      ['GET', `${SEC}/activity`, undefined],
      ['POST', `${SEC}/mfa/enrollment`, { method: 'TOTP' }],
    ] as const) {
      const e = fail(await call(admin, method, url, { body }), 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED');
      expect(e.category, url).toBe('AUTHORIZATION');
    }
    // the admin may call the public reset route, which does not know it
    ok(await resetPassword('someone@example.test', { as: admin.t0 }), OP.reset, 202);
    expect(await writes()).toEqual(before);
  });

  it('a SUSPENDED account is a 403 ACCOUNT_SUSPENDED first (before any session logic) on every route, for a known session, a revoked one and a brand-new sid; no row appears', async () => {
    const a = await newActor('suspended');
    const known2 = await login(a);
    ok(await revokeOne(a, await sessionIdOf(a, known2)), OP.revoke);
    await accounts.changeStatus(a.accountId, 'SUSPENDED', { actor: 'system:itest', reason: 'integration test' });
    const fresh = await mint(a);
    const before = await writes();
    const id = randomUUID();
    for (const t of [a.t0, known2, fresh]) {
      for (const [method, url, body] of [
        ['GET', '/account/me', undefined],
        ['GET', SEC, undefined],
        ['GET', `${SEC}/sessions`, undefined],
        ['DELETE', `${SEC}/sessions/${id}`, undefined],
        ['POST', `${SEC}/sessions/revoke-all`, {}],
        ['POST', `${SEC}/sessions/current`, { device: newSecret() }],
        ['POST', `${SEC}/sessions/current/sign-out`, undefined],
        ['GET', `${SEC}/devices`, undefined],
        ['POST', `${SEC}/devices/current/trust`, undefined],
        ['DELETE', `${SEC}/devices/current/trust`, undefined],
        ['DELETE', `${SEC}/devices/${id}`, undefined],
        ['GET', `${SEC}/activity`, undefined],
        ['POST', `${SEC}/mfa/enrollment`, { method: 'TOTP' }],
      ] as const) {
        const e = fail(await call(a, method, url, { as: t, body }), 403, 'ACCOUNT_SUSPENDED');
        expect(e.details).toEqual({ status: 'SUSPENDED' });
      }
    }
    expect(await writes()).toEqual(before);
    expect(await sessionRowOf(fresh.sid)).toBeUndefined();
    await accounts.changeStatus(a.accountId, 'ACTIVE', { actor: 'system:itest' });
    ok(await me(a));
    revoked(await me(a, { as: known2 })); // the revoked session is still revoked after reactivation
    ok(await me(a, { as: fresh }));
  });

  it('a CLOSED account is a 403 ACCOUNT_CLOSED on every route and gets no new session', async () => {
    const a = await newActor('closed');
    await accounts.changeStatus(a.accountId, 'SUSPENDED', { actor: 'system:itest' });
    await accounts.changeStatus(a.accountId, 'CLOSED', { actor: 'system:itest', reason: 'integration test' });
    const fresh = await mint(a);
    const before = await writes();
    for (const t of [a.t0, fresh]) {
      for (const [method, url, body] of [
        ['GET', '/account/me', undefined],
        ['GET', SEC, undefined],
        ['GET', `${SEC}/sessions`, undefined],
        ['POST', `${SEC}/sessions/revoke-all`, {}],
        ['POST', `${SEC}/sessions/current/sign-out`, undefined],
        ['POST', `${SEC}/devices/current/trust`, undefined],
        ['POST', `${SEC}/mfa/enrollment`, { method: 'RECOVERY_CODES' }],
        ['GET', `${SEC}/activity`, undefined],
      ] as const) {
        fail(await call(a, method, url, { as: t, body }), 403, 'ACCOUNT_CLOSED');
      }
    }
    expect(await writes()).toEqual(before);
    expect(await sessionRowOf(fresh.sid)).toBeUndefined();
  });
});

// ====================================================================== devices: registration
describe('registering the browser of a login (POST /account/security/sessions/current)', () => {
  it('stores only a keyed hash of the secret and three coarse families; returns the session, the device and the trust state', async () => {
    const a = await newActor('dev-reg');
    const marker = `bananagig-itest-ua-${randomUUID()}`;
    secrets.userAgents.push(marker);
    const secret = newSecret();
    const r = await registerDevice(a, secret, `${UA.chromeWindows} ${marker}`);
    const data = ok(r, OP.register);
    const rows = await deviceRows(a.accountId);
    expect(rows).toHaveLength(1);
    expect(data).toEqual({ sessionId: await sessionIdOf(a, a.t0), deviceId: rows[0]!.account_device_id, deviceTrusted: false, trustedUntil: null });
    expect(rows[0]).toMatchObject({
      browser_family: 'CHROME',
      os_family: 'WINDOWS',
      device_class: 'DESKTOP',
      trusted_at: null,
      trusted_until: null,
      removed_at: null,
      device_hash: hashDeviceSecret(HASH_KEY, a.accountId, secret),
    });
    expect((await sessionRowOf(a.t0.sid))!.account_device_id).toBe(rows[0]!.account_device_id);
    // the listing shows the coarse browser and nothing else
    const list = ok(await devicesOf(a), OP.devices).devices;
    expect(list).toEqual([
      {
        deviceId: rows[0]!.account_device_id,
        current: true,
        device: { browser: 'CHROME', os: 'WINDOWS', deviceClass: 'DESKTOP' },
        firstSeenAt: rows[0]!.first_seen_at.toISOString(),
        lastSeenAt: expect.any(String),
        trusted: false,
        trustedUntil: null,
      },
    ]);
    const s = ok(await sessionsOf(a), OP.sessions).sessions[0];
    expect(s).toMatchObject({ deviceId: rows[0]!.account_device_id, device: { browser: 'CHROME', os: 'WINDOWS', deviceClass: 'DESKTOP' } });
  });

  it('is idempotent: the same secret again changes nothing and answers the same device', async () => {
    const a = await newActor('dev-idem');
    const first = await withDevice(a);
    const before = await writes();
    const again = await registerDevice(a, first.secret, UA.firefoxLinux); // a different user agent does not rewrite the first families
    expect(ok(again, OP.register).deviceId).toBe(first.deviceId);
    const after = await writes();
    expect(after.devices).toBe(before.devices);
    expect(after.sessions).toBe(before.sessions);
    expect((await deviceRows(a.accountId))[0]).toMatchObject({ browser_family: 'CHROME', os_family: 'WINDOWS' });
  });

  it('the same browser (secret) on a second session of the account is the same device', async () => {
    const a = await newActor('dev-two-sessions');
    const first = await withDevice(a);
    const s2 = await login(a);
    const second = await withDevice(a, { as: s2, secret: first.secret });
    expect(second.deviceId).toBe(first.deviceId);
    expect(await deviceRows(a.accountId)).toHaveLength(1);
    const devices = ok(await devicesOf(a), OP.devices).devices;
    expect(devices).toHaveLength(1);
  });

  it('classifies the user agent into the closed vocabularies (and nothing else is kept)', async () => {
    const table: [string | undefined, [string, string, string]][] = [
      [UA.chromeWindows, ['CHROME', 'WINDOWS', 'DESKTOP']],
      [UA.firefoxLinux, ['FIREFOX', 'LINUX', 'DESKTOP']],
      [UA.safariMac, ['SAFARI', 'MACOS', 'DESKTOP']],
      [UA.safariIphone, ['SAFARI', 'IOS', 'MOBILE']],
      [UA.safariIpad, ['SAFARI', 'IOS', 'TABLET']],
      [UA.edgeWindows, ['EDGE', 'WINDOWS', 'DESKTOP']],
      [UA.operaLinux, ['OPERA', 'LINUX', 'DESKTOP']],
      [UA.chromeAndroidPhone, ['CHROME', 'ANDROID', 'MOBILE']],
      [UA.chromeAndroidTablet, ['CHROME', 'ANDROID', 'TABLET']],
      [UA.curl, ['OTHER', 'OTHER', 'OTHER']],
      ['', ['OTHER', 'OTHER', 'OTHER']],
      [undefined, ['OTHER', 'OTHER', 'OTHER']],
    ];
    for (const [ua, [browser, os, deviceClass]] of table) {
      const a = await newActor('dev-ua');
      const marker = `bananagig-itest-ua-${randomUUID()}`;
      secrets.userAgents.push(marker);
      const sent = ua === undefined ? undefined : ua === '' ? '' : `${ua} ${marker}`;
      ok(await registerDevice(a, newSecret(), sent), OP.register);
      expect((await devicesOf(a)).body.data.devices[0].device, ua).toEqual({ browser, os, deviceClass });
    }
  });

  it('a user agent of exactly 512 characters is accepted; 513 is a 400', async () => {
    const a = await newActor('dev-ua-len');
    ok(await registerDevice(a, newSecret(), 'a'.repeat(512)), OP.register);
    const b = await newActor('dev-ua-len2');
    fail(await registerDevice(b, newSecret(), 'a'.repeat(513)), 400, 'VALIDATION_FAILED');
    expect(await deviceRows(b.accountId)).toHaveLength(0);
  });

  it('strict body: a malformed secret, a wrong type, an unknown field, an array, a huge body are all 400 (or 413) and nothing is written', async () => {
    const a = await newActor('dev-strict');
    const good = newSecret();
    const before = await writes();
    const bodies: unknown[] = [
      {},
      { userAgent: UA.chromeWindows },
      { device: good.slice(0, 42) },
      { device: `${good}A` },
      { device: good.replace(/.$/, '=') },
      { device: good.replace(/^./, '+') },
      { device: good.replace(/^./, '/') },
      { device: good.replace(/^./, ' ') },
      { device: ` ${good}` },
      { device: `${good}\n` },
      { device: 12345 },
      { device: null },
      { device: true },
      { device: [good] },
      { device: { value: good } },
      { device: '' },
      { device: good, userAgent: 123 },
      { device: good, userAgent: null },
      { device: good, userAgent: ['x'] },
      { device: good, userAgent: {} },
      { device: good, extra: 1 },
      { device: good, accountId: a.accountId },
      { device: good, sid: a.t0.sid },
      { Device: good },
      [],
      [{ device: good }],
      [good],
      good,
      42,
      null,
      true,
    ];
    for (const body of bodies) {
      const r = await call(a, 'POST', `${SEC}/sessions/current`, { body });
      fail(r, 400, 'VALIDATION_FAILED');
      expect(r.raw, 'the rejected value is never echoed').not.toContain(good);
    }
    fail(await call(a, 'POST', `${SEC}/sessions/current`, { rawBody: '{"device": ' }), 400, 'BAD_REQUEST');
    fail(await call(a, 'POST', `${SEC}/sessions/current`), 400, 'VALIDATION_FAILED');
    const huge = await call(a, 'POST', `${SEC}/sessions/current`, { rawBody: JSON.stringify({ device: good, userAgent: 'u'.repeat(3 * 1024 * 1024) }) });
    expect([400, 413]).toContain(huge.status);
    expect(ErrorResponse.safeParse(huge.body).success).toBe(true);
    expect(await writes()).toEqual(before);
  });

  it('keeps the FIRST device of a session: presenting a different secret later answers the session own device', async () => {
    const a = await newActor('dev-first-wins');
    const first = await withDevice(a);
    const other = await registerDevice(a, newSecret(), UA.safariMac);
    expect(ok(other, OP.register).deviceId).toBe(first.deviceId);
    expect((await sessionRowOf(a.t0.sid))!.account_device_id).toBe(first.deviceId);
    expect(ok(await devicesOf(a), OP.devices).devices.find((d: Json) => d.current).deviceId).toBe(first.deviceId);
  });

  it('a revoked session cannot register a browser (401 SESSION_REVOKED) and no device appears', async () => {
    const a = await newActor('dev-revoked');
    const s2 = await login(a);
    ok(await revokeOne(a, await sessionIdOf(a, s2)), OP.revoke);
    const before = await writes();
    revoked(await registerDevice(a, newSecret(), UA.chromeWindows, { as: s2 }));
    expect(await writes()).toEqual(before);
  });
});

// ====================================================================== trusted browser
describe('the trusted browser (needs a recent authentication)', () => {
  it('without auth_time: 401 STEP_UP_REQUIRED with the exact RFC 9470 challenge and StepUpDetails; nothing is written', async () => {
    const a = await newActor('trust-noauth', { authTime: null });
    await withDevice(a);
    const before = await writes();
    stepUp(await trustDevice(a));
    expect(await writes()).toEqual(before);
  });

  it('with an old auth_time (beyond the 15 minute window) it is 401; just inside the window it is 200', async () => {
    const a = await newActor('trust-old');
    await withDevice(a);
    const old = await mint(a, { sid: a.t0.sid, authTime: appNow() - 905 });
    stepUp(await trustDevice(a, { as: old }));
    const inside = await mint(a, { sid: a.t0.sid, authTime: appNow() - 880 });
    expect(ok(await trustDevice(a, { as: inside }), OP.trust).trusted).toBe(true);
  });

  it('a malformed auth_time claim (string, negative, far in the future) is no authentication time at all', async () => {
    const a = await newActor('trust-weird');
    await withDevice(a);
    for (const claims of [{ auth_time: String(appNow()) }, { auth_time: -5 }, { auth_time: appNow() + 3600 }, { auth_time: null }, { auth_time: [appNow()] }]) {
      const t = await mint(a, { sid: a.t0.sid, authTime: null, claims });
      stepUp(await trustDevice(a, { as: t }));
    }
    // a few seconds ahead (clock skew between the identity provider and the API) is tolerated
    const skew = await mint(a, { sid: a.t0.sid, authTime: appNow() + 20 });
    ok(await trustDevice(a, { as: skew }), OP.trust);
  });

  it('a fresh login is enough (no second factor needed); the answer carries the window of session.trusted_browser_days', async () => {
    const a = await newActor('trust-ok', { acr: ACR_PASSWORD });
    const { deviceId } = await withDevice(a);
    const t0 = await dbEpoch();
    const data = ok(await trustDevice(a), OP.trust);
    expect(data).toMatchObject({ deviceId, trusted: true });
    const until = Date.parse(data.trustedUntil) / 1000;
    expect(until - t0).toBeGreaterThan(30 * 86400 - 60);
    expect(until - t0).toBeLessThan(30 * 86400 + 60);
    const row = (await deviceRows(a.accountId))[0]!;
    expect(row.trusted_until!.toISOString()).toBe(data.trustedUntil);
    expect(row.trusted_at).not.toBeNull();
    const audit = await auditOf(a.accountId, 'DEVICE_%');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'DEVICE_TRUSTED', account_device_id: deviceId, changes: { trustedBrowserDays: 30, renewed: false } });
  });

  it('the trust shows in the sessions, the devices and the overview', async () => {
    const a = await newActor('trust-visible');
    const { deviceId } = await withDevice(a);
    const until = ok(await trustDevice(a), OP.trust).trustedUntil;
    expect(ok(await sessionsOf(a), OP.sessions).sessions[0]).toMatchObject({ deviceId, trusted: true, trustedUntil: until });
    expect(ok(await devicesOf(a), OP.devices).devices[0]).toMatchObject({ deviceId, current: true, trusted: true, trustedUntil: until });
    expect(ok(await overview(a), OP.overview).currentSession).toEqual({
      sessionId: await sessionIdOf(a, a.t0),
      deviceId,
      deviceTrusted: true,
      trustedUntil: until,
    });
    expect(ok(await registerDevice(a, (await deviceRows(a.accountId)).length ? newSecret() : '', UA.chromeWindows), OP.register).deviceTrusted).toBe(true);
  });

  it('renewing an already trusted browser extends the window and says so in the audit row', async () => {
    const a = await newActor('trust-renew');
    await withDevice(a);
    const first = ok(await trustDevice(a), OP.trust).trustedUntil;
    await new Promise((r) => setTimeout(r, 20));
    const second = ok(await trustDevice(a), OP.trust).trustedUntil;
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
    const audit = await auditOf(a.accountId, 'DEVICE_TRUSTED');
    expect(audit.map((r) => r.changes.renewed)).toEqual([false, true]);
  });

  it('expires by the clock: once trusted_until is in the past the browser is untrusted everywhere and can be trusted again (renewed=false)', async () => {
    const a = await newActor('trust-expire');
    const { deviceId } = await withDevice(a);
    ok(await trustDevice(a), OP.trust);
    await expireTrust(deviceId);
    expect(ok(await sessionsOf(a), OP.sessions).sessions[0]).toMatchObject({ trusted: false, trustedUntil: null });
    expect(ok(await devicesOf(a), OP.devices).devices[0]).toMatchObject({ trusted: false, trustedUntil: null });
    expect(ok(await overview(a), OP.overview).currentSession).toMatchObject({ deviceTrusted: false, trustedUntil: null });
    expect(ok(await registerDevice(a, newSecret()), OP.register)).toMatchObject({ deviceId, deviceTrusted: false, trustedUntil: null });
    ok(await trustDevice(a), OP.trust);
    expect((await auditOf(a.accountId, 'DEVICE_TRUSTED')).map((r) => r.changes.renewed)).toEqual([false, false]);
  });

  it('a trusted browser NEVER satisfies a step-up: an old auth_time is still refused on trust and enrollment', async () => {
    const a = await newActor('trust-nostepup');
    await withDevice(a);
    ok(await trustDevice(a), OP.trust);
    const stale = await mint(a, { sid: a.t0.sid, authTime: appNow() - 4000 });
    stepUp(await trustDevice(a, { as: stale }));
    stepUp(await enroll(a, 'TOTP', { as: stale }));
  });

  it('no registered browser: 409 ACCOUNT_DEVICE_REQUIRED (after the step-up check), for trust and untrust', async () => {
    const a = await newActor('trust-nodevice');
    const e = fail(await trustDevice(a), 409, 'ACCOUNT_DEVICE_REQUIRED');
    expect(e.category).toBe('CONFLICT');
    expect(e.details).toEqual({ messageKey: 'account.security.error.device_required' });
    fail(await untrustDevice(a), 409, 'ACCOUNT_DEVICE_REQUIRED');
    const stale = await mint(a, { sid: a.t0.sid, authTime: appNow() - 4000 });
    stepUp(await trustDevice(a, { as: stale })); // 401 first, not 409
  });

  it('takes no body: {} or none is fine, anything else is 400 (after authentication and the step-up check)', async () => {
    const a = await newActor('trust-body');
    await withDevice(a);
    const stale = await mint(a, { sid: a.t0.sid, authTime: appNow() - 4000 });
    stepUp(await call(a, 'POST', `${SEC}/devices/current/trust`, { as: stale, body: { x: 1 } })); // 401 before 400
    for (const body of [{ x: 1 }, [], 'x', 5, null, { accountId: a.accountId }])
      fail(await call(a, 'POST', `${SEC}/devices/current/trust`, { body }), 400, 'VALIDATION_FAILED');
    expect((await deviceRows(a.accountId))[0]!.trusted_until).toBeNull();
    ok(await call(a, 'POST', `${SEC}/devices/current/trust`, { body: {} }), OP.trust);
  });

  it('untrust: stops trusting without a step-up, audits once, and repeating it is a no-op that records nothing', async () => {
    const a = await newActor('untrust');
    const { deviceId } = await withDevice(a);
    ok(await trustDevice(a), OP.trust);
    const stale = await mint(a, { sid: a.t0.sid, authTime: null });
    expect(ok(await untrustDevice(a, { as: stale }), OP.untrust)).toEqual({ deviceId, trusted: false, trustedUntil: null });
    expect(ok(await untrustDevice(a), OP.untrust)).toEqual({ deviceId, trusted: false, trustedUntil: null });
    expect(await actionsOf(a.accountId, 'DEVICE_%')).toEqual(['DEVICE_TRUSTED', 'DEVICE_UNTRUSTED']);
    expect((await deviceRows(a.accountId))[0]).toMatchObject({ trusted_at: null, trusted_until: null });
    expect(ok(await devicesOf(a), OP.devices).devices[0].trusted).toBe(false);
  });

  it('is unavailable (503, nothing written) when the configuration cannot be read', async () => {
    const a = await newActor('trust-policy');
    await withDevice(a);
    const before = await writes();
    policyOverride = async () => {
      throw new Error('configuration down');
    };
    try {
      const r = await trustDevice(a);
      fail(r, 503, 'ACCOUNT_UNAVAILABLE');
      expect(r.raw).not.toContain('configuration down');
    } finally {
      policyOverride = null;
    }
    expect(await writes()).toEqual(before);
  });

  it('an out-of-range configuration value is refused, not defaulted (the policy fails closed)', async () => {
    const a = await newActor('trust-badpolicy');
    await withDevice(a);
    policyOverride = async () => ({ ...SEEDED_SECURITY_POLICY, trustedBrowserDays: 0 });
    try {
      fail(await trustDevice(a), 503, 'ACCOUNT_UNAVAILABLE');
    } finally {
      policyOverride = null;
    }
  });

  it('follows a configuration change at once: a shorter trusted_browser_days gives a shorter window on the next trust', async () => {
    const a = await newActor('trust-days');
    await withDevice(a);
    policyOverride = async () => ({ ...SEEDED_SECURITY_POLICY, trustedBrowserDays: 2 });
    try {
      const t0 = await dbEpoch();
      const data = ok(await trustDevice(a), OP.trust);
      const seconds = Date.parse(data.trustedUntil) / 1000 - t0;
      expect(seconds).toBeGreaterThan(2 * 86400 - 60);
      expect(seconds).toBeLessThan(2 * 86400 + 60);
      expect(ok(await overview(a), OP.overview).policy.trustedBrowserDays).toBe(2);
    } finally {
      policyOverride = null;
    }
  });
});

// ====================================================================== removing a browser
describe('removing a browser', () => {
  it('untrusts it, marks it removed, revokes ITS sessions only (reason DEVICE_REMOVED), and the other browser keeps working', async () => {
    const a = await newActor('rm-dev');
    const d1 = await withDevice(a);
    const s2 = await login(a);
    await withDevice(a, { as: s2, secret: d1.secret }); // second session of the same browser
    const s3 = await login(a);
    const d2 = await withDevice(a, { as: s3, ua: UA.firefoxLinux });
    ok(await trustDevice(a), OP.trust);
    const r = await removeDevice(a, d2.deviceId, { as: a.t0 });
    expect(ok(r, OP.removeDevice)).toEqual({ deviceId: d2.deviceId, changed: true, sessionsRevoked: 1, keycloak: 'ENDED' });
    revoked(await me(a, { as: s3 }));
    ok(await me(a));
    ok(await me(a, { as: s2 }));
    expect(ok(await devicesOf(a), OP.devices).devices.map((d: Json) => d.deviceId)).toEqual([d1.deviceId]);
    expect((await deviceRows(a.accountId)).find((d) => d.account_device_id === d2.deviceId)).toMatchObject({ trusted_until: null });
    expect((await deviceRows(a.accountId)).find((d) => d.account_device_id === d2.deviceId)!.removed_at).not.toBeNull();
    const audit = await auditOf(a.accountId, '%');
    expect(audit.filter((r) => r.action === 'DEVICE_REMOVED')).toHaveLength(1);
    expect(audit.filter((r) => r.action === 'SESSION_REVOKED' && r.changes.reason === 'DEVICE_REMOVED')).toHaveLength(1);
    expect(provider.endedSessions).toContain(s3.sid);
    // d1 and its trust are untouched
    expect((await deviceRows(a.accountId)).find((d) => d.account_device_id === d1.deviceId)!.trusted_until).not.toBeNull();
  });

  it('removing the current browser revokes every session on it, the caller included; repeating is idempotent', async () => {
    const a = await newActor('rm-self');
    const d1 = await withDevice(a);
    const s2 = await login(a);
    await withDevice(a, { as: s2, secret: d1.secret });
    const keep = await login(a);
    expect(ok(await removeDevice(a, d1.deviceId, { as: keep }), OP.removeDevice)).toEqual({
      deviceId: d1.deviceId,
      changed: true,
      sessionsRevoked: 2,
      keycloak: 'ENDED',
    });
    revoked(await me(a));
    revoked(await me(a, { as: s2 }));
    ok(await me(a, { as: keep }));
    const again = ok(await removeDevice(a, d1.deviceId, { as: keep }), OP.removeDevice);
    expect(again).toMatchObject({ deviceId: d1.deviceId, changed: false, sessionsRevoked: 0 });
    expect(await actionsOf(a.accountId, 'DEVICE_REMOVED')).toHaveLength(1);
  });

  it('a removed browser is terminal: the same cookie registers no device again (deviceId null), so it cannot be trusted', async () => {
    const a = await newActor('rm-terminal');
    const d1 = await withDevice(a);
    const keep = await login(a);
    ok(await removeDevice(a, d1.deviceId, { as: keep }), OP.removeDevice);
    const fresh = await login(a);
    const r = ok(await registerDevice(a, d1.secret, UA.chromeWindows, { as: fresh }), OP.register);
    expect(r).toMatchObject({ deviceId: null, deviceTrusted: false, trustedUntil: null });
    fail(await trustDevice(a, { as: fresh }), 409, 'ACCOUNT_DEVICE_REQUIRED');
    expect(ok(await devicesOf(a, { as: fresh }), OP.devices).devices).toEqual([]);
  });

  it('a device id that is malformed is 400, unknown or foreign is 404, and neither writes anything', async () => {
    const a = await newActor('rm-ids');
    const b = await newActor('rm-ids-b');
    const db = await withDevice(b);
    const before = await writes();
    for (const bad of ['x', '1', `${randomUUID()}0`, '..%2f..']) fail(await removeDevice(a, bad), 400, 'VALIDATION_FAILED');
    const unknown = fail(await removeDevice(a, randomUUID()), 404, 'ACCOUNT_DEVICE_NOT_FOUND');
    const foreign = fail(await removeDevice(a, db.deviceId), 404, 'ACCOUNT_DEVICE_NOT_FOUND');
    expect(unknown.message).toBe(foreign.message);
    expect(unknown.details).toEqual({ messageKey: 'account.security.error.device_not_found' });
    expect(await writes()).toEqual(before);
  });

  it('works when Keycloak is down: the sessions are revoked all the same (keycloak UNAVAILABLE)', async () => {
    const a = await newActor('rm-down');
    const d = await withDevice(a);
    const keep = await login(a);
    provider.failNext('endSession');
    const r = ok(await removeDevice(a, d.deviceId, { as: keep }), OP.removeDevice);
    expect(r).toMatchObject({ changed: true, sessionsRevoked: 1, keycloak: 'UNAVAILABLE' });
    revoked(await me(a));
  });
});

// ====================================================================== MFA enrollment
describe('POST /account/security/mfa/enrollment', () => {
  it('needs a recent authentication (401 STEP_UP_REQUIRED) before the body is even looked at', async () => {
    const a = await newActor('mfa-step', { authTime: appNow() - 5000 });
    const before = await writes();
    stepUp(await enroll(a, 'TOTP'));
    stepUp(await enroll(a, 'nonsense'));
    stepUp(await call(a, 'POST', `${SEC}/mfa/enrollment`, { body: { method: 'TOTP', extra: 1 } }));
    expect(await writes()).toEqual(before);
    const none = await newActor('mfa-step2', { authTime: null });
    stepUp(await enroll(none, 'TOTP'));
  });

  it('returns only the method and the Keycloak action name (no secret), and audits the request', async () => {
    const a = await newActor('mfa-ok');
    const totp = await enroll(a, 'TOTP');
    expect(ok(totp, OP.mfa)).toEqual({ method: 'TOTP', keycloakAction: 'CONFIGURE_TOTP' });
    expect(Object.keys(totp.body.data).sort()).toEqual(['keycloakAction', 'method']);
    expect(ok(await enroll(a, 'RECOVERY_CODES'), OP.mfa)).toEqual({ method: 'RECOVERY_CODES', keycloakAction: 'CONFIGURE_RECOVERY_AUTHN_CODES' });
    const audit = await auditOf(a.accountId, '%REQUESTED');
    expect(audit.map((r) => [r.action, r.changes])).toEqual([
      ['MFA_ENROLLMENT_REQUESTED', { method: 'TOTP' }],
      ['RECOVERY_CODES_REQUESTED', { method: 'RECOVERY_CODES' }],
    ]);
    // starting enrollment does not touch Keycloak
    expect(provider.calls.filter((c) => c.subject === a.sub)).toEqual([]);
  });

  it('validates the method strictly: wrong case, unknown value, wrong type, missing, extra fields, non-objects are 400 and write nothing', async () => {
    const a = await newActor('mfa-strict');
    const before = await writes();
    for (const method of ['totp', 'Totp', 'SMS', 'EMAIL', 'TOTP ', ' TOTP', '', 'recovery_codes', 1, true, null, ['TOTP'], { m: 1 }]) {
      fail(await enroll(a, method), 400, 'VALIDATION_FAILED');
    }
    for (const body of [{}, { method: 'TOTP', extra: 1 }, { method: 'TOTP', accountId: a.accountId }, [], [{ method: 'TOTP' }], 'TOTP', 5, null]) {
      fail(await call(a, 'POST', `${SEC}/mfa/enrollment`, { body }), 400, 'VALIDATION_FAILED');
    }
    fail(await call(a, 'POST', `${SEC}/mfa/enrollment`), 400, 'VALIDATION_FAILED');
    expect(await writes()).toEqual(before);
  });
});

// ====================================================================== the step-up guards on a harness route
describe('requireRecentAuthentication / requireMfa / requireStepUp on a harness app over the real services', () => {
  let harness: FastifyInstance;
  beforeAll(async () => {
    harness = Fastify({ logger: false });
    await harness.register(correlationPlugin);
    await harness.register(errorPlugin);
    await harness.register(authPlugin, { verifier: verifierFor(), realm: REALM });
    await harness.register(accountPlugin, { accounts, security });
    for (const [path, guard] of [
      ['/recent', requireRecentAuthentication()],
      ['/mfa', requireMfa()],
      ['/step-recent', requireStepUp('RECENT_AUTHENTICATION')],
      ['/step-mfa', requireStepUp('MFA')],
    ] as const)
      harness.get(path, { preValidation: [requireAccount(), guard] }, async () => ({ passed: true }));
    await harness.ready();
    extraApps.push(harness);
  });
  const hit = async (path: string, t: Tok): Promise<Res> => {
    const r = await harness.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${t.token}` } });
    const res: Res = {
      method: 'GET',
      url: path,
      status: r.statusCode,
      body: JSON.parse(r.body),
      headers: r.headers,
      raw: r.body,
      cid: String(r.headers[CORRELATION_HEADER]),
    };
    return res;
  };

  it('requireMfa passes a recent authentication that included a second factor', async () => {
    const a = await newActor('g-pass');
    const t = await mint(a, { acr: ACR_MFA, authTime: appNow() - 30 });
    expect((await hit('/mfa', t)).status).toBe(200);
    expect((await hit('/step-mfa', t)).status).toBe(200);
  });

  it('requireMfa with an MFA login that is no longer recent asks for a fresh MFA authentication (acr_values in the challenge)', async () => {
    const a = await newActor('g-old');
    provider.setUser(a.sub, { otpConfigured: true });
    const t = await mint(a, { acr: ACR_MFA, authTime: appNow() - 1200 });
    stepUp(await hit('/mfa', t), 'MFA');
  });

  it('requireMfa with a password-only login and a TOTP enrolled asks for MFA; with none enrolled it is 403 MFA_ENROLLMENT_REQUIRED (no loop); recovery codes alone do not count', async () => {
    const enrolled = await newActor('g-enrolled');
    provider.setUser(enrolled.sub, { otpConfigured: true });
    stepUp(await hit('/mfa', await mint(enrolled, { acr: ACR_PASSWORD })), 'MFA');
    stepUp(await hit('/step-mfa', await mint(enrolled, { acr: ACR_PASSWORD })), 'MFA');

    const none = await newActor('g-none');
    for (const path of ['/mfa', '/step-mfa']) {
      const r = await hit(path, await mint(none, { acr: ACR_PASSWORD }));
      const e = fail(r, 403, 'MFA_ENROLLMENT_REQUIRED');
      expect(e.category).toBe('AUTHORIZATION');
      expect(e.details).toEqual({ messageKey: 'account.security.error.mfa_enrollment_required' });
      expect(r.headers['www-authenticate']).toBeUndefined();
    }
    const recoveryOnly = await newActor('g-rec');
    provider.setUser(recoveryOnly.sub, { recoveryCodesConfigured: true });
    fail(await hit('/mfa', await mint(recoveryOnly, { acr: ACR_PASSWORD })), 403, 'MFA_ENROLLMENT_REQUIRED');
  });

  it('requireMfa fails CLOSED when the identity provider cannot be asked: 503, never a pass and never a step-up loop', async () => {
    const a = await newActor('g-down');
    provider.failNext('getUserSecurity');
    fail(await hit('/mfa', await mint(a, { acr: ACR_PASSWORD })), 503, 'ACCOUNT_SECURITY_UNAVAILABLE');
    provider.available = false;
    try {
      const e = fail(await hit('/mfa', await mint(a, { acr: ACR_PASSWORD })), 503, 'ACCOUNT_SECURITY_UNAVAILABLE');
      expect(e.details).toEqual({ retryable: true, messageKey: 'account.security.error.security_unavailable' });
      expect((await hit('/mfa', await mint(a, { acr: ACR_MFA, authTime: appNow() - 5 }))).status, 'a recent MFA login needs no provider').toBe(200);
    } finally {
      provider.available = true;
    }
  });

  it('the guards follow a configuration change: a longer window lets an older authentication pass, an unreadable policy is 503', async () => {
    const a = await newActor('g-window');
    const t = await mint(a, { authTime: appNow() - 1200 });
    stepUp(await hit('/recent', t));
    policyOverride = async () => ({ ...SEEDED_SECURITY_POLICY, stepUpValidMinutes: 30 });
    try {
      expect((await hit('/recent', t)).status).toBe(200);
      stepUp(await hit('/recent', await mint(a, { authTime: appNow() - 2000 })), 'RECENT_AUTHENTICATION', 1800);
    } finally {
      policyOverride = null;
    }
    policyOverride = async () => {
      throw new Error('down');
    };
    try {
      fail(await hit('/recent', t), 503, 'ACCOUNT_UNAVAILABLE');
    } finally {
      policyOverride = null;
    }
  });

  it('a revoked session or a suspended account is refused by requireAccount BEFORE the step-up guard speaks', async () => {
    const a = await newActor('g-order');
    const s2 = await login(a, { authTime: appNow() - 5000 });
    ok(await revokeOne(a, await sessionIdOf(a, s2)), OP.revoke);
    revoked(await hit('/recent', s2));
    revoked(await hit('/mfa', s2));
    await accounts.changeStatus(a.accountId, 'SUSPENDED', { actor: 'system:itest' });
    fail(await hit('/recent', await mint(a, { authTime: appNow() - 5000 })), 403, 'ACCOUNT_SUSPENDED');
    await accounts.changeStatus(a.accountId, 'ACTIVE', { actor: 'system:itest' });
  });
});

// ====================================================================== overview, observed transitions, step-up state
describe('GET /account/security: the second-factor state, the step-up state and the policy', () => {
  it('reports the provider state, the seeded policy and the current session', async () => {
    const a = await newActor('ov-basic');
    const o = ok(await overview(a), OP.overview);
    expect(o.mfa).toEqual({ available: true, totpConfigured: false, recoveryCodesConfigured: false });
    expect(o.policy).toEqual({ trustedBrowserDays: 30, stepUpValidMinutes: 15, activityLogDays: 90 });
    expect(o.currentSession).toEqual({ sessionId: await sessionIdOf(a, a.t0), deviceId: null, deviceTrusted: false, trustedUntil: null });
    expect(await mfaActions(a.accountId)).toEqual([]);
    expect(await recoveryActions(a.accountId)).toEqual([]);
    expect(await actionsOf(a.accountId, 'PASSWORD%')).toEqual([]);
  });

  it('shows TOTP and recovery codes as set up by Keycloak and audits each transition ONCE, even under parallel reads', async () => {
    const a = await newActor('ov-mfa');
    // the person asked to enrol both factors (an enrolment request is what turns "configured" into a transition rather than a baseline)
    ok(await enroll(a, 'TOTP'), OP.mfa);
    ok(await enroll(a, 'RECOVERY_CODES'), OP.mfa);
    provider.setUser(a.sub, { otpConfigured: true });
    const reads = await Promise.all(Array.from({ length: 6 }, () => overview(a)));
    for (const r of reads) expect(ok(r, OP.overview).mfa).toEqual({ available: true, totpConfigured: true, recoveryCodesConfigured: false });
    expect(await mfaActions(a.accountId)).toEqual(['MFA_ENABLED']);
    expect((await auditOf(a.accountId, 'MFA_ENABLED'))[0]!.changes).toEqual({ method: 'TOTP' });
    expect((await eventsOf(a.accountId, SECURITY_EVENTS.mfaEnabled)).map((e) => e.payload_json)).toEqual([{ accountId: a.accountId, method: 'TOTP' }]);

    provider.setUser(a.sub, { recoveryCodesConfigured: true });
    await Promise.all(Array.from({ length: 4 }, () => overview(a)));
    expect(await recoveryActions(a.accountId)).toEqual(['RECOVERY_CODES_ENABLED']);

    provider.setUser(a.sub, { otpConfigured: false });
    expect(ok(await overview(a), OP.overview).mfa).toEqual({ available: true, totpConfigured: false, recoveryCodesConfigured: true });
    await overview(a);
    provider.setUser(a.sub, { otpConfigured: true, recoveryCodesConfigured: false });
    await overview(a);
    expect(await mfaActions(a.accountId)).toEqual(['MFA_ENABLED', 'MFA_DISABLED', 'MFA_ENABLED']);
    expect(await recoveryActions(a.accountId)).toEqual(['RECOVERY_CODES_ENABLED', 'RECOVERY_CODES_DISABLED']);
    expect((await eventsOf(a.accountId, SECURITY_EVENTS.mfaDisabled)).map((e) => e.payload_json.method).sort()).toEqual(['RECOVERY_CODES', 'TOTP']);
  });

  it('a factor that is ALREADY configured the first time it is seen (no enrolment request) is a silent baseline: audited with baseline=true, no event, not on the timeline; removing it later is a real transition', async () => {
    const a = await newActor('ov-baseline');
    provider.setUser(a.sub, { otpConfigured: true, recoveryCodesConfigured: true });
    await Promise.all([overview(a), overview(a), overview(a)]);
    const audit = await auditOf(a.accountId, '%ENABLED');
    expect(audit.map((r) => [r.action, r.changes])).toEqual([
      ['MFA_ENABLED', { method: 'TOTP', baseline: true }],
      ['RECOVERY_CODES_ENABLED', { method: 'RECOVERY_CODES', baseline: true }],
    ]);
    expect(await eventsOf(a.accountId, 'bananagig.identity.mfa-%')).toEqual([]);
    expect((await activity(a, '?limit=100')).body.data.entries.map((e: Json) => e.type)).toEqual(['SESSION_CREATED']);
    provider.setUser(a.sub, { otpConfigured: false });
    await overview(a);
    expect(await mfaActions(a.accountId)).toEqual(['MFA_ENABLED', 'MFA_DISABLED']);
    expect((await eventsOf(a.accountId, SECURITY_EVENTS.mfaDisabled)).map((e) => e.payload_json)).toEqual([{ accountId: a.accountId, method: 'TOTP' }]);
  });

  it('when the identity provider cannot answer, `available` is false, the flags are false, nothing is audited, and the rest of the overview still works', async () => {
    const a = await newActor('ov-down');
    ok(await enroll(a, 'TOTP'), OP.mfa);
    provider.setUser(a.sub, { otpConfigured: true });
    await overview(a);
    expect(await mfaActions(a.accountId)).toEqual(['MFA_ENABLED']);
    provider.setUser(a.sub, { otpConfigured: false });

    provider.failNext('getUserSecurity');
    const failing = ok(await overview(a), OP.overview);
    expect(failing.mfa).toEqual({ available: false, totpConfigured: false, recoveryCodesConfigured: false });
    expect(failing.policy.stepUpValidMinutes).toBe(15);
    provider.available = false;
    try {
      expect(ok(await overview(a), OP.overview).mfa.available).toBe(false);
    } finally {
      provider.available = true;
    }
    expect(await mfaActions(a.accountId), 'an outage is never read as "the factor was removed"').toEqual(['MFA_ENABLED']);
    expect(ok(await overview(a), OP.overview).mfa.available).toBe(true);
    expect(await mfaActions(a.accountId)).toEqual(['MFA_ENABLED', 'MFA_DISABLED']);

    const unavailable = await makeApp({ provider: createUnavailableSecurityIdentityProvider() });
    expect(ok(await overview(a, { app: unavailable.app }), OP.overview).mfa.available).toBe(false);
  });

  it('shows the step-up state of the verified token: authenticatedAt, mfaSatisfied and until when it counts as recent', async () => {
    const a = await newActor('ov-stepup');
    const at = appNow() - 120;
    const t = await mint(a, { sid: a.t0.sid, authTime: at });
    expect(ok(await overview(a, { as: t }), OP.overview).stepUp).toEqual({
      authenticatedAt: new Date(at * 1000).toISOString(),
      mfaSatisfied: false,
      recentUntil: new Date((at + 900) * 1000).toISOString(),
    });
    const mfa = await mint(a, { sid: a.t0.sid, authTime: at, acr: ACR_MFA });
    expect(ok(await overview(a, { as: mfa }), OP.overview).stepUp.mfaSatisfied).toBe(true);
    const old = await mint(a, { sid: a.t0.sid, authTime: appNow() - 5000 });
    expect(ok(await overview(a, { as: old }), OP.overview).stepUp).toEqual({
      authenticatedAt: new Date((old.authTime as number) * 1000).toISOString(),
      mfaSatisfied: false,
      recentUntil: null,
    });
    const none = await mint(a, { sid: a.t0.sid, authTime: null });
    expect(ok(await overview(a, { as: none }), OP.overview).stepUp).toEqual({ authenticatedAt: null, mfaSatisfied: false, recentUntil: null });
    // an acr that only looks like the MFA level is not the MFA level
    for (const acr of ['bananagig:MFA', 'bananagig:mfa ', 'mfa', ACR_PASSWORD]) {
      const t2 = await mint(a, { sid: a.t0.sid, acr });
      expect(ok(await overview(a, { as: t2 }), OP.overview).stepUp.mfaSatisfied, acr).toBe(false);
    }
  });

  it('observes a password change once (PASSWORD_CHANGED) and attributes a change after a reset request to the reset (PASSWORD_RESET_COMPLETED)', async () => {
    const a = await newActor('ov-pw');
    const base = await dbEpoch();
    provider.setUser(a.sub, { passwordChangedAt: new Date((base + 1) * 1000) });
    await overview(a);
    await overview(a);
    expect(await actionsOf(a.accountId, 'PASSWORD%')).toEqual(['PASSWORD_CHANGED']);
    provider.setUser(a.sub, { passwordChangedAt: new Date((base + 1) * 1000) }); // the same value again: nothing new
    await overview(a);
    expect(await actionsOf(a.accountId, 'PASSWORD%')).toEqual(['PASSWORD_CHANGED']);

    const address = await verifyEmail(a);
    provider.setUser(a.sub, { email: address });
    ok(await resetPassword(address, { ip: nextIp() }), OP.reset, 202);
    await security.drain();
    expect(await actionsOf(a.accountId, 'PASSWORD_RESET_REQUESTED')).toHaveLength(1);
    provider.setUser(a.sub, { passwordChangedAt: new Date((await dbEpoch()) * 1000 + 1500) });
    await overview(a);
    await overview(a);
    expect(await actionsOf(a.accountId, 'PASSWORD%')).toEqual(['PASSWORD_CHANGED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED']);
    expect((await eventsOf(a.accountId, SECURITY_EVENTS.passwordResetCompleted)).map((e) => e.payload_json)).toEqual([{ accountId: a.accountId }]);
    // a later change with no reset request after the completed one is a plain change
    provider.setUser(a.sub, { passwordChangedAt: new Date((await dbEpoch()) * 1000 + 3000) });
    await overview(a);
    expect((await actionsOf(a.accountId, 'PASSWORD%')).slice(-1)).toEqual(['PASSWORD_CHANGED']);
  });

  it('an observed password change signs out the OTHER older sessions (reason PASSWORD_CHANGED) and keeps the current one', async () => {
    const a = await newActor('ov-pw-sessions');
    const older = await login(a, { authTime: appNow() - 600 });
    provider.setUser(a.sub, { passwordChangedAt: new Date((await dbEpoch()) * 1000 + 1000) });
    await overview(a);
    revoked(await me(a, { as: older }));
    ok(await me(a));
    expect((await sessionRowOf(older.sid))!.revocation_reason).toBe('PASSWORD_CHANGED');
  });

  it('a revoked session has no overview (401 SESSION_REVOKED); the overview accepts no query', async () => {
    const a = await newActor('ov-revoked');
    const s2 = await login(a);
    ok(await revokeOne(a, await sessionIdOf(a, s2)), OP.revoke);
    revoked(await overview(a, { as: s2 }));
    for (const q2 of ['?accountId=' + a.accountId, '?x=1', '?sid=' + a.t0.sid, '?limit=1']) fail(await call(a, 'GET', `${SEC}${q2}`), 400, 'VALIDATION_FAILED');
  });
});

// ====================================================================== the activity timeline
describe('GET /account/security/activity', () => {
  const entries = (r: Res): Json[] => ok(r, OP.activity).entries;

  it('lists security events and contact events newest first, with the managed label key, and nothing else', async () => {
    const a = await newActor('act');
    const dev = await withDevice(a);
    ok(await trustDevice(a), OP.trust);
    const s2 = await login(a);
    ok(await revokeOne(a, await sessionIdOf(a, s2)), OP.revoke);
    ok(await enroll(a, 'TOTP'), OP.mfa);
    await verifyEmail(a);
    await verifyPhone(a);
    ok(await untrustDevice(a), OP.untrust);
    ok(await revokeAll(a, {}), OP.revokeAll);

    const list = entries(await activity(a, '?limit=100'));
    const types = list.map((e) => e.type);
    expect(types.length).toBeGreaterThanOrEqual(9);
    for (const e of list) {
      expect(SECURITY_ACTIVITY_TYPES as readonly string[]).toContain(e.type);
      expect(e.labelContentKey).toBe(securityActivityLabelKey(e.type));
      expect(e.outcome).toBe('SUCCESS');
      expect(Object.keys(e).sort()).toEqual(['device', 'id', 'labelContentKey', 'occurredAt', 'outcome', 'sessionId', 'type']);
    }
    for (let i = 1; i < list.length; i++) expect(list[i - 1].occurredAt >= list[i].occurredAt).toBe(true);
    expect(types).toEqual(
      expect.arrayContaining(['SESSION_CREATED', 'SESSION_REVOKED', 'SESSIONS_REVOKED_ALL', 'DEVICE_TRUSTED', 'DEVICE_UNTRUSTED', 'MFA_ENROLLMENT_REQUESTED']),
    );
    expect(types, 'contact events are shown next to the security ones').toEqual(expect.arrayContaining(['EMAIL_VERIFIED', 'PHONE_VERIFIED']));
    expect(types).not.toContain('ACCOUNT_CREATED');
    expect(types).not.toContain('EXTERNAL_IDENTITY_LINKED');
    // it is a read model of the audit table: same rows, same order
    const inTimeline = (await auditOf(a.accountId)).filter((r) => (SECURITY_ACTIVITY_TYPES as readonly string[]).includes(r.action));
    expect(list.map((e) => e.type)).toEqual(inTimeline.map((r) => r.action).reverse());
    // session events carry the application session id and the coarse browser of that session; device events carry neither session nor secret
    const created = list.find(
      (e) => e.type === 'SESSION_CREATED' && e.sessionId === inTimeline.find((r) => r.action === 'SESSION_CREATED')!.application_session_id,
    )!;
    expect(created.device).toEqual({ browser: 'CHROME', os: 'WINDOWS', deviceClass: 'DESKTOP' });
    expect(list.find((e) => e.type === 'DEVICE_TRUSTED')!.sessionId).toBeNull();
    expect(list.find((e) => e.type === 'EMAIL_VERIFIED')!.sessionId).toBeNull();
    expect(JSON.stringify(list)).not.toContain(dev.deviceId);
  });

  it('pages backwards through the HTTP cursor: every event exactly once, in order, whatever the page size', async () => {
    const a = await newActor('act-page');
    for (let i = 0; i < 12; i++) await login(a);
    ok(await revokeAll(a, {}), OP.revokeAll);
    const all = entries(await activity(a, '?limit=100'));
    expect(all.length).toBeGreaterThanOrEqual(26);
    for (const size of [1, 2, 3, 5, 7, 25]) {
      const seen: string[] = [];
      let before: string | null = null;
      let pages = 0;
      do {
        const r = await activity(a, `?limit=${size}${before ? `&before=${encodeURIComponent(before)}` : ''}`);
        const data = ok(r, OP.activity);
        expect(data.entries.length).toBeLessThanOrEqual(size);
        seen.push(...data.entries.map((e: Json) => e.id));
        before = data.nextBefore;
        if (before !== null) {
          expect(data.entries).toHaveLength(size);
          expect(before).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        }
        pages += 1;
      } while (before !== null && pages < 200);
      const missing = all.map((e) => e.id).filter((id) => !seen.includes(id));
      const diag =
        missing.length === 0
          ? ''
          : JSON.stringify(
              await q(
                `SELECT audit_event_id, action, to_char(occurred_at AT TIME ZONE 'UTC', 'HH24:MI:SS.US') AS t FROM identity.account_audit_events WHERE account_id = $1 AND occurred_at BETWEEN (SELECT occurred_at FROM identity.account_audit_events WHERE audit_event_id = $2) - interval '2 milliseconds' AND (SELECT occurred_at FROM identity.account_audit_events WHERE audit_event_id = $2) + interval '2 milliseconds' ORDER BY occurred_at`,
                [a.accountId, missing[0]],
              ),
            );
      expect(seen, `page size ${size} ${diag}`).toEqual(all.map((e) => e.id));
    }
  });

  /** An account whose timeline holds `ties` events at ONE instant (an hour ago) plus its session-created event. */
  async function tiedTimeline(label: string, ties = 4) {
    const a = await newActor(label);
    const at = (await q<{ t: string }>(`SELECT to_char((clock_timestamp() - interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`))[0]!
      .t;
    for (let i = 0; i < ties; i++)
      await q(
        `INSERT INTO identity.account_audit_events (occurred_at, actor, action, account_id, changes, correlation_id) VALUES ($2::timestamptz, 'system:itest', 'PASSWORD_CHANGED', $1, '{}'::jsonb, 'itest-tie')`,
        [a.accountId, at],
      );
    const all = entries(await activity(a, '?limit=100')).map((e) => e.id);
    expect(all.length).toBe(ties + 1);
    return { a, at, all };
  }

  it('paging never skips or repeats events that share the same instant, for every page size (the cursor carries the event id as a tiebreaker)', async () => {
    const { a, all } = await tiedTimeline('act-tie', 5);
    for (const size of [1, 2, 3, 4, 5, 6, 100]) {
      const seen: string[] = [];
      let before: string | null = null;
      for (let pages = 0; pages < 20; pages++) {
        const d = ok(await activity(a, `?limit=${size}${before ? `&before=${encodeURIComponent(before)}` : ''}`), OP.activity);
        seen.push(...d.entries.map((e: Json) => e.id));
        before = d.nextBefore;
        if (before === null) break;
      }
      expect(seen, `page size ${size}`).toEqual(all);
    }
    // the order among ties is the descending event id
    const ties = (await activity(a, '?limit=100')).body.data.entries.filter((e: Json) => e.type === 'PASSWORD_CHANGED').map((e: Json) => e.id);
    expect(ties).toEqual([...ties].sort().reverse());
  });

  it('the composite cursor round-trips through HTTP exactly as returned (instant, underscore, lower-case event id of the last entry), in any letter case', async () => {
    const { a, all } = await tiedTimeline('act-cursor', 4);
    const first = ok(await activity(a, '?limit=3'), OP.activity);
    expect(first.nextBefore).toBe(`${(await activity(a, '?limit=3')).body.data.nextBefore}`);
    const [instant, id] = (first.nextBefore as string).split('_');
    expect(id).toBe(first.entries[2].id);
    expect(instant).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const rest = ok(await activity(a, `?limit=100&before=${encodeURIComponent(first.nextBefore)}`), OP.activity);
    expect([...first.entries, ...rest.entries].map((e: Json) => e.id)).toEqual(all);
    // the event id of the cursor is case-insensitive
    const upper = ok(await activity(a, `?limit=100&before=${encodeURIComponent(`${instant}_${id!.toUpperCase()}`)}`), OP.activity);
    expect(upper.entries.map((e: Json) => e.id)).toEqual(rest.entries.map((e: Json) => e.id));
    // a cursor naming another account's event id still only ever filters this account's own events
    const b = await newActor('act-cursor-b');
    const foreign = ok(await activity(b, `?limit=100&before=${encodeURIComponent(first.nextBefore)}`), OP.activity);
    expect(foreign.entries).toEqual([]);
  });

  it('a plain instant `before` still works and means strictly older than that instant: events AT the instant are excluded', async () => {
    const { a, at, all } = await tiedTimeline('act-plain', 3);
    expect(all).toHaveLength(4);
    const atInstant = ok(await activity(a, `?limit=100&before=${encodeURIComponent(at)}`), OP.activity);
    expect(atInstant.entries).toEqual([]);
    const justAfter = ok(await activity(a, `?limit=100&before=${encodeURIComponent('2999-01-01T00:00:00Z')}`), OP.activity);
    expect(justAfter.entries.map((e: Json) => e.id)).toEqual(all);
    // one microsecond after the tie: all of the tied events are older
    const after = (
      await q<{ t: string }>(`SELECT to_char(($1::timestamptz + interval '1 microsecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`, [at])
    )[0]!.t;
    expect(ok(await activity(a, `?limit=100&before=${encodeURIComponent(after)}`), OP.activity).entries.map((e: Json) => e.id)).toEqual(all.slice(1));
  });

  it('malformed composite cursors are 400 and read nothing: bad instant, bad or missing id, extra parts, wrong separators, over-long', async () => {
    const a = await newActor('act-badcursor');
    const id = randomUUID();
    const t = '2030-01-01T00:00:00.123456Z';
    const before = await writes();
    for (const v of [
      `${t}_`,
      `${t}_${id.slice(1)}`,
      `${t}_${id}0`,
      `${t}_${id.replace(/-/g, '')}`,
      `${t}_${'g'.repeat(8)}${id.slice(8)}`,
      `${t}_not-a-uuid`,
      `${t}_${id}_${id}`,
      `${t}__${id}`,
      `${t}-${id}`,
      `${t} ${id}`,
      `${t}|${id}`,
      `${t}:${id}`,
      `_${id}`,
      `yesterday_${id}`,
      `2030-02-30T00:00:00Z_${id}`,
      `2030-01-01_${id}`,
      `2030-01-01T00:00:00_${id}`,
      `${id}_${t}`,
      `${t}_${id}${'0'.repeat(40)}`,
      `${t}_${id}';DROP TABLE x;--`,
      `${t}_${id}\u0000`,
    ]) {
      const e = fail(await activity(a, `?before=${encodeURIComponent(v)}`), 400, 'VALIDATION_FAILED');
      expect(e.category, v).toBe('VALIDATION');
    }
    fail(await activity(a, `?before=${encodeURIComponent(`${t}_${id}`)}&before=${encodeURIComponent(`${t}_${id}`)}`), 400, 'VALIDATION_FAILED');
    expect(await writes()).toEqual(before);
    // the well-formed one is accepted
    ok(await activity(a, `?before=${encodeURIComponent(`${t}_${id}`)}`), OP.activity);
  });

  it('defaults to 25 entries, accepts 1..100, and the end of the list has nextBefore null', async () => {
    const a = await newActor('act-limit');
    await Promise.all(Array.from({ length: 30 }, () => login(a)));
    const d = ok(await activity(a), OP.activity);
    expect(d.entries).toHaveLength(25);
    expect(d.nextBefore).not.toBeNull();
    expect(ok(await activity(a, '?limit=1'), OP.activity).entries).toHaveLength(1);
    expect(ok(await activity(a, '?limit=100'), OP.activity).nextBefore).toBeNull();
    const total = ok(await activity(a, '?limit=100'), OP.activity).entries.length;
    expect(ok(await activity(a, `?limit=${total}`), OP.activity).nextBefore, 'exactly one full page').toBeNull();
    expect(ok(await activity(a, `?limit=${total - 1}`), OP.activity).nextBefore).not.toBeNull();
  });

  it('refuses every non-canonical `limit` (coercion variants) and unknown query keys with a 400, and never reads the database for them', async () => {
    const a = await newActor('act-strict');
    const before = await writes();
    const bad = [
      '0',
      '101',
      '-1',
      '1e1',
      '1E1',
      '010',
      '+5',
      '%205',
      '5%20',
      '0x5',
      '0b1',
      '1.0',
      '5.',
      '.5',
      'five',
      '',
      'NaN',
      'Infinity',
      '٥',
      '５',
      '1_0',
      '1,0',
      '9007199254740993',
      '2147483648',
    ];
    for (const v of bad) {
      const r = await activity(a, `?limit=${v}`);
      const e = fail(r, 400, 'VALIDATION_FAILED');
      expect(e.category, v).toBe('VALIDATION');
    }
    fail(await activity(a, '?limit=1&limit=2'), 400, 'VALIDATION_FAILED');
    fail(await activity(a, '?limit[]=1'), 400, 'VALIDATION_FAILED');
    for (const q2 of [
      `?accountId=${a.accountId}`,
      '?subject=x',
      `?sid=${a.t0.sid}`,
      '?offset=1',
      '?page=2',
      '?Limit=5',
      '?limit=5&x=1',
      '?before=2030-01-01T00:00:00Z&x=1',
    ]) {
      fail(await activity(a, q2), 400, 'VALIDATION_FAILED');
    }
    expect(await writes()).toEqual(before);
    // the bounds themselves are fine
    ok(await activity(a, '?limit=1'), OP.activity);
    ok(await activity(a, '?limit=100'), OP.activity);
  });

  it('`before` is a real ISO instant with an offset: other shapes are 400; offsets and fractions are accepted', async () => {
    const a = await newActor('act-before');
    for (const v of [
      '',
      'yesterday',
      '2030-01-01',
      '2030-01-01T00:00:00',
      '2030-13-01T00:00:00Z',
      '2030-02-30T00:00:00Z',
      '2030-01-01T24:00:00Z',
      '2030-01-01T00:60:00Z',
      '2030-01-01T00:00:60Z',
      '2030-01-01 00:00:00Z',
      '2030-01-01T00:00:00z',
      '1700000000',
      '2030-01-01T00:00:00.1234567Z',
      `2030-01-01T00:00:00Z${'0'.repeat(30)}`,
      '2030-01-01T00:00:00Z;DROP',
      "'2030-01-01T00:00:00Z'",
    ]) {
      fail(await activity(a, `?before=${encodeURIComponent(v)}`), 400, 'VALIDATION_FAILED');
    }
    fail(await activity(a, '?before=2030-01-01T00:00:00Z&before=2031-01-01T00:00:00Z'), 400, 'VALIDATION_FAILED');
    for (const v of ['2030-01-01T00:00:00Z', '2030-01-01T00:00:00.5Z', '2030-01-01T05:30:00+05:30', '2030-01-01T00:00:00.123456-08:00']) {
      const d = ok(await activity(a, `?before=${encodeURIComponent(v)}`), OP.activity);
      expect(d.entries.length, v).toBeGreaterThan(0); // a future instant: everything is older
    }
    expect(ok(await activity(a, `?before=${encodeURIComponent('2001-01-01T00:00:00Z')}`), OP.activity).entries).toEqual([]);
  });

  it('shows only the last security.activity_log_days: older rows are not part of the timeline', async () => {
    const a = await newActor('act-window');
    const mk = (days: number) =>
      q(
        `INSERT INTO identity.account_audit_events (occurred_at, actor, action, account_id, changes, correlation_id)
         VALUES (clock_timestamp() - make_interval(days => $2), 'system:itest', 'PASSWORD_CHANGED', $1, '{}'::jsonb, 'itest-window')`,
        [a.accountId, days],
      );
    await mk(100);
    await mk(10);
    const list = entries(await activity(a, '?limit=100'));
    expect(list.filter((e) => e.type === 'PASSWORD_CHANGED')).toHaveLength(1);
    policyOverride = async () => ({ ...SEEDED_SECURITY_POLICY, activityLogDays: 365 });
    try {
      expect(entries(await activity(a, '?limit=100')).filter((e) => e.type === 'PASSWORD_CHANGED')).toHaveLength(2);
    } finally {
      policyOverride = null;
    }
  });

  it("never shows another account's events", async () => {
    const a = await newActor('act-iso-a');
    const b = await newActor('act-iso-b');
    await login(b);
    const bIds = new Set((await sessionRows(b.accountId)).map((r) => r.application_session_id));
    const list = entries(await activity(a, '?limit=100'));
    expect(list.every((e) => e.sessionId === null || !bIds.has(e.sessionId))).toBe(true);
    expect(list.filter((e) => e.type === 'SESSION_CREATED')).toHaveLength(1);
  });

  it('a revoked session reads no timeline', async () => {
    const a = await newActor('act-revoked');
    const s2 = await login(a);
    ok(await revokeOne(a, await sessionIdOf(a, s2)), OP.revoke);
    revoked(await activity(a, '', { as: s2 }));
  });
});

// ====================================================================== public password reset
describe('POST /auth/password-reset (public)', () => {
  const FIXED_CID = 'fixed-correlation-id-0001';
  const uniq = (label: string): string => {
    const e = `${label}-${randomUUID()}@example.test`;
    secrets.emails.push(e);
    return e;
  };
  /** An account with a VERIFIED primary email whose address Keycloak knows too. */
  async function accountWithEmail(label: string, o: { keycloakEmail?: string | null } = {}) {
    const a = await newActor(label);
    const address = await verifyEmail(a, uniq(label));
    provider.setUser(a.sub, { email: o.keycloakEmail === undefined ? address : o.keycloakEmail });
    return { a, address };
  }
  const sent = (sub: string) => provider.sentResetEmails.filter((m) => m.subject === sub);
  const request = (email: unknown, o: CallOptions = {}) => resetPassword(email, { cid: FIXED_CID, ip: nextIp(), ...o });

  it('answers the SAME 202 and body for an existing account, an unknown address, invalid input, another letter case and padding, with a fixed correlation id', async () => {
    const { a, address } = await accountWithEmail('pr-same');
    const suspended = await accountWithEmail('pr-same-susp');
    await accounts.changeStatus(suspended.a.accountId, 'SUSPENDED', { actor: 'system:itest' });
    const inputs: unknown[] = [
      address,
      uniq('unknown'),
      address.toUpperCase(),
      ` ${address} `,
      `\t${address}\n`,
      suspended.address,
      'not-an-email',
      '',
      '   ',
      'a@b',
      `${'x'.repeat(64)}@${'y'.repeat(250)}.test`,
      'x'.repeat(320),
      `${address}\u0000`,
      '<script>alert(1)</script>@example.test',
      "'; DROP TABLE identity.accounts; --@example.test",
    ];
    const answers: Res[] = [];
    for (const email of inputs) answers.push(await request(email));
    const first = answers[0]!;
    expect(ok(first, OP.reset, 202)).toEqual({ accepted: true });
    expect(first.body).toEqual({ data: { accepted: true }, meta: { correlationId: FIXED_CID } });
    for (const [i, r] of answers.entries()) {
      expect(r.status, String(i)).toBe(202);
      expect(r.raw, `input ${i}`).toBe(first.raw);
      for (const h of ['content-type', 'cache-control', 'content-length', CORRELATION_HEADER])
        expect(r.headers[h], `${h} of input ${i}`).toBe(first.headers[h]);
      expect(r.headers['www-authenticate']).toBeUndefined();
    }
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers[CORRELATION_HEADER]).toBe(FIXED_CID);
    await security.drain();
    expect(a.accountId).toBeTruthy();
  });

  it('records PASSWORD_RESET_REQUESTED (audit + event) and asks Keycloak ONCE per request, with lifespan = reset_link.validity_minutes * 60, only for a verified address that Keycloak also has', async () => {
    const { a, address } = await accountWithEmail('pr-send');
    provider.sentResetEmails.length = 0;
    ok(await request(address), OP.reset, 202);
    await security.drain();
    expect(sent(a.sub)).toEqual([{ subject: a.sub, lifespanSeconds: 3600 }]);
    expect(await actionsOf(a.accountId, 'PASSWORD_RESET_REQUESTED')).toHaveLength(1);
    expect((await eventsOf(a.accountId, SECURITY_EVENTS.passwordResetRequested)).map((e) => e.payload_json)).toEqual([{ accountId: a.accountId }]);

    // other letter case and padding resolve to the same account
    ok(await request(address.toUpperCase()), OP.reset, 202);
    ok(await request(`  ${address}  `), OP.reset, 202);
    await security.drain();
    expect(sent(a.sub)).toHaveLength(3);

    // the lifespan follows the configuration
    policyOverride = async () => ({ ...SEEDED_SECURITY_POLICY, resetLinkValidityMinutes: 7 });
    try {
      ok(await request(address), OP.reset, 202);
      await security.drain();
    } finally {
      policyOverride = null;
    }
    expect(sent(a.sub).map((m) => m.lifespanSeconds)).toEqual([3600, 3600, 3600, 420]);
  });

  it('sends nothing when the address is unknown, not verified, not primary, the account is closed, or Keycloak knows a different (or no) address', async () => {
    const mismatch = await accountWithEmail('pr-mismatch', { keycloakEmail: uniq('other') });
    const noEmail = await accountWithEmail('pr-noemail', { keycloakEmail: null });
    const pending = await newActor('pr-pending');
    const pendingAddress = uniq('pending');
    ok(await call(pending, 'POST', '/account/email', { body: { email: pendingAddress } }));
    provider.setUser(pending.sub, { email: pendingAddress });
    const closed = await accountWithEmail('pr-closed');
    await accounts.changeStatus(closed.a.accountId, 'SUSPENDED', { actor: 'system:itest' });
    await accounts.changeStatus(closed.a.accountId, 'CLOSED', { actor: 'system:itest' });
    const unknown = uniq('nobody');
    provider.sentResetEmails.length = 0;
    for (const email of [mismatch.address, noEmail.address, pendingAddress, closed.address, unknown]) ok(await request(email), OP.reset, 202);
    await security.drain();
    expect(provider.sentResetEmails).toEqual([]);
    // Keycloak was not even asked about an account that is not eligible
    expect(await actionsOf(pending.accountId, 'PASSWORD_RESET_REQUESTED')).toEqual([]);
    expect(await actionsOf(closed.a.accountId, 'PASSWORD_RESET_REQUESTED')).toEqual([]);
    // a verified address with a Keycloak mismatch is recorded as a request (the person asked) but nothing is sent
    expect(await actionsOf(mismatch.a.accountId, 'PASSWORD_RESET_REQUESTED')).toHaveLength(1);
    // a suspended account with a verified address can still be asked for (it only mails the owner)
    const susp = await accountWithEmail('pr-susp');
    await accounts.changeStatus(susp.a.accountId, 'SUSPENDED', { actor: 'system:itest' });
    ok(await request(susp.address), OP.reset, 202);
    await security.drain();
    expect(sent(susp.a.sub)).toHaveLength(1);
  });

  it('the Keycloak call is DETACHED: the response arrives while the provider is still held, never differs, and a provider failure is invisible to the caller', async () => {
    const { a, address } = await accountWithEmail('pr-detached');
    provider.sentResetEmails.length = 0;
    const release = provider.hold('getUserSecurity');
    const started = performance.now();
    const held = await request(address);
    const heldMs = performance.now() - started;
    expect(ok(held, OP.reset, 202)).toEqual({ accepted: true });
    expect(sent(a.sub)).toEqual([]);
    release();
    await security.drain();
    expect(sent(a.sub)).toHaveLength(1);
    expect(heldMs, 'the answer did not wait for the identity provider').toBeLessThan(2000);

    for (const method of ['getUserSecurity', 'sendPasswordResetEmail'] as const) {
      provider.failNext(method);
      const failing = await request(address);
      expect(failing.status).toBe(202);
      expect(failing.body.data).toEqual({ accepted: true });
      await security.drain();
    }
    const down = await makeApp({ provider: createUnavailableSecurityIdentityProvider() });
    const r = await request(address, { app: down.app });
    expect(r.status).toBe(202);
    await down.security.drain();
  });

  it('ignores Authorization completely: a valid token, a revoked session, garbage and a malformed header all get the same answer and no account is looked up from the token', async () => {
    const { address } = await accountWithEmail('pr-auth');
    const other = await newActor('pr-auth-other');
    const s2 = await login(other);
    ok(await revokeOne(other, await sessionIdOf(other, s2)), OP.revoke);
    const baseline = await request(address, { as: null });
    for (const as of [other.t0, s2, 'garbage'] as const) {
      const r = await request(address, { as });
      expect(r.status).toBe(202);
      expect(r.raw).toBe(baseline.raw);
    }
    const header = await request(address, { as: null, headers: { authorization: 'Basic Zm9vOmJhcg==' } });
    expect(header.raw).toBe(baseline.raw);
    await security.drain();
    // the other account (token owner) got no audit row
    expect(await actionsOf(other.accountId, 'PASSWORD_RESET_REQUESTED')).toEqual([]);
  });

  it('no session is created, touched or required; the route needs no sid', async () => {
    const before = await writes();
    ok(await request(uniq('nothing'), { as: null }), OP.reset, 202);
    await security.drain();
    const after = await writes();
    expect(after.sessions).toBe(before.sessions);
    expect(after.devices).toBe(before.devices);
    expect(after.audit).toBe(before.audit);
  });

  it('is limited PER ADDRESS: the 6th request for the same address (any letter case, any source) is 429 with Retry-After; refused requests use up nothing else', async () => {
    const address = uniq('rl-email');
    const ips = Array.from({ length: 8 }, () => nextIp());
    for (let i = 0; i < 5; i++) ok(await request(i % 2 ? address.toUpperCase() : address, { ip: ips[i] }), OP.reset, 202);
    const refused = await request(address, { ip: ips[5] });
    const e = fail(refused, 429, 'ACCOUNT_PASSWORD_RESET_RATE_LIMITED');
    expect(e.category).toBe('RATE_LIMIT');
    const wait = Number(refused.headers['retry-after']);
    expect(Number.isInteger(wait)).toBe(true);
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(3600);
    expect(e.details).toEqual({ retryAfterSeconds: wait, messageKey: 'account.security.error.password_reset_rate_limited' });
    expect(refused.headers['cache-control']).toBe('no-store');
    expect(refused.raw).not.toContain(address);
    // the source that was refused has not been charged: it can still ask for another address
    ok(await request(uniq('rl-fresh'), { ip: ips[5] }), OP.reset, 202);
    fail(await request(address, { ip: ips[6] }), 429, 'ACCOUNT_PASSWORD_RESET_RATE_LIMITED');
  });

  it('the limit is identical for an existing and an unknown address (the limiter reveals nothing), and for invalid input it is counted on what was sent', async () => {
    const { address } = await accountWithEmail('rl-known');
    const unknown = uniq('rl-unknown');
    const garbage = `garbage-${randomUUID()}`;
    const out: Record<string, Res> = {};
    for (const [name, email] of [
      ['known', address],
      ['unknown', unknown],
      ['garbage', garbage],
    ] as const) {
      for (let i = 0; i < 5; i++) ok(await request(email), OP.reset, 202);
      out[name] = await request(email);
    }
    for (const r of Object.values(out)) fail(r, 429, 'ACCOUNT_PASSWORD_RESET_RATE_LIMITED');
    expect(shape(out.known!.body.error.details)).toEqual(shape(out.unknown!.body.error.details));
    expect(out.known!.body.error.message).toBe(out.unknown!.body.error.message);
    expect(out.known!.body.error.code).toBe(out.garbage!.body.error.code);
    await security.drain();
  });

  it('is limited PER SOURCE address: the 6th request from one address is 429 whatever the emails are', async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) ok(await request(uniq('rl-ip'), { ip }), OP.reset, 202);
    const refused = await request(uniq('rl-ip'), { ip });
    fail(refused, 429, 'ACCOUNT_PASSWORD_RESET_RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    ok(await request(uniq('rl-ip'), { ip: nextIp() }), OP.reset, 202); // another source is not affected
  });

  it('follows reset_link.max_requests_per_hour from the configuration', async () => {
    policyOverride = async () => ({ ...SEEDED_SECURITY_POLICY, resetMaxRequestsPerHour: 2 });
    try {
      const address = uniq('rl-cfg');
      ok(await request(address), OP.reset, 202);
      ok(await request(address), OP.reset, 202);
      fail(await request(address), 429, 'ACCOUNT_PASSWORD_RESET_RATE_LIMITED');
    } finally {
      policyOverride = null;
    }
  });

  it('keys the limits by keyed hashes: no raw address, no raw IP, and no input text reaches the limiter', async () => {
    const address = uniq('rl-keys').toUpperCase();
    const ip = nextIp();
    const mark = limiter.log.length;
    ok(await request(address, { ip }), OP.reset, 202);
    const rules = limiter.log.slice(mark).flat();
    expect(rules.map((r) => r.name).sort()).toEqual(['password-reset:email', 'password-reset:ip']);
    expect(rules.find((r) => r.name === 'password-reset:email')!.key).toBe(hashDimension(HASH_KEY, 'email', address.toLowerCase()));
    expect(rules.find((r) => r.name === 'password-reset:ip')!.key).toBe(hashDimension(HASH_KEY, 'ip', ip));
    expect(JSON.stringify(rules)).not.toContain(ip);
    expect(JSON.stringify(rules).toLowerCase()).not.toContain('rl-keys');
    expect(rules.every((r) => r.limit === 5 && r.windowSeconds === 3600)).toBe(true);
  });

  it('FAILS CLOSED when the limiter is down: 503, no audit row, no provider call; it works again once the limiter is back', async () => {
    const { a, address } = await accountWithEmail('pr-down');
    provider.sentResetEmails.length = 0;
    const before = await writes();
    limiter.inner.unavailable = true;
    try {
      for (const email of [address, uniq('x'), 'not-an-email']) {
        const r = await request(email);
        const e = fail(r, 503, 'ACCOUNT_UNAVAILABLE');
        expect(e.category).toBe('DEPENDENCY');
        expect(r.headers['cache-control']).toBe('no-store');
      }
      await security.drain();
    } finally {
      limiter.inner.unavailable = false;
    }
    expect(await writes()).toEqual(before);
    expect(provider.sentResetEmails).toEqual([]);
    ok(await request(address), OP.reset, 202);
    await security.drain();
    expect(sent(a.sub)).toHaveLength(1);
  });

  it('is a 503 (not an error leak) when the configuration cannot be read', async () => {
    policyOverride = async () => {
      throw new Error('configuration down: secret detail');
    };
    try {
      const r = await request(uniq('cfg'));
      fail(r, 503, 'ACCOUNT_UNAVAILABLE');
      expect(r.raw).not.toContain('secret detail');
    } finally {
      policyOverride = null;
    }
  });

  it('strict body: an unknown field, a non-string email, a missing email, a non-object, an over-long email or a too-large body is refused (400/413) before anything is consumed', async () => {
    const marks = limiter.log.length;
    const before = await writes();
    const address = uniq('strict');
    const bodies: unknown[] = [
      { email: address, extra: 1 },
      { email: address, accountId: randomUUID() },
      { email: address, subject: 'x' },
      { email: 123 },
      { email: null },
      { email: true },
      { email: [address] },
      { email: { value: address } },
      { Email: address },
      {},
      [],
      [{ email: address }],
      address,
      42,
      null,
      { email: 'x'.repeat(321) },
    ];
    for (const body of bodies) {
      const r = await call(undefined, 'POST', '/auth/password-reset', { body, cid: FIXED_CID, ip: nextIp() });
      fail(r, 400, 'VALIDATION_FAILED');
      expect(r.raw).not.toContain(address);
    }
    fail(await call(undefined, 'POST', '/auth/password-reset', { cid: FIXED_CID }), 400, 'VALIDATION_FAILED');
    fail(await call(undefined, 'POST', '/auth/password-reset', { rawBody: '{"email": ', cid: FIXED_CID }), 400, 'BAD_REQUEST');
    const big = await call(undefined, 'POST', '/auth/password-reset', { body: { email: 'a'.repeat(5000) }, cid: FIXED_CID });
    expect([400, 413]).toContain(big.status);
    expect(ErrorResponse.safeParse(big.body).success).toBe(true);
    expect(limiter.log.length).toBe(marks);
    expect(await writes()).toEqual(before);
    // 320 characters is the limit and is a normal 202
    ok(await request('y'.repeat(320)), OP.reset, 202);
  });

  it('only POST exists: GET and PUT are not a way in', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH'] as const) {
      const r = await call(undefined, method, '/auth/password-reset', { body: method === 'GET' ? undefined : { email: 'a@example.test' } });
      expect(r.status, method).toBe(404);
    }
  });
});

// ====================================================================== the device dimension of the email and phone limits (DEBT-0054, partial)
describe('the session device feeds the email and phone request limits', () => {
  it('after the browser registered, the email limiter sees a device rule keyed by a hash of the application device id, never the id', async () => {
    const withBrowser = await newActor('dd-email');
    const { deviceId } = await withDevice(withBrowser);
    const mark = limiter.log.length;
    const address = `dd-${randomUUID()}@example.test`;
    secrets.emails.push(address);
    ok(await call(withBrowser, 'POST', '/account/email', { body: { email: address } }));
    ok(await call(withBrowser, 'POST', '/account/email/verification/send', { body: {} }));
    const rules = limiter.log.slice(mark).flat();
    const device = rules.filter((r) => r.name === 'email-verification:device');
    expect(device.length).toBeGreaterThanOrEqual(1);
    for (const r of device) expect(r.key).toBe(hashDimension(HASH_KEY, 'device', deviceId));
    expect(JSON.stringify(rules)).not.toContain(deviceId);
    expect(rules.filter((r) => r.name === 'email-verification:account').every((r) => r.key === withBrowser.accountId)).toBe(true);
    expect(rules.filter((r) => r.name === 'email-verification:ip').every((r) => r.key === hashDimension(HASH_KEY, 'ip', withBrowser.ip))).toBe(true);
  });

  it('the same for the phone limiter', async () => {
    const a = await newActor('dd-phone');
    const { deviceId } = await withDevice(a);
    const mark = limiter.log.length;
    ok(await call(a, 'POST', '/account/phone', { body: { phone: newPhone() } }));
    ok(await call(a, 'POST', '/account/phone/verification/send', { body: {} }));
    const rules = limiter.log
      .slice(mark)
      .flat()
      .filter((r) => r.name === 'phone-verification:device');
    expect(rules.length).toBeGreaterThanOrEqual(1);
    for (const r of rules) expect(r.key).toBe(hashDimension(HASH_KEY, 'device', deviceId));
  });

  it('a session whose browser is not registered (yet) contributes no device rule, and another session of the same account uses ITS device', async () => {
    const a = await newActor('dd-none');
    const mark = limiter.log.length;
    const address = `dd-${randomUUID()}@example.test`;
    secrets.emails.push(address);
    ok(await call(a, 'POST', '/account/email', { body: { email: address } }));
    ok(await call(a, 'POST', '/account/email/verification/send', { body: {} }));
    expect(
      limiter.log
        .slice(mark)
        .flat()
        .filter((r) => r.name.endsWith(':device')),
    ).toEqual([]);

    const s2 = await login(a);
    const d2 = await withDevice(a, { as: s2 });
    const mark2 = limiter.log.length;
    const address2 = `dd-${randomUUID()}@example.test`;
    secrets.emails.push(address2);
    ok(await call(a, 'POST', '/account/email', { as: s2, body: { email: address2 } }));
    const rules = limiter.log
      .slice(mark2)
      .flat()
      .filter((r) => r.name === 'email-verification:device');
    expect(rules.length).toBeGreaterThanOrEqual(1);
    for (const r of rules) expect(r.key).toBe(hashDimension(HASH_KEY, 'device', d2.deviceId));
  });
});

// ====================================================================== expiry, reconciliation and propagation to the identity provider
describe('session expiry, reconciliation with Keycloak and best-effort propagation', () => {
  /** Ages a session row (the guard triggers forbid it, so the test superuser bypasses them for this one statement). */
  const age = async (sid: string, days: number): Promise<void> => {
    await iso.database.transaction(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx);
      await sql`UPDATE identity.application_sessions SET created_at = created_at - make_interval(days => ${days}), last_seen_at = last_seen_at - make_interval(days => ${days}) WHERE keycloak_session_id = ${sid}`.execute(
        trx,
      );
    });
  };

  it('a session younger than the grace period is never ended just because the provider does not list it yet', async () => {
    const a = await newActor('rec-young');
    const young = await login(a, { inProvider: false });
    const d = ok(await sessionsOf(a), OP.sessions);
    expect(d.reconciled).toBe(true);
    expect(d.sessions).toHaveLength(2);
    ok(await me(a, { as: young }));
  });

  it('a non-current session the provider no longer lists is ended (KEYCLOAK_ENDED, SESSION_ENDED, event) and refused at once; the current session is never ended', async () => {
    const g0 = await makeApp({ graceSeconds: 0 });
    const a = await newActor('rec-gone', { inProvider: false }); // the CURRENT session is not in the provider list either
    const gone = await login(a, { inProvider: false });
    const alive = await login(a);
    const d = ok(await sessionsOf(a, { app: g0.app }), OP.sessions);
    expect(d.reconciled).toBe(true);
    const ids = d.sessions.map((s: Json) => s.sessionId);
    expect(ids).toEqual([await sessionIdOf(a, a.t0), await sessionIdOf(a, alive)]);
    revoked(await me(a, { as: gone }));
    ok(await me(a));
    ok(await me(a, { as: alive }));
    const goneId = (await sessionRowOf(gone.sid))!;
    expect(goneId.revocation_reason).toBe('KEYCLOAK_ENDED');
    const ended = await auditOf(a.accountId, 'SESSION_ENDED');
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ application_session_id: goneId.application_session_id, changes: { reason: 'KEYCLOAK_ENDED' } });
    expect((await eventsOf(a.accountId, SECURITY_EVENTS.sessionRevoked)).map((e) => e.payload_json)).toEqual([
      { accountId: a.accountId, applicationSessionId: goneId.application_session_id, reason: 'KEYCLOAK_ENDED' },
    ]);
    // listing again changes nothing
    const before = await writes();
    ok(await sessionsOf(a, { app: g0.app }), OP.sessions);
    expect(await writes()).toEqual(before);
    // the timeline shows it as ended
    expect((await activity(a, '?limit=100')).body.data.entries.map((e: Json) => e.type)).toContain('SESSION_ENDED');
  });

  it('when the provider cannot be asked the list says reconciled=false and nothing is mutated (failure, outage, no admin client)', async () => {
    const g0 = await makeApp({ graceSeconds: 0 });
    const a = await newActor('rec-down');
    const orphan = await login(a, { inProvider: false });
    provider.failNext('listSessions');
    const failing = ok(await sessionsOf(a, { app: g0.app }), OP.sessions);
    expect(failing.reconciled).toBe(false);
    expect(failing.sessions).toHaveLength(2);
    provider.available = false;
    try {
      expect(ok(await sessionsOf(a, { app: g0.app }), OP.sessions).reconciled).toBe(false);
    } finally {
      provider.available = true;
    }
    const none = await makeApp({ provider: createUnavailableSecurityIdentityProvider(), graceSeconds: 0 });
    const d = ok(await sessionsOf(a, { app: none.app }), OP.sessions);
    expect(d.reconciled).toBe(false);
    expect(d.sessions).toHaveLength(2);
    expect((await sessionRowOf(orphan.sid))!.revoked_at).toBeNull();
    ok(await me(a, { as: orphan }));
  });

  it('a session not seen for longer than session.keep_signed_in_days is closed on the next listing (never the current one), whatever the provider says', async () => {
    const a = await newActor('rec-expired');
    const old = await login(a);
    const oldCurrent = a.t0;
    await age(old.sid, 40);
    await age(oldCurrent.sid, 40);
    const down = await makeApp({ provider: createUnavailableSecurityIdentityProvider() });
    const d = ok(await sessionsOf(a, { app: down.app }), OP.sessions);
    expect(d.sessions.map((s: Json) => [s.current])).toEqual([[true]]); // the current one stays even though its row is older than the window
    expect((await sessionRowOf(old.sid))!.revocation_reason).toBe('KEYCLOAK_ENDED');
    expect((await auditOf(a.accountId, 'SESSION_ENDED'))[0]!.changes).toMatchObject({ reason: 'KEYCLOAK_ENDED' });
    revoked(await me(a, { as: old }));
    ok(await me(a));
  });

  it('revoke-all asks the provider to end each other session (not the current one) and reports ENDED; with includeCurrent it ends all of the user sessions', async () => {
    const a = await newActor('prop-all');
    const o1 = await login(a);
    const o2 = await login(a);
    provider.endedSessions.length = 0;
    expect(ok(await revokeAll(a, {}), OP.revokeAll)).toEqual({ revokedCount: 2, keycloak: 'ENDED' });
    expect([...provider.endedSessions].sort()).toEqual([o1.sid, o2.sid].sort());
    provider.addSession(a.sub, a.t0.sid);
    expect(ok(await revokeAll(a, { includeCurrent: true }), OP.revokeAll)).toMatchObject({ revokedCount: 1, keycloak: 'ENDED' });
    expect(provider.endedSessions).toContain(a.t0.sid);
  });

  it('a provider failure never undoes the revocation: UNAVAILABLE is reported, the sessions are refused anyway (revoke, revoke-all, includeCurrent, outage, no admin client)', async () => {
    const a = await newActor('prop-fail');
    const s1 = await login(a);
    provider.failNext('endSession');
    expect(ok(await revokeOne(a, await sessionIdOf(a, s1)), OP.revoke).keycloak).toBe('UNAVAILABLE');
    revoked(await me(a, { as: s1 }));

    const s2 = await freshLogin(a);
    provider.failNext('listSessions');
    expect(ok(await revokeAll(a, {}), OP.revokeAll)).toEqual({ revokedCount: 1, keycloak: 'UNAVAILABLE' });
    revoked(await me(a, { as: s2 }));

    const s3 = await freshLogin(a);
    provider.available = false;
    try {
      expect(ok(await revokeAll(a, {}), OP.revokeAll)).toEqual({ revokedCount: 1, keycloak: 'UNAVAILABLE' });
    } finally {
      provider.available = true;
    }
    revoked(await me(a, { as: s3 }));

    const s4 = await freshLogin(a);
    provider.failNext('endAllSessions');
    expect(ok(await revokeAll(a, { includeCurrent: true }), OP.revokeAll).keycloak).toBe('UNAVAILABLE');
    revoked(await me(a, { as: s4 }));
    revoked(await me(a));
    // one of several endSession calls failing is still UNAVAILABLE and every session is revoked in the database
    const b = await newActor('prop-partial');
    const x = [await login(b), await login(b), await login(b)];
    provider.failNext('endSession', 1);
    expect(ok(await revokeAll(b, {}), OP.revokeAll)).toEqual({ revokedCount: 3, keycloak: 'UNAVAILABLE' });
    for (const t of x) revoked(await me(b, { as: t }));
    provider.clearFailures();
  });

  it('the identity provider is never asked about another account: its calls name only the subject and sessions of this account', async () => {
    const a = await newActor('prop-scope');
    const b = await newActor('prop-scope-b');
    const bs = await login(b);
    provider.calls.length = 0;
    ok(await revokeAll(a, { includeCurrent: true }), OP.revokeAll);
    expect(provider.calls.every((c) => c.subject === undefined || c.subject === a.sub)).toBe(true);
    expect(provider.endedSessions).not.toContain(bs.sid);
    ok(await me(b, { as: bs }));
  });
});

// ====================================================================== password change, registration and the guards (final behaviour)
describe('further behaviour of the final implementation', () => {
  it('registerSession observes a password change too: older sessions of the account end with reason PASSWORD_CHANGED, the registering one stays', async () => {
    const a = await newActor('pwreg');
    const older = await login(a, { authTime: appNow() - 900 });
    provider.setUser(a.sub, { passwordChangedAt: new Date((await dbEpoch()) * 1000 + 1000) });
    ok(await registerDevice(a, newSecret(), UA.firefoxLinux), OP.register);
    revoked(await me(a, { as: older }));
    ok(await me(a));
    expect((await sessionRowOf(older.sid))!.revocation_reason).toBe('PASSWORD_CHANGED');
    expect(await actionsOf(a.accountId, 'PASSWORD_CHANGED')).toHaveLength(1);
    expect((await auditOf(a.accountId, 'SESSION_REVOKED')).map((r) => r.changes.reason)).toEqual(['PASSWORD_CHANGED']);
  });

  it('a session created AFTER the password change is not ended by it', async () => {
    const a = await newActor('pwafter');
    provider.setUser(a.sub, { passwordChangedAt: new Date((await dbEpoch()) * 1000 - 5000) });
    const later = await login(a);
    await overview(a);
    ok(await me(a, { as: later }));
  });

  it('the step-up guards refuse non-web contexts themselves (403 ACCOUNT_CONTEXT_NOT_SUPPORTED), even without requireAccount in front', async () => {
    const guardOnly = Fastify({ logger: false });
    await guardOnly.register(correlationPlugin);
    await guardOnly.register(errorPlugin);
    await guardOnly.register(authPlugin, { verifier: verifierFor(), realm: REALM });
    await guardOnly.register(accountPlugin, { accounts, security });
    guardOnly.get('/recent', { preValidation: requireRecentAuthentication() }, async () => ({ passed: true }));
    guardOnly.get('/mfa', { preValidation: requireMfa() }, async () => ({ passed: true }));
    await guardOnly.ready();
    extraApps.push(guardOnly);
    const sub = `itest-admin-${randomUUID()}`;
    secrets.subjects.push(sub);
    const admin = await mint(
      { sub },
      {
        acr: ACR_MFA,
        claims: { azp: 'bananagig-admin', resource_access: { 'bananagig-admin': { roles: ['admin-console-access'] } }, realm_access: { roles: [] } },
      },
    );
    const other = await mint({ sub: `itest-other-${randomUUID()}` }, { acr: ACR_MFA, claims: { azp: 'bananagig-dev-test' } });
    for (const path of ['/recent', '/mfa']) {
      for (const t of [admin, other]) {
        const r = await guardOnly.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${t.token}` } });
        expect(r.statusCode, path).toBe(403);
        expect(JSON.parse(r.body).error.code).toBe('ACCOUNT_CONTEXT_NOT_SUPPORTED');
      }
    }
  });

  it('closing the app drains the detached password-reset work (bounded): the audit row and the provider call exist after close', async () => {
    const closing = await makeApp();
    const a = await newActor('close-drain');
    const address = await verifyEmail(a);
    provider.setUser(a.sub, { email: address });
    provider.sentResetEmails.length = 0;
    const release = provider.hold('getUserSecurity');
    ok(await resetPassword(address, { app: closing.app, ip: nextIp() }), OP.reset, 202);
    setTimeout(release, 50);
    await closing.app.close();
    expect(provider.sentResetEmails.filter((m) => m.subject === a.sub)).toHaveLength(1);
    expect(await actionsOf(a.accountId, 'PASSWORD_RESET_REQUESTED')).toHaveLength(1);
  });

  it('closing the app does not hang on a provider that never answers (the drain is bounded)', async () => {
    const closing = await makeApp();
    const a = await newActor('close-hang');
    const address = await verifyEmail(a);
    provider.setUser(a.sub, { email: address });
    const release = provider.hold('getUserSecurity');
    ok(await resetPassword(address, { app: closing.app, ip: nextIp() }), OP.reset, 202);
    const started = performance.now();
    await closing.app.close();
    const took = performance.now() - started;
    release();
    await closing.security.drain();
    expect(took).toBeLessThan(15000);
  }, 40000);
});

// ====================================================================== HTTP-level concurrency
describe('concurrency over HTTP', () => {
  it('parallel DELETEs of the same session: all answer 200, exactly one changed=true, one SESSION_REVOKED audit row and one event', async () => {
    for (let round = 0; round < 3; round++) {
      const a = await newActor(`cc-revoke-${round}`);
      const s2 = await login(a);
      const id = await sessionIdOf(a, s2);
      const results = await Promise.all(Array.from({ length: 10 }, () => revokeOne(a, id)));
      const data = results.map((r) => ok(r, OP.revoke));
      expect(data.filter((d) => d.changed)).toHaveLength(1);
      expect(await auditOf(a.accountId, 'SESSION_REVOKED')).toHaveLength(1);
      expect(await eventsOf(a.accountId, SECURITY_EVENTS.sessionRevoked)).toHaveLength(1);
      revoked(await me(a, { as: s2 }));
      ok(await me(a));
    }
  });

  it('parallel revoke-all from the same session: the total revoked equals the number of sessions, once each; the caller survives; one SESSIONS_REVOKED_ALL per call', async () => {
    for (let round = 0; round < 3; round++) {
      const a = await newActor(`cc-all-${round}`);
      const others = await Promise.all(Array.from({ length: 6 }, () => login(a)));
      const results = await Promise.all(Array.from({ length: 6 }, () => revokeAll(a, {})));
      const total = results.map((r) => ok(r, OP.revokeAll).revokedCount).reduce((x, y) => x + y, 0);
      expect(total).toBe(6);
      expect(await auditOf(a.accountId, 'SESSION_REVOKED')).toHaveLength(6);
      expect(await auditOf(a.accountId, 'SESSIONS_REVOKED_ALL')).toHaveLength(6);
      for (const t of others) revoked(await me(a, { as: t }));
      ok(await me(a));
    }
  });

  it('parallel revoke-all from DIFFERENT sessions of one account: every call answers, each session is revoked exactly once, the account row is not corrupted', async () => {
    const a = await newActor('cc-all-mixed');
    const tokens = [a.t0, ...(await Promise.all(Array.from({ length: 5 }, () => login(a))))];
    const results = await Promise.all(tokens.map((t) => revokeAll(a, {}, { as: t })));
    for (const r of results) expect([200, 401]).toContain(r.status);
    for (const r of results) if (r.status === 401) revoked(r);
    const rows = await sessionRows(a.accountId);
    expect(rows.filter((r) => r.revoked_at !== null).length).toBeGreaterThanOrEqual(5);
    expect(await auditOf(a.accountId, 'SESSION_REVOKED')).toHaveLength(rows.filter((r) => r.revoked_at !== null).length);
    expect(await watermarkOf(a.accountId)).not.toBeNull();
  });

  it('parallel first requests with ONE sid (existing account): one session row, one SESSION_CREATED audit row, one event, all 200', async () => {
    for (let round = 0; round < 3; round++) {
      const a = await newActor(`cc-first-${round}`);
      const t = await mint(a);
      const results = await Promise.all(Array.from({ length: 15 }, (_, i) => (i % 2 ? me(a, { as: t }) : sessionsOf(a, { as: t }))));
      for (const r of results) expect(r.status, r.raw).toBe(200);
      expect(await count('SELECT 1 FROM identity.application_sessions WHERE keycloak_session_id = $1', [t.sid])).toBe(1);
      expect((await auditOf(a.accountId, 'SESSION_CREATED')).length).toBe(2); // the actor's first session and this one
      expect((await eventsOf(a.accountId, SECURITY_EVENTS.sessionCreated)).length).toBe(2);
    }
  });

  it('parallel first requests of a brand-new person with one sid: one account, one identity, one session', async () => {
    const sub = `itest-cc-new-${randomUUID()}`;
    secrets.subjects.push(sub);
    const t = await mint({ sub });
    const results = await Promise.all(Array.from({ length: 12 }, () => call(undefined, 'GET', '/account/me', { as: t })));
    for (const r of results) expect(r.status, r.raw).toBe(200);
    expect(new Set(results.map((r) => r.body.data.accountId)).size).toBe(1);
    const accountId = results[0]!.body.data.accountId;
    expect(await sessionRows(accountId)).toHaveLength(1);
    expect(await auditOf(accountId, 'SESSION_CREATED')).toHaveLength(1);
  });

  it('parallel first requests of many distinct sids create one session each', async () => {
    const a = await newActor('cc-many');
    const tokens = await Promise.all(Array.from({ length: 10 }, () => mint(a)));
    const results = await Promise.all(tokens.map((t) => me(a, { as: t })));
    for (const r of results) expect(r.status).toBe(200);
    expect(await sessionRows(a.accountId)).toHaveLength(11);
    expect(await auditOf(a.accountId, 'SESSION_CREATED')).toHaveLength(11);
  });

  it('revoke-all RACING the first request of a session the API has never seen: afterwards that session is refused, whichever side won', async () => {
    const tally = { refusedFirst: 0, servedThenRevoked: 0 };
    for (let i = 0; i < 15; i++) {
      const a = await newActor(`cc-race-${i}`);
      const unseen = await mint(a, { authTime: Math.floor(await dbEpoch()) - 30 });
      const [all, first] = await Promise.all([revokeAll(a, {}), me(a, { as: unseen })]);
      ok(all, OP.revokeAll);
      expect([200, 401], first.raw).toContain(first.status);
      if (first.status === 401) {
        revoked(first);
        tally.refusedFirst += 1;
      } else tally.servedThenRevoked += 1;
      revoked(await me(a, { as: unseen }));
      const row = await sessionRowOf(unseen.sid);
      if (row) expect(row.revocation_reason).toBe('SIGN_OUT_EVERYWHERE');
      ok(await me(a));
    }
    expect(tally.refusedFirst + tally.servedThenRevoked).toBe(15);
  });

  it('parallel trust renewals: all succeed, each is audited, the window only moves forward', async () => {
    const a = await newActor('cc-trust');
    await withDevice(a);
    const results = await Promise.all(Array.from({ length: 6 }, () => trustDevice(a)));
    const until = results.map((r) => Date.parse(ok(r, OP.trust).trustedUntil));
    expect(await auditOf(a.accountId, 'DEVICE_TRUSTED')).toHaveLength(6);
    expect((await deviceRows(a.accountId))[0]!.trusted_until!.getTime()).toBe(Math.max(...until));
  });

  it('parallel removals of one device: one changed=true, one DEVICE_REMOVED row, its sessions revoked once', async () => {
    const a = await newActor('cc-rmdev');
    const d = await withDevice(a);
    const s2 = await login(a);
    await withDevice(a, { as: s2, secret: d.secret });
    const keep = await login(a);
    const results = await Promise.all(Array.from({ length: 6 }, () => removeDevice(a, d.deviceId, { as: keep })));
    const data = results.map((r) => ok(r, OP.removeDevice));
    expect(data.filter((x) => x.changed)).toHaveLength(1);
    expect(data.find((x) => x.changed)!.sessionsRevoked).toBe(2);
    expect(await auditOf(a.accountId, 'DEVICE_REMOVED')).toHaveLength(1);
    expect(await auditOf(a.accountId, 'SESSION_REVOKED')).toHaveLength(2);
  });

  it('parallel registrations of the same secret from two sessions: one device row', async () => {
    const a = await newActor('cc-reg');
    const s2 = await login(a);
    const secret = newSecret();
    const results = await Promise.all([
      registerDevice(a, secret, UA.safariMac),
      registerDevice(a, secret, UA.safariMac, { as: s2 }),
      registerDevice(a, secret, UA.safariMac),
    ]);
    const ids = new Set(results.map((r) => ok(r, OP.register).deviceId));
    expect(ids.size).toBe(1);
    expect(await deviceRows(a.accountId)).toHaveLength(1);
  });

  it('parallel overviews that observe the same password change write one PASSWORD_CHANGED row', async () => {
    const a = await newActor('cc-pw');
    provider.setUser(a.sub, { passwordChangedAt: new Date((await dbEpoch()) * 1000 + 1000) });
    await Promise.all(Array.from({ length: 8 }, () => overview(a)));
    expect(await actionsOf(a.accountId, 'PASSWORD_CHANGED')).toHaveLength(1);
  });

  it('parallel password-reset requests: exactly the limit passes, the rest are 429, whoever asks', async () => {
    const address = `cc-reset-${randomUUID()}@example.test`;
    secrets.emails.push(address);
    const results = await Promise.all(Array.from({ length: 12 }, () => resetPassword(address, { ip: nextIp() })));
    expect(results.filter((r) => r.status === 202)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
    for (const r of results.filter((x) => x.status === 429)) fail(r, 429, 'ACCOUNT_PASSWORD_RESET_RATE_LIMITED');
  });
});

// ====================================================================== nothing accepts or echoes an identifier of the login
describe('no route accepts or echoes an account id, a subject or a Keycloak session id', () => {
  it('every route refuses those fields in the body and in the query (400), and answers the same for the caller own data', async () => {
    const a = await newActor('noid');
    const other = await newActor('noid-other');
    const d = await withDevice(a);
    const extras = [
      { accountId: other.accountId },
      { account_id: other.accountId },
      { subject: other.sub },
      { sub: other.sub },
      { sid: other.t0.sid },
      { keycloakSessionId: other.t0.sid },
      { sessionId: await sessionIdOf(other, other.t0) },
      { deviceId: d.deviceId },
    ];
    const before = await writes();
    for (const extra of extras) {
      const key = Object.keys(extra)[0]!;
      fail(await revokeAll(a, extra), 400, 'VALIDATION_FAILED');
      fail(await call(a, 'POST', `${SEC}/sessions/current`, { body: { device: newSecret(), ...extra } }), 400, 'VALIDATION_FAILED');
      fail(await call(a, 'POST', `${SEC}/mfa/enrollment`, { body: { method: 'TOTP', ...extra } }), 400, 'VALIDATION_FAILED');
      fail(await call(a, 'POST', `${SEC}/sessions/current/sign-out`, { body: extra }), 400, 'VALIDATION_FAILED');
      fail(await call(a, 'POST', `${SEC}/devices/current/trust`, { body: extra }), 400, 'VALIDATION_FAILED');
      fail(await call(a, 'POST', '/auth/password-reset', { body: { email: 'x@example.test', ...extra } }), 400, 'VALIDATION_FAILED');
      for (const path of [SEC, `${SEC}/sessions`, `${SEC}/devices`, `${SEC}/activity`])
        fail(await call(a, 'GET', `${path}?${key}=${encodeURIComponent(String(Object.values(extra)[0]))}`), 400, 'VALIDATION_FAILED');
    }
    expect(await writes()).toEqual(before);
    // an authenticated caller always acts on the account of its token: B's token never shows A's data
    expect(ok(await devicesOf(other), OP.devices).devices).toEqual([]);
    expect(ok(await sessionsOf(other), OP.sessions).sessions).toHaveLength(1);
  });
});

// ====================================================================== framework errors keep the privacy headers
describe('errors raised before the routes run', () => {
  it('a malformed URL or an over-long path parameter is a 400 envelope; none of them echoes the input', async () => {
    const a = await newActor('fw');
    const r1 = await revokeOne(a, 'z'.repeat(500));
    expect(r1.status).toBe(400);
    expect(ErrorResponse.safeParse(r1.body).success).toBe(true);
    expect(r1.raw).not.toContain('zzzzzzzzzz');

    const r2 = await call(a, 'DELETE', `${SEC}/sessions/%E0%A4%A`);
    expect(r2.status).toBe(400);
    expect(ErrorResponse.safeParse(r2.body).success).toBe(true);
  });

  it('router-level errors (over-long path parameter, malformed URL, unknown route) under /account and /auth are also Cache-Control: no-store', async () => {
    const a = await newActor('fw-cache');
    for (const r of [
      await revokeOne(a, 'z'.repeat(500)),
      await call(a, 'DELETE', `${SEC}/sessions/%E0%A4%A`),
      await call(a, 'GET', '/account/security/nope'),
      await call(a, 'GET', '/auth/nope', { as: null }),
      await call(undefined, 'GET', '/auth/password-reset', { as: null }),
    ]) {
      expect(ErrorResponse.safeParse(r.body).success, r.raw).toBe(true);
      expect(r.headers['cache-control'], `${r.method} ${r.url}`).toBe('no-store');
    }
  });
});

// ====================================================================== secrecy and caching over EVERYTHING this file did (keep last)
describe('secrecy and caching over the whole transcript', () => {
  const FORBIDDEN_KEYS = new Set([
    'accountid',
    'account_id',
    'subject',
    'sub',
    'sid',
    'keycloaksessionid',
    'keycloak_session_id',
    'devicehash',
    'device_hash',
    'devicesecret',
    'useragent',
    'user_agent',
    'ip',
    'clientip',
    'email',
    'token',
    'accesstoken',
  ]);
  const keysOf = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        keysOf(x, out);
      }
    return out;
  };
  const isSecurityPath = (r: Res): boolean => r.url.startsWith('/api/v1/account/security') || r.url.startsWith('/api/v1/auth/password-reset');

  it('every response of the account and auth routes, errors and router-level errors included, is Cache-Control: no-store', () => {
    const relevant = transcript.filter((r) => r.url.startsWith('/api/v1/account') || r.url.startsWith('/api/v1/auth'));
    expect(relevant.length).toBeGreaterThan(1000);
    const missing = relevant.filter((r) => r.headers['cache-control'] !== 'no-store');
    expect(missing.map((r) => `${r.method} ${r.url} ${r.status} ${r.body?.error?.code}`)).toEqual([]);
  });

  it('the security responses carry no field that names the account, the subject, the Keycloak session, the device secret, the user agent or an address', () => {
    const rs = transcript.filter(isSecurityPath);
    expect(rs.length).toBeGreaterThan(500);
    const offenders: string[] = [];
    for (const r of rs) {
      const bad = keysOf(r.body).filter((k) => FORBIDDEN_KEYS.has(k.toLowerCase()));
      // a request for `device` registration echoes nothing: the response keys must not include it either
      if (bad.length) offenders.push(`${r.method} ${r.url}: ${bad.join(',')}`);
    }
    expect(offenders).toEqual([]);
  });

  const needles = (): { name: string; value: string }[] => {
    const out: { name: string; value: string }[] = [];
    for (const t of secrets.tokens) {
      const [, payload, signature] = t.split('.');
      out.push({ name: 'token', value: t }, { name: 'token payload', value: payload! }, { name: 'token signature', value: signature! });
    }
    for (const v of secrets.sids) out.push({ name: 'sid', value: v });
    for (const v of secrets.subjects) out.push({ name: 'subject', value: v });
    for (const v of secrets.emails) out.push({ name: 'email', value: v }, { name: 'email', value: v.toUpperCase() });
    for (const v of secrets.ips) out.push({ name: 'ip', value: v });
    for (const v of secrets.devices) out.push({ name: 'device secret', value: v });
    for (const v of secrets.userAgents) out.push({ name: 'user agent', value: v });
    return out;
  };
  const firstHit = (haystack: string, skip: ReadonlySet<string> = new Set()): string | undefined => {
    for (const n of needles()) if (n.value.length >= 16 && !skip.has(n.name) && haystack.includes(n.value)) return `${n.name} ${n.value.slice(0, 12)}...`;
    return undefined;
  };

  it('no response body or header contains a token, a sid, a subject, an address, an IP, a device secret or a user agent', () => {
    expect(needles().filter((n) => n.value.length >= 16).length).toBeGreaterThan(1000);
    const offenders: string[] = [];
    for (const r of transcript) {
      const hit = firstHit(`${r.raw}\n${JSON.stringify(r.headers)}`);
      if (hit) offenders.push(`${r.method} ${r.url} ${r.status}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it('no table of the identity and integration schemas (audit rows, outbox payloads, devices, sessions) holds a secret outside its one legitimate place', async () => {
    const tables = await q<{ schemaname: string; tablename: string }>(
      `SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('identity', 'integration')`,
    );
    expect(tables.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const t of tables) {
      const rows = await q<{ j: string }>(`SELECT to_jsonb(t)::text AS j FROM ${t.schemaname}.${t.tablename} t`);
      const skip = new Set<string>();
      if (t.tablename === 'application_sessions') skip.add('sid'); // the Keycloak session id is stored here by design (and only here)
      if (t.tablename === 'external_identities') skip.add('subject'); // the link table
      if (t.tablename.startsWith('email_')) skip.add('email'); // the contact itself
      for (const row of rows) {
        const hit = firstHit(row.j, skip);
        if (hit) offenders.push(`${t.schemaname}.${t.tablename}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
    // and the audit and outbox rows of the security layer carry identifiers only
    const audit = await q<{ j: string }>(`SELECT changes::text AS j FROM identity.account_audit_events WHERE changes IS NOT NULL`);
    expect(audit.length).toBeGreaterThan(100);
    const outbox = await q<{ j: string }>(`SELECT payload_json::text AS j FROM integration.outbox_events WHERE event_type LIKE 'bananagig.identity.%'`);
    expect(outbox.length).toBeGreaterThan(100);
  });

  it('the device secret is stored only as a 64-hex keyed hash, and the user agent is not stored at all', async () => {
    const hashes = await q<{ device_hash: string }>('SELECT device_hash FROM identity.account_devices');
    expect(hashes.length).toBeGreaterThan(20);
    for (const h of hashes) expect(h.device_hash).toMatch(/^[0-9a-f]{64}$/);
    const columns = await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'identity' AND table_name IN ('account_devices', 'application_sessions')`,
    );
    expect(columns.map((c) => c.column_name).filter((c) => /agent|ip_|_ip|address|secret|token/.test(c))).toEqual([]);
  });

  it('no captured log line contains a token, a sid, a subject, an address, an IP, a device secret or a user agent, and the lines that exist carry codes only', () => {
    const joined = logLines.join('\n');
    expect(logLines.length, 'the run produced log lines (provider and limiter failures were injected)').toBeGreaterThan(5);
    expect(firstHit(joined)).toBeUndefined();
    expect(joined).toMatch(/identity provider session could not be ended|identity provider sessions could not be listed|rate limiter unavailable/);
    for (const line of logLines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && 'code' in parsed) expect(String(parsed.code)).toMatch(/^[A-Z_]{3,40}$/);
      } catch {
        /* not a JSON line */
      }
    }
  });

  it('every operation of the security tag was exercised and its success body equals its contract exactly', () => {
    const doc = app.swagger() as { paths: Record<string, Record<string, { operationId?: string; tags?: string[]; security?: unknown[] }>> };
    const ops: { id: string; path: string; method: string; security?: unknown[] }[] = [];
    for (const [path, item] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(item))
        if (op.tags?.includes('security')) ops.push({ id: op.operationId!, path, method, security: op.security });
    expect(ops.length).toBe(13);
    expect(new Set(ops.map((o) => o.id))).toEqual(new Set(Object.keys(SHAPES)));
    for (const o of ops) {
      expect(shapeChecked.has(o.id), `${o.id} (${o.method} ${o.path}) validated against its contract`).toBe(true);
      expect(o.path.startsWith('/api/v1/')).toBe(true);
      if (o.id === 'requestPasswordReset') expect(o.security).toEqual([]);
      else expect(o.security).toEqual([{ bearerAuth: [] }]);
    }
  });
});
