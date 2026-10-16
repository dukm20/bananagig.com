// Keycloak admin REST client for the account security layer (ID-004): what BananaGig ASKS Keycloak (credential kinds, protocol sessions) and the few things it
// asks Keycloak to DO (end sessions, email the password-reset link). Keycloak owns passwords, TOTP, recovery codes and protocol sessions (ADR-0034); this client
// reads no secret of a credential and writes no credential.
//
// The authority is a dedicated service-account client (`bananagig-security`, client credentials) that holds only the narrow realm-management roles it needs. The
// secret is a deployment secret (KEYCLOAK_SECURITY_CLIENT_SECRET). The client is fetch based, has no dependency, never retries, and reduces every failure to a
// `KeycloakAdminError` that carries a CODE (and the HTTP status): never a response body, a token, the secret, a URL or an id.
//
// Workspace boundary: @bananagig/identity imports nothing from the workspace, so the interface below is the SHAPE of `SecurityIdentityProvider`
// (packages/accounts/src/security-types.ts) declared locally; TypeScript's structural typing makes the two interchangeable. The composition root wraps this
// client so that every KeycloakAdminError becomes the accounts package's SecurityProviderUnavailableError.

/** The facts about a user's second factor and password that the security layer needs (no credential data). */
export interface KeycloakUserSecurity {
  /** A TOTP credential exists (Keycloak credential type `otp`). */
  otpConfigured: boolean;
  /** Recovery codes exist (credential type `recovery-authn-codes`). */
  recoveryCodesConfigured: boolean;
  /** When the newest password credential was created, or null. */
  passwordChangedAt: Date | null;
  /** The email Keycloak holds for the user, trimmed and lower-case, or null. */
  email: string | null;
}
export interface KeycloakProtocolSession {
  /** The protocol session id (the `sid` claim). */
  id: string;
  startedAt: Date;
  lastAccessAt: Date;
}
/** Structurally identical to `SecurityIdentityProvider` of @bananagig/accounts. */
export interface KeycloakSecurityProvider {
  readonly available: boolean;
  getUserSecurity(subject: string): Promise<KeycloakUserSecurity>;
  listSessions(subject: string): Promise<KeycloakProtocolSession[]>;
  endSession(sessionId: string): Promise<void>;
  endAllSessions(subject: string): Promise<void>;
  sendPasswordResetEmail(subject: string, options: { lifespanSeconds: number }): Promise<void>;
}

/** Why a call failed. A code is all a caller (and a log line) ever gets. */
export const KEYCLOAK_ADMIN_ERROR_CODES = [
  'INVALID_INPUT', // an id or option the client refuses to put in a request (nothing was sent)
  'UNREACHABLE', // network error / connection refused / DNS
  'TIMEOUT', // no answer within the timeout
  'TOKEN_REJECTED', // the token endpoint refused the client credentials (wrong or rotated secret, client disabled)
  'TOKEN_UNAVAILABLE', // the token endpoint failed or answered something unusable
  'UNAUTHORIZED', // 401 from the admin API (the cached token is dropped)
  'FORBIDDEN', // 403: the service account lacks a role
  'NOT_FOUND', // 404 on a user (a missing session is not an error for endSession)
  'BAD_REQUEST', // 400/409/422: Keycloak refused the request (e.g. the user has no email)
  'RATE_LIMITED', // 429
  'PROVIDER_ERROR', // 5xx (e.g. Keycloak could not send the mail)
  'UNEXPECTED_STATUS', // any other status
  'INVALID_RESPONSE', // a 2xx answer that is not the expected JSON shape
] as const;
export type KeycloakAdminErrorCode = (typeof KEYCLOAK_ADMIN_ERROR_CODES)[number];

export class KeycloakAdminError extends Error {
  constructor(
    public readonly code: KeycloakAdminErrorCode,
    public readonly status?: number,
  ) {
    super(`keycloak admin ${code}${status ? ` (${status})` : ''}`);
    this.name = 'KeycloakAdminError';
  }
}

export interface KeycloakAdminOptions {
  /** The internal Keycloak base URL (`KEYCLOAK_URL`), e.g. `http://keycloak-auth:8080`. */
  baseUrl: string;
  realm: string;
  /** The service-account client (`KEYCLOAK_SECURITY_CLIENT_ID`). */
  clientId: string;
  clientSecret: string;
  /**
   * `client_id` and `redirect_uri` sent with the reset-password email so the page that follows the reset can offer a link back to the application. Both or neither;
   * the redirect URI must be registered on that client in the realm.
   */
  resetEmail?: { clientId: string; redirectUri: string };
  /** Per-request timeout in milliseconds. Default 5000. */
  timeoutMs?: number;
  /** Injected fetch (tests). */
  fetch?: typeof fetch;
  /** Injected clock in epoch milliseconds (tests). */
  now?: () => number;
}

/** A cached token is reused until this long before it expires. */
export const TOKEN_EXPIRY_MARGIN_MS = 30_000;
export const DEFAULT_ADMIN_TIMEOUT_MS = 5_000;
const MAX_ID_LENGTH = 128;
const MAX_LIFESPAN_SECONDS = 2_147_483_647;

interface CachedToken {
  value: string;
  expiresAtMs: number;
}
interface CallOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Statuses that are success (default 200/204 handled per call). */
  ok: readonly number[];
  /** Whether a JSON body is expected and returned. */
  json: boolean;
  /** Statuses that are success but carry no result (e.g. 404 on endSession). */
  tolerate?: readonly number[];
}

export class KeycloakAdminClient implements KeycloakSecurityProvider {
  readonly available = true;
  private readonly base: string;
  private readonly realm: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly resetEmail?: { clientId: string; redirectUri: string };
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token: CachedToken | undefined;
  private refreshing: Promise<string> | undefined;

  constructor(o: KeycloakAdminOptions) {
    // configuration errors are programmer/deployment errors: plain Errors that never echo the secret
    let url: URL;
    try {
      url = new URL(o.baseUrl);
    } catch {
      throw new Error('KeycloakAdminClient: baseUrl is not a URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('KeycloakAdminClient: baseUrl must be http or https');
    if (!o.realm) throw new Error('KeycloakAdminClient: realm is required');
    if (!o.clientId) throw new Error('KeycloakAdminClient: clientId is required');
    if (!o.clientSecret) throw new Error('KeycloakAdminClient: clientSecret is required');
    if (o.resetEmail && (!o.resetEmail.clientId || !o.resetEmail.redirectUri))
      throw new Error('KeycloakAdminClient: resetEmail needs clientId and redirectUri');
    const timeout = o.timeoutMs ?? DEFAULT_ADMIN_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1) throw new Error('KeycloakAdminClient: timeoutMs must be a positive integer');
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.realm = o.realm;
    this.clientId = o.clientId;
    this.clientSecret = o.clientSecret;
    this.resetEmail = o.resetEmail;
    this.timeoutMs = timeout;
    this.fetchImpl = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  // ------------------------------------------------------------------ operations
  async getUserSecurity(subject: string): Promise<KeycloakUserSecurity> {
    const id = segment(subject);
    const [user, credentials] = await Promise.all([
      this.call({ method: 'GET', path: `users/${id}`, ok: [200], json: true }),
      this.call({ method: 'GET', path: `users/${id}/credentials`, ok: [200], json: true }),
    ]);
    if (!isRecord(user) || !Array.isArray(credentials)) throw new KeycloakAdminError('INVALID_RESPONSE');
    const email = typeof user.email === 'string' && user.email.trim() ? user.email.trim().toLowerCase() : null;
    let otp = false;
    let recovery = false;
    let passwordMs: number | null = null;
    for (const c of credentials) {
      if (!isRecord(c) || typeof c.type !== 'string') throw new KeycloakAdminError('INVALID_RESPONSE');
      if (c.type === 'otp') otp = true;
      else if (c.type === 'recovery-authn-codes') recovery = true;
      else if (c.type === 'password' && typeof c.createdDate === 'number' && Number.isFinite(c.createdDate) && c.createdDate > 0)
        passwordMs = passwordMs === null ? c.createdDate : Math.max(passwordMs, c.createdDate);
    }
    return { otpConfigured: otp, recoveryCodesConfigured: recovery, passwordChangedAt: passwordMs === null ? null : new Date(passwordMs), email };
  }

  async listSessions(subject: string): Promise<KeycloakProtocolSession[]> {
    const body = await this.call({ method: 'GET', path: `users/${segment(subject)}/sessions`, ok: [200], json: true });
    if (!Array.isArray(body)) throw new KeycloakAdminError('INVALID_RESPONSE');
    // a malformed entry fails the whole call: silently dropping one would make the caller believe that session ended
    return body.map((s): KeycloakProtocolSession => {
      if (!isRecord(s) || typeof s.id !== 'string' || !s.id || typeof s.start !== 'number' || !Number.isFinite(s.start))
        throw new KeycloakAdminError('INVALID_RESPONSE');
      const last = typeof s.lastAccess === 'number' && Number.isFinite(s.lastAccess) ? s.lastAccess : s.start;
      return { id: s.id, startedAt: new Date(s.start), lastAccessAt: new Date(last) };
    });
  }

  async endSession(sessionId: string): Promise<void> {
    // ending a session that is already gone is the desired state: 404 is success
    await this.call({ method: 'DELETE', path: `sessions/${segment(sessionId)}`, ok: [200, 204], json: false, tolerate: [404] });
  }

  async endAllSessions(subject: string): Promise<void> {
    await this.call({ method: 'POST', path: `users/${segment(subject)}/logout`, ok: [200, 204], json: false });
  }

  async sendPasswordResetEmail(subject: string, options: { lifespanSeconds: number }): Promise<void> {
    const id = segment(subject);
    const lifespan = options?.lifespanSeconds;
    if (!Number.isInteger(lifespan) || lifespan < 1 || lifespan > MAX_LIFESPAN_SECONDS) throw new KeycloakAdminError('INVALID_INPUT');
    const query: Record<string, string> = { lifespan: String(lifespan) };
    if (this.resetEmail) {
      query.client_id = this.resetEmail.clientId;
      query.redirect_uri = this.resetEmail.redirectUri;
    }
    await this.call({ method: 'PUT', path: `users/${id}/execute-actions-email`, query, body: ['UPDATE_PASSWORD'], ok: [200, 204], json: false });
  }

  // ------------------------------------------------------------------ transport
  private async call(o: CallOptions): Promise<unknown> {
    const token = await this.accessToken();
    const url = new URL(`${this.base}/admin/realms/${encodeURIComponent(this.realm)}/${o.path}`);
    for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.send(url.toString(), { method: o.method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }, async (r) => {
      if (!o.json || !o.ok.includes(r.status)) {
        await r.body?.cancel().catch(() => undefined); // never read an error body
        return undefined;
      }
      return parseJson(await r.text()); // a read error (including the timeout) propagates; only unparseable text is INVALID
    });
    if (o.ok.includes(res.status)) {
      if (!o.json) return undefined;
      if (res.value === INVALID || res.value === undefined) throw new KeycloakAdminError('INVALID_RESPONSE');
      return res.value;
    }
    if (o.tolerate?.includes(res.status)) return undefined;
    if (res.status === 401) this.token = undefined; // the token may have been revoked or the keys rotated: the next call fetches a new one
    throw new KeycloakAdminError(codeOfStatus(res.status), res.status);
  }

  /** One request with a timeout covering the connection AND the body. Network failures are reduced to UNREACHABLE / TIMEOUT. */
  private async send<T>(url: string, init: RequestInit, readBody: (r: Response) => Promise<T>): Promise<{ status: number; value: T }> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const r = await this.fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
      return { status: r.status, value: await readBody(r) };
    } catch {
      // the thrown error may embed the URL (with ids); it is dropped, not chained
      throw new KeycloakAdminError(timedOut ? 'TIMEOUT' : 'UNREACHABLE');
    } finally {
      clearTimeout(timer);
    }
  }

  /** A valid access token: cached until 30 s before expiry; concurrent callers share one in-flight request. */
  private accessToken(): Promise<string> {
    const cached = this.token;
    if (cached && this.now() < cached.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS) return Promise.resolve(cached.value);
    this.refreshing ??= this.fetchToken().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async fetchToken(): Promise<string> {
    const url = `${this.base}/realms/${encodeURIComponent(this.realm)}/protocol/openid-connect/token`;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret });
    const res = await this.send(
      url,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body },
      async (r): Promise<unknown> => {
        if (r.status === 200) return parseJson(await r.text());
        await r.body?.cancel().catch(() => undefined); // never read an error body
        return undefined;
      },
    );
    if (res.status === 400 || res.status === 401) throw new KeycloakAdminError('TOKEN_REJECTED', res.status);
    const json = res.value;
    if (res.status !== 200 || !isRecord(json) || typeof json.access_token !== 'string' || !json.access_token)
      throw new KeycloakAdminError('TOKEN_UNAVAILABLE', res.status);
    const expiresIn = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) && json.expires_in > 0 ? json.expires_in : 0;
    // a response without a usable lifetime is used once and never cached (expiresAt = now)
    this.token = { value: json.access_token, expiresAtMs: this.now() + expiresIn * 1000 };
    return json.access_token;
  }
}

const INVALID = Symbol('invalid-json');
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return INVALID;
  }
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One URL path segment from a Keycloak id: never empty, never a dot segment (which URL parsing would resolve), always percent-encoded. */
function segment(id: string): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH || id === '.' || id === '..' || hasControlCharacter(id))
    throw new KeycloakAdminError('INVALID_INPUT');
  return encodeURIComponent(id);
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function codeOfStatus(status: number): KeycloakAdminErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 400 || status === 409 || status === 422) return 'BAD_REQUEST';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'PROVIDER_ERROR';
  return 'UNEXPECTED_STATUS';
}
