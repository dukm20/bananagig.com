// Public contracts of the account security layer (ID-004, docs/engineering/SESSIONS_AND_MFA.md): application sessions, devices and the trusted browser, MFA status,
// step-up, the security activity timeline, password-reset requests, the identity security events and the error codes.
//
// Ownership (ADR-0034, ADR-0035): Keycloak owns passwords, TOTP, recovery codes and the protocol sessions. BananaGig owns the application session registry, the
// device registry (with the trusted-browser window), the revocation state and the timeline (a read model over the immutable audit log). Nothing here carries a
// token, a Keycloak credential, a TOTP secret, a recovery code or a reset link, and no read model returns a raw IP address or a raw user agent.
import { z } from 'zod';
import { envelope } from './envelope';

// ---------------------------------------------------------------- authentication context (claims of the VERIFIED access token)
/** The `acr` values the realm maps to levels of authentication (`acr.loa.map` in infra/keycloak/bananagig-realm.json). */
export const ACR_PASSWORD = 'bananagig:password';
export const ACR_MFA = 'bananagig:mfa';
/** True when the verified `acr` claim says the login (or the last step-up) included a second factor. */
export const isMfaAcr = (acr: string | undefined): boolean => acr === ACR_MFA;

/** What a step-up guard asks of the caller. */
export const STEP_UP_REQUIREMENTS = ['RECENT_AUTHENTICATION', 'MFA'] as const;
export type StepUpRequirement = (typeof STEP_UP_REQUIREMENTS)[number];
/** The `details` of a 401 STEP_UP_REQUIRED (RFC 9470 shape): what the client must ask the identity provider for, and how fresh the result must be. */
export const StepUpDetails = z.object({
  requirement: z.enum(STEP_UP_REQUIREMENTS),
  /** Maximum age, in seconds, of the authentication the API will accept (the `max_age` to request). */
  maxAgeSeconds: z.number().int().positive(),
  /** The `acr_values` to request, present when the requirement is MFA. */
  acrValues: z.string().optional(),
});
export type StepUpDetails = z.infer<typeof StepUpDetails>;

/** Errors raised by the guards in front of the account routes (HTTP 401/403; NOT prefixed with ACCOUNT_). */
export const AUTH_SECURITY_ERROR_CODES = ['SESSION_REVOKED', 'STEP_UP_REQUIRED', 'MFA_ENROLLMENT_REQUIRED'] as const;
export type AuthSecurityErrorCode = (typeof AUTH_SECURITY_ERROR_CODES)[number];

// ---------------------------------------------------------------- vocabularies
export const SESSION_REVOCATION_REASONS = [
  'SIGN_OUT',
  'REVOKED_BY_USER',
  'SIGN_OUT_EVERYWHERE',
  'KEYCLOAK_ENDED',
  'DEVICE_REMOVED',
  'PASSWORD_CHANGED',
] as const;
export const SessionRevocationReason = z.enum(SESSION_REVOCATION_REASONS);
export type SessionRevocationReason = z.infer<typeof SessionRevocationReason>;
/** ACTIVE: not revoked. ENDED: the person signed out or Keycloak ended it. REVOKED: revoked from another session, by removing its device or by a password change. Derived, never stored. */
export const SESSION_STATUSES = ['ACTIVE', 'ENDED', 'REVOKED'] as const;
export const SessionStatus = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatus>;
export const sessionStatusOf = (revocationReason: SessionRevocationReason | null): SessionStatus =>
  revocationReason === null ? 'ACTIVE' : revocationReason === 'SIGN_OUT' || revocationReason === 'KEYCLOAK_ENDED' ? 'ENDED' : 'REVOKED';

/** Coarse, closed vocabularies derived from the user agent. The raw user agent is never stored. */
export const BROWSER_FAMILIES = ['CHROME', 'FIREFOX', 'SAFARI', 'EDGE', 'OPERA', 'OTHER'] as const;
export const BrowserFamily = z.enum(BROWSER_FAMILIES);
export type BrowserFamily = z.infer<typeof BrowserFamily>;
export const OS_FAMILIES = ['WINDOWS', 'MACOS', 'LINUX', 'IOS', 'ANDROID', 'OTHER'] as const;
export const OsFamily = z.enum(OS_FAMILIES);
export type OsFamily = z.infer<typeof OsFamily>;
export const DEVICE_CLASSES = ['DESKTOP', 'MOBILE', 'TABLET', 'OTHER'] as const;
export const DeviceClass = z.enum(DEVICE_CLASSES);
export type DeviceClass = z.infer<typeof DeviceClass>;
export const DeviceSummaryDto = z.object({ browser: BrowserFamily, os: OsFamily, deviceClass: DeviceClass });
export type DeviceSummaryDto = z.infer<typeof DeviceSummaryDto>;
/** Content keys of the coarse labels (managed copy). */
export const browserLabelKey = (b: BrowserFamily): string => `account.security.browser.${b.toLowerCase()}`;
export const osLabelKey = (o: OsFamily): string => `account.security.os.${o.toLowerCase()}`;
export const deviceClassLabelKey = (d: DeviceClass): string => `account.security.device_class.${d.toLowerCase()}`;

/** The second-factor methods BananaGig can start enrolling through Keycloak (Keycloak keeps the credential; BananaGig stores no secret and no code). */
export const MFA_METHODS = ['TOTP', 'RECOVERY_CODES'] as const;
export const MfaMethod = z.enum(MFA_METHODS);
export type MfaMethod = z.infer<typeof MfaMethod>;
/** The Keycloak application-initiated action (`kc_action`) that enrols each method. */
export const KEYCLOAK_ACTION_OF_METHOD: Record<MfaMethod, string> = { TOTP: 'CONFIGURE_TOTP', RECOVERY_CODES: 'CONFIGURE_RECOVERY_AUTHN_CODES' };

// ---------------------------------------------------------------- the security timeline (a read model over identity.account_audit_events)
/** Audit actions written by the security layer (the action list of the audit table, widened by migration 0012). */
export const SECURITY_AUDIT_ACTIONS = [
  'SESSION_CREATED',
  'SESSION_ENDED',
  'SESSION_REVOKED',
  'SESSIONS_REVOKED_ALL',
  'DEVICE_TRUSTED',
  'DEVICE_UNTRUSTED',
  'DEVICE_REMOVED',
  'MFA_ENROLLMENT_REQUESTED',
  'MFA_ENABLED',
  'MFA_DISABLED',
  'RECOVERY_CODES_REQUESTED',
  'RECOVERY_CODES_ENABLED',
  'RECOVERY_CODES_DISABLED',
  'PASSWORD_RESET_REQUESTED',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET_COMPLETED',
] as const;
export type SecurityAuditAction = (typeof SECURITY_AUDIT_ACTIONS)[number];
/** Contact audit actions (ID-002, ID-003) the owner also sees on the timeline ("contact changes", CU-09.20). They are read, never copied. */
export const SECURITY_TIMELINE_CONTACT_ACTIONS = ['EMAIL_VERIFIED', 'EMAIL_PRIMARY_CHANGED', 'PHONE_VERIFIED', 'PHONE_PRIMARY_CHANGED'] as const;
/** Every type the timeline can show. Audit actions that are not listed here (for example wrong verification codes) are not part of the timeline. */
export const SECURITY_ACTIVITY_TYPES = [...SECURITY_AUDIT_ACTIONS, ...SECURITY_TIMELINE_CONTACT_ACTIONS] as const;
export const SecurityActivityType = z.enum(SECURITY_ACTIVITY_TYPES);
export type SecurityActivityType = z.infer<typeof SecurityActivityType>;
export const securityActivityLabelKey = (t: SecurityActivityType): string => `account.security.activity.${t.toLowerCase()}`;

// ---------------------------------------------------------------- policy (configuration, CFG-001) as exposed to the owner
export const SecurityPolicyDto = z.object({
  /** `session.trusted_browser_days`. */
  trustedBrowserDays: z.number().int(),
  /** `security.step_up_valid_minutes`. */
  stepUpValidMinutes: z.number().int(),
  /** `security.activity_log_days`: how far back the timeline reaches. */
  activityLogDays: z.number().int(),
});
export type SecurityPolicyDto = z.infer<typeof SecurityPolicyDto>;

// ---------------------------------------------------------------- read models (owner only)
export const SecuritySessionDto = z.object({
  /** The application session id (an opaque uuid; the handle of the revoke operation). Never the Keycloak session id. */
  sessionId: z.string(),
  current: z.boolean(),
  status: SessionStatus,
  device: DeviceSummaryDto.nullable(),
  deviceId: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  /** Whether the browser of this session is currently trusted, and until when. */
  trusted: z.boolean(),
  trustedUntil: z.string().nullable(),
});
export type SecuritySessionDto = z.infer<typeof SecuritySessionDto>;
export const SecuritySessionsDto = z.object({
  sessions: z.array(SecuritySessionDto),
  /** True when the list was compared with the identity provider's own sessions; false when it was unavailable (the list is then bounded by `session.keep_signed_in_days` only). */
  reconciled: z.boolean(),
});
export type SecuritySessionsDto = z.infer<typeof SecuritySessionsDto>;
export const SecuritySessionsResponse = envelope(SecuritySessionsDto);

export const SecurityDeviceDto = z.object({
  deviceId: z.string(),
  current: z.boolean(),
  device: DeviceSummaryDto,
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  trusted: z.boolean(),
  trustedUntil: z.string().nullable(),
});
export type SecurityDeviceDto = z.infer<typeof SecurityDeviceDto>;
export const SecurityDevicesDto = z.object({ devices: z.array(SecurityDeviceDto) });
export type SecurityDevicesDto = z.infer<typeof SecurityDevicesDto>;
export const SecurityDevicesResponse = envelope(SecurityDevicesDto);

export const SecurityActivityEntryDto = z.object({
  /** The audit event id (opaque). */
  id: z.string(),
  type: SecurityActivityType,
  occurredAt: z.string(),
  outcome: z.enum(['SUCCESS', 'FAILURE']),
  labelContentKey: z.string(),
  /** The application session the event concerns, when it concerns one. */
  sessionId: z.string().nullable(),
  /** The coarse device of that session, when known. */
  device: DeviceSummaryDto.nullable(),
});
export type SecurityActivityEntryDto = z.infer<typeof SecurityActivityEntryDto>;
export const SecurityActivityDto = z.object({
  entries: z.array(SecurityActivityEntryDto),
  /** Pass as `before` to read the next (older) page; null at the end. */
  nextBefore: z.string().nullable(),
});
export type SecurityActivityDto = z.infer<typeof SecurityActivityDto>;
export const SecurityActivityResponse = envelope(SecurityActivityDto);
export const SECURITY_ACTIVITY_MAX_LIMIT = 100;
export const SECURITY_ACTIVITY_DEFAULT_LIMIT = 25;

/** `GET /account/security`: the second-factor state, the step-up state and the current session. */
export const SecurityOverviewDto = z.object({
  mfa: z.object({
    /** False when the identity provider could not be asked: the flags below are then false and mean "unknown". */
    available: z.boolean(),
    totpConfigured: z.boolean(),
    recoveryCodesConfigured: z.boolean(),
  }),
  stepUp: z.object({
    /** `auth_time` of the verified access token, or null. */
    authenticatedAt: z.string().nullable(),
    /** The verified `acr` says a second factor was part of that authentication. */
    mfaSatisfied: z.boolean(),
    /** Until when that authentication counts as recent for a sensitive action, or null when it no longer does. */
    recentUntil: z.string().nullable(),
  }),
  currentSession: z.object({
    sessionId: z.string(),
    deviceId: z.string().nullable(),
    deviceTrusted: z.boolean(),
    trustedUntil: z.string().nullable(),
  }),
  policy: SecurityPolicyDto,
});
export type SecurityOverviewDto = z.infer<typeof SecurityOverviewDto>;
export const SecurityOverviewResponse = envelope(SecurityOverviewDto);

// ---------------------------------------------------------------- operation results
/** The result of `POST /account/security/sessions/current`: the web server tells the API which browser this login came from. */
export const RegisteredSessionDto = z.object({
  sessionId: z.string(),
  deviceId: z.string().nullable(),
  deviceTrusted: z.boolean(),
  trustedUntil: z.string().nullable(),
});
export type RegisteredSessionDto = z.infer<typeof RegisteredSessionDto>;
export const RegisteredSessionResponse = envelope(RegisteredSessionDto);

/** `ENDED`: the identity provider session(s) were ended. `UNAVAILABLE`: it could not be reached (the application revocation holds anyway; the Keycloak session ends when it expires or the browser signs out). */
export const KEYCLOAK_PROPAGATION_OUTCOMES = ['ENDED', 'UNAVAILABLE', 'NOT_NEEDED'] as const;
export type KeycloakPropagationOutcome = (typeof KEYCLOAK_PROPAGATION_OUTCOMES)[number];
export const SessionRevokedDto = z.object({
  sessionId: z.string(),
  /** False when it was already revoked (idempotent). */
  changed: z.boolean(),
  /** The revoked session is the one this request came from. */
  current: z.boolean(),
  keycloak: z.enum(KEYCLOAK_PROPAGATION_OUTCOMES),
});
export type SessionRevokedDto = z.infer<typeof SessionRevokedDto>;
export const SessionRevokedResponse = envelope(SessionRevokedDto);
export const SessionsRevokedAllDto = z.object({
  revokedCount: z.number().int(),
  keycloak: z.enum(KEYCLOAK_PROPAGATION_OUTCOMES),
});
export type SessionsRevokedAllDto = z.infer<typeof SessionsRevokedAllDto>;
export const SessionsRevokedAllResponse = envelope(SessionsRevokedAllDto);
export const SignedOutDto = z.object({ changed: z.boolean(), keycloak: z.enum(KEYCLOAK_PROPAGATION_OUTCOMES) });
export type SignedOutDto = z.infer<typeof SignedOutDto>;
export const SignedOutResponse = envelope(SignedOutDto);

export const DeviceTrustDto = z.object({ deviceId: z.string(), trusted: z.boolean(), trustedUntil: z.string().nullable() });
export type DeviceTrustDto = z.infer<typeof DeviceTrustDto>;
export const DeviceTrustResponse = envelope(DeviceTrustDto);
export const DeviceRemovedDto = z.object({
  deviceId: z.string(),
  changed: z.boolean(),
  sessionsRevoked: z.number().int(),
  keycloak: z.enum(KEYCLOAK_PROPAGATION_OUTCOMES),
});
export type DeviceRemovedDto = z.infer<typeof DeviceRemovedDto>;
export const DeviceRemovedResponse = envelope(DeviceRemovedDto);

/** `POST /account/security/mfa/enrollment`: the web server must now send the browser to Keycloak with `kc_action=<keycloakAction>`. Nothing secret is returned. */
export const MfaEnrollmentDto = z.object({ method: MfaMethod, keycloakAction: z.string() });
export type MfaEnrollmentDto = z.infer<typeof MfaEnrollmentDto>;
export const MfaEnrollmentResponse = envelope(MfaEnrollmentDto);

/** The (always identical) answer to a password-reset request: it never says whether an account exists. */
export const PasswordResetAcceptedDto = z.object({ accepted: z.literal(true) });
export type PasswordResetAcceptedDto = z.infer<typeof PasswordResetAcceptedDto>;
export const PasswordResetAcceptedResponse = envelope(PasswordResetAcceptedDto);

// ---------------------------------------------------------------- requests (strict: unknown fields are refused; nothing is coerced)
/** The device secret: 32 random bytes, base64url, issued by the web server in an HttpOnly cookie. Only a keyed hash of it is stored. */
export const DEVICE_SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;
export const USER_AGENT_MAX_LENGTH = 512;
export const RegisterSessionRequest = z
  .object({
    device: z.string().regex(DEVICE_SECRET_SHAPE),
    userAgent: z.string().max(USER_AGENT_MAX_LENGTH).optional(),
  })
  .strict();
export type RegisterSessionRequest = z.infer<typeof RegisterSessionRequest>;
/** `includeCurrent` false (the default) is "sign out everywhere else". */
export const RevokeAllSessionsRequest = z.object({ includeCurrent: z.boolean().optional() }).strict();
export type RevokeAllSessionsRequest = z.infer<typeof RevokeAllSessionsRequest>;
export const StartMfaEnrollmentRequest = z.object({ method: MfaMethod }).strict();
export type StartMfaEnrollmentRequest = z.infer<typeof StartMfaEnrollmentRequest>;
export const PASSWORD_RESET_EMAIL_MAX_LENGTH = 320;
export const PasswordResetRequest = z.object({ email: z.string().max(PASSWORD_RESET_EMAIL_MAX_LENGTH) }).strict();
export type PasswordResetRequest = z.infer<typeof PasswordResetRequest>;
export const SecuritySessionIdParam = z.object({ sessionId: z.string().uuid() }).strict();
export const SecurityDeviceIdParam = z.object({ deviceId: z.string().uuid() }).strict();

// ---------------------------------------------------------------- events (transactional outbox; identifiers only, never a token, a secret or an address)
export const SECURITY_EVENTS = {
  sessionCreated: 'bananagig.identity.session-created.v1',
  sessionRevoked: 'bananagig.identity.session-revoked.v1',
  sessionsRevokedAll: 'bananagig.identity.sessions-revoked-all.v1',
  mfaEnabled: 'bananagig.identity.mfa-enabled.v1',
  mfaDisabled: 'bananagig.identity.mfa-disabled.v1',
  passwordResetRequested: 'bananagig.identity.password-reset-requested.v1',
  passwordResetCompleted: 'bananagig.identity.password-reset-completed.v1',
} as const;
export const SessionCreatedPayload = z.object({ accountId: z.string(), applicationSessionId: z.string(), accountDeviceId: z.string().nullable() });
export type SessionCreatedPayload = z.infer<typeof SessionCreatedPayload>;
export const SessionRevokedPayload = z.object({ accountId: z.string(), applicationSessionId: z.string(), reason: SessionRevocationReason });
export type SessionRevokedPayload = z.infer<typeof SessionRevokedPayload>;
export const SessionsRevokedAllPayload = z.object({ accountId: z.string(), revokedCount: z.number().int(), includeCurrent: z.boolean() });
export type SessionsRevokedAllPayload = z.infer<typeof SessionsRevokedAllPayload>;
export const MfaChangedPayload = z.object({ accountId: z.string(), method: MfaMethod });
export type MfaChangedPayload = z.infer<typeof MfaChangedPayload>;
export const PasswordResetRequestedPayload = z.object({ accountId: z.string() });
export type PasswordResetRequestedPayload = z.infer<typeof PasswordResetRequestedPayload>;
export const PasswordResetCompletedPayload = z.object({ accountId: z.string() });
export type PasswordResetCompletedPayload = z.infer<typeof PasswordResetCompletedPayload>;

// ---------------------------------------------------------------- error codes (mapped to `ACCOUNT_<code>` by the API layer)
export const SECURITY_ERROR_CODES = [
  'SESSION_NOT_FOUND',
  'DEVICE_NOT_FOUND',
  /** The operation needs a registered browser (device) and this session has none. */
  'DEVICE_REQUIRED',
  /** The identity provider could not be asked and the operation cannot proceed without it. */
  'SECURITY_UNAVAILABLE',
  'PASSWORD_RESET_RATE_LIMITED',
] as const;
export type SecurityErrorCode = (typeof SECURITY_ERROR_CODES)[number];
export const securityErrorMessageKey = (code: SecurityErrorCode): string => `account.security.error.${code.toLowerCase()}`;
/** Content key of the message of a guard error. */
export const authSecurityErrorMessageKey = (code: AuthSecurityErrorCode): string => `account.security.error.${code.toLowerCase()}`;
