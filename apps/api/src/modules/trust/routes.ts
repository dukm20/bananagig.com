// Provider verification API (TRUST-001, docs/engineering/TRUST_VERIFICATION.md), registered under /api/v1/provider/verification: the caller's own verification. Every route acts on
// the account of the VERIFIED token (requireAccount) and none accepts an account id, a case id, a requirement id, a status or a decision: the case is the caller's live case, a
// document is found through its owner (someone else's document is "not found"), and a provider can never approve, reject, change the policy or see an administrator's view.
// Nothing returned carries an object key, a hash or a document; the only link is the one-time upload authorization to its caller. Every response, errors included, is
// `Cache-Control: no-store`. Bodies are validated RAW and strictly (strictBody) before Ajv can coerce them.
import type { FastifyInstance, FastifyRequest, preValidationAsyncHookHandler } from 'fastify';
import {
  CancelVerificationRequest,
  DocumentUploadAuthorizationResponse,
  ExternalVerificationResponse,
  FinalizeDocumentRequest,
  OpenVerificationRequest,
  ProviderVerificationResponse,
  RequestDocumentUploadRequest,
  ReverifyRequirementRequest,
  StartExternalVerificationRequest,
  SubmitVerificationRequest,
  VerificationDocumentListResponse,
  VerificationDocumentResponse,
} from '@bananagig/contracts';
import type { TrustService } from '@bananagig/trust';
import { requireAccount } from '../../plugins/account';
import { parseBody as parse, strictBody } from '../../plugins/strict-body';
import { authErrorResponses, errorResponses, errorSchema, schemaOf } from '../../schema';
import { documentDto, toAppError, uploadDto, verificationDto } from './dto';

const bearer = [{ bearerAuth: [] }];
const failures = { ...authErrorResponses, 400: errorResponses[400], 403: errorSchema, 404: errorResponses[404], 409: errorSchema, 503: errorSchema };
const meta = (req: FastifyRequest) => ({ correlationId: req.correlationId });
const run = <T>(fn: () => Promise<T>): Promise<T> => fn().catch(toAppError);

/** Largest body any verification route can legitimately receive (a few short fields): far below the default limit. */
export const TRUST_BODY_LIMIT = 4096;

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const CODE_PATTERN = '^[a-z][a-z0-9]*(_[a-z0-9]+)*$';
const idParams = { type: 'object', properties: { id: { type: 'string', pattern: UUID_PATTERN } }, required: ['id'], additionalProperties: false } as const;
const codeParams = {
  type: 'object',
  properties: { code: { type: 'string', pattern: CODE_PATTERN, minLength: 2, maxLength: 48 } },
  required: ['code'],
  additionalProperties: false,
} as const;
const noQuery = { type: 'object', properties: {}, additionalProperties: false } as const;

/** A body-less POST is accepted (no body or exactly `{}`); anything else is validated strictly. */
const optionalBody =
  (schema: Parameters<typeof parse>[0]): preValidationAsyncHookHandler =>
  async (req) => {
    parse(schema, req.body === undefined || req.body === null ? {} : req.body);
  };

export interface TrustProviderRouteDeps {
  trust: TrustService;
}

export async function trustProviderRoutes(app: FastifyInstance, deps: TrustProviderRouteDeps): Promise<void> {
  const svc = deps.trust;
  const tags = ['trust'];
  const accountId = (req: FastifyRequest): string => req.account!.accountId;
  const guard = requireAccount({ honorActiveRoleHeader: false });
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get(
    '',
    {
      preValidation: guard,
      schema: {
        operationId: 'getProviderVerification',
        summary:
          "The caller's verification: the requirements policy derives from the registration's market and service types, each one's status (an approval past its end reads EXPIRED), the documents' metadata and the overall state. There is no `verified` flag: complete means every required requirement is approved, and it is NOT Go-Live (goLive is always not evaluated). Writes nothing.",
        tags,
        security: bearer,
        querystring: noQuery,
        response: { 200: schemaOf(ProviderVerificationResponse), ...failures },
      },
    },
    async (req) => ({ data: verificationDto(await run(() => svc.getVerification(accountId(req)))), meta: meta(req) }),
  );

  app.post(
    '',
    {
      bodyLimit: TRUST_BODY_LIMIT,
      preValidation: [guard, optionalBody(OpenVerificationRequest)],
      schema: {
        operationId: 'openProviderVerification',
        summary:
          'Open (or resume) the verification case of the caller and bring it in line with policy. Needs a live provider registration and the configured contacts verified. Idempotent: 201 when a case was opened, 200 when it already existed. When policy requires nothing, no case is created.',
        tags,
        security: bearer,
        response: { 200: schemaOf(ProviderVerificationResponse), 201: schemaOf(ProviderVerificationResponse), ...failures },
      },
    },
    async (req, reply) => {
      const r = await run(() => svc.openVerification(accountId(req)));
      return reply.status(r.created ? 201 : 200).send({ data: verificationDto(r.view), meta: meta(req) });
    },
  );

  app.get(
    '/documents',
    {
      preValidation: guard,
      schema: {
        operationId: 'listProviderVerificationDocuments',
        summary: "Metadata of every document of the caller's live case, including withdrawn and abandoned uploads (history). No file, no key, no hash.",
        tags,
        security: bearer,
        querystring: noQuery,
        response: { 200: schemaOf(VerificationDocumentListResponse), ...failures },
      },
    },
    async (req) => ({ data: (await run(() => svc.listDocuments(accountId(req)))).map(documentDto), meta: meta(req) }),
  );

  app.post(
    '/documents/upload',
    {
      bodyLimit: TRUST_BODY_LIMIT,
      preValidation: [guard, strictBody(RequestDocumentUploadRequest)],
      schema: {
        operationId: 'requestProviderVerificationUpload',
        summary:
          'Authorize ONE document upload for a requirement: validates the file type and size against the configured policy and the requirement state, records the document as UPLOAD_PENDING and returns a one-object, short-lived PUT authorization (send the file with exactly the returned headers), then call finalize. The authorization is not stored or logged.',
        tags,
        security: bearer,
        body: schemaOf(RequestDocumentUploadRequest),
        response: { 201: schemaOf(DocumentUploadAuthorizationResponse), ...failures },
      },
    },
    async (req, reply) => {
      const u = await run(() => svc.requestUpload(accountId(req), parse(RequestDocumentUploadRequest, req.body)));
      return reply.status(201).send({ data: uploadDto(u), meta: meta(req) });
    },
  );

  app.post(
    '/documents/:id/finalize',
    {
      bodyLimit: TRUST_BODY_LIMIT,
      preValidation: [guard, optionalBody(FinalizeDocumentRequest)],
      schema: {
        operationId: 'finalizeProviderVerificationDocument',
        summary:
          'Finalize an upload: the server checks the stored object (it exists, its size and content type are the authorized ones, its first bytes are the signature of that type, its SHA-256 equals the optional one sent) and scans it. A mismatch or an infected file abandons the document; with no working scanner the document stays pending and the call can be repeated. Idempotent.',
        tags,
        security: bearer,
        params: idParams,
        response: { 200: schemaOf(VerificationDocumentResponse), ...failures },
      },
    },
    async (req) => ({
      data: documentDto(
        await run(() => svc.finalizeDocument(accountId(req), (req.params as { id: string }).id, parse(FinalizeDocumentRequest, req.body ?? {}))),
      ),
      meta: meta(req),
    }),
  );

  app.post(
    '/documents/:id/withdraw',
    {
      bodyLimit: TRUST_BODY_LIMIT,
      preValidation: [guard, optionalBody(OpenVerificationRequest)],
      schema: {
        operationId: 'withdrawProviderVerificationDocument',
        summary:
          'Remove a DRAFT document (not yet submitted) so another can replace it; the stored file is deleted. A submitted document is history and cannot be removed. Idempotent.',
        tags,
        security: bearer,
        params: idParams,
        response: { 200: schemaOf(VerificationDocumentResponse), ...failures },
      },
    },
    async (req) => ({ data: documentDto(await run(() => svc.withdrawDocument(accountId(req), (req.params as { id: string }).id))), meta: meta(req) }),
  );

  app.post(
    '/submit',
    {
      bodyLimit: TRUST_BODY_LIMIT,
      preValidation: [guard, strictBody(SubmitVerificationRequest)],
      schema: {
        operationId: 'submitProviderVerification',
        summary:
          'Submit the evidence for review. Every requirement that waits for the provider needs a finalized, clean document; they all move to PENDING in a new round and their documents become SUBMITTED (frozen). Idempotent when nothing is left to submit; a stale revision is 409.',
        tags,
        security: bearer,
        body: schemaOf(SubmitVerificationRequest),
        response: { 200: schemaOf(ProviderVerificationResponse), ...failures },
      },
    },
    async (req) => {
      const r = await run(() => svc.submitVerification(accountId(req), parse(SubmitVerificationRequest, req.body)));
      return { data: verificationDto(r.view), meta: meta(req) };
    },
  );

  app.post(
    '/cancel',
    {
      bodyLimit: TRUST_BODY_LIMIT,
      preValidation: [guard, optionalBody(CancelVerificationRequest)],
      schema: {
        operationId: 'cancelProviderVerification',
        summary:
          'Withdraw a verification case that was not decided (OPEN, IN_REVIEW or ACTION_REQUIRED). The account, the registration and the history stay; a new case is the next number. Idempotent.',
        tags,
        security: bearer,
        response: { 200: schemaOf(ProviderVerificationResponse), ...failures },
      },
    },
    async (req) => ({ data: verificationDto((await run(() => svc.cancelVerification(accountId(req)))).view), meta: meta(req) }),
  );

  app.post(
    '/requirements/:code/reverify',
    {
      bodyLimit: TRUST_BODY_LIMIT,
      preValidation: [guard, optionalBody(ReverifyRequirementRequest)],
      schema: {
        operationId: 'reverifyProviderRequirement',
        summary:
          'Start a NEW cycle of a requirement whose approval ended. The expired approval stays as history; the new cycle needs new evidence. 409 unless the requirement is expired and still required.',
        tags,
        security: bearer,
        params: codeParams,
        response: { 200: schemaOf(ProviderVerificationResponse), ...failures },
      },
    },
    async (req) => ({
      data: verificationDto(await run(() => svc.reverifyRequirement(accountId(req), (req.params as { code: string }).code))),
      meta: meta(req),
    }),
  );

  app.post(
    '/requirements/:code/external',
    {
      bodyLimit: TRUST_BODY_LIMIT,
      preValidation: [guard, optionalBody(StartExternalVerificationRequest)],
      schema: {
        operationId: 'startProviderExternalVerification',
        summary:
          'Start the verification of a requirement that is evidenced by an external provider (through the adapter boundary). Only the adapter name, the external identifier and a status snapshot are stored. 503 when no external provider is configured. Idempotent for the current round.',
        tags,
        security: bearer,
        params: codeParams,
        response: { 200: schemaOf(ExternalVerificationResponse), ...failures },
      },
    },
    async (req) => ({ data: await run(() => svc.startExternalVerification(accountId(req), (req.params as { code: string }).code)), meta: meta(req) }),
  );

  app.post(
    '/requirements/:code/external/refresh',
    {
      bodyLimit: TRUST_BODY_LIMIT,
      preValidation: [guard, optionalBody(StartExternalVerificationRequest)],
      schema: {
        operationId: 'refreshProviderExternalVerification',
        summary:
          'Ask the external provider for the current state and record it. An approval or rejection by the provider decides the requirement (reviewer `external:<adapter>`); only the provider, through the adapter, can say so, never the caller.',
        tags,
        security: bearer,
        params: codeParams,
        response: { 200: schemaOf(ExternalVerificationResponse), ...failures },
      },
    },
    async (req) => ({ data: await run(() => svc.refreshExternalVerification(accountId(req), (req.params as { code: string }).code)), meta: meta(req) }),
  );
}
