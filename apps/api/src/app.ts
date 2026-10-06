import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import type { AppConfig } from '@bananagig/config';
import { API_PREFIX } from '@bananagig/contracts';
import type { TokenVerifier } from '@bananagig/identity';
import { metrics } from '@bananagig/observability';
import { authPlugin } from './plugins/auth';
import { correlationPlugin } from './plugins/correlation';
import { errorPlugin } from './plugins/errors';
import { systemAuthRoutes, systemRootRoutes, systemV1Routes } from './modules/system/routes';

export interface AppDeps {
  cfg: AppConfig;
  /** Critical dependencies only. See docs/engineering/API_CONVENTIONS.md (dependency criticality). */
  readiness: () => Promise<Record<string, 'up' | 'down'>>;
  /** Internal-only connectivity diagnostics (not routed by Caddy, hidden from OpenAPI). */
  diagnostics?: () => Promise<unknown>;
  /** Access-token verifier (real JWKS in production, local keys in tests). */
  verifier: TokenVerifier;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });
  const sys = { cfg: deps.cfg, startedAt: Date.now() };

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'BananaGig API',
        version: '1.0.0',
        license: { name: 'UNLICENSED', identifier: 'UNLICENSED' },
        description: 'HTTP contract for the BananaGig API. Generated from route schemas; do not edit docs/api/openapi.yaml by hand.',
      },
      servers: [{ url: 'http://api.localhost:8080', description: 'Local development via Caddy' }],
      tags: [{ name: 'system', description: 'Operational and system information' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'Keycloak access token for the bananagig-api audience (Authorization Code + PKCE). Obtain it through the web app or an approved client.',
          },
        },
      },
    },
  });
  await app.register(correlationPlugin);
  await app.register(errorPlugin);
  await app.register(authPlugin, { verifier: deps.verifier, realm: deps.cfg.identity.realm });

  await app.register(systemRootRoutes, { ...sys, readiness: deps.readiness });
  await app.register(systemV1Routes, { ...sys, prefix: API_PREFIX });
  await app.register(systemAuthRoutes, { prefix: API_PREFIX });

  app.get('/metrics', { schema: { hide: true } }, async (_req, reply) => reply.type(metrics.contentType).send(await metrics.metrics()));
  if (deps.diagnostics) {
    const d = deps.diagnostics;
    app.get('/internal/diagnostics', { schema: { hide: true } }, async () => d());
  }
  return app;
}
