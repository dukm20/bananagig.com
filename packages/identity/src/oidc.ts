// OpenID Connect helpers for the web back end: Authorization Code + PKCE (S256 only). No client secret is ever used:
// the browser client is public and the exchange happens server-side with the PKCE verifier.
import { createHash, randomBytes } from 'node:crypto';

export interface OidcEndpoints {
  issuer: string;
  /** Browser-facing (public URL). */
  authorization: string;
  endSession: string;
  /** Server-to-server (internal URL, so containers do not need to resolve the public host). */
  token: string;
  jwks: string;
}

export function oidcEndpoints(o: { publicUrl: string; internalUrl: string; realm: string }): OidcEndpoints {
  const path = `/realms/${encodeURIComponent(o.realm)}/protocol/openid-connect`;
  const pub = o.publicUrl.replace(/\/$/, '');
  const internal = o.internalUrl.replace(/\/$/, '');
  return {
    issuer: `${pub}/realms/${encodeURIComponent(o.realm)}`,
    authorization: `${pub}${path}/auth`,
    endSession: `${pub}${path}/logout`,
    token: `${internal}${path}/token`,
    jwks: `${internal}${path}/certs`,
  };
}

const b64url = (b: Buffer): string => b.toString('base64url');
/** Cryptographically random URL-safe token (state, nonce, session ids). */
export const randomToken = (bytes = 32): string => b64url(randomBytes(bytes));
/** RFC 7636: 43-128 chars of unreserved characters; 32 random bytes encode to 43. */
export const generateCodeVerifier = (): string => randomToken(32);
export const codeChallengeS256 = (verifier: string): string => b64url(createHash('sha256').update(verifier).digest());

export interface AuthorizeParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  scope?: string;
  /** Step-up: request an authentication context class, e.g. `bananagig:mfa`. */
  acrValues?: string;
}

/** Authorization request: response_type=code with PKCE method S256. There is deliberately no way to request `plain` or implicit flow. */
export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const u = new URL(p.authorizationEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', p.scope ?? 'openid');
  u.searchParams.set('state', p.state);
  u.searchParams.set('nonce', p.nonce);
  u.searchParams.set('code_challenge', p.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (p.acrValues) u.searchParams.set('acr_values', p.acrValues);
  return u.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  refreshExpiresIn: number;
}

/** Provider errors are reduced to a category; the raw Keycloak payload is never surfaced to callers or users. */
export class OidcError extends Error {
  constructor(
    public readonly category: 'invalid_grant' | 'provider_error' | 'provider_unreachable',
    public readonly status?: number,
  ) {
    super(`oidc ${category}${status ? ` (${status})` : ''}`);
    this.name = 'OidcError';
  }
}

async function tokenRequest(endpoint: string, body: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new OidcError('provider_unreachable');
  }
  const json = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!res.ok) throw new OidcError(json?.error === 'invalid_grant' ? 'invalid_grant' : 'provider_error', res.status);
  if (!json || typeof json.access_token !== 'string' || typeof json.refresh_token !== 'string') throw new OidcError('provider_error', res.status);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    idToken: typeof json.id_token === 'string' ? json.id_token : undefined,
    expiresIn: Number(json.expires_in ?? 300),
    refreshExpiresIn: Number(json.refresh_expires_in ?? 1800),
  };
}

export const exchangeAuthorizationCode = (o: {
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetch?: typeof fetch;
}): Promise<TokenSet> =>
  tokenRequest(
    o.tokenEndpoint,
    { grant_type: 'authorization_code', client_id: o.clientId, redirect_uri: o.redirectUri, code: o.code, code_verifier: o.codeVerifier },
    o.fetch ?? fetch,
  );

export const refreshTokenSet = (o: { tokenEndpoint: string; clientId: string; refreshToken: string; fetch?: typeof fetch }): Promise<TokenSet> =>
  tokenRequest(o.tokenEndpoint, { grant_type: 'refresh_token', client_id: o.clientId, refresh_token: o.refreshToken }, o.fetch ?? fetch);

export function buildLogoutUrl(o: { endSessionEndpoint: string; clientId: string; idTokenHint?: string; postLogoutRedirectUri: string }): string {
  const u = new URL(o.endSessionEndpoint);
  u.searchParams.set('client_id', o.clientId);
  u.searchParams.set('post_logout_redirect_uri', o.postLogoutRedirectUri);
  if (o.idTokenHint) u.searchParams.set('id_token_hint', o.idTokenHint);
  return u.toString();
}

/** Only same-site relative paths are allowed as post-login destinations (prevents open redirects). */
export function safeReturnTo(raw: string | null | undefined, fallback = '/'): string {
  if (!raw || raw.length > 512) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || raw.includes('\\') || [...raw].some((c) => c.charCodeAt(0) < 32))
    return fallback;
  return raw;
}
