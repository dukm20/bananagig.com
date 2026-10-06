// Typed internal API client. Knows only the public HTTP contract (/api/v1), never database internals.
import { API_PREFIX, CORRELATION_HEADER, ErrorResponse, SystemInfoResponse, WhoAmIResponse, type SystemInfo, type WhoAmI } from '@bananagig/contracts';

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

export function createApiClient(opts: ApiClientOptions) {
  const f = opts.fetch ?? fetch;
  async function request<T>(path: string, parse: (json: unknown) => T): Promise<{ data: T; correlationId: string | undefined }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const cid = opts.correlationId?.();
    if (cid) headers[CORRELATION_HEADER] = cid;
    const token = opts.accessToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await f(`${opts.baseUrl.replace(/\/$/, '')}${API_PREFIX}${path}`, { headers, cache: 'no-store' });
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
    return { data: parse(json), correlationId };
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
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;
