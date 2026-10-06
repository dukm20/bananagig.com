// System module: process-level endpoints. Pattern for later modules: one folder per domain, exporting
// Fastify plugins from routes.ts, with business logic in service files that never import Fastify.
import type { FastifyInstance } from 'fastify';
import { API_PREFIX, API_VERSION, HealthResponse, ReadinessResponse, SystemInfoResponse, VersionResponse } from '@bananagig/contracts';
import { errorResponses, schemaOf } from '../../schema';
import { buildSystemInfo, buildVersion, type SystemDeps } from './service';

/** Unversioned operational endpoints. */
export async function systemRootRoutes(app: FastifyInstance, deps: SystemDeps & { readiness: () => Promise<Record<string, 'up' | 'down'>> }): Promise<void> {
  app.get(
    '/healthz',
    { schema: { operationId: 'getHealth', summary: 'Liveness: the process is alive', tags: ['system'], response: { 200: schemaOf(HealthResponse) } } },
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
    { schema: { operationId: 'getVersion', summary: 'Build version of the running service', tags: ['system'], response: { 200: schemaOf(VersionResponse) } } },
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

export const SYSTEM_V1_PREFIX = API_PREFIX;
export { API_VERSION };
