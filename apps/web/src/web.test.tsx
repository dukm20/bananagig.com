import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORRELATION_HEADER } from '@bananagig/contracts';
import Home from './app/page';
import HealthPage from './app/health/page';
import NotFound from './app/not-found';
import { ApiError, createApiClient } from './lib/api-client';

describe('pages', () => {
  it('renders the root page', () => {
    const html = renderToString(<Home />);
    expect(html).toContain('BananaGig');
    expect(html).toContain('Local help. Done fast.');
    expect(html).toContain('Platform initialization successful.');
  });
  it('renders health and not-found pages', () => {
    expect(renderToString(<HealthPage />)).toContain('web: ok');
    expect(renderToString(<NotFound />)).toContain('Page not found');
  });
});

describe('api client', () => {
  let server: http.Server;
  let base = '';
  let lastCorrelation: string | undefined;
  beforeAll(async () => {
    // Contract-conforming stand-in for the API (the real API is exercised by `pnpm smoke`).
    server = http.createServer((req, res) => {
      lastCorrelation = req.headers[CORRELATION_HEADER] as string | undefined;
      res.setHeader('content-type', 'application/json').setHeader(CORRELATION_HEADER, lastCorrelation ?? 'generated-id-1');
      if (req.url === '/api/v1/system/info') {
        res.end(
          JSON.stringify({
            data: { service: 'api', environment: 'test', version: '1.2.3', apiVersion: 'v1', serverTime: new Date().toISOString(), uptimeSeconds: 5 },
            meta: { correlationId: 'x' },
          }),
        );
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: 'ROUTE_NOT_FOUND', category: 'NOT_FOUND', message: 'nope', correlationId: 'c-1234567' } }));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('calls /api/v1/system/info, validates the contract and propagates correlation', async () => {
    const info = await createApiClient({ baseUrl: base, correlationId: () => 'web-corr-12345' }).getSystemInfo();
    expect(info.version).toBe('1.2.3');
    expect(lastCorrelation).toBe('web-corr-12345');
  });
  it('turns standard error bodies into ApiError', async () => {
    const bad = createApiClient({ baseUrl: base, fetch: (url, init) => fetch(String(url).replace('/system/info', '/missing'), init) });
    await expect(bad.getSystemInfo()).rejects.toMatchObject({ name: 'ApiError', status: 404, code: 'ROUTE_NOT_FOUND', category: 'NOT_FOUND' });
  });
  it('reports an unreachable API as a DEPENDENCY error', async () => {
    const err = await createApiClient({ baseUrl: 'http://127.0.0.1:1' })
      .getSystemInfo()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.category).toBe('DEPENDENCY');
  });
});
