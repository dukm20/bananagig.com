// Typed internal API client. Knows only the public HTTP contract (/api/v1), never database internals.
import {
  ACTIVE_ROLE_HEADER,
  API_PREFIX,
  CORRELATION_HEADER,
  ErrorResponse,
  AcceptConsentResponse,
  CatalogServiceTypeListResponse,
  DocumentUploadAuthorizationResponse,
  ProviderVerificationResponse,
  VerificationDocumentResponse,
  GigDetailResponse,
  GigMenuResponse,
  GigTemplateChoicesResponse,
  GigVersionResponse,
  MarketListResponse,
  ProviderRegistrationStateResponse,
  ProviderRequirementsResponse,
  AccountConsentsResponse,
  AccountEmailResponse,
  AccountNavigationResponse,
  AccountProfileViewResponse,
  AccountResponse,
  AccountRolesSectionResponse,
  ContactVerificationSectionResponse,
  PrivacySummaryResponse,
  ProfilePatchedResponse,
  SecuritySummaryResponse,
  TimeZoneListResponse,
  AddressFormatResponse,
  AddressValidationResponse,
  AdministrativeAreaListResponse,
  ConsentRequirementsResponse,
  DeviceRemovedResponse,
  DeviceTrustResponse,
  EmailVerificationSentResponse,
  EmailVerifiedResponse,
  FormatAddressResponse,
  LocaleListResponse,
  MfaEnrollmentResponse,
  PasswordResetAcceptedResponse,
  RegisteredSessionResponse,
  ResolveContentResponse,
  ResolveManyContentResponse,
  SecurityActivityResponse,
  SecurityDevicesResponse,
  SecurityOverviewResponse,
  SecuritySessionsResponse,
  SessionRevokedResponse,
  SessionsRevokedAllResponse,
  SetEmailResponse,
  SignedOutResponse,
  SystemInfoResponse,
  WhoAmIResponse,
  WithdrawConsentResponse,
  type AcceptConsentRequest,
  type CatalogServiceTypeDto,
  type DocumentUploadAuthorizationDto,
  type FinalizeDocumentRequest,
  type ProviderVerificationDto,
  type CreateGigRequest,
  type GigDetailDto,
  type GigMenuDto,
  type GigTemplateChoicesDto,
  type GigVersionDto,
  type PublishGigRequest,
  type UpdateGigDraftRequest,
  type RequestDocumentUploadRequest,
  type SubmitVerificationRequest,
  type VerificationDocumentDto,
  type MarketDto,
  type ProviderRegistrationStateDto,
  type ProviderRequirementsDto,
  type ReplaceProviderServicesRequest,
  type SelectProviderMarketRequest,
  type SubmitProviderRegistrationRequest,
  type CancelProviderRegistrationRequest,
  type AcceptConsentResultDto,
  type AccountConsentsDto,
  type AccountDto,
  type AccountEmailDetailDto,
  type AccountNavigationDto,
  type AccountProfileViewDto,
  type AccountRolesSectionDto,
  type ContactVerificationSectionDto,
  type PatchProfileRequest,
  type PrivacySummaryDto,
  type ProfilePatchedDto,
  type SecuritySummaryDto,
  type TimeZoneDto,
  type AddressFormatDto,
  type AddressInput,
  type AddressValidationResultDto,
  type AdministrativeAreaListDto,
  type ConsentRequirementsDto,
  type ContentContext,
  type DeviceRemovedDto,
  type DeviceTrustDto,
  type EmailVerificationSentDto,
  type EmailVerifiedDto,
  type FormattedAddressDto,
  type LocaleDto,
  type MfaEnrollmentDto,
  type MfaMethod,
  type NormalizedAddressDto,
  type PasswordResetAcceptedDto,
  type RegisteredSessionDto,
  type RegisterSessionRequest,
  type ResolvedContentDto,
  type SecurityActivityDto,
  type SecurityDevicesDto,
  type SecurityOverviewDto,
  type SecuritySessionsDto,
  type SessionRevokedDto,
  type SessionsRevokedAllDto,
  type SetEmailResultDto,
  type SignedOutDto,
  type SystemInfo,
  type UpdateProfileRequest,
  type WhoAmI,
  type WithdrawConsentResultDto,
} from '@bananagig/contracts';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly category: string,
    message: string,
    public readonly correlationId?: string,
    /** Error details of the standard envelope (for example the address issues of a rejected format request: field, code and message key only). */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Correlation id to propagate; a fresh one is generated per call when omitted. */
  correlationId?: () => string | undefined;
  /** Bearer access token for authenticated calls (server-side session). Never logged. */
  accessToken?: () => string | undefined;
  fetch?: typeof fetch;
}

/** Public content resolution input (what the web may send; management-only fields such as `at` and `includeTemplate` are deliberately absent). */
export interface ResolveContentInput {
  key: string;
  locale: string;
  context?: ContentContext;
  variables?: Record<string, unknown>;
  timeZone?: string;
}
export interface ResolveManyContentInput {
  keys: string[];
  locale: string;
  context?: ContentContext;
  /** Variable values by content key. */
  variables?: Record<string, Record<string, unknown>>;
  timeZone?: string;
}

/** Options of the account calls: the application role this request acts as (the session's active role). The API validates it on every request. */
export interface AccountCallOptions {
  activeRole?: string;
  /**
   * The browser's address as seen by the web server (the first entry of the proxy's x-forwarded-for). Forwarded as x-forwarded-for so the API's abuse
   * limits count real clients and not the web server itself. Only the email verification calls and the public password-reset request use it.
   */
  clientIp?: string;
}

/** Options of the central address formatter. */
export interface FormatAddressInput {
  /** Locale of the country line (default: the country's default locale). */
  locale?: string;
  /** Append the country name as the last line (an address shown outside its own country). */
  includeCountry?: boolean;
}

export function createApiClient(opts: ApiClientOptions) {
  const f = opts.fetch ?? fetch;
  async function request<T>(
    path: string,
    parse: (json: unknown) => T,
    body?: unknown,
    extra: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; headers?: Record<string, string> } = {},
  ): Promise<{ data: T; correlationId: string | undefined; status: number }> {
    const headers: Record<string, string> = { accept: 'application/json', ...extra.headers };
    const cid = opts.correlationId?.();
    if (cid) headers[CORRELATION_HEADER] = cid;
    const token = opts.accessToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      if (body !== undefined) headers['content-type'] = 'application/json';
      res = await f(`${opts.baseUrl.replace(/\/$/, '')}${API_PREFIX}${path}`, {
        method: extra.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
    } catch (err) {
      throw new ApiError(0, 'API_UNREACHABLE', 'DEPENDENCY', `API request failed: ${err instanceof Error ? err.message : String(err)}`, cid);
    }
    const json: unknown = await res.json().catch(() => undefined);
    const correlationId = res.headers.get(CORRELATION_HEADER) ?? undefined;
    if (!res.ok) {
      const e = ErrorResponse.safeParse(json);
      if (e.success)
        throw new ApiError(res.status, e.data.error.code, e.data.error.category, e.data.error.message, e.data.error.correlationId, e.data.error.details);
      throw new ApiError(res.status, 'UNEXPECTED_RESPONSE', 'INTERNAL', `Unexpected ${res.status} response`, correlationId);
    }
    let data: T;
    try {
      data = parse(json);
    } catch (err) {
      // A body that violates the contract is an API fault, not a crash of the caller.
      throw new ApiError(
        res.status,
        'UNEXPECTED_RESPONSE',
        'INTERNAL',
        `Response did not match the contract: ${err instanceof Error ? err.name : 'error'}`,
        correlationId,
      );
    }
    return { data, correlationId, status: res.status };
  }
  const roleHeader = (o: AccountCallOptions): Record<string, string> => (o.activeRole ? { [ACTIVE_ROLE_HEADER]: o.activeRole } : {});
  const emailHeaders = (o: AccountCallOptions): Record<string, string> => ({ ...roleHeader(o), ...(o.clientIp ? { 'x-forwarded-for': o.clientIp } : {}) });
  return {
    /** GET /api/v1/system/whoami (requires an access token) */
    async getWhoAmI(): Promise<WhoAmI> {
      return (await request('/system/whoami', (j) => WhoAmIResponse.parse(j).data)).data;
    },
    /**
     * GET /api/v1/account/me (requires an access token of the web identity context): the caller's own application account, ACTIVE roles and the role
     * this request acts as. `activeRole` is sent as x-active-role and accepted by the API only when the account holds it as an ACTIVE role (403 otherwise).
     */
    async getAccount(o: AccountCallOptions = {}): Promise<AccountDto> {
      return (await request('/account/me', (j) => AccountResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /**
     * POST /api/v1/account/active-role: validates that the account holds the role as an ACTIVE role and returns the account acting as it. Persists
     * nothing and starts no Keycloak login: the caller (the web session) remembers the role. A role the account does not hold is an ApiError (403).
     */
    async setActiveRole(role: string): Promise<AccountDto> {
      return (await request('/account/active-role', (j) => AccountResponse.parse(j).data, { role }, { method: 'POST' })).data;
    },
    /** PUT /api/v1/account/profile: replaces the caller's own core profile (names, optional locale and time zone). Invalid names are an ApiError (400) with issue codes and message keys. */
    async updateProfile(input: UpdateProfileRequest, o: AccountCallOptions = {}): Promise<AccountDto> {
      return (await request('/account/profile', (j) => AccountResponse.parse(j).data, input, { method: 'PUT', headers: roleHeader(o) })).data;
    },
    /** GET /api/v1/account/email: the caller's email verification state (addresses masked), resend countdown, attempts left and the code length. */
    async getAccountEmail(o: AccountCallOptions = {}): Promise<AccountEmailDetailDto> {
      return (await request('/account/email', (j) => AccountEmailResponse.parse(j).data, undefined, { headers: emailHeaders(o) })).data;
    },
    /** POST /api/v1/account/email: sets the address to verify (first address or a pending replacement). Sends nothing. */
    async setAccountEmail(email: string, o: AccountCallOptions = {}): Promise<SetEmailResultDto> {
      return (await request('/account/email', (j) => SetEmailResponse.parse(j).data, { email }, { method: 'POST', headers: emailHeaders(o) })).data;
    },
    /** POST /api/v1/account/email/verification/send: sends (or resends) the verification email. Cooldown and caps are ApiErrors (429). */
    async sendEmailVerification(o: AccountCallOptions = {}): Promise<EmailVerificationSentDto> {
      return (
        await request('/account/email/verification/send', (j) => EmailVerificationSentResponse.parse(j).data, {}, { method: 'POST', headers: emailHeaders(o) })
      ).data;
    },
    /** POST /api/v1/account/email/verification/confirm-code: confirms with the emailed code. A wrong code is an ApiError (400) with attemptsRemaining. */
    async confirmEmailCode(code: string, o: AccountCallOptions = {}): Promise<EmailVerifiedDto> {
      return (
        await request(
          '/account/email/verification/confirm-code',
          (j) => EmailVerifiedResponse.parse(j).data,
          { code },
          { method: 'POST', headers: emailHeaders(o) },
        )
      ).data;
    },
    /** POST /api/v1/account/email/verification/confirm-link: confirms with the magic-link token (sent in the body, never in a URL). */
    async confirmEmailLink(token: string, o: AccountCallOptions = {}): Promise<EmailVerifiedDto> {
      return (
        await request(
          '/account/email/verification/confirm-link',
          (j) => EmailVerifiedResponse.parse(j).data,
          { token },
          { method: 'POST', headers: emailHeaders(o) },
        )
      ).data;
    },
    // ---------------------------------------------------------------- account security (ID-004): sessions, browsers, MFA, activity, password reset
    /** POST /api/v1/account/security/sessions/current: tells the API which browser (device secret, coarse user agent) this login came from. The secret is sent in the body only. */
    async registerSession(input: RegisterSessionRequest, o: AccountCallOptions = {}): Promise<RegisteredSessionDto> {
      return (
        await request('/account/security/sessions/current', (j) => RegisteredSessionResponse.parse(j).data, input, { method: 'POST', headers: roleHeader(o) })
      ).data;
    },
    /** GET /api/v1/account/security: second-factor state, step-up state, current session and the policy the owner sees. */
    async getSecurityOverview(o: AccountCallOptions = {}): Promise<SecurityOverviewDto> {
      return (await request('/account/security', (j) => SecurityOverviewResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /** GET /api/v1/account/security/sessions: the caller's sessions (current first). */
    async listSecuritySessions(o: AccountCallOptions = {}): Promise<SecuritySessionsDto> {
      return (await request('/account/security/sessions', (j) => SecuritySessionsResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /** DELETE /api/v1/account/security/sessions/:sessionId: signs one session out (an unknown or foreign id is 404). */
    async revokeSecuritySession(sessionId: string, o: AccountCallOptions = {}): Promise<SessionRevokedDto> {
      return (
        await request(`/account/security/sessions/${encodeURIComponent(sessionId)}`, (j) => SessionRevokedResponse.parse(j).data, undefined, {
          method: 'DELETE',
          headers: roleHeader(o),
        })
      ).data;
    },
    /** POST /api/v1/account/security/sessions/revoke-all: signs out every other session (`includeCurrent: true` signs this one out too). */
    async revokeAllSecuritySessions(input: { includeCurrent?: boolean } = {}, o: AccountCallOptions = {}): Promise<SessionsRevokedAllDto> {
      return (
        await request('/account/security/sessions/revoke-all', (j) => SessionsRevokedAllResponse.parse(j).data, input, {
          method: 'POST',
          headers: roleHeader(o),
        })
      ).data;
    },
    /** POST /api/v1/account/security/sessions/current/sign-out: ends the application session of this request (best effort at logout). */
    async signOutCurrentSession(o: AccountCallOptions = {}): Promise<SignedOutDto> {
      return (
        await request('/account/security/sessions/current/sign-out', (j) => SignedOutResponse.parse(j).data, {}, { method: 'POST', headers: roleHeader(o) })
      ).data;
    },
    /** GET /api/v1/account/security/devices: the caller's browsers with their trusted-browser state. */
    async listSecurityDevices(o: AccountCallOptions = {}): Promise<SecurityDevicesDto> {
      return (await request('/account/security/devices', (j) => SecurityDevicesResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /** POST /api/v1/account/security/devices/current/trust: trusts this browser (needs a recent authentication: 401 STEP_UP_REQUIRED otherwise). */
    async trustCurrentDevice(o: AccountCallOptions = {}): Promise<DeviceTrustDto> {
      return (
        await request('/account/security/devices/current/trust', (j) => DeviceTrustResponse.parse(j).data, {}, { method: 'POST', headers: roleHeader(o) })
      ).data;
    },
    /** DELETE /api/v1/account/security/devices/current/trust: stops trusting this browser. */
    async untrustCurrentDevice(o: AccountCallOptions = {}): Promise<DeviceTrustDto> {
      return (
        await request('/account/security/devices/current/trust', (j) => DeviceTrustResponse.parse(j).data, undefined, {
          method: 'DELETE',
          headers: roleHeader(o),
        })
      ).data;
    },
    /** DELETE /api/v1/account/security/devices/:deviceId: forgets a browser and signs out its sessions. */
    async removeSecurityDevice(deviceId: string, o: AccountCallOptions = {}): Promise<DeviceRemovedDto> {
      return (
        await request(`/account/security/devices/${encodeURIComponent(deviceId)}`, (j) => DeviceRemovedResponse.parse(j).data, undefined, {
          method: 'DELETE',
          headers: roleHeader(o),
        })
      ).data;
    },
    /** GET /api/v1/account/security/activity: the security timeline, newest first (`before` is the `nextBefore` of the previous page). */
    async listSecurityActivity(q: { limit?: number; before?: string } = {}, o: AccountCallOptions = {}): Promise<SecurityActivityDto> {
      const query = new URLSearchParams();
      if (q.limit !== undefined) query.set('limit', String(q.limit));
      if (q.before !== undefined) query.set('before', q.before);
      const qs = query.size > 0 ? `?${query.toString()}` : '';
      return (await request(`/account/security/activity${qs}`, (j) => SecurityActivityResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /** POST /api/v1/account/security/mfa/enrollment: records the request and names the Keycloak action to start (needs a recent authentication). Nothing secret is returned. */
    async startMfaEnrollment(method: MfaMethod, o: AccountCallOptions = {}): Promise<MfaEnrollmentDto> {
      return (
        await request('/account/security/mfa/enrollment', (j) => MfaEnrollmentResponse.parse(j).data, { method }, { method: 'POST', headers: roleHeader(o) })
      ).data;
    },
    /** POST /api/v1/auth/password-reset (public): always the same 202 body. A rate limit is an ApiError (429). The address travels in the body only. */
    async requestPasswordReset(email: string, o: AccountCallOptions = {}): Promise<PasswordResetAcceptedDto> {
      return (
        await request('/auth/password-reset', (j) => PasswordResetAcceptedResponse.parse(j).data, { email }, { method: 'POST', headers: emailHeaders(o) })
      ).data;
    },
    // ---------------------------------------------------------------- consent and legal-version history (ID-005)
    /** GET /api/v1/account/consents: the caller's derived current consent per purpose and the history of every consent event, newest first. */
    async getAccountConsents(o: AccountCallOptions = {}): Promise<AccountConsentsDto> {
      return (await request('/account/consents', (j) => AccountConsentsResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /**
     * GET /api/v1/account/consents/requirements: which purposes the caller's roles require, their status, and the version in force (the one a person could accept now).
     * `locale` overrides the evaluation locale (default: the account's preferred locale, else the platform default).
     */
    async getConsentRequirements(q: { locale?: string } = {}, o: AccountCallOptions = {}): Promise<ConsentRequirementsDto> {
      const qs = q.locale !== undefined ? `?${new URLSearchParams({ locale: q.locale }).toString()}` : '';
      return (await request(`/account/consents/requirements${qs}`, (j) => ConsentRequirementsResponse.parse(j).data, undefined, { headers: roleHeader(o) }))
        .data;
    },
    /**
     * POST /api/v1/account/consents/:purpose/accept: accepts exactly the version the person was shown (id, locale and hash of its text). The server verifies that
     * the version is in force for the purpose and that the locale and hash are those of the immutable version; a mismatch is an ApiError, never repaired.
     */
    async acceptConsent(purpose: string, input: AcceptConsentRequest, o: AccountCallOptions = {}): Promise<AcceptConsentResultDto> {
      return (
        await request(`/account/consents/${encodeURIComponent(purpose)}/accept`, (j) => AcceptConsentResponse.parse(j).data, input, {
          method: 'POST',
          headers: roleHeader(o),
        })
      ).data;
    },
    /** POST /api/v1/account/consents/:purpose/withdraw: withdraws an accepted, withdrawable purpose that no role of the account requires (idempotent). */
    async withdrawConsent(purpose: string, o: AccountCallOptions = {}): Promise<WithdrawConsentResultDto> {
      return (
        await request(
          `/account/consents/${encodeURIComponent(purpose)}/withdraw`,
          (j) => WithdrawConsentResponse.parse(j).data,
          {},
          {
            method: 'POST',
            headers: roleHeader(o),
          },
        )
      ).data;
    },
    // ---------------------------------------------------------------- provider registration (PRO-001): the caller's own registration; no call carries an account id
    /** GET /api/v1/provider/registration: the provider role of the caller and the latest registration attempt (or null). */
    async getProviderRegistration(o: AccountCallOptions = {}): Promise<ProviderRegistrationStateDto> {
      return (await request('/provider/registration', (j) => ProviderRegistrationStateResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /** POST /api/v1/provider/registration: starts the registration or resumes the live one (idempotent). `created` tells which. */
    async startProviderRegistration(o: AccountCallOptions = {}): Promise<{ created: boolean; state: ProviderRegistrationStateDto }> {
      const r = await request('/provider/registration', (j) => ProviderRegistrationStateResponse.parse(j).data, {}, { method: 'POST', headers: roleHeader(o) });
      return { created: r.status === 201, state: r.data };
    },
    /** PUT /api/v1/provider/registration/market: chooses the market of the registration (the server checks the configured policy). */
    async selectProviderMarket(input: SelectProviderMarketRequest, o: AccountCallOptions = {}): Promise<ProviderRegistrationStateDto> {
      return (
        await request('/provider/registration/market', (j) => ProviderRegistrationStateResponse.parse(j).data, input, { method: 'PUT', headers: roleHeader(o) })
      ).data;
    },
    /** PUT /api/v1/provider/registration/services: replaces the whole set of service types of the registration. */
    async replaceProviderServices(input: ReplaceProviderServicesRequest, o: AccountCallOptions = {}): Promise<ProviderRegistrationStateDto> {
      return (
        await request('/provider/registration/services', (j) => ProviderRegistrationStateResponse.parse(j).data, input, {
          method: 'PUT',
          headers: roleHeader(o),
        })
      ).data;
    },
    /** GET /api/v1/provider/registration/requirements: the derived status of every onboarding step. */
    async getProviderRequirements(q: { locale?: string } = {}, o: AccountCallOptions = {}): Promise<ProviderRequirementsDto> {
      const qs = q.locale !== undefined ? `?${new URLSearchParams({ locale: q.locale }).toString()}` : '';
      return (
        await request(`/provider/registration/requirements${qs}`, (j) => ProviderRequirementsResponse.parse(j).data, undefined, { headers: roleHeader(o) })
      ).data;
    },
    /** POST /api/v1/provider/registration/submit: the server decides whether every step is met; a stale revision is an ApiError (409). */
    async submitProviderRegistration(input: SubmitProviderRegistrationRequest, o: AccountCallOptions = {}): Promise<ProviderRequirementsDto> {
      return (
        await request('/provider/registration/submit', (j) => ProviderRequirementsResponse.parse(j).data, input, { method: 'POST', headers: roleHeader(o) })
      ).data;
    },
    /** POST /api/v1/provider/registration/cancel: cancels the attempt in progress; the account, the customer role and the history stay. */
    async cancelProviderRegistration(input: CancelProviderRegistrationRequest = {}, o: AccountCallOptions = {}): Promise<ProviderRegistrationStateDto> {
      return (
        await request('/provider/registration/cancel', (j) => ProviderRegistrationStateResponse.parse(j).data, input, {
          method: 'POST',
          headers: roleHeader(o),
        })
      ).data;
    },
    /** GET /api/v1/geography/markets (public: the ACTIVE markets in effect). */
    async listGeographyMarkets(): Promise<MarketDto[]> {
      return (await request('/geography/markets', (j) => MarketListResponse.parse(j).data)).data;
    },
    /** GET /api/v1/catalog/service-types?market= (public: the ACTIVE service types offered in a public market, with resolved names). */
    async listMarketServiceTypes(market: string, locale?: string): Promise<CatalogServiceTypeDto[]> {
      const qs = new URLSearchParams({ market, ...(locale ? { locale } : {}) }).toString();
      return (await request(`/catalog/service-types?${qs}`, (j) => CatalogServiceTypeListResponse.parse(j).data)).data;
    },
    // ---------------------------------------------------------------- provider verification (TRUST-001): the caller's own case; no call carries an account id, a case id or a decision
    /** GET /api/v1/provider/verification: the requirements, their statuses, the documents' metadata and the overall state (derived; never Go-Live). */
    async getProviderVerification(o: AccountCallOptions = {}): Promise<ProviderVerificationDto> {
      return (await request('/provider/verification', (j) => ProviderVerificationResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /** POST /api/v1/provider/verification: opens or resumes the case (idempotent). `created` tells which. */
    async openProviderVerification(o: AccountCallOptions = {}): Promise<{ created: boolean; verification: ProviderVerificationDto }> {
      const r = await request('/provider/verification', (j) => ProviderVerificationResponse.parse(j).data, {}, { method: 'POST', headers: roleHeader(o) });
      return { created: r.status === 201, verification: r.data };
    },
    /** POST /api/v1/provider/verification/documents/upload: authorizes ONE upload (a one-time URL: never store or log it). */
    async requestVerificationUpload(input: RequestDocumentUploadRequest, o: AccountCallOptions = {}): Promise<DocumentUploadAuthorizationDto> {
      return (
        await request('/provider/verification/documents/upload', (j) => DocumentUploadAuthorizationResponse.parse(j).data, input, {
          method: 'POST',
          headers: roleHeader(o),
        })
      ).data;
    },
    /** POST /api/v1/provider/verification/documents/:id/finalize: the server verifies the stored file and scans it. */
    async finalizeVerificationDocument(documentId: string, input: FinalizeDocumentRequest = {}, o: AccountCallOptions = {}): Promise<VerificationDocumentDto> {
      return (
        await request(`/provider/verification/documents/${encodeURIComponent(documentId)}/finalize`, (j) => VerificationDocumentResponse.parse(j).data, input, {
          method: 'POST',
          headers: roleHeader(o),
        })
      ).data;
    },
    /** POST /api/v1/provider/verification/documents/:id/withdraw: removes a draft document. */
    async withdrawVerificationDocument(documentId: string, o: AccountCallOptions = {}): Promise<VerificationDocumentDto> {
      return (
        await request(
          `/provider/verification/documents/${encodeURIComponent(documentId)}/withdraw`,
          (j) => VerificationDocumentResponse.parse(j).data,
          {},
          {
            method: 'POST',
            headers: roleHeader(o),
          },
        )
      ).data;
    },
    /** POST /api/v1/provider/verification/submit: submits the evidence for review (a stale revision is an ApiError 409). */
    async submitProviderVerification(input: SubmitVerificationRequest, o: AccountCallOptions = {}): Promise<ProviderVerificationDto> {
      return (
        await request('/provider/verification/submit', (j) => ProviderVerificationResponse.parse(j).data, input, { method: 'POST', headers: roleHeader(o) })
      ).data;
    },
    /** POST /api/v1/provider/verification/cancel: withdraws a case that was not decided. */
    async cancelProviderVerification(o: AccountCallOptions = {}): Promise<ProviderVerificationDto> {
      return (await request('/provider/verification/cancel', (j) => ProviderVerificationResponse.parse(j).data, {}, { method: 'POST', headers: roleHeader(o) }))
        .data;
    },
    /** POST /api/v1/provider/verification/requirements/:code/reverify: starts a new cycle of an expired requirement. */
    async reverifyProviderRequirement(requirementCode: string, o: AccountCallOptions = {}): Promise<ProviderVerificationDto> {
      return (
        await request(
          `/provider/verification/requirements/${encodeURIComponent(requirementCode)}/reverify`,
          (j) => ProviderVerificationResponse.parse(j).data,
          {},
          {
            method: 'POST',
            headers: roleHeader(o),
          },
        )
      ).data;
    },
    // ---------------------------------------------------------------- provider Gigs (CAT-003): the caller's own Gigs; no call carries an account id, a role, a status or a currency
    /** GET /api/v1/provider/gig-templates: the Gig Templates the caller can start a Gig from now (market and selected service types already applied by the server). */
    async listGigTemplateChoices(o: AccountCallOptions = {}): Promise<GigTemplateChoicesDto> {
      return (await request('/provider/gig-templates', (j) => GigTemplateChoicesResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /** GET /api/v1/provider/gigs: the GigMenu (every Gig of the caller with its current version and draft, readiness, limits and whether creating is possible). */
    async getGigMenu(o: AccountCallOptions = {}): Promise<GigMenuDto> {
      return (await request('/provider/gigs', (j) => GigMenuResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /** POST /api/v1/provider/gigs: creates a Gig and its first draft from a template code (201), or returns the one an earlier request with the same `clientRequestId` created (200). */
    async createGig(input: CreateGigRequest, o: AccountCallOptions = {}): Promise<{ created: boolean; detail: GigDetailDto }> {
      const r = await request('/provider/gigs', (j) => GigDetailResponse.parse(j).data, input, { method: 'POST', headers: roleHeader(o) });
      return { created: r.status === 201, detail: r.data };
    },
    /** GET /api/v1/provider/gigs/:gigId: one Gig with its current version, draft and history (404 for a Gig that is not the caller's). */
    async getGig(gigId: string, o: AccountCallOptions = {}): Promise<GigDetailDto> {
      return (await request(`/provider/gigs/${encodeURIComponent(gigId)}`, (j) => GigDetailResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /** POST /api/v1/provider/gigs/:gigId/versions: starts the next draft from the published version (takes no input). */
    async createGigVersion(gigId: string, o: AccountCallOptions = {}): Promise<GigDetailDto> {
      return (
        await request(
          `/provider/gigs/${encodeURIComponent(gigId)}/versions`,
          (j) => GigDetailResponse.parse(j).data,
          {},
          { method: 'POST', headers: roleHeader(o) },
        )
      ).data;
    },
    /** GET /api/v1/provider/gigs/:gigId/versions/:version: one version of the caller's Gig, whatever its status. */
    async getGigVersion(gigId: string, version: number, o: AccountCallOptions = {}): Promise<GigVersionDto> {
      return (
        await request(
          `/provider/gigs/${encodeURIComponent(gigId)}/versions/${encodeURIComponent(String(version))}`,
          (j) => GigVersionResponse.parse(j).data,
          undefined,
          {
            headers: roleHeader(o),
          },
        )
      ).data;
    },
    /** PUT /api/v1/provider/gigs/:gigId/draft: replaces the whole editable content of the draft (a stale revision is an ApiError 409). */
    async updateGigDraft(gigId: string, input: UpdateGigDraftRequest, o: AccountCallOptions = {}): Promise<GigDetailDto> {
      return (
        await request(`/provider/gigs/${encodeURIComponent(gigId)}/draft`, (j) => GigDetailResponse.parse(j).data, input, {
          method: 'PUT',
          headers: roleHeader(o),
        })
      ).data;
    },
    /** POST /api/v1/provider/gigs/:gigId/publish: publishes the draft (the server checks completeness; a stale revision is an ApiError 409). */
    async publishGig(gigId: string, input: PublishGigRequest, o: AccountCallOptions = {}): Promise<GigDetailDto> {
      return (
        await request(`/provider/gigs/${encodeURIComponent(gigId)}/publish`, (j) => GigDetailResponse.parse(j).data, input, {
          method: 'POST',
          headers: roleHeader(o),
        })
      ).data;
    },
    /** POST /api/v1/provider/gigs/:gigId/retire: retires the Gig for good (takes no input; the history stays readable). */
    async retireGig(gigId: string, o: AccountCallOptions = {}): Promise<GigDetailDto> {
      return (
        await request(
          `/provider/gigs/${encodeURIComponent(gigId)}/retire`,
          (j) => GigDetailResponse.parse(j).data,
          {},
          { method: 'POST', headers: roleHeader(o) },
        )
      ).data;
    },
    // ---------------------------------------------------------------- the shared account area (ACC-001): every call acts as the session's active role (x-active-role)
    /** GET /api/v1/account/navigation: the enabled sections of the active role (registry data, in menu order), the switchable roles and the contact summary. */
    async getAccountNavigation(o: AccountCallOptions = {}): Promise<AccountNavigationDto> {
      return (await request('/account/navigation', (j) => AccountNavigationResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /** GET /api/v1/account/profile: the caller's own profile (names, the name other people see, locale, time zone) or null before a name was given. 404 ACCOUNT_SECTION_NOT_FOUND when the role has neither Profile nor Language and region. */
    async getAccountProfile(o: AccountCallOptions = {}): Promise<AccountProfileViewDto> {
      return (await request('/account/profile', (j) => AccountProfileViewResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /** PATCH /api/v1/account/profile: changes the PRESENT fields only (null clears the locale and time zone). A rejected value is an ApiError (400) with `details.reason` and issue codes, never the value. */
    async patchAccountProfile(input: PatchProfileRequest, o: AccountCallOptions = {}): Promise<ProfilePatchedDto> {
      return (await request('/account/profile', (j) => ProfilePatchedResponse.parse(j).data, input, { method: 'PATCH', headers: roleHeader(o) })).data;
    },
    /** GET /api/v1/account/contact-verification: the masked email and phone states and the derived summary (Contact details section). */
    async getAccountContactVerification(o: AccountCallOptions = {}): Promise<ContactVerificationSectionDto> {
      return (await request('/account/contact-verification', (j) => ContactVerificationSectionResponse.parse(j).data, undefined, { headers: roleHeader(o) }))
        .data;
    },
    /** GET /api/v1/account/roles: the ACTIVE roles the account holds, the role it acts as and the roles it can switch to (Roles section). */
    async getAccountRolesSection(o: AccountCallOptions = {}): Promise<AccountRolesSectionDto> {
      return (await request('/account/roles', (j) => AccountRolesSectionResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /** GET /api/v1/account/security-summary: two-step state, number of live sessions and whether this browser is trusted (Security section; the security centre stays the place to act). */
    async getAccountSecuritySummary(o: AccountCallOptions = {}): Promise<SecuritySummaryDto> {
      return (await request('/account/security-summary', (j) => SecuritySummaryResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /** GET /api/v1/account/privacy: how many required agreements still need attention and the data-download contract (Privacy and data section). */
    async getAccountPrivacySummary(o: AccountCallOptions = {}): Promise<PrivacySummaryDto> {
      return (await request('/account/privacy', (j) => PrivacySummaryResponse.parse(j).data, undefined, { headers: roleHeader(o) })).data;
    },
    /** GET /api/v1/geography/time-zones (public: without a bearer token only the ACTIVE zones are returned). */
    async listGeographyTimeZones(): Promise<TimeZoneDto[]> {
      return (await request('/geography/time-zones', (j) => TimeZoneListResponse.parse(j).data)).data;
    },
    /** GET /api/v1/system/info */
    async getSystemInfo(): Promise<SystemInfo> {
      return (await request('/system/info', (j) => SystemInfoResponse.parse(j).data)).data;
    },
    /** GET /api/v1/content/locales (public: without a bearer token only the ACTIVE locales are returned) */
    async listContentLocales(): Promise<LocaleDto[]> {
      return (await request('/content/locales', (j) => LocaleListResponse.parse(j).data)).data;
    },
    /** POST /api/v1/content/resolve (public: PUBLIC entries only, rendered and sanitized by the API) */
    async resolveContent(input: ResolveContentInput): Promise<ResolvedContentDto> {
      return (await request('/content/resolve', (j) => ResolveContentResponse.parse(j).data, input)).data;
    },
    /** POST /api/v1/content/resolve-many (public). Keys the registry cannot serve are simply absent from `items`. */
    async resolveManyContent(input: ResolveManyContentInput): Promise<{ evaluatedAt: string; items: ResolvedContentDto[] }> {
      return (await request('/content/resolve-many', (j) => ResolveManyContentResponse.parse(j).data, input)).data;
    },
    /** GET /api/v1/geography/countries/:code/address-format (public: ACTIVE countries only). The form definition; labels are content keys. */
    async getAddressFormat(countryCode: string): Promise<AddressFormatDto> {
      return (await request(`/geography/countries/${encodeURIComponent(countryCode)}/address-format`, (j) => AddressFormatResponse.parse(j).data)).data;
    },
    /** GET /api/v1/geography/countries/:code/administrative-areas (public: ACTIVE countries and areas only), in picker order. */
    async listAdministrativeAreas(countryCode: string): Promise<AdministrativeAreaListDto> {
      return (
        await request(`/geography/countries/${encodeURIComponent(countryCode)}/administrative-areas`, (j) => AdministrativeAreaListResponse.parse(j).data)
      ).data;
    },
    /**
     * POST /api/v1/geography/addresses/validate (public, stateless: nothing is stored). An invalid address is a normal result (`valid: false` with
     * issue codes and content message keys, never the rejected values); an ApiError (400) means the request itself was malformed.
     */
    async validateAddress(address: AddressInput): Promise<AddressValidationResultDto> {
      return (await request('/geography/addresses/validate', (j) => AddressValidationResponse.parse(j).data, { address })).data;
    },
    /**
     * POST /api/v1/geography/addresses/format (public, stateless): the one central formatter, so clients never build the string. An address that is
     * not valid for its country is an ApiError (400) whose `details.issues` carry field, code and message key.
     */
    async formatAddress(address: AddressInput, opts: FormatAddressInput = {}): Promise<{ address: NormalizedAddressDto; formatted: FormattedAddressDto }> {
      const body = {
        address,
        ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
        ...(opts.includeCountry !== undefined ? { includeCountry: opts.includeCountry } : {}),
      };
      return (await request('/geography/addresses/format', (j) => FormatAddressResponse.parse(j).data, body)).data;
    },
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;
