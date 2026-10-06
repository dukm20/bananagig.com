// Real tokens from Keycloak against the real API auth plugin (pnpm dev:deps starts keycloak-auth).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import { CORRELATION_HEADER, ErrorResponse, WhoAmIResponse } from '@bananagig/contracts';
import { createTokenVerifier, exchangeAuthorizationCode, oidcEndpoints } from '@bananagig/identity';
import {
  ADMIN_REDIRECT_URI,
  authorizationCodeLogin,
  DEV_USERS,
  devAccessToken,
  TEST_PUBLIC_URL,
  TEST_REALM,
  type KeycloakTarget,
} from '@bananagig/identity/testing';
import { buildApp } from './app';
import { requireRealmRole } from './plugins/auth';

const kc: KeycloakTarget = { keycloakUrl: process.env.KEYCLOAK_ITEST_URL ?? 'http://127.0.0.1:18081' };
let app: FastifyInstance;

beforeAll(async () => {
  const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test', KEYCLOAK_URL: kc.keycloakUrl, KEYCLOAK_PUBLIC_URL: TEST_PUBLIC_URL } });
  const verifier = createTokenVerifier({
    issuer: cfg.identity.issuer,
    apiAudience: cfg.identity.apiAudience,
    jwks: { url: cfg.identity.jwksUrl },
    webClientId: cfg.identity.webClientId,
    adminClientId: cfg.identity.adminClientId,
  });
  app = await buildApp({ cfg, verifier, readiness: async () => ({}) });
  app.get('/__guard/provider', { preHandler: requireRealmRole('provider'), schema: { hide: true } }, async () => ({ ok: true }));
  await app.ready();
});
afterAll(() => app.close());
const whoami = (token?: string) =>
  app.inject({ url: '/api/v1/system/whoami', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), [CORRELATION_HEADER]: 'corr-kc-itest-1' } });

describe('API with real Keycloak tokens', () => {
  it('accepts a valid token and returns minimal identity with the correlation id', async () => {
    const token = await devAccessToken(kc, 'customer');
    const r = await whoami(token);
    expect(r.statusCode).toBe(200);
    const body = WhoAmIResponse.parse(r.json());
    expect(body.data).toMatchObject({ clientId: 'bananagig-dev-test', audience: ['bananagig-api'], realmRoles: ['customer'], authContext: 'other' });
    expect(body.meta.correlationId).toBe('corr-kc-itest-1');
    expect(r.body).not.toContain(token);
  });
  it('identifies the admin identity context for tokens issued to the admin client', async () => {
    const login = await authorizationCodeLogin(kc, { clientId: 'bananagig-admin', redirectUri: ADMIN_REDIRECT_URI, ...DEV_USERS.admin });
    const ep = oidcEndpoints({ publicUrl: TEST_PUBLIC_URL, internalUrl: kc.keycloakUrl, realm: TEST_REALM });
    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: ep.token,
      clientId: 'bananagig-admin',
      redirectUri: ADMIN_REDIRECT_URI,
      code: login.code,
      codeVerifier: login.verifier,
    });
    const r = await whoami(tokens.accessToken);
    expect(r.json().data).toMatchObject({ authContext: 'admin', clientId: 'bananagig-admin', realmRoles: [] });
  });
  it('rejects missing and invalid tokens with the standard 401', async () => {
    for (const t of [undefined, 'garbage', `${await devAccessToken(kc, 'provider')}tampered`]) {
      const r = await whoami(t);
      expect(r.statusCode).toBe(401);
      expect(ErrorResponse.parse(r.json()).error).toMatchObject({ category: 'AUTHENTICATION', correlationId: 'corr-kc-itest-1' });
    }
  });
  it('role guards use real identity roles: provider passes, customer gets 403', async () => {
    const provider = await app.inject({ url: '/__guard/provider', headers: { authorization: `Bearer ${await devAccessToken(kc, 'provider')}` } });
    expect(provider.statusCode).toBe(200);
    const customer = await app.inject({ url: '/__guard/provider', headers: { authorization: `Bearer ${await devAccessToken(kc, 'customer')}` } });
    expect(customer.statusCode).toBe(403);
    expect(ErrorResponse.parse(customer.json()).error.category).toBe('AUTHORIZATION');
  });
  it('reports a dependency error (503), not a bad-token error, when the key set is unreachable', async () => {
    const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
    const offline = createTokenVerifier({
      issuer: cfg.identity.issuer,
      apiAudience: 'bananagig-api',
      jwks: { url: 'http://127.0.0.1:1/certs', timeoutMs: 400 },
    });
    const a = await buildApp({ cfg, verifier: offline, readiness: async () => ({}) });
    const r = await a.inject({ url: '/api/v1/system/whoami', headers: { authorization: `Bearer ${await devAccessToken(kc, 'customer')}` } });
    expect(r.statusCode).toBe(503);
    expect(ErrorResponse.parse(r.json()).error).toMatchObject({ category: 'DEPENDENCY', code: 'AUTH_PROVIDER_UNAVAILABLE' });
    await a.close();
  });
});
