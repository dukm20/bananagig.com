// Contract-conforming stand-in for the account endpoints (and whoami) of the API, mounted on the content stub (the real API is exercised by its own
// integration tests and `pnpm smoke`). It behaves like the API where the web app depends on it: the bearer token is required, the role named in
// x-active-role must be an ACTIVE role of the account (403 ACCOUNT_ROLE_NOT_HELD otherwise), the role switch validates and persists nothing.
import type http from 'node:http';
import { CORRELATION_HEADER, UpdateProfileRequest, type AccountDto, type AccountEmailDetailDto } from '@bananagig/contracts';
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
  /** The email verification state GET /api/v1/account/email reports (ID-002). */
  email: AccountEmailDetailDto;
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
    mode: 'up',
    whoami: true,
    reset() {
      api.calls.length = 0;
      api.account = accountDto();
      api.email = emailDetail();
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
    return fail(404, 'ROUTE_NOT_FOUND', 'NOT_FOUND');
  };
  return api;
}
