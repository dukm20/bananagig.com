import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORRELATION_HEADER } from '@bananagig/contracts';
import Home from './app/page';
import HealthPage from './app/health/page';
import NotFound from './app/not-found';
import { ApiError, createApiClient } from './lib/api-client';
import { ACTIVE_LOCALES_TTL_MS, getContent, getContentMany, renderContent, resetActiveLocalesMemo } from './lib/content';
import { REGISTRY_COPY, startContentStub, type ContentStub } from './testing/content-stub';

const state = vi.hoisted(() => ({ baseUrl: 'http://127.0.0.1:1', acceptLanguage: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(state.acceptLanguage === undefined ? {} : { 'accept-language': state.acceptLanguage }),
}));
vi.mock('./lib/server', async () => {
  const { createApiClient: create } = await import('./lib/api-client');
  return { serverApi: () => create({ baseUrl: state.baseUrl, correlationId: () => 'web-test-corr-1' }) };
});

describe('pages', () => {
  let stub: ContentStub;
  beforeAll(async () => {
    stub = await startContentStub(REGISTRY_COPY);
  });
  afterAll(() => stub.close());
  beforeEach(() => {
    stub.mode = 'up';
    stub.calls.length = 0;
    stub.localeCalls = 0;
    stub.locales = undefined;
    resetActiveLocalesMemo();
    vi.restoreAllMocks();
    stub.catalog = REGISTRY_COPY;
    state.baseUrl = stub.baseUrl;
    state.acceptLanguage = 'en-US';
  });

  it('(28) server-renders the home page copy from the registry in one batched call', async () => {
    const html = renderToString(await Home());
    expect(html).toContain('<h1>BananaGig</h1>');
    expect(html).toContain('Registry tagline (en-US)');
    expect(html).toContain('Registry initialized message');
    // Not the old hardcoded literals: the text provably came from the registry.
    expect(html).not.toContain('Local help. Done fast.');
    expect(html).not.toContain('Platform initialization successful.');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.path).toBe('/api/v1/content/resolve-many');
    expect(stub.calls[0]!.correlationId).toBe('web-test-corr-1');
    expect((stub.calls[0]!.body as { keys: string[] }).keys.sort()).toEqual(['brand.name', 'brand.tagline', 'system.home.initialized']);
  });
  it('(28) registry down: the page still renders with the wordmark and no tagline or hardcoded replacement', async () => {
    stub.mode = 'down';
    const html = renderToString(await Home());
    expect(html).toContain('<h1>BananaGig</h1>');
    expect(html).not.toContain('tagline');
    expect(html).not.toContain('Local help');
    expect(html).not.toContain('initialization');
    expect(html).not.toContain('initialized');
    expect(html).not.toContain('class="muted"');
    expect(html).toContain('href="/system"');
  });
  it('(28) registry unreachable: same graceful omission', async () => {
    state.baseUrl = 'http://127.0.0.1:1';
    const html = renderToString(await Home());
    expect(html).toContain('<h1>BananaGig</h1>');
    expect(html).not.toContain('Local help');
    expect(html).not.toContain('<p>Registry');
  });
  it('(28) a key the registry does not serve is omitted individually', async () => {
    stub.catalog = { 'en-US': { 'brand.name': { value: 'BananaGig' }, 'brand.tagline': { value: 'Only tagline' } } };
    const html = renderToString(await Home());
    expect(html).toContain('Only tagline');
    expect(html).not.toContain('initialization');
    expect(html).not.toContain('class="muted"');
  });
  it('(29) negotiates Accept-Language, sends the top locale and renders the fallback the API reports', async () => {
    state.acceptLanguage = 'fr;q=0.2, es-mx;q=0.9, en;q=0.5';
    const html = renderToString(await Home());
    expect((stub.calls[0]!.body as { locale: string }).locale).toBe('es-MX');
    expect(html).toContain('Registry tagline (en-US)'); // the stub answered a fallback to en-US
    const direct = await getContent('brand.tagline');
    expect(direct).toEqual({ format: 'text', value: 'Registry tagline (en-US)' });
    expect((stub.calls.at(-1)!.body as { locale: string }).locale).toBe('es-MX');
  });
  it('(29) serves the negotiated locale when the registry has it, and an unusable header requests the default locale', async () => {
    stub.catalog = { ...REGISTRY_COPY, 'es-MX': { 'brand.tagline': { value: 'Etiqueta es-MX' } } };
    state.acceptLanguage = 'es-MX,es;q=0.8';
    expect((await getContent('brand.tagline'))?.value).toBe('Etiqueta es-MX');
    state.acceptLanguage = '*, en_US, ;q=1, garbage!!!';
    await getContent('brand.tagline');
    expect((stub.calls.at(-1)!.body as { locale: string }).locale).toBe('en-US');
    state.acceptLanguage = undefined;
    await getContent('brand.tagline');
    expect((stub.calls.at(-1)!.body as { locale: string }).locale).toBe('en-US');
  });
  describe('(29) negotiation against the active locales', () => {
    /** A complete LocaleDto as the API returns it (display name and derived language/script/region), so fixtures cannot drift from the contract. */
    const locale = (tag: string, isActive: boolean, isPlatformDefault: boolean) => {
      const [language = tag, ...rest] = tag.split('-');
      const script = rest.find((x) => /^[A-Z][a-z]{3}$/.test(x)) ?? null;
      const region = rest.find((x) => /^([A-Z]{2}|[0-9]{3})$/.test(x)) ?? null;
      return { locale: tag, displayName: tag, language, script, region, isActive, isPlatformDefault };
    };
    const ACTIVE = [locale('en-US', true, true), locale('es-US', true, false)];
    const requested = () => (stub.calls.at(-1)!.body as { locale: string }).locale;

    it('requests the first ACTIVE preference: es-US when fr is inactive (fr-FR, es-US;q=0.8)', async () => {
      stub.locales = ACTIVE;
      stub.catalog = { ...REGISTRY_COPY, 'es-US': { 'brand.tagline': { value: 'Etiqueta es-US' } } };
      state.acceptLanguage = 'fr-FR, es-US;q=0.8';
      expect((await getContent('brand.tagline'))?.value).toBe('Etiqueta es-US');
      expect(requested()).toBe('es-US');
      expect(stub.localeCalls).toBe(1);
      const html = renderToString(await Home());
      expect(html).toContain('Etiqueta es-US');
    });
    it('truncates variants and regions to an active language and ignores a locale list entry that is not active', async () => {
      stub.locales = [...ACTIVE, locale('fr-FR', false, false), locale('de', true, false)];
      state.acceptLanguage = 'fr-FR, de-CH-1996;q=0.9';
      await getContent('brand.tagline');
      expect(requested()).toBe('de');
    });
    it('requests the platform default locale when no preference is active', async () => {
      stub.locales = ACTIVE;
      state.acceptLanguage = 'fr-FR, ja;q=0.5';
      await getContent('brand.tagline');
      expect(requested()).toBe('en-US');
    });
    it('sends no locale list request when the header carries no usable preference or an explicit locale is given', async () => {
      stub.locales = ACTIVE;
      state.acceptLanguage = '*';
      await getContent('brand.tagline');
      expect(requested()).toBe('en-US');
      await getContent('brand.tagline', { locale: 'es-US' });
      expect(stub.localeCalls).toBe(0);
    });
    it('falls back to the top preference when the locale list fails (404, 503, API down, unreachable)', async () => {
      state.acceptLanguage = 'fr-FR, es-US;q=0.8';
      for (const arrange of [
        () => (stub.locales = undefined),
        () => (stub.locales = 'fail'),
        () => {
          stub.locales = ACTIVE;
          state.baseUrl = 'http://127.0.0.1:1';
        },
      ]) {
        resetActiveLocalesMemo();
        arrange();
        // the content call itself may fail too (unreachable); only the locale choice matters, so use an injected api that records it
        const sent: string[] = [];
        const api = {
          ...createApiClient({ baseUrl: state.baseUrl }),
          resolveContent: async (input: { locale: string }) => {
            sent.push(input.locale);
            throw new ApiError(503, 'UNAVAILABLE', 'DEPENDENCY', 'down');
          },
        } as never;
        expect(await getContent('brand.tagline', { api })).toBeUndefined();
        expect(sent).toEqual(['fr-FR']);
        state.baseUrl = stub.baseUrl;
      }
    });
    it('falls back to the top preference and still serves copy when only the locale list is down', async () => {
      stub.locales = 'fail';
      state.acceptLanguage = 'fr-FR, es-US;q=0.8';
      expect((await getContent('brand.tagline'))?.value).toBe('Registry tagline (en-US)');
      expect(requested()).toBe('fr-FR');
      expect(stub.localeCalls).toBe(1);
    });
    it('does not memoize a failure: the next request tries the list again and uses it once it works', async () => {
      stub.locales = 'fail';
      state.acceptLanguage = 'fr-FR, es-US;q=0.8';
      await getContent('brand.tagline');
      stub.locales = ACTIVE;
      await getContent('brand.tagline');
      expect(requested()).toBe('es-US');
      expect(stub.localeCalls).toBe(2);
    });
    it('memoizes the list for 30 seconds: no second fetch within the TTL, a refetch after it (activation takes effect)', async () => {
      stub.locales = ACTIVE;
      state.acceptLanguage = 'fr-FR, es-US;q=0.8';
      const t0 = 1_800_000_000_000;
      const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
      await getContent('brand.tagline');
      await getContentMany(['brand.tagline']);
      renderToString(await Home());
      expect(stub.localeCalls).toBe(1);
      now.mockReturnValue(t0 + ACTIVE_LOCALES_TTL_MS - 1);
      await getContent('brand.tagline');
      expect(stub.localeCalls).toBe(1);
      expect(ACTIVE_LOCALES_TTL_MS).toBe(30_000);
      stub.locales = [...ACTIVE, locale('fr', true, false)];
      now.mockReturnValue(t0 + ACTIVE_LOCALES_TTL_MS);
      await getContent('brand.tagline');
      expect(stub.localeCalls).toBe(2);
      expect(requested()).toBe('fr');
    });
    it('shares one fetch between concurrent requests', async () => {
      stub.locales = ACTIVE;
      state.acceptLanguage = 'es-US';
      await Promise.all([getContent('brand.tagline'), getContent('brand.name'), getContentMany(['brand.tagline'])]);
      expect(stub.localeCalls).toBe(1);
    });
  });
  it('an explicit locale option overrides negotiation', async () => {
    state.acceptLanguage = 'de-DE';
    await getContent('brand.tagline', { locale: 'en-GB' });
    expect((stub.calls.at(-1)!.body as { locale: string }).locale).toBe('en-GB');
  });
  it('getContent returns undefined for an unknown key and when the registry is down; getContentMany returns {}', async () => {
    expect(await getContent('no.such_key')).toBeUndefined();
    stub.mode = 'down';
    expect(await getContent('brand.tagline')).toBeUndefined();
    expect(await getContentMany(['brand.tagline'])).toEqual({});
    expect(await getContentMany([])).toEqual({});
  });
  it('renderContent escapes text and injects only html-format values', () => {
    expect(renderToString(<p>{renderContent({ format: 'text', value: '<img src=x onerror=alert(1)>' })}</p>)).toContain('&lt;img');
    expect(renderToString(<>{renderContent({ format: 'html', value: '<strong>ok</strong>' })}</>)).toContain('<strong>ok</strong>');
    expect(renderContent(undefined)).toBeNull();
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
