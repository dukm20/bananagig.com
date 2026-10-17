// Provider registration API (PRO-001, docs/engineering/PROVIDER_REGISTRATION.md), registered under /api/v1/provider: the caller's own registration as a provider. A provider is
// NOT a second account: every route acts on the account of the VERIFIED token (requireAccount) and none accepts an account id, a registration id, a role, a status or a
// completion flag. The role, the contact state, the consent state, the market and the service types are decided by their owners and by the configured policy, on the server.
// The registration does not depend on the active role (a customer starts it), so the active-role header is not honoured here. Every response, errors included, is
// `Cache-Control: no-store`. Bodies are validated RAW and strictly (strictBody) before Ajv can coerce them.
import type { FastifyInstance, FastifyRequest, preValidationAsyncHookHandler } from 'fastify';
import {
  CancelProviderRegistrationRequest,
  ProviderRegistrationStateResponse,
  ProviderRequirementsQuery,
  ProviderRequirementsResponse,
  ReplaceProviderServicesRequest,
  SelectProviderMarketRequest,
  StartProviderRegistrationRequest,
  SubmitProviderRegistrationRequest,
} from '@bananagig/contracts';
import type { AccountFacts, ProviderRegistrationService } from '@bananagig/provider';
import { AppError } from '../../errors';
import { requireAccount } from '../../plugins/account';
import { parseBody as parse, strictBody } from '../../plugins/strict-body';
import { authErrorResponses, errorResponses, errorSchema, schemaOf } from '../../schema';
import { requirementsDto, stateDto, toAppError } from './dto';

const bearer = [{ bearerAuth: [] }];
/** 401 (missing or invalid token), 400, 403 (admin context, suspended or closed account), 404, 409, 503. */
const failures = { ...authErrorResponses, 400: errorResponses[400], 403: errorSchema, 404: errorResponses[404], 409: errorSchema };
const meta = (req: FastifyRequest) => ({ correlationId: req.correlationId });
const run = <T>(fn: () => Promise<T>): Promise<T> => fn().catch(toAppError);

/** Largest body any registration route can legitimately receive (50 service type codes of at most 48 characters): far below the default limit. */
export const PROVIDER_BODY_LIMIT = 8192;

const LOCALE_TAG = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const validationFailed = (issues: { path: string; message: string }[]): AppError =>
  new AppError('VALIDATION', 'VALIDATION_FAILED', 'Request validation failed', { issues });
/** Strict query: only `locale`, exactly once, a locale tag. */
const strictQuery: preValidationAsyncHookHandler = async (req) => {
  const parsed = ProviderRequirementsQuery.safeParse(req.query);
  const locale = parsed.success ? parsed.data.locale : undefined;
  if (!parsed.success || (locale !== undefined && !LOCALE_TAG.test(locale)))
    throw validationFailed([{ path: 'querystring.locale', message: 'must be a locale tag, given once, and nothing else may be sent' }]);
};
/** A body-less POST is accepted (no body or exactly `{}`); anything else is validated strictly. */
const optionalBody =
  (schema: Parameters<typeof parse>[0]): preValidationAsyncHookHandler =>
  async (req) => {
    parse(schema, req.body === undefined || req.body === null ? {} : req.body);
  };

/** The account facts the request guard already loaded (no second read for a GET). */
const factsOf = (req: FastifyRequest): AccountFacts => {
  const a = req.account!;
  return {
    accountId: a.accountId,
    status: a.status,
    memberships: a.memberships.map((m) => ({ code: m.code, status: m.status })),
    emailVerified: a.contacts.emailVerified,
    phoneVerified: a.contacts.phoneVerified,
  };
};

export interface ProviderRouteDeps {
  registrations: ProviderRegistrationService;
}

export async function providerRoutes(app: FastifyInstance, deps: ProviderRouteDeps): Promise<void> {
  const svc = deps.registrations;
  const tags = ['provider'];
  const accountId = (req: FastifyRequest): string => req.account!.accountId;
  const guard = requireAccount({ honorActiveRoleHeader: false });
  // the responses concern one person's onboarding: never stored by a shared cache or the browser
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get(
    '/registration',
    {
      preValidation: guard,
      schema: {
        operationId: 'getProviderRegistration',
        summary:
          "The caller's provider registration: the provider role as the account holds it (NONE, PENDING, ACTIVE or INACTIVE: the identity domain's membership, not a second status) and the latest attempt (IN_PROGRESS, COMPLETED or CANCELLED) with its market and selected service types, or null when the account never started. Owner only: there is no id in any path",
        tags,
        security: bearer,
        querystring: { type: 'object', properties: {}, additionalProperties: false },
        response: { 200: schemaOf(ProviderRegistrationStateResponse), ...failures },
      },
    },
    async (req) => ({ data: stateDto(await run(() => svc.getRegistration(accountId(req), { facts: factsOf(req) }))), meta: meta(req) }),
  );

  app.post(
    '/registration',
    {
      bodyLimit: PROVIDER_BODY_LIMIT,
      preValidation: [guard, optionalBody(StartProviderRegistrationRequest)],
      schema: {
        operationId: 'startProviderRegistration',
        summary:
          'Start (or resume) the provider registration of the caller. The same account, its CUSTOMER role, contacts, sessions and consent history are kept; the PROVIDER role is requested as PENDING (never activated here). Idempotent: a live registration (IN_PROGRESS or COMPLETED) is returned unchanged (200); a first start, or a restart after a cancellation (a NEW attempt), is 201. A deactivated provider role is refused (409 PROVIDER_ROLE_INACTIVE)',
        tags,
        security: bearer,
        response: { 200: schemaOf(ProviderRegistrationStateResponse), 201: schemaOf(ProviderRegistrationStateResponse), ...failures },
      },
    },
    async (req, reply) => {
      const r = await run(() => svc.startRegistration(accountId(req), {}));
      return reply.status(r.created ? 201 : 200).send({ data: stateDto(r.state), meta: meta(req) });
    },
  );

  app.put(
    '/registration/market',
    {
      bodyLimit: PROVIDER_BODY_LIMIT,
      preValidation: [guard, strictBody(SelectProviderMarketRequest)],
      schema: {
        operationId: 'selectProviderMarket',
        summary:
          'Choose the market where the provider plans to work. Needs the email and phone verified (as configured) and a market whose status the registration policy allows (ACTIVE and in effect by default; a PLANNED market such as one not yet launched is closed unless the policy says otherwise). `expectedRevision`, when present, must be the revision last read (409 PROVIDER_STALE_REGISTRATION). Idempotent for the same market. Already selected service types are kept; the requirements report the ones the new market does not offer',
        tags,
        security: bearer,
        body: schemaOf(SelectProviderMarketRequest),
        response: { 200: schemaOf(ProviderRegistrationStateResponse), ...failures },
      },
    },
    async (req) => ({ data: stateDto(await run(() => svc.selectMarket(accountId(req), parse(SelectProviderMarketRequest, req.body)))), meta: meta(req) }),
  );

  app.put(
    '/registration/services',
    {
      bodyLimit: PROVIDER_BODY_LIMIT,
      preValidation: [guard, strictBody(ReplaceProviderServicesRequest)],
      schema: {
        operationId: 'replaceProviderServices',
        summary:
          'Replace the WHOLE set of service types the provider plans to offer (codes of the catalogue). Needs a chosen market that still accepts providers, codes the market offers (ACTIVE service types enabled under an enabled ACTIVE category) and a count within the configured range. Atomic and idempotent: an equal set writes nothing. No Gig is created',
        tags,
        security: bearer,
        body: schemaOf(ReplaceProviderServicesRequest),
        response: { 200: schemaOf(ProviderRegistrationStateResponse), ...failures },
      },
    },
    async (req) => ({
      data: stateDto(await run(() => svc.replaceServiceTypes(accountId(req), parse(ReplaceProviderServicesRequest, req.body)))),
      meta: meta(req),
    }),
  );

  app.get(
    '/registration/requirements',
    {
      preValidation: [guard, strictQuery],
      schema: {
        operationId: 'getProviderRegistrationRequirements',
        summary:
          'The derived onboarding state: the status of every step (account, contact, legal, market, services, verification, subscription, profile, Gigs) composed from the domains that own them, whether the registration can be submitted and what blocks it. Contact and agreement state is READ from its owners, never stored here. Verification, subscription, profile and Gigs are not available yet and never block the registration. Go-Live eligibility is never evaluated here (goLive.eligible is false)',
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
              description: 'The locale the agreements are evaluated in (default: the account locale).',
            },
          },
          additionalProperties: false,
        },
        response: { 200: schemaOf(ProviderRequirementsResponse), ...failures },
      },
    },
    async (req) => {
      const { locale } = req.query as { locale?: string };
      return { data: requirementsDto(await run(() => svc.getRequirements(accountId(req), { locale, facts: factsOf(req) }))), meta: meta(req) };
    },
  );

  app.post(
    '/registration/submit',
    {
      bodyLimit: PROVIDER_BODY_LIMIT,
      preValidation: [guard, strictBody(SubmitProviderRegistrationRequest)],
      schema: {
        operationId: 'submitProviderRegistration',
        summary:
          'Submit the registration. The SERVER validates every step this registration owns or composes (account, contact, agreements, market, services) and completes it in one transaction, activating a PENDING provider role so the account may act as a provider. It does NOT verify, subscribe, publish or make the provider live. 409 PROVIDER_REGISTRATION_INCOMPLETE names the open steps. `expectedRevision` must be the revision last read. A repeat on a COMPLETED registration changes nothing',
        tags,
        security: bearer,
        body: schemaOf(SubmitProviderRegistrationRequest),
        response: { 200: schemaOf(ProviderRequirementsResponse), ...failures },
      },
    },
    async (req) => {
      const r = await run(() => svc.submitRegistration(accountId(req), parse(SubmitProviderRegistrationRequest, req.body)));
      return { data: requirementsDto(r.requirements), meta: meta(req) };
    },
  );

  app.post(
    '/registration/cancel',
    {
      bodyLimit: PROVIDER_BODY_LIMIT,
      preValidation: [guard, optionalBody(CancelProviderRegistrationRequest)],
      schema: {
        operationId: 'cancelProviderRegistration',
        summary:
          'Cancel an IN_PROGRESS registration. The account, the CUSTOMER role, the contacts and the consent history are untouched; a PENDING provider role stays PENDING. A restart is a new attempt. Idempotent on a cancelled registration; a COMPLETED registration is not cancelled here (409)',
        tags,
        security: bearer,
        response: { 200: schemaOf(ProviderRegistrationStateResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(CancelProviderRegistrationRequest, req.body === undefined || req.body === null ? {} : req.body);
      return { data: stateDto((await run(() => svc.cancelRegistration(accountId(req), body))).state), meta: meta(req) };
    },
  );
}
