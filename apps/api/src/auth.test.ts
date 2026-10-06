import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import { CORRELATION_HEADER, ErrorResponse, WhoAmIResponse } from '@bananagig/contracts';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, hmacToken, signToken, unsignedToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { buildApp } from './app';
import { requireAnyRole, requireAuthContext, requireClientRole, requireRealmRole } from './plugins/auth';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test', KEYCLOAK_PUBLIC_URL: 'http://auth.localhost:8080' } });
let keys: TestKeys;
let other: TestKeys;
let app: FastifyInstance;
const get = (token?: string, url = '/api/v1/system/whoami', extra: Record<string, string> = {}) =>
  app.inject({ url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } });

beforeAll(async () => {
  keys = await createTestKeys('k1');
  other = await createTestKeys('k1');
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  app = await buildApp({ cfg, verifier, readiness: async () => ({}) });
  app.get('/__guard/provider', { preHandler: requireRealmRole('provider'), schema: { hide: true } }, async () => ({ ok: true }));
  app.get('/__guard/any', { preHandler: requireAnyRole('provider', 'customer'), schema: { hide: true } }, async () => ({ ok: true }));
  app.get('/__guard/all', { preHandler: requireRealmRole('provider', 'customer'), schema: { hide: true } }, async () => ({ ok: true }));
  app.get('/__guard/admin', { preHandler: requireClientRole('bananagig-admin', 'admin-console-access'), schema: { hide: true } }, async () => ({ ok: true }));
  app.get('/__guard/admin-context', { preHandler: requireAuthContext('admin'), schema: { hide: true } }, async () => ({ ok: true }));
  await app.ready();
});
afterAll(() => app.close());

describe('whoami', () => {
  it('returns minimal identity for a valid token and preserves the correlation id', async () => {
    const token = await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } });
    const r = await get(token, undefined, { [CORRELATION_HEADER]: 'corr-auth-12345' });
    expect(r.statusCode).toBe(200);
    const body = WhoAmIResponse.parse(r.json());
    expect(body.data).toEqual({
      subject: 'test-subject-1',
      clientId: 'bananagig-web',
      audience: ['bananagig-api'],
      realmRoles: ['customer'],
      authContext: 'web',
    });
    expect(body.meta.correlationId).toBe('corr-auth-12345');
    expect(r.headers[CORRELATION_HEADER]).toBe('corr-auth-12345');
    expect(r.body).not.toContain(token); // the raw token is never echoed
  });
  it('marks the admin context', async () => {
    const r = await get(await signToken(keys, { claims: { azp: 'bananagig-admin' } }));
    expect(r.json().data.authContext).toBe('admin');
  });
});

describe('authentication failures use the standard error model', () => {
  const expect401 = async (r: Awaited<ReturnType<typeof get>>, code: string) => {
    expect(r.statusCode).toBe(401);
    const e = ErrorResponse.parse(r.json()).error;
    expect(e).toMatchObject({ category: 'AUTHENTICATION', code });
    expect(e.correlationId).toBe(r.headers[CORRELATION_HEADER]);
    expect(String(r.headers['www-authenticate'])).toContain('Bearer realm="bananagig"');
    return e;
  };
  it('missing token -> 401 AUTHENTICATION_REQUIRED', async () => {
    await expect401(await get(), 'AUTHENTICATION_REQUIRED');
  });
  it('unsigned token -> 401', async () => {
    await expect401(await get(unsignedToken()), 'INVALID_TOKEN');
  });
  it('HMAC (algorithm confusion) token -> 401', async () => {
    await expect401(await get(await hmacToken()), 'INVALID_TOKEN');
  });
  it('wrong signature -> 401', async () => {
    await expect401(await get(await signToken(other)), 'INVALID_TOKEN');
  });
  it('wrong issuer -> 401', async () => {
    await expect401(await get(await signToken(keys, { claims: { iss: 'http://evil.example/realms/bananagig' } })), 'INVALID_TOKEN');
  });
  it('wrong audience -> 401', async () => {
    await expect401(await get(await signToken(keys, { claims: { aud: 'other-api' } })), 'INVALID_TOKEN');
  });
  it('expired token -> 401', async () => {
    await expect401(await get(await signToken(keys, { expiresInSec: -300 })), 'INVALID_TOKEN');
  });
  it('an ID token used as an access token -> 401', async () => {
    await expect401(await get(await signToken(keys, { claims: { typ: 'ID' } })), 'INVALID_TOKEN');
  });
  it('malformed Authorization headers -> 401 without leaking details', async () => {
    for (const header of ['Basic abc', 'Bearer', 'Bearer a b', 'Bearer a;b']) {
      const r = await app.inject({ url: '/api/v1/system/whoami', headers: { authorization: header } });
      const e = await expect401(r, 'INVALID_TOKEN');
      expect(JSON.stringify(e)).not.toMatch(/jose|signature|JWS|keycloak/i);
    }
  });
  it('public endpoints stay public', async () => {
    expect((await get(undefined, '/api/v1/system/info')).statusCode).toBe(200);
    expect((await get(undefined, '/healthz')).statusCode).toBe(200);
  });
});

describe('authorization guards (server-side only)', () => {
  const token = (roles: string[], claims: Record<string, unknown> = {}) => signToken(keys, { claims: { realm_access: { roles }, ...claims } });
  it('role guards return standardized 403 with the correlation id', async () => {
    const r = await get(await token(['customer']), '/__guard/provider');
    expect(r.statusCode).toBe(403);
    const e = ErrorResponse.parse(r.json()).error;
    expect(e).toMatchObject({ category: 'AUTHORIZATION', code: 'INSUFFICIENT_PERMISSIONS' });
    expect(e.correlationId).toBe(r.headers[CORRELATION_HEADER]);
  });
  it('allows when the role is present; guards authenticate first (401 before 403)', async () => {
    expect((await get(await token(['provider']), '/__guard/provider')).statusCode).toBe(200);
    expect((await get(undefined, '/__guard/provider')).statusCode).toBe(401);
  });
  it('requireAnyRole needs one role, requireRealmRole needs all', async () => {
    expect((await get(await token(['customer']), '/__guard/any')).statusCode).toBe(200);
    expect((await get(await token(['other']), '/__guard/any')).statusCode).toBe(403);
    expect((await get(await token(['customer']), '/__guard/all')).statusCode).toBe(403);
    expect((await get(await token(['customer', 'provider']), '/__guard/all')).statusCode).toBe(200);
  });
  it('client roles and the admin context are separate from realm roles', async () => {
    const adminToken = await token([], { azp: 'bananagig-admin', resource_access: { 'bananagig-admin': { roles: ['admin-console-access'] } } });
    expect((await get(adminToken, '/__guard/admin')).statusCode).toBe(200);
    expect((await get(adminToken, '/__guard/admin-context')).statusCode).toBe(200);
    // a customer with realm roles only can never pass the admin guards, even with the web client
    expect((await get(await token(['customer', 'provider']), '/__guard/admin')).statusCode).toBe(403);
    expect((await get(await token(['customer']), '/__guard/admin-context')).statusCode).toBe(403);
  });
});

describe('logging', () => {
  it('never writes token material to logs, for successful or failed authentication', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const good = await signToken(keys);
    const bad = await signToken(other);
    const forged = unsignedToken();
    for (const t of [good, bad, forged]) await get(t);
    await get('garbage.token.value');
    const out = spy.mock.calls.map((c) => String(c[0])).join('\n');
    spy.mockRestore();
    for (const t of [good, bad, forged, 'garbage.token.value']) {
      expect(out).not.toContain(t);
      for (const part of t.split('.').filter((x) => x.length > 12)) expect(out).not.toContain(part); // header/payload/signature segments
    }
    expect(out).toContain('authentication failed'); // failures are logged by category only
  });
});
