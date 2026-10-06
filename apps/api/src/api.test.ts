import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import { CORRELATION_HEADER, ErrorResponse, SystemInfoResponse } from '@bananagig/contracts';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys } from '@bananagig/identity/testing';
import { buildApp } from './app';
import { AppError } from './errors';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test', APP_VERSION: '9.9.9' } });
let ready = true;
let app: FastifyInstance;

beforeAll(async () => {
  const keys = await createTestKeys();
  const verifier = createTokenVerifier({ issuer: cfg.identity.issuer, apiAudience: cfg.identity.apiAudience, jwks: keys.getKey });
  app = await buildApp({ cfg, verifier, readiness: async () => ({ postgres: ready ? 'up' : 'down' }) });
  app.get('/__throw/:kind', { schema: { hide: true } }, async (req) => {
    const { kind } = req.params as { kind: string };
    if (kind === 'conflict') throw new AppError('CONFLICT', 'TEST_CONFLICT', 'conflict happened', { field: 'x' });
    throw new Error('secret internal detail');
  });
  await app.ready();
});
afterAll(() => app.close());

describe('api', () => {
  it('healthz', async () => {
    const r = await app.inject('/healthz');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok', service: 'bananagig-api' });
  });
  it('readyz reflects critical dependency state', async () => {
    expect((await app.inject('/readyz')).statusCode).toBe(200);
    ready = false;
    const r = await app.inject('/readyz');
    expect(r.statusCode).toBe(503);
    expect(r.json().checks.postgres).toBe('down');
    ready = true;
  });
  it('version', async () => {
    const r = await app.inject('/version');
    expect(r.json()).toMatchObject({ version: '9.9.9', environment: 'test' });
  });
  it('system info matches the contract and carries the correlation id', async () => {
    const r = await app.inject('/api/v1/system/info');
    expect(r.statusCode).toBe(200);
    const body = SystemInfoResponse.parse(r.json());
    expect(body.meta.correlationId).toBe(r.headers[CORRELATION_HEADER]);
  });
  it('creates a correlation id when none is sent', async () => {
    const r = await app.inject('/healthz');
    expect(r.headers[CORRELATION_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('propagates a valid incoming correlation id and replaces unsafe ones', async () => {
    const ok = await app.inject({ url: '/healthz', headers: { [CORRELATION_HEADER]: 'client-id-12345' } });
    expect(ok.headers[CORRELATION_HEADER]).toBe('client-id-12345');
    const bad = await app.inject({ url: '/healthz', headers: { [CORRELATION_HEADER]: 'x\ty' } });
    expect(bad.headers[CORRELATION_HEADER]).not.toBe('x\ty');
  });
  it('returns the standard error model for unknown routes', async () => {
    const r = await app.inject('/api/v1/nope');
    expect(r.statusCode).toBe(404);
    const e = ErrorResponse.parse(r.json());
    expect(e.error).toMatchObject({ category: 'NOT_FOUND', code: 'ROUTE_NOT_FOUND' });
    expect(e.error.correlationId).toBe(r.headers[CORRELATION_HEADER]);
  });
  it('maps AppError categories and hides internal details of unexpected errors', async () => {
    const c = await app.inject('/__throw/conflict');
    expect(c.statusCode).toBe(409);
    expect(c.json().error.details).toEqual({ field: 'x' });
    const i = await app.inject('/__throw/boom');
    expect(i.statusCode).toBe(500);
    const txt = i.body;
    expect(txt).not.toContain('secret internal detail');
    expect(txt).not.toContain('stack');
    expect(ErrorResponse.parse(i.json()).error.category).toBe('INTERNAL');
  });
});
