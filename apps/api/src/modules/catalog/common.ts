// Helpers shared by the catalogue route modules (taxonomy and Gig Templates).
import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import { AppError } from '../../errors';
import { authErrorResponses, errorResponses, schemaOf } from '../../schema';
import { toAppError, type Texts } from './dto';

export const bearer = [{ bearerAuth: [] }];
/** Management routes: 401 missing/invalid token, 403 missing role, 404 unknown, 409 state conflicts. */
export const failures = { ...authErrorResponses, 400: errorResponses[400], 403: errorResponses[400], 404: errorResponses[404], 409: errorResponses[400] };
/** Public routes: 401 only for a credential that was presented and is invalid. */
export const publicFailures = { ...authErrorResponses, 400: errorResponses[400], 404: errorResponses[404] };
export const meta = (req: FastifyRequest) => ({ correlationId: req.correlationId });
export const run = async <T>(fn: () => Promise<T>): Promise<T> => fn().catch(toAppError);

export const params = (name: string, schema: ZodType) => ({
  type: 'object',
  properties: { [name]: schemaOf(schema) },
  required: [name],
  additionalProperties: false,
});

export const requireMarket = (market: string | undefined): string => {
  if (market === undefined)
    throw new AppError('VALIDATION', 'CATALOG_VALIDATION_FAILED', 'The market is required', { reason: 'MARKET_REQUIRED', field: 'market' });
  return market;
};
export const dropNull = <T>(list: (T | null)[]): T[] => list.filter((x): x is T => x !== null);

/** What the route modules share from the catalogue plugin: the caller's view, the actor and the text resolution. */
export interface CatalogRouteHelpers {
  privileged(req: FastifyRequest): boolean;
  actor(req: FastifyRequest): string;
  textsFor(keys: readonly string[], locale: string | undefined, marketCode: string | undefined, management: boolean): Promise<Texts>;
  localeFor(requested: string | undefined, marketDefault: string | undefined): Promise<string | undefined>;
  managementLocale(requested: string | undefined, marketCode: string | undefined): Promise<string | undefined>;
}
