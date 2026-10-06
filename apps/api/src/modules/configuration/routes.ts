// Internal/admin configuration API. Not for product clients: every route needs the admin identity context plus a temporary
// configuration permission. Routes are thin; all rules live in @bananagig/configuration.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import {
  ChangeRequestListResponse,
  ChangeRequestResponse,
  CreateChangeRequest,
  CreateParameterRequest,
  CreateSnapshotRequest,
  DecisionRequest,
  ParameterListResponse,
  ParameterResponse,
  ResolveRequest,
  ResolveResponse,
  SnapshotResponse,
  CHANGE_STATES,
  type ChangeState,
} from '@bananagig/contracts';
import { type ConfigurationService } from '@bananagig/configuration';
import { requireConfigurationPermission } from '../../plugins/auth';
import { AppError } from '../../errors';
import { authErrorResponses, errorResponses, schemaOf } from '../../schema';
import { changeRequestDto, parameterDto, resolvedDto, snapshotDto, toAppError } from './dto';

const bearer = [{ bearerAuth: [] }];
const failures = { ...authErrorResponses, 400: errorResponses[400], 403: errorResponses[400], 404: errorResponses[404], 409: errorResponses[400] };
const meta = (req: FastifyRequest) => ({ correlationId: req.correlationId });
const parse = <T>(schema: ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success)
    throw new AppError('VALIDATION', 'VALIDATION_FAILED', 'Request validation failed', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  return r.data;
};
const run = async <T>(fn: () => Promise<T>): Promise<T> => fn().catch(toAppError);
const idParams = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] };

export async function configurationRoutes(app: FastifyInstance, deps: { configuration: ConfigurationService }): Promise<void> {
  const svc = deps.configuration;
  const tags = ['configuration'];
  const actor = (req: FastifyRequest): string => req.principal!.subject;

  app.get(
    '/parameters',
    {
      preValidation: requireConfigurationPermission('read'),
      schema: {
        operationId: 'listConfigurationParameters',
        summary: 'List configuration parameter definitions (no values)',
        tags,
        security: bearer,
        response: { 200: schemaOf(ParameterListResponse), ...failures },
      },
    },
    async (req) => ({
      data: (await run(() => svc.listParameters())).map(parameterDto),
      meta: meta(req),
    }),
  );

  app.get(
    '/parameters/:key',
    {
      preValidation: requireConfigurationPermission('read'),
      schema: {
        operationId: 'getConfigurationParameter',
        summary: 'One parameter definition',
        tags,
        security: bearer,
        params: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
        response: { 200: schemaOf(ParameterResponse), ...failures },
      },
    },
    async (req) => ({
      data: parameterDto(await run(() => svc.getParameter((req.params as { key: string }).key))),
      meta: meta(req),
    }),
  );

  app.post(
    '/parameters',
    {
      preValidation: requireConfigurationPermission('write'),
      schema: {
        operationId: 'createConfigurationParameter',
        summary: 'Create a parameter definition',
        tags,
        security: bearer,
        body: schemaOf(CreateParameterRequest),
        response: { 201: schemaOf(ParameterResponse), ...failures },
      },
    },
    async (req, reply) => {
      const body = parse(CreateParameterRequest, req.body);
      return reply.status(201).send({ data: parameterDto(await run(() => svc.createParameter(body, actor(req)))), meta: meta(req) });
    },
  );

  app.post(
    '/resolve',
    {
      preValidation: requireConfigurationPermission('read'),
      schema: {
        operationId: 'resolveConfiguration',
        summary: 'Resolve parameters for a context (SENSITIVE values are redacted)',
        tags,
        security: bearer,
        body: schemaOf(ResolveRequest),
        response: { 200: schemaOf(ResolveResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(ResolveRequest, req.body);
      const r = await run(() => svc.resolveMany(body.keys, body.context, { at: body.at ? new Date(body.at) : undefined }));
      return { data: { evaluatedAt: r.at.toISOString(), values: [...r.values.values()].map(resolvedDto) }, meta: meta(req) };
    },
  );

  app.post(
    '/snapshots',
    {
      preValidation: requireConfigurationPermission('read'),
      schema: {
        operationId: 'createConfigurationSnapshot',
        summary: 'Create an immutable snapshot of resolved values',
        tags,
        security: bearer,
        body: schemaOf(CreateSnapshotRequest),
        response: { 201: schemaOf(SnapshotResponse), ...failures },
      },
    },
    async (req, reply) => {
      const body = parse(CreateSnapshotRequest, req.body);
      const snap = await run(() =>
        svc.createSnapshot({ keys: body.keys, context: body.context, purpose: body.purpose, at: body.at ? new Date(body.at) : undefined }, actor(req)),
      );
      return reply.status(201).send({ data: snapshotDto(snap), meta: meta(req) });
    },
  );

  app.get(
    '/snapshots/:id',
    {
      preValidation: requireConfigurationPermission('read'),
      schema: {
        operationId: 'getConfigurationSnapshot',
        summary: 'Read a snapshot',
        tags,
        security: bearer,
        params: idParams,
        response: { 200: schemaOf(SnapshotResponse), ...failures },
      },
    },
    async (req) => ({
      data: snapshotDto(await run(() => svc.getSnapshot((req.params as { id: string }).id))),
      meta: meta(req),
    }),
  );

  app.get(
    '/change-requests',
    {
      preValidation: requireConfigurationPermission('read'),
      schema: {
        operationId: 'listConfigurationChangeRequests',
        summary: 'List change requests',
        tags,
        security: bearer,
        querystring: { type: 'object', properties: { state: { type: 'string', enum: [...CHANGE_STATES] }, parameterKey: { type: 'string' } } },
        response: { 200: schemaOf(ChangeRequestListResponse), ...failures },
      },
    },
    async (req) => {
      const q = req.query as { state?: ChangeState; parameterKey?: string };
      return { data: (await run(() => svc.listChangeRequests(q))).map(changeRequestDto), meta: meta(req) };
    },
  );

  app.get(
    '/change-requests/:id',
    {
      preValidation: requireConfigurationPermission('read'),
      schema: {
        operationId: 'getConfigurationChangeRequest',
        summary: 'One change request',
        tags,
        security: bearer,
        params: idParams,
        response: { 200: schemaOf(ChangeRequestResponse), ...failures },
      },
    },
    async (req) => ({
      data: changeRequestDto(await run(() => svc.getChangeRequest((req.params as { id: string }).id))),
      meta: meta(req),
    }),
  );

  app.post(
    '/change-requests',
    {
      preValidation: requireConfigurationPermission('write'),
      schema: {
        operationId: 'createConfigurationChangeRequest',
        summary: 'Create a draft change request',
        tags,
        security: bearer,
        body: schemaOf(CreateChangeRequest),
        response: { 201: schemaOf(ChangeRequestResponse), ...failures },
      },
    },
    async (req, reply) => {
      const body = parse(CreateChangeRequest, req.body);
      return reply.status(201).send({ data: changeRequestDto(await run(() => svc.createChangeRequest(body, actor(req)))), meta: meta(req) });
    },
  );

  const transition = (
    path: string,
    operationId: string,
    summary: string,
    permission: 'write' | 'approve',
    fn: (id: string, who: string, comment?: string) => Promise<Awaited<ReturnType<ConfigurationService['getChangeRequest']>>>,
  ) =>
    app.post(
      `/change-requests/:id/${path}`,
      {
        preValidation: requireConfigurationPermission(permission),
        schema: {
          operationId,
          summary,
          tags,
          security: bearer,
          params: idParams,
          body: schemaOf(DecisionRequest),
          response: { 200: schemaOf(ChangeRequestResponse), ...failures },
        },
      },
      async (req) => {
        const body = parse(DecisionRequest, req.body ?? {});
        return { data: changeRequestDto(await run(() => fn((req.params as { id: string }).id, actor(req), body.comment))), meta: meta(req) };
      },
    );
  transition('submit', 'submitConfigurationChangeRequest', 'Submit a draft for approval (policy NONE approves it)', 'write', (id, who) => svc.submit(id, who));
  transition(
    'approve',
    'approveConfigurationChangeRequest',
    'Approve a pending change (a SECOND_APPROVER policy forbids the requester)',
    'approve',
    (id, who, c) => svc.approve(id, who, c),
  );
  transition('reject', 'rejectConfigurationChangeRequest', 'Reject a pending change', 'approve', (id, who, c) => svc.reject(id, who, c));
  transition('cancel', 'cancelConfigurationChangeRequest', 'Cancel an unpublished change (requester only)', 'write', (id, who) => svc.cancel(id, who));
  transition(
    'publish',
    'publishConfigurationChangeRequest',
    'Publish an approved change as an immutable version (scheduled or immediate)',
    'write',
    (id, who) => svc.publish(id, who),
  );
}
