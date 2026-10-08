// Account API (docs/engineering/ACCOUNTS.md): the caller's OWN application account. Every route derives the account from the verified token
// (requireAccount); no route accepts an account id, a subject or a role claim from the client, and there is no endpoint that grants a role (granting is
// server-side: provider sign-up, support and tests call AccountService directly). Bodies are validated raw and strictly (strictBody) before Ajv can coerce them.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AccountResponse, ACTIVE_ROLE_HEADER, SetActiveRoleRequest, UpdateProfileRequest } from '@bananagig/contracts';
import { requireAccount } from '../../plugins/account';
import { parseBody as parse, strictBody } from '../../plugins/strict-body';
import { authErrorResponses, errorResponses, schemaOf } from '../../schema';
import { accountDto, toAppError } from './dto';
import { accountEmailRoutes } from './email-routes';

const bearer = [{ bearerAuth: [] }];
/** 401 missing or invalid token, 403 for the admin context, a suspended or closed account and a role the account does not hold, 409 conflicts. */
const failures = { ...authErrorResponses, 400: errorResponses[400], 403: errorResponses[400], 404: errorResponses[404], 409: errorResponses[400] };
const meta = (req: FastifyRequest) => ({ correlationId: req.correlationId });
const run = async <T>(fn: () => Promise<T>): Promise<T> => fn().catch(toAppError);
const activeRoleHeader = (req: FastifyRequest): string | undefined => {
  const h = req.headers[ACTIVE_ROLE_HEADER];
  return Array.isArray(h) ? h.join(',') : h;
};

export async function accountRoutes(app: FastifyInstance, opts: { emailRoutes?: boolean } = {}): Promise<void> {
  // the responses (and the error bodies) concern one person and carry the caller's own name: never stored by a shared cache or the browser
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });
  const tags = ['account'];
  const svc = (req: FastifyRequest) => req.server.accounts;
  if (opts.emailRoutes) await app.register(accountEmailRoutes);

  app.get(
    '/account/me',
    {
      preValidation: requireAccount({ includeProfile: true }),
      schema: {
        operationId: 'getAccountMe',
        summary:
          "The caller's own application account: id, status, ACTIVE application roles, preferred (primary) role, the role this request acts as, the core profile and the email verification state (status NONE, PENDING or VERIFIED, with the address masked). The account is created on the first authenticated request. The role named in the x-active-role header is accepted only when the account holds it as an ACTIVE role",
        description:
          'Application roles come from PostgreSQL, not from Keycloak. The admin identity context has no application account (403). A suspended or closed account is refused (403).',
        tags,
        security: bearer,
        querystring: { type: 'object', properties: {}, additionalProperties: false },
        headers: { type: 'object', properties: { [ACTIVE_ROLE_HEADER]: { type: 'string' } } },
        response: { 200: schemaOf(AccountResponse), ...failures },
      },
    },
    async (req) => ({ data: accountDto(req.account!), meta: meta(req) }),
  );

  app.post(
    '/account/active-role',
    {
      preValidation: [requireAccount({ honorActiveRoleHeader: false }), strictBody(SetActiveRoleRequest)],
      schema: {
        operationId: 'setAccountActiveRole',
        summary:
          "Switch the application role the caller acts as. The role must be an ACTIVE role of the caller's account (403 otherwise). This changes the application context only: it does not create a Keycloak login or session and persists nothing. The web server keeps the chosen role in its session and sends it as x-active-role",
        tags,
        security: bearer,
        body: schemaOf(SetActiveRoleRequest),
        response: { 200: schemaOf(AccountResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(SetActiveRoleRequest, req.body);
      return { data: accountDto(await run(() => svc(req).selectActiveRole(req.account!.accountId, body.role))), meta: meta(req) };
    },
  );

  app.put(
    '/account/profile',
    {
      preValidation: [requireAccount(), strictBody(UpdateProfileRequest)],
      schema: {
        operationId: 'updateAccountProfile',
        summary:
          "Replace the caller's own core profile: first and last name (trimmed, 1 to 50 characters each), optional preferred locale and time zone override (omitted or null clears them). Idempotent: an unchanged profile writes nothing. Returns the updated account",
        tags,
        security: bearer,
        body: schemaOf(UpdateProfileRequest),
        response: { 200: schemaOf(AccountResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(UpdateProfileRequest, req.body);
      const accountId = req.account!.accountId;
      await run(() => svc(req).upsertProfile(accountId, body, { actor: `account:${accountId}` }));
      const fresh = await run(() => svc(req).getAccountContext(accountId, { includeProfile: true, requestedRole: activeRoleHeader(req) }));
      return { data: accountDto(fresh), meta: meta(req) };
    },
  );
}
