// JWT verification for tokens issued by Keycloak. Validates signature, algorithm, issuer, audience, expiry, not-before,
// required claims and token type. Failures are classified (never leak provider payloads) so callers can count and map them.
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export type AuthFailureCategory =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'signature'
  | 'expired'
  | 'not_yet_valid'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'wrong_token_type'
  | 'claims_invalid'
  | 'jwks_unavailable';

export class TokenValidationError extends Error {
  constructor(
    public readonly category: AuthFailureCategory,
    detail?: string,
  ) {
    super(detail ? `${category}: ${detail}` : category);
    this.name = 'TokenValidationError';
  }
}

export type AuthContext = 'web' | 'admin' | 'other';

/** The authenticated identity extracted from a verified access token. Contains no raw token material. */
export interface Principal {
  subject: string;
  issuer: string;
  audience: string[];
  /** Authorized party: the client the token was issued to (`azp`). */
  clientId: string;
  realmRoles: string[];
  clientRoles: Record<string, string[]>;
  scopes: string[];
  /** Which identity context issued this token (admin console vs normal web vs anything else). */
  authContext: AuthContext;
  acr?: string;
  sessionId?: string;
  issuedAt: number;
  expiresAt: number;
}

export interface JwksRemote {
  url: string;
  cacheMaxAgeMs?: number;
  cooldownMs?: number;
  timeoutMs?: number;
}

export interface VerifierOptions {
  /** Exact issuer (the PUBLIC realm URL; Keycloak pins it regardless of the host used to reach it). */
  issuer: string;
  /** Audience required in API access tokens (the API resource-server client id). */
  apiAudience: string;
  /** Remote JWKS (cached, cooldown-limited refetch on unknown kid) or an injected key resolver (tests). */
  jwks: JWKSource;
  webClientId?: string;
  adminClientId?: string;
  clockToleranceSec?: number;
  /** Asymmetric only. `none` and HMAC algorithms are never accepted. */
  algorithms?: string[];
}
export type JWKSource = JwksRemote | JWTVerifyGetKey;

const DEFAULT_ALGS = ['RS256', 'ES256'];

function classify(err: unknown): TokenValidationError {
  if (err instanceof TokenValidationError) return err;
  if (err instanceof joseErrors.JWTExpired) return new TokenValidationError('expired');
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'iss') return new TokenValidationError('issuer_mismatch');
    if (err.claim === 'aud') return new TokenValidationError('audience_mismatch');
    if (err.claim === 'nbf') return new TokenValidationError('not_yet_valid');
    return new TokenValidationError('claims_invalid', err.claim);
  }
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return new TokenValidationError('unsupported_algorithm');
  if (
    err instanceof joseErrors.JWSSignatureVerificationFailed ||
    err instanceof joseErrors.JWKSNoMatchingKey ||
    err instanceof joseErrors.JWKSMultipleMatchingKeys
  )
    return new TokenValidationError('signature');
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid || err instanceof joseErrors.JOSENotSupported)
    return new TokenValidationError('malformed');
  // Anything else while resolving keys (timeout, network error, bad JWKS response) means we could not validate at all.
  return new TokenValidationError('jwks_unavailable');
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export class TokenVerifier {
  private readonly keys: JWTVerifyGetKey;
  private readonly algs: string[];

  constructor(private readonly opts: VerifierOptions) {
    this.algs = opts.algorithms ?? DEFAULT_ALGS;
    if (this.algs.some((a) => a === 'none' || a.startsWith('HS'))) throw new Error('symmetric/none algorithms are not allowed');
    const j = opts.jwks;
    this.keys =
      typeof j === 'function'
        ? j
        : createRemoteJWKSet(new URL(j.url), {
            cacheMaxAge: j.cacheMaxAgeMs ?? 10 * 60_000,
            cooldownDuration: j.cooldownMs ?? 30_000,
            timeoutDuration: j.timeoutMs ?? 5_000,
          });
  }

  private async verifyRaw(token: string, audience: string, type: 'Bearer' | 'ID'): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.opts.issuer,
        audience,
        algorithms: this.algs,
        clockTolerance: this.opts.clockToleranceSec ?? 5,
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      if (payload.typ !== type) throw new TokenValidationError('wrong_token_type', `expected ${type}`);
      if (typeof payload.sub !== 'string' || !payload.sub) throw new TokenValidationError('claims_invalid', 'sub');
      return payload;
    } catch (err) {
      throw classify(err);
    }
  }

  /** Verifies an API access token (typ Bearer, aud includes the API audience) and returns the principal. */
  async verifyAccessToken(token: string): Promise<Principal> {
    const p = await this.verifyRaw(token, this.opts.apiAudience, 'Bearer');
    if (typeof p.azp !== 'string' || !p.azp) throw new TokenValidationError('claims_invalid', 'azp');
    const realmAccess = (p.realm_access ?? {}) as { roles?: unknown };
    const resourceAccess = (p.resource_access ?? {}) as Record<string, { roles?: unknown }>;
    const clientRoles: Record<string, string[]> = {};
    for (const [client, v] of Object.entries(resourceAccess)) clientRoles[client] = asStrings(v?.roles);
    const authContext: AuthContext = p.azp === this.opts.adminClientId ? 'admin' : p.azp === this.opts.webClientId ? 'web' : 'other';
    return {
      subject: p.sub as string,
      issuer: p.iss as string,
      audience: Array.isArray(p.aud) ? p.aud : p.aud ? [p.aud] : [],
      clientId: p.azp,
      realmRoles: asStrings(realmAccess.roles),
      clientRoles,
      scopes: typeof p.scope === 'string' && p.scope ? p.scope.split(' ') : [],
      authContext,
      acr: typeof p.acr === 'string' ? p.acr : undefined,
      sessionId: typeof p.sid === 'string' ? p.sid : undefined,
      issuedAt: p.iat as number,
      expiresAt: p.exp as number,
    };
  }

  /** Verifies an OIDC ID token for the given client and checks the nonce. Used by the web login callback. */
  async verifyIdToken(token: string, clientId: string, expectedNonce: string): Promise<JWTPayload> {
    const p = await this.verifyRaw(token, clientId, 'ID');
    if (p.nonce !== expectedNonce) throw new TokenValidationError('claims_invalid', 'nonce');
    return p;
  }
}

export const createTokenVerifier = (opts: VerifierOptions): TokenVerifier => new TokenVerifier(opts);

/** Extracts the token from an Authorization header value. Returns undefined for anything that is not exactly `Bearer <token>`. */
export function bearerFromHeader(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const m = header.match(/^Bearer ([A-Za-z0-9._~+/-]+=*)$/i);
  return m?.[1];
}
