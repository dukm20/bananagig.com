// Typed internal API client. Knows only the public HTTP contract (/api/v1), never database internals.
import {
  ACTIVE_ROLE_HEADER,
  API_PREFIX,
  CORRELATION_HEADER,
  ErrorResponse,
  AccountEmailResponse,
  AccountResponse,
  AddressFormatResponse,
  AddressValidationResponse,
  AdministrativeAreaListResponse,
  EmailVerificationSentResponse,
  EmailVerifiedResponse,
  FormatAddressResponse,
  LocaleListResponse,
  ResolveContentResponse,
  ResolveManyContentResponse,
  SetEmailResponse,
  SystemInfoResponse,
  WhoAmIResponse,
  type AccountDto,
  type AccountEmailDetailDto,
  type AddressFormatDto,
  type AddressInput,
  type AddressValidationResultDto,
  type AdministrativeAreaListDto,
  type ContentContext,
  type EmailVerificationSentDto,
  type EmailVerifiedDto,
  type FormattedAddressDto,
  type LocaleDto,
  type NormalizedAddressDto,
  type ResolvedContentDto,
  type SetEmailResultDto,
  type SystemInfo,
  type UpdateProfileRequest,
  type WhoAmI,
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
   * limits count real clients and not the web server itself. Only the email verification calls use it.
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
    extra: { method?: 'GET' | 'POST' | 'PUT'; headers?: Record<string, string> } = {},
  ): Promise<{ data: T; correlationId: string | undefined }> {
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
    return { data, correlationId };
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
