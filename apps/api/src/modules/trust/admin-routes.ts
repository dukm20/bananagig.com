// Verification administration API (TRUST-001), registered under /api/v1/admin/trust for admin identities with the `trust-*` client roles (TRUST_PERMISSIONS): `trust-read` lists
// cases and shows document METADATA; `trust-review` decides requirements and downloads evidence (an audited, short-lived link); `trust-admin` manages the requirement policy and
// sees no evidence. A provider token is refused (403). The reviewers see an internal account id only: no name, email, phone or profile. Every response is `Cache-Control: no-store`.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ApproveRequirementRequest,
  envelope,
  RejectRequirementRequest,
  RequestActionRequest,
  SetRequirementRuleRequest,
  SetRequirementStatusRequest,
  StartReviewRequest,
  TRUST_CASE_STATUSES,
  TrustCaseDetailResponse,
  TrustCaseListResponse,
  TrustDownloadResponse,
  TrustPolicyResponse,
  TrustRequirementDecisionResponse,
  type TrustCaseStatus,
} from '@bananagig/contracts';
import type { TrustService } from '@bananagig/trust';
import { requireTrustPermission } from '../../plugins/auth';
import { integerParamSchema, strictIntegerParams } from '../../plugins/strict-params';
import { parseBody as parse, strictBody } from '../../plugins/strict-body';
import { authErrorResponses, errorResponses, errorSchema, schemaOf } from '../../schema';
import { z } from 'zod';
import { caseDetailDto, caseSummaryDto, decisionDto, policyDto, toAppError } from './dto';
import { TRUST_BODY_LIMIT } from './routes';

const bearer = [{ bearerAuth: [] }];
const failures = { ...authErrorResponses, 400: errorResponses[400], 403: errorSchema, 404: errorResponses[404], 409: errorSchema, 503: errorSchema };
const meta = (req: FastifyRequest) => ({ correlationId: req.correlationId });
const run = <T>(fn: () => Promise<T>): Promise<T> => fn().catch(toAppError);
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const idParams = { type: 'object', properties: { id: { type: 'string', pattern: UUID_PATTERN } }, required: ['id'], additionalProperties: false } as const;
const codeParams = {
  type: 'object',
  properties: { code: { type: 'string', pattern: '^[a-z][a-z0-9]*(_[a-z0-9]+)*$', minLength: 2, maxLength: 48 } },
  required: ['code'],
  additionalProperties: false,
} as const;

const RuleResultResponse = envelope(
  z.object({
    requirementCode: z.string(),
    marketCode: z.string().nullable(),
    serviceTypeCode: z.string().nullable(),
    enabled: z.boolean(),
    changed: z.boolean(),
  }),
);
const StatusResultResponse = envelope(z.object({ code: z.string(), status: z.string(), changed: z.boolean() }));

export interface TrustAdminRouteDeps {
  trust: TrustService;
}

export async function trustAdminRoutes(app: FastifyInstance, deps: TrustAdminRouteDeps): Promise<void> {
  const svc = deps.trust;
  const tags = ['trust'];
  const reviewer = (req: FastifyRequest): string => req.principal!.subject;
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get(
    '/cases',
    {
      preValidation: [requireTrustPermission('read'), strictIntegerParams({ limit: { min: 1, max: 100 } }, 'querystring')],
      schema: {
        operationId: 'listTrustCases',
        summary:
          'The verification cases for the reviewers (trust-read): newest submissions first, optionally one status, at most `limit` (default 50, max 100). The internal account id only; no name or contact.',
        tags,
        security: bearer,
        querystring: {
          type: 'object',
          properties: { status: { type: 'string', enum: [...TRUST_CASE_STATUSES] }, limit: integerParamSchema({ min: 1, max: 100 }) },
          additionalProperties: false,
        },
        response: { 200: schemaOf(TrustCaseListResponse), ...failures },
      },
    },
    async (req) => {
      const q = req.query as { status?: TrustCaseStatus; limit?: number };
      return { data: (await run(() => svc.listCases({ status: q.status, limit: q.limit }))).map(caseSummaryDto), meta: meta(req) };
    },
  );

  app.get(
    '/cases/:id',
    {
      preValidation: requireTrustPermission('read'),
      schema: {
        operationId: 'getTrustCase',
        summary:
          'One case (trust-read): every cycle of every requirement, the reviews, the document metadata (no file, no key, no link) and the external references.',
        tags,
        security: bearer,
        params: idParams,
        querystring: { type: 'object', properties: {}, additionalProperties: false },
        response: { 200: schemaOf(TrustCaseDetailResponse), ...failures },
      },
    },
    async (req) => ({ data: caseDetailDto(await run(() => svc.getCase((req.params as { id: string }).id))), meta: meta(req) }),
  );

  app.get(
    '/documents/:id/download',
    {
      preValidation: requireTrustPermission('review'),
      schema: {
        operationId: 'downloadTrustDocument',
        summary:
          'A short-lived link to ONE document (trust-review). The access is audited before the link is created; the document must be finalized and clean. The link is an attachment, is not stored or logged and expires per policy.',
        tags,
        security: bearer,
        params: idParams,
        querystring: { type: 'object', properties: {}, additionalProperties: false },
        response: { 200: schemaOf(TrustDownloadResponse), ...failures },
      },
    },
    async (req) => ({ data: await run(() => svc.downloadDocument(reviewer(req), (req.params as { id: string }).id)), meta: meta(req) }),
  );

  const decision = (
    path: string,
    operationId: string,
    summary: string,
    schema: Parameters<typeof strictBody>[0],
    call: (subject: string, id: string, body: unknown) => Promise<Parameters<typeof decisionDto>[0]>,
  ) =>
    app.post(
      path,
      {
        bodyLimit: TRUST_BODY_LIMIT,
        preValidation: [requireTrustPermission('review'), strictBody(schema)],
        schema: {
          operationId,
          summary,
          tags,
          security: bearer,
          params: idParams,
          body: schemaOf(schema),
          response: { 200: schemaOf(TrustRequirementDecisionResponse), ...failures },
        },
      },
      async (req) => ({ data: decisionDto(await run(() => call(reviewer(req), (req.params as { id: string }).id, parse(schema, req.body)))), meta: meta(req) }),
    );
  decision(
    '/requirements/:id/start-review',
    'startTrustReview',
    'Start the review of a submitted requirement (trust-review); names the evidence round. Idempotent for a review already started in that round.',
    StartReviewRequest,
    (s, id, b) => svc.startReview(s, id, b),
  );
  decision(
    '/requirements/:id/approve',
    'approveTrustRequirement',
    'Approve the evidence of the named round (trust-review). The approval carries an end date when the requirement expires (required if the definition says so). A decision on stale evidence is 409; a repeat of the same decision is a no-op.',
    ApproveRequirementRequest,
    (s, id, b) => svc.approveRequirement(s, id, b),
  );
  decision(
    '/requirements/:id/reject',
    'rejectTrustRequirement',
    'Refuse the evidence of the named round with a structured reason (trust-review). The provider may resubmit.',
    RejectRequirementRequest,
    (s, id, b) => svc.rejectRequirement(s, id, b),
  );
  decision(
    '/requirements/:id/request-action',
    'requestTrustAction',
    'Ask the provider for more with a structured reason (trust-review). The provider resubmits.',
    RequestActionRequest,
    (s, id, b) => svc.requestAction(s, id, b),
  );

  app.get(
    '/policy',
    {
      preValidation: requireTrustPermission('admin'),
      schema: {
        operationId: 'getTrustPolicy',
        summary: 'The requirement policy (trust-admin): the definitions, the rules that say where each applies, and the document types.',
        tags,
        security: bearer,
        querystring: { type: 'object', properties: {}, additionalProperties: false },
        response: { 200: schemaOf(TrustPolicyResponse), ...failures },
      },
    },
    async (req) => ({ data: policyDto(await run(() => svc.getPolicy())), meta: meta(req) }),
  );

  app.put(
    '/requirement-definitions/:code/status',
    {
      bodyLimit: TRUST_BODY_LIMIT,
      preValidation: [requireTrustPermission('admin'), strictBody(SetRequirementStatusRequest)],
      schema: {
        operationId: 'setTrustRequirementStatus',
        summary:
          'Turn a requirement definition on or off, or retire it (trust-admin). Cases adopt the change when they are next evaluated. Audited; idempotent.',
        tags,
        security: bearer,
        params: codeParams,
        body: schemaOf(SetRequirementStatusRequest),
        response: { 200: schemaOf(StatusResultResponse), ...failures },
      },
    },
    async (req) => ({
      data: await run(() => svc.setRequirementStatus(reviewer(req), (req.params as { code: string }).code, parse(SetRequirementStatusRequest, req.body))),
      meta: meta(req),
    }),
  );

  app.put(
    '/requirement-rules',
    {
      bodyLimit: TRUST_BODY_LIMIT,
      preValidation: [requireTrustPermission('admin'), strictBody(SetRequirementRuleRequest)],
      schema: {
        operationId: 'setTrustRequirementRule',
        summary:
          'Require (or stop requiring) a definition for a market and/or a service type, null meaning all (trust-admin). A rule is switched off, never deleted. Audited; idempotent.',
        tags,
        security: bearer,
        body: schemaOf(SetRequirementRuleRequest),
        response: { 200: schemaOf(RuleResultResponse), ...failures },
      },
    },
    async (req) => ({ data: await run(() => svc.setRequirementRule(reviewer(req), parse(SetRequirementRuleRequest, req.body))), meta: meta(req) }),
  );
}
