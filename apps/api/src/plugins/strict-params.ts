// Strict integer path and query parameters. Fastify's Ajv runs with type coercion on (query strings need it), and coercion turns `1e3` into 1000,
// `1.0` and `+1` and `01` into 1, `0x10` into 16 and ` 1` into 1. Integers that arrive as text are therefore checked lexically by the ONE shared
// parser (parseDecimalInteger in @bananagig/contracts) in a preValidation hook, BEFORE Ajv sees them, and answered with the standard validation
// envelope. `enforceStrictIntegerParams` makes forgetting the hook impossible: a route whose params or querystring schema has a numeric property that is
// not covered by `strictIntegerParams` fails to register, at start-up and in every test that builds the app.
import type { FastifyInstance, preValidationAsyncHookHandler } from 'fastify';
import { decimalIntegerMessage, parseDecimalInteger, type IntegerBounds } from '@bananagig/contracts';
import { AppError } from '../errors';

type Source = 'params' | 'querystring';
const GUARDED = Symbol.for('bananagig.strictIntegerParams');
interface Guard {
  source: Source;
  names: string[];
}

/** JSON Schema of an integer parameter, with the same bounds the strict parser applies (documented in OpenAPI). */
export const integerParamSchema = (bounds: IntegerBounds = {}): Record<string, unknown> => ({
  type: 'integer',
  minimum: bounds.min ?? 0,
  maximum: bounds.max ?? Number.MAX_SAFE_INTEGER,
  description: `Canonical base-10 integer text: ${decimalIntegerMessage(bounds)}.`,
});

/**
 * preValidation hook: every listed parameter must be canonical base-10 integer text within its bounds (an absent query parameter is left to the
 * schema's `required`). List it AFTER the authorization hook so 401 and 403 still win over 400.
 */
export function strictIntegerParams(spec: Record<string, IntegerBounds>, source: Source = 'params'): preValidationAsyncHookHandler {
  const hook: preValidationAsyncHookHandler = async (req) => {
    const bag = ((source === 'params' ? req.params : req.query) ?? {}) as Record<string, unknown>;
    const issues: { path: string; message: string }[] = [];
    for (const [name, bounds] of Object.entries(spec)) {
      const raw = bag[name];
      if (raw === undefined && source === 'querystring') continue;
      if (parseDecimalInteger(raw, bounds) === null) issues.push({ path: `${source}.${name}`, message: decimalIntegerMessage(bounds) });
    }
    if (issues.length > 0) throw new AppError('VALIDATION', 'VALIDATION_FAILED', 'Request validation failed', { issues });
  };
  return Object.assign(hook, { [GUARDED]: { source, names: Object.keys(spec) } satisfies Guard });
}

const allowsNumber = (schema: unknown): boolean => {
  if (schema === null || typeof schema !== 'object') return false;
  const type = (schema as { type?: unknown }).type;
  if (type === 'integer' || type === 'number' || (Array.isArray(type) && (type.includes('integer') || type.includes('number')))) return true;
  return Object.values(schema as Record<string, unknown>).some((v) => (Array.isArray(v) ? v.some(allowsNumber) : allowsNumber(v)));
};
/** A `$ref` anywhere hides what the schema accepts (it can point at a numeric schema registered elsewhere), so the guard fails closed on it. */
const containsRef = (schema: unknown): boolean =>
  schema !== null &&
  typeof schema === 'object' &&
  ('$ref' in schema || Object.values(schema as Record<string, unknown>).some((v) => (Array.isArray(v) ? v.some(containsRef) : containsRef(v))));

/**
 * Registers an onRoute hook (call before any route is registered) that refuses to register a route whose params or querystring schema can accept a number
 * without `strictIntegerParams` covering it. Fail closed: a numeric property that is not covered, a numeric type declared anywhere outside `properties`
 * (allOf, oneOf, anyOf, additionalProperties, patternProperties, ...) and any `$ref` are all refused, because none of them can be tied to a hook by name.
 * The hook must be a direct entry of the route's own `preValidation` (a plugin-level or wrapped hook is not recognized and the route is refused).
 */
export function enforceStrictIntegerParams(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    const hooks = [route.preValidation].flat().filter((h): h is NonNullable<typeof h> => typeof h === 'function');
    const guards = hooks.map((h) => (h as unknown as Record<symbol, Guard | undefined>)[GUARDED]).filter((g): g is Guard => g !== undefined);
    const schema = route.schema as Record<string, Record<string, unknown> | undefined> | undefined;
    const where = `route ${String(route.method)} ${route.url}`;
    for (const source of ['params', 'querystring'] as const) {
      const declared = schema?.[source];
      if (declared === undefined) continue;
      if (containsRef(declared))
        throw new Error(`${where}: ${source} uses $ref; inline the schema so its numeric parameters can be guarded by strictIntegerParams`);
      const { properties, ...rest } = declared as { properties?: Record<string, unknown> };
      if (allowsNumber(rest))
        throw new Error(
          `${where}: ${source} declares a numeric schema outside \`properties\`; declare numeric parameters under properties and guard them with strictIntegerParams`,
        );
      for (const [name, definition] of Object.entries(properties ?? {})) {
        if (allowsNumber(definition) && !guards.some((g) => g.source === source && g.names.includes(name)))
          throw new Error(`${where}: ${source}.${name} is numeric and must be guarded by strictIntegerParams`);
      }
    }
  });
}
