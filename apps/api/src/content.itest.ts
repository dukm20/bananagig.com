// The content registry workflow over HTTP: real PostgreSQL (isolated, migrated; migration 0006 seeds the shell copy), the real auth plugin and
// forged-but-signed tokens (the same approach as configuration.itest.ts). The client role names (content-read, content-write, content-approve,
// content-legal) are asserted by the API from the token, so this test does not depend on the Keycloak realm import.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@bananagig/config';
import { MemoryConfigCache } from '@bananagig/configuration';
import { ContentService } from '@bananagig/content';
import { ErrorResponse } from '@bananagig/contracts';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { createIsolatedDatabase, type IsolatedDatabase } from '@bananagig/testing';
import { buildApp } from './app';

let iso: IsolatedDatabase;
let app: FastifyInstance;
let keys: TestKeys;
const STAFF = ['admin-console-access', 'content-read', 'content-write', 'content-approve'];
const token = (sub: string, roles: string[]) =>
  signToken(keys, { claims: { sub, azp: 'bananagig-admin', realm_access: { roles: [] }, resource_access: { 'bananagig-admin': { roles } } } });
let author: string;
let approver: string;
let legalAuthor: string;
let legalApprover: string;
let readOnly: string;
let seq = 0;
const key = (name: string) => `devtest.http${++seq}.${name}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const api = async (method: 'GET' | 'POST', url: string, t?: string, payload?: unknown): Promise<{ status: number; body: Json }> => {
  const r = await app.inject({
    method,
    url: `/api/v1/content${url}`,
    headers: t ? { authorization: `Bearer ${t}` } : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: r.statusCode, body: r.json() as Json };
};

/** Creates and publishes one version (draft -> submit -> approve -> publish) through the HTTP API. */
async function publish(entryKey: string, body: string, over: Record<string, unknown> = {}, tokens = { author, approver }): Promise<Json> {
  const created = await api('POST', `/entries/${entryKey}/versions`, tokens.author, { locale: 'en-US', body, reason: 'http test', ...over });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.versionId as string;
  const submitted = await api('POST', `/versions/${id}/submit`, tokens.author, {});
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  if (submitted.body.data.status === 'IN_REVIEW') {
    const approved = await api('POST', `/versions/${id}/approve`, tokens.approver, { comment: 'ok' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  }
  const published = await api('POST', `/versions/${id}/publish`, tokens.author, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return published.body.data;
}

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
  const content = new ContentService({ database: iso.database, cache: new MemoryConfigCache(), env: 'test', allowTestKeys: true });
  app = await buildApp({ cfg, verifier, configuration: {} as never, content, readiness: async () => ({}) });
  await app.ready();
  author = await token('author-a', STAFF);
  approver = await token('approver-b', STAFF);
  legalAuthor = await token('legal-a', [...STAFF, 'content-legal']);
  legalApprover = await token('legal-b', [...STAFF, 'content-legal']);
  readOnly = await token('reader-r', ['admin-console-access', 'content-read']);
});
afterAll(async () => {
  await app.close();
  await iso.drop();
});

describe('content API workflow (HTTP, real database)', () => {
  it('serves the seeded shell copy to anonymous callers and keeps INTERNAL-only options for content-read', async () => {
    const r = await api('POST', '/resolve', undefined, { key: 'brand.tagline', locale: 'en-US' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      key: 'brand.tagline',
      value: 'Local help. Done fast.',
      format: 'text',
      resolvedLocale: 'en-US',
      fallback: { applied: false },
    });
    expect(r.body.data.template).toBeUndefined();
    const many = await api('POST', '/resolve-many', undefined, { keys: ['brand.name', 'common.action.sign_in', 'brand.missing'], locale: 'en-US' });
    expect(many.status).toBe(200);
    expect(many.body.data.items.map((i: { key: string }) => i.key)).toEqual(['brand.name', 'common.action.sign_in']);
    expect((await api('POST', '/resolve', undefined, { key: 'brand.tagline', locale: 'en-US', at: '2026-01-01T00:00:00Z' })).status).toBe(403);
    const withTemplate = await api('POST', '/resolve', readOnly, { key: 'brand.tagline', locale: 'en-US', includeTemplate: true });
    expect(withTemplate.body.data.template).toBe('Local help. Done fast.');
  });

  it('creates an entry, authors, approves, publishes and resolves with locale fallback and variables', async () => {
    const k = key('greeting');
    const created = await api('POST', '/entries', author, {
      key: k,
      contentType: 'UI_LABEL',
      ownerRole: 'CONTENT',
      description: 'neutral http test greeting',
      variables: [{ name: 'name', type: 'PERSON_DISPLAY_NAME', description: 'Display name', example: 'Ada', piiClass: 'PERSONAL' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({ key: k, approvalPolicy: 'OWNER_APPROVAL', fallbackPolicy: 'CHAIN', isActive: true, sensitivity: 'PUBLIC' });
    expect((await api('POST', '/entries', author, { key: k, contentType: 'UI_LABEL', ownerRole: 'CONTENT', description: 'dup' })).body.error.code).toBe(
      'CONTENT_CONFLICT',
    );

    // locales: authoring needs registration, serving needs activation
    expect((await api('POST', '/locales', author, { locale: 'es-US', reason: 'http test' })).body.data).toMatchObject({
      locale: 'es-US',
      displayName: 'Spanish (United States)',
      language: 'es',
      script: null,
      region: 'US',
      isActive: false,
    });
    const unregistered = await api('POST', `/entries/${k}/versions`, author, { locale: 'fr-FR', body: 'Bonjour {name}', reason: 'r' });
    expect(unregistered.status).toBe(404);
    expect(unregistered.body.error.code).toBe('CONTENT_LOCALE_NOT_FOUND');

    await publish(k, 'Hello {name}');
    const es = await publish(k, 'Hola {name}', { locale: 'es-US' });
    expect(es).toMatchObject({ status: 'PUBLISHED', locale: 'es-US', version: 1 });

    // es-US is registered but inactive: a request for it falls back to the platform default
    const inactive = await api('POST', '/resolve', undefined, { key: k, locale: 'es-US', variables: { name: 'Ada' } });
    expect(inactive.body.data).toMatchObject({ value: 'Hello Ada', resolvedLocale: 'en-US', fallback: { applied: true, chain: ['en-US'] } });
    expect((await api('GET', '/locales')).body.data.map((l: { locale: string }) => l.locale)).toEqual(['en-US']);
    expect((await api('GET', '/locales', readOnly)).body.data.map((l: { locale: string }) => l.locale)).toEqual(['en-US', 'es-US']);

    expect((await api('POST', '/locales/es-US/activation', author, { active: true, reason: 'launch' })).body.data).toMatchObject({ isActive: true });
    const active = await api('POST', '/resolve', undefined, { key: k, locale: 'es-US', variables: { name: 'Ada' } });
    expect(active.body.data).toMatchObject({ value: 'Hola Ada', resolvedLocale: 'es-US', fallback: { applied: false } });
    const regional = await api('POST', '/resolve', undefined, { key: k, locale: 'es-MX', variables: { name: 'Ada' } });
    expect(regional.status).toBe(200);
    expect(regional.body.data).toMatchObject({ value: 'Hello Ada', resolvedLocale: 'en-US', fallback: { applied: true } });
    expect((await api('GET', '/locales')).body.data.map((l: { locale: string }) => l.locale)).toEqual(['en-US', 'es-US']);
    expect((await api('POST', '/locales/en-US/activation', author, { active: false, reason: 'no' })).status).toBeGreaterThanOrEqual(400);

    const missing = await api('POST', '/resolve', undefined, { key: k, locale: 'en-US' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('CONTENT_TEMPLATE_ERROR');
    expect(JSON.stringify(missing.body)).not.toContain('Hello');

    const detail = await api('GET', `/entries/${k}`, readOnly);
    expect(detail.body.data.entry.key).toBe(k);
    expect(detail.body.data.versions.map((v: { locale: string; status: string }) => [v.locale, v.status])).toEqual([
      ['en-US', 'PUBLISHED'],
      ['es-US', 'PUBLISHED'],
    ]);
    expect((await api('GET', '/entries?contentType=UI_LABEL&isActive=true', readOnly)).body.data.some((e: { key: string }) => e.key === k)).toBe(true);
  });

  it('enforces the lifecycle and the permissions: no publish before approval, approval needs content-approve, reject and cancel', async () => {
    const k = key('lifecycle');
    await api('POST', '/entries', author, { key: k, contentType: 'PLAIN_TEXT', ownerRole: 'CONTENT', description: 'lifecycle test' });
    const v = (await api('POST', `/entries/${k}/versions`, author, { locale: 'en-US', body: 'draft text', reason: 'r' })).body.data;
    expect(v.status).toBe('DRAFT');
    const early = await api('POST', `/versions/${v.versionId}/publish`, author, {});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('CONTENT_INVALID_STATE');
    expect((await api('POST', `/versions/${v.versionId}/submit`, readOnly, {})).status).toBe(403);
    expect((await api('POST', `/versions/${v.versionId}/submit`, author, {})).body.data.status).toBe('IN_REVIEW');
    expect((await api('POST', `/versions/${v.versionId}/approve`, readOnly, {})).status).toBe(403); // content-read alone cannot approve
    const rejected = await api('POST', `/versions/${v.versionId}/reject`, approver, { comment: 'no' });
    expect(rejected.body.data.status).toBe('REJECTED');

    const v2 = (await api('POST', `/entries/${k}/versions`, author, { locale: 'en-US', body: 'second draft', reason: 'r' })).body.data;
    expect((await api('POST', `/versions/${v2.versionId}/cancel`, author, {})).body.data.status).toBe('CANCELLED');
    expect((await api('POST', `/versions/${v2.versionId}/submit`, author, {})).status).toBe(409);
    expect((await api('POST', '/versions/6f1d0c3e-9d1f-4a43-8f64-0a3b6f0f1111/submit', author, {})).status).toBe(404);
  });

  it('rejects invalid copy with a typed 400 that never echoes the text', async () => {
    const k = key('template');
    await api('POST', '/entries', author, {
      key: k,
      contentType: 'MARKDOWN',
      ownerRole: 'CONTENT',
      description: 'template validation test',
      variables: [{ name: 'url', type: 'URL', description: 'Link', example: 'https://example.com/a' }],
    });
    const unknownVariable = await api('POST', `/entries/${k}/versions`, author, { locale: 'en-US', body: 'Dear {nobody} HTTP-SECRET-COPY', reason: 'r' });
    expect(unknownVariable.status).toBe(400);
    expect(unknownVariable.body.error).toMatchObject({ code: 'CONTENT_TEMPLATE_ERROR', details: { reason: 'UNKNOWN_VARIABLE' } });
    expect(JSON.stringify(unknownVariable.body)).not.toContain('HTTP-SECRET-COPY');
    const unsafeLink = await api('POST', `/entries/${k}/versions`, author, {
      locale: 'en-US',
      body: '[click](javascript:alert(1)) HTTP-SECRET-COPY',
      reason: 'r',
    });
    expect(unsafeLink.status).toBe(400);
    expect(unsafeLink.body.error.details.reason).toBe('UNSAFE_LINK');
    expect(JSON.stringify(unsafeLink.body)).not.toContain('HTTP-SECRET-COPY');

    await publish(k, 'Read **this**: <script>alert(1)</script> [site]({url})', { locale: 'en-US' });
    const r = await api('POST', '/resolve', undefined, { key: k, locale: 'en-US', variables: { url: 'https://example.com/a?b=1' } });
    expect(r.status).toBe(200);
    expect(r.body.data.format).toBe('html');
    expect(r.body.data.value).toContain('<strong>this</strong>');
    expect(r.body.data.value).toContain('&lt;script&gt;');
    expect(r.body.data.value).not.toContain('<script>');
    expect(r.body.data.value).toContain('rel="noopener noreferrer nofollow"');
  });

  it('hides INTERNAL entries from anonymous callers (as not found) and shows them to content-read', async () => {
    const k = key('internal');
    await api('POST', '/entries', author, { key: k, contentType: 'PLAIN_TEXT', ownerRole: 'CONTENT', description: 'internal note', sensitivity: 'INTERNAL' });
    await publish(k, 'staff only note');
    const anon = await api('POST', '/resolve', undefined, { key: k, locale: 'en-US' });
    const unknown = await api('POST', '/resolve', undefined, { key: key('nonexistent'), locale: 'en-US' });
    expect(anon.status).toBe(404);
    expect(ErrorResponse.parse(anon.body).error.code).toBe(ErrorResponse.parse(unknown.body).error.code);
    expect(JSON.stringify(anon.body)).not.toContain('staff only note');
    expect((await api('POST', '/resolve-many', undefined, { keys: [k], locale: 'en-US' })).body.data.items).toEqual([]);
    const staff = await api('POST', '/resolve', readOnly, { key: k, locale: 'en-US' });
    expect(staff.body.data.value).toBe('staff only note');
    // a customer-style token (web client) is not privileged either
    const customer = await signToken(keys, { claims: { azp: 'bananagig-web', realm_access: { roles: ['customer'] } } });
    expect((await api('POST', '/resolve', customer, { key: k, locale: 'en-US' })).status).toBe(404);
  });

  it('schedules a future version: it does not resolve early and resolves at its instant for previews', async () => {
    const k = key('scheduled');
    await api('POST', '/entries', author, { key: k, contentType: 'PLAIN_TEXT', ownerRole: 'CONTENT', description: 'schedule test' });
    await publish(k, 'current text');
    const from = new Date(Date.now() + 3_600_000);
    const scheduled = await publish(k, 'future text', { effectiveFrom: from.toISOString() });
    expect(scheduled).toMatchObject({ status: 'SCHEDULED', version: 2 });
    expect((await api('POST', '/resolve', undefined, { key: k, locale: 'en-US' })).body.data).toMatchObject({ value: 'current text', version: 1 });
    const preview = await api('POST', '/resolve', readOnly, { key: k, locale: 'en-US', at: new Date(from.getTime() + 1000).toISOString() });
    expect(preview.body.data).toMatchObject({ value: 'future text', version: 2 });
  });

  it('never tells a public caller that a successor is scheduled (effectiveTo is null), while management sees the period end', async () => {
    const k = key('embargo');
    await api('POST', '/entries', author, { key: k, contentType: 'PLAIN_TEXT', ownerRole: 'CONTENT', description: 'embargo test' });
    await publish(k, 'current promo');
    const from = new Date(Date.now() + 3_600_000);
    await publish(k, 'SECRET future promo', { effectiveFrom: from.toISOString() });
    const request = { key: k, locale: 'en-US' };
    for (const t of [undefined, await token('customer', ['customer'])]) {
      const one = await api('POST', '/resolve', t, request);
      expect(one.body.data).toMatchObject({ value: 'current promo', effectiveTo: null });
      expect(JSON.stringify(one.body)).not.toContain(from.toISOString());
      const many = await api('POST', '/resolve-many', t, { keys: [k], locale: 'en-US' });
      expect(many.body.data.items[0]).toMatchObject({ value: 'current promo', effectiveTo: null });
      expect(JSON.stringify(many.body)).not.toContain(from.toISOString());
    }
    const staff = await api('POST', '/resolve', readOnly, request);
    expect(staff.body.data.effectiveTo).toBe(from.toISOString());
    expect((await api('POST', '/resolve-many', readOnly, { keys: [k], locale: 'en-US' })).body.data.items[0].effectiveTo).toBe(from.toISOString());
  });

  it('serves keys of the full 160 character contract length end to end (create, get, version, publish, activate)', async () => {
    const k = `devtest.${'a'.repeat(152)}`;
    expect(k).toHaveLength(160);
    const created = await api('POST', '/entries', author, { key: k, contentType: 'PLAIN_TEXT', ownerRole: 'CONTENT', description: 'long key test' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const got = await api('GET', `/entries/${k}`, readOnly);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body.data.entry.key).toBe(k);
    const first = await publish(k, 'long key text');
    expect(first.entryKey).toBe(k);
    expect((await api('POST', '/resolve', undefined, { key: k, locale: 'en-US' })).body.data.value).toBe('long key text');
    expect((await api('POST', `/entries/${k}/activation`, author, { active: false, reason: 'retire' })).body.data.isActive).toBe(false);

    // beyond the router limit: the standard error envelope, not Fastify's own body
    const tooLong = await app.inject({
      method: 'GET',
      url: `/api/v1/content/entries/devtest.${'a'.repeat(200)}`,
      headers: { authorization: `Bearer ${readOnly}` },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(ErrorResponse.parse(tooLong.json()).error.code).toBe('PATH_PARAMETER_TOO_LONG');
  });

  it('gates legal documents behind content-legal, requires a second approver and records the checksum', async () => {
    const k = key('terms');
    const body = { key: k, contentType: 'LEGAL', ownerRole: 'LEGAL', description: 'neutral http test terms' };
    const denied = await api('POST', '/entries', author, body);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    const created = await api('POST', '/entries', legalAuthor, body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({ approvalPolicy: 'SECOND_APPROVER', criticality: 'CRITICAL', fallbackPolicy: 'EXACT' });

    expect((await api('POST', `/entries/${k}/versions`, author, { locale: 'en-US', body: 'Terms v1', reason: 'r' })).status).toBe(403);
    const v = (await api('POST', `/entries/${k}/versions`, legalAuthor, { locale: 'en-US', body: 'Terms v1', reason: 'r' })).body.data;
    expect((await api('POST', `/versions/${v.versionId}/submit`, author, {})).status).toBe(403);
    expect((await api('POST', `/versions/${v.versionId}/submit`, legalAuthor, {})).body.data.status).toBe('IN_REVIEW');
    const self = await api('POST', `/versions/${v.versionId}/approve`, legalAuthor, {});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('CONTENT_FORBIDDEN_APPROVER');
    expect((await api('POST', `/versions/${v.versionId}/approve`, approver, {})).status).toBe(403); // content-approve but no content-legal
    expect((await api('POST', `/versions/${v.versionId}/approve`, legalApprover, {})).body.data.status).toBe('APPROVED');
    expect((await api('POST', `/versions/${v.versionId}/publish`, approver, {})).status).toBe(403);
    const published = await api('POST', `/versions/${v.versionId}/publish`, legalAuthor, {});
    expect(published.status).toBe(200);
    // taking a legal document offline needs content-legal too
    const offline = await api('POST', `/entries/${k}/activation`, author, { active: false, reason: 'retire' });
    expect(offline.status).toBe(403);
    expect(offline.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    expect((await api('POST', '/resolve', undefined, { key: k, locale: 'en-US' })).status).toBe(200);
    expect((await api('POST', `/entries/${k}/activation`, legalAuthor, { active: false, reason: 'retire' })).body.data.isActive).toBe(false);
    expect((await api('POST', '/resolve', undefined, { key: k, locale: 'en-US' })).status).toBe(404);
    expect((await api('POST', `/entries/${k}/activation`, legalAuthor, { active: true, reason: 'restore' })).body.data.isActive).toBe(true);
    expect(published.body.data.bodySha256).toMatch(/^[0-9a-f]{64}$/);

    const resolved = await api('POST', '/resolve', undefined, { key: k, locale: 'en-US' });
    expect(resolved.body.data).toMatchObject({ value: '<p>Terms v1</p>', format: 'html', bodySha256: published.body.data.bodySha256, versionId: v.versionId });
    // EXACT: a locale without its own version never falls back for legal text
    expect((await api('POST', '/resolve', undefined, { key: k, locale: 'es-US' })).status).toBe(404);
  });

  it('snapshots the exact versions, unchanged by later publications', async () => {
    const k = key('snap');
    await api('POST', '/entries', author, { key: k, contentType: 'PLAIN_TEXT', ownerRole: 'CONTENT', description: 'snapshot test' });
    const first = await publish(k, 'snapshotted text');
    expect((await api('POST', '/snapshots', author, { keys: [k], locale: 'en-US', purpose: 'x' })).status).toBe(201);
    expect((await api('POST', '/snapshots', undefined, { keys: [k], locale: 'en-US', purpose: 'x' })).status).toBe(401);
    const snap = await api('POST', '/snapshots', readOnly, { keys: [k], locale: 'en-US', purpose: 'http test' });
    expect(snap.status).toBe(201);
    expect(snap.body.data.items[0]).toMatchObject({ key: k, body: 'snapshotted text', versionId: first.versionId });
    await publish(k, 'later text');
    expect((await api('POST', '/resolve', undefined, { key: k, locale: 'en-US' })).body.data.value).toBe('later text');
    const stored = await api('GET', `/snapshots/${snap.body.data.snapshotId}`, readOnly);
    expect(stored.body.data.items[0]).toMatchObject({ body: 'snapshotted text', version: 1 });
    // byte-stable: the read-back after a later publication (which closes version 1's period) equals the response at creation
    expect(stored.body.data.items[0]).not.toHaveProperty('effectiveTo');
    expect(JSON.stringify(stored.body.data)).toBe(JSON.stringify(snap.body.data));
    expect((await api('POST', '/snapshots', readOnly, { keys: [key('none')], locale: 'en-US', purpose: 'x' })).status).toBe(404);
    expect((await api('GET', '/snapshots/6f1d0c3e-9d1f-4a43-8f64-0a3b6f0f1111', readOnly)).status).toBe(404);
  });

  it('deactivating an entry makes it resolve as unknown', async () => {
    const k = key('toggle');
    await api('POST', '/entries', author, { key: k, contentType: 'PLAIN_TEXT', ownerRole: 'CONTENT', description: 'toggle test' });
    await publish(k, 'toggle text');
    expect((await api('POST', '/resolve', undefined, { key: k, locale: 'en-US' })).status).toBe(200);
    expect((await api('POST', `/entries/${k}/activation`, author, { active: false, reason: 'retire' })).body.data.isActive).toBe(false);
    expect((await api('POST', '/resolve', undefined, { key: k, locale: 'en-US' })).status).toBe(404);
    expect((await api('POST', `/entries/${k}/activation`, author, { active: true, reason: 'restore' })).body.data.isActive).toBe(true);
    expect((await api('POST', '/resolve', undefined, { key: k, locale: 'en-US' })).status).toBe(200);
  });

  it('activation bodies are validated raw: {"active":1}, "true", "false" and null are 400 and change nothing (no ajv coercion of booleans)', async () => {
    const k = key('coerce');
    await api('POST', '/entries', author, { key: k, contentType: 'PLAIN_TEXT', ownerRole: 'CONTENT', description: 'coercion test' });
    await publish(k, 'coerce text');
    const auditCount = async () => (await iso.database.query<{ n: number }>('SELECT count(*)::int AS n FROM content.audit_events', []))[0]!.n;
    const before = await auditCount();
    // an ACTIVE entry: {"active":"false"} / 0 / null would have DEACTIVATED it through coercion
    for (const active of [0, '0', 'false', null, '']) {
      const r = await api('POST', `/entries/${k}/activation`, author, { active, reason: 'must not apply' });
      expect(r.status, JSON.stringify(active)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect((await api('POST', '/resolve', undefined, { key: k, locale: 'en-US' })).status).toBe(200);
    // an INACTIVE locale: {"active":1} / "true" would have ACTIVATED it
    const loc = await api('POST', '/locales', author, { locale: 'qae', active: false, reason: 'coercion test' });
    expect(loc.status, JSON.stringify(loc.body)).toBe(201);
    for (const active of [1, '1', 'true', null]) {
      expect((await api('POST', '/locales/qae/activation', author, { active, reason: 'must not apply' })).status, JSON.stringify(active)).toBe(400);
      expect((await api('POST', '/locales', author, { locale: 'qaf', active, reason: 'must not apply' })).status, JSON.stringify(active)).toBe(400);
    }
    const stored = await iso.database.query<{ locale: string; is_active: boolean }>(
      "SELECT locale, is_active FROM content.locales WHERE locale IN ('qae', 'qaf')",
      [],
    );
    expect(stored).toEqual([{ locale: 'qae', is_active: false }]); // qaf was never registered, qae stayed inactive
    // nothing was audited by any of the refused requests (the only new audit rows are the registration above)
    expect((await auditCount()) - before).toBe(1);
    // real booleans still work
    expect((await api('POST', '/locales/qae/activation', author, { active: true, reason: 'now for real' })).body.data.isActive).toBe(true);
    expect((await api('POST', `/entries/${k}/activation`, author, { active: false, reason: 'now for real' })).body.data.isActive).toBe(false);
  });
});
