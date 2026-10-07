// Contract-conforming stand-in for the account endpoints (and whoami) of the API, mounted on the content stub (the real API is exercised by its own
// integration tests and `pnpm smoke`). It behaves like the API where the web app depends on it: the bearer token is required, the role named in
// x-active-role must be an ACTIVE role of the account (403 ACCOUNT_ROLE_NOT_HELD otherwise), the role switch validates and persists nothing.
import type http from 'node:http';
import { CORRELATION_HEADER, UpdateProfileRequest, type AccountDto } from '@bananagig/contracts';
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
  createdAt: '2026-01-02T03:04:05.000Z',
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

export interface AccountCall {
  method: string;
  path: string;
  authorization: string | undefined;
  /** The x-active-role header the request carried. */
  activeRole: string | undefined;
  body: unknown;
  correlationId: string | undefined;
}
export interface AccountApiStub {
  calls: AccountCall[];
  /** The account the API holds; its `activeRole` is recomputed per request like the API does. */
  account: AccountDto;
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
    mode: 'up',
    whoami: true,
    reset() {
      api.calls.length = 0;
      api.account = accountDto();
      api.mode = 'up';
      api.whoami = true;
    },
  };
  stub.extra = (req: http.IncomingMessage, body: unknown, res: http.ServerResponse): boolean => {
    const path = req.url ?? '';
    if (!path.startsWith('/api/v1/account/') && !(api.whoami && path === '/api/v1/system/whoami')) return false;
    const correlationId = req.headers[CORRELATION_HEADER] as string | undefined;
    const activeRole = req.headers['x-active-role'] as string | undefined;
    const authorization = req.headers.authorization;
    api.calls.push({ method: req.method ?? '', path, authorization, activeRole, body, correlationId });
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
    if (!authorization?.startsWith('Bearer ')) return fail(401, 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION');
    if (api.mode === 'down') return fail(503, 'ACCOUNT_UNAVAILABLE', 'DEPENDENCY');
    if (api.mode === 'suspended') return fail(403, 'ACCOUNT_SUSPENDED', 'AUTHORIZATION', { status: 'SUSPENDED' });
    if (path === '/api/v1/system/whoami')
      return ok({ subject: 'user-1', clientId: 'bananagig-web', audience: ['bananagig-api'], realmRoles: ['customer'], authContext: 'web' });
    const held = (role: string | undefined): boolean => role === undefined || api.account.roles.some((r) => r.code === role);
    const acting = (role: string | undefined): AccountDto => ({ ...api.account, activeRole: role ?? api.account.primaryRole });
    if (req.method === 'GET' && path === '/api/v1/account/me')
      return held(activeRole) ? ok(acting(activeRole)) : fail(403, 'ACCOUNT_ROLE_NOT_HELD', 'AUTHORIZATION', { role: activeRole });
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
    return fail(404, 'ROUTE_NOT_FOUND', 'NOT_FOUND');
  };
  return api;
}
