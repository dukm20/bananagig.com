// Content and localization registry API (docs/engineering/CONTENT.md). Management routes are internal/admin only: they need the admin identity
// context plus a temporary content permission (content-read | content-write | content-approve) and, for entries owned by LEGAL, content-legal.
// Resolution and the active locale list are PUBLIC routes with visibility rules: anonymous callers only ever see PUBLIC entries, never the
// template source and never `at` previews. Routes are thin; all rules live in @bananagig/content.
import { parseBody as parse, strictBody } from '../../plugins/strict-body';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ContentDecisionRequest,
  ContentSnapshotResponse,
  ContentVersionResponse,
  CONTENT_OWNER_ROLES,
  CONTENT_TYPES,
  CreateContentSnapshotRequest,
  CreateEntryRequest,
  CreateVersionRequest,
  EntryDetailResponse,
  EntryListResponse,
  EntryResponse,
  LocaleListResponse,
  LocaleResponse,
  RegisterLocaleRequest,
  ResolveContentRequest,
  ResolveContentResponse,
  ResolveManyContentRequest,
  ResolveManyContentResponse,
  SetActiveRequest,
  type ContentOwnerRole,
  type ContentType,
} from '@bananagig/contracts';
import { renderResolved, type ContentService } from '@bananagig/content';
import { assertContentLegal, hasContentPermission, optionalAuthenticated, requireContentPermission } from '../../plugins/auth';
import { AppError } from '../../errors';
import { authErrorResponses, errorResponses, schemaOf } from '../../schema';
import { entryDto, localeDto, renderedDto, snapshotDto, toAppError, versionDto } from './dto';

const bearer = [{ bearerAuth: [] }];
const failures = { ...authErrorResponses, 400: errorResponses[400], 403: errorResponses[400], 404: errorResponses[404], 409: errorResponses[400] };
/** Public routes: 401 only for a credential that was presented and is invalid; 403 for privileged request options used anonymously. */
const publicFailures = { ...authErrorResponses, 400: errorResponses[400], 403: errorResponses[400], 404: errorResponses[404] };
const meta = (req: FastifyRequest) => ({ correlationId: req.correlationId });
const run = async <T>(fn: () => Promise<T>): Promise<T> => fn().catch(toAppError);
/** Synchronous variant for the pure rendering step (its typed failures map the same way). */
const runSync = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    return toAppError(e);
  }
};
const idParams = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] };
const keyParams = { type: 'object', properties: { key: { type: 'string', maxLength: 160 } }, required: ['key'] };
/**
 * Hard budget on the TOTAL template source length of the entries a single resolve-many call renders. Rendering is synchronous CPU work and the
 * response grows with the source, and the public route can name 100 guessable keys, so the work is bounded before anything is rendered. A
 * technical safety limit (not business configuration); LEGAL/CRITICAL entries bypass the cache, so this also bounds the database read.
 */
export const MAX_RESOLVE_MANY_SOURCE_CHARS = 500_000;
const insufficient = (): AppError => new AppError('AUTHORIZATION', 'INSUFFICIENT_PERMISSIONS', 'You do not have permission to perform this action');

export async function contentRoutes(app: FastifyInstance, deps: { content: ContentService }): Promise<void> {
  const svc = deps.content;
  const tags = ['content'];
  const actor = (req: FastifyRequest): string => req.principal!.subject;
  /** Whether the caller may see INTERNAL entries, use `at`, and ask for the template source. Anonymous and non-admin callers may not. */
  const privileged = (req: FastifyRequest): boolean => hasContentPermission(req.principal, 'read');
  const rejectPrivilegedOptions = (req: FastifyRequest, o: { at?: string; includeTemplate?: boolean }): void => {
    if (!privileged(req) && (o.at !== undefined || o.includeTemplate === true)) throw insufficient();
  };

  /** Legal documents need content-legal on top of the ordinary permission. Looked up from the stored entry, never from the request. */
  const assertEntryAccess = async (req: FastifyRequest, key: string): Promise<void> => {
    const entry = await run(() => svc.findEntry(key));
    if (entry.ownerRole === 'LEGAL') assertContentLegal(req.principal);
  };
  const assertVersionAccess = async (req: FastifyRequest, versionId: string): Promise<void> => {
    const version = await run(() => svc.getVersion(versionId));
    await assertEntryAccess(req, version.entryKey);
  };

  // ------------------------------------------------------------------ entries
  app.get(
    '/entries',
    {
      preValidation: requireContentPermission('read'),
      schema: {
        operationId: 'listContentEntries',
        summary: 'List content entries (definitions, no copy text)',
        tags,
        security: bearer,
        querystring: {
          type: 'object',
          properties: {
            contentType: { type: 'string', enum: [...CONTENT_TYPES] },
            ownerRole: { type: 'string', enum: [...CONTENT_OWNER_ROLES] },
            isActive: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        response: { 200: schemaOf(EntryListResponse), ...failures },
      },
    },
    async (req) => {
      const q = req.query as { contentType?: ContentType; ownerRole?: ContentOwnerRole; isActive?: boolean };
      return { data: (await run(() => svc.listEntries(q))).map(entryDto), meta: meta(req) };
    },
  );

  app.get(
    '/entries/:key',
    {
      preValidation: requireContentPermission('read'),
      schema: {
        operationId: 'getContentEntry',
        summary: 'One entry with all of its versions (management view, includes template source)',
        tags,
        security: bearer,
        params: keyParams,
        response: { 200: schemaOf(EntryDetailResponse), ...failures },
      },
    },
    async (req) => {
      const d = await run(() => svc.getEntry((req.params as { key: string }).key));
      return { data: { entry: entryDto(d.entry), versions: d.versions.map(versionDto) }, meta: meta(req) };
    },
  );

  app.post(
    '/entries',
    {
      preValidation: [requireContentPermission('write'), strictBody(CreateEntryRequest)],
      schema: {
        operationId: 'createContentEntry',
        summary: 'Create a content entry (LEGAL-owned entries and LEGAL content type also need content-legal)',
        tags,
        security: bearer,
        body: schemaOf(CreateEntryRequest),
        response: { 201: schemaOf(EntryResponse), ...failures },
      },
    },
    async (req, reply) => {
      const body = parse(CreateEntryRequest, req.body);
      if (body.ownerRole === 'LEGAL' || body.contentType === 'LEGAL') assertContentLegal(req.principal);
      return reply.status(201).send({ data: entryDto(await run(() => svc.createEntry(body, actor(req)))), meta: meta(req) });
    },
  );

  app.post(
    '/entries/:key/activation',
    {
      preValidation: [requireContentPermission('write'), strictBody(SetActiveRequest)],
      schema: {
        operationId: 'setContentEntryActive',
        summary: 'Activate or deactivate an entry (an inactive entry resolves as unknown; LEGAL-owned entries also need content-legal)',
        tags,
        security: bearer,
        params: keyParams,
        body: schemaOf(SetActiveRequest),
        response: { 200: schemaOf(EntryResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(SetActiveRequest, req.body);
      const key = (req.params as { key: string }).key;
      // Taking a legal document offline is as consequential as publishing it: LEGAL-owned entries need content-legal (looked up from the entry).
      await assertEntryAccess(req, key);
      return { data: entryDto(await run(() => svc.setEntryActive(key, body.active, body.reason, actor(req)))), meta: meta(req) };
    },
  );

  app.post(
    '/entries/:key/versions',
    {
      preValidation: requireContentPermission('write'),
      schema: {
        operationId: 'createContentVersion',
        summary: 'Create a DRAFT version of an entry for a locale and scope (validated, with a dry render)',
        tags,
        security: bearer,
        params: keyParams,
        body: schemaOf(CreateVersionRequest),
        response: { 201: schemaOf(ContentVersionResponse), ...failures },
      },
    },
    async (req, reply) => {
      const body = parse(CreateVersionRequest, req.body);
      const key = (req.params as { key: string }).key;
      await assertEntryAccess(req, key);
      return reply.status(201).send({ data: versionDto(await run(() => svc.createVersion(key, body, actor(req)))), meta: meta(req) });
    },
  );

  // ------------------------------------------------------------------ version lifecycle
  const transition = (
    path: string,
    operationId: string,
    summary: string,
    permission: 'write' | 'approve',
    /** Whether a LEGAL-owned entry additionally needs content-legal (submit, approve, reject, publish; not cancel). */
    legalGated: boolean,
    fn: (id: string, who: string, comment?: string) => Promise<Awaited<ReturnType<ContentService['getVersion']>>>,
  ) =>
    app.post(
      `/versions/:id/${path}`,
      {
        preValidation: requireContentPermission(permission),
        schema: {
          operationId,
          summary,
          tags,
          security: bearer,
          params: idParams,
          body: schemaOf(ContentDecisionRequest),
          response: { 200: schemaOf(ContentVersionResponse), ...failures },
        },
      },
      async (req) => {
        const body = parse(ContentDecisionRequest, req.body ?? {});
        const id = (req.params as { id: string }).id;
        if (legalGated) await assertVersionAccess(req, id);
        return { data: versionDto(await run(() => fn(id, actor(req), body.comment))), meta: meta(req) };
      },
    );
  transition('submit', 'submitContentVersion', 'Submit a draft for review (policy NONE approves it)', 'write', true, (id, who) => svc.submit(id, who));
  transition('approve', 'approveContentVersion', 'Approve a version in review (a SECOND_APPROVER policy forbids the author)', 'approve', true, (id, who, c) =>
    svc.approve(id, who, c),
  );
  transition('reject', 'rejectContentVersion', 'Reject a version in review', 'approve', true, (id, who, c) => svc.reject(id, who, c));
  transition('cancel', 'cancelContentVersion', 'Cancel an unpublished version (author only)', 'write', false, (id, who) => svc.cancel(id, who));
  transition(
    'publish',
    'publishContentVersion',
    'Publish an approved version (immediate or scheduled); published text is immutable',
    'write',
    true,
    (id, who) => svc.publish(id, who),
  );

  // ------------------------------------------------------------------ locales
  app.get(
    '/locales',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'listContentLocales',
        summary: 'List locales: public callers get the active locales; callers with content-read (bearer token) get all registered locales',
        tags,
        security: [],
        response: { 200: schemaOf(LocaleListResponse), ...publicFailures },
      },
    },
    async (req) => ({
      data: (await run(() => svc.listLocales({ activeOnly: !privileged(req) }))).map(localeDto),
      meta: meta(req),
    }),
  );

  app.post(
    '/locales',
    {
      preValidation: [requireContentPermission('write'), strictBody(RegisterLocaleRequest)],
      schema: {
        operationId: 'registerContentLocale',
        summary: 'Register a locale (inactive unless active is true; authoring needs registration, serving needs activation)',
        tags,
        security: bearer,
        body: schemaOf(RegisterLocaleRequest),
        response: { 201: schemaOf(LocaleResponse), ...failures },
      },
    },
    async (req, reply) => {
      const body = parse(RegisterLocaleRequest, req.body);
      return reply.status(201).send({ data: localeDto(await run(() => svc.registerLocale(body, actor(req)))), meta: meta(req) });
    },
  );

  app.post(
    '/locales/:locale/activation',
    {
      preValidation: [requireContentPermission('write'), strictBody(SetActiveRequest)],
      schema: {
        operationId: 'setContentLocaleActive',
        summary: 'Activate or deactivate a locale (the platform default locale cannot be deactivated)',
        tags,
        security: bearer,
        params: { type: 'object', properties: { locale: { type: 'string', maxLength: 20 } }, required: ['locale'] },
        body: schemaOf(SetActiveRequest),
        response: { 200: schemaOf(LocaleResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(SetActiveRequest, req.body);
      return {
        data: localeDto(await run(() => svc.setLocaleActive((req.params as { locale: string }).locale, body.active, body.reason, actor(req)))),
        meta: meta(req),
      };
    },
  );

  // ------------------------------------------------------------------ resolution (public)
  app.post(
    '/resolve',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'resolveContent',
        summary:
          'Resolve and render one entry for a locale and context. Public: PUBLIC entries only (INTERNAL behaves as not found), no template, no `at`. ' +
          'A bearer token with content-read also sees INTERNAL entries and may use `at` and `includeTemplate`.',
        tags,
        security: [],
        body: schemaOf(ResolveContentRequest),
        response: { 200: schemaOf(ResolveContentResponse), ...publicFailures },
      },
    },
    async (req) => {
      const body = parse(ResolveContentRequest, req.body);
      rejectPrivilegedOptions(req, body);
      const resolved = await run(() =>
        svc.resolve(body.key, {
          locale: body.locale,
          context: body.context,
          at: body.at ? new Date(body.at) : undefined,
          includeInternal: privileged(req),
        }),
      );
      // Defense in depth: the service already hides INTERNAL entries when includeInternal is false; never rely on it alone.
      if (resolved.sensitivity === 'INTERNAL' && !privileged(req))
        throw new AppError('NOT_FOUND', 'CONTENT_ENTRY_NOT_FOUND', 'content entry not found', { key: body.key });
      const rendered = runSync(() => renderResolved(resolved, body.variables, { timeZone: body.timeZone }));
      return { data: renderedDto(rendered, { template: body.includeTemplate ? resolved.body : undefined, management: privileged(req) }), meta: meta(req) };
    },
  );

  app.post(
    '/resolve-many',
    {
      preValidation: optionalAuthenticated(),
      schema: {
        operationId: 'resolveManyContent',
        summary:
          'Resolve and render up to 100 entries in one batched read. Entries that are unknown, not visible to the caller or without effective content in the ' +
          'locale are omitted from `items` (compare with the requested keys). Same visibility rules as resolveContent.',
        tags,
        security: [],
        body: schemaOf(ResolveManyContentRequest),
        response: { 200: schemaOf(ResolveManyContentResponse), ...publicFailures },
      },
    },
    async (req) => {
      const body = parse(ResolveManyContentRequest, req.body);
      rejectPrivilegedOptions(req, body);
      const unknownVariableKeys = Object.keys(body.variables ?? {}).filter((k) => !body.keys.includes(k));
      if (unknownVariableKeys.length)
        throw new AppError('VALIDATION', 'CONTENT_VALIDATION_FAILED', 'variables were supplied for keys that are not being resolved', {
          reason: 'UNKNOWN_VARIABLES_KEY',
          keys: unknownVariableKeys,
        });
      const r = await run(() =>
        svc.resolveMany(body.keys, {
          locale: body.locale,
          context: body.context,
          at: body.at ? new Date(body.at) : undefined,
          includeInternal: privileged(req),
        }),
      );
      const visible = [...new Set(body.keys)].flatMap((key) => {
        const resolved = r.items.get(key);
        return resolved && (resolved.sensitivity !== 'INTERNAL' || privileged(req)) ? [{ key, resolved }] : [];
      });
      // Bound the work BEFORE rendering anything (all callers, privileged or not).
      const sourceChars = visible.reduce((n, v) => n + v.resolved.body.length, 0);
      if (sourceChars > MAX_RESOLVE_MANY_SOURCE_CHARS)
        throw new AppError('VALIDATION', 'CONTENT_RESPONSE_TOO_LARGE', 'The requested entries exceed the size budget of one call; request fewer keys', {
          reason: 'RESPONSE_TOO_LARGE',
          maxSourceCharacters: MAX_RESOLVE_MANY_SOURCE_CHARS,
        });
      const items = visible.map(({ key, resolved }) => {
        const rendered = runSync(() => renderResolved(resolved, body.variables?.[key], { timeZone: body.timeZone }));
        return renderedDto(rendered, { template: body.includeTemplate ? resolved.body : undefined, management: privileged(req) });
      });
      return { data: { evaluatedAt: r.at.toISOString(), items }, meta: meta(req) };
    },
  );

  // ------------------------------------------------------------------ snapshots
  app.post(
    '/snapshots',
    {
      preValidation: requireContentPermission('read'),
      schema: {
        operationId: 'createContentSnapshot',
        summary: 'Create an immutable snapshot of exactly which versions applied (authoritative read; not for routine UI labels)',
        tags,
        security: bearer,
        body: schemaOf(CreateContentSnapshotRequest),
        response: { 201: schemaOf(ContentSnapshotResponse), ...failures },
      },
    },
    async (req, reply) => {
      const body = parse(CreateContentSnapshotRequest, req.body);
      const snap = await run(() =>
        svc.createSnapshot(
          { keys: body.keys, locale: body.locale, context: body.context, purpose: body.purpose, at: body.at ? new Date(body.at) : undefined },
          actor(req),
        ),
      );
      return reply.status(201).send({ data: snapshotDto(snap), meta: meta(req) });
    },
  );

  app.get(
    '/snapshots/:id',
    {
      preValidation: requireContentPermission('read'),
      schema: {
        operationId: 'getContentSnapshot',
        summary: 'Read a snapshot (the exact versions used, with template source)',
        tags,
        security: bearer,
        params: idParams,
        response: { 200: schemaOf(ContentSnapshotResponse), ...failures },
      },
    },
    async (req) => ({
      data: snapshotDto(await run(() => svc.getSnapshot((req.params as { id: string }).id))),
      meta: meta(req),
    }),
  );
}
