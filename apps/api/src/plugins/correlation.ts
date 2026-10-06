import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { Histogram } from 'prom-client';
import { CORRELATION_HEADER } from '@bananagig/contracts';
import { log, metrics, resolveCorrelationId, runWithCorrelation } from '@bananagig/observability';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    startedAt: number;
  }
}

/**
 * Every request gets a correlation id (safe inbound value or fresh UUID), echoed in the response header,
 * available through AsyncLocalStorage to logs/spans/DB transactions, and logged on completion.
 */
// Module scope: registering the metric per app instance would throw on the second buildApp() in one process.
const duration = new Histogram({
  name: 'http_server_request_duration_seconds',
  help: 'HTTP server request duration',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [metrics],
});

export const correlationPlugin = fp(async (app: FastifyInstance): Promise<void> => {
  app.decorateRequest('correlationId', '');
  app.decorateRequest('startedAt', 0);

  app.addHook('onRequest', (req, reply, done) => {
    req.correlationId = resolveCorrelationId(req.headers[CORRELATION_HEADER]);
    req.startedAt = performance.now();
    reply.header(CORRELATION_HEADER, req.correlationId);
    runWithCorrelation(req.correlationId, () => done());
  });

  app.addHook('onResponse', (req, reply, done) => {
    const ms = performance.now() - req.startedAt;
    const route = req.routeOptions?.url ?? 'unmatched';
    duration.labels(req.method, route, String(reply.statusCode)).observe(ms / 1000);
    if (route !== '/healthz' && route !== '/readyz' && route !== '/metrics') {
      log('info', 'request completed', { method: req.method, route, status: reply.statusCode, durationMs: Math.round(ms) });
    }
    done();
  });
});
