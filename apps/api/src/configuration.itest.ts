// The whole configuration workflow over HTTP: real PostgreSQL (isolated, migrated), real auth plugin, forged-but-signed tokens.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import { ConfigurationService, MemoryConfigCache } from '@bananagig/configuration';
import { ErrorResponse } from '@bananagig/contracts';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';

let iso: IsolatedDatabase;
let app: FastifyInstance;
let keys: TestKeys;
const ROLES = ['admin-console-access', 'configuration-read', 'configuration-write', 'configuration-approve'];
const token = (sub: string) =>
  signToken(keys, { claims: { sub, azp: 'bananagig-admin', realm_access: { roles: [] }, resource_access: { 'bananagig-admin': { roles: ROLES } } } });
let tokenA: string;
let tokenB: string;
const api = async (method: 'GET' | 'POST', url: string, t: string, payload?: unknown) => {
  const r = await app.inject({
    method,
    url: `/api/v1/configuration${url}`,
    headers: { authorization: `Bearer ${t}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: r.statusCode, body: r.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

beforeAll(async () => {
  iso = await createIsolatedDatabase();
  keys = await createTestKeys('k1');
  const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  const configuration = new ConfigurationService({ database: iso.database, cache: new MemoryConfigCache(), env: 'test', allowTestKeys: true });
  app = await buildApp({ cfg, verifier, configuration, readiness: async () => ({}) });
  await app.ready();
  [tokenA, tokenB] = [await token('admin-a'), await token('admin-b')];
});
afterAll(async () => {
  await app.close();
  await iso.drop();
});

describe('configuration API workflow (HTTP, real database)', () => {
  it('creates a parameter, runs the second-approver workflow, resolves by scope and snapshots', async () => {
    const created = await api('POST', '/parameters', tokenA, {
      key: 'devtest.http.window_hours',
      dataType: 'INTEGER',
      description: 'neutral test parameter',
      ownerRole: 'platform',
      approvalPolicy: 'SECOND_APPROVER',
      validationRules: { min: 1, max: 100 },
      allowedOverrideScopes: ['MARKET'],
    });
    expect(created.status).toBe(201);
    expect(created.body.data.allowedScopes).toEqual(['PLATFORM', 'MARKET']);
    expect((await api('GET', '/parameters/devtest.http.window_hours', tokenA)).body.data.key).toBe('devtest.http.window_hours');
    expect((await api('GET', '/parameters', tokenA)).body.data.length).toBeGreaterThanOrEqual(1);

    const publish = async (scopeType: string, scopeRef: string | null, value: number) => {
      const cr = await api('POST', '/change-requests', tokenA, { parameterKey: 'devtest.http.window_hours', scopeType, scopeRef, value, reason: 'http test' });
      expect(cr.status).toBe(201);
      const id = cr.body.data.changeRequestId as string;
      expect((await api('POST', `/change-requests/${id}/submit`, tokenA, {})).body.data.state).toBe('PENDING_APPROVAL');
      const self = await api('POST', `/change-requests/${id}/approve`, tokenA, {});
      expect(self.status).toBe(403);
      expect(ErrorResponse.parse(self.body).error.code).toBe('CONFIGURATION_FORBIDDEN_APPROVER');
      expect((await api('POST', `/change-requests/${id}/approve`, tokenB, { comment: 'ok' })).body.data.state).toBe('APPROVED');
      const pub = await api('POST', `/change-requests/${id}/publish`, tokenA, {});
      expect(pub.body.data).toMatchObject({ state: 'ACTIVE', version: expect.any(Number) });
      return id;
    };
    await publish('PLATFORM', null, 24);
    await publish('MARKET', 'us-ca', 48);

    const res = await api('POST', '/resolve', tokenA, { keys: ['devtest.http.window_hours'], context: { market: 'us-ca' } });
    expect(res.body.data.values[0]).toMatchObject({ value: 48, sourceScope: 'MARKET', scopeRef: 'us-ca', version: 1 });
    expect((await api('POST', '/resolve', tokenA, { keys: ['devtest.http.window_hours'], context: { market: 'us-ny' } })).body.data.values[0]).toMatchObject({
      value: 24,
      sourceScope: 'PLATFORM',
    });

    const snap = await api('POST', '/snapshots', tokenA, { keys: ['devtest.http.window_hours'], context: { market: 'us-ca' }, purpose: 'http test' });
    expect(snap.status).toBe(201);
    await publish('MARKET', 'us-ca', 72);
    expect((await api('POST', '/resolve', tokenA, { keys: ['devtest.http.window_hours'], context: { market: 'us-ca' } })).body.data.values[0]).toMatchObject({
      value: 72,
      version: 2,
    });
    const stored = await api('GET', `/snapshots/${snap.body.data.snapshotId}`, tokenA);
    expect(stored.body.data.items[0]).toMatchObject({ value: 48, version: 1 }); // unchanged by the later change
  });

  it('rejects invalid values, forbidden scopes and unknown parameters with standard errors', async () => {
    expect(
      (await api('POST', '/change-requests', tokenA, { parameterKey: 'devtest.http.window_hours', scopeType: 'PLATFORM', value: 0, reason: 'too small' })).body
        .error.code,
    ).toBe('CONFIGURATION_VALIDATION_FAILED');
    expect(
      (
        await api('POST', '/change-requests', tokenA, {
          parameterKey: 'devtest.http.window_hours',
          scopeType: 'GIG',
          scopeRef: 'g',
          value: 5,
          reason: 'no gig override',
        })
      ).body.error.code,
    ).toBe('CONFIGURATION_SCOPE_NOT_ALLOWED');
    expect((await api('GET', '/parameters/devtest.http.missing', tokenA)).status).toBe(404);
    expect((await api('POST', '/resolve', tokenA, { keys: ['devtest.http.missing'], context: {} })).status).toBe(404);
  });

  it('returns CONFIGURATION_VALUE_NOT_FOUND when a required parameter has no value (no fallback)', async () => {
    await api('POST', '/parameters', tokenA, {
      key: 'devtest.http.empty',
      dataType: 'STRING',
      description: 'no value ever set',
      ownerRole: 'platform',
      approvalPolicy: 'NONE',
    });
    const r = await api('POST', '/resolve', tokenA, { keys: ['devtest.http.empty'], context: {} });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('CONFIGURATION_VALUE_NOT_FOUND');
  });

  it('never returns SENSITIVE values, but still versions and snapshots them', async () => {
    await api('POST', '/parameters', tokenA, {
      key: 'devtest.http.sensitive',
      dataType: 'STRING',
      description: 'sensitive test',
      ownerRole: 'platform',
      approvalPolicy: 'NONE',
      sensitivity: 'SENSITIVE',
    });
    const cr = await api('POST', '/change-requests', tokenA, {
      parameterKey: 'devtest.http.sensitive',
      scopeType: 'PLATFORM',
      value: 'sentinel-secret-value',
      reason: 'sensitive',
    });
    expect(cr.body.data.redacted).toBe(true);
    await api('POST', `/change-requests/${cr.body.data.changeRequestId}/submit`, tokenA, {});
    await api('POST', `/change-requests/${cr.body.data.changeRequestId}/publish`, tokenA, {});
    const responses = [
      await api('POST', '/resolve', tokenA, { keys: ['devtest.http.sensitive'], context: {} }),
      await api('POST', '/snapshots', tokenA, { keys: ['devtest.http.sensitive'], context: {}, purpose: 'sensitive' }),
      await api('GET', `/change-requests/${cr.body.data.changeRequestId}`, tokenA),
      await api('GET', '/change-requests', tokenA),
    ];
    for (const r of responses) expect(JSON.stringify(r.body)).not.toContain('sentinel-secret-value');
    expect(responses[0]!.body.data.values[0]).toMatchObject({ value: null, redacted: true, version: 1 });
  });

  it('lists change requests by state', async () => {
    const r = await api('GET', '/change-requests?state=ACTIVE', tokenA);
    expect(r.status).toBe(200);
    expect(r.body.data.every((c: { state: string }) => c.state === 'ACTIVE')).toBe(true);
    expect((await api('GET', '/change-requests?state=BOGUS', tokenA)).status).toBe(400);
  });
});
