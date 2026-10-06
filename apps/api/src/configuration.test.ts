import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import { ConfigurationError, type ChangeRequest, type ConfigurationService, type Resolved, type Snapshot } from '@bananagig/configuration';
import { ErrorResponse } from '@bananagig/contracts';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { buildApp } from './app';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
let keys: TestKeys;
let app: FastifyInstance;
const svc = {
  listParameters: vi.fn(),
  getParameter: vi.fn(),
  createParameter: vi.fn(),
  resolveMany: vi.fn(),
  createSnapshot: vi.fn(),
  getSnapshot: vi.fn(),
  listChangeRequests: vi.fn(),
  getChangeRequest: vi.fn(),
  createChangeRequest: vi.fn(),
  submit: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  cancel: vi.fn(),
  publish: vi.fn(),
};

const adminToken = (roles: string[], over: Record<string, unknown> = {}) =>
  signToken(keys, {
    claims: {
      sub: 'admin-a',
      azp: 'bananagig-admin',
      realm_access: { roles: [] },
      resource_access: { 'bananagig-admin': { roles: ['admin-console-access', ...roles] } },
      ...over,
    },
  });
const call = async (method: 'GET' | 'POST', url: string, token?: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/api/v1/configuration${url}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const resolved = (over: Partial<Resolved> = {}): Resolved => ({
  key: 'devtest.k.v',
  parameterId: 'p1',
  dataType: 'STRING',
  sensitivity: 'INTERNAL',
  criticality: 'STANDARD',
  value: 'visible',
  sourceScope: 'PLATFORM',
  scopeRef: null,
  version: 1,
  versionId: 'v1',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveTo: null,
  ...over,
});
const change = (over: Partial<ChangeRequest> = {}): ChangeRequest => ({
  changeRequestId: '6f1d0c3e-9d1f-4a43-8f64-0a3b6f0f1111',
  parameterId: 'p1',
  parameterKey: 'devtest.k.v',
  sensitivity: 'INTERNAL',
  scopeType: 'PLATFORM',
  scopeRef: null,
  proposedValue: 'visible',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  effectiveTo: null,
  reason: 'r',
  requestedBy: 'admin-a',
  approvalPolicy: 'NONE',
  state: 'DRAFT',
  version: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

beforeAll(async () => {
  keys = await createTestKeys('k1');
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  app = await buildApp({ cfg, verifier, configuration: svc as unknown as ConfigurationService, readiness: async () => ({}) });
  await app.ready();
});
afterAll(() => app.close());

describe('configuration API access control', () => {
  const routes: ['GET' | 'POST', string, string][] = [
    ['GET', '/parameters', 'configuration-read'],
    ['GET', '/parameters/devtest.k.v', 'configuration-read'],
    ['POST', '/resolve', 'configuration-read'],
    ['GET', '/snapshots/6f1d0c3e-9d1f-4a43-8f64-0a3b6f0f1111', 'configuration-read'],
    ['GET', '/change-requests', 'configuration-read'],
    ['POST', '/parameters', 'configuration-write'],
    ['POST', '/change-requests', 'configuration-write'],
    ['POST', '/change-requests/6f1d0c3e-9d1f-4a43-8f64-0a3b6f0f1111/submit', 'configuration-write'],
    ['POST', '/change-requests/6f1d0c3e-9d1f-4a43-8f64-0a3b6f0f1111/publish', 'configuration-write'],
    ['POST', '/change-requests/6f1d0c3e-9d1f-4a43-8f64-0a3b6f0f1111/approve', 'configuration-approve'],
    ['POST', '/change-requests/6f1d0c3e-9d1f-4a43-8f64-0a3b6f0f1111/reject', 'configuration-approve'],
  ];
  it('requires authentication on every route (401)', async () => {
    for (const [m, u] of routes) expect((await call(m, u, undefined, m === 'POST' ? {} : undefined)).statusCode, `${m} ${u}`).toBe(401);
  });
  it('requires the specific permission: an admin without it gets 403', async () => {
    for (const [m, u, perm] of routes) {
      const other = ['configuration-read', 'configuration-write', 'configuration-approve'].filter((p) => p !== perm);
      const r = await call(m, u, await adminToken(other), m === 'POST' ? {} : undefined);
      expect(r.statusCode, `${m} ${u}`).toBe(403);
      expect(ErrorResponse.parse(r.json()).error.category).toBe('AUTHORIZATION');
    }
  });
  it('customers, providers and web-client tokens can never reach it, even carrying the role names', async () => {
    const customer = await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } });
    expect((await call('GET', '/parameters', customer)).statusCode).toBe(403);
    const spoofedOnWebClient = await signToken(keys, {
      claims: { azp: 'bananagig-web', resource_access: { 'bananagig-web': { roles: ['configuration-read'] } } },
    });
    expect((await call('GET', '/parameters', spoofedOnWebClient)).statusCode).toBe(403);
    const adminRolesFromOtherClient = await signToken(keys, {
      claims: { azp: 'bananagig-dev-test', resource_access: { 'bananagig-admin': { roles: ['configuration-read'] } } },
    });
    expect((await call('GET', '/parameters', adminRolesFromOtherClient)).statusCode).toBe(403);
  });
});

describe('configuration API behavior', () => {
  it('redacts SENSITIVE values in resolve, snapshots and change requests', async () => {
    svc.resolveMany.mockResolvedValue({
      at: new Date('2026-01-02T00:00:00Z'),
      values: new Map([
        ['devtest.k.a', resolved({ key: 'devtest.k.a' })],
        ['devtest.k.b', resolved({ key: 'devtest.k.b', sensitivity: 'SENSITIVE', value: 'TOP-SECRET' })],
      ]),
      sources: new Map(),
    });
    const r = await call('POST', '/resolve', await adminToken(['configuration-read']), { keys: ['devtest.k.a', 'devtest.k.b'], context: { market: 'us-ca' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('TOP-SECRET');
    const vals = r.json().data.values as { key: string; value: unknown; redacted: boolean }[];
    expect(vals.find((v) => v.key === 'devtest.k.a')).toMatchObject({ value: 'visible', redacted: false });
    expect(vals.find((v) => v.key === 'devtest.k.b')).toMatchObject({ value: null, redacted: true });
    expect(svc.resolveMany).toHaveBeenCalledWith(['devtest.k.a', 'devtest.k.b'], { market: 'us-ca' }, { at: undefined });

    const snap: Snapshot = {
      snapshotId: 's1',
      evaluatedAt: new Date(),
      context: {},
      purpose: 'p',
      createdBy: 'u',
      createdAt: new Date(),
      items: [resolved({ sensitivity: 'SENSITIVE', value: 'TOP-SECRET' })],
    };
    svc.createSnapshot.mockResolvedValue(snap);
    svc.getSnapshot.mockResolvedValue(snap);
    const s1 = await call('POST', '/snapshots', await adminToken(['configuration-read']), { keys: ['devtest.k.a'], context: {}, purpose: 'p' });
    expect(s1.statusCode).toBe(201);
    expect(s1.body).not.toContain('TOP-SECRET');
    const snapshot = await call('GET', '/snapshots/6f1d0c3e-9d1f-4a43-8f64-0a3b6f0f1111', await adminToken(['configuration-read']));
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.body).not.toContain('TOP-SECRET');

    svc.getChangeRequest.mockResolvedValue(change({ sensitivity: 'SENSITIVE', proposedValue: 'TOP-SECRET' }));
    const c = await call('GET', '/change-requests/6f1d0c3e-9d1f-4a43-8f64-0a3b6f0f1111', await adminToken(['configuration-read']));
    expect(c.body).not.toContain('TOP-SECRET');
    expect(c.json().data).toMatchObject({ proposedValue: null, redacted: true });
  });

  it('maps typed configuration errors to the standard error model without leaking internals', async () => {
    const t = await adminToken(['configuration-read']);
    const expectErr = async (error: ConfigurationError, status: number, category: string, code: string) => {
      svc.resolveMany.mockRejectedValueOnce(error);
      const r = await call('POST', '/resolve', t, { keys: ['devtest.k.a'], context: {} });
      expect(r.statusCode, error.code).toBe(status);
      expect(ErrorResponse.parse(r.json()).error).toMatchObject({ category, code });
      expect(r.body).not.toContain('SELECT');
      expect(r.body).not.toContain('connect ECONNREFUSED');
    };
    await expectErr(new ConfigurationError('NO_VALUE', 'no value', { keys: ['devtest.k.a'] }), 404, 'NOT_FOUND', 'CONFIGURATION_VALUE_NOT_FOUND');
    await expectErr(new ConfigurationError('PARAMETER_NOT_FOUND', 'unknown', { keys: ['devtest.k.a'] }), 404, 'NOT_FOUND', 'CONFIGURATION_NOT_FOUND');
    await expectErr(
      new ConfigurationError('UNAVAILABLE', 'down', { cause: 'connect ECONNREFUSED 10.0.0.5:5432' }),
      503,
      'DEPENDENCY',
      'CONFIGURATION_UNAVAILABLE',
    );
    await expectErr(new ConfigurationError('CONFLICT', 'overlap'), 409, 'CONFLICT', 'CONFIGURATION_CONFLICT');
    await expectErr(new ConfigurationError('INVALID_STATE', 'wrong state'), 409, 'CONFLICT', 'CONFIGURATION_INVALID_STATE');
    await expectErr(new ConfigurationError('FORBIDDEN_APPROVER', 'self approval'), 403, 'AUTHORIZATION', 'CONFIGURATION_FORBIDDEN_APPROVER');
    await expectErr(new ConfigurationError('VALIDATION_FAILED', 'bad value'), 400, 'VALIDATION', 'CONFIGURATION_VALIDATION_FAILED');
    await expectErr(new ConfigurationError('SCOPE_NOT_ALLOWED', 'no gig override'), 400, 'VALIDATION', 'CONFIGURATION_SCOPE_NOT_ALLOWED');
  });

  it('validates request bodies before calling the service', async () => {
    const t = await adminToken(['configuration-read', 'configuration-write']);
    for (const [url, body] of [
      ['/resolve', { keys: [] }],
      ['/resolve', { keys: ['Bad Key'] }],
      ['/resolve', { keys: ['devtest.k.a'], context: { galaxy: 'x' } }],
      ['/parameters', { key: 'a.b' }],
      ['/change-requests', { parameterKey: 'a.b', scopeType: 'WORLD', value: 1, reason: 'r' }],
    ] as const) {
      const r = await call('POST', url, t, body);
      expect(r.statusCode, `${url} ${JSON.stringify(body)}`).toBe(400);
      expect(ErrorResponse.parse(r.json()).error.category).toBe('VALIDATION');
    }
  });

  it('passes the authenticated subject as the actor, and the correlation id through', async () => {
    svc.createChangeRequest.mockResolvedValue(change());
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/configuration/change-requests',
      headers: { authorization: `Bearer ${await adminToken(['configuration-write'], { sub: 'admin-zed' })}`, 'x-correlation-id': 'corr-cfg-api-1' },
      payload: { parameterKey: 'devtest.k.v', scopeType: 'PLATFORM', value: 'v', reason: 'because' },
    });
    expect(r.statusCode).toBe(201);
    expect(svc.createChangeRequest).toHaveBeenCalledWith(expect.objectContaining({ parameterKey: 'devtest.k.v', reason: 'because' }), 'admin-zed');
    expect(r.json().meta.correlationId).toBe('corr-cfg-api-1');
  });
});
