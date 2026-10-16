// The interfaces of the account security layer (ID-004, docs/engineering/SESSIONS_AND_MFA.md): what the service needs from the outside (the identity provider, the
// configuration) and what it offers (SecurityOperations). The service itself is packages/accounts/src/security-service.ts.
//
// Ownership (ADR-0034, ADR-0035): Keycloak owns passwords, TOTP, recovery codes and the protocol sessions; this layer only ASKS it (through SecurityIdentityProvider)
// and never stores a credential, a token or a code. The application session registry, the device registry, the revocation watermark and the timeline are BananaGig's.
import type {
  DeviceRemovedDto,
  DeviceTrustDto,
  MfaEnrollmentDto,
  MfaMethod,
  RegisteredSessionDto,
  SecurityActivityDto,
  SecurityDevicesDto,
  SecurityOverviewDto,
  SecuritySessionsDto,
  SessionRevokedDto,
  SessionsRevokedAllDto,
  SignedOutDto,
} from '@bananagig/contracts';

// ---------------------------------------------------------------- policy (configuration, CFG-001)
export interface SecurityPolicy {
  /** `session.trusted_browser_days` (PRD CU-09.13): how long a trusted browser stays trusted. */
  trustedBrowserDays: number;
  /** `session.keep_signed_in_days` (PRD SV-01.12): the longest an identity-provider session lives; bounds the session list when the provider cannot be asked. */
  keepSignedInDays: number;
  /** `security.step_up_valid_minutes` (assumption, DEBT): how recent an authentication must be for a sensitive action. */
  stepUpValidMinutes: number;
  /** `security.activity_log_days` (assumption, DEBT): how far back the security timeline reaches (CU-09.20). */
  activityLogDays: number;
  /** `reset_link.validity_minutes` (PRD CU-03.11): lifespan of the single-use reset link Keycloak sends. */
  resetLinkValidityMinutes: number;
  /** `reset_link.max_requests_per_hour` (assumption, DEBT): password-reset requests per hour, per email address and per source address. */
  resetMaxRequestsPerHour: number;
}
export interface SecurityPolicyProvider {
  /** Reads the CURRENT policy. Throws when the configuration is unavailable (a security limit has no code default: the operation then fails closed). */
  policy(): Promise<SecurityPolicy>;
}

// ---------------------------------------------------------------- the identity provider as seen by the security layer (implemented over the Keycloak admin REST API)
/** Raised by every SecurityIdentityProvider method when the provider cannot answer or refuses. Carries no response body, token or secret. */
export class SecurityProviderUnavailableError extends Error {
  constructor(public readonly reason: string = 'UNAVAILABLE') {
    super(`the identity provider could not be asked (${reason})`);
    this.name = 'SecurityProviderUnavailableError';
  }
}
export interface IdentityUserSecurity {
  /** The user has a TOTP credential (Keycloak credential type `otp`). */
  otpConfigured: boolean;
  /** The user has recovery codes (Keycloak credential type `recovery-authn-codes`). */
  recoveryCodesConfigured: boolean;
  /** When the current password credential was created, or null (used to observe a password change or a completed reset). */
  passwordChangedAt: Date | null;
  /** The email Keycloak knows for the login, lowercase, or null. A reset link goes ONLY to this address. */
  email: string | null;
}
export interface IdentityProviderSession {
  /** The protocol session id (the `sid` claim). */
  id: string;
  startedAt: Date;
  lastAccessAt: Date;
}
export interface SecurityIdentityProvider {
  /** False for the null provider used when no admin client is configured: every method then throws SecurityProviderUnavailableError. */
  readonly available: boolean;
  /** `subject` is the Keycloak user id (the `sub` claim, `identity.external_identities.provider_subject`). */
  getUserSecurity(subject: string): Promise<IdentityUserSecurity>;
  listSessions(subject: string): Promise<IdentityProviderSession[]>;
  /** Ends ONE protocol session (its refresh token stops working at once). Ending an unknown session is not an error. */
  endSession(sessionId: string): Promise<void>;
  /** Ends every protocol session of the user. */
  endAllSessions(subject: string): Promise<void>;
  /** Asks Keycloak to email the single-use UPDATE_PASSWORD link; the link lives `lifespanSeconds`. */
  sendPasswordResetEmail(subject: string, options: { lifespanSeconds: number }): Promise<void>;
}

// ---------------------------------------------------------------- inputs
/** What the API knows about the request's session from the VERIFIED access token. */
export interface SessionObservation {
  accountId: string;
  /** The `sid` claim. */
  keycloakSessionId: string;
  /** The `auth_time` claim (epoch seconds), or undefined when the token has none. */
  authTime?: number;
}
export interface ObservedSession {
  applicationSessionId: string;
  accountDeviceId: string | null;
  /** True when this request created the session row (the first request of a login). */
  created: boolean;
}
/** The session the request came from. */
export interface CurrentSession {
  accountId: string;
  keycloakSessionId: string;
}
export interface RegisterSessionInput extends CurrentSession {
  /** The device secret issued by the web server (never stored; only a keyed hash is). */
  deviceSecret: string;
  /** The browser's user agent; reduced to coarse families and discarded. */
  userAgent?: string;
}
export interface SecurityRequestContext {
  /** The client address as resolved from the trusted proxy hops; hashed for the abuse limits, never stored. */
  clientIp?: string;
  /** The application device id of the request's session, when it has one. */
  deviceId?: string;
}
/** Facts from the verified token needed by the overview. */
export interface TokenFacts {
  authTime?: number;
  acr?: string;
}
export interface TimelineQuery {
  limit?: number;
  /** An ISO timestamp: only events strictly older than this are returned. */
  before?: string;
}

// ---------------------------------------------------------------- the operations the API calls
export interface SecurityOperations {
  /**
   * Called for every authenticated web-context request. Creates the session row on first sight (writing the SESSION_CREATED audit event and outbox event in the same
   * transaction), touches `last_seen_at` (at most once a minute) and REFUSES a revoked session. Throws AccountError('SESSION_REVOKED') for a revoked session, or for a
   * first-seen session whose `authTime` is older than the account's `sessions_not_before` (it was authenticated before a "sign out everywhere").
   */
  observeSession(input: SessionObservation): Promise<ObservedSession>;
  /** Attaches the browser (device) of this login to the session: idempotent; the first device of a session wins. */
  registerSession(input: RegisterSessionInput, ctx?: SecurityRequestContext): Promise<RegisteredSessionDto>;
  /** The account's active sessions. Reconciles with the identity provider when it is reachable (sessions gone there are marked ended). */
  listSessions(current: CurrentSession): Promise<SecuritySessionsDto>;
  /** Revokes ONE of the account's sessions (idempotent). A session of another account is a 404. */
  revokeSession(current: CurrentSession, sessionId: string): Promise<SessionRevokedDto>;
  /** Revokes all sessions (default: all except the current one) and raises the account's `sessions_not_before` watermark. */
  revokeAllSessions(current: CurrentSession, options: { includeCurrent: boolean }): Promise<SessionsRevokedAllDto>;
  /** The person signed out of THIS session (logout): revokes it with reason SIGN_OUT. Idempotent. */
  signOutCurrentSession(current: CurrentSession): Promise<SignedOutDto>;

  listDevices(current: CurrentSession): Promise<SecurityDevicesDto>;
  /** Trusts the current browser for `session.trusted_browser_days`. DEVICE_REQUIRED when the session has no device. */
  trustCurrentDevice(current: CurrentSession): Promise<DeviceTrustDto>;
  untrustCurrentDevice(current: CurrentSession): Promise<DeviceTrustDto>;
  /** Forgets a device: untrusts it, marks it removed and revokes its sessions. */
  removeDevice(current: CurrentSession, deviceId: string): Promise<DeviceRemovedDto>;
  /** Whether the session's browser is trusted right now (derived from `trusted_until`). */
  isDeviceTrusted(current: CurrentSession): Promise<boolean>;

  /** The second-factor state (asked of the identity provider; observed transitions are audited), the step-up state and the policy. */
  getOverview(current: CurrentSession, token: TokenFacts): Promise<SecurityOverviewDto>;
  /** Records that the person asked to enrol `method` and returns the Keycloak action the web server must send the browser to. */
  startMfaEnrollment(current: CurrentSession, method: MfaMethod): Promise<MfaEnrollmentDto>;
  /** True when the user has a TOTP credential, or null when the identity provider cannot be asked (the step-up guard then fails closed). */
  hasMfaEnrolled(accountId: string): Promise<boolean | null>;

  listActivity(accountId: string, query: TimelineQuery): Promise<SecurityActivityDto>;
  /** The current policy (configuration). Throws AccountError('UNAVAILABLE') when it cannot be read. */
  getPolicy(): Promise<SecurityPolicy>;

  /**
   * Public password-reset request: resolves the account of the VERIFIED primary email, rate-limits, records PASSWORD_RESET_REQUESTED and asks Keycloak to email the link.
   * Always returns normally for any well-formed input (no enumeration); only the abuse limits can refuse (PASSWORD_RESET_RATE_LIMITED).
   */
  requestPasswordReset(email: string, ctx: SecurityRequestContext): Promise<void>;
  /** Waits for the detached work started by earlier calls (the password-reset task). The composition root awaits it, with a bound, before closing the database at shutdown. */
  drain?(): Promise<void>;
}
