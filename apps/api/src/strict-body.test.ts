// Unit tests of the strict body helpers (plugins/strict-body.ts): the shared parse step with its value-free issues, and the preValidation hook that
// runs the strict contract on the RAW body before Fastify's Ajv can coerce it (DEBT-0043, option B). The account routes' own use of it is in account.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorResponse, SetActiveRoleRequest, UpdateProfileRequest } from '@bananagig/contracts';
import { createTokenVerifier } from '@bananagig/identity';
import { createTestKeys, signToken, TEST_ISSUER, type TestKeys } from '@bananagig/identity/testing';
import { AppError } from './errors';
import { authPlugin, requireAuthenticated } from './plugins/auth';
import { correlationPlugin } from './plugins/correlation';
import { errorPlugin } from './plugins/errors';
import { parseBody, strictBody } from './plugins/strict-body';

const thrown = (fn: () => unknown): AppError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('expected the call to throw');
};
const issuesOf = (e: AppError) => (e.details as { issues: { path: string; message: string }[] }).issues;

// ====================================================================== parseBody
describe('parseBody', () => {
  const Schema = z.object({ name: z.string(), count: z.number().int().default(3) }).strict();

  it('returns the parsed data, including defaults and transforms of the contract', () => {
    expect(parseBody(Schema, { name: 'x' })).toEqual({ name: 'x', count: 3 });
    expect(parseBody(z.object({ n: z.string().transform((s) => s.length) }), { n: 'abcd' })).toEqual({ n: 4 });
  });
  it('throws the standard validation AppError: category VALIDATION, code VALIDATION_FAILED, status 400, fixed message', () => {
    const e = thrown(() => parseBody(Schema, { name: 5 }));
    expect(e.category).toBe('VALIDATION');
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.status).toBe(400);
    expect(e.message).toBe('Request validation failed');
  });
  it('reports each issue as a path and a message, nothing else', () => {
    const e = thrown(() => parseBody(Schema, { name: 5, count: 'x' }));
    expect(issuesOf(e).map((i) => i.path)).toEqual(['name', 'count']);
    for (const issue of issuesOf(e)) {
      expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
      expect(typeof issue.message).toBe('string');
    }
    expect(Object.keys(e.details ?? {})).toEqual(['issues']);
  });
  it('uses dotted paths for nested objects and array indexes', () => {
    const Nested = z.object({ a: z.object({ b: z.array(z.object({ c: z.string() })) }) });
    expect(issuesOf(thrown(() => parseBody(Nested, { a: { b: [{ c: 'ok' }, { c: 1 }] } }))).map((i) => i.path)).toEqual(['a.b.1.c']);
    expect(issuesOf(thrown(() => parseBody(Nested, { a: { b: 'nope' } }))).map((i) => i.path)).toEqual(['a.b']);
    expect(issuesOf(thrown(() => parseBody(Nested, { a: 1 }))).map((i) => i.path)).toEqual(['a']);
  });
  it('uses an empty path for a problem with the whole body', () => {
    for (const body of [undefined, null, 'text', 5, [], true]) {
      expect(
        issuesOf(thrown(() => parseBody(Schema, body))).map((i) => i.path),
        String(body),
      ).toEqual(['']);
    }
  });
  it('names an unknown key but never its value', () => {
    const e = thrown(() => parseBody(Schema, { name: 'x', accountId: 'secret-account-value' }));
    expect(issuesOf(e)).toEqual([{ path: '', message: expect.stringContaining('accountId') }]);
    expect(JSON.stringify(e.details)).not.toContain('secret-account-value');
  });
  it('never echoes a rejected value of the real account contracts', () => {
    const cases: [z.ZodType, unknown, string][] = [
      [SetActiveRoleRequest, { role: 'secret-role-value' }, 'secret-role-value'],
      [SetActiveRoleRequest, { role: 123456789 }, '123456789'],
      [SetActiveRoleRequest, { role: ['secret-array-value'] }, 'secret-array-value'],
      [UpdateProfileRequest, { firstName: 'secret-first-name', lastName: 7 }, 'secret-first-name'],
      [UpdateProfileRequest, { firstName: 'a', lastName: 'b', timeZone: 'secret zone value' }, 'secret zone value'],
      [UpdateProfileRequest, { firstName: 'a', lastName: 'b', preferredLocale: 'secret_locale_value' }, 'secret_locale_value'],
      [UpdateProfileRequest, { firstName: 'x'.repeat(501) + 'secret-tail', lastName: 'b' }, 'secret-tail'],
    ];
    for (const [schema, body, value] of cases) {
      const e = thrown(() => parseBody(schema, body));
      expect(JSON.stringify(e.details), value).not.toContain(value);
      expect(e.message).not.toContain(value);
    }
  });
  it('does not coerce: a number is not a string and a string is not a number', () => {
    expect(thrown(() => parseBody(z.object({ s: z.string() }), { s: 5 })).code).toBe('VALIDATION_FAILED');
    expect(thrown(() => parseBody(z.object({ n: z.number() }), { n: '5' })).code).toBe('VALIDATION_FAILED');
    expect(thrown(() => parseBody(z.object({ b: z.boolean() }), { b: 'true' })).code).toBe('VALIDATION_FAILED');
  });
});

// ====================================================================== the strictBody hook
let app: FastifyInstance | undefined;
let keys: TestKeys | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const Body = z.object({ n: z.number().int().optional(), b: z.boolean().optional() }).strict();
/** The same shape for Ajv. Fastify's Ajv coerces types (query strings need it), so a plain body schema would turn "5" into 5. */
const bodySchema = { type: 'object', properties: { n: { type: 'integer' }, b: { type: 'boolean' } }, additionalProperties: false };

const buildApp = async (): Promise<FastifyInstance> => {
  const a = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  await a.register(correlationPlugin);
  await a.register(errorPlugin);
  app = a;
  return a;
};
const errorOf = (res: { json: () => unknown }) => ErrorResponse.parse(res.json()).error;

describe('strictBody: runs on the raw body, ahead of Ajv coercion', () => {
  const setup = async () => {
    const a = await buildApp();
    const strictHandler = vi.fn(async (req: { body: unknown }) => ({ body: req.body }));
    const looseHandler = vi.fn(async (req: { body: unknown }) => ({ body: req.body }));
    a.post('/strict', { preValidation: strictBody(Body), schema: { body: bodySchema } }, strictHandler);
    a.post('/loose', { schema: { body: bodySchema } }, looseHandler);
    return { a, strictHandler, looseHandler };
  };

  it('shows the problem it solves: without it Ajv coerces "5" to 5, "true" to true, 1 to true and null to 0', async () => {
    const { a } = await setup();
    const coerced = async (payload: unknown) =>
      ((await a.inject({ method: 'POST', url: '/loose', payload: payload as object })).json() as { body: unknown }).body;
    expect(await coerced({ n: '5' })).toEqual({ n: 5 });
    expect(await coerced({ b: 'true' })).toEqual({ b: true });
    expect(await coerced({ b: 1 })).toEqual({ b: true });
    expect(await coerced({ n: true })).toEqual({ n: 1 });
    expect(await coerced({ n: null })).toEqual({ n: 0 });
  });
  it.each([
    ['a numeric string for an integer', { n: '5' }],
    ['a boolean string for a boolean', { b: 'true' }],
    ['the number 1 for a boolean', { b: 1 }],
    ['a boolean for an integer', { n: true }],
    ['null for an integer', { n: null }],
    ['a float for an integer', { n: 1.5 }],
    ['an unknown key', { n: 5, extra: 1 }],
  ])('rejects %s with the standard envelope and never runs the handler', async (_label, payload) => {
    const { a, strictHandler } = await setup();
    const res = await a.inject({ method: 'POST', url: '/strict', payload });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED', message: 'Request validation failed' });
    expect(strictHandler).not.toHaveBeenCalled();
  });
  it('accepts an exact body and leaves it untouched for the handler', async () => {
    const { a, strictHandler } = await setup();
    for (const payload of [{ n: 5, b: true }, { n: 0 }, { b: false }, {}]) {
      const res = await a.inject({ method: 'POST', url: '/strict', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(200);
      expect(res.json()).toEqual({ body: payload });
    }
    expect(strictHandler).toHaveBeenCalledTimes(4);
  });
  it('reports the failing paths and never the values', async () => {
    const { a } = await setup();
    const res = await a.inject({ method: 'POST', url: '/strict', payload: { n: 'secret-n-value', b: 'secret-b-value' } });
    expect(res.statusCode).toBe(400);
    expect((errorOf(res).details as { issues: { path: string }[] }).issues.map((i) => i.path)).toEqual(['n', 'b']);
    expect(res.body).not.toContain('secret-n-value');
    expect(res.body).not.toContain('secret-b-value');
  });
  it.each([
    ['no body at all', undefined],
    ['a JSON string', '"text"'],
    ['a JSON number', '5'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
  ])('rejects %s', async (_label, payload) => {
    const { a, strictHandler } = await setup();
    const res = await a.inject({
      method: 'POST',
      url: '/strict',
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { payload }),
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).category).toBe('VALIDATION');
    expect(strictHandler).not.toHaveBeenCalled();
  });
  it('answers a body that is not JSON with the standard envelope too (Fastify rejects it before any hook)', async () => {
    const { a, strictHandler } = await setup();
    const res = await a.inject({ method: 'POST', url: '/strict', headers: { 'content-type': 'application/json' }, payload: '{"n": ' });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).category).toBe('VALIDATION');
    expect(strictHandler).not.toHaveBeenCalled();
  });
  it('validates a route that has no Ajv body schema at all', async () => {
    const a = await buildApp();
    a.post('/only-hook', { preValidation: strictBody(Body) }, async (req) => ({ body: req.body }));
    expect((await a.inject({ method: 'POST', url: '/only-hook', payload: { n: '5' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/only-hook', payload: { n: 5 } })).statusCode).toBe(200);
  });
  it('does not alter the body the handler receives even when the contract has defaults (parse is a check; the handler parses itself)', async () => {
    const a = await buildApp();
    a.post('/defaults', { preValidation: strictBody(z.object({ n: z.number().default(9) }).strict()) }, async (req) => ({ body: req.body }));
    const res = await a.inject({ method: 'POST', url: '/defaults', payload: {} });
    expect(res.json()).toEqual({ body: {} });
  });
});

describe('strictBody: ordering with the authorization hook', () => {
  const token = async (claims: Record<string, unknown> = {}) => signToken(keys!, { claims });
  const setup = async () => {
    keys = await createTestKeys('k1');
    const a = await buildApp();
    await a.register(authPlugin, {
      realm: 'bananagig',
      verifier: createTokenVerifier({
        issuer: TEST_ISSUER,
        apiAudience: 'bananagig-api',
        jwks: keys.getKey,
        webClientId: 'bananagig-web',
        adminClientId: 'bananagig-admin',
      }),
    });
    const after = vi.fn(async () => ({ ok: true }));
    const before = vi.fn(async () => ({ ok: true }));
    a.post('/after', { preValidation: [requireAuthenticated(), strictBody(Body)], schema: { body: bodySchema } }, after);
    a.post('/before', { preValidation: [strictBody(Body), requireAuthenticated()], schema: { body: bodySchema } }, before);
    return { a, after, before };
  };
  const bad = { n: 'x' };

  it('listed after the authorization hook: a missing token is 401 with WWW-Authenticate, whatever the body', async () => {
    const { a, after } = await setup();
    for (const payload of [bad, {}, { garbage: true }, undefined]) {
      const res = await a.inject({ method: 'POST', url: '/after', ...(payload !== undefined ? { payload } : {}) });
      expect(res.statusCode, JSON.stringify(payload)).toBe(401);
      expect(errorOf(res)).toMatchObject({ category: 'AUTHENTICATION', code: 'AUTHENTICATION_REQUIRED' });
      expect(res.headers['www-authenticate']).toContain('Bearer');
    }
    expect(after).not.toHaveBeenCalled();
  });
  it('listed after the authorization hook: an invalid token is 401 with the invalid_token challenge, whatever the body', async () => {
    const { a, after } = await setup();
    for (const authorization of ['Bearer not.a.token', 'Bearer', 'Basic abc', `Bearer ${await token({ aud: 'someone-else' })}`]) {
      const res = await a.inject({ method: 'POST', url: '/after', headers: { authorization }, payload: bad });
      expect(res.statusCode, authorization).toBe(401);
      expect(errorOf(res).category).toBe('AUTHENTICATION');
    }
    expect(after).not.toHaveBeenCalled();
  });
  it('listed after the authorization hook: a valid token with a bad body is 400, with a good body 200', async () => {
    const { a, after } = await setup();
    const authorization = `Bearer ${await token()}`;
    const rejected = await a.inject({ method: 'POST', url: '/after', headers: { authorization }, payload: bad });
    expect(rejected.statusCode).toBe(400);
    expect(errorOf(rejected).code).toBe('VALIDATION_FAILED');
    expect(after).not.toHaveBeenCalled();
    expect((await a.inject({ method: 'POST', url: '/after', headers: { authorization }, payload: { n: 5 } })).statusCode).toBe(200);
    expect(after).toHaveBeenCalledTimes(1);
  });
  it('listed BEFORE the authorization hook the 400 wins over the 401, which is why routes list it after', async () => {
    const { a, before } = await setup();
    const res = await a.inject({ method: 'POST', url: '/before', payload: bad });
    expect(res.statusCode).toBe(400);
    expect(before).not.toHaveBeenCalled();
    expect((await a.inject({ method: 'POST', url: '/before', payload: { n: 5 } })).statusCode).toBe(401);
  });
});
