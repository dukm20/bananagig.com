// DEV / TEST ONLY. Helpers for obtaining and forging tokens in tests and the smoke check.
// Never import from production code (ESLint enforces this). Nothing here is used by api, web or worker at runtime.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from 'jose';
import { buildAuthorizeUrl, codeChallengeS256, generateCodeVerifier, oidcEndpoints, randomToken } from './oidc';

export const TEST_REALM = 'bananagig';
export const TEST_PUBLIC_URL = 'http://auth.localhost:8080';
export const TEST_ISSUER = `${TEST_PUBLIC_URL}/realms/${TEST_REALM}`;
export const DEV_TEST_CLIENT = 'bananagig-dev-test';
export const WEB_REDIRECT_URI = 'http://app.localhost:8080/auth/callback';
export const ADMIN_REDIRECT_URI = 'http://admin.localhost:8080/auth/callback';

/** DEV-ONLY identities from infra/keycloak/bananagig-realm.json. They do not exist in production realm builds. */
export const DEV_USERS = {
  customer: { username: 'customer.dev', password: 'dev_only_customer_password' },
  provider: { username: 'provider.dev', password: 'dev_only_provider_password' },
  admin: { username: 'admin.dev', password: 'dev_only_admin_password' },
  /** A second administrator (same roles) so tests can exercise the second-approver rule. */
  admin2: { username: 'admin2.dev', password: 'dev_only_admin2_password' },
} as const;

// ---------------------------------------------------------------- forged tokens (unit tests, no Keycloak needed)
export interface TestKeys {
  kid: string;
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  jwk: JWK;
  getKey: JWTVerifyGetKey;
}
export async function createTestKeys(kid = 'test-key-1'): Promise<TestKeys> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey, jwk, getKey: createLocalJWKSet({ keys: [jwk] }) };
}

export interface SignOptions {
  claims?: Record<string, unknown>;
  /** Claim names to drop entirely. */
  omit?: string[];
  /** Seconds relative to now. */
  expiresInSec?: number;
  notBeforeInSec?: number;
}
function baseClaims(): Record<string, unknown> {
  return {
    iss: TEST_ISSUER,
    aud: 'bananagig-api',
    sub: 'test-subject-1',
    typ: 'Bearer',
    azp: 'bananagig-web',
    sid: 'test-session-1',
    acr: 'bananagig:password',
    realm_access: { roles: ['customer'] },
    scope: '',
  };
}
export async function signToken(keys: TestKeys, o: SignOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { ...baseClaims(), ...o.claims };
  for (const k of o.omit ?? []) delete claims[k];
  const jwt = new SignJWT(claims as Record<string, never>).setProtectedHeader({ alg: 'RS256', kid: keys.kid, typ: 'JWT' });
  if (!(o.omit ?? []).includes('iat')) jwt.setIssuedAt(now);
  if (!(o.omit ?? []).includes('exp')) jwt.setExpirationTime(now + (o.expiresInSec ?? 300));
  if (o.notBeforeInSec !== undefined) jwt.setNotBefore(now + o.notBeforeInSec);
  return jwt.sign(keys.privateKey);
}
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
/** `alg: none` token with a plausible payload. Must always be rejected. */
export function unsignedToken(claims: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...baseClaims(), iat: now, exp: now + 300, ...claims })}.`;
}
/** HS256 token signed with an attacker-chosen secret (algorithm-confusion attempt). Must always be rejected. */
export async function hmacToken(secret = 'attacker-chosen-secret-attacker-chosen-secret'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...baseClaims() } as Record<string, never>)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(secret));
}

// ---------------------------------------------------------------- real Keycloak (integration tests, smoke)
export interface KeycloakTarget {
  /** Where to connect (reachable from the caller: 127.0.0.1:18081 on the host, keycloak-auth:8080 in the Compose network). */
  keycloakUrl: string;
  publicUrl?: string;
  realm?: string;
  fetch?: typeof fetch;
}
const f = (t: KeycloakTarget): typeof fetch => t.fetch ?? fetch;
const rewrite = (url: string, t: KeycloakTarget): string => url.replace((t.publicUrl ?? TEST_PUBLIC_URL).replace(/\/$/, ''), t.keycloakUrl.replace(/\/$/, ''));

/** Password-grant access token via the DEV/TEST-ONLY client. The production realm build has no such client. */
export async function directGrant(
  t: KeycloakTarget,
  o: { username: string; password: string; clientId?: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const ep = oidcEndpoints({ publicUrl: t.publicUrl ?? TEST_PUBLIC_URL, internalUrl: t.keycloakUrl, realm: t.realm ?? TEST_REALM });
  const res = await f(t)(ep.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: o.clientId ?? DEV_TEST_CLIENT, username: o.username, password: o.password }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
export async function devAccessToken(t: KeycloakTarget, user: keyof typeof DEV_USERS = 'customer'): Promise<string> {
  const r = await directGrant(t, DEV_USERS[user]);
  if (r.status !== 200 || typeof r.json.access_token !== 'string') throw new Error(`dev token request failed (${r.status})`);
  return r.json.access_token;
}

class Jar {
  private c = new Map<string, string>();
  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      if (!value || /max-age=0/i.test(line)) this.c.delete(name);
      else this.c.set(name, value);
    }
  }
  header(): string {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}
const decodeHtml = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#x3d;/gi, '=')
    .replace(/&#61;/g, '=');

/** Raw authorization request (manual redirect handling) for negative tests: invalid redirect, implicit flow, plain PKCE. */
export async function rawAuthorize(t: KeycloakTarget, params: Record<string, string>): Promise<{ status: number; location?: string; body: string }> {
  const ep = oidcEndpoints({ publicUrl: t.publicUrl ?? TEST_PUBLIC_URL, internalUrl: t.keycloakUrl, realm: t.realm ?? TEST_REALM });
  const url = new URL(rewrite(ep.authorization, t));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await f(t)(url, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location') ?? undefined, body: await res.text() };
}

export interface CodeLogin {
  code: string;
  state: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
}

/**
 * Completes the Keycloak login form for an authorization URL (any client, any flow start) and returns the final redirect
 * Location (the callback URL carrying code and state). Cookies set by Keycloak are kept in a local jar. The redirect target is
 * never fetched.
 */
export async function completeLogin(t: KeycloakTarget, authorizeUrl: string, o: { redirectUri: string; username: string; password: string }): Promise<string> {
  let url = rewrite(authorizeUrl, t);
  const jar = new Jar();
  for (let hop = 0; hop < 6; hop++) {
    const res = await f(t)(url, { redirect: 'manual', headers: { cookie: jar.header() } });
    jar.absorb(res);
    const loc = res.headers.get('location');
    if (loc) {
      if (loc.startsWith(o.redirectUri)) return loc;
      url = rewrite(new URL(loc, url).toString(), t);
      continue;
    }
    if (res.status !== 200) throw new Error(`authorization request failed (${res.status})`);
    const html = await res.text();
    const action = html.match(/<form[^>]*\baction="([^"]+)"/i)?.[1];
    if (!action) throw new Error('login form not found');
    const post = await f(t)(rewrite(decodeHtml(action), t), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
      body: new URLSearchParams({ username: o.username, password: o.password, credentialId: '' }),
    });
    jar.absorb(post);
    const next = post.headers.get('location');
    if (!next) throw new Error(`login rejected (${post.status}): invalid credentials or required action`);
    if (next.startsWith(o.redirectUri)) return next;
    url = rewrite(new URL(next, url).toString(), t);
  }
  throw new Error('too many redirects');
}

/**
 * Production-shaped browser login without a browser: Authorization Code + PKCE (S256), state and nonce, credentials posted to
 * the Keycloak login form. Returns the authorization code captured from the redirect.
 */
export async function authorizationCodeLogin(
  t: KeycloakTarget,
  o: { clientId: string; redirectUri: string; username: string; password: string; acrValues?: string },
): Promise<CodeLogin> {
  const ep = oidcEndpoints({ publicUrl: t.publicUrl ?? TEST_PUBLIC_URL, internalUrl: t.keycloakUrl, realm: t.realm ?? TEST_REALM });
  const verifier = generateCodeVerifier();
  const state = randomToken(16);
  const nonce = randomToken(16);
  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: ep.authorization,
    clientId: o.clientId,
    redirectUri: o.redirectUri,
    state,
    nonce,
    codeChallenge: codeChallengeS256(verifier),
    acrValues: o.acrValues,
  });
  return parseRedirect(await completeLogin(t, authorizeUrl, o), state, verifier, nonce, o.redirectUri);
}
function parseRedirect(location: string, state: string, verifier: string, nonce: string, redirectUri: string): CodeLogin {
  const u = new URL(location);
  const code = u.searchParams.get('code');
  if (!code) throw new Error(`no code in redirect: ${u.searchParams.get('error') ?? 'unknown error'}`);
  if (u.searchParams.get('state') !== state) throw new Error('state mismatch in redirect');
  return { code, state, verifier, nonce, redirectUri };
}
