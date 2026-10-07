// Unit tests of the strict integer parameter hook and of the start-up guard that makes it impossible to register a numeric path or query parameter
// without it (GEO-002A). The route-level behavior for the real address routes is in address.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ErrorResponse, decimalIntegerMessage } from '@bananagig/contracts';
import { correlationPlugin } from './plugins/correlation';
import { errorPlugin } from './plugins/errors';
import { enforceStrictIntegerParams, integerParamSchema, strictIntegerParams } from './plugins/strict-params';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});
const build = async (): Promise<FastifyInstance> => {
  const a = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
  enforceStrictIntegerParams(a);
  await a.register(correlationPlugin);
  await a.register(errorPlugin);
  app = a;
  return a;
};
const params = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties) });

describe('integerParamSchema', () => {
  it('documents the same bounds the parser applies', () => {
    expect(integerParamSchema({ min: 1, max: 100000 })).toMatchObject({ type: 'integer', minimum: 1, maximum: 100000 });
    expect(integerParamSchema()).toMatchObject({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
    expect(integerParamSchema({ min: 1, max: 100000 }).description).toBe(`Canonical base-10 integer text: ${decimalIntegerMessage({ min: 1, max: 100000 })}.`);
  });
});

describe('strictIntegerParams (path parameters)', () => {
  const setup = async () => {
    const a = await build();
    a.get(
      '/v/:version',
      {
        preValidation: strictIntegerParams({ version: { min: 1, max: 100 } }),
        schema: { params: params({ version: integerParamSchema({ min: 1, max: 100 }) }) },
      },
      async (req) => ({ version: (req.params as { version: number }).version }),
    );
    return a;
  };
  it.each(['1', '99', '100'])('accepts %s and the handler receives a number', async (raw) => {
    const a = await setup();
    const res = await a.inject({ method: 'GET', url: `/v/${raw}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: Number(raw) });
  });
  it.each(['1e1', '1.0', '+1', '-1', '01', '0', '101', '%201', '0x10', 'Infinity', 'NaN', '1_0', '%D9%A1'])(
    'rejects %s with the standard envelope',
    async (raw) => {
      const a = await setup();
      const res = await a.inject({ method: 'GET', url: `/v/${raw}` });
      expect(res.statusCode).toBe(400);
      const error = ErrorResponse.parse(res.json()).error;
      expect(error).toMatchObject({ category: 'VALIDATION', code: 'VALIDATION_FAILED', message: 'Request validation failed' });
      expect((error.details as { issues: { path: string }[] }).issues).toEqual([expect.objectContaining({ path: 'params.version' })]);
    },
  );
  it('reports every bad parameter of a route at once', async () => {
    const a = await build();
    a.get(
      '/p/:a/:b',
      {
        preValidation: strictIntegerParams({ a: { min: 1 }, b: { min: 1 } }),
        schema: { params: params({ a: integerParamSchema({ min: 1 }), b: integerParamSchema({ min: 1 }) }) },
      },
      async () => ({}),
    );
    const res = await a.inject({ method: 'GET', url: '/p/1e1/2.0' });
    expect((ErrorResponse.parse(res.json()).error.details as { issues: { path: string }[] }).issues.map((i) => i.path)).toEqual(['params.a', 'params.b']);
  });
});

describe('strictIntegerParams (query strings)', () => {
  const setup = async () => {
    const a = await build();
    a.get(
      '/list',
      {
        preValidation: strictIntegerParams({ limit: { min: 1, max: 50 } }, 'querystring'),
        schema: { querystring: { type: 'object', properties: { limit: integerParamSchema({ min: 1, max: 50 }) } } },
      },
      async (req) => ({ limit: (req.query as { limit?: number }).limit ?? null }),
    );
    return a;
  };
  it('leaves an absent optional parameter to the schema and accepts canonical text', async () => {
    const a = await setup();
    expect((await a.inject({ method: 'GET', url: '/list' })).json()).toEqual({ limit: null });
    expect((await a.inject({ method: 'GET', url: '/list?limit=25' })).json()).toEqual({ limit: 25 });
  });
  it.each(['1e1', '2.5', '+3', '-3', '03', '0', '51', '%204', '0x10', 'Infinity', 'NaN', '', '1&limit=2'])('rejects limit=%s', async (raw) => {
    const a = await setup();
    const res = await a.inject({ method: 'GET', url: `/list?limit=${raw}` });
    expect(res.statusCode, raw).toBe(400);
    expect(ErrorResponse.parse(res.json()).error.code).toBe('VALIDATION_FAILED');
  });
});

describe('enforceStrictIntegerParams (the start-up guard)', () => {
  it('refuses to register a route whose numeric path parameter is not guarded', async () => {
    const a = await build();
    expect(() => a.get('/v/:version', { schema: { params: params({ version: { type: 'integer' } }) } }, async () => ({}))).toThrow(
      /GET \/v\/:version: params\.version is numeric and must be guarded by strictIntegerParams/,
    );
  });
  it('refuses unguarded numeric query properties, whatever way the number is written in the schema', async () => {
    const a = await build();
    const q = (properties: Record<string, unknown>) => ({ schema: { querystring: { type: 'object', properties } } });
    expect(() => a.get('/a', q({ n: { type: 'number' } }), async () => ({}))).toThrow(/querystring\.n/);
    expect(() => a.get('/b', q({ n: { type: ['integer', 'null'] } }), async () => ({}))).toThrow(/querystring\.n/);
    expect(() => a.get('/c', q({ n: { anyOf: [{ type: 'string' }, { type: 'integer' }] } }), async () => ({}))).toThrow(/querystring\.n/);
    expect(() => a.get('/d', q({ n: { type: 'array', items: { type: 'integer' } } }), async () => ({}))).toThrow(/querystring\.n/);
  });
  it('does not accept a hook that covers a different parameter or a different source', async () => {
    const a = await build();
    const route = (preValidation: ReturnType<typeof strictIntegerParams>) =>
      a.get(`/x${Math.random().toString(36).slice(2)}/:id`, { preValidation, schema: { params: params({ id: { type: 'integer' } }) } }, async () => ({}));
    expect(() => route(strictIntegerParams({ other: {} }))).toThrow(/params\.id/);
    expect(() => route(strictIntegerParams({ id: {} }, 'querystring'))).toThrow(/params\.id/);
    expect(() => route(strictIntegerParams({ id: {} }))).not.toThrow();
  });
  it('accepts the guard in a preValidation list next to other hooks, and ignores string and object parameters', async () => {
    const a = await build();
    expect(() =>
      a.get(
        '/ok/:id/:code',
        {
          preValidation: [async () => undefined, strictIntegerParams({ id: { min: 1 } })],
          schema: { params: params({ id: { type: 'integer', minimum: 1 }, code: { type: 'string' } }) },
        },
        async () => ({}),
      ),
    ).not.toThrow();
    expect(() => a.get('/s/:code', { schema: { params: params({ code: { type: 'string', pattern: '^[A-Z]{2}$' } }) } }, async () => ({}))).not.toThrow();
    expect(() => a.get('/none', async () => ({}))).not.toThrow();
  });
  it('fails closed on a $ref, wherever it appears: it can point at a numeric schema registered elsewhere', async () => {
    const a = await build();
    a.addSchema({ $id: 'shared-int', type: 'integer' });
    a.addSchema({ $id: 'shared-params', type: 'object', properties: { n: { type: 'integer' } } });
    expect(() => a.get('/r1/:n', { schema: { params: params({ n: { $ref: 'shared-int#' } }) } }, async () => ({}))).toThrow(/params uses \$ref/);
    expect(() => a.get('/r2', { schema: { querystring: { type: 'object', properties: { n: { $ref: 'shared-int#' } } } } }, async () => ({}))).toThrow(
      /querystring uses \$ref/,
    );
    expect(() => a.get('/r3/:n', { schema: { params: { $ref: 'shared-params#' } } }, async () => ({}))).toThrow(/params uses \$ref/);
    expect(() =>
      a.get(
        '/r4',
        { schema: { querystring: { type: 'object', definitions: { I: { type: 'integer' } }, properties: { n: { $ref: '#/definitions/I' } } } } },
        async () => ({}),
      ),
    ).toThrow(/querystring uses \$ref/);
  });
  it('fails closed on a numeric schema declared outside `properties`', async () => {
    const a = await build();
    const q = (querystring: Record<string, unknown>) => ({ schema: { querystring } });
    expect(() => a.get('/c1', q({ type: 'object', allOf: [{ properties: { n: { type: 'integer' } } }] }), async () => ({}))).toThrow(/outside `properties`/);
    expect(() => a.get('/c2', q({ oneOf: [{ type: 'object', properties: { n: { type: 'integer' } } }] }), async () => ({}))).toThrow(/outside `properties`/);
    expect(() => a.get('/c3', q({ anyOf: [{ type: 'object', properties: { n: { type: 'number' } } }] }), async () => ({}))).toThrow(/outside `properties`/);
    expect(() => a.get('/c4', q({ type: 'object', additionalProperties: { type: 'integer' } }), async () => ({}))).toThrow(/outside `properties`/);
    expect(() => a.get('/c5', q({ type: 'object', patternProperties: { '^n': { type: 'integer' } } }), async () => ({}))).toThrow(/outside `properties`/);
    expect(() => a.get('/c6', q({ type: 'object', if: { properties: { n: { type: 'integer' } } }, then: {} }), async () => ({}))).toThrow(
      /outside `properties`/,
    );
    // a plain object schema, `required` and `additionalProperties: false` are not numeric
    expect(() =>
      a.get('/c7', q({ type: 'object', required: ['s'], additionalProperties: false, properties: { s: { type: 'string' } } }), async () => ({})),
    ).not.toThrow();
  });
  it('recognizes only a hook that is a direct entry of the route own preValidation (a wrapper is refused)', async () => {
    const a = await build();
    // a hook the guard cannot recognize (here simply another function): the route is refused even if the hook were doing the right thing inside
    const wrapped: ReturnType<typeof strictIntegerParams> = async () => undefined;
    expect(() => a.get('/w/:id', { preValidation: wrapped, schema: { params: params({ id: { type: 'integer' } }) } }, async () => ({}))).toThrow(
      /params\.id is numeric/,
    );
  });
  it('applies to routes registered inside encapsulated plugins (the plugin fails to load)', async () => {
    const a = await build();
    await expect(
      a.register(async (child) => {
        child.get('/inner/:n', { schema: { params: params({ n: { type: 'integer' } }) } }, async () => ({}));
      }),
    ).rejects.toThrow(/params\.n is numeric and must be guarded/);
  });
});
