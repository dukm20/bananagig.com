import type { TokenVerifier } from '@bananagig/identity';
import type { ApiClient } from '../api-client';

/** The step-up a login was started for (ID-004): the web asks Keycloak for a fresh authentication (`recent`) or one that includes a second factor (`mfa`). */
export const STEP_UP_LEVELS = ['recent', 'mfa'] as const;
export type StepUpLevel = (typeof STEP_UP_LEVELS)[number];
/** The Keycloak application-initiated action a login was started for: enrol an authenticator app or generate recovery codes. */
export const KC_ACTION_NAMES = ['totp', 'recovery'] as const;
export type KcActionName = (typeof KC_ACTION_NAMES)[number];

export interface AuthConfig {
  clientId: string;
  /** Allowed Origin for state-changing requests (logout), derived from WEB_PUBLIC_URL. */
  webOrigin: string;
  webPublicUrl: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  endpoints: { authorization: string; endSession: string; token: string };
  /** `Secure` cookies and the `__Host-` prefix apply when the public URL is https (production). */
  cookieSecure: boolean;
  sessionCookie: string;
  txCookie: string;
  /** Name of the device cookie (ID-004): `__Host-bg_device` when secure, `bg_device` otherwise. HttpOnly; its value never enters Valkey, a log line or a URL. */
  deviceCookie: string;
  /** Where Keycloak sends the browser after it ended a session the API revoked (must be listed in the realm's `post.logout.redirect.uris`). */
  revokedRedirectUri: string;
}

/** Server-side session record. Tokens live ONLY here (Valkey), never in the browser. */
export interface SessionRecord {
  subject: string;
  realmRoles: string[];
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Epoch seconds. */
  accessExpiresAt: number;
  createdAt: number;
  /**
   * The application role this session acts as (ID-001), set by the role switch after the API confirmed the account holds it. It is NOT a token and NOT
   * authority: it is sent as x-active-role and validated by the API on every request. Absent means "the account's preferred role". Switching it
   * never touches the Keycloak session or any token above.
   */
  activeRole?: string;
}

export interface AuthTransaction {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  /**
   * Set when the login was started as a step-up. It is the ONE-SHOT marker: the callback checks that the requested level was really reached and, when it was not
   * (for example Keycloak ignored `acr_values`), returns to `returnTo` with an error instead of starting another round trip. `startedAt` is epoch seconds.
   */
  stepUp?: { level: StepUpLevel; startedAt: number };
}

/** The one-shot permission to start a Keycloak credential setup (kc_action) from the next login of THIS browser session (ID-004): stored by POST /auth/security/mfa-enroll after the API accepted the request. */
export interface EnrollmentMarker {
  method: 'TOTP' | 'RECOVERY_CODES';
}

export interface SessionStore {
  putSession(id: string, record: SessionRecord, ttlSeconds: number): Promise<void>;
  /** Replaces the record of an EXISTING session and keeps its remaining lifetime. Returns false (and writes nothing) when the session no longer exists. */
  updateSession(id: string, record: SessionRecord): Promise<boolean>;
  getSession(id: string): Promise<SessionRecord | null>;
  deleteSession(id: string): Promise<void>;
  putTransaction(id: string, tx: AuthTransaction, ttlSeconds: number): Promise<void>;
  /** Atomically read and delete (a login transaction can be consumed once). */
  takeTransaction(id: string): Promise<AuthTransaction | null>;
  /** Stores the enrollment marker of a browser session (replacing an earlier one) for `ttlSeconds`. */
  putEnrollment(sessionId: string, marker: EnrollmentMarker, ttlSeconds: number): Promise<void>;
  /** Atomically read and delete the marker of a browser session (it can be used once, and only by the session it was stored for). */
  takeEnrollment(sessionId: string): Promise<EnrollmentMarker | null>;
}

export interface AuthDeps {
  cfg: AuthConfig;
  store: SessionStore;
  verifier: TokenVerifier;
  /** API client factory for calls made with the session's access token (the role switch, the email verification actions). Always provided by runtime.ts. */
  api?: (accessToken: string) => Pick<ApiClient, 'setActiveRole'> & Partial<Omit<ApiClient, 'setActiveRole'>>;
  /** API client without a token, for the public calls a signed-out visitor makes (the password-reset request). Always provided by runtime.ts. */
  publicApi?: () => Partial<ApiClient>;
  fetch?: typeof fetch;
  /** Epoch seconds (injectable for tests). */
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', message: string, attrs?: Record<string, unknown>) => void;
}
