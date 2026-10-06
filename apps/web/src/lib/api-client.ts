// Typed internal API client. Knows only the public HTTP contract (/api/v1), never database internals.
import {
  API_PREFIX,
  CORRELATION_HEADER,
  ErrorResponse,
  LocaleListResponse,
  ResolveContentResponse,
  ResolveManyContentResponse,
  SystemInfoResponse,
  WhoAmIResponse,
  type ContentContext,
  type LocaleDto,
  type ResolvedContentDto,
  type SystemInfo,
  type WhoAmI,
} from '@bananagig/contracts';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly category: string,
    message: string,
    public readonly correlationId?: string,
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

export function createApiClient(opts: ApiClientOptions) {
  const f = opts.fetch ?? fetch;
  async function request<T>(path: string, parse: (json: unknown) => T, body?: unknown): Promise<{ data: T; correlationId: string | undefined }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const cid = opts.correlationId?.();
    if (cid) headers[CORRELATION_HEADER] = cid;
    const token = opts.accessToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      if (body !== undefined) headers['content-type'] = 'application/json';
      res = await f(`${opts.baseUrl.replace(/\/$/, '')}${API_PREFIX}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
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
      if (e.success) throw new ApiError(res.status, e.data.error.code, e.data.error.category, e.data.error.message, e.data.error.correlationId);
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
  return {
    /** GET /api/v1/system/whoami (requires an access token) */
    async getWhoAmI(): Promise<WhoAmI> {
      return (await request('/system/whoami', (j) => WhoAmIResponse.parse(j).data)).data;
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
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;
