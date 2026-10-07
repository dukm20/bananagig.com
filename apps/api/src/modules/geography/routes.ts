// Geography registry API (docs/engineering/GEOGRAPHY.md): countries, markets, currencies, time zones and the data-driven market defaults.
// The reads are PUBLIC routes with visibility rules: anonymous callers (and callers without the admin context plus geography-read or geography-write) see ACTIVE
// data and the public fields only, PLANNED and INACTIVE rows behave as not found. A caller with the admin context plus geography-read (or geography-write, which implies it) gets every
// status and the management-only fields, and readiness. Management mutations need the admin context plus geography-write, which also implies
// the management view (geography-write holds read). Public reads answer with `Vary: Authorization` (the body depends on the optional token).
// Routes are thin; all rules live in @bananagig/geography.
import type { FastifyInstance, FastifyRequest, preValidationAsyncHookHandler } from 'fastify';
import type { ZodType } from 'zod';
import {
  CountryCode,
  CountryListResponse,
  CountryResponse,
  CreateCountryRequest,
  CreateMarketRequest,
  CurrencyListResponse,
  GeoActivationRequest,
  MarketCode,
  MarketDefaultsResponse,
  MarketListResponse,
  MarketReadinessResponse,
  MarketResponse,
  TimeZoneListResponse,
  UpdateCountryRequest,
  UpdateMarketRequest,
} from '@bananagig/contracts';
import type { GeographyService } from '@bananagig/geography';
import { hasGeographyPermission, optionalAuthenticated, requireGeographyPermission } from '../../plugins/auth';
import { AppError } from '../../errors';
import { authErrorResponses, errorResponses, schemaOf } from '../../schema';
import { countryDto, currencyDto, marketDefaultsDto, marketDto, readinessDto, timeZoneDto, toAppError } from './dto';

const bearer = [{ bearerAuth: [] }];
/** Management routes: 401 missing/invalid token, 403 missing role (documented with the standard error schema), 404 unknown, 409 state conflicts. */
const failures = { ...authErrorResponses, 400: errorResponses[400], 403: errorResponses[400], 404: errorResponses[404], 409: errorResponses[400] };
/** Public routes: 401 only for a credential that was presented and is invalid. */
const publicFailures = { ...authErrorResponses, 400: errorResponses[400], 404: errorResponses[404] };
const meta = (req: FastifyRequest) => ({ correlationId: req.correlationId });
const parse = <T>(schema: ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success)
    throw new AppError('VALIDATION', 'VALIDATION_FAILED', 'Request validation failed', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  return r.data;
};
const run = async <T>(fn: () => Promise<T>): Promise<T> => fn().catch(toAppError);
/**
 * preValidation hook for every management body: validates the RAW parsed body with the strict contract schema BEFORE Fastify's ajv step, which
 * coerces types ({"active":1} would become true, {"active":"false"} false, a number a string). Ajv coercion stays on app-wide (query strings
 * need it); bodies must be exactly the contract. Listed after the authorization hook, so 401/403 still win over 400. Same envelope as `parse`.
 */
const strictBody =
  <T>(schema: ZodType<T>): preValidationAsyncHookHandler =>
  async (req) => {
    parse(schema, req.body);
  };

const codeParams = (schema: ZodType) => ({ type: 'object', properties: { code: schemaOf(schema) }, required: ['code'], additionalProperties: false });
const countryParams = codeParams(CountryCode);
const marketParams = codeParams(MarketCode);

export async function geographyRoutes(app: FastifyInstance, deps: { geography: GeographyService }): Promise<void> {
  const svc = deps.geography;
  const tags = ['geography'];
  const actor = (req: FastifyRequest): string => req.principal!.subject;
  /**
   * Management view: every status and the management-only fields. Only the admin context with geography-read or geography-write (write implies
   * read); everyone else is anonymous-equivalent.
   */
  const privileged = (req: FastifyRequest): boolean => hasGeographyPermission(req.principal, 'read');
  const code = (req: FastifyRequest): string => (req.params as { code: string }).code;

  // ------------------------------------------------------------------ public reads
  app.get(
    '/countries',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'listGeographyCountries',
        summary:
          'List countries: public callers get the ACTIVE countries (public fields); callers with geography-read (or geography-write) get every status and the management fields',
        tags,
        security: [],
        response: { 200: schemaOf(CountryListResponse), ...publicFailures },
      },
    },
    async (req) => {
      const management = privileged(req);
      return { data: (await run(() => svc.listCountries({ management }))).map((c) => countryDto(c, management)), meta: meta(req) };
    },
  );

  app.get(
    '/countries/:code',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'getGeographyCountry',
        summary: 'One country by ISO 3166-1 alpha-2 code (upper case). A country that is not ACTIVE is not found for public callers',
        tags,
        security: [],
        params: countryParams,
        response: { 200: schemaOf(CountryResponse), ...publicFailures },
      },
    },
    async (req) => {
      const management = privileged(req);
      return { data: countryDto(await run(() => svc.getCountry(code(req), { management })), management), meta: meta(req) };
    },
  );

  app.get(
    '/markets',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'listGeographyMarkets',
        summary:
          'List markets: public callers get the ACTIVE markets in effect; callers with geography-read (or geography-write) get every status and the management fields',
        tags,
        security: [],
        querystring: { type: 'object', properties: { countryCode: schemaOf(CountryCode) }, additionalProperties: false },
        response: { 200: schemaOf(MarketListResponse), ...publicFailures },
      },
    },
    async (req) => {
      const management = privileged(req);
      const { countryCode } = req.query as { countryCode?: string };
      return { data: (await run(() => svc.listMarkets({ management, countryCode }))).map((m) => marketDto(m, management)), meta: meta(req) };
    },
  );

  app.get(
    '/markets/:code',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'getGeographyMarket',
        summary:
          'One market by code (lower-case kebab). A market that is not ACTIVE and in effect is not found for public callers; effectiveTo (planned retirement) is returned to management callers only',
        tags,
        security: [],
        params: marketParams,
        response: { 200: schemaOf(MarketResponse), ...publicFailures },
      },
    },
    async (req) => {
      const management = privileged(req);
      return { data: marketDto(await run(() => svc.getMarket(code(req), { management })), management), meta: meta(req) };
    },
  );

  app.get(
    '/markets/:code/defaults',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'getGeographyMarketDefaults',
        summary:
          'Data-driven defaults of a market (locale, currency, time zone, units and formats), from reference data with no code fallback. ' +
          'Public: ACTIVE markets in effect only. Callers with geography-read (or geography-write) may also fetch defaults for PLANNED and INACTIVE markets',
        tags,
        security: [],
        params: marketParams,
        response: { 200: schemaOf(MarketDefaultsResponse), ...publicFailures },
      },
    },
    async (req) => {
      const includeInactive = privileged(req);
      return { data: marketDefaultsDto(await run(() => svc.resolveMarketDefaults(code(req), { includeInactive })), includeInactive), meta: meta(req) };
    },
  );

  app.get(
    '/currencies',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'listGeographyCurrencies',
        summary:
          'List currencies (ISO 4217, with minor-unit digits): public callers get the ACTIVE currencies; callers with geography-read (or geography-write) get every status',
        tags,
        security: [],
        response: { 200: schemaOf(CurrencyListResponse), ...publicFailures },
      },
    },
    async (req) => {
      const management = privileged(req);
      return { data: (await run(() => svc.listCurrencies({ management }))).map((c) => currencyDto(c, management)), meta: meta(req) };
    },
  );

  app.get(
    '/time-zones',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'listGeographyTimeZones',
        summary: 'List IANA time zones: public callers get the ACTIVE zones; callers with geography-read (or geography-write) get every status',
        tags,
        security: [],
        response: { 200: schemaOf(TimeZoneListResponse), ...publicFailures },
      },
    },
    async (req) => {
      const management = privileged(req);
      return { data: (await run(() => svc.listTimeZones({ management }))).map((t) => timeZoneDto(t, management)), meta: meta(req) };
    },
  );

  // ------------------------------------------------------------------ management reads
  app.get(
    '/markets/:code/readiness',
    {
      preValidation: requireGeographyPermission('read'),
      schema: {
        operationId: 'getGeographyMarketReadiness',
        summary: 'The extensible readiness checks that gate market activation, evaluated now (never cached)',
        tags,
        security: bearer,
        params: marketParams,
        response: { 200: schemaOf(MarketReadinessResponse), ...failures },
      },
    },
    async (req) => ({ data: readinessDto(await run(() => svc.getMarketReadiness(code(req)))), meta: meta(req) }),
  );

  // ------------------------------------------------------------------ management mutations
  app.post(
    '/countries',
    {
      preValidation: [requireGeographyPermission('write'), strictBody(CreateCountryRequest)],
      schema: {
        operationId: 'createGeographyCountry',
        summary: 'Create a country as PLANNED (activation is a separate step; the test country ZZ is DEV/TEST only)',
        tags,
        security: bearer,
        body: schemaOf(CreateCountryRequest),
        response: { 201: schemaOf(CountryResponse), ...failures },
      },
    },
    async (req, reply) => {
      const body = parse(CreateCountryRequest, req.body);
      return reply.status(201).send({ data: countryDto(await run(() => svc.createCountry(body, actor(req))), true), meta: meta(req) });
    },
  );

  app.put(
    '/countries/:code',
    {
      preValidation: [requireGeographyPermission('write'), strictBody(UpdateCountryRequest)],
      schema: {
        operationId: 'updateGeographyCountry',
        summary: 'Change the provided fields of a country (ISO codes are identity; supportedLocales and timeZones replace the sets)',
        tags,
        security: bearer,
        params: countryParams,
        body: schemaOf(UpdateCountryRequest),
        response: { 200: schemaOf(CountryResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(UpdateCountryRequest, req.body);
      return { data: countryDto(await run(() => svc.updateCountry(code(req), body, actor(req))), true), meta: meta(req) };
    },
  );

  app.post(
    '/countries/:code/activation',
    {
      preValidation: [requireGeographyPermission('write'), strictBody(GeoActivationRequest)],
      schema: {
        operationId: 'setGeographyCountryActive',
        summary:
          'Activate or deactivate a country (idempotent; activation needs an ACTIVE currency, locale and time zone; deactivation is blocked while markets are ACTIVE)',
        tags,
        security: bearer,
        params: countryParams,
        body: schemaOf(GeoActivationRequest),
        response: { 200: schemaOf(CountryResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(GeoActivationRequest, req.body);
      return { data: countryDto(await run(() => svc.setCountryActive(code(req), body.active, body.reason, actor(req))), true), meta: meta(req) };
    },
  );

  app.post(
    '/markets',
    {
      preValidation: [requireGeographyPermission('write'), strictBody(CreateMarketRequest)],
      schema: {
        operationId: 'createGeographyMarket',
        summary: 'Create a market as PLANNED (devtest-* codes are DEV/TEST only)',
        tags,
        security: bearer,
        body: schemaOf(CreateMarketRequest),
        response: { 201: schemaOf(MarketResponse), ...failures },
      },
    },
    async (req, reply) => {
      const body = parse(CreateMarketRequest, req.body);
      return reply.status(201).send({ data: marketDto(await run(() => svc.createMarket(body, actor(req))), true), meta: meta(req) });
    },
  );

  app.put(
    '/markets/:code',
    {
      preValidation: [requireGeographyPermission('write'), strictBody(UpdateMarketRequest)],
      schema: {
        operationId: 'updateGeographyMarket',
        summary:
          'Change the provided fields of a market (code and country are identity; changing the default locale, currency or time zone emits market-defaults-changed)',
        tags,
        security: bearer,
        params: marketParams,
        body: schemaOf(UpdateMarketRequest),
        response: { 200: schemaOf(MarketResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(UpdateMarketRequest, req.body);
      return { data: marketDto(await run(() => svc.updateMarket(code(req), body, actor(req))), true), meta: meta(req) };
    },
  );

  app.post(
    '/markets/:code/activation',
    {
      preValidation: [requireGeographyPermission('write'), strictBody(GeoActivationRequest)],
      schema: {
        operationId: 'setGeographyMarketActive',
        summary: 'Activate or deactivate a market (idempotent; activation runs every registered readiness check and fails with the failing checks)',
        tags,
        security: bearer,
        params: marketParams,
        body: schemaOf(GeoActivationRequest),
        response: { 200: schemaOf(MarketResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(GeoActivationRequest, req.body);
      return { data: marketDto(await run(() => svc.setMarketActive(code(req), body.active, body.reason, actor(req))), true), meta: meta(req) };
    },
  );
}
