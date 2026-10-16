// Contract-conforming stand-in for the account endpoints (and whoami) of the API, mounted on the content stub (the real API is exercised by its own
// integration tests and `pnpm smoke`). It behaves like the API where the web app depends on it: the bearer token is required, the role named in
// x-active-role must be an ACTIVE role of the account (403 ACCOUNT_ROLE_NOT_HELD otherwise), the role switch validates and persists nothing.
import { createHash } from 'node:crypto';
import type http from 'node:http';
import {
  AcceptConsentRequest,
  CONSENT_ACCEPTANCE_STATES,
  CONSENT_ERROR_CODES,
  CONSENT_EVENT_TYPES,
  CONSENT_REQUIREMENT_STATUSES,
  CORRELATION_HEADER,
  LEGAL_ENTRY_KEYS,
  SEEDED_CONSENT_PURPOSES,
  consentErrorMessageKey,
  consentPurposeLabelKey,
  PasswordResetRequest,
  RegisterSessionRequest,
  RevokeAllSessionsRequest,
  SECURITY_ACTIVITY_TYPES,
  StartMfaEnrollmentRequest,
  UpdateProfileRequest,
  KEYCLOAK_ACTION_OF_METHOD,
  type AccountDto,
  type AccountConsentsDto,
  type AccountEmailDetailDto,
  type ConsentEventDto,
  type ConsentRequirementDto,
  type ConsentRequirementsDto,
  type SecurityActivityDto,
  type SecurityDevicesDto,
  type SecurityOverviewDto,
  type SecuritySessionsDto,
} from '@bananagig/contracts';
import type { ContentStub, StubCatalog } from './content-stub';
import { REGISTRY_COPY } from './content-stub';

export const ACCOUNT_ID = '3f8a6c1e-9d2b-4c7a-8e51-0b6d4f2a9c13';
export const CUSTOMER_ROLE = { code: 'CUSTOMER', nameContentKey: 'identity.role.customer.name' };
export const PROVIDER_ROLE = { code: 'PROVIDER', nameContentKey: 'identity.role.provider.name' };

/** An ACTIVE account holding the given roles (CUSTOMER first, which is the preferred role). */
export const accountDto = (roles: AccountDto['roles'] = [CUSTOMER_ROLE], over: Partial<AccountDto> = {}): AccountDto => ({
  accountId: ACCOUNT_ID,
  status: 'ACTIVE',
  roles,
  primaryRole: roles[0]?.code ?? null,
  activeRole: roles[0]?.code ?? null,
  profile: null,
  email: { emailVerificationStatus: 'NONE', primary: null, pending: null },
  phone: { phoneVerificationStatus: 'NONE', primary: null, pending: null },
  contacts: { emailVerified: false, phoneVerified: false, contactsVerified: false },
  createdAt: '2026-01-02T03:04:05.000Z',
  ...over,
});

/** The email verification state the API reports for an account without any address (NONE, codes of 6 digits, 30 minutes of validity). */
export const emailDetail = (over: Partial<AccountEmailDetailDto> = {}): AccountEmailDetailDto => ({
  emailVerificationStatus: 'NONE',
  primary: null,
  pending: null,
  resendAvailableAt: null,
  attemptsRemaining: null,
  codeLength: 6,
  validityMinutes: 30,
  ...over,
});

/** Registry copy of the account block of the session page, worded unlike the seeded copy so a test proves the text came from the registry. */
export const ACCOUNT_COPY: StubCatalog = {
  'en-US': {
    ...REGISTRY_COPY['en-US'],
    'session.account.id': { value: 'Registry account id' },
    'session.account.status': { value: 'Registry account status' },
    'session.account.roles': { value: 'Registry application roles' },
    'session.account.active_role': { value: 'Registry active role' },
    'session.account.unavailable': { value: 'Registry account unavailable', contentType: 'PLAIN_TEXT' },
    'account.status.active': { value: 'Registry status active' },
    'account.status.suspended': { value: 'Registry status suspended' },
    'identity.role.customer.name': { value: 'Registry Customer' },
    'identity.role.provider.name': { value: 'Registry Provider' },
  },
};

/**
 * Registry copy of the email verification screen (ID-002): every content key the /verify-email page requests, worded unlike the seeded copy so a test
 * proves the text came from the registry. The stub does not render variables, so the intro and countdown copy is plain text here.
 */
export const EMAIL_TEXT: Readonly<Record<string, string>> = {
  'account.email.verify.title': 'Registry email title',
  'account.email.verify.intro': 'Registry email intro',
  'account.email.verify.code_label': 'Registry email code label',
  'account.email.verify.submit': 'Registry email submit',
  'account.email.verify.resend': 'Registry email resend',
  'account.email.verify.resend_wait': 'Registry email countdown',
  'account.email.verify.change': 'Registry email change',
  'account.email.verify.sent': 'Registry email sent',
  'account.email.verify.success': 'Registry email success',
  'account.email.link.title': 'Registry link title',
  'account.email.link.body': 'Registry link body',
  'account.email.link.confirm': 'Registry link confirm',
  'account.email.link.sign_in_required': 'Registry link sign-in required',
  'account.email.status.none': 'Registry email status none',
  'account.email.status.pending': 'Registry email status pending',
  'account.email.status.verified': 'Registry email status verified',
  'account.email.error.invalid_format': 'Registry error invalid format',
  'account.email.error.not_pending': 'Registry error not pending',
  'account.email.error.code_invalid': 'Registry error code invalid',
  'account.email.error.link_invalid': 'Registry error link invalid',
  'account.email.error.code_expired': 'Registry error code expired',
  'account.email.error.code_used': 'Registry error code used',
  'account.email.error.verification_locked': 'Registry error verification locked',
  'account.email.error.resend_too_soon': 'Registry error resend too soon',
  'account.email.error.send_limit': 'Registry error send limit',
  'account.email.error.unavailable': 'Registry error unavailable',
  'account.email.error.delivery_failed': 'Registry error delivery failed',
  'account.email.error.rate_limited': 'Registry error rate limited',
};
export const EMAIL_COPY: StubCatalog = {
  'en-US': {
    ...ACCOUNT_COPY['en-US'],
    ...Object.fromEntries(Object.entries(EMAIL_TEXT).map(([key, value]) => [key, { value, contentType: 'PLAIN_TEXT' as const }])),
  },
};

// ---------------------------------------------------------------- account security (ID-004)
export const SESSION_ID = '5b0c9d3e-7a41-4f68-9c2d-1e8f0a6b4d21';
export const OTHER_SESSION_ID = '9a7e2c54-3b18-4d6f-8f90-2c5d7e1a0b36';
export const DEVICE_ID = '2d6f8a10-5c93-4e7b-b4a1-7f3e9c0d5a82';
export const OTHER_DEVICE_ID = 'c4e1b7a9-0d52-4a38-9e6f-8b2a5d3c7f10';

/** The overview the API reports for an account with an authenticator app but no recovery codes, signed in with the password only. */
export const overviewDto = (over: Partial<SecurityOverviewDto> = {}): SecurityOverviewDto => ({
  mfa: { available: true, totpConfigured: true, recoveryCodesConfigured: false },
  stepUp: { authenticatedAt: '2026-10-16T10:00:00.000Z', mfaSatisfied: false, recentUntil: null },
  currentSession: { sessionId: SESSION_ID, deviceId: DEVICE_ID, deviceTrusted: false, trustedUntil: null },
  policy: { trustedBrowserDays: 30, stepUpValidMinutes: 15, activityLogDays: 90 },
  ...over,
});
/** Two ACTIVE sessions: the current one (Firefox on Linux) and another browser (Safari on iOS). */
export const sessionsDto = (over: Partial<SecuritySessionsDto> = {}): SecuritySessionsDto => ({
  reconciled: true,
  sessions: [
    {
      sessionId: SESSION_ID,
      current: true,
      status: 'ACTIVE',
      device: { browser: 'FIREFOX', os: 'LINUX', deviceClass: 'DESKTOP' },
      deviceId: DEVICE_ID,
      createdAt: '2026-10-16T09:00:00.000Z',
      lastSeenAt: '2026-10-16T10:05:00.000Z',
      trusted: false,
      trustedUntil: null,
    },
    {
      sessionId: OTHER_SESSION_ID,
      current: false,
      status: 'ACTIVE',
      device: { browser: 'SAFARI', os: 'IOS', deviceClass: 'MOBILE' },
      deviceId: OTHER_DEVICE_ID,
      createdAt: '2026-10-15T09:00:00.000Z',
      lastSeenAt: '2026-10-15T18:30:00.000Z',
      trusted: true,
      trustedUntil: '2026-11-14T09:00:00.000Z',
    },
  ],
  ...over,
});
export const devicesDto = (over: Partial<SecurityDevicesDto> = {}): SecurityDevicesDto => ({
  devices: [
    {
      deviceId: DEVICE_ID,
      current: true,
      device: { browser: 'FIREFOX', os: 'LINUX', deviceClass: 'DESKTOP' },
      firstSeenAt: '2026-09-01T09:00:00.000Z',
      lastSeenAt: '2026-10-16T10:05:00.000Z',
      trusted: false,
      trustedUntil: null,
    },
    {
      deviceId: OTHER_DEVICE_ID,
      current: false,
      device: { browser: 'SAFARI', os: 'IOS', deviceClass: 'MOBILE' },
      firstSeenAt: '2026-08-01T09:00:00.000Z',
      lastSeenAt: '2026-10-15T18:30:00.000Z',
      trusted: true,
      trustedUntil: '2026-11-14T09:00:00.000Z',
    },
  ],
  ...over,
});
export const activityDto = (over: Partial<SecurityActivityDto> = {}): SecurityActivityDto => ({
  entries: [
    {
      id: 'ev-1',
      type: 'SESSION_CREATED',
      occurredAt: '2026-10-16T09:00:00.000Z',
      outcome: 'SUCCESS',
      labelContentKey: 'account.security.activity.session_created',
      sessionId: SESSION_ID,
      device: { browser: 'FIREFOX', os: 'LINUX', deviceClass: 'DESKTOP' },
    },
    {
      id: 'ev-2',
      type: 'PASSWORD_CHANGED',
      occurredAt: '2026-10-14T08:00:00.000Z',
      outcome: 'SUCCESS',
      labelContentKey: 'account.security.activity.password_changed',
      sessionId: null,
      device: null,
    },
  ],
  nextBefore: null,
  ...over,
});

/**
 * Registry copy of the security screens (ID-004): every content key the /security, /forgot-password and /session pages request, worded unlike the seeded copy so a
 * test proves the text came from the registry. The stub does not render variables, so the copy with a variable is plain text here.
 */
export const SECURITY_TEXT: Readonly<Record<string, string>> = {
  'account.security.title': 'Registry security title',
  'account.security.mfa.title': 'Registry mfa title',
  'account.security.mfa.status.enabled': 'Registry mfa on',
  'account.security.mfa.status.disabled': 'Registry mfa off',
  'account.security.mfa.status.unknown': 'Registry mfa unknown',
  'account.security.mfa.totp.label': 'Registry totp label',
  'account.security.mfa.totp.enable': 'Registry totp enable',
  'account.security.mfa.recovery.label': 'Registry recovery label',
  'account.security.mfa.recovery.generate': 'Registry recovery generate',
  'account.security.mfa.recovery.warning': 'Registry recovery warning',
  'account.security.mfa.stepup_note': 'Registry step-up note',
  'account.security.sessions.title': 'Registry sessions title',
  'account.security.sessions.current': 'Registry this session',
  'account.security.sessions.sign_out': 'Registry sign this one out',
  'account.security.sessions.sign_out_everywhere': 'Registry sign out everywhere',
  'account.security.sessions.empty': 'Registry no sessions',
  'account.security.sessions.unreconciled': 'Registry sessions unreconciled',
  'account.security.sessions.last_seen': 'Registry last seen',
  'account.security.devices.title': 'Registry browsers title',
  'account.security.devices.trust': 'Registry trust this browser',
  'account.security.devices.untrust': 'Registry stop trusting',
  'account.security.devices.remove': 'Registry remove browser',
  'account.security.devices.trust_note': 'Registry trust note',
  'account.security.devices.none': 'Registry no browsers',
  'account.security.devices.trusted_until': 'Registry trusted until',
  'account.security.activity.title': 'Registry activity title',
  'account.security.activity.empty': 'Registry no activity',
  ...Object.fromEntries(SECURITY_ACTIVITY_TYPES.map((t) => [`account.security.activity.${t.toLowerCase()}`, `Registry activity ${t.toLowerCase()}`])),
  ...Object.fromEntries(['chrome', 'firefox', 'safari', 'edge', 'opera', 'other'].map((b) => [`account.security.browser.${b}`, `Registry browser ${b}`])),
  ...Object.fromEntries(['windows', 'macos', 'linux', 'ios', 'android', 'other'].map((o) => [`account.security.os.${o}`, `Registry os ${o}`])),
  ...Object.fromEntries(['desktop', 'mobile', 'tablet', 'other'].map((c) => [`account.security.device_class.${c}`, `Registry class ${c}`])),
  ...Object.fromEntries(
    ['session_revoked', 'signed_out_elsewhere', 'device_trusted', 'device_untrusted', 'device_removed', 'mfa_return_success', 'mfa_return_cancelled'].map(
      (n) => [`account.security.notice.${n}`, `Registry notice ${n}`],
    ),
  ),
  ...Object.fromEntries(
    [
      'session_revoked',
      'step_up_required',
      'mfa_enrollment_required',
      'session_not_found',
      'device_not_found',
      'device_required',
      'security_unavailable',
      'password_reset_rate_limited',
    ].map((e) => [`account.security.error.${e}`, `Registry error ${e}`]),
  ),
  'account.password_reset.title': 'Registry reset title',
  'account.password_reset.intro': 'Registry reset intro',
  'account.password_reset.email_label': 'Registry reset email label',
  'account.password_reset.submit': 'Registry reset submit',
  'account.password_reset.accepted': 'Registry reset accepted',
  'account.password_reset.back_to_sign_in': 'Registry back to sign in',
  'account.password_reset.error.invalid_email': 'Registry reset invalid email',
  'account.password_reset.error.rate_limited': 'Registry reset rate limited',
};
export const SECURITY_COPY: StubCatalog = {
  'en-US': {
    ...ACCOUNT_COPY['en-US'],
    ...Object.fromEntries(Object.entries(SECURITY_TEXT).map(([key, value]) => [key, { value, contentType: 'PLAIN_TEXT' as const }])),
  },
};

// ---------------------------------------------------------------- consent and legal-version history (ID-005)
export const TOS_VERSION_ID = '7c1e5a9b-2d4f-4b86-a3e0-9f1d6c8b2e47';
export const PRIVACY_VERSION_ID = 'e08b3d62-5f1a-4c97-8d24-6a7b9c0e1f35';
/** The legal texts of the stub registry (markup, as the LEGAL content type is); the version hash is the real SHA-256 of the text, like the registry's trigger computes. */
export const TOS_BODY = '<h2>Registry terms heading</h2><p>Registry terms clause <strong>one</strong>.</p>';
export const PRIVACY_BODY = '<p>Registry privacy clause one.</p>';
export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');
export const TOS_HASH = sha256Hex(TOS_BODY);
export const PRIVACY_HASH = sha256Hex(PRIVACY_BODY);
export const CONSENT_EVENT_ID = 'b2d94f10-7e3a-4a68-9c15-3d8e6f0a7b24';

/** The version in force of a seeded purpose, as the requirements read reports it. */
export const consentDocument = (
  purpose: 'TERMS_OF_SERVICE' | 'PRIVACY_POLICY' = 'TERMS_OF_SERVICE',
  over: Partial<NonNullable<ConsentRequirementDto['document']>> = {},
) => ({
  entryKey: LEGAL_ENTRY_KEYS[purpose],
  versionId: purpose === 'TERMS_OF_SERVICE' ? TOS_VERSION_ID : PRIVACY_VERSION_ID,
  version: purpose === 'TERMS_OF_SERVICE' ? 3 : 2,
  locale: 'en-US',
  bodySha256: purpose === 'TERMS_OF_SERVICE' ? TOS_HASH : PRIVACY_HASH,
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  ...over,
});
/** An OUTSTANDING, required, never accepted purpose with its document in force. */
export const requirementDto = (
  purpose: 'TERMS_OF_SERVICE' | 'PRIVACY_POLICY' = 'TERMS_OF_SERVICE',
  over: Partial<ConsentRequirementDto> = {},
): ConsentRequirementDto => ({
  purposeCode: purpose,
  labelContentKey: consentPurposeLabelKey(purpose),
  required: true,
  status: 'OUTSTANDING',
  acceptanceState: 'NONE',
  withdrawable: false,
  reacceptance: 'REACCEPT_REQUIRED',
  document: consentDocument(purpose),
  accepted: null,
  ...over,
});
export const requirementsDto = (
  requirements: ConsentRequirementDto[] = [requirementDto('TERMS_OF_SERVICE'), requirementDto('PRIVACY_POLICY')],
): ConsentRequirementsDto => ({
  locale: 'en-US',
  requirements,
  satisfied: requirements.every((r) => !r.required || r.status === 'SATISFIED'),
  outstanding: requirements.filter((r) => r.required && r.status !== 'SATISFIED').map((r) => r.purposeCode),
});
export const consentEventDto = (over: Partial<ConsentEventDto> = {}): ConsentEventDto => ({
  consentEventId: CONSENT_EVENT_ID,
  purposeCode: 'TERMS_OF_SERVICE',
  eventType: 'ACCEPTED',
  eventSeq: 1,
  document: { versionId: TOS_VERSION_ID, version: 3, locale: 'en-US', bodySha256: TOS_HASH },
  occurredAt: '2026-10-16T09:30:00.000Z',
  source: 'ACCOUNT_API',
  ...over,
});
export const emptyConsentsDto = (): AccountConsentsDto => ({
  current: SEEDED_CONSENT_PURPOSES.map((p) => ({
    purposeCode: p,
    labelContentKey: consentPurposeLabelKey(p),
    state: 'NONE' as const,
    withdrawable: false,
    latest: null,
  })),
  history: [],
});

/**
 * Registry copy of the consent screen (ID-005): every content key the /consents page requests (the seeded `account.consent.*` keys plus `error.unavailable`, see the
 * report of ID-005 A4), worded unlike the seeded copy so a test proves the text came from the registry. The stub does not render variables, so the copy with a variable
 * is plain text here (the tests assert the variables the page sent). No legal text: the legal documents are separate LEGAL entries (CONSENT_COPY).
 */
export const CONSENT_TEXT: Readonly<Record<string, string>> = {
  'account.consent.title': 'Registry consent title',
  'account.consent.intro': 'Registry consent intro',
  'account.consent.requirements.title': 'Registry requirements title',
  'account.consent.requirements.all_done': 'Registry all done',
  'account.consent.requirements.outstanding_intro': 'Registry outstanding intro',
  'account.consent.history.title': 'Registry history title',
  'account.consent.history.empty': 'Registry history empty',
  'account.consent.document.unavailable_note': 'Registry document unavailable note',
  'account.consent.document.read': 'Registry read the document',
  'account.consent.document.version': 'Registry document version',
  'account.consent.document.locale': 'Registry document locale',
  'account.consent.action.accept': 'Registry accept',
  'account.consent.action.withdraw': 'Registry withdraw',
  'account.consent.accepted_on': 'Registry accepted on',
  'account.consent.purpose.terms_of_service': 'Registry terms of service',
  'account.consent.purpose.privacy_policy': 'Registry privacy policy',
  ...Object.fromEntries(CONSENT_REQUIREMENT_STATUSES.map((x) => [`account.consent.status.${x.toLowerCase()}`, `Registry status ${x.toLowerCase()}`])),
  ...Object.fromEntries(CONSENT_ACCEPTANCE_STATES.map((x) => [`account.consent.state.${x.toLowerCase()}`, `Registry state ${x.toLowerCase()}`])),
  ...Object.fromEntries(CONSENT_EVENT_TYPES.map((x) => [`account.consent.event.${x.toLowerCase()}`, `Registry event ${x.toLowerCase()}`])),
  ...Object.fromEntries(['accepted', 'withdrawn', 'already_accepted'].map((n) => [`account.consent.notice.${n}`, `Registry consent notice ${n}`])),
  ...Object.fromEntries(CONSENT_ERROR_CODES.map((c) => [consentErrorMessageKey(c), `Registry consent error ${c.toLowerCase()}`])),
  'account.consent.error.unavailable': 'Registry consent error unavailable',
};
export const CONSENT_COPY: StubCatalog = {
  'en-US': {
    ...ACCOUNT_COPY['en-US'],
    ...Object.fromEntries(Object.entries(CONSENT_TEXT).map(([key, value]) => [key, { value, contentType: 'PLAIN_TEXT' as const }])),
    [LEGAL_ENTRY_KEYS.TERMS_OF_SERVICE]: {
      value: TOS_BODY,
      format: 'html',
      contentType: 'LEGAL',
      version: { versionId: TOS_VERSION_ID, version: 3, bodySha256: TOS_HASH },
    },
    [LEGAL_ENTRY_KEYS.PRIVACY_POLICY]: {
      value: PRIVACY_BODY,
      format: 'html',
      contentType: 'LEGAL',
      version: { versionId: PRIVACY_VERSION_ID, version: 2, bodySha256: PRIVACY_HASH },
    },
  },
};

/** A scripted failure of one security route: the status and the standard error envelope the API would answer with. */
export interface ForcedFailure {
  status: number;
  code: string;
  category: string;
  details?: Record<string, unknown>;
}

export interface AccountCall {
  method: string;
  path: string;
  authorization: string | undefined;
  /** The x-active-role header the request carried. */
  activeRole: string | undefined;
  body: unknown;
  correlationId: string | undefined;
  /** The x-forwarded-for header the request carried. */
  forwardedFor?: string | undefined;
}
export interface AccountApiStub {
  calls: AccountCall[];
  /** The account the API holds; its `activeRole` is recomputed per request like the API does. */
  account: AccountDto;
  /** The email verification state GET /api/v1/account/email reports (ID-002). */
  email: AccountEmailDetailDto;
  /** The security read models (ID-004) GET /api/v1/account/security... report. */
  security: { overview: SecurityOverviewDto; sessions: SecuritySessionsDto; devices: SecurityDevicesDto; activity: SecurityActivityDto };
  /**
   * The consent state (ID-005) GET /api/v1/account/consents... report. The accept and withdraw routes validate like the API (strict body, the version in force, locale
   * and hash of that version, withdrawable and not required, idempotent repeats) and UPDATE this state, so a page rendered after an action shows its effect.
   */
  consent: { requirements: ConsentRequirementsDto; consents: AccountConsentsDto };
  /** When true every /account/* request is answered 401 SESSION_REVOKED (what `requireAccount` does for a revoked session). */
  revoked: boolean;
  /** Scripted failures by `METHOD /path` (without the /api/v1 prefix and the query), for example `POST /account/security/devices/current/trust`. */
  forced: Record<string, ForcedFailure>;
  /** up: serves; down: 503; suspended: 403 ACCOUNT_SUSPENDED. */
  mode: 'up' | 'down' | 'suspended';
  /** Whether /system/whoami is served (otherwise 404, which is what the content-only stub does). */
  whoami: boolean;
  reset(): void;
}

export function attachAccountApi(stub: ContentStub): AccountApiStub {
  const api: AccountApiStub = {
    calls: [],
    account: accountDto(),
    email: emailDetail(),
    security: { overview: overviewDto(), sessions: sessionsDto(), devices: devicesDto(), activity: activityDto() },
    consent: { requirements: requirementsDto(), consents: emptyConsentsDto() },
    revoked: false,
    forced: {},
    mode: 'up',
    whoami: true,
    reset() {
      api.calls.length = 0;
      api.account = accountDto();
      api.email = emailDetail();
      api.security = { overview: overviewDto(), sessions: sessionsDto(), devices: devicesDto(), activity: activityDto() };
      api.consent = { requirements: requirementsDto(), consents: emptyConsentsDto() };
      api.revoked = false;
      api.forced = {};
      api.mode = 'up';
      api.whoami = true;
    },
  };
  stub.extra = (req: http.IncomingMessage, body: unknown, res: http.ServerResponse): boolean => {
    const path = req.url ?? '';
    if (!path.startsWith('/api/v1/account/') && path !== '/api/v1/auth/password-reset' && !(api.whoami && path === '/api/v1/system/whoami')) return false;
    const correlationId = req.headers[CORRELATION_HEADER] as string | undefined;
    const activeRole = req.headers['x-active-role'] as string | undefined;
    const authorization = req.headers.authorization;
    api.calls.push({
      method: req.method ?? '',
      path,
      authorization,
      activeRole,
      body,
      correlationId,
      forwardedFor: req.headers['x-forwarded-for'] as string | undefined,
    });
    const cid = correlationId ?? 'stub-correlation';
    res.setHeader('content-type', 'application/json').setHeader(CORRELATION_HEADER, cid);
    const fail = (status: number, code: string, category: string, details?: Record<string, unknown>): boolean => {
      res.statusCode = status;
      res.end(JSON.stringify({ error: { code, category, message: code, correlationId: cid, ...(details ? { details } : {}) } }));
      return true;
    };
    const ok = (data: unknown): boolean => {
      res.end(JSON.stringify({ data, meta: { correlationId: cid } }));
      return true;
    };
    const route = `${req.method ?? ''} ${path.slice('/api/v1'.length).split('?')[0]}`;
    const forced = api.forced[route];
    if (forced) return fail(forced.status, forced.code, forced.category, forced.details);
    // POST /auth/password-reset is public: always the same 202 for a well-formed body (the real API never says whether an account exists)
    if (route === 'POST /auth/password-reset') {
      if (!PasswordResetRequest.safeParse(body).success) return fail(400, 'VALIDATION_FAILED', 'VALIDATION');
      res.statusCode = 202;
      return ok({ accepted: true });
    }
    if (!authorization?.startsWith('Bearer ')) return fail(401, 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION');
    if (api.revoked && path.startsWith('/api/v1/account/')) return fail(401, 'SESSION_REVOKED', 'AUTHENTICATION');
    if (api.mode === 'down') return fail(503, 'ACCOUNT_UNAVAILABLE', 'DEPENDENCY');
    if (api.mode === 'suspended') return fail(403, 'ACCOUNT_SUSPENDED', 'AUTHORIZATION', { status: 'SUSPENDED' });
    if (path === '/api/v1/system/whoami')
      return ok({ subject: 'user-1', clientId: 'bananagig-web', audience: ['bananagig-api'], realmRoles: ['customer'], authContext: 'web' });
    const held = (role: string | undefined): boolean => role === undefined || api.account.roles.some((r) => r.code === role);
    const acting = (role: string | undefined): AccountDto => ({ ...api.account, activeRole: role ?? api.account.primaryRole });
    if (req.method === 'GET' && path === '/api/v1/account/me')
      return held(activeRole) ? ok(acting(activeRole)) : fail(403, 'ACCOUNT_ROLE_NOT_HELD', 'AUTHORIZATION', { role: activeRole });
    if (req.method === 'GET' && path === '/api/v1/account/email')
      return held(activeRole) ? ok(api.email) : fail(403, 'ACCOUNT_ROLE_NOT_HELD', 'AUTHORIZATION', { role: activeRole });
    if (req.method === 'POST' && path === '/api/v1/account/active-role') {
      const role = (body as { role?: string } | undefined)?.role;
      if (typeof role !== 'string') return fail(400, 'VALIDATION_FAILED', 'VALIDATION');
      return held(role) ? ok(acting(role)) : fail(403, 'ACCOUNT_ROLE_NOT_HELD', 'AUTHORIZATION', { role });
    }
    if (req.method === 'PUT' && path === '/api/v1/account/profile') {
      const parsed = UpdateProfileRequest.safeParse(body);
      if (!parsed.success)
        return fail(400, 'VALIDATION_FAILED', 'VALIDATION', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      api.account = {
        ...api.account,
        profile: {
          firstName: parsed.data.firstName,
          lastName: parsed.data.lastName,
          preferredLocale: parsed.data.preferredLocale ?? null,
          timeZone: parsed.data.timeZone ?? null,
        },
      };
      return ok(acting(activeRole));
    }
    const sec = api.security;
    const SECURITY = '/account/security';
    if (route === `GET ${SECURITY}`) return held(activeRole) ? ok(sec.overview) : fail(403, 'ACCOUNT_ROLE_NOT_HELD', 'AUTHORIZATION', { role: activeRole });
    if (route === `GET ${SECURITY}/sessions`) return ok(sec.sessions);
    if (route === `GET ${SECURITY}/devices`) return ok(sec.devices);
    if (route === `GET ${SECURITY}/activity`) return ok(sec.activity);
    if (route === `POST ${SECURITY}/sessions/current`) {
      if (!RegisterSessionRequest.safeParse(body).success) return fail(400, 'VALIDATION_FAILED', 'VALIDATION');
      const o = sec.overview.currentSession;
      return ok({ sessionId: o.sessionId, deviceId: o.deviceId, deviceTrusted: o.deviceTrusted, trustedUntil: o.trustedUntil });
    }
    const sessionRoute = /^DELETE \/account\/security\/sessions\/([^/]+)$/.exec(route);
    if (sessionRoute) {
      const id = sessionRoute[1]!;
      if (!sec.sessions.sessions.some((x) => x.sessionId === id)) return fail(404, 'ACCOUNT_SESSION_NOT_FOUND', 'NOT_FOUND');
      return ok({ sessionId: id, changed: true, current: sec.sessions.sessions.find((x) => x.sessionId === id)!.current, keycloak: 'ENDED' });
    }
    if (route === `POST ${SECURITY}/sessions/revoke-all`) {
      if (!RevokeAllSessionsRequest.safeParse(body).success) return fail(400, 'VALIDATION_FAILED', 'VALIDATION');
      return ok({ revokedCount: sec.sessions.sessions.filter((x) => !x.current).length, keycloak: 'ENDED' });
    }
    if (route === `POST ${SECURITY}/sessions/current/sign-out`) return ok({ changed: true, keycloak: 'ENDED' });
    if (route === `POST ${SECURITY}/devices/current/trust`)
      return ok({ deviceId: sec.overview.currentSession.deviceId ?? DEVICE_ID, trusted: true, trustedUntil: '2026-11-15T10:00:00.000Z' });
    if (route === `DELETE ${SECURITY}/devices/current/trust`)
      return ok({ deviceId: sec.overview.currentSession.deviceId ?? DEVICE_ID, trusted: false, trustedUntil: null });
    const deviceRoute = /^DELETE \/account\/security\/devices\/([^/]+)$/.exec(route);
    if (deviceRoute) {
      const id = deviceRoute[1]!;
      if (!sec.devices.devices.some((x) => x.deviceId === id)) return fail(404, 'ACCOUNT_DEVICE_NOT_FOUND', 'NOT_FOUND');
      return ok({ deviceId: id, changed: true, sessionsRevoked: 1, keycloak: 'ENDED' });
    }
    if (route === `POST ${SECURITY}/mfa/enrollment`) {
      const parsed = StartMfaEnrollmentRequest.safeParse(body);
      if (!parsed.success) return fail(400, 'VALIDATION_FAILED', 'VALIDATION');
      return ok({ method: parsed.data.method, keycloakAction: KEYCLOAK_ACTION_OF_METHOD[parsed.data.method] });
    }
    // ---------------------------------------------------------------- consent (ID-005)
    if (route === 'GET /account/consents/requirements')
      return held(activeRole) ? ok(api.consent.requirements) : fail(403, 'ACCOUNT_ROLE_NOT_HELD', 'AUTHORIZATION', { role: activeRole });
    if (route === 'GET /account/consents')
      return held(activeRole) ? ok(api.consent.consents) : fail(403, 'ACCOUNT_ROLE_NOT_HELD', 'AUTHORIZATION', { role: activeRole });
    const consentRoute = /^POST \/account\/consents\/([^/]+)\/(accept|withdraw)$/.exec(route);
    if (consentRoute) {
      const purpose = decodeURIComponent(consentRoute[1]!);
      const req = api.consent.requirements.requirements.find((r) => r.purposeCode === purpose);
      if (!req) return fail(404, 'ACCOUNT_CONSENT_PURPOSE_NOT_FOUND', 'NOT_FOUND');
      const history = api.consent.consents.history;
      const latest = history.find((e) => e.purposeCode === purpose);
      const append = (eventType: 'ACCEPTED' | 'WITHDRAWN', document: ConsentEventDto['document']): ConsentEventDto => {
        const event = consentEventDto({
          consentEventId: `b2d94f10-7e3a-4a68-9c15-${String(history.length + 1).padStart(12, '0')}`,
          purposeCode: purpose,
          eventType,
          eventSeq: (latest?.eventSeq ?? 0) + 1,
          document,
          occurredAt: '2026-10-16T11:00:00.000Z',
        });
        history.unshift(event);
        const current = api.consent.consents.current.find((c) => c.purposeCode === purpose);
        if (current) {
          current.state = eventType === 'ACCEPTED' ? 'ACCEPTED' : 'WITHDRAWN';
          current.latest = event;
        }
        req.acceptanceState = eventType === 'ACCEPTED' ? 'ACCEPTED' : 'WITHDRAWN';
        req.accepted = eventType === 'ACCEPTED' ? event : null;
        req.status = eventType === 'ACCEPTED' ? 'SATISFIED' : req.required ? 'OUTSTANDING' : 'NOT_REQUIRED';
        const all = api.consent.requirements;
        all.satisfied = all.requirements.every((r) => !r.required || r.status === 'SATISFIED');
        all.outstanding = all.requirements.filter((r) => r.required && r.status !== 'SATISFIED').map((r) => r.purposeCode);
        return event;
      };
      if (consentRoute[2] === 'accept') {
        const parsed = AcceptConsentRequest.safeParse(body);
        if (!parsed.success) return fail(400, 'VALIDATION_FAILED', 'VALIDATION');
        const doc = req.document;
        if (!doc || parsed.data.versionId !== doc.versionId) return fail(404, 'ACCOUNT_CONSENT_VERSION_NOT_FOUND', 'NOT_FOUND');
        if (parsed.data.locale !== doc.locale) return fail(400, 'ACCOUNT_CONSENT_LOCALE_MISMATCH', 'VALIDATION');
        if (parsed.data.bodySha256 !== doc.bodySha256) return fail(400, 'ACCOUNT_CONSENT_HASH_MISMATCH', 'VALIDATION');
        if (latest?.eventType === 'ACCEPTED' && latest.document.versionId === doc.versionId) return ok({ changed: false, event: latest });
        return ok({
          changed: true,
          event: append('ACCEPTED', { versionId: doc.versionId, version: doc.version, locale: doc.locale, bodySha256: doc.bodySha256 }),
        });
      }
      if (body === undefined || JSON.stringify(body) !== '{}') return fail(400, 'VALIDATION_FAILED', 'VALIDATION');
      if (!req.withdrawable) return fail(409, 'ACCOUNT_CONSENT_NOT_WITHDRAWABLE', 'CONFLICT');
      if (latest?.eventType === 'WITHDRAWN') return ok({ changed: false, event: latest });
      if (latest?.eventType !== 'ACCEPTED') return fail(409, 'ACCOUNT_CONSENT_NOT_ACCEPTED', 'CONFLICT');
      if (req.required) return fail(409, 'ACCOUNT_CONSENT_REQUIRED_FOR_ROLE', 'CONFLICT');
      return ok({ changed: true, event: append('WITHDRAWN', latest.document) });
    }
    return fail(404, 'ROUTE_NOT_FOUND', 'NOT_FOUND');
  };
  return api;
}
