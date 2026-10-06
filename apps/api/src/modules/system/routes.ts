// System module: process-level endpoints. Pattern for later modules: one folder per domain, exporting
// Fastify plugins from routes.ts, with business logic in service files that never import Fastify.
import type { FastifyInstance } from 'fastify';
import { API_PREFIX, API_VERSION, HealthResponse, ReadinessResponse, SystemInfoResponse, VersionResponse, WhoAmIResponse } from '@bananagig/contracts';
import { requireAuthenticated } from '../../plugins/auth';
import { authErrorResponses, errorResponses, schemaOf } from '../../schema';
import { buildSystemInfo, buildVersion, type SystemDeps } from './service';

/** Unversioned operational endpoints. */
export async function systemRootRoutes(app: FastifyInstance, deps: SystemDeps & { readiness: () => Promise<Record<string, 'up' | 'down'>> }): Promise<void> {
  app.get(
    '/healthz',
    {
      schema: {
        operationId: 'getHealth',
        summary: 'Liveness: the process is alive',
        tags: ['system'],
        security: [],
        response: { 200: schemaOf(HealthResponse) },
      },
    },
    async () => ({
      status: 'ok' as const,
      service: deps.cfg.serviceName,
    }),
  );

  app.get(
    '/readyz',
    {
      schema: {
        operationId: 'getReadiness',
        summary: 'Readiness: critical dependencies allow serving requests',
        security: [],
        tags: ['system'],
        response: { 200: schemaOf(ReadinessResponse), 503: schemaOf(ReadinessResponse) },
      },
    },
    async (_req, reply) => {
      const checks = await deps.readiness();
      const ready = Object.values(checks).every((v) => v === 'up');
      return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', service: deps.cfg.serviceName, checks });
    },
  );

  app.get(
    '/version',
    {
      schema: {
        operationId: 'getVersion',
        summary: 'Build version of the running service',
        tags: ['system'],
        security: [],
        response: { 200: schemaOf(VersionResponse) },
      },
    },
    async () => buildVersion(deps),
  );
}

/** Versioned API routes (/api/v1). */
export async function systemV1Routes(app: FastifyInstance, deps: SystemDeps): Promise<void> {
  app.get(
    '/system/info',
    {
      schema: {
        operationId: 'getSystemInfo',
        summary: 'Service and environment information',
        security: [],
        tags: ['system'],
        response: { 200: schemaOf(SystemInfoResponse), ...errorResponses },
      },
    },
    async (req) => ({
      data: buildSystemInfo(deps),
      meta: { correlationId: req.correlationId },
    }),
  );
}

/** Versioned routes that require authentication. */
export async function systemAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/system/whoami',
    {
      preHandler: requireAuthenticated(),
      schema: {
        operationId: 'getWhoAmI',
        summary: 'Minimal identity of the caller (never the raw token)',
        description:
          'Requires a valid bananagig-api access token. Returns the immutable subject, the client the token was issued to, the audience, identity roles and the authentication context.',
        tags: ['system'],
        security: [{ bearerAuth: [] }],
        response: { 200: schemaOf(WhoAmIResponse), ...authErrorResponses },
      },
    },
    async (req) => {
      const p = req.principal!;
      return {
        data: { subject: p.subject, clientId: p.clientId, audience: p.audience, realmRoles: p.realmRoles, authContext: p.authContext },
        meta: { correlationId: req.correlationId },
      };
    },
  );
}

export const SYSTEM_V1_PREFIX = API_PREFIX;
export { API_VERSION };
