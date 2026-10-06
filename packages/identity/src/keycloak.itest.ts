// Integration tests against a real Keycloak (pnpm dev:deps starts keycloak-auth on 127.0.0.1:18081).
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { createTokenVerifier, exchangeAuthorizationCode, oidcEndpoints, TokenValidationError } from './index';
import {
  ADMIN_REDIRECT_URI,
  authorizationCodeLogin,
  DEV_USERS,
  devAccessToken,
  directGrant,
  rawAuthorize,
  TEST_ISSUER,
  TEST_PUBLIC_URL,
  TEST_REALM,
  WEB_REDIRECT_URI,
  type KeycloakTarget,
} from './testing';

const target: KeycloakTarget = { keycloakUrl: process.env.KEYCLOAK_ITEST_URL ?? 'http://127.0.0.1:18081' };
const ep = oidcEndpoints({ publicUrl: TEST_PUBLIC_URL, internalUrl: target.keycloakUrl, realm: TEST_REALM });
const verifier = createTokenVerifier({
  issuer: ep.issuer,
  apiAudience: 'bananagig-api',
  jwks: { url: ep.jwks },
  webClientId: 'bananagig-web',
  adminClientId: 'bananagig-admin',
});
// Claims an access token may carry. Anything else (email, phone, name, preferred_username...) violates claim minimization.
const ALLOWED_ACCESS_CLAIMS = ['acr', 'aud', 'auth_time', 'azp', 'exp', 'iat', 'iss', 'jti', 'realm_access', 'resource_access', 'scope', 'sid', 'sub', 'typ'];

let adminToken: string;
const admin = async (path: string) => {
  const res = await fetch(`${target.keycloakUrl}/admin/realms/${TEST_REALM}${path}`, { headers: { authorization: `Bearer ${adminToken}` } });
  return { status: res.status, json: (await res.json().catch(() => undefined)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const codeFlow = async (clientId: string, redirectUri: string, user: keyof typeof DEV_USERS) => {
  const login = await authorizationCodeLogin(target, { clientId, redirectUri, ...DEV_USERS[user] });
  const tokens = await exchangeAuthorizationCode({ tokenEndpoint: ep.token, clientId, redirectUri, code: login.code, codeVerifier: login.verifier });
  return { login, tokens };
};

beforeAll(async () => {
  const res = await fetch(`${target.keycloakUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: process.env.KEYCLOAK_ADMIN ?? 'admin',
      password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin_dev_only',
    }),
  });
  adminToken = ((await res.json()) as { access_token: string }).access_token;
  expect(adminToken).toBeTruthy();
});

describe('realm discovery', () => {
  it('serves discovery with the pinned public issuer, S256 support and reachable JWKS', async () => {
    const d = (await (await fetch(`${target.keycloakUrl}/realms/${TEST_REALM}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    expect(d.issuer).toBe(TEST_ISSUER); // pinned even though we reached Keycloak on 127.0.0.1:18081
    expect(d.code_challenge_methods_supported).toContain('S256');
    const jwks = (await (await fetch(ep.jwks)).json()) as { keys: { kid: string; use: string }[] };
    expect(jwks.keys.some((k) => k.use === 'sig')).toBe(true);
  });
  it('has the realm settings the identity baseline requires', async () => {
    const r = (await admin('')).json;
    expect(r).toMatchObject({
      registrationAllowed: false,
      bruteForceProtected: true,
      sslRequired: 'external',
      otpPolicyType: 'totp',
      resetPasswordAllowed: false,
    });
    expect(r.passwordPolicy).toContain('length(12)');
  });
});

describe('client configuration (live)', () => {
  const get = async (clientId: string) => (await admin(`/clients?clientId=${clientId}`)).json[0];
  it('has bananagig-web, bananagig-api and bananagig-admin', async () => {
    for (const id of ['bananagig-web', 'bananagig-api', 'bananagig-admin']) expect(await get(id), id).toBeTruthy();
  });
  it('browser clients are public, code flow only, PKCE S256, exact redirect URIs, no implicit/password grant', async () => {
    for (const id of ['bananagig-web', 'bananagig-admin']) {
      const c = await get(id);
      expect(c).toMatchObject({
        publicClient: true,
        standardFlowEnabled: true,
        implicitFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
      });
      expect(c.attributes['pkce.code.challenge.method']).toBe('S256');
      expect([...c.redirectUris, ...c.webOrigins].some((u: string) => u.includes('*'))).toBe(false);
      expect((await admin(`/clients/${c.id}/client-secret`)).json?.value).toBeUndefined(); // public clients have no secret value to leak
    }
  });
  it('bananagig-api issues nothing; password grant exists only on the dev-only client', async () => {
    const api = await get('bananagig-api');
    expect(api).toMatchObject({ standardFlowEnabled: false, directAccessGrantsEnabled: false, implicitFlowEnabled: false, serviceAccountsEnabled: false });
    const all = (await admin('/clients')).json as { clientId: string; directAccessGrantsEnabled: boolean; attributes: Record<string, string> }[];
    for (const c of all.filter((x) => x.directAccessGrantsEnabled)) expect(c.attributes['bananagig.devOnly'], c.clientId).toBe('true');
  });
  it('the built-in admin-cli client (password grant) is disabled in the product realm', async () => {
    const c = await get('admin-cli');
    expect(c).toMatchObject({ enabled: false, directAccessGrantsEnabled: false });
  });
  it('the admin client is bound to its own browser flow with an OTP step', async () => {
    const c = await get('bananagig-admin');
    const flowId = c.authenticationFlowBindingOverrides.browser as string;
    expect(flowId).toBeTruthy();
    const flows = (await admin('/authentication/flows')).json as { id: string; alias: string }[];
    expect(flows.find((f) => f.id === flowId)?.alias).toBe('bananagig-admin-browser');
    const otp = (await admin('/authentication/flows/bananagig-admin-browser-otp/executions')).json as { providerId: string }[];
    expect(otp.map((e) => e.providerId)).toContain('auth-otp-form');
  });
});

describe('Authorization Code + PKCE end to end', () => {
  it('customer: web client, customer role, minimal claims, API audience', async () => {
    const { login, tokens } = await codeFlow('bananagig-web', WEB_REDIRECT_URI, 'customer');
    const principal = await verifier.verifyAccessToken(tokens.accessToken);
    expect(principal).toMatchObject({
      clientId: 'bananagig-web',
      authContext: 'web',
      realmRoles: ['customer'],
      audience: ['bananagig-api'],
      issuer: TEST_ISSUER,
    });
    expect(Object.keys(decodeJwt(tokens.accessToken)).filter((k) => !ALLOWED_ACCESS_CLAIMS.includes(k))).toEqual([]);
    expect((await verifier.verifyIdToken(tokens.idToken!, 'bananagig-web', login.nonce)).sub).toBe(principal.subject);
  });
  it('provider: provider role only', async () => {
    const { tokens } = await codeFlow('bananagig-web', WEB_REDIRECT_URI, 'provider');
    expect((await verifier.verifyAccessToken(tokens.accessToken)).realmRoles).toEqual(['provider']);
  });
  it('admin: separate client context, client role only, shorter-lived token, no customer/provider roles', async () => {
    const { tokens } = await codeFlow('bananagig-admin', ADMIN_REDIRECT_URI, 'admin');
    const p = await verifier.verifyAccessToken(tokens.accessToken);
    expect(p).toMatchObject({ clientId: 'bananagig-admin', authContext: 'admin', realmRoles: [] });
    expect([...p.clientRoles['bananagig-admin']!].sort()).toEqual([
      'admin-console-access',
      'configuration-approve',
      'configuration-read',
      'configuration-write',
    ]);
    expect(p.expiresAt - p.issuedAt).toBeLessThanOrEqual(180);
    expect(tokens.expiresIn).toBeLessThanOrEqual(180);
  });
  it('a customer cannot obtain an admin-client token with admin roles', async () => {
    const { tokens } = await codeFlow('bananagig-admin', ADMIN_REDIRECT_URI, 'customer');
    const p = await verifier.verifyAccessToken(tokens.accessToken);
    expect(p.clientRoles['bananagig-admin'] ?? []).toEqual([]);
    expect(p.realmRoles).toEqual([]);
  });
  it('rejects a wrong PKCE verifier at the token endpoint', async () => {
    const login = await authorizationCodeLogin(target, { clientId: 'bananagig-web', redirectUri: WEB_REDIRECT_URI, ...DEV_USERS.customer });
    const err = await exchangeAuthorizationCode({
      tokenEndpoint: ep.token,
      clientId: 'bananagig-web',
      redirectUri: WEB_REDIRECT_URI,
      code: login.code,
      codeVerifier: `${login.verifier}x`,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ name: 'OidcError', category: 'invalid_grant' });
  });
  it('an authorization code works once', async () => {
    const login = await authorizationCodeLogin(target, { clientId: 'bananagig-web', redirectUri: WEB_REDIRECT_URI, ...DEV_USERS.customer });
    const ex = () =>
      exchangeAuthorizationCode({
        tokenEndpoint: ep.token,
        clientId: 'bananagig-web',
        redirectUri: WEB_REDIRECT_URI,
        code: login.code,
        codeVerifier: login.verifier,
      });
    await ex();
    expect(
      await ex().then(
        () => undefined,
        (e: unknown) => e,
      ),
    ).toMatchObject({ category: 'invalid_grant' });
  });
  it('rejects wrong credentials', async () => {
    await expect(
      authorizationCodeLogin(target, {
        clientId: 'bananagig-web',
        redirectUri: WEB_REDIRECT_URI,
        username: 'customer.dev',
        password: 'wrong_dummy_password_value',
      }),
    ).rejects.toThrow(/login rejected|failed/);
  });
});

describe('protocol restrictions (security tests)', () => {
  const base = { client_id: 'bananagig-web', redirect_uri: WEB_REDIRECT_URI, response_type: 'code', scope: 'openid', state: 's1', nonce: 'n1' };
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  it('redirect URIs are exact-match: an unregistered URI is never redirected to', async () => {
    for (const bad of [
      'http://evil.example/auth/callback',
      'http://app.localhost:8080/auth/callback/extra',
      'http://app.localhost:8080/other',
      'http://app.localhost:8080/auth/callback?x=1',
    ]) {
      const r = await rawAuthorize(target, { ...base, redirect_uri: bad, code_challenge: challenge, code_challenge_method: 'S256' });
      expect(r.location ?? '', bad).not.toContain('evil.example');
      expect(r.status, bad).toBe(400); // Keycloak shows an error page instead of redirecting
    }
  });
  it('implicit flow is disabled: response_type=token never returns a token', async () => {
    const r = await rawAuthorize(target, { ...base, response_type: 'token', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(`${r.location ?? ''}${r.body}`).not.toContain('access_token=');
    expect(r.status === 400 || (r.status === 302 && /error=/.test(r.location ?? ''))).toBe(true);
    const idt = await rawAuthorize(target, { ...base, response_type: 'id_token token', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(`${idt.location ?? ''}`).not.toContain('access_token=');
  });
  it('PKCE is mandatory and S256 only: missing challenge and the plain method are refused', async () => {
    const missing = await rawAuthorize(target, base);
    expect(missing.status === 400 || /error=/.test(missing.location ?? '')).toBe(true);
    const plain = await rawAuthorize(target, { ...base, code_challenge: 'plainplainplainplainplainplainplainplainplain', code_challenge_method: 'plain' });
    expect(plain.status === 400 || /error=/.test(plain.location ?? '')).toBe(true);
  });
  it('the password grant is refused for the web and admin clients', async () => {
    for (const clientId of ['bananagig-web', 'bananagig-admin', 'bananagig-api']) {
      const r = await directGrant(target, { ...DEV_USERS.customer, clientId });
      expect([400, 401], clientId).toContain(r.status);
      expect(r.json.access_token, clientId).toBeUndefined();
    }
  });
  it('the dev/test client is the only one that can use the password grant (automation only)', async () => {
    const token = await devAccessToken(target, 'customer');
    expect((await verifier.verifyAccessToken(token)).realmRoles).toEqual(['customer']);
  });
  it('tokens are rejected by the verifier when tampered with, and cross-audience tokens are not accepted', async () => {
    const token = await devAccessToken(target, 'customer');
    const [h, p, s] = token.split('.');
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...decodeJwt(token), realm_access: { roles: ['customer', 'provider'] } })).toString('base64url')}.${s}`;
    expect(
      await verifier.verifyAccessToken(tampered).then(
        () => undefined,
        (e: unknown) => (e as TokenValidationError).category,
      ),
    ).toBe('signature');
    void p;
    const otherAudience = createTokenVerifier({ issuer: ep.issuer, apiAudience: 'some-other-api', jwks: { url: ep.jwks } });
    expect(
      await otherAudience.verifyAccessToken(token).then(
        () => undefined,
        (e: unknown) => (e as TokenValidationError).category,
      ),
    ).toBe('audience_mismatch');
  });
});

describe('logout', () => {
  it('ending the session invalidates the refresh token', async () => {
    const r = await directGrant(target, DEV_USERS.customer);
    const refresh = r.json.refresh_token as string;
    const out = await fetch(`${target.keycloakUrl}/realms/${TEST_REALM}/protocol/openid-connect/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'bananagig-dev-test', refresh_token: refresh }),
    });
    expect(out.status).toBe(204);
    const again = await fetch(ep.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'bananagig-dev-test', refresh_token: refresh }),
    });
    expect(again.status).toBe(400);
  });
});
