// Email contact and verification API (ID-002, docs/engineering/EMAIL_VERIFICATION.md), registered under /api/v1/account.
//
// Every route acts on the account of the verified caller (requireAccount); none accepts an account id, a contact id or a subject. Bodies are validated
// RAW and strictly (strictBody) before Ajv can coerce them, so `{"code": 123456}` is a 400, never a coerced string. Responses carry the address MASKED only.
// The code and the magic token appear in the request bodies of the confirm routes and nowhere else: never in a URL this API sees, a log line, an error
// detail or a response. Confirmation is a POST because a GET that changes state is triggered by link scanners and prefetchers.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AccountEmailResponse,
  ConfirmEmailCodeRequest,
  ConfirmEmailLinkRequest,
  EmailVerificationSentResponse,
  EmailVerifiedResponse,
  SendEmailVerificationRequest,
  SetEmailRequest,
  SetEmailResponse,
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
/** Facts for the abuse limits: the client address as Fastify resolves it (trustProxy). Hashed by the service; never stored or logged. */
const requestContext = (req: FastifyRequest) => ({ clientIp: req.ip });

export async function accountEmailRoutes(app: FastifyInstance): Promise<void> {
  const tags = ['account'];
  const svc = (req: FastifyRequest) => req.server.emailVerification;
  const accountId = (req: FastifyRequest): string => req.account!.accountId;
  const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

  app.get(
    '/account/email',
    {
      preValidation: requireAccount(),
      schema: {
        operationId: 'getAccountEmail',
        summary:
          "The caller's own email state for the verification screen: the verification status (NONE, PENDING, VERIFIED), the verified primary and the pending address (both MASKED, never the full address), when a new code may be requested, the wrong attempts left and the code length",
        tags,
        security: bearer,
        response: { 200: schemaOf(AccountEmailResponse), ...failures },
      },
    },
    async (req) => {
      const d = await run(() => svc(req).getEmailDetail(accountId(req)));
      return { data: { ...d, resendAvailableAt: iso(d.resendAvailableAt) }, meta: meta(req) };
    },
  );

  app.post(
    '/account/email',
    {
      preValidation: [requireAccount(), strictBody(SetEmailRequest)],
      schema: {
        operationId: 'setAccountEmail',
        summary:
          'Set the email address to verify. Without a verified primary it becomes the pending first address (INITIAL_EMAIL); with one it becomes a pending replacement (CHANGE_EMAIL) and the verified address stays active until the new one verifies. Sends nothing: call the send operation next. The answer is the same whatever any other account holds',
        tags,
        security: bearer,
        body: schemaOf(SetEmailRequest),
        response: { 200: schemaOf(SetEmailResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(SetEmailRequest, req.body);
      return { data: await run(() => svc(req).setEmail(accountId(req), body.email, requestContext(req))), meta: meta(req) };
    },
  );

  app.post(
    '/account/email/verification/send',
    {
      preValidation: [requireAccount(), strictBody(SendEmailVerificationRequest)],
      schema: {
        operationId: 'sendAccountEmailVerification',
        summary:
          "Send (or resend) the verification email for the account's pending address: one message with a one-time code and a single-use magic link. A resend supersedes the previous code. Enforces the resend cooldown and the hourly and daily caps (429 with Retry-After) from the configuration registry",
        tags,
        security: bearer,
        body: schemaOf(SendEmailVerificationRequest),
        response: { 200: schemaOf(EmailVerificationSentResponse), ...failures, 503: errorResponses[503] },
      },
    },
    async (req) => {
      parse(SendEmailVerificationRequest, req.body);
      const r = await run(() => svc(req).sendVerification(accountId(req), requestContext(req)));
      return {
        data: {
          sentAt: r.sentAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
          resendAvailableAt: r.resendAvailableAt.toISOString(),
          codeLength: r.codeLength,
          validityMinutes: r.validityMinutes,
          email: r.email,
        },
        meta: meta(req),
      };
    },
  );

  app.post(
    '/account/email/verification/confirm-code',
    {
      preValidation: [requireAccount(), strictBody(ConfirmEmailCodeRequest)],
      schema: {
        operationId: 'confirmAccountEmailCode',
        summary:
          'Confirm the pending address with the code from the email. A wrong code is counted atomically and locks the verification at the configured maximum (429); an expired or used code has its own error. Repeating a successful confirmation is idempotent (changed=false)',
        tags,
        security: bearer,
        body: schemaOf(ConfirmEmailCodeRequest),
        response: { 200: schemaOf(EmailVerifiedResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(ConfirmEmailCodeRequest, req.body);
      return { data: await run(() => svc(req).confirmCode(accountId(req), body.code, requestContext(req))), meta: meta(req) };
    },
  );

  app.post(
    '/account/email/verification/confirm-link',
    {
      preValidation: [requireAccount(), strictBody(ConfirmEmailLinkRequest)],
      schema: {
        operationId: 'confirmAccountEmailLink',
        summary:
          'Confirm the pending address with the magic-link token from the email. The token travels in the body (never in a URL this API sees) and is single use; it must belong to the caller. A code and a link racing verify exactly once; the loser gets an idempotent success',
        tags,
        security: bearer,
        body: schemaOf(ConfirmEmailLinkRequest),
        response: { 200: schemaOf(EmailVerifiedResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(ConfirmEmailLinkRequest, req.body);
      return { data: await run(() => svc(req).confirmLink(accountId(req), body.token, requestContext(req))), meta: meta(req) };
    },
  );
}
