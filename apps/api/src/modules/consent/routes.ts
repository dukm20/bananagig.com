// Consent API (ID-005, docs/engineering/CONSENT.md), registered under /api/v1: the caller's own relationship to the versions of the legal documents (CFG-002 owns the
// documents and their immutable versions; this layer binds an ACCOUNT to an exact version, locale and text hash in an append-only event log and derives the state).
//
// Every route acts on the account of the VERIFIED token (requireAccount); none accepts an account id, a subject or a role, and the time is never taken from the client. The
// only path parameter is the purpose code (a strict upper-snake token checked before Ajv); the only query parameter is `locale`; bodies are validated RAW and strictly
// (strictBody) before Ajv can coerce them. A purpose that does not exist is a 404 whatever its spelling class (a malformed code is a 400). Every response, errors
// included, is `Cache-Control: no-store`. Responses carry identifiers, the version number, the locale and the SHA-256 of the text: never the text itself. Failures are
// answered with fixed messages and a message key (see toAppError): no service message or detail, no hash and no version id is ever echoed back.
import type { FastifyInstance, FastifyRequest, preValidationAsyncHookHandler } from 'fastify';
import {
  AcceptConsentRequest,
  AcceptConsentResponse,
  AccountConsentsResponse,
  ConsentPurposeParam,
  ConsentRequirementsQuery,
  ConsentRequirementsResponse,
  PURPOSE_CODE_PATTERN,
  WithdrawConsentRequest,
  WithdrawConsentResponse,
} from '@bananagig/contracts';
import { AccountError, type ConsentOperations, type ConsentRequestContext } from '@bananagig/accounts';
import { AppError } from '../../errors';
import { requireAccount } from '../../plugins/account';
import { parseBody as parse, strictBody } from '../../plugins/strict-body';
import { authErrorResponses, errorResponses, errorSchema, schemaOf } from '../../schema';
import { toAppError } from '../account/dto';

const bearer = [{ bearerAuth: [] }];
/** 401 (missing or invalid token, SESSION_REVOKED), 400, 403 (admin context, suspended or closed account), 404, 409, 503. */
const failures = { ...authErrorResponses, 400: errorResponses[400], 403: errorSchema, 404: errorResponses[404], 409: errorSchema };
const meta = (req: FastifyRequest) => ({ correlationId: req.correlationId });
const realmOf = (req: FastifyRequest): string => (req.server as unknown as { authRealm: string }).authRealm;

/** Largest body any consent route can legitimately receive (the accept body is about 150 bytes): far below the default limit. */
export const CONSENT_BODY_LIMIT = 2048;

/** The only service detail a non-consent failure may keep: short machine tokens (`reason`, `field`). Everything else (a constraint name, a cause, a value) is dropped. */
const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const sanitizeOther = (err: AccountError): AccountError => {
  const details: Record<string, unknown> = {};
  for (const k of ['reason', 'field'] as const) {
    const v = err.details[k];
    if (typeof v === 'string' && SAFE_TOKEN.test(v)) details[k] = v;
  }
  return new AccountError(err.code, 'The consent request could not be processed', details);
};
/**
 * Runs a service call and maps typed failures onto the API error model. The consent codes are mapped by toAppError (fixed message, message key only); any other typed
 * account failure (a closed account, an unavailable policy) keeps its code but loses the service message and every detail except a `reason` and a `field` token.
 */
const runFor =
  (req: FastifyRequest) =>
  <T>(fn: () => Promise<T>): Promise<T> =>
    fn().catch((err: unknown) => {
      if (err instanceof AccountError && !err.code.startsWith('CONSENT_')) return toAppError(sanitizeOther(err), realmOf(req));
      return toAppError(err, realmOf(req));
    });

/** Facts the service may record: the application session of the request (ID-004), when there is one. Never an address, a user agent or a time. */
const contextOf = (req: FastifyRequest): ConsentRequestContext => {
  const applicationSessionId = req.securitySession?.applicationSessionId;
  return applicationSessionId === undefined ? {} : { applicationSessionId };
};

const validationFailed = (issues: { path: string; message: string }[]): AppError =>
  new AppError('VALIDATION', 'VALIDATION_FAILED', 'Request validation failed', { issues });

/** Strict path parameter: the purpose is a stable upper-snake code, checked lexically against the contract BEFORE Ajv; the issue names the parameter, never its value. */
const strictPurposeParam: preValidationAsyncHookHandler = async (req) => {
  if (!ConsentPurposeParam.safeParse(req.params).success) throw validationFailed([{ path: 'params.purpose', message: 'must be a purpose code' }]);
};

/** A locale tag as stored in `content.locales` (BCP 47: letters and digits in subtags): validated again against the registered locales by the service, which never falls back. */
const LOCALE_TAG = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
/** Strict query: only `locale`, exactly once, a locale tag. A repeated key (an array), an unknown key or an empty value is a 400 before Ajv can coerce anything. */
const strictRequirementsQuery: preValidationAsyncHookHandler = async (req) => {
  const parsed = ConsentRequirementsQuery.safeParse(req.query);
  const locale = parsed.success ? parsed.data.locale : undefined;
  if (!parsed.success || (locale !== undefined && !LOCALE_TAG.test(locale)))
    throw validationFailed([{ path: 'querystring.locale', message: 'must be a locale tag, given once, and nothing else may be sent' }]);
};

/** For the withdraw route: no body, or exactly `{}`. Anything else is a 400 (the rejected value is never echoed). */
const noBody: preValidationAsyncHookHandler = async (req) => {
  parse(WithdrawConsentRequest, req.body === undefined ? {} : req.body);
};

const purposeParams = {
  type: 'object',
  properties: {
    purpose: {
      type: 'string',
      minLength: 2,
      maxLength: 64,
      pattern: PURPOSE_CODE_PATTERN.source,
      description: 'The purpose code (upper snake case), for example TERMS_OF_SERVICE.',
    },
  },
  required: ['purpose'],
  additionalProperties: false,
};

export async function consentRoutes(app: FastifyInstance): Promise<void> {
  // the responses (and the error bodies) concern one person's legal acceptances: never stored by a shared cache or the browser
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });
  const tags = ['consent'];
  const svc = (req: FastifyRequest): ConsentOperations => req.server.consent;
  const accountId = (req: FastifyRequest): string => req.account!.accountId;

  app.get(
    '/account/consents',
    {
      preValidation: requireAccount(),
      schema: {
        operationId: 'getAccountConsents',
        summary:
          "The caller's own consents: the derived current state of every purpose that is active or has events (NONE, ACCEPTED or WITHDRAWN, from the latest event, with whether it can be withdrawn) and the whole append-only history of acceptances and withdrawals, newest first. Each event is bound to the exact document version (id, number, locale) and the SHA-256 of its text; the text itself is never returned here (read it from the content registry)",
        tags,
        security: bearer,
        querystring: { type: 'object', properties: {}, additionalProperties: false },
        response: { 200: schemaOf(AccountConsentsResponse), ...failures },
      },
    },
    async (req) => ({ data: await runFor(req)(() => svc(req).getConsents(accountId(req))), meta: meta(req) }),
  );

  app.get(
    '/account/consents/requirements',
    {
      preValidation: [requireAccount(), strictRequirementsQuery],
      schema: {
        operationId: 'getAccountConsentRequirements',
        summary:
          "What the caller must accept now, evaluated for the roles of the account (pending and active) against the configured policy: per active purpose whether it is required, its status (NOT_REQUIRED, SATISFIED, OUTSTANDING, REACCEPTANCE_REQUIRED, DOCUMENT_UNAVAILABLE), the account's acceptance state, the version in force in the evaluated locale (id, number, locale, SHA-256, effective from) and the account's latest acceptance. `locale` selects the language (default: the preferred locale of the account, else the platform default); legal documents never fall back to another locale. `satisfied` is true when every required purpose is satisfied",
        tags,
        security: bearer,
        querystring: {
          type: 'object',
          properties: {
            locale: {
              type: 'string',
              minLength: 2,
              maxLength: 35,
              pattern: LOCALE_TAG.source,
              description: 'A locale tag registered in the content registry (for example en-US). Given at most once.',
            },
          },
          additionalProperties: false,
        },
        response: { 200: schemaOf(ConsentRequirementsResponse), ...failures },
      },
    },
    async (req) => {
      const { locale } = req.query as { locale?: string };
      return { data: await runFor(req)(() => svc(req).getRequirements(accountId(req), locale === undefined ? {} : { locale })), meta: meta(req) };
    },
  );

  app.post(
    '/account/consents/:purpose/accept',
    {
      bodyLimit: CONSENT_BODY_LIMIT,
      preValidation: [requireAccount(), strictPurposeParam, strictBody(AcceptConsentRequest)],
      schema: {
        operationId: 'acceptAccountConsent',
        summary:
          "Record that the caller accepted the exact document version it was shown: `versionId`, `locale` and `bodySha256` (the SHA-256 of the text, lower-case hex). The account comes from the token and the time from the server. The version must belong to the purpose's document, be in force now in the platform scope, and carry that locale and hash (400 ACCOUNT_CONSENT_LOCALE_MISMATCH or ACCOUNT_CONSENT_HASH_MISMATCH otherwise; 404 ACCOUNT_CONSENT_VERSION_NOT_FOUND for an unknown or unpublished version, whatever the reason; 409 ACCOUNT_CONSENT_VERSION_NOT_CURRENT for a published version that is superseded or not yet effective; 409 ACCOUNT_CONSENT_PURPOSE_INACTIVE). Repeating the same acceptance is idempotent (`changed` false, nothing written). Nothing is ever accepted by default: only this explicit call records consent",
        tags,
        security: bearer,
        params: purposeParams,
        body: schemaOf(AcceptConsentRequest),
        response: { 200: schemaOf(AcceptConsentResponse), ...failures },
      },
    },
    async (req) => {
      const { purpose } = req.params as { purpose: string };
      const body = parse(AcceptConsentRequest, req.body);
      // a UUID is compared in its canonical lower-case form; the locale and the hash are compared exactly by the service (nothing else is normalized)
      const input = { versionId: body.versionId.toLowerCase(), locale: body.locale, bodySha256: body.bodySha256 };
      return { data: await runFor(req)(() => svc(req).accept(accountId(req), purpose, input, contextOf(req))), meta: meta(req) };
    },
  );

  app.post(
    '/account/consents/:purpose/withdraw',
    {
      bodyLimit: CONSENT_BODY_LIMIT,
      preValidation: [requireAccount(), strictPurposeParam, noBody],
      schema: {
        operationId: 'withdrawAccountConsent',
        summary:
          'Withdraw the accepted consent of a withdrawable purpose. Refused (409) when the purpose cannot be withdrawn (ACCOUNT_CONSENT_NOT_WITHDRAWABLE), when nothing is accepted (ACCOUNT_CONSENT_NOT_ACCEPTED) and while a role of the account requires it (ACCOUNT_CONSENT_REQUIRED_FOR_ROLE). Repeating a withdrawal is idempotent (`changed` false). The request takes no body (none, or exactly {})',
        tags,
        security: bearer,
        params: purposeParams,
        response: { 200: schemaOf(WithdrawConsentResponse), ...failures },
      },
    },
    async (req) => {
      const { purpose } = req.params as { purpose: string };
      return { data: await runFor(req)(() => svc(req).withdraw(accountId(req), purpose, contextOf(req))), meta: meta(req) };
    },
  );
}
