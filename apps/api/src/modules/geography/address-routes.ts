// Address API (docs/engineering/ADDRESSES.md), registered under /api/v1/geography: the country-driven address format read model, administrative
// areas, the STATELESS validate and format operations, and the management routes for format drafts, publication and areas.
//
// Privacy: validate and format receive an address and return it normalized; they persist nothing, log nothing, and answer with `Cache-Control:
// no-store`. There is deliberately NO route that creates or reads a persisted address: persisted addresses are personal data and are used in
// process by the owning domains through AddressService until the identity and booking checkpoints define who may see them.
//
// Visibility follows the registry rules: public callers see ACTIVE countries only (everything else behaves as not found); a caller with the admin
// context plus geography-read (write implies read) also previews PLANNED and INACTIVE countries, drafts and inactive areas.
import type { FastifyInstance, FastifyReply, FastifyRequest, preValidationAsyncHookHandler } from 'fastify';
import type { ZodType } from 'zod';
import {
  AddressFormatListResponse,
  AddressFormatResponse,
  AddressValidationResponse,
  AdministrativeAreaListResponse,
  CountryCode,
  CreateAddressFormatRequest,
  FormatAddressRequest,
  FormatAddressResponse,
  PublishAddressFormatRequest,
  UpsertAdministrativeAreasRequest,
  UpsertAdministrativeAreasResponse,
  ValidateAddressRequest,
  ADDRESS_FORMAT_VERSION_BOUNDS,
} from '@bananagig/contracts';
import { toAddressFormatDto, toAdministrativeAreaDto, type AddressService } from '@bananagig/geography';
import { hasGeographyPermission, optionalAuthenticated, requireGeographyPermission } from '../../plugins/auth';
import { AppError } from '../../errors';
import { authErrorResponses, errorResponses, schemaOf } from '../../schema';
import { integerParamSchema, strictIntegerParams } from '../../plugins/strict-params';
import { toAppError } from './dto';

const bearer = [{ bearerAuth: [] }];
const failures = { ...authErrorResponses, 400: errorResponses[400], 403: errorResponses[400], 404: errorResponses[404], 409: errorResponses[400] };
const publicFailures = { ...authErrorResponses, 400: errorResponses[400], 404: errorResponses[404] };
const meta = (req: FastifyRequest) => ({ correlationId: req.correlationId });
const run = async <T>(fn: () => Promise<T>): Promise<T> => fn().catch(toAppError);
/** Address bodies are small; anything bigger is not an address. */
const ADDRESS_BODY_LIMIT = 16 * 1024;
const noStore = (reply: FastifyReply): void => {
  reply.header('Cache-Control', 'no-store');
};

/**
 * preValidation hook: validates the RAW body with the strict contract schema BEFORE Fastify's ajv step coerces types. The message of a failure
 * lists the paths only: a rejected value (an address part) is never echoed.
 */
const strictBody =
  <T>(schema: ZodType<T>): preValidationAsyncHookHandler =>
  async (req) => {
    const r = schema.safeParse(req.body);
    if (!r.success)
      throw new AppError('VALIDATION', 'VALIDATION_FAILED', 'Request validation failed', {
        issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
  };
const parse = <T>(schema: ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success)
    throw new AppError('VALIDATION', 'VALIDATION_FAILED', 'Request validation failed', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  return r.data;
};

const countryParams = { type: 'object', properties: { code: schemaOf(CountryCode) }, required: ['code'], additionalProperties: false };
const versionParams = {
  type: 'object',
  properties: { code: schemaOf(CountryCode), version: integerParamSchema(ADDRESS_FORMAT_VERSION_BOUNDS) },
  required: ['code', 'version'],
  additionalProperties: false,
};

export async function addressRoutes(app: FastifyInstance, deps: { address: AddressService }): Promise<void> {
  const svc = deps.address;
  const tags = ['geography'];
  const privileged = (req: FastifyRequest): boolean => hasGeographyPermission(req.principal, 'read');
  const actor = (req: FastifyRequest): string => req.principal!.subject;
  const code = (req: FastifyRequest): string => (req.params as { code: string }).code;

  // ------------------------------------------------------------------ public reads: the form definition and the area lookup
  app.get(
    '/countries/:code/address-format',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'getGeographyAddressFormat',
        summary:
          'The address form definition of a country: ordered fields with content label keys, required flags, maximum lengths, input types, validation patterns, examples and the administrative-area mode (LOOKUP, FREE_TEXT or NONE). ' +
          'Web and mobile render every address form from this; the server validates with the same definition. Public: ACTIVE countries only; geography-read callers may preview any country and also receive status, template and period',
        tags,
        security: [],
        params: countryParams,
        response: { 200: schemaOf(AddressFormatResponse), ...publicFailures },
      },
    },
    async (req) => {
      const management = privileged(req);
      return { data: toAddressFormatDto(await run(() => svc.getAddressFormat(code(req), { management })), management), meta: meta(req) };
    },
  );

  app.get(
    '/countries/:code/administrative-areas',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'listGeographyAdministrativeAreas',
        summary:
          'The administrative areas (states, provinces, regions) of a country in picker order, with the entry mode of its address format. Public: ACTIVE countries and ACTIVE areas; geography-read callers also see inactive areas and any country status',
        tags,
        security: [],
        params: countryParams,
        response: { 200: schemaOf(AdministrativeAreaListResponse), ...publicFailures },
      },
    },
    async (req) => {
      const management = privileged(req);
      const { mode, areas } = await run(() => svc.listAdministrativeAreas(code(req), { management }));
      return { data: { countryCode: code(req), mode, areas: areas.map((a) => toAdministrativeAreaDto(a, management)) }, meta: meta(req) };
    },
  );

  // ------------------------------------------------------------------ public, stateless: validate and format
  app.post(
    '/addresses/validate',
    {
      bodyLimit: ADDRESS_BODY_LIMIT,
      preValidation: [optionalAuthenticated(), strictBody(ValidateAddressRequest)],
      schema: {
        operationId: 'validateGeographyAddress',
        summary:
          'Validates and normalizes a structured address against the format in force for its country (the same rules the form shows). Stateless: nothing is stored or logged. An invalid address is a normal result (valid=false with issue codes and message keys, never the rejected values)',
        tags,
        security: [],
        body: schemaOf(ValidateAddressRequest),
        response: { 200: schemaOf(AddressValidationResponse), ...publicFailures },
      },
    },
    async (req, reply) => {
      noStore(reply);
      const body = parse(ValidateAddressRequest, req.body);
      const { outcome, format } = await run(() => svc.validateAddress(body.address, { management: privileged(req) }));
      return { data: { valid: outcome.valid, address: outcome.address, issues: outcome.issues, formatVersion: format.version }, meta: meta(req) };
    },
  );

  app.post(
    '/addresses/format',
    {
      bodyLimit: ADDRESS_BODY_LIMIT,
      preValidation: [optionalAuthenticated(), strictBody(FormatAddressRequest)],
      schema: {
        operationId: 'formatGeographyAddress',
        summary:
          'Formats a structured address with the display template of its country format (the one central formatter; clients never build the string). Validates first: an invalid address is 400 with the issue codes. Stateless: nothing is stored or logged',
        tags,
        security: [],
        body: schemaOf(FormatAddressRequest),
        response: { 200: schemaOf(FormatAddressResponse), ...publicFailures },
      },
    },
    async (req, reply) => {
      noStore(reply);
      const body = parse(FormatAddressRequest, req.body);
      const result = await run(() =>
        svc.formatAddress(body.address, { management: privileged(req), locale: body.locale, includeCountry: body.includeCountry }),
      );
      return { data: result, meta: meta(req) };
    },
  );

  // ------------------------------------------------------------------ management
  app.get(
    '/countries/:code/address-formats',
    {
      preValidation: requireGeographyPermission('read'),
      schema: {
        operationId: 'listGeographyAddressFormats',
        summary: 'Every version of a country address format, newest first, drafts included, with status, template and period',
        tags,
        security: bearer,
        params: countryParams,
        response: { 200: schemaOf(AddressFormatListResponse), ...failures },
      },
    },
    async (req) => ({ data: (await run(() => svc.listAddressFormats(code(req)))).map((f) => toAddressFormatDto(f, true)), meta: meta(req) }),
  );

  app.post(
    '/countries/:code/address-formats',
    {
      preValidation: [requireGeographyPermission('write'), strictBody(CreateAddressFormatRequest)],
      schema: {
        operationId: 'createGeographyAddressFormat',
        summary:
          'Create a DRAFT address format version for a country (fields in array order; labels are content keys; patterns are vetted). Nothing is public or in force until it is published',
        tags,
        security: bearer,
        params: countryParams,
        body: schemaOf(CreateAddressFormatRequest),
        response: { 201: schemaOf(AddressFormatResponse), ...failures },
      },
    },
    async (req, reply) => {
      const created = await run(() => svc.createFormatDraft(code(req), parse(CreateAddressFormatRequest, req.body), actor(req)));
      return reply.status(201).send({ data: toAddressFormatDto(created, true), meta: meta(req) });
    },
  );

  app.post(
    '/countries/:code/address-formats/:version/publication',
    {
      preValidation: [
        requireGeographyPermission('write'),
        strictIntegerParams({ version: ADDRESS_FORMAT_VERSION_BOUNDS }),
        strictBody(PublishAddressFormatRequest),
      ],
      schema: {
        operationId: 'publishGeographyAddressFormat',
        summary:
          'Publish a DRAFT format version: it becomes immutable and starts now (or later), and the format open-ended at that moment is closed at the new start. Idempotent for a published version; emits address-format-published',
        tags,
        security: bearer,
        params: versionParams,
        body: schemaOf(PublishAddressFormatRequest),
        response: { 200: schemaOf(AddressFormatResponse), ...failures },
      },
    },
    async (req) => {
      const { version } = req.params as { version: number };
      const published = await run(() => svc.publishFormat(code(req), version, parse(PublishAddressFormatRequest, req.body), actor(req)));
      return { data: toAddressFormatDto(published, true), meta: meta(req) };
    },
  );

  app.post(
    '/countries/:code/administrative-areas',
    {
      preValidation: [requireGeographyPermission('write'), strictBody(UpsertAdministrativeAreasRequest)],
      schema: {
        operationId: 'upsertGeographyAdministrativeAreas',
        summary:
          'Create the administrative areas that do not exist yet and update name, type, order and activity of the ones that do (rows are never deleted; a parent is set at creation only). Emits administrative-areas-updated when something changed',
        tags,
        security: bearer,
        params: countryParams,
        body: schemaOf(UpsertAdministrativeAreasRequest),
        response: { 200: schemaOf(UpsertAdministrativeAreasResponse), ...failures },
      },
    },
    async (req) => ({
      data: await run(() => svc.upsertAdministrativeAreas(code(req), parse(UpsertAdministrativeAreasRequest, req.body), actor(req))),
      meta: meta(req),
    }),
  );
}
