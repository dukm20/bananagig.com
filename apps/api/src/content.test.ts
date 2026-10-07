import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import {
  ContentError,
  type ContentEntry,
  type ContentLocale,
  type ContentService,
  type ContentSnapshot,
  type ContentVersion,
  type ResolvedContent,
} from '@bananagig/content';
import { CONTENT_ERROR_CODES, ErrorResponse, type ContentErrorCode } from '@bananagig/contracts';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { buildApp, MAX_PATH_PARAM_LENGTH } from './app';

const cfg = loadConfig({ service: 'bananagig-api', env: { NODE_ENV: 'test' } });
let keys: TestKeys;
let app: FastifyInstance;

const svc = {
  listEntries: vi.fn(),
  getEntry: vi.fn(),
  findEntry: vi.fn(),
  createEntry: vi.fn(),
  setEntryActive: vi.fn(),
  createVersion: vi.fn(),
  getVersion: vi.fn(),
  submit: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  cancel: vi.fn(),
  publish: vi.fn(),
  listLocales: vi.fn(),
  registerLocale: vi.fn(),
  setLocaleActive: vi.fn(),
  resolve: vi.fn(),
  resolveMany: vi.fn(),
  createSnapshot: vi.fn(),
  getSnapshot: vi.fn(),
};

const ROLES = ['content-read', 'content-write', 'content-approve'];
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
const call = async (method: 'GET' | 'POST', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method,
    url: `/api/v1/content${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const errorOf = (r: { json: () => unknown }) => ErrorResponse.parse(r.json()).error;

const ID = '6f1d0c3e-9d1f-4a43-8f64-0a3b6f0f1111';
const T0 = new Date('2026-01-01T00:00:00Z');
const EN_US: ContentLocale = {
  locale: 'en-US',
  displayName: 'English (United States)',
  language: 'en',
  script: null,
  region: 'US',
  isActive: true,
  isPlatformDefault: true,
};
const ES_US: ContentLocale = {
  locale: 'es-US',
  displayName: 'Spanish (United States)',
  language: 'es',
  script: null,
  region: 'US',
  isActive: true,
  isPlatformDefault: false,
};
const NAME_VARIABLE = { name: 'name', type: 'STRING' as const, required: true, description: 'Display name', example: 'Ada', piiClass: 'NONE' as const };

const resolved = (over: Partial<ResolvedContent> = {}): ResolvedContent => ({
  key: 'shell.tagline',
  entryId: 'entry-1',
  contentType: 'UI_LABEL',
  sensitivity: 'PUBLIC',
  criticality: 'STANDARD',
  requestedLocale: 'en-US',
  resolvedLocale: 'en-US',
  fallback: { applied: false, chain: ['en-US'] },
  version: 1,
  versionId: ID,
  sourceScope: 'PLATFORM',
  scopeRef: null,
  effectiveFrom: T0,
  effectiveTo: null,
  body: 'Local help, done fast',
  bodySha256: 'a'.repeat(64),
  variables: [],
  ...over,
});
const entry = (over: Partial<ContentEntry> = {}): ContentEntry => ({
  entryId: 'entry-1',
  key: 'shell.tagline',
  contentType: 'UI_LABEL',
  ownerRole: 'CONTENT',
  description: 'Home tagline',
  sensitivity: 'PUBLIC',
  criticality: 'STANDARD',
  approvalPolicy: 'OWNER_APPROVAL',
  fallbackPolicy: 'CHAIN',
  maxScopeType: 'PLATFORM',
  isActive: true,
  variables: [],
  createdBy: 'admin-a',
  createdAt: T0,
  updatedAt: T0,
  ...over,
});
const version = (over: Partial<ContentVersion> = {}): ContentVersion => ({
  versionId: ID,
  entryId: 'entry-1',
  entryKey: 'shell.tagline',
  locale: 'en-US',
  scopeType: 'PLATFORM',
  scopeRef: null,
  version: 1,
  status: 'DRAFT',
  approvalPolicy: 'OWNER_APPROVAL',
  effectiveFrom: T0,
  effectiveTo: null,
  reason: 'initial copy',
  createdBy: 'admin-a',
  createdAt: T0,
  updatedAt: T0,
  bodySha256: 'a'.repeat(64),
  body: 'Local help, done fast',
  ...over,
});
const snapshot = (): ContentSnapshot => ({
  snapshotId: ID,
  evaluatedAt: T0,
  requestedLocale: 'en-US',
  context: {},
  purpose: 'test',
  createdBy: 'admin-a',
  createdAt: T0,
  items: [{ ...resolved(), fallback: undefined } as never],
});

/** The fake service behaves like the real one for visibility: with includeInternal false, INTERNAL entries are indistinguishable from unknown ones. */
let catalog: Record<string, ResolvedContent> = {};
const fakeResolveMany = async (keysIn: string[], opts: { includeInternal?: boolean; at?: Date }) => {
  const items = new Map<string, ResolvedContent>();
  const missing = new Map<string, 'ENTRY_NOT_FOUND' | 'NO_CONTENT'>();
  for (const k of keysIn) {
    const r = catalog[k];
    if (!r || (r.sensitivity === 'INTERNAL' && opts.includeInternal === false)) missing.set(k, 'ENTRY_NOT_FOUND');
    else items.set(k, r);
  }
  return { items, sources: new Map(), missing, at: opts.at ?? new Date('2026-02-01T00:00:00Z') };
};

beforeAll(async () => {
  keys = await createTestKeys('k1');
  const verifier = createTokenVerifier({
    issuer: TEST_ISSUER,
    apiAudience: 'bananagig-api',
    jwks: keys.getKey,
    webClientId: 'bananagig-web',
    adminClientId: 'bananagig-admin',
  });
  app = await buildApp({ cfg, verifier, configuration: {} as never, content: svc as unknown as ContentService, readiness: async () => ({}) });
  await app.ready();
});
afterAll(() => app.close());

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset();
  catalog = {
    'shell.tagline': resolved(),
    'shell.secret': resolved({ key: 'shell.secret', sensitivity: 'INTERNAL', body: 'INTERNAL-ONLY-COPY' }),
    'shell.greeting': resolved({ key: 'shell.greeting', body: 'Hello {name}', variables: [NAME_VARIABLE] }),
  };
  svc.resolveMany.mockImplementation(fakeResolveMany);
  svc.resolve.mockImplementation(async (key: string, opts: { includeInternal?: boolean; locale: string }) => {
    const r = await fakeResolveMany([key], opts);
    const item = r.items.get(key);
    if (!item) throw new ContentError('ENTRY_NOT_FOUND', 'content entry not found', { key, locale: opts.locale });
    return item;
  });
  svc.findEntry.mockResolvedValue(entry());
  svc.getVersion.mockResolvedValue(version());
  for (const f of [svc.submit, svc.approve, svc.reject, svc.cancel, svc.publish]) f.mockResolvedValue(version());
});

type Route = { method: 'GET' | 'POST'; url: string; permission: string; legal?: boolean };
const KEY = 'shell.tagline';
const protectedRoutes: Route[] = [
  { method: 'GET', url: '/entries', permission: 'content-read' },
  { method: 'GET', url: `/entries/${KEY}`, permission: 'content-read' },
  { method: 'POST', url: '/entries', permission: 'content-write' },
  { method: 'POST', url: `/entries/${KEY}/activation`, permission: 'content-write', legal: true },
  { method: 'POST', url: `/entries/${KEY}/versions`, permission: 'content-write' },
  { method: 'POST', url: `/versions/${ID}/submit`, permission: 'content-write', legal: true },
  { method: 'POST', url: `/versions/${ID}/approve`, permission: 'content-approve', legal: true },
  { method: 'POST', url: `/versions/${ID}/reject`, permission: 'content-approve', legal: true },
  { method: 'POST', url: `/versions/${ID}/cancel`, permission: 'content-write' },
  { method: 'POST', url: `/versions/${ID}/publish`, permission: 'content-write', legal: true },
  { method: 'POST', url: '/locales', permission: 'content-write' },
  { method: 'POST', url: '/locales/es-US/activation', permission: 'content-write' },
  { method: 'POST', url: '/snapshots', permission: 'content-read' },
  { method: 'GET', url: `/snapshots/${ID}`, permission: 'content-read' },
];

describe('content API access control (management routes)', () => {
  it('returns 401 before any validation on every protected route, with an empty, invalid or missing body and malformed params', async () => {
    for (const r of protectedRoutes) {
      for (const payload of r.method === 'POST' ? [undefined, {}, { garbage: true }] : [undefined]) {
        const res = await call(r.method, r.url, undefined, payload);
        expect(res.statusCode, `${r.method} ${r.url} ${JSON.stringify(payload)}`).toBe(401);
        expect(errorOf(res).category).toBe('AUTHENTICATION');
      }
    }
    expect((await call('POST', '/versions/not-a-uuid/submit', undefined, {})).statusCode).toBe(401);
    expect((await call('GET', '/snapshots/not-a-uuid')).statusCode).toBe(401);
    expect((await call('POST', `/entries/${KEY}/activation`, 'not.a.token', {})).statusCode).toBe(401);
    expect(Object.values(svc).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it('returns 403 (before validation) when an admin lacks the specific permission', async () => {
    for (const r of protectedRoutes) {
      const others = [...ROLES, 'content-legal'].filter((p) => p !== r.permission);
      const res = await call(r.method, r.url, await adminToken(others), r.method === 'POST' ? {} : undefined);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHORIZATION', code: 'INSUFFICIENT_PERMISSIONS' });
    }
    expect(Object.values(svc).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it('keeps customers, web-client tokens and non-admin contexts out even when they carry the role names', async () => {
    const customer = await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } });
    const spoofedOnWebClient = await signToken(keys, {
      claims: { azp: 'bananagig-web', resource_access: { 'bananagig-web': { roles: [...ROLES, 'content-legal'] } } },
    });
    const adminRolesFromOtherClient = await signToken(keys, {
      claims: { azp: 'bananagig-dev-test', resource_access: { 'bananagig-admin': { roles: [...ROLES, 'content-legal'] } } },
    });
    for (const t of [customer, spoofedOnWebClient, adminRolesFromOtherClient]) {
      for (const r of protectedRoutes) {
        const res = await call(r.method, r.url, t, r.method === 'POST' ? {} : undefined);
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      }
    }
    expect(Object.values(svc).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it('requires content-legal on top of the ordinary permission for LEGAL-owned entries, and never for other entries', async () => {
    svc.findEntry.mockResolvedValue(entry({ key: 'legal.terms', ownerRole: 'LEGAL', contentType: 'LEGAL' }));
    const withoutLegal = await adminToken(ROLES);
    const withLegal = await adminToken([...ROLES, 'content-legal']);
    const createVersion = { locale: 'en-US', body: 'Terms', reason: 'initial' };
    const legalCalls: [string, string, unknown][] = [
      ['POST', '/entries/legal.terms/versions', createVersion],
      ...['submit', 'approve', 'reject', 'publish'].map((a): [string, string, unknown] => ['POST', `/versions/${ID}/${a}`, {}]),
    ];
    for (const [m, u, body] of legalCalls) {
      const denied = await call(m as 'POST', u, withoutLegal, body);
      expect(denied.statusCode, u).toBe(403);
      expect(errorOf(denied).code).toBe('INSUFFICIENT_PERMISSIONS');
    }
    expect(svc.createVersion).not.toHaveBeenCalled();
    expect(svc.submit).not.toHaveBeenCalled();
    expect(svc.approve).not.toHaveBeenCalled();
    expect(svc.reject).not.toHaveBeenCalled();
    expect(svc.publish).not.toHaveBeenCalled();

    svc.getVersion.mockResolvedValue(version({ entryKey: 'legal.terms' }));
    svc.createVersion.mockResolvedValue(version({ entryKey: 'legal.terms' }));
    for (const [m, u, body] of legalCalls) expect((await call(m as 'POST', u, withLegal, body)).statusCode, u).toBeLessThan(300);
    expect(svc.publish).toHaveBeenCalledTimes(1);

    // create-entry: ownerRole LEGAL or content type LEGAL
    const legalEntry = { key: 'legal.privacy', contentType: 'LEGAL', ownerRole: 'LEGAL', description: 'Privacy policy' };
    expect((await call('POST', '/entries', withoutLegal, legalEntry)).statusCode).toBe(403);
    expect((await call('POST', '/entries', withoutLegal, { ...legalEntry, ownerRole: 'CONTENT' })).statusCode).toBe(403);
    expect((await call('POST', '/entries', withoutLegal, { ...legalEntry, contentType: 'MARKDOWN' })).statusCode).toBe(403);
    expect(svc.createEntry).not.toHaveBeenCalled();
    svc.createEntry.mockResolvedValue(entry({ key: 'legal.privacy', ownerRole: 'LEGAL', contentType: 'LEGAL' }));
    expect((await call('POST', '/entries', withLegal, legalEntry)).statusCode).toBe(201);

    // ordinary entries need only the ordinary permission
    svc.findEntry.mockResolvedValue(entry());
    svc.getVersion.mockResolvedValue(version());
    for (const a of ['submit', 'publish']) expect((await call('POST', `/versions/${ID}/${a}`, withoutLegal, {})).statusCode).toBe(200);
    svc.createEntry.mockResolvedValue(entry());
    expect(
      (await call('POST', '/entries', withoutLegal, { key: 'shell.other', contentType: 'UI_LABEL', ownerRole: 'CONTENT', description: 'd' })).statusCode,
    ).toBe(201);
  });

  it('does not require content-legal for cancelling a version', async () => {
    svc.findEntry.mockResolvedValue(entry({ key: 'legal.terms', ownerRole: 'LEGAL', contentType: 'LEGAL' }));
    svc.getVersion.mockResolvedValue(version({ entryKey: 'legal.terms' }));
    expect((await call('POST', `/versions/${ID}/cancel`, await adminToken(ROLES), {})).statusCode).toBe(200);
  });

  it('requires content-legal to activate or deactivate a LEGAL-owned entry (taking a legal document offline), and never for other entries', async () => {
    const withoutLegal = await adminToken(ROLES);
    const withLegal = await adminToken([...ROLES, 'content-legal']);
    const body = { active: false, reason: 'retire' };
    svc.findEntry.mockResolvedValue(entry({ key: 'legal.terms', ownerRole: 'LEGAL', contentType: 'LEGAL' }));
    svc.setEntryActive.mockResolvedValue(entry({ key: 'legal.terms', ownerRole: 'LEGAL', contentType: 'LEGAL', isActive: false }));
    const denied = await call('POST', '/entries/legal.terms/activation', withoutLegal, body);
    expect(denied.statusCode).toBe(403);
    expect(errorOf(denied)).toMatchObject({ category: 'AUTHORIZATION', code: 'INSUFFICIENT_PERMISSIONS' });
    expect((await call('POST', '/entries/legal.terms/activation', withoutLegal, { ...body, active: true })).statusCode).toBe(403);
    expect(svc.setEntryActive).not.toHaveBeenCalled();
    expect((await call('POST', '/entries/legal.terms/activation', withLegal, body)).statusCode).toBe(200);
    expect(svc.setEntryActive).toHaveBeenCalledWith('legal.terms', false, 'retire', 'admin-a');

    // a LEGAL owner on a non-LEGAL content type is gated too; the gate follows owner_role, looked up from the stored entry
    svc.setEntryActive.mockClear();
    svc.findEntry.mockResolvedValue(entry({ key: 'legal.notice', ownerRole: 'LEGAL', contentType: 'MARKDOWN' }));
    expect((await call('POST', '/entries/legal.notice/activation', withoutLegal, body)).statusCode).toBe(403);
    expect(svc.setEntryActive).not.toHaveBeenCalled();

    // ordinary entries: content-write alone is enough
    svc.findEntry.mockResolvedValue(entry());
    svc.setEntryActive.mockResolvedValue(entry({ isActive: false }));
    expect((await call('POST', `/entries/${KEY}/activation`, withoutLegal, body)).statusCode).toBe(200);
    expect(svc.setEntryActive).toHaveBeenCalledTimes(1);
  });

  it('keeps locale activation under content-write only (locales are not entries; recorded as DEBT-0028)', async () => {
    svc.setLocaleActive.mockResolvedValue({ ...ES_US, isActive: false });
    const r = await call('POST', '/locales/es-US/activation', await adminToken(ROLES), { active: false, reason: 'retire' });
    expect(r.statusCode).toBe(200);
  });
});

describe('content API visibility of resolution (public routes)', () => {
  const resolveBody = (over: Record<string, unknown> = {}) => ({ key: 'shell.tagline', locale: 'en-US', ...over });

  it('lets anonymous callers resolve PUBLIC entries, without internal metadata or the template', async () => {
    const r = await call('POST', '/resolve', undefined, resolveBody({ context: { market: 'us-ca' } }));
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({
      key: 'shell.tagline',
      format: 'text',
      value: 'Local help, done fast',
      resolvedLocale: 'en-US',
      versionId: ID,
      effectiveFrom: T0.toISOString(),
    });
    expect(r.json().data.template).toBeUndefined();
    for (const internal of ['sensitivity', 'criticality', 'entryId', 'body"', 'variables']) expect(r.body).not.toContain(internal);
    expect(svc.resolve).toHaveBeenCalledWith(
      'shell.tagline',
      expect.objectContaining({ locale: 'en-US', context: { market: 'us-ca' }, includeInternal: false, at: undefined }),
    );
  });

  it('never discloses effectiveTo to callers without content-read (a scheduled successor closes the current period), but still shows it to management', async () => {
    const END = '2026-03-01T00:00:00.000Z';
    catalog['shell.tagline'] = resolved({ effectiveTo: new Date(END) });
    const pub = { key: 'shell.tagline', locale: 'en-US' };
    const customer = await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } });
    const adminWithoutRead = await adminToken(['content-write']);
    for (const t of [undefined, customer, adminWithoutRead]) {
      const one = await call('POST', '/resolve', t, pub);
      expect(one.statusCode).toBe(200);
      expect(one.json().data.effectiveTo, 'resolve').toBeNull();
      expect(one.json().data.effectiveFrom).toBe(T0.toISOString());
      expect(one.body).not.toContain(END);
      const many = await call('POST', '/resolve-many', t, { keys: ['shell.tagline'], locale: 'en-US' });
      expect(many.json().data.items[0].effectiveTo, 'resolve-many').toBeNull();
      expect(many.body).not.toContain(END);
    }
    const reader = await adminToken(['content-read']);
    expect((await call('POST', '/resolve', reader, pub)).json().data.effectiveTo).toBe(END);
    expect((await call('POST', '/resolve-many', reader, { keys: ['shell.tagline'], locale: 'en-US' })).json().data.items[0].effectiveTo).toBe(END);
  });

  it('accepts a request without a context (defaults to an empty context)', async () => {
    expect((await call('POST', '/resolve', undefined, resolveBody())).statusCode).toBe(200);
    expect((await call('POST', '/resolve-many', undefined, { keys: ['shell.tagline'], locale: 'en-US' })).statusCode).toBe(200);
  });

  it('treats INTERNAL entries as not found for anonymous callers, indistinguishable from unknown entries', async () => {
    const internal = await call('POST', '/resolve', undefined, resolveBody({ key: 'shell.secret' }));
    const unknown = await call('POST', '/resolve', undefined, resolveBody({ key: 'shell.nonexistent' }));
    expect(internal.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(errorOf(internal)).toMatchObject({ category: 'NOT_FOUND', code: 'CONTENT_ENTRY_NOT_FOUND' });
    expect(errorOf(internal).message).toBe(errorOf(unknown).message);
    expect(internal.body).not.toContain('INTERNAL-ONLY-COPY');
  });

  it('still hides INTERNAL entries if the service ever returned one to an anonymous caller (defense in depth)', async () => {
    svc.resolve.mockResolvedValue(catalog['shell.secret']);
    svc.resolveMany.mockResolvedValue({ items: new Map([['shell.secret', catalog['shell.secret']]]), sources: new Map(), missing: new Map(), at: T0 });
    expect((await call('POST', '/resolve', undefined, resolveBody({ key: 'shell.secret' }))).statusCode).toBe(404);
    const many = await call('POST', '/resolve-many', undefined, { keys: ['shell.secret'], locale: 'en-US' });
    expect(many.json().data.items).toEqual([]);
    expect(many.body).not.toContain('INTERNAL-ONLY-COPY');
  });

  it('omits INTERNAL and unknown keys from a batch for anonymous callers and keeps the request order', async () => {
    const r = await call('POST', '/resolve-many', undefined, {
      keys: ['shell.greeting', 'shell.secret', 'shell.nonexistent', 'shell.tagline', 'shell.greeting'],
      locale: 'en-US',
      variables: { 'shell.greeting': { name: 'Ada' } },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json().data.items as { key: string; value: string }[]).map((i) => [i.key, i.value])).toEqual([
      ['shell.greeting', 'Hello Ada'],
      ['shell.tagline', 'Local help, done fast'],
    ]);
    expect(r.json().data.evaluatedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(r.body).not.toContain('INTERNAL-ONLY-COPY');
    expect(svc.resolveMany).toHaveBeenCalledTimes(1);
  });

  it('rejects `at` and `includeTemplate` for anonymous callers with 403, but allows includeTemplate:false', async () => {
    for (const [url, body] of [
      ['/resolve', resolveBody({ at: '2026-03-01T00:00:00Z' })],
      ['/resolve', resolveBody({ includeTemplate: true })],
      ['/resolve-many', { keys: ['shell.tagline'], locale: 'en-US', at: '2026-03-01T00:00:00Z' }],
      ['/resolve-many', { keys: ['shell.tagline'], locale: 'en-US', includeTemplate: true }],
    ] as const) {
      const r = await call('POST', url, undefined, body);
      expect(r.statusCode, `${url} ${JSON.stringify(body)}`).toBe(403);
      expect(errorOf(r)).toMatchObject({ category: 'AUTHORIZATION', code: 'INSUFFICIENT_PERMISSIONS' });
    }
    expect(svc.resolve).not.toHaveBeenCalled();
    expect(svc.resolveMany).not.toHaveBeenCalled();
    expect((await call('POST', '/resolve', undefined, resolveBody({ includeTemplate: false }))).statusCode).toBe(200);
  });

  it('treats authenticated callers without content-read like anonymous callers', async () => {
    const customer = await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } });
    const adminWithoutRead = await adminToken(['content-write']);
    for (const t of [customer, adminWithoutRead]) {
      expect((await call('POST', '/resolve', t, resolveBody({ key: 'shell.secret' }))).statusCode).toBe(404);
      expect((await call('POST', '/resolve', t, resolveBody({ at: '2026-03-01T00:00:00Z' }))).statusCode).toBe(403);
      expect((await call('POST', '/resolve', t, resolveBody({ includeTemplate: true }))).statusCode).toBe(403);
      expect((await call('POST', '/resolve', t, resolveBody())).statusCode).toBe(200);
    }
  });

  it('rejects an invalid credential on a public route with 401 instead of silently treating it as anonymous', async () => {
    expect((await call('POST', '/resolve', 'bogus.token.value', resolveBody())).statusCode).toBe(401);
    expect((await call('GET', '/locales', 'bogus.token.value')).statusCode).toBe(401);
  });

  it('lets callers with content-read resolve INTERNAL entries, use `at` and receive the template', async () => {
    const t = await adminToken(['content-read']);
    const internal = await call('POST', '/resolve', t, resolveBody({ key: 'shell.secret', includeTemplate: true }));
    expect(internal.statusCode).toBe(200);
    expect(internal.json().data).toMatchObject({ key: 'shell.secret', value: 'INTERNAL-ONLY-COPY', template: 'INTERNAL-ONLY-COPY' });
    expect(svc.resolve).toHaveBeenLastCalledWith('shell.secret', expect.objectContaining({ includeInternal: true }));

    const at = await call('POST', '/resolve', t, resolveBody({ at: '2026-03-01T00:00:00Z' }));
    expect(at.statusCode).toBe(200);
    expect(svc.resolve).toHaveBeenLastCalledWith('shell.tagline', expect.objectContaining({ at: new Date('2026-03-01T00:00:00Z') }));

    const many = await call('POST', '/resolve-many', t, {
      keys: ['shell.secret', 'shell.greeting'],
      locale: 'en-US',
      includeTemplate: true,
      variables: { 'shell.greeting': { name: 'Ada' } },
    });
    expect(many.statusCode).toBe(200);
    expect((many.json().data.items as { key: string; template?: string }[]).map((i) => [i.key, i.template])).toEqual([
      ['shell.secret', 'INTERNAL-ONLY-COPY'],
      ['shell.greeting', 'Hello {name}'],
    ]);
  });

  it('returns only active locales to the public and all locales to content-read', async () => {
    svc.listLocales.mockResolvedValue([EN_US]);
    const pub = await call('GET', '/locales');
    expect(pub.statusCode).toBe(200);
    expect(pub.json().data).toEqual([
      { locale: 'en-US', displayName: 'English (United States)', language: 'en', script: null, region: 'US', isActive: true, isPlatformDefault: true },
    ]);
    expect(svc.listLocales).toHaveBeenLastCalledWith({ activeOnly: true });
    await call('GET', '/locales', await signToken(keys, { claims: { realm_access: { roles: ['customer'] } } }));
    expect(svc.listLocales).toHaveBeenLastCalledWith({ activeOnly: true });
    await call('GET', '/locales', await adminToken(['content-read']));
    expect(svc.listLocales).toHaveBeenLastCalledWith({ activeOnly: false });
  });

  it('renders variables, rejects a missing required variable and never echoes variable values or copy in errors', async () => {
    const ok = await call('POST', '/resolve', undefined, resolveBody({ key: 'shell.greeting', variables: { name: 'Ada <b>' } }));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.value).toBe('Hello Ada <b>'); // text format: the renderer (React) escapes
    const missing = await call('POST', '/resolve', undefined, resolveBody({ key: 'shell.greeting' }));
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing)).toMatchObject({ category: 'VALIDATION', code: 'CONTENT_TEMPLATE_ERROR' });
    const unknown = await call(
      'POST',
      '/resolve',
      undefined,
      resolveBody({ key: 'shell.greeting', variables: { name: 'SECRET-PERSON', other: 'SECRET-OTHER' } }),
    );
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).not.toContain('SECRET-PERSON');
    expect(unknown.body).not.toContain('SECRET-OTHER');
    expect(missing.body).not.toContain('Hello');
  });

  it('rejects variables supplied for keys that are not being resolved', async () => {
    const r = await call('POST', '/resolve-many', undefined, { keys: ['shell.greeting'], locale: 'en-US', variables: { 'shell.tagline': {} } });
    expect(r.statusCode).toBe(400);
    expect(errorOf(r)).toMatchObject({ category: 'VALIDATION', code: 'CONTENT_VALIDATION_FAILED' });
    expect(svc.resolveMany).not.toHaveBeenCalled();
  });
});

describe('content API: Vary: Authorization on the public routes', () => {
  const vary = (r: { headers: Record<string, unknown> }) =>
    String(r.headers['vary'] ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase());

  it('is present on resolve, resolve-many and the locale list: successes, errors, anonymous and authenticated (a shared cache must not mix management and public bodies)', async () => {
    svc.listLocales.mockResolvedValue([EN_US]);
    const tokens = [undefined, await adminToken(['content-read']), await adminToken(['content-write'])];
    for (const t of tokens) {
      const label = t ? 'token' : 'anonymous';
      expect(vary(await call('POST', '/resolve', t, { key: 'shell.tagline', locale: 'en-US' })), `resolve ${label}`).toContain('authorization');
      expect(vary(await call('POST', '/resolve', t, { key: 'shell.secret', locale: 'en-US' })), `resolve internal ${label}`).toContain('authorization');
      expect(vary(await call('POST', '/resolve-many', t, { keys: ['shell.tagline', 'shell.secret'], locale: 'en-US' })), `resolve-many ${label}`).toContain(
        'authorization',
      );
      expect(vary(await call('GET', '/locales', t)), `locales ${label}`).toContain('authorization');
    }
    // 404 (unknown key), 400 (invalid body) and 401 (invalid credential) are responses of the same routes
    const unknown = await call('POST', '/resolve', undefined, { key: 'shell.nope', locale: 'en-US' });
    expect(unknown.statusCode).toBe(404);
    expect(vary(unknown)).toContain('authorization');
    const invalid = await call('POST', '/resolve', undefined, { locale: 'en-US' });
    expect(invalid.statusCode).toBe(400);
    expect(vary(invalid)).toContain('authorization');
    for (const [method, url, payload] of [
      ['POST', '/resolve', { key: 'shell.tagline', locale: 'en-US' }],
      ['POST', '/resolve-many', { keys: ['shell.tagline'], locale: 'en-US' }],
      ['GET', '/locales', undefined],
    ] as const) {
      const bad = await call(method, url, 'not.a.token', payload);
      expect(bad.statusCode, url).toBe(401);
      expect(vary(bad), `${url} 401`).toContain('authorization');
    }
  });

  it('is not added to the management routes', async () => {
    svc.listEntries.mockResolvedValue([]);
    const r = await call('GET', '/entries', await adminToken(['content-read']));
    expect(r.statusCode).toBe(200);
    expect(vary(r)).not.toContain('authorization');
  });
});

describe('content API: boolean bodies are validated raw, before Fastify coerces them', () => {
  const routes = [
    ['entry activation', '/entries/shell.tagline/activation', () => svc.setEntryActive, (active: unknown) => ({ active, reason: 'r' })],
    ['locale activation', '/locales/es-US/activation', () => svc.setLocaleActive, (active: unknown) => ({ active, reason: 'r' })],
    ['locale registration', '/locales', () => svc.registerLocale, (active: unknown) => ({ locale: 'es-US', active, reason: 'r' })],
  ] as const;
  const coerced: [string, unknown][] = [
    ['number 1', 1],
    ['number 0', 0],
    ['string "true"', 'true'],
    ['string "false"', 'false'],
    ['null', null],
    ['empty string', ''],
    ['array', [true]],
  ];

  it.each(routes)('%s answers 400 for a non-boolean active and never calls the service', async (_label, url, mock, body) => {
    const t = await adminToken(['content-write']);
    for (const [label, active] of coerced) {
      const res = await call('POST', url, t, body(active));
      expect(res.statusCode, label).toBe(400);
      expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED' });
    }
    expect(mock()).not.toHaveBeenCalled();
  });

  it('real booleans are still accepted, in both directions, on all three routes', async () => {
    const t = await adminToken(['content-write']);
    svc.setEntryActive.mockResolvedValue(entry());
    svc.setLocaleActive.mockResolvedValue(ES_US);
    svc.registerLocale.mockResolvedValue(ES_US);
    for (const active of [true, false]) {
      expect((await call('POST', '/entries/shell.tagline/activation', t, { active, reason: 'r' })).statusCode).toBe(200);
      expect((await call('POST', '/locales/es-US/activation', t, { active, reason: 'r' })).statusCode).toBe(200);
      expect((await call('POST', '/locales', t, { locale: 'es-US', active, reason: 'r' })).statusCode).toBe(201);
    }
    expect(svc.setEntryActive).toHaveBeenNthCalledWith(1, 'shell.tagline', true, 'r', 'admin-a');
    expect(svc.setEntryActive).toHaveBeenNthCalledWith(2, 'shell.tagline', false, 'r', 'admin-a');
    expect(svc.setLocaleActive).toHaveBeenNthCalledWith(2, 'es-US', false, 'r', 'admin-a');
  });

  it('the entry creation body does not coerce its boolean variable flags either', async () => {
    const t = await adminToken(['content-write']);
    const variable = (required: unknown) => ({ name: 'name', type: 'STRING', description: 'd', example: 'Ada', required });
    for (const required of ['false', 0, null]) {
      const res = await call('POST', '/entries', t, {
        key: 'shell.tagline',
        contentType: 'UI_LABEL',
        ownerRole: 'CONTENT',
        description: 'd',
        variables: [variable(required)],
      });
      expect(res.statusCode, String(required)).toBe(400);
    }
    expect(svc.createEntry).not.toHaveBeenCalled();
  });

  it('keeps 401 and 403 ahead of the body check', async () => {
    const body = { active: 1, reason: 'r' };
    for (const url of ['/entries/shell.tagline/activation', '/locales/es-US/activation']) {
      expect((await call('POST', url, undefined, body)).statusCode, url).toBe(401);
      expect((await call('POST', url, await adminToken(['content-read']), body)).statusCode, url).toBe(403);
    }
    expect(svc.setEntryActive).not.toHaveBeenCalled();
    expect(svc.setLocaleActive).not.toHaveBeenCalled();
  });
});

describe('content API resolve-many size budget', () => {
  const big = (key: string, chars: number, over: Partial<ResolvedContent> = {}) =>
    resolved({ key, contentType: 'PLAIN_TEXT', body: 'x'.repeat(chars), ...over });

  it('rejects, before rendering, a call whose resolved template sources exceed 500000 characters in total, for every caller', async () => {
    catalog = { 'big.one': big('big.one', 200_000), 'big.two': big('big.two', 200_000), 'big.three': big('big.three', 100_001) };
    const request = { keys: ['big.one', 'big.two', 'big.three'], locale: 'en-US' };
    for (const t of [undefined, await adminToken(['content-read'])]) {
      const r = await call('POST', '/resolve-many', t, request);
      expect(r.statusCode).toBe(400);
      expect(errorOf(r)).toMatchObject({
        category: 'VALIDATION',
        code: 'CONTENT_RESPONSE_TOO_LARGE',
        details: { reason: 'RESPONSE_TOO_LARGE', maxSourceCharacters: 500_000 },
      });
      expect(r.body.length).toBeLessThan(2000);
    }
  });

  it('accepts a call exactly at the budget and counts each requested key once', async () => {
    // the template renderer itself caps one body at 200000 characters
    catalog = { 'big.one': big('big.one', 200_000), 'big.two': big('big.two', 200_000), 'big.three': big('big.three', 100_000) };
    const ok = await call('POST', '/resolve-many', undefined, { keys: ['big.one', 'big.two', 'big.three', 'big.one'], locale: 'en-US' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.items).toHaveLength(3);
    catalog['big.three'] = big('big.three', 100_001);
    expect((await call('POST', '/resolve-many', undefined, { keys: ['big.one', 'big.two', 'big.three'], locale: 'en-US' })).statusCode).toBe(400);
  });

  it('does not count entries the caller cannot see (INTERNAL for anonymous) or that did not resolve', async () => {
    catalog = {
      'big.internal': big('big.internal', 200_000, { sensitivity: 'INTERNAL' }),
      'big.ok': big('big.ok', 200_000),
      'big.ok2': big('big.ok2', 100_001),
    };
    const request = { keys: ['big.internal', 'big.ok', 'big.ok2', 'big.unknown'], locale: 'en-US' };
    const anonymous = await call('POST', '/resolve-many', undefined, request);
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json().data.items.map((i: { key: string }) => i.key)).toEqual(['big.ok', 'big.ok2']);
    expect((await call('POST', '/resolve-many', await adminToken(['content-read']), request)).statusCode).toBe(400);
  });

  it('does not apply to a single resolve (bounded by the 200000 character body limit)', async () => {
    catalog = { 'big.one': big('big.one', 200_000) };
    expect((await call('POST', '/resolve', undefined, { key: 'big.one', locale: 'en-US' })).statusCode).toBe(200);
  });
});

describe('content API long path parameters', () => {
  const longKey = (n: number) => `devtest.${'a'.repeat(n - 8)}`;

  it('reaches routes with a 160-character key (the contract maximum; Fastify defaults to 100)', async () => {
    const k = longKey(160);
    expect(k).toHaveLength(160);
    const t = await adminToken(ROLES);
    svc.getEntry.mockResolvedValue({ entry: entry({ key: k }), versions: [] });
    svc.createVersion.mockResolvedValue(version({ entryKey: k }));
    svc.setEntryActive.mockResolvedValue(entry({ key: k, isActive: false }));
    svc.findEntry.mockResolvedValue(entry({ key: k }));
    expect((await call('GET', `/entries/${k}`, t)).statusCode).toBe(200);
    expect(svc.getEntry).toHaveBeenCalledWith(k);
    expect((await call('POST', `/entries/${k}/versions`, t, { locale: 'en-US', body: 'x', reason: 'r' })).statusCode).toBe(201);
    expect(svc.createVersion).toHaveBeenCalledWith(k, expect.anything(), 'admin-a');
    expect((await call('POST', `/entries/${k}/activation`, t, { active: false, reason: 'r' })).statusCode).toBe(200);
  });

  it('rejects an over-long key param with the standard error body (schema, and the router for very long values) and a correlation id', async () => {
    const t = await adminToken(ROLES);
    const schemaLevel = await call('GET', `/entries/${longKey(161)}`, t);
    expect(schemaLevel.statusCode).toBe(400);
    expect(errorOf(schemaLevel)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED' });

    const router = await call('GET', `/entries/${longKey(MAX_PATH_PARAM_LENGTH + 8)}`, t, undefined, { 'x-correlation-id': 'corr-long-param-1' });
    expect(router.statusCode).toBe(400);
    expect(errorOf(router)).toMatchObject({ category: 'VALIDATION', code: 'PATH_PARAMETER_TOO_LONG', correlationId: 'corr-long-param-1' });
    expect(router.headers['x-correlation-id']).toBe('corr-long-param-1');
    expect(router.body).not.toContain('FST_ERR');
    expect(router.body).not.toContain('Bad Request');
    // unauthenticated callers get the same envelope (the router fails before any auth hook)
    const anonymous = await call('GET', `/entries/${longKey(300)}`);
    expect(errorOf(anonymous).code).toBe('PATH_PARAMETER_TOO_LONG');
    expect(errorOf(anonymous).correlationId).toEqual(expect.any(String));
    expect(svc.getEntry).not.toHaveBeenCalled();
  });

  it('answers a malformed URL component with the standard error body too', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/content/entries/%E0%A4%A' });
    expect(r.statusCode).toBe(400);
    expect(errorOf(r)).toMatchObject({ category: 'VALIDATION', code: 'BAD_URL' });
  });
});

describe('content API request validation', () => {
  it('rejects invalid bodies with 400 before calling the service', async () => {
    const t = await adminToken([...ROLES, 'content-legal']);
    const cases: [string, unknown][] = [
      ['/resolve', { key: 'Bad Key', locale: 'en-US' }],
      ['/resolve', { key: 'shell.tagline', locale: 'en_US' }],
      ['/resolve', { key: 'shell.tagline', locale: 'EN-us' }],
      ['/resolve', { key: 'shell.tagline', locale: ' en-US' }],
      ['/resolve', { key: 'shell.tagline', locale: 'en-US', context: { galaxy: 'x' } }],
      ['/resolve', { locale: 'en-US' }],
      ['/resolve-many', { keys: [], locale: 'en-US' }],
      ['/resolve-many', { keys: Array.from({ length: 101 }, (_, i) => `a.k${i}`), locale: 'en-US' }],
      ['/entries', { key: 'a.b' }],
      ['/entries', { key: 'a.b', contentType: 'UI_LABEL', ownerRole: 'CONTENT', description: 'd', variables: [{ name: 'X', type: 'STRING' }] }],
      [`/entries/${KEY}/versions`, { locale: 'en-US', body: '', reason: 'r' }],
      [`/entries/${KEY}/versions`, { locale: 'en-US', body: 'x', reason: 'r', scopeType: 'GIG' }],
      [`/entries/${KEY}/activation`, { active: 'yes', reason: 'r' }],
      ['/locales', { locale: 'xx_YY', reason: 'r' }],
      ['/locales/es-US/activation', { active: true }],
      ['/snapshots', { keys: ['a.b'], locale: 'en-US' }],
    ];
    for (const [url, body] of cases) {
      const r = await call('POST', url, t, body);
      expect(r.statusCode, `${url} ${JSON.stringify(body)}`).toBe(400);
      expect(errorOf(r).category).toBe('VALIDATION');
    }
    // public routes validate for anonymous callers too
    for (const [url, body] of cases.filter(([u]) => u.startsWith('/resolve'))) {
      expect((await call('POST', url, undefined, body)).statusCode, `${url} ${JSON.stringify(body)}`).toBe(400);
    }
    expect(
      Object.entries(svc)
        .filter(([n]) => !['resolve', 'resolveMany', 'findEntry', 'getVersion'].includes(n))
        .every(([, f]) => f.mock.calls.length === 0),
    ).toBe(true);
    expect(svc.resolve).not.toHaveBeenCalled();
    expect(svc.resolveMany).not.toHaveBeenCalled();
  });

  it('rejects unknown properties instead of stripping them (removeAdditional false)', async () => {
    const t = await adminToken([...ROLES, 'content-legal']);
    const cases: [string, unknown, string?][] = [
      ['/resolve', { key: 'shell.tagline', locale: 'en-US', bonus: 1 }],
      ['/resolve', { key: 'shell.tagline', locale: 'en-US', context: { market: 'us-ca', bonus: 1 } }],
      ['/resolve-many', { keys: ['shell.tagline'], locale: 'en-US', bonus: 1 }],
      ['/entries', { key: 'a.b', contentType: 'UI_LABEL', ownerRole: 'CONTENT', description: 'd', bonus: 1 }],
      [`/entries/${KEY}/versions`, { locale: 'en-US', body: 'x', reason: 'r', bonus: 1 }],
      [`/entries/${KEY}/activation`, { active: true, reason: 'r', bonus: 1 }],
      [`/versions/${ID}/approve`, { comment: 'c', bonus: 1 }],
      ['/locales', { locale: 'es-US', reason: 'r', bonus: 1 }],
      ['/snapshots', { keys: ['a.b'], locale: 'en-US', purpose: 'p', bonus: 1 }],
    ];
    for (const [url, body] of cases) {
      for (const token of [t, ...(url.startsWith('/resolve') ? [undefined] : [])]) {
        const r = await call('POST', url, token, body);
        expect(r.statusCode, `${url} ${JSON.stringify(body)}`).toBe(400);
        expect(errorOf(r).code).toBe('VALIDATION_FAILED');
      }
    }
    expect(svc.createEntry).not.toHaveBeenCalled();
    expect(svc.createVersion).not.toHaveBeenCalled();
    expect(svc.approve).not.toHaveBeenCalled();
    expect(svc.resolve).not.toHaveBeenCalled();
  });

  it('rejects an invalid entries filter and a malformed version or snapshot id', async () => {
    const t = await adminToken(ROLES);
    expect((await call('GET', '/entries?contentType=BOGUS', t)).statusCode).toBe(400);
    expect((await call('GET', '/entries?isActive=maybe', t)).statusCode).toBe(400);
    expect((await call('POST', '/versions/not-a-uuid/submit', t, {})).statusCode).toBe(400);
    expect((await call('GET', '/snapshots/not-a-uuid', t)).statusCode).toBe(400);
  });
});

describe('content API behavior', () => {
  it('passes filters, the authenticated subject as actor, and the correlation id through', async () => {
    svc.listEntries.mockResolvedValue([entry()]);
    const list = await call('GET', '/entries?contentType=UI_LABEL&ownerRole=CONTENT&isActive=true', await adminToken(['content-read']));
    expect(list.statusCode).toBe(200);
    expect(svc.listEntries).toHaveBeenCalledWith({ contentType: 'UI_LABEL', ownerRole: 'CONTENT', isActive: true });
    expect(list.json().data[0]).toMatchObject({ key: 'shell.tagline', createdAt: T0.toISOString() });

    svc.createVersion.mockResolvedValue(version());
    const r = await call(
      'POST',
      `/entries/${KEY}/versions`,
      await adminToken(['content-write'], { sub: 'admin-zed' }),
      { locale: 'es-US', body: 'Ayuda local', reason: 'because', effectiveFrom: '2026-06-01T00:00:00Z' },
      { 'x-correlation-id': 'corr-content-api-1' },
    );
    expect(r.statusCode).toBe(201);
    expect(svc.createVersion).toHaveBeenCalledWith(
      KEY,
      expect.objectContaining({ locale: 'es-US', body: 'Ayuda local', scopeType: 'PLATFORM', reason: 'because' }),
      'admin-zed',
    );
    expect(r.json().meta.correlationId).toBe('corr-content-api-1');
    expect(r.headers['x-correlation-id']).toBe('corr-content-api-1');
  });

  it('applies request defaults when creating an entry and locale', async () => {
    svc.createEntry.mockResolvedValue(entry());
    svc.registerLocale.mockResolvedValue({ ...ES_US, isActive: false });
    const t = await adminToken(['content-write']);
    expect((await call('POST', '/entries', t, { key: 'shell.tagline', contentType: 'UI_LABEL', ownerRole: 'CONTENT', description: 'd' })).statusCode).toBe(201);
    expect(svc.createEntry).toHaveBeenCalledWith(expect.objectContaining({ sensitivity: 'PUBLIC', maxScopeType: 'PLATFORM', variables: [] }), 'admin-a');
    const loc = await call('POST', '/locales', t, { locale: 'es-US', reason: 'launch' });
    expect(loc.statusCode).toBe(201);
    expect(svc.registerLocale).toHaveBeenCalledWith({ locale: 'es-US', active: false, reason: 'launch' }, 'admin-a');
    expect(loc.json().data).toEqual({
      locale: 'es-US',
      displayName: 'Spanish (United States)',
      language: 'es',
      script: null,
      region: 'US',
      isActive: false,
      isPlatformDefault: false,
    });
    const named = await call('POST', '/locales', t, { locale: 'es-US', displayName: 'Español (EE. UU.)', reason: 'launch' });
    expect(named.statusCode).toBe(201);
    expect(svc.registerLocale).toHaveBeenLastCalledWith({ locale: 'es-US', active: false, displayName: 'Español (EE. UU.)', reason: 'launch' }, 'admin-a');
    expect((await call('POST', '/locales', t, { locale: 'es-US', displayName: ' ', reason: 'launch' })).statusCode).toBe(400);
  });

  it('drives the lifecycle through the service with the comment and actor, accepting an empty body', async () => {
    const t = await adminToken(ROLES);
    for (const [action, fn] of [
      ['submit', svc.submit],
      ['approve', svc.approve],
      ['reject', svc.reject],
      ['cancel', svc.cancel],
      ['publish', svc.publish],
    ] as const) {
      const r = await call('POST', `/versions/${ID}/${action}`, t, { comment: 'looks right' });
      expect(r.statusCode, action).toBe(200);
      expect(r.json().data).toMatchObject({ versionId: ID, status: 'DRAFT', body: 'Local help, done fast' });
      expect(fn).toHaveBeenCalled();
    }
    expect(svc.approve).toHaveBeenCalledWith(ID, 'admin-a', 'looks right');
    expect(svc.reject).toHaveBeenCalledWith(ID, 'admin-a', 'looks right');
    expect(svc.publish).toHaveBeenCalledWith(ID, 'admin-a');
    expect((await call('POST', `/versions/${ID}/submit`, t, {})).statusCode).toBe(200);
  });

  it('returns entry detail, snapshots and locale management results in the standard envelope', async () => {
    const t = await adminToken(ROLES);
    svc.getEntry.mockResolvedValue({ entry: entry({ variables: [NAME_VARIABLE] }), versions: [version({ status: 'PUBLISHED' })] });
    const d = await call('GET', `/entries/${KEY}`, t);
    expect(d.statusCode).toBe(200);
    expect(d.json().data.entry.variables[0]).toMatchObject({ name: 'name', type: 'STRING' });
    expect(d.json().data.versions[0]).toMatchObject({ status: 'PUBLISHED', bodySha256: 'a'.repeat(64) });
    expect(d.json().meta.correlationId).toEqual(expect.any(String));

    svc.createSnapshot.mockResolvedValue(snapshot());
    svc.getSnapshot.mockResolvedValue(snapshot());
    const s = await call('POST', '/snapshots', t, { keys: ['shell.tagline'], locale: 'en-US', purpose: 'test', at: '2026-01-02T00:00:00Z' });
    expect(s.statusCode).toBe(201);
    expect(svc.createSnapshot).toHaveBeenCalledWith(
      { keys: ['shell.tagline'], locale: 'en-US', context: {}, purpose: 'test', at: new Date('2026-01-02T00:00:00Z') },
      'admin-a',
    );
    expect(s.json().data.items[0]).toMatchObject({ key: 'shell.tagline', body: 'Local help, done fast', versionId: ID });
    expect(s.body).not.toContain('sensitivity');
    expect(s.json().data.items[0]).not.toHaveProperty('effectiveTo'); // changes when a successor is published; a snapshot read-back must be stable
    expect(s.json().data.items[0].effectiveFrom).toBe(T0.toISOString());
    const stored = await call('GET', `/snapshots/${ID}`, t);
    expect(stored.statusCode).toBe(200);
    expect(stored.json().data.items[0]).not.toHaveProperty('effectiveTo');

    svc.setLocaleActive.mockResolvedValue(ES_US);
    const a = await call('POST', '/locales/es-US/activation', t, { active: true, reason: 'launch' });
    expect(a.statusCode).toBe(200);
    expect(svc.setLocaleActive).toHaveBeenCalledWith('es-US', true, 'launch', 'admin-a');
  });
});

describe('content API error mapping', () => {
  const expected: Record<ContentErrorCode, [number, string]> = {
    ENTRY_NOT_FOUND: [404, 'NOT_FOUND'],
    NO_CONTENT: [404, 'NOT_FOUND'],
    LOCALE_NOT_FOUND: [404, 'NOT_FOUND'],
    NOT_FOUND: [404, 'NOT_FOUND'],
    VALIDATION_FAILED: [400, 'VALIDATION'],
    TEMPLATE_ERROR: [400, 'VALIDATION'],
    SCOPE_NOT_ALLOWED: [400, 'VALIDATION'],
    CONFLICT: [409, 'CONFLICT'],
    INVALID_STATE: [409, 'CONFLICT'],
    FORBIDDEN_APPROVER: [403, 'AUTHORIZATION'],
    UNAVAILABLE: [503, 'DEPENDENCY'],
  };

  it('covers every ContentError code', () => {
    expect(Object.keys(expected).sort()).toEqual([...CONTENT_ERROR_CODES].sort());
  });

  it.each(CONTENT_ERROR_CODES)('maps %s to the standard error model on management and public routes without leaking internals', async (code) => {
    const [status, category] = expected[code];
    const error = () =>
      new ContentError(code, `${code} happened`, { key: 'shell.tagline', cause: 'connect ECONNREFUSED 10.0.0.5:5432 SELECT secret FROM content.versions' });
    const check = (r: { statusCode: number; body: string; json: () => unknown }) => {
      expect(r.statusCode).toBe(status);
      expect(errorOf(r)).toMatchObject({ category, code: `CONTENT_${code}` });
      expect(r.body).not.toContain('ECONNREFUSED');
      expect(r.body).not.toContain('SELECT');
      expect(r.body).not.toContain('cause');
      if (code === 'UNAVAILABLE') expect(errorOf(r).message).toBe('The content registry is temporarily unavailable');
      if (code === 'FORBIDDEN_APPROVER') expect(errorOf(r).details).toBeUndefined();
    };
    const t = await adminToken(ROLES);

    svc.resolve.mockRejectedValueOnce(error());
    check(await call('POST', '/resolve', undefined, { key: 'shell.tagline', locale: 'en-US' }));
    svc.resolveMany.mockRejectedValueOnce(error());
    check(await call('POST', '/resolve-many', undefined, { keys: ['shell.tagline'], locale: 'en-US' }));
    svc.publish.mockRejectedValueOnce(error());
    check(await call('POST', `/versions/${ID}/publish`, t, {}));
    svc.getEntry.mockRejectedValueOnce(error());
    check(await call('GET', `/entries/${KEY}`, t));
  });

  it('keeps typed details (identifiers, reasons, positions) but never copy text: a TEMPLATE_ERROR carries the reason, not the template', async () => {
    svc.createVersion.mockRejectedValueOnce(
      new ContentError('TEMPLATE_ERROR', 'unknown variable in the template', { reason: 'UNKNOWN_VARIABLE', variable: 'nope', position: 7 }),
    );
    const r = await call('POST', `/entries/${KEY}/versions`, await adminToken(['content-write']), {
      locale: 'en-US',
      body: 'Dear {nope} UNIQUE-COPY-SENTINEL',
      reason: 'r',
    });
    expect(r.statusCode).toBe(400);
    expect(errorOf(r).details).toEqual({ reason: 'UNKNOWN_VARIABLE', variable: 'nope', position: 7 });
    expect(r.body).not.toContain('UNIQUE-COPY-SENTINEL');
  });

  it('does not echo submitted copy or variable values in request-validation errors', async () => {
    const t = await adminToken(['content-write']);
    const r = await call('POST', `/entries/${KEY}/versions`, t, { locale: 'not a locale', body: 'UNIQUE-COPY-SENTINEL', reason: 'r' });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('UNIQUE-COPY-SENTINEL');
    const r2 = await call('POST', '/resolve', undefined, { key: 'shell.tagline', locale: 'en-US', variables: { Bad_Name: 'SECRET-VALUE' } });
    expect(r2.statusCode).toBe(400);
    expect(r2.body).not.toContain('SECRET-VALUE');
  });

  it('rethrows unexpected errors as a generic 500 without internals', async () => {
    svc.resolve.mockRejectedValueOnce(new Error('kaboom with connection string postgres://u:p@h/db'));
    const r = await call('POST', '/resolve', undefined, { key: 'shell.tagline', locale: 'en-US' });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('postgres://');
    expect(errorOf(r).code).toBe('INTERNAL_ERROR');
  });

  it('maps a invalid time zone or locale rejected by the service to 400', async () => {
    svc.resolve.mockRejectedValueOnce(new ContentError('VALIDATION_FAILED', 'unsupported time zone', { reason: 'INVALID_TIME_ZONE' }));
    const r = await call('POST', '/resolve', undefined, { key: 'shell.tagline', locale: 'en-US', timeZone: 'Mars/Base' });
    expect(r.statusCode).toBe(400);
    expect(errorOf(r)).toMatchObject({ code: 'CONTENT_VALIDATION_FAILED', details: { reason: 'INVALID_TIME_ZONE' } });
  });
});
