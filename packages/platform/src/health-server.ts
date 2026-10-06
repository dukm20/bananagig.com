import http from 'node:http';
import { metrics, log } from '@bananagig/observability';

export interface HealthServerOptions {
  service: string;
  port: number;
  ready: () => Promise<Record<string, 'up' | 'down'>>;
  routes?: Record<string, () => Promise<unknown>>;
}

/**
 * Minimal HTTP surface for processes that are not HTTP apps (the worker).
 * /healthz: process alive.  /readyz: can accept work.  /metrics: Prometheus.
 */
export function startHealthServer(o: HealthServerOptions): http.Server {
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const send = (status: number, body: unknown, type = 'application/json') =>
      res.writeHead(status, { 'content-type': type }).end(typeof body === 'string' ? body : JSON.stringify(body));
    try {
      if (path === '/healthz') return send(200, { status: 'ok', service: o.service });
      if (path === '/readyz') {
        const checks = await o.ready();
        const ok = Object.values(checks).every((v) => v === 'up');
        return send(ok ? 200 : 503, { status: ok ? 'ready' : 'not_ready', service: o.service, checks });
      }
      if (path === '/metrics') return send(200, await metrics.metrics(), metrics.contentType);
      const route = path ? o.routes?.[path] : undefined;
      if (route) return send(200, await route());
      return send(404, { error: 'not_found' });
    } catch (err) {
      log('error', 'health server request failed', { path, error: String(err) });
      return send(500, { error: 'internal' });
    }
  });
  server.listen(o.port, '0.0.0.0');
  return server;
}
