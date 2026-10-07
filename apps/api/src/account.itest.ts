// ID-001 application account over HTTP: the real AccountService, ContentService and GeographyService on one real, isolated PostgreSQL (migration
// 0009 seeds the CUSTOMER and PROVIDER roles and the account copy), the real auth plugin and forged-but-signed tokens (so the test does not depend on the
// Keycloak realm import). The account comes from the verified token only: this file proves a request cannot choose another account, that the
// admin context has none, that role switching persists nothing, that account status gates every route, and that the new strict bodies keep the
// DEBT-0043 regression closed. Granting a role is server-side only, so the test grants through AccountService exactly as provider sign-up will.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AccountService } from '@bananagig/accounts';
import { loadConfig } from '@bananagig/config';
import { MemoryConfigCache } from '@bananagig/configuration';
import {
  ACCOUNT_STATUSES,
  AccountResponse,
  ACTIVE_ROLE_HEADER,
  CORRELATION_HEADER,
  ErrorResponse,
  IDENTITY_EVENTS,
  accountStatusLabelKey,
} from '@bananagig/contracts';
import { ContentService } from '@bananagig/content';
import { GeographyService, ReadinessRegistry, createGeographyScopeReferenceValidator, createMarketDefaultsProvider } from '@bananagig/geography';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';

let iso: IsolatedDatabase;
let app: FastifyInstance;
let keys: TestKeys;
let accounts: AccountService;
let content: ContentService;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Res {
  method: string;
  url: string;
  status: number;
  body: Json;
  headers: Record<string, unknown>;
  raw: string;
}
/** Every response of the file, so the last test can prove no token, subject or issuer ever appeared in one. */
const transcript: Res[] = [];
const issuedTokens: string[] = [];
const issuedSubjects: string[] = [];

const subject = (label: string): string => {
  const s = `itest-${label}-${randomUUID()}`;
  issuedSubjects.push(s);
  return s;
};
const track = async (token: Promise<string>): Promise<string> => {
  const t = await token;
  issuedTokens.push(t);
  return t;
};
/** A token of the normal web context. Every token gets its own session id, so two tokens of one subject are different strings. */
const webToken = (sub: string, roles: string[] = ['customer'], claims: Record<string, unknown> = {}) =>
  track(signToken(keys, { claims: { sub, azp: 'bananagig-web', sid: randomUUID(), realm_access: { roles }, ...claims } }));
const adminToken = (sub: string) =>
  track(
    signToken(keys, {
      claims: {
        sub,
        azp: 'bananagig-admin',
        sid: randomUUID(),
        realm_access: { roles: [] },
        resource_access: { 'bananagig-admin': { roles: ['admin-console-access', 'content-read', 'geography-read'] } },
      },
    }),
  );
const otherClientToken = (sub: string) =>
  track(signToken(keys, { claims: { sub, azp: 'bananagig-dev-test', sid: randomUUID(), realm_access: { roles: ['customer'] } } }));

interface SendOptions {
  token?: string;
  /** JSON-serialized by the helper (so a test can send a number, an array or null as the body). */
  body?: unknown;
  /** Sent verbatim with a JSON content type (malformed JSON). */
  rawBody?: string;
  headers?: Record<string, string>;
}
async function send(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, o: SendOptions = {}): Promise<Res> {
  const hasBody = o.body !== undefined || o.rawBody !== undefined;
  const path = url.startsWith('/api/') ? url : `/api/v1${url}`;
  const r = await app.inject({
    method,
    url: path,
    headers: { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(hasBody ? { 'content-type': 'application/json' } : {}), ...o.headers },
    ...(hasBody ? { payload: o.rawBody ?? JSON.stringify(o.body) } : {}),
  });
  let body: Json;
  try {
    body = JSON.parse(r.body);
  } catch {
    body = undefined;
  }
  const res: Res = { method, url: path, status: r.statusCode, body, headers: r.headers, raw: r.body };
  transcript.push(res);
  return res;
}
const me = (token?: string, headers?: Record<string, string>) => send('GET', '/account/me', { token, headers });
const setRole = (token: string | undefined, role: unknown, headers?: Record<string, string>) =>
  send('POST', '/account/active-role', { token, body: { role }, headers });
const putProfile = (token: string | undefined, body: unknown, headers?: Record<string, string>) => send('PUT', '/account/profile', { token, body, headers });
const withRole = (role: string) => ({ [ACTIVE_ROLE_HEADER]: role });

const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => iso.database.query<T>(text, params);
const accountIdOf = async (sub: string): Promise<string | undefined> =>
  (await q<{ account_id: string }>('SELECT account_id FROM identity.external_identities WHERE provider_subject = $1', [sub]))[0]?.account_id;
const SYSTEM = { actor: 'system:itest', source: 'SYSTEM' } as const;

/** Everything a request must NOT change when it only reads or validates (the row contents, not last_seen_at, which the identity touch updates on purpose). */
const state = async () => ({
  accounts: await q('SELECT account_id, status, primary_role_id, created_at, updated_at, closed_at FROM identity.accounts ORDER BY account_id'),
  memberships: await q(
    'SELECT account_id, role_id, status, granted_at, activated_at, deactivated_at, granted_by, grant_source, updated_at FROM identity.account_roles ORDER BY account_id, role_id',
  ),
  profiles: await q('SELECT account_id, first_name, last_name, preferred_locale, time_zone_id, updated_at FROM identity.account_profiles ORDER BY account_id'),
  identities: await q(
    'SELECT external_identity_id, account_id, issuer, provider_subject, created_at FROM identity.external_identities ORDER BY external_identity_id',
  ),
  history: (await q<{ n: number }>('SELECT count(*)::int AS n FROM identity.account_status_history'))[0]!.n,
  audit: (await q<{ n: number }>('SELECT count(*)::int AS n FROM identity.account_audit_events'))[0]!.n,
  outbox: (await q<{ n: number }>("SELECT count(*)::int AS n FROM integration.outbox_events WHERE aggregate_type = 'identity_account'"))[0]!.n,
});
const outboxOf = (accountId: string) =>
  q<{
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    actor_type: string;
    actor_id: string;
    correlation_id: string;
    payload_json: Record<string, unknown>;
  }>(
    `SELECT event_type, aggregate_type, aggregate_id, actor_type, actor_id, correlation_id, payload_json FROM integration.outbox_events
      WHERE aggregate_id = $1 ORDER BY created_at, event_type`,
    [accountId],
  );
const auditOf = (accountId: string) =>
  q<{ action: string; actor: string; role_code: string | null; changes: Record<string, unknown> | null; correlation_id: string }>(
    `SELECT a.action, a.actor, r.code AS role_code, a.changes, a.correlation_id FROM identity.account_audit_events a
       LEFT JOIN identity.roles r ON r.role_id = a.role_id WHERE a.account_id = $1 ORDER BY a.occurred_at, a.audit_event_id`,
    [accountId],
  );
const historyOf = (accountId: string) =>
  q<{ from_status: string | null; to_status: string; actor: string; correlation_id: string }>(
    'SELECT from_status, to_status, actor, correlation_id FROM identity.account_status_history WHERE account_id = $1 ORDER BY history_seq',
    [accountId],
  );

const expectError = (r: Res, status: number, code: string) => {
  expect(r.status, r.raw).toBe(status);
  expect(ErrorResponse.safeParse(r.body).success, r.raw).toBe(true);
  expect(r.body.error.code, r.raw).toBe(code);
  expect(r.body.error.correlationId, 'the error carries the correlation id of the request').toBe(r.headers[CORRELATION_HEADER]);
};
const expectAccount = (r: Res) => {
  expect(r.status, r.raw).toBe(200);
  const parsed = AccountResponse.safeParse(r.body);
  expect(parsed.success, r.raw).toBe(true);
  expect(r.body.meta.correlationId).toBe(r.headers[CORRELATION_HEADER]);
  return r.body.data as Json;
};
const roleCodes = (data: Json): string[] => data.roles.map((x: { code: string }) => x.code).sort();
/** The distinctive characters of the name tests, built from code points so no escape sequence has to appear in this file. */
const ch = (code: number): string => String.fromCharCode(code);
const RLO = ch(0x202e); // right-to-left override
const BEL = ch(0x07);
const NUL = ch(0x00);
const ZWSP = ch(0x200b);
const LONE_SURROGATE = ch(0xd800);
const COMBINING_ACUTE = ch(0x0301);

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  keys = await createTestKeys('k1');
  const readiness = new ReadinessRegistry();
  const geography = new GeographyService({ database: iso.database, cache: new MemoryConfigCache(), env: 'test', allowTestKeys: true, readiness });
  content = new ContentService({
    database: iso.database,
    env: 'test',
    allowTestKeys: true,
    scopeReferences: createGeographyScopeReferenceValidator(geography),
    markets: createMarketDefaultsProvider(geography),
  });
  // lastSeenTouchSeconds 0: every authenticated request touches last_seen_at, which the identity tests below rely on
  accounts = new AccountService({ database: iso.database, lastSeenTouchSeconds: 0 });
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  app = await buildApp({
    cfg: loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } }),
    verifier,
    configuration: {} as never,
    content,
    geography,
    accounts,
    readiness: async () => ({}),
  });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await iso?.drop();
});
afterEach(() => vi.restoreAllMocks());

// ====================================================================== authentication and identity context
describe('account API: authentication and identity context', () => {
  const ROUTES = [
    ['GET', '/account/me', undefined],
    ['POST', '/account/active-role', { role: 'CUSTOMER' }],
    ['PUT', '/account/profile', { firstName: 'Ana', lastName: 'M' }],
  ] as const;

  it('answers 401 on every route without a usable access token and creates nothing', async () => {
    const before = await state();
    const foreign = await createTestKeys('k-foreign');
    const bad = {
      'no token': undefined,
      'not a jwt': 'not.a.jwt',
      'foreign signature': await signToken(foreign, { claims: { sub: subject('forged'), azp: 'bananagig-web' } }),
      expired: await signToken(keys, { claims: { sub: subject('expired'), azp: 'bananagig-web' }, expiresInSec: -120 }),
      'wrong audience': await signToken(keys, { claims: { sub: subject('aud'), azp: 'bananagig-web', aud: 'somebody-else' } }),
    };
    for (const [method, url, body] of ROUTES) {
      for (const [what, token] of Object.entries(bad)) {
        const r = await send(method, url, { token, body });
        expectError(r, 401, token === undefined ? 'AUTHENTICATION_REQUIRED' : 'INVALID_TOKEN');
        expect(String(r.headers['www-authenticate']), `${method} ${url} ${what}`).toContain('Bearer');
      }
      // an Authorization header that is not a bearer token is the same 401
      const basic = await app.inject({ method, url: `/api/v1${url}`, headers: { authorization: 'Basic Zm9vOmJhcg==' } });
      expect(basic.statusCode, `${method} ${url}`).toBe(401);
    }
    // authentication wins over validation: a rejected body without a token is a 401, not a 400
    expectError(await send('POST', '/account/active-role', { body: { role: 1 } }), 401, 'AUTHENTICATION_REQUIRED');
    expectError(await send('PUT', '/account/profile', { body: { firstName: 1 } }), 401, 'AUTHENTICATION_REQUIRED');
    expectError(await send('GET', '/account/me?accountId=nobody'), 401, 'AUTHENTICATION_REQUIRED');
    expect(await state()).toEqual(before);
  });

  it('refuses the admin identity context (azp bananagig-admin) with 403 ACCOUNT_CONTEXT_NOT_SUPPORTED and creates no account or identity row for it', async () => {
    const sub = subject('admin');
    const t = await adminToken(sub);
    const before = await state();
    for (const [method, url, body] of ROUTES) {
      const r = await send(method, url, { token: t, body });
      expectError(r, 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED');
      expect(r.body.error.category).toBe('AUTHORIZATION');
    }
    // the guard runs before body validation, so even a malformed body is a 403 for this context
    expectError(await setRole(t, 1), 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED');
    expectError(await putProfile(t, { firstName: 1 }), 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED');
    expect(await accountIdOf(sub)).toBeUndefined();
    expect(await state()).toEqual(before);
    // an admin token that also names an application role gets nothing either
    expectError(await me(t, withRole('CUSTOMER')), 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED');
  });

  it("refuses an 'other' client context (a token issued to any client that is neither web nor admin) with 403 and creates nothing", async () => {
    const sub = subject('other');
    const t = await otherClientToken(sub);
    const before = await state();
    for (const [method, url, body] of ROUTES) expectError(await send(method, url, { token: t, body }), 403, 'ACCOUNT_CONTEXT_NOT_SUPPORTED');
    expect(await accountIdOf(sub)).toBeUndefined();
    expect(await state()).toEqual(before);
  });
});

// ====================================================================== bootstrap: first request, one identity, one account
describe('account API: account creation and identity mapping', () => {
  it('creates the account at the first authenticated request: ACTIVE, the CUSTOMER role from the bootstrap policy, nothing else', async () => {
    const sub = subject('customer');
    const cid = 'itest-corr-bootstrap-1';
    const r = await me(await webToken(sub), { [CORRELATION_HEADER]: cid });
    const data = expectAccount(r);
    expect(r.headers[CORRELATION_HEADER]).toBe(cid);
    expect(data).toMatchObject({
      status: 'ACTIVE',
      roles: [{ code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' }],
      primaryRole: 'CUSTOMER',
      activeRole: 'CUSTOMER',
      profile: null,
    });
    expect(Object.keys(data).sort()).toEqual(['accountId', 'activeRole', 'createdAt', 'primaryRole', 'profile', 'roles', 'status']);
    expect(Object.keys(data.roles[0]).sort()).toEqual(['code', 'nameContentKey']);
    expect(new Date(data.createdAt).toISOString()).toBe(data.createdAt);
    expect(await accountIdOf(sub)).toBe(data.accountId);

    // the link is the Keycloak issuer + subject; the account row holds neither
    const identities = await q<{ provider_type: string; issuer: string; provider_subject: string }>(
      'SELECT provider_type, issuer, provider_subject FROM identity.external_identities WHERE account_id = $1',
      [data.accountId],
    );
    expect(identities).toEqual([{ provider_type: 'KEYCLOAK', issuer: TEST_ISSUER, provider_subject: sub }]);
    expect(Object.keys((await q('SELECT * FROM identity.accounts WHERE account_id = $1', [data.accountId]))[0]!).sort()).toEqual([
      'account_id',
      'closed_at',
      'created_at',
      'primary_role_id',
      'status',
      'updated_at',
    ]);
    const roles = await q<{ code: string; status: string; grant_source: string; granted_by: string }>(
      `SELECT r.code, m.status, m.grant_source, m.granted_by FROM identity.account_roles m JOIN identity.roles r ON r.role_id = m.role_id WHERE m.account_id = $1`,
      [data.accountId],
    );
    expect(roles).toEqual([{ code: 'CUSTOMER', status: 'ACTIVE', grant_source: 'BOOTSTRAP', granted_by: 'system:account-bootstrap' }]);

    // history, audit and outbox, in one transaction, all carrying the correlation id of the request
    expect(await historyOf(data.accountId)).toEqual([{ from_status: null, to_status: 'ACTIVE', actor: 'system:account-bootstrap', correlation_id: cid }]);
    const audit = await auditOf(data.accountId);
    expect(audit.map((a) => [a.action, a.role_code])).toEqual([
      ['ACCOUNT_CREATED', null],
      ['EXTERNAL_IDENTITY_LINKED', null],
      ['ROLE_GRANTED', 'CUSTOMER'],
      ['PRIMARY_ROLE_CHANGED', null],
    ]);
    for (const a of audit) expect(a.correlation_id).toBe(cid);
    expect(JSON.stringify(audit)).not.toContain(sub);
    const events = await outboxOf(data.accountId);
    expect(events.map((e) => e.event_type).sort()).toEqual(
      [IDENTITY_EVENTS.accountCreated, IDENTITY_EVENTS.accountRoleGranted, IDENTITY_EVENTS.externalIdentityLinked].sort(),
    );
    for (const e of events) {
      expect(e).toMatchObject({
        aggregate_type: 'identity_account',
        aggregate_id: data.accountId,
        actor_type: 'system',
        actor_id: 'system:account-bootstrap',
        correlation_id: cid,
      });
      expect(JSON.stringify(e)).not.toContain(sub);
    }
    const payload = (type: string) => events.find((e) => e.event_type === type)!.payload_json;
    expect(payload(IDENTITY_EVENTS.accountCreated)).toEqual({ accountId: data.accountId, status: 'ACTIVE' });
    expect(payload(IDENTITY_EVENTS.externalIdentityLinked)).toEqual({ accountId: data.accountId, providerType: 'KEYCLOAK' });
    expect(payload(IDENTITY_EVENTS.accountRoleGranted)).toEqual({ accountId: data.accountId, roleCode: 'CUSTOMER', source: 'BOOTSTRAP' });
    // creation does not emit a status change
    expect(events.map((e) => e.event_type)).not.toContain(IDENTITY_EVENTS.accountStatusChanged);
  });

  it('seeds the initial roles from the realm roles of the first token only: customer -> CUSTOMER, provider -> PROVIDER only, none -> no role', async () => {
    const provider = expectAccount(await me(await webToken(subject('provider'), ['provider'])));
    expect(roleCodes(provider)).toEqual(['PROVIDER']);
    expect(provider).toMatchObject({
      status: 'ACTIVE',
      primaryRole: 'PROVIDER',
      activeRole: 'PROVIDER',
      roles: [{ nameContentKey: 'identity.role.provider.name' }],
    });

    const none = expectAccount(await me(await webToken(subject('norole'), [])));
    expect(none).toMatchObject({ status: 'ACTIVE', roles: [], primaryRole: null, activeRole: null, profile: null });

    const unknown = expectAccount(await me(await webToken(subject('unknownrole'), ['offline_access', 'uma_authorization', 'admin', 'PROVIDER'])));
    expect(unknown.roles, 'unknown realm roles (and a wrongly cased one) map to nothing').toEqual([]);

    const both = expectAccount(await me(await webToken(subject('both'), ['customer', 'provider'])));
    expect(roleCodes(both)).toEqual(['CUSTOMER', 'PROVIDER']);
    expect(both.activeRole, 'the first mapped role is the primary one, so the active role is defined without a header').toBe(both.primaryRole);
  });

  it('uses the realm roles ONCE: a later token with other realm roles never adds or removes an application role', async () => {
    const sub = subject('onetime');
    const first = expectAccount(await me(await webToken(sub, ['customer'])));
    // the realm now says provider (and no longer customer): PostgreSQL stays the only authority
    const later = expectAccount(await me(await webToken(sub, ['provider'])));
    expect(later.accountId).toBe(first.accountId);
    expect(roleCodes(later)).toEqual(['CUSTOMER']);
    expect(roleCodes(expectAccount(await me(await webToken(sub, [])))), 'a token with no realm role keeps the account roles').toEqual(['CUSTOMER']);
    expect(await q('SELECT 1 FROM identity.account_audit_events WHERE account_id = $1 AND action = $2', [first.accountId, 'ROLE_GRANTED'])).toHaveLength(1);
  });

  it('returns the same account on repeated calls and across distinct tokens of one subject, and a different account for a different subject', async () => {
    const sub = subject('same');
    const t1 = await webToken(sub);
    const t2 = await webToken(sub);
    expect(t1).not.toBe(t2);
    const a = expectAccount(await me(t1));
    const before = await state();
    const ids = [expectAccount(await me(t1)).accountId, expectAccount(await me(t2)).accountId, expectAccount(await me(await webToken(sub))).accountId];
    expect(ids).toEqual([a.accountId, a.accountId, a.accountId]);
    const after = await state();
    expect(after.accounts).toEqual(before.accounts);
    expect(after.identities, 'no second identity row').toEqual(before.identities);
    expect(after.audit).toBe(before.audit);
    expect(after.outbox).toBe(before.outbox);

    const other = expectAccount(await me(await webToken(subject('different'))));
    expect(other.accountId).not.toBe(a.accountId);
    expect(other.createdAt).not.toBe(a.createdAt);
  });

  it('touches last_seen_at on use (interval 0) without changing the account', async () => {
    const sub = subject('lastseen');
    const t = await webToken(sub);
    const created = expectAccount(await me(t));
    const row = () =>
      q<{ last_seen_at: Date; created_at: Date }>('SELECT last_seen_at, created_at FROM identity.external_identities WHERE provider_subject = $1', [sub]).then(
        (r) => r[0]!,
      );
    const first = await row();
    expectAccount(await me(t));
    const second = await row();
    expect(second.last_seen_at.getTime()).toBeGreaterThan(first.last_seen_at.getTime());
    expect(second.created_at).toEqual(first.created_at);
    expect((await q<{ updated_at: Date }>('SELECT updated_at FROM identity.accounts WHERE account_id = $1', [created.accountId]))[0]!.updated_at).toEqual(
      new Date(created.createdAt),
    );
  });

  it('creates exactly one account for 20 concurrent first requests with the same new token (the unique identity key decides)', async () => {
    const sub = subject('race');
    const t = await webToken(sub, ['customer', 'provider']);
    const before = await state();
    const results = await Promise.all(Array.from({ length: 20 }, () => me(t)));
    for (const r of results) expect(r.status, r.raw).toBe(200);
    const ids = new Set(results.map((r) => r.body.data.accountId));
    expect(ids.size).toBe(1);
    const accountId = [...ids][0] as string;
    for (const r of results) expect(roleCodes(r.body.data)).toEqual(['CUSTOMER', 'PROVIDER']);
    const after = await state();
    // the losers' half-created accounts rolled back: one account, one link, one creation history row, one set of events
    expect(after.accounts).toHaveLength(before.accounts.length + 1);
    expect(after.identities).toHaveLength(before.identities.length + 1);
    expect(after.history).toBe(before.history + 1);
    expect(await q('SELECT 1 FROM identity.external_identities WHERE provider_subject = $1', [sub])).toHaveLength(1);
    expect(await q('SELECT 1 FROM identity.account_roles WHERE account_id = $1', [accountId])).toHaveLength(2);
    expect((await auditOf(accountId)).filter((a) => a.action === 'ACCOUNT_CREATED')).toHaveLength(1);
    const events = (await outboxOf(accountId)).map((e) => e.event_type);
    expect(events.filter((e) => e === IDENTITY_EVENTS.accountCreated)).toHaveLength(1);
    expect(events.filter((e) => e === IDENTITY_EVENTS.accountRoleGranted)).toHaveLength(2);
    expect(
      await q('SELECT 1 FROM identity.accounts a WHERE NOT EXISTS (SELECT 1 FROM identity.external_identities e WHERE e.account_id = a.account_id)'),
    ).toHaveLength(0);
  });

  it('keeps concurrent first requests of several new subjects apart: one account each', async () => {
    const tokens = await Promise.all(Array.from({ length: 6 }, (_, i) => webToken(subject(`multi${i}`))));
    const results = await Promise.all(tokens.flatMap((t) => Array.from({ length: 4 }, () => me(t))));
    for (const r of results) expect(r.status, r.raw).toBe(200);
    const byToken = tokens.map((_, i) => new Set(results.slice(i * 4, i * 4 + 4).map((r) => r.body.data.accountId)));
    for (const s of byToken) expect(s.size).toBe(1);
    expect(new Set(byToken.map((s) => [...s][0])).size).toBe(tokens.length);
  });

  it('cannot be pointed at another account: query, header and body can never override the identity of the token', async () => {
    const aSub = subject('ident-a');
    const bSub = subject('ident-b');
    const a = expectAccount(await me(await webToken(aSub)));
    const b = expectAccount(await me(await webToken(bSub)));
    const tokenA = await webToken(aSub);
    const before = await state();

    // a query parameter naming an account is rejected outright
    for (const url of [`/account/me?accountId=${b.accountId}`, `/account/me?account_id=${b.accountId}`, `/account/me?sub=${bSub}`, '/account/me?foo=1']) {
      const r = await send('GET', url, { token: tokenA });
      expectError(r, 400, 'VALIDATION_FAILED');
      expect(r.raw).not.toContain(b.accountId);
    }
    // account identifiers in a header are ignored: the answer is always the account of the token
    for (const h of ['x-account-id', 'x-user-id', 'x-subject', 'x-forwarded-user', 'x-auth-request-user', 'x-bananagig-account']) {
      const r = await me(tokenA, { [h]: b.accountId });
      expect(expectAccount(r).accountId, h).toBe(a.accountId);
      expect(expectAccount(await me(tokenA, { [h]: bSub })).accountId, h).toBe(a.accountId);
    }
    // an account id in a body is rejected by the strict contract, and nothing of the other account changes
    for (const key of ['accountId', 'account_id', 'subject', 'sub']) {
      expectError(await send('POST', '/account/active-role', { token: tokenA, body: { role: 'CUSTOMER', [key]: b.accountId } }), 400, 'VALIDATION_FAILED');
      expectError(
        await send('PUT', '/account/profile', { token: tokenA, body: { firstName: 'Mallory', lastName: 'X', [key]: b.accountId } }),
        400,
        'VALIDATION_FAILED',
      );
    }
    expect(await state()).toEqual(before);

    // a valid profile update through A's token lands on A only
    const updated = expectAccount(await putProfile(tokenA, { firstName: 'Alice', lastName: 'Anders' }));
    expect(updated.accountId).toBe(a.accountId);
    expect(expectAccount(await me(await webToken(bSub))).profile, "another account's /me never shows the profile").toBeNull();
    expect(await q<{ account_id: string }>('SELECT account_id FROM identity.account_profiles WHERE first_name = $1', ['Alice'])).toEqual([
      { account_id: a.accountId },
    ]);
  });
});

// ====================================================================== roles and the active role
describe('account API: application roles and the active role', () => {
  async function customerWithProvider(label = 'roles') {
    const sub = subject(label);
    const token = await webToken(sub);
    const accountId = expectAccount(await me(token)).accountId as string;
    await accounts.grantRole(accountId, 'PROVIDER', SYSTEM);
    return { sub, token, accountId };
  }

  it('switches the active role without persisting anything: same account, same primary role, no audit, outbox, history or identity rows', async () => {
    const { token, accountId } = await customerWithProvider();
    expectError(await setRole(await webToken(subject('customeronly')), 'PROVIDER'), 403, 'ACCOUNT_ROLE_NOT_HELD');
    const before = await state();

    const switched = await setRole(token, 'PROVIDER');
    const data = expectAccount(switched);
    expect(data).toMatchObject({ accountId, status: 'ACTIVE', activeRole: 'PROVIDER', primaryRole: 'CUSTOMER' });
    expect(roleCodes(data)).toEqual(['CUSTOMER', 'PROVIDER']);
    expect(data.roles.map((r: { nameContentKey: string }) => r.nameContentKey).sort()).toEqual(['identity.role.customer.name', 'identity.role.provider.name']);
    // a repeated switch and a switch back are the same kind of non-event
    expect(expectAccount(await setRole(token, 'PROVIDER')).activeRole).toBe('PROVIDER');
    const back = expectAccount(await setRole(token, 'CUSTOMER'));
    expect(back).toMatchObject({ accountId, activeRole: 'CUSTOMER', primaryRole: 'CUSTOMER' });
    expect(await state(), 'role switching writes no row anywhere').toEqual(before);
    // no new Keycloak identity either: the one external identity of the account is unchanged
    expect(await q('SELECT 1 FROM identity.external_identities WHERE account_id = $1', [accountId])).toHaveLength(1);
  });

  it('validates the x-active-role header on every request: held -> that role, no header -> the primary role', async () => {
    const { token, accountId } = await customerWithProvider('header');
    const noHeader = expectAccount(await me(token));
    expect(noHeader).toMatchObject({ accountId, activeRole: 'CUSTOMER', primaryRole: 'CUSTOMER' });
    expect(roleCodes(noHeader)).toEqual(['CUSTOMER', 'PROVIDER']);
    expect(expectAccount(await me(token, withRole('PROVIDER')))).toMatchObject({ accountId, activeRole: 'PROVIDER', primaryRole: 'CUSTOMER' });
    expect(expectAccount(await me(token, withRole('CUSTOMER'))).activeRole).toBe('CUSTOMER');
    // the header never changes what is stored
    expect((await accounts.getAccountContext(accountId)).primaryRole).toBe('CUSTOMER');
    // the header name is case-insensitive on the wire, the role code is not
    expect(expectAccount(await me(token, { 'X-Active-Role': 'PROVIDER' })).activeRole).toBe('PROVIDER');
  });

  it('refuses a role the account does not hold, and a malformed role header, with 403', async () => {
    const { token } = await customerWithProvider('notheld');
    const customerOnly = await webToken(subject('notheld-c'));
    expectAccount(await me(customerOnly));
    expectError(await me(customerOnly, withRole('PROVIDER')), 403, 'ACCOUNT_ROLE_NOT_HELD');
    expectError(await me(token, withRole('ADMIN')), 403, 'ACCOUNT_ROLE_NOT_HELD');
    expectError(await setRole(customerOnly, 'PROVIDER'), 403, 'ACCOUNT_ROLE_NOT_HELD');
    expectError(await setRole(token, 'ADMIN'), 403, 'ACCOUNT_ROLE_NOT_HELD');
    const long = 'A'.repeat(300);
    for (const malformed of ['provider', 'Provider', 'CUSTOMER, PROVIDER', 'PRO VIDER', '1PROVIDER', 'PRO-VIDER', 'DROP TABLE x;', long]) {
      const r = await me(token, withRole(malformed));
      expectError(r, 403, 'ACCOUNT_ROLE_NOT_HELD');
      expect(r.raw, 'the malformed value is not echoed').not.toContain(long);
      expectError(await putProfile(token, { firstName: 'Ana', lastName: 'M' }, withRole(malformed)), 403, 'ACCOUNT_ROLE_NOT_HELD');
    }
    // the role in the BODY of the switch decides; the header of that request is ignored (it is a switch, not a read)
    expect(expectAccount(await setRole(token, 'CUSTOMER', withRole('PROVIDER'))).activeRole).toBe('CUSTOMER');
    expect(expectAccount(await setRole(token, 'PROVIDER', withRole('garbage!'))).activeRole).toBe('PROVIDER');
  });

  it('applies the header to the profile update as well and refuses it before writing anything when the role is not held', async () => {
    const { token } = await customerWithProvider('putheader');
    expect(expectAccount(await putProfile(token, { firstName: 'Pia', lastName: 'Park' }, withRole('PROVIDER'))).activeRole).toBe('PROVIDER');
    const before = await state();
    expectError(await putProfile(token, { firstName: 'Other', lastName: 'Name' }, withRole('ADMIN')), 403, 'ACCOUNT_ROLE_NOT_HELD');
    expect(await state()).toEqual(before);
  });

  it('answers 403 ACCOUNT_ROLE_NOT_ACTIVE for a role the account holds but is not active, and 200 again after it is granted back', async () => {
    const { token, accountId } = await customerWithProvider('inactive');
    await accounts.deactivateRole(accountId, 'PROVIDER', { actor: 'system:itest', reason: 'integration test' });
    expectError(await me(token, withRole('PROVIDER')), 403, 'ACCOUNT_ROLE_NOT_ACTIVE');
    expectError(await setRole(token, 'PROVIDER'), 403, 'ACCOUNT_ROLE_NOT_ACTIVE');
    const data = expectAccount(await me(token));
    expect(roleCodes(data), 'the roles list shows ACTIVE roles only').toEqual(['CUSTOMER']);
    expect(data.activeRole).toBe('CUSTOMER');
    await accounts.grantRole(accountId, 'PROVIDER', SYSTEM);
    expect(expectAccount(await me(token, withRole('PROVIDER'))).activeRole).toBe('PROVIDER');
    expect(roleCodes(expectAccount(await me(token)))).toEqual(['CUSTOMER', 'PROVIDER']);
  });

  it('moves the preferred role when the primary role is deactivated (provider first, customer added, provider removed)', async () => {
    const token = await webToken(subject('providerfirst'), ['provider']);
    const first = expectAccount(await me(token));
    expect(first).toMatchObject({ primaryRole: 'PROVIDER', activeRole: 'PROVIDER' });
    await accounts.grantRole(first.accountId, 'CUSTOMER', SYSTEM);
    expect(expectAccount(await me(token))).toMatchObject({ primaryRole: 'PROVIDER', activeRole: 'PROVIDER' });
    await accounts.deactivateRole(first.accountId, 'PROVIDER', { actor: 'system:itest' });
    expect(expectAccount(await me(token))).toMatchObject({ primaryRole: 'CUSTOMER', activeRole: 'CUSTOMER' });
  });

  it('gives an account without any role no active role, refuses every role, and uses the first role granted on the server as the default', async () => {
    const token = await webToken(subject('rolesless'), []);
    const created = expectAccount(await me(token));
    expect(created).toMatchObject({ roles: [], primaryRole: null, activeRole: null });
    expectError(await setRole(token, 'CUSTOMER'), 403, 'ACCOUNT_ROLE_NOT_HELD');
    expectError(await me(token, withRole('CUSTOMER')), 403, 'ACCOUNT_ROLE_NOT_HELD');
    await accounts.grantRole(created.accountId, 'PROVIDER', { actor: 'system:itest', source: 'SIGNUP' });
    expect(expectAccount(await me(token))).toMatchObject({
      accountId: created.accountId,
      roles: [{ code: 'PROVIDER' }],
      primaryRole: 'PROVIDER',
      activeRole: 'PROVIDER',
    });
    expect(expectAccount(await setRole(token, 'PROVIDER')).activeRole).toBe('PROVIDER');
  });

  it('has no route that grants, changes or removes a role, a primary role or a status', async () => {
    const { token, accountId } = await customerWithProvider('nogrant');
    const before = await state();
    for (const [method, url, body] of [
      ['POST', '/account/roles/provider', {}],
      ['POST', '/account/roles/PROVIDER', {}],
      ['POST', '/account/roles', { role: 'PROVIDER' }],
      ['PUT', '/account/roles', { roles: ['PROVIDER'] }],
      ['PUT', '/account/roles/provider', {}],
      ['DELETE', '/account/roles/provider', undefined],
      ['POST', '/account/primary-role', { role: 'PROVIDER' }],
      ['POST', '/account/status', { status: 'CLOSED' }],
      ['PATCH', '/account/me', { status: 'CLOSED' }],
      ['DELETE', '/account/me', undefined],
      ['POST', '/account/me', {}],
      ['PUT', '/account/me', {}],
      ['GET', `/accounts/${accountId}`, undefined],
      ['POST', '/accounts', {}],
    ] as const) {
      const r = await send(method, url, { token, body });
      expect([r.status, r.body?.error?.code], `${method} ${url}`).toEqual([404, 'ROUTE_NOT_FOUND']);
    }
    expect(await state()).toEqual(before);
    expect(roleCodes(expectAccount(await me(token)))).toEqual(['CUSTOMER', 'PROVIDER']);
  });
});

// ====================================================================== account status gates every route
describe('account API: account status', () => {
  async function account(label: string, roles = ['customer', 'provider']) {
    const sub = subject(label);
    const token = await webToken(sub, roles);
    const data = expectAccount(await me(token));
    return { sub, token, accountId: data.accountId as string };
  }
  const all = (token: string): [string, () => Promise<Res>][] => [
    ['GET /account/me', () => me(token)],
    ['POST /account/active-role', () => setRole(token, 'CUSTOMER')],
    ['PUT /account/profile', () => putProfile(token, { firstName: 'Sam', lastName: 'Suspended' })],
  ];

  it('refuses a SUSPENDED account on all three routes with 403 ACCOUNT_SUSPENDED, writes nothing, and serves it again once reactivated', async () => {
    const { token, accountId } = await account('suspend');
    expectAccount(await putProfile(token, { firstName: 'Sue', lastName: 'Before' }));
    await accounts.changeStatus(accountId, 'SUSPENDED', { actor: 'system:itest', reason: 'integration test' });
    const before = await state();
    for (const [what, run] of all(token)) {
      const r = await run();
      expectError(r, 403, 'ACCOUNT_SUSPENDED');
      expect(r.body.error.category, what).toBe('AUTHORIZATION');
      expect(r.body.error.details, what).toEqual({ status: 'SUSPENDED' });
      expect(r.raw, `${what} leaks nothing about the account`).not.toMatch(/Sue|Before|roles|PROVIDER/);
    }
    expectError(await me(token, withRole('PROVIDER')), 403, 'ACCOUNT_SUSPENDED');
    expect(await state(), 'a refused request writes nothing (the profile was not replaced)').toEqual(before);

    await accounts.changeStatus(accountId, 'ACTIVE', { actor: 'system:itest', reason: 'integration test' });
    const back = expectAccount(await me(token));
    expect(back).toMatchObject({ accountId, status: 'ACTIVE', profile: { firstName: 'Sue', lastName: 'Before' } });
    expect(roleCodes(back)).toEqual(['CUSTOMER', 'PROVIDER']);
    expect(expectAccount(await setRole(token, 'PROVIDER')).activeRole).toBe('PROVIDER');
    expect(expectAccount(await putProfile(token, { firstName: 'Sue', lastName: 'After' })).profile.lastName).toBe('After');
    // status changes are history rows and outbox events, in order
    expect((await historyOf(accountId)).map((h) => [h.from_status, h.to_status])).toEqual([
      [null, 'ACTIVE'],
      ['ACTIVE', 'SUSPENDED'],
      ['SUSPENDED', 'ACTIVE'],
    ]);
    const changes = (await outboxOf(accountId)).filter((e) => e.event_type === IDENTITY_EVENTS.accountStatusChanged).map((e) => e.payload_json);
    expect(changes).toHaveLength(2);
    expect(changes).toContainEqual({ accountId, fromStatus: 'ACTIVE', toStatus: 'SUSPENDED' });
    expect(changes).toContainEqual({ accountId, fromStatus: 'SUSPENDED', toStatus: 'ACTIVE' });
  });

  it('refuses a CLOSED account on all three routes with 403 ACCOUNT_CLOSED, never re-provisions the identity, and CLOSED stays terminal', async () => {
    const { sub, token, accountId } = await account('close');
    await accounts.changeStatus(accountId, 'SUSPENDED', { actor: 'system:itest' });
    await accounts.changeStatus(accountId, 'CLOSED', { actor: 'system:itest', reason: 'integration test' });
    const before = await state();
    for (const [what, run] of all(token)) {
      const r = await run();
      expectError(r, 403, 'ACCOUNT_CLOSED');
      expect(r.body.error.details, what).toEqual({ status: 'CLOSED' });
    }
    expectError(await me(await webToken(sub, ['customer', 'provider'])), 403, 'ACCOUNT_CLOSED'); // another token of the same subject: same answer
    expect(await state(), 'no second account was created for the closed identity').toEqual(before);
    expect(
      await q("SELECT 1 FROM identity.account_roles WHERE account_id = $1 AND status <> 'INACTIVE'", [accountId]),
      'closing deactivates every role',
    ).toHaveLength(0);
    expect((await accounts.getAccountContext(accountId, { allowUnusable: true })).primaryRole).toBeNull();
    await expect(accounts.changeStatus(accountId, 'ACTIVE', { actor: 'system:itest' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expectError(await me(token), 403, 'ACCOUNT_CLOSED');
  });

  it('keeps an account usable while closure is requested (the account page must still load) and after the request is withdrawn', async () => {
    const { token, accountId } = await account('closurereq');
    await accounts.changeStatus(accountId, 'CLOSURE_REQUESTED', { actor: 'system:itest' });
    expect(expectAccount(await me(token)).status).toBe('CLOSURE_REQUESTED');
    expect(expectAccount(await setRole(token, 'PROVIDER')).status).toBe('CLOSURE_REQUESTED');
    expect(expectAccount(await putProfile(token, { firstName: 'Cleo', lastName: 'Requested' })).status).toBe('CLOSURE_REQUESTED');
    await accounts.changeStatus(accountId, 'ACTIVE', { actor: 'system:itest' });
    expect(expectAccount(await me(token)).status).toBe('ACTIVE');
  });
});

// ====================================================================== database outage
describe('account API: database outage', () => {
  it('answers 503 ACCOUNT_UNAVAILABLE with a generic message on every route (no driver text), and recovers when the database is back', async () => {
    const token = await webToken(subject('outage'));
    const accountId = expectAccount(await me(token)).accountId as string;
    const before = await state();
    // the pool cannot hand out a connection: what a stopped or unreachable PostgreSQL looks like to the service
    const outage = Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432 password=hunter2'), { code: 'ECONNREFUSED' });
    vi.spyOn(iso.database.pool, 'connect').mockRejectedValue(outage as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined); // the service logs the outage once per request
    for (const [method, url, body] of [
      ['GET', '/account/me', undefined],
      ['POST', '/account/active-role', { role: 'CUSTOMER' }],
      ['PUT', '/account/profile', { firstName: 'Ana', lastName: 'M' }],
    ] as const) {
      const r = await send(method, url, { token, body });
      expectError(r, 503, 'ACCOUNT_UNAVAILABLE');
      expect(r.body.error.category).toBe('DEPENDENCY');
      expect(r.headers['cache-control']).toBe('no-store');
      for (const leak of ['ECONNREFUSED', 'hunter2', '10.0.0.9', '5432']) expect(r.raw, `${method} ${url}`).not.toContain(leak);
    }
    vi.restoreAllMocks();
    expect(expectAccount(await me(token)).accountId).toBe(accountId);
    expect(await state()).toEqual(before);
  });
});

// ====================================================================== the core profile
describe('account API: core profile (PUT /account/profile)', () => {
  const NAME_MAX = 50;
  const valid = { firstName: 'Ana', lastName: 'Martinez' };
  async function owner(label: string) {
    const token = await webToken(subject(label));
    const data = expectAccount(await me(token));
    return { token, accountId: data.accountId as string };
  }
  const rejected = (r: Res) => {
    expectError(r, 400, 'ACCOUNT_VALIDATION_FAILED');
    return r.body.error.details as { reason: string; issues?: { field: string; code: string; messageKey: string }[]; field?: string };
  };

  it('stores trimmed names for the owner only, returns them from /me, writes one audit row that names fields and never values, and is idempotent', async () => {
    const { token, accountId } = await owner('profile');
    const bystander = await webToken(subject('profile-b'));
    expect(expectAccount(await me(bystander)).profile).toBeNull();
    const before = await state();

    const r = await putProfile(token, { firstName: '  Ana   Maria ', lastName: ' Martinez\t' });
    const data = expectAccount(r);
    expect(data.profile).toEqual({ firstName: 'Ana Maria', lastName: 'Martinez', preferredLocale: null, timeZone: null });
    expect(expectAccount(await me(token)).profile).toEqual(data.profile);
    expect(await q('SELECT first_name, last_name, preferred_locale, time_zone_id FROM identity.account_profiles WHERE account_id = $1', [accountId])).toEqual([
      { first_name: 'Ana Maria', last_name: 'Martinez', preferred_locale: null, time_zone_id: null },
    ]);
    expect(expectAccount(await me(bystander)).profile, "another account's /me never shows it").toBeNull();
    expect(await q('SELECT 1 FROM identity.account_profiles')).toHaveLength(before.profiles.length + 1);

    const audit = (await auditOf(accountId)).filter((a) => a.action === 'PROFILE_UPDATED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: `account:${accountId}`, changes: { fields: ['firstName', 'lastName'] } });
    expect(JSON.stringify(audit)).not.toMatch(/Ana|Martinez/);
    expect((await state()).outbox, 'a profile change emits no event').toBe(before.outbox);

    // an identical repeat writes nothing (idempotent), a changed last name audits that field only
    const afterFirst = await state();
    expect(expectAccount(await putProfile(token, { firstName: 'Ana Maria', lastName: 'Martinez' })).profile).toEqual(data.profile);
    expect(await state()).toEqual(afterFirst);
    expectAccount(await putProfile(token, { firstName: 'Ana Maria', lastName: 'Lopez' }));
    const audit2 = (await auditOf(accountId)).filter((a) => a.action === 'PROFILE_UPDATED');
    expect(audit2).toHaveLength(2);
    expect(audit2[1]!.changes).toEqual({ fields: ['lastName'] });
  });

  it('accepts a preferred locale and a time zone override, replaces the profile on every PUT (omitted clears them) and refuses unknown ones', async () => {
    const { token } = await owner('profile-locale');
    const full = { ...valid, preferredLocale: 'en-US', timeZone: 'America/Los_Angeles' };
    expect(expectAccount(await putProfile(token, full)).profile).toEqual(full);
    expect(expectAccount(await me(token)).profile).toEqual(full);
    expect(expectAccount(await putProfile(token, { ...valid, preferredLocale: null, timeZone: null })).profile).toEqual({
      ...valid,
      preferredLocale: null,
      timeZone: null,
    });
    expectAccount(await putProfile(token, full));
    expect(expectAccount(await putProfile(token, valid)).profile).toEqual({ ...valid, preferredLocale: null, timeZone: null });

    const before = await state();
    expect(rejected(await putProfile(token, { ...valid, preferredLocale: 'fr-FR' }))).toMatchObject({ reason: 'UNKNOWN_LOCALE', field: 'preferredLocale' });
    expect(rejected(await putProfile(token, { ...valid, timeZone: 'Mars/Olympus_Mons' }))).toMatchObject({ reason: 'UNKNOWN_TIME_ZONE', field: 'timeZone' });
    expectError(await putProfile(token, { ...valid, preferredLocale: 'not a locale!' }), 400, 'VALIDATION_FAILED');
    expect(await state()).toEqual(before);
  });

  it('accepts real names: accents, apostrophes, hyphens, CJK, decomposed accents (stored NFC), and exactly 50 characters of any kind', async () => {
    const { token } = await owner('profile-names');
    const names: [string, string][] = [
      ['José', "O'Brien-Smith"],
      ['Anne-Marie', 'de la Cruz'],
      ['山田', '太郎'],
      [`Jose${COMBINING_ACUTE}`, 'Nunez'],
      ['A'.repeat(NAME_MAX), 'B'.repeat(NAME_MAX)],
      ['😀'.repeat(NAME_MAX), 'Ö'.repeat(NAME_MAX)],
    ];
    for (const [firstName, lastName] of names) {
      const p = expectAccount(await putProfile(token, { firstName, lastName })).profile;
      expect(p.firstName).toBe(firstName.normalize('NFC'));
      expect(p.lastName).toBe(lastName.normalize('NFC'));
    }
    expect(expectAccount(await putProfile(token, { firstName: `Jose${COMBINING_ACUTE}`, lastName: 'N' })).profile.firstName).toHaveLength(4);
  });

  it('rejects names with the standard 400, issue codes and message KEYS, and never echoes what was typed', async () => {
    const { token } = await owner('profile-bad');
    const before = await state();
    const tooLong = 'T'.repeat(NAME_MAX + 1);
    const cases: [string, unknown, string, string][] = [
      ['51 characters', { firstName: tooLong, lastName: 'Fine' }, 'TOO_LONG', 'account.error.name_too_long'],
      ['51 emoji', { firstName: 'Fine', lastName: '😀'.repeat(NAME_MAX + 1) }, 'TOO_LONG', 'account.error.name_too_long'],
      ['empty', { firstName: '', lastName: 'Fine' }, 'REQUIRED', 'account.error.name_required'],
      ['blank', { firstName: 'Fine', lastName: '   ' }, 'REQUIRED', 'account.error.name_required'],
      ['tabs and newlines only', { firstName: ' \t\n ', lastName: 'Fine' }, 'REQUIRED', 'account.error.name_required'],
      ['zero width only', { firstName: ZWSP, lastName: 'Fine' }, 'REQUIRED', 'account.error.name_required'],
      ['bidi override', { firstName: `Ana${RLO}evilname`, lastName: 'Fine' }, 'INVALID_CHARACTERS', 'account.error.name_invalid_characters'],
      ['control character', { firstName: 'Fine', lastName: `Mar${BEL}tinez` }, 'INVALID_CHARACTERS', 'account.error.name_invalid_characters'],
      ['NUL', { firstName: `Ana${NUL}x`, lastName: 'Fine' }, 'INVALID_CHARACTERS', 'account.error.name_invalid_characters'],
      ['unpaired surrogate', { firstName: `Ana${LONE_SURROGATE}`, lastName: 'Fine' }, 'INVALID_CHARACTERS', 'account.error.name_invalid_characters'],
    ];
    for (const [what, body, code, messageKey] of cases) {
      const r = await putProfile(token, body);
      const details = rejected(r);
      expect(details.reason, what).toBe('INVALID_PROFILE');
      expect(details.issues, what).toHaveLength(1);
      expect(details.issues![0], what).toEqual({ field: Object.entries(body as Record<string, string>).find(([, v]) => v !== 'Fine')![0], code, messageKey });
      for (const typed of [tooLong, `evilname`, 'tinez', RLO, BEL, NUL, ZWSP, LONE_SURROGATE])
        expect(r.raw, `${what}: the typed value is echoed`).not.toContain(typed);
    }
    // both names invalid: both issues, in field order
    const both = rejected(await putProfile(token, { firstName: '', lastName: tooLong }));
    expect(both.issues!.map((i) => [i.field, i.code, i.messageKey])).toEqual([
      ['firstName', 'REQUIRED', 'account.error.name_required'],
      ['lastName', 'TOO_LONG', 'account.error.name_too_long'],
    ]);
    expect(await state(), 'a rejected name writes nothing').toEqual(before);
    // an existing profile survives a rejected update
    expectAccount(await putProfile(token, valid));
    rejected(await putProfile(token, { firstName: tooLong, lastName: 'X' }));
    expect(expectAccount(await me(token)).profile).toMatchObject(valid);
  });

  it('answers with managed copy: every issue message key resolves through the content registry', async () => {
    for (const [key, text] of [
      ['account.error.name_required', 'Enter a name.'],
      ['account.error.name_too_long', 'This name is too long.'],
      ['account.error.name_invalid_characters', 'This name contains characters that are not allowed.'],
      ['account.error.suspended', 'This account is suspended.'],
      ['account.error.closed', 'This account is closed.'],
    ] as const)
      expect((await content.render(key, { locale: 'en-US' })).value, key).toBe(text);
  });
});

// ====================================================================== DEBT-0043: strict raw bodies
describe('account API: strict request bodies (DEBT-0043 regression for the new bodies)', () => {
  let token: string;
  let other: string;
  beforeAll(async () => {
    token = await webToken(subject('strict'), ['customer', 'provider']);
    other = expectAccount(await me(await webToken(subject('strict-other')))).accountId;
    expectAccount(await me(token));
    expectAccount(await putProfile(token, { firstName: 'Stella', lastName: 'Strict' }));
  });

  const expectValidation = (r: Res) => {
    expectError(r, 400, 'VALIDATION_FAILED');
    expect(r.body.error.category).toBe('VALIDATION');
    expect(Array.isArray(r.body.error.details.issues), r.raw).toBe(true);
    for (const issue of r.body.error.details.issues) expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
  };

  it('POST /account/active-role accepts exactly {role: <ROLE_CODE>}: integers, booleans, null, lowercase, objects, extra keys and non-object bodies are 400 and nothing changes', async () => {
    const before = await state();
    const bodies: [string, unknown][] = [
      ['integer', { role: 1 }],
      ['boolean true', { role: true }],
      ['boolean false', { role: false }],
      ['null', { role: null }],
      ['lowercase', { role: 'customer' }],
      ['mixed case', { role: 'Customer' }],
      ['numeric string', { role: '1' }],
      ['coercible string', { role: '1e3' }],
      ['array', { role: ['CUSTOMER'] }],
      ['object', { role: { code: 'CUSTOMER' } }],
      ['too long', { role: 'A'.repeat(31) }],
      ['empty string', { role: '' }],
      ['missing role', {}],
      ['extra key', { role: 'CUSTOMER', extra: 1 }],
      ['accountId', { role: 'CUSTOMER', accountId: other }],
      ['two roles', { role: 'CUSTOMER', roles: ['PROVIDER'] }],
      ['array body', []],
      ['array body with role', [{ role: 'CUSTOMER' }]],
      ['string body', 'CUSTOMER'],
      ['number body', 7],
      ['boolean body', true],
      ['null body', null],
    ];
    for (const [what, body] of bodies) {
      const r = await send('POST', '/account/active-role', { token, body });
      expectValidation(r);
      expect(r.raw, what).not.toContain(other);
    }
    expectValidation(await send('POST', '/account/active-role', { token }));
    // an empty or malformed JSON body is rejected by the parser with the same standard envelope (a different code)
    for (const rawBody of ['', '{"role": ', '{role: "CUSTOMER"}']) {
      const parserFailure = await send('POST', '/account/active-role', { token, rawBody });
      expect(parserFailure.status, parserFailure.raw).toBe(400);
      expect(ErrorResponse.safeParse(parserFailure.body).success, parserFailure.raw).toBe(true);
    }
    expect(await state()).toEqual(before);
    // the one accepted shape still works
    expect(expectAccount(await setRole(token, 'PROVIDER')).activeRole).toBe('PROVIDER');
  });

  it('PUT /account/profile accepts exactly the strict contract: wrong types, extra keys, missing names and non-object bodies are 400 and nothing is written', async () => {
    const before = await state();
    const ok = { firstName: 'Ana', lastName: 'M' };
    const bodies: [string, unknown][] = [
      ['number first name', { firstName: 1, lastName: 'M' }],
      ['number last name', { ...ok, lastName: 7 }],
      ['boolean name', { ...ok, firstName: true }],
      ['null name', { ...ok, lastName: null }],
      ['array name', { ...ok, firstName: ['Ana'] }],
      ['object name', { ...ok, firstName: { value: 'Ana' } }],
      ['number locale', { ...ok, preferredLocale: 5 }],
      ['boolean locale', { ...ok, preferredLocale: true }],
      ['object locale', { ...ok, preferredLocale: {} }],
      ['number time zone', { ...ok, timeZone: 5 }],
      ['array time zone', { ...ok, timeZone: ['America/Chicago'] }],
      ['extra key', { ...ok, nickname: 'x' }],
      ['accountId', { ...ok, accountId: other }],
      ['status', { ...ok, status: 'CLOSED' }],
      ['roles', { ...ok, roles: ['PROVIDER'] }],
      ['missing last name', { firstName: 'Ana' }],
      ['missing first name', { lastName: 'M' }],
      ['empty object', {}],
      ['very long name', { ...ok, firstName: 'A'.repeat(501) }],
      ['array body', []],
      ['string body', 'Ana M'],
      ['number body', 1],
      ['null body', null],
    ];
    for (const [what, body] of bodies) {
      const r = await send('PUT', '/account/profile', { token, body });
      expectValidation(r);
      expect(r.raw, what).not.toContain(other);
    }
    expectValidation(await send('PUT', '/account/profile', { token }));
    // the typed value is not echoed even when another field is wrong
    const leak = await send('PUT', '/account/profile', { token, body: { firstName: 'Leakyname', lastName: 5 } });
    expectValidation(leak);
    expect(leak.raw).not.toContain('Leakyname');
    expect(await state()).toEqual(before);
    expect(expectAccount(await me(token)).profile).toMatchObject({ firstName: 'Stella', lastName: 'Strict' });
  });

  it('GET /account/me takes no query: any parameter is 400', async () => {
    for (const qs of ['?accountId=1', '?role=PROVIDER', '?active_role=PROVIDER', '?a=b&c=d', '?x'])
      expectValidation(await send('GET', `/account/me${qs}`, { token }));
    expect(expectAccount(await send('GET', '/account/me', { token })).accountId).toBeDefined();
  });
});

// ====================================================================== managed copy
describe('account API: role names and status labels are managed content', () => {
  it('resolves the role name keys of /account/me and the status label keys through the real content registry (en-US, PLATFORM scope, public)', async () => {
    const data = expectAccount(await me(await webToken(subject('copy'), ['customer', 'provider'])));
    const expected: Record<string, string> = {
      'identity.role.customer.name': 'Customer',
      'identity.role.provider.name': 'Provider',
      [accountStatusLabelKey('PENDING')]: 'Pending',
      [accountStatusLabelKey('ACTIVE')]: 'Active',
      [accountStatusLabelKey('SUSPENDED')]: 'Suspended',
      [accountStatusLabelKey('CLOSURE_REQUESTED')]: 'Closure requested',
      [accountStatusLabelKey('CLOSED')]: 'Closed',
      'session.account.id': 'Account',
      'session.account.status': 'Account status',
      'session.account.roles': 'Application roles',
      'session.account.active_role': 'Active role',
      'session.account.unavailable': 'Account details are unavailable.',
    };
    expect(ACCOUNT_STATUSES.map(accountStatusLabelKey).every((k) => k in expected)).toBe(true);
    for (const role of data.roles as { nameContentKey: string }[]) expect(expected[role.nameContentKey], role.nameContentKey).toBeDefined();
    for (const [key, text] of Object.entries(expected)) expect((await content.render(key, { locale: 'en-US' })).value, key).toBe(text);
    // the same through the public HTTP resolve, the way the web app does it
    const resolved = await send('POST', '/content/resolve-many', { body: { keys: Object.keys(expected), locale: 'en-US' } });
    expect(resolved.status, resolved.raw).toBe(200);
    const items = resolved.body.data.items as { key: string; value: string }[];
    expect(Object.fromEntries(items.map((i) => [i.key, i.value]))).toEqual(expected);
  });
});

// ====================================================================== secrecy
describe('account API: no token, subject or personal value leaks', () => {
  it('keeps the subject, the token and the typed name out of every log line written while the account routes run', async () => {
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(capture);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    const sub = subject('logs');
    const token = await webToken(sub, ['customer', 'provider']);
    const firstName = 'Zyxwvutsrq';
    const lastName = 'Qponmlkjih';
    const calls: Res[] = [];
    calls.push(await me(token));
    calls.push(await me(token, withRole('PROVIDER')));
    calls.push(await setRole(token, 'PROVIDER'));
    calls.push(await setRole(token, 'ADMIN'));
    calls.push(await setRole(token, 1));
    calls.push(await putProfile(token, { firstName, lastName }));
    calls.push(await putProfile(token, { firstName, lastName: 'L'.repeat(60) }));
    calls.push(await putProfile(token, { firstName, lastName: 9 }));
    calls.push(await me(token, withRole('garbage')));
    calls.push(await me('Zyxwvutsrq.invalid.token'));
    calls.push(await send('GET', '/account/me', { token: await adminToken(subject('logs-admin')) }));
    const accountId = expectAccount(calls[0]!).accountId as string;
    await accounts.changeStatus(accountId, 'SUSPENDED', { actor: 'system:itest' });
    calls.push(await me(token));
    await accounts.changeStatus(accountId, 'ACTIVE', { actor: 'system:itest' });
    write.mockRestore();
    expect(
      lines.some((l) => l.includes('request completed')),
      'the request log lines were captured, so the assertions below are meaningful',
    ).toBe(true);
    const logged = lines.join('\n');
    for (const secret of [sub, token, firstName, lastName, 'Bearer ', ...issuedTokens.slice(-3)])
      expect(logged, `a log line contains ${secret.slice(0, 12)}`).not.toContain(secret);
    for (const r of calls) {
      expect(r.raw).not.toContain(sub);
      expect(r.raw).not.toContain(token);
    }
  });

  it('marks every response of an account route as private: Cache-Control no-store on successes and errors alike, and on nothing else', async () => {
    const t = await webToken(subject('nostore'));
    const results = [
      await me(t),
      await me(),
      await me(t, withRole('ADMIN')),
      await setRole(t, 'CUSTOMER'),
      await setRole(t, 1),
      await putProfile(t, { firstName: 'Nora', lastName: 'Store' }),
      await putProfile(t, { firstName: '', lastName: 'Store' }),
      await send('GET', '/account/me?accountId=x', { token: t }),
      await send('POST', '/account/active-role', { token: t, rawBody: '{"role":' }),
      await send('GET', '/account/me', { token: await adminToken(subject('nostore-admin')) }),
    ];
    expect(new Set(results.map((r) => r.status))).toEqual(new Set([200, 401, 403, 400]));
    for (const r of results) expect(r.headers['cache-control'], `${r.method} ${r.url} ${r.status}`).toBe('no-store');
    // the header belongs to the account routes only: public reference data stays cacheable
    expect((await send('GET', '/geography/countries')).headers['cache-control']).not.toBe('no-store');
  });

  it('never returns a token, a Keycloak subject, an issuer or a claim in any /account response (every response of this file)', async () => {
    expect(transcript.length).toBeGreaterThan(150);
    const secrets = [...issuedTokens, ...issuedSubjects, TEST_ISSUER, 'realm_access', 'resource_access', 'bananagig-api'];
    const accountResponses = transcript.filter((r) => r.raw.length > 0);
    for (const r of accountResponses) {
      const text = `${r.raw}\n${JSON.stringify(r.headers)}`;
      for (const s of secrets) if (text.includes(s)) throw new Error(`a response contains ${s.slice(0, 24)}...: ${r.raw.slice(0, 200)}`);
    }
    // every response of a matched account route, whatever its status, is private
    for (const r of accountResponses.filter((x) => x.url.startsWith('/api/v1/account/') && x.body?.error?.code !== 'ROUTE_NOT_FOUND'))
      expect(r.headers['cache-control'], `${r.method} ${r.url} ${r.status}`).toBe('no-store');
    // successful bodies hold exactly the documented keys
    for (const r of accountResponses.filter((x) => x.status === 200 && x.body?.data?.accountId)) {
      expect(Object.keys(r.body.data).sort()).toEqual(['accountId', 'activeRole', 'createdAt', 'primaryRole', 'profile', 'roles', 'status']);
      expect(Object.keys(r.body).sort()).toEqual(['data', 'meta']);
    }
  });

  it('keeps the invariants of the whole run: every account has one identity link and a creation history row, and the schema holds no subject outside the link', async () => {
    expect(
      await q('SELECT 1 FROM identity.accounts a WHERE NOT EXISTS (SELECT 1 FROM identity.external_identities e WHERE e.account_id = a.account_id)'),
    ).toHaveLength(0);
    expect(
      await q(
        `SELECT 1 FROM identity.accounts a WHERE NOT EXISTS (SELECT 1 FROM identity.account_status_history h WHERE h.account_id = a.account_id AND h.from_status IS NULL)`,
      ),
    ).toHaveLength(0);
    expect(await q('SELECT account_id FROM identity.external_identities GROUP BY account_id HAVING count(*) > 1')).toHaveLength(0);
    // no admin or other-context identity was ever linked
    const admins = issuedSubjects.filter((s) => /^itest-(admin|other|logs-admin|forged|expired|aud)-/.test(s));
    expect(admins.length).toBeGreaterThanOrEqual(6);
    for (const s of admins) expect(await accountIdOf(s), s).toBeUndefined();
    // subjects and tokens live nowhere but in external_identities.provider_subject
    for (const [table, column] of [
      ['identity.account_audit_events', 'changes'],
      ['identity.account_status_history', 'reason'],
      ['integration.outbox_events', 'payload_json'],
    ] as const)
      for (const s of issuedSubjects.slice(0, 5))
        expect(await q(`SELECT 1 FROM ${table} WHERE ${column}::text LIKE $1`, [`%${s}%`]), `${table}.${column}`).toHaveLength(0);
  });
});
