// Phone contact and verification API (ID-003, docs/engineering/PHONE_VERIFICATION.md), registered under /api/v1/account.
//
// Every route acts on the account of the verified caller (requireAccount); none accepts an account id, a contact id or a subject. Bodies are validated RAW and
// strictly (strictBody) before Ajv can coerce them, so `{"code": 123456}` is a 400, never a coerced string. Responses carry the number MASKED only. The code appears
// in the request body of the confirm route and nowhere else: never in a URL, a log line, an error detail or a response.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AccountPhoneResponse,
  ConfirmPhoneCodeRequest,
  PhoneVerificationSentResponse,
  PhoneVerifiedResponse,
  SendPhoneVerificationRequest,
  SetPhoneRequest,
  SetPhoneResponse,
} from '@bananagig/contracts';
import { requireAccount } from '../../plugins/account';
import { parseBody as parse, strictBody } from '../../plugins/strict-body';
import { authErrorResponses, errorResponses, schemaOf } from '../../schema';
import { toAppError } from './dto';

const bearer = [{ bearerAuth: [] }];
const failures = {
  ...authErrorResponses,
  400: errorResponses[400],
  403: errorResponses[400],
  404: errorResponses[404],
  409: errorResponses[400],
  429: errorResponses[400],
};
const meta = (req: FastifyRequest) => ({ correlationId: req.correlationId });
const run = async <T>(fn: () => Promise<T>): Promise<T> => fn().catch(toAppError);
/** Facts for the abuse limits: the client address as Fastify resolves it from the EXACT trusted proxy hops (DEBT-0055). Hashed by the service; never stored or logged. */
const requestContext = (req: FastifyRequest) => {
  // the application device of the session (ID-004) feeds the per-device rate-limit dimension; absent without the security layer or before the browser registered
  const deviceId = req.securitySession?.accountDeviceId ?? undefined;
  return deviceId === undefined ? { clientIp: req.ip } : { clientIp: req.ip, deviceId };
};

export async function accountPhoneRoutes(app: FastifyInstance): Promise<void> {
  const tags = ['account'];
  const svc = (req: FastifyRequest) => req.server.phoneVerification;
  const accountId = (req: FastifyRequest): string => req.account!.accountId;
  const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

  app.get(
    '/account/phone',
    {
      preValidation: requireAccount(),
      schema: {
        operationId: 'getAccountPhone',
        summary:
          "The caller's own phone state for the verification screen: the verification status (NONE, PENDING, VERIFIED), the verified primary and the pending number (both MASKED, never the full number), when a new code may be requested, the wrong attempts left and the code length",
        tags,
        security: bearer,
        response: { 200: schemaOf(AccountPhoneResponse), ...failures },
      },
    },
    async (req) => {
      const d = await run(() => svc(req).getPhoneDetail(accountId(req)));
      return { data: { ...d, resendAvailableAt: iso(d.resendAvailableAt) }, meta: meta(req) };
    },
  );

  app.post(
    '/account/phone',
    {
      preValidation: [requireAccount(), strictBody(SetPhoneRequest)],
      schema: {
        operationId: 'setAccountPhone',
        summary:
          'Set the phone number to verify. The number is canonicalized to E.164 (an international +... number needs no country; a national number is read in `country`, else in the platform default country) and must belong to an ACTIVE country and satisfy the country/market line-type policy. Without a verified primary it becomes the pending first number (INITIAL_PHONE); with one it becomes a pending replacement (CHANGE_PHONE) and the verified number stays active until the new one verifies. Sends nothing: call the send operation next. The answer is the same whatever any other account holds',
        tags,
        security: bearer,
        body: schemaOf(SetPhoneRequest),
        response: { 200: schemaOf(SetPhoneResponse), ...failures, 503: errorResponses[503] },
      },
    },
    async (req) => {
      const body = parse(SetPhoneRequest, req.body);
      return { data: await run(() => svc(req).setPhone(accountId(req), body.phone, { country: body.country, ...requestContext(req) })), meta: meta(req) };
    },
  );

  app.post(
    '/account/phone/verification/send',
    {
      preValidation: [requireAccount(), strictBody(SendPhoneVerificationRequest)],
      schema: {
        operationId: 'sendAccountPhoneVerification',
        summary:
          "Send (or resend) the verification SMS for the account's pending number: one text with a one-time code. A resend supersedes the previous code. Enforces the resend cooldown and the hourly and daily caps (429 with Retry-After) from the configuration registry and the per-number budget across accounts",
        tags,
        security: bearer,
        body: schemaOf(SendPhoneVerificationRequest),
        response: { 200: schemaOf(PhoneVerificationSentResponse), ...failures, 503: errorResponses[503] },
      },
    },
    async (req) => {
      parse(SendPhoneVerificationRequest, req.body);
      const r = await run(() => svc(req).sendVerification(accountId(req), requestContext(req)));
      return {
        data: {
          sentAt: r.sentAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
          resendAvailableAt: r.resendAvailableAt.toISOString(),
          codeLength: r.codeLength,
          validityMinutes: r.validityMinutes,
          phone: r.phone,
        },
        meta: meta(req),
      };
    },
  );

  app.post(
    '/account/phone/verification/confirm-code',
    {
      preValidation: [requireAccount(), strictBody(ConfirmPhoneCodeRequest)],
      schema: {
        operationId: 'confirmAccountPhoneCode',
        summary:
          'Confirm the pending number with the code from the SMS. A wrong code is counted atomically and locks the verification at the configured maximum (429); an expired or used code has its own error. Repeating a successful confirmation is idempotent (changed=false)',
        tags,
        security: bearer,
        body: schemaOf(ConfirmPhoneCodeRequest),
        response: { 200: schemaOf(PhoneVerifiedResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(ConfirmPhoneCodeRequest, req.body);
      return { data: await run(() => svc(req).confirmCode(accountId(req), body.code, requestContext(req))), meta: meta(req) };
    },
  );
}
