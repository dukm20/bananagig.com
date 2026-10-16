// Account security API (ID-004, docs/engineering/SESSIONS_AND_MFA.md), registered under /api/v1: the application sessions of the caller, the browsers (devices) and the
// trusted-browser window, the second-factor state and its enrolment, the step-up state, the security timeline, and the PUBLIC password-reset request.
//
// Every route under /account/security acts on the account and the session of the VERIFIED token (requireAccount); none accepts an account id, a subject, a
// Keycloak session id or a role. Only application ids appear in a path (a session or a device of the caller's own account; another account's id is a 404, never a
// 403), and path parameters are strict UUIDs checked before Ajv. Bodies are validated RAW and strictly (strictBody) before Ajv can coerce them. Every response,
// errors included, is `Cache-Control: no-store`. Responses carry application ids and coarse families only: no token, no Keycloak session id, no device secret, no
// raw IP address, no raw user agent. The password-reset request answers 202 with ONE fixed body whatever the input is.
import type { FastifyInstance, FastifyRequest, preValidationAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import {
  DeviceRemovedResponse,
  DeviceTrustResponse,
  MfaEnrollmentResponse,
  PasswordResetAcceptedResponse,
  PasswordResetRequest,
  RegisterSessionRequest,
  RegisteredSessionResponse,
  RevokeAllSessionsRequest,
  SECURITY_ACTIVITY_MAX_LIMIT,
  SecurityActivityResponse,
  SecurityDeviceIdParam,
  SecurityDevicesResponse,
  SecurityOverviewResponse,
  SecuritySessionIdParam,
  SecuritySessionsResponse,
  SessionRevokedResponse,
  SessionsRevokedAllResponse,
  SignedOutResponse,
  StartMfaEnrollmentRequest,
  parseDecimalInteger,
} from '@bananagig/contracts';
import type { CurrentSession, SecurityOperations, SecurityRequestContext } from '@bananagig/accounts';
import { AppError } from '../../errors';
import { requireAccount } from '../../plugins/account';
import { parseBody as parse, strictBody } from '../../plugins/strict-body';
import { integerParamSchema, strictIntegerParams } from '../../plugins/strict-params';
import { requireRecentAuthentication } from '../../plugins/step-up';
import { authErrorResponses, errorResponses, errorSchema, schemaOf } from '../../schema';
import { toAppError } from '../account/dto';

const bearer = [{ bearerAuth: [] }];
/** 401 (missing or invalid token, SESSION_REVOKED, STEP_UP_REQUIRED), 400, 403 (admin context, suspended or closed account, MFA_ENROLLMENT_REQUIRED), 404, 409, 429, 503. */
const failures = {
  ...authErrorResponses,
  400: errorResponses[400],
  403: errorSchema,
  404: errorResponses[404],
  409: errorSchema,
  429: errorSchema,
};
const meta = (req: FastifyRequest) => ({ correlationId: req.correlationId });
const realmOf = (req: FastifyRequest): string => (req.server as unknown as { authRealm: string }).authRealm;
/** Runs a service call and maps typed failures onto the API error model; a SESSION_REVOKED carries the realm challenge. */
const runFor =
  (req: FastifyRequest) =>
  <T>(fn: () => Promise<T>): Promise<T> =>
    fn().catch((err: unknown) => toAppError(err, realmOf(req)));

/** The account and session of the VERIFIED token (requireAccount, with the security service wired, guarantees both). */
const currentOf = (req: FastifyRequest): CurrentSession => ({ accountId: req.account!.accountId, keycloakSessionId: req.principal!.sessionId! });
/** Facts for the abuse limits and the device dimension: the address as Fastify resolves it from the exact trusted hops, and the session's device. Never stored raw. */
const requestContext = (req: FastifyRequest): SecurityRequestContext => ({
  clientIp: req.ip,
  deviceId: req.securitySession?.accountDeviceId ?? undefined,
});

const EmptyBody = z.object({}).strict();
/** For routes that take no body: none, or exactly `{}`. Anything else is a 400 (the rejected value is never echoed). */
const noBody: preValidationAsyncHookHandler = async (req) => {
  parse(EmptyBody, req.body === undefined ? {} : req.body);
};

/** Strict path parameters: validated lexically against the contract (a canonical UUID) BEFORE Ajv; the issues name the parameter, never its value. */
const strictParams =
  (schema: z.ZodType): preValidationAsyncHookHandler =>
  async (req) => {
    const r = schema.safeParse(req.params);
    if (!r.success)
      throw new AppError('VALIDATION', 'VALIDATION_FAILED', 'Request validation failed', {
        issues: r.error.issues.map((i) => ({ path: `params.${i.path.join('.')}`.replace(/\.$/, ''), message: 'must be a UUID' })),
      });
  };
const uuidParams = (name: string) => ({
  type: 'object',
  properties: { [name]: { type: 'string', format: 'uuid' } },
  required: [name],
  additionalProperties: false,
});

/** `before` of the timeline: an ISO 8601 timestamp with a UTC offset (what `nextBefore` carries). A real calendar instant, never free text. */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
export const isIsoInstant = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 40) return false;
  const m = ISO_INSTANT.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const calendarOk = probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d && h < 24 && mi < 60 && s < 60;
  return calendarOk && Number.isFinite(Date.parse(value));
};
/** The cursor of the timeline (`nextBefore`): an ISO instant, optionally followed by `_` and the uuid of the last audit event (a tie-breaker for events of the same microsecond). */
const CURSOR_TIEBREAK = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const isActivityCursor = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 77) return false;
  const at = value.indexOf('_');
  if (at === -1) return isIsoInstant(value);
  return isIsoInstant(value.slice(0, at)) && CURSOR_TIEBREAK.test(value.slice(at + 1));
};
const strictActivityQuery: preValidationAsyncHookHandler = async (req) => {
  const before = (req.query as Record<string, unknown> | undefined)?.before;
  if (before !== undefined && !isActivityCursor(before))
    throw new AppError('VALIDATION', 'VALIDATION_FAILED', 'Request validation failed', {
      issues: [{ path: 'querystring.before', message: 'must be an ISO 8601 timestamp with a UTC offset, optionally followed by _ and an event id' }],
    });
};

export async function securityRoutes(app: FastifyInstance): Promise<void> {
  // the responses (and the error bodies) concern one person's sessions and devices: never stored by a shared cache or the browser
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });
  const tags = ['security'];
  const svc = (req: FastifyRequest): SecurityOperations => req.server.security;

  app.post(
    '/account/security/sessions/current',
    {
      preValidation: [requireAccount(), strictBody(RegisterSessionRequest)],
      schema: {
        operationId: 'registerAccountSecuritySession',
        summary:
          'Register the browser of this login. The web server sends the device secret it issued in an HttpOnly cookie (43 base64url characters) and the browser user agent; only a keyed hash of the secret is stored, and the user agent is reduced to a browser, operating system and device class and discarded. Idempotent: the first device of a session wins. Returns the application session id and whether the browser is currently trusted',
        tags,
        security: bearer,
        body: schemaOf(RegisterSessionRequest),
        response: { 200: schemaOf(RegisteredSessionResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(RegisterSessionRequest, req.body);
      const data = await runFor(req)(() =>
        svc(req).registerSession({ ...currentOf(req), deviceSecret: body.device, userAgent: body.userAgent }, requestContext(req)),
      );
      return { data, meta: meta(req) };
    },
  );

  app.get(
    '/account/security',
    {
      preValidation: requireAccount(),
      schema: {
        operationId: 'getAccountSecurity',
        summary:
          "The caller's own security overview: whether a second factor (authenticator app, recovery codes) is set up (asked of the identity provider; `mfa.available` is false when it cannot be asked), when the caller last authenticated and whether that included a second factor, until when that counts as recent for a sensitive action, the current session and browser, and the configured policy windows",
        tags,
        security: bearer,
        querystring: { type: 'object', properties: {}, additionalProperties: false },
        response: { 200: schemaOf(SecurityOverviewResponse), ...failures },
      },
    },
    async (req) => {
      const p = req.principal!;
      return { data: await runFor(req)(() => svc(req).getOverview(currentOf(req), { authTime: p.authTime, acr: p.acr })), meta: meta(req) };
    },
  );

  app.get(
    '/account/security/sessions',
    {
      preValidation: requireAccount(),
      schema: {
        operationId: 'listAccountSecuritySessions',
        summary:
          "The caller's own active sessions, the current one first and the rest by last activity, each with its coarse browser (browser family, operating system, device class) and whether that browser is trusted. Compared with the identity provider's own sessions when it can be reached (`reconciled`); sessions it no longer has are marked ended",
        tags,
        security: bearer,
        querystring: { type: 'object', properties: {}, additionalProperties: false },
        response: { 200: schemaOf(SecuritySessionsResponse), ...failures },
      },
    },
    async (req) => ({ data: await runFor(req)(() => svc(req).listSessions(currentOf(req))), meta: meta(req) }),
  );

  app.delete(
    '/account/security/sessions/:sessionId',
    {
      preValidation: [requireAccount(), strictParams(SecuritySessionIdParam)],
      schema: {
        operationId: 'revokeAccountSecuritySession',
        summary:
          "Sign out one of the caller's own sessions: it stops working on its next API request (a revoked session is refused with 401 SESSION_REVOKED even though its access token is still valid) and the identity provider's session is ended best effort (`keycloak`: ENDED, UNAVAILABLE or NOT_NEEDED). Idempotent (`changed` false when it was already revoked). A session of another account is a 404",
        tags,
        security: bearer,
        params: uuidParams('sessionId'),
        response: { 200: schemaOf(SessionRevokedResponse), ...failures },
      },
    },
    async (req) => {
      const { sessionId } = req.params as { sessionId: string };
      return { data: await runFor(req)(() => svc(req).revokeSession(currentOf(req), sessionId.toLowerCase())), meta: meta(req) };
    },
  );

  app.post(
    '/account/security/sessions/revoke-all',
    {
      preValidation: [requireAccount(), strictBody(RevokeAllSessionsRequest)],
      schema: {
        operationId: 'revokeAllAccountSecuritySessions',
        summary:
          "Sign out everywhere: revoke all of the caller's sessions except this one (`includeCurrent` false, the default) or including it. Also raises the account's revocation watermark so a session the API had not seen yet, authenticated before this moment, is refused when it first appears. The identity provider's sessions are ended best effort (`keycloak`)",
        tags,
        security: bearer,
        body: schemaOf(RevokeAllSessionsRequest),
        response: { 200: schemaOf(SessionsRevokedAllResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(RevokeAllSessionsRequest, req.body);
      return { data: await runFor(req)(() => svc(req).revokeAllSessions(currentOf(req), { includeCurrent: body.includeCurrent ?? false })), meta: meta(req) };
    },
  );

  app.post(
    '/account/security/sessions/current/sign-out',
    {
      preValidation: [requireAccount(), noBody],
      schema: {
        operationId: 'signOutCurrentAccountSecuritySession',
        summary:
          'Record that the caller signed out of THIS session (the web server calls it before it deletes its own session): the session is revoked with reason SIGN_OUT and the identity provider session is ended best effort. The request takes no body. Repeating it after the session was revoked is a 401 SESSION_REVOKED like any other request of a revoked session',
        tags,
        security: bearer,
        response: { 200: schemaOf(SignedOutResponse), ...failures },
      },
    },
    async (req) => ({ data: await runFor(req)(() => svc(req).signOutCurrentSession(currentOf(req))), meta: meta(req) }),
  );

  app.get(
    '/account/security/devices',
    {
      preValidation: requireAccount(),
      schema: {
        operationId: 'listAccountSecurityDevices',
        summary:
          "The caller's own browsers (devices): coarse browser, operating system and device class, when first and last seen, and whether each is trusted and until when. Removed browsers are not listed. A trusted browser is a record kept by BananaGig: it does NOT change when the sign-in service asks for a code and never satisfies a step-up check",
        tags,
        security: bearer,
        querystring: { type: 'object', properties: {}, additionalProperties: false },
        response: { 200: schemaOf(SecurityDevicesResponse), ...failures },
      },
    },
    async (req) => ({ data: await runFor(req)(() => svc(req).listDevices(currentOf(req))), meta: meta(req) }),
  );

  app.post(
    '/account/security/devices/current/trust',
    {
      preValidation: [requireAccount(), requireRecentAuthentication(), noBody],
      schema: {
        operationId: 'trustCurrentAccountSecurityDevice',
        summary:
          'Trust the current browser for the configured number of days (`session.trusted_browser_days`); trusting an already trusted browser extends the window. Needs a recent authentication (401 STEP_UP_REQUIRED otherwise) and a registered browser (409 ACCOUNT_DEVICE_REQUIRED). This is a record kept by BananaGig: it does NOT make the sign-in service skip its code prompt and never satisfies a step-up check. The request takes no body',
        tags,
        security: bearer,
        response: { 200: schemaOf(DeviceTrustResponse), ...failures },
      },
    },
    async (req) => ({ data: await runFor(req)(() => svc(req).trustCurrentDevice(currentOf(req))), meta: meta(req) }),
  );

  app.delete(
    '/account/security/devices/current/trust',
    {
      preValidation: requireAccount(),
      schema: {
        operationId: 'untrustCurrentAccountSecurityDevice',
        summary:
          'Stop trusting the current browser. Idempotent: an untrusted browser stays untrusted and nothing is recorded. 409 ACCOUNT_DEVICE_REQUIRED when the session has no registered browser',
        tags,
        security: bearer,
        response: { 200: schemaOf(DeviceTrustResponse), ...failures },
      },
    },
    async (req) => ({ data: await runFor(req)(() => svc(req).untrustCurrentDevice(currentOf(req))), meta: meta(req) }),
  );

  app.delete(
    '/account/security/devices/:deviceId',
    {
      preValidation: [requireAccount(), strictParams(SecurityDeviceIdParam)],
      schema: {
        operationId: 'removeAccountSecurityDevice',
        summary:
          "Forget one of the caller's own browsers: it stops being trusted, is marked removed and its sessions are revoked (the identity provider sessions are ended best effort). Idempotent (`changed` false when already removed). A device of another account is a 404",
        tags,
        security: bearer,
        params: uuidParams('deviceId'),
        response: { 200: schemaOf(DeviceRemovedResponse), ...failures },
      },
    },
    async (req) => {
      const { deviceId } = req.params as { deviceId: string };
      return { data: await runFor(req)(() => svc(req).removeDevice(currentOf(req), deviceId.toLowerCase())), meta: meta(req) };
    },
  );

  app.get(
    '/account/security/activity',
    {
      preValidation: [requireAccount(), strictIntegerParams({ limit: { min: 1, max: SECURITY_ACTIVITY_MAX_LIMIT } }, 'querystring'), strictActivityQuery],
      schema: {
        operationId: 'listAccountSecurityActivity',
        summary:
          "The caller's own security timeline, newest first, for the configured period (`security.activity_log_days`): sign-ins, sign-outs, revocations, browser trust changes, second-factor and password changes, password reset requests and contact changes. Page backwards with `before` (the `nextBefore` of the previous page). Entries carry the coarse browser only, never an IP address or a user agent",
        tags,
        security: bearer,
        querystring: {
          type: 'object',
          properties: {
            limit: integerParamSchema({ min: 1, max: SECURITY_ACTIVITY_MAX_LIMIT }),
            before: {
              type: 'string',
              maxLength: 77,
              description:
                'The `nextBefore` of the previous page: an ISO 8601 timestamp with a UTC offset (up to 6 fractional digits), optionally followed by `_` and an event UUID; only events strictly older are returned. Pass it back unchanged.',
            },
          },
          additionalProperties: false,
        },
        response: { 200: schemaOf(SecurityActivityResponse), ...failures },
      },
    },
    async (req) => {
      const q = req.query as { limit?: number | string; before?: string };
      // `limit` was checked lexically by strictIntegerParams; it is converted from that checked text here, never trusted from Ajv's coercion alone
      const limit = q.limit === undefined ? undefined : (parseDecimalInteger(String(q.limit), { min: 1, max: SECURITY_ACTIVITY_MAX_LIMIT }) ?? undefined);
      return {
        data: await runFor(req)(() => svc(req).listActivity(req.account!.accountId, { limit, before: q.before })),
        meta: meta(req),
      };
    },
  );

  app.post(
    '/account/security/mfa/enrollment',
    {
      preValidation: [requireAccount(), requireRecentAuthentication(), strictBody(StartMfaEnrollmentRequest)],
      schema: {
        operationId: 'startAccountSecurityMfaEnrollment',
        summary:
          'Start setting up a second factor (`TOTP` authenticator app or `RECOVERY_CODES`). Needs a recent authentication (401 STEP_UP_REQUIRED otherwise). Records the request and returns the identity provider action the web server must send the browser to (`kc_action`); the secret and the codes are created and shown by the identity provider and BananaGig never sees or stores them',
        tags,
        security: bearer,
        body: schemaOf(StartMfaEnrollmentRequest),
        response: { 200: schemaOf(MfaEnrollmentResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(StartMfaEnrollmentRequest, req.body);
      return { data: await runFor(req)(() => svc(req).startMfaEnrollment(currentOf(req), body.method)), meta: meta(req) };
    },
  );
}

/** PUBLIC password-reset request: no token, no session, no account route. Its own plugin so the authenticated routes' hooks never apply to it. */
export async function passwordResetRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.post(
    '/auth/password-reset',
    {
      // a body is one email address: far below the default limit
      bodyLimit: 2048,
      preValidation: strictBody(PasswordResetRequest),
      schema: {
        operationId: 'requestPasswordReset',
        summary:
          'Ask for a password reset email. Public. The answer is ALWAYS the same 202 body and status, whether or not the address belongs to an account and whatever the account state: nothing here reveals who has an account. The email is sent by the identity provider only to the verified address of an account, as a single-use link that expires after the configured time. Limited per address and per source (429 with Retry-After; 503 when the limit cannot be applied, because every request can send an email). An email that is not a valid address gets the same 202 as any other',
        tags: ['security'],
        security: [],
        body: schemaOf(PasswordResetRequest),
        response: { 202: schemaOf(PasswordResetAcceptedResponse), 400: errorResponses[400], 429: errorSchema, 503: errorResponses[503] },
      },
    },
    async (req, reply) => {
      const body = parse(PasswordResetRequest, req.body);
      // `req.ip` is the address Fastify resolves from the EXACT trusted proxy hops (TRUSTED_PROXY_HOPS, DEBT-0055). The service's per-source bucket is only as good as
      // this address: with the wrong hop count every visitor shares the proxy's address (one bucket for all) or a client picks its own (no limit at all).
      await runFor(req)(() => req.server.security.requestPasswordReset(body.email, { clientIp: req.ip }));
      return reply.code(202).send({ data: { accepted: true }, meta: meta(req) });
    },
  );
}
