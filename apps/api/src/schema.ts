import { z } from 'zod';
import { ErrorResponse } from '@bananagig/contracts';

/** Contract (zod) -> JSON Schema used by Fastify and by the generated OpenAPI document. */
export function schemaOf(t: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(t, { target: 'draft-7' }) as Record<string, unknown>;
  return rest;
}
export const errorSchema = schemaOf(ErrorResponse);
export const errorResponses = { 400: errorSchema, 404: errorSchema, 500: errorSchema, 503: errorSchema };
/** Documented failure responses for protected routes (403 only where a role guard applies). */
export const authErrorResponses = { 401: errorSchema, 503: errorSchema };
