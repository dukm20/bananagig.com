import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import type { AppConfig } from '@bananagig/config';
import { API_PREFIX } from '@bananagig/contracts';
import type { ConfigurationService } from '@bananagig/configuration';
import type { ContentService } from '@bananagig/content';
import type { TokenVerifier } from '@bananagig/identity';
import { metrics } from '@bananagig/observability';
import { authPlugin } from './plugins/auth';
import { correlationPlugin } from './plugins/correlation';
import { errorPlugin, frameworkErrors } from './plugins/errors';
import { configurationRoutes } from './modules/configuration/routes';
import { contentRoutes } from './modules/content/routes';
import { systemAuthRoutes, systemRootRoutes, systemV1Routes } from './modules/system/routes';

/** Longest path parameter the router accepts: above the 160-character content key limit; longer values are rejected with the standard 400. */
export const MAX_PATH_PARAM_LENGTH = 192;

export interface AppDeps {
  cfg: AppConfig;
  /** Critical dependencies only. See docs/engineering/API_CONVENTIONS.md (dependency criticality). */
  readiness: () => Promise<Record<string, 'up' | 'down'>>;
  /** Internal-only connectivity diagnostics (not routed by Caddy, hidden from OpenAPI). */
  diagnostics?: () => Promise<unknown>;
  /** Access-token verifier (real JWKS in production, local keys in tests). */
  verifier: TokenVerifier;
  /** Product configuration registry (internal/admin API). */
  configuration: ConfigurationService;
  /**
   * Content and localization registry (management routes are internal/admin; resolve and active locales are public). Optional only so the
   * pre-existing test harnesses that build the app without it keep compiling; index.ts and the spec generator always pass it.
   */
  content?: ContentService;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // removeAdditional=false: unknown request properties are REJECTED (400) instead of silently stripped.
  // maxParamLength: Fastify's default (100) is shorter than a content key (160) and than the longest :id/:locale, which would orphan a created
  // entry. frameworkErrors routes router-level failures (over-long params, malformed URLs) through the standard error envelope.
  const app = Fastify({
    logger: false,
    trustProxy: true,
    ajv: { customOptions: { removeAdditional: false } },
    routerOptions: { maxParamLength: MAX_PATH_PARAM_LENGTH },
    frameworkErrors,
  });
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
      tags: [
        { name: 'system', description: 'Operational and system information' },
        { name: 'configuration', description: 'Product configuration registry: internal/admin only (admin identity context plus a configuration permission)' },
        {
          name: 'content',
          description:
            'Content and localization registry: management is internal/admin only (admin identity context plus a content permission); resolve and the active locale list are public with visibility rules',
        },
      ],
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
  await app.register(configurationRoutes, { prefix: `${API_PREFIX}/configuration`, configuration: deps.configuration });
  if (deps.content) await app.register(contentRoutes, { prefix: `${API_PREFIX}/content`, content: deps.content });

  app.get('/metrics', { schema: { hide: true } }, async (_req, reply) => reply.type(metrics.contentType).send(await metrics.metrics()));
  if (deps.diagnostics) {
    const d = deps.diagnostics;
    app.get('/internal/diagnostics', { schema: { hide: true } }, async () => d());
  }
  return app;
}
