// The shared account area API (ACC-001, docs/engineering/ACCOUNT_AREA.md), registered under /api/v1 by accountRoutes: ONE framework for every persona.
//
// The navigation is data (the registry identity.account_sections / account_section_roles) selected by the ACTIVE role of the request, which the account guard has
// already validated against PostgreSQL: a client never names a role or a section set. Every section-owned read model COMPOSES the domain that owns the state (the contacts
// of ID-002/ID-003, the security overview of ID-004, the consent requirements of ID-005): nothing is copied, nothing new is stored. Each is guarded by
// requireAccountSection, so a section the role does not have is a 404 here even if a client calls the URL directly.
//
// Every route acts on the account of the VERIFIED token; none accepts an account id, a subject, a role or a section list. Bodies are validated RAW and strictly. Every
// response, errors included, is `Cache-Control: no-store` (the responses concern one person). The area audits and announces nothing itself: only the profile mutation is audited (by the service); the security summary goes through the ID-004 overview, which writes what it always writes when it observes a second-factor or password transition.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ACCOUNT_SECTIONS,
  AccountNavigationResponse,
  AccountProfileViewResponse,
  AccountRolesSectionResponse,
  ContactVerificationSectionResponse,
  PROFILE_FIELD_SECTIONS,
  PatchProfileRequest,
  PrivacySummaryResponse,
  ProfilePatchedResponse,
  SecuritySummaryResponse,
  publicDisplayName,
  toAccountProfileView,
} from '@bananagig/contracts';
import { requireAccount } from '../../plugins/account';
import { assertAccountSections, requireAccountSection, requireAnyAccountSection } from '../../plugins/account-section';
import { parseBody as parse, strictBody } from '../../plugins/strict-body';
import { authErrorResponses, errorResponses, errorSchema, schemaOf } from '../../schema';
import { toAppError } from './dto';

const bearer = [{ bearerAuth: [] }];
/** 401 missing or invalid token (or revoked session), 403 admin context / suspended or closed account / role not held, 404 section not available to the active role, 409, 503. */
const failures = { ...authErrorResponses, 400: errorResponses[400], 403: errorSchema, 404: errorResponses[404], 409: errorSchema };
const meta = (req: FastifyRequest) => ({ correlationId: req.correlationId });
const realmOf = (req: FastifyRequest): string => (req.server as unknown as { authRealm: string }).authRealm;
const run = <T>(req: FastifyRequest, fn: () => Promise<T>): Promise<T> => fn().catch((err: unknown) => toAppError(err, realmOf(req)));
const S = ACCOUNT_SECTIONS;

export interface AccountAreaRouteOptions {
  /** The security summary needs the security layer (ID-004); the route is registered only when it is wired. */
  securitySummary: boolean;
  /** The privacy summary needs the consent layer (ID-005); the route is registered only when it is wired. */
  privacySummary: boolean;
}

export async function accountAreaRoutes(app: FastifyInstance, opts: AccountAreaRouteOptions): Promise<void> {
  const tags = ['account-area'];

  app.get(
    '/account/navigation',
    {
      preValidation: requireAccount(),
      schema: {
        operationId: 'getAccountNavigation',
        summary:
          'What the shared account area needs to draw itself, in one read: the role this request acts as, the ACTIVE roles of the account (the role switcher), the ENABLED sections of that role in menu order (code, page, managed label and description keys) and whether the email and phone are verified. The section set belongs to the active role (x-active-role, validated against PostgreSQL), so switching role changes it without a new login. One registry read regardless of the number of sections',
        description:
          'Sections come from the registry (data), never from code. An account with no usable active role gets an empty section list. No contact detail, session id or legal-history detail is in this payload.',
        tags,
        security: bearer,
        querystring: { type: 'object', properties: {}, additionalProperties: false },
        response: { 200: schemaOf(AccountNavigationResponse), ...failures },
      },
    },
    async (req) => {
      const account = req.account!;
      const data = await run(req, () =>
        req.server.accountArea.navigation({ activeRole: account.activeRole, roles: account.roles, contacts: account.contacts }),
      );
      return { data, meta: meta(req) };
    },
  );

  app.get(
    '/account/profile',
    {
      preValidation: [requireAccount({ includeProfile: true }), requireAnyAccountSection(S.profile, S.languageRegion)],
      schema: {
        operationId: 'getAccountProfile',
        summary:
          "The caller's own core profile as the account area shows it: first and last name, the name other people see (first name and last initial, derived on read), the preferred locale and the time zone override. null before the person gave a name. Owner data only",
        tags,
        security: bearer,
        querystring: { type: 'object', properties: {}, additionalProperties: false },
        response: { 200: schemaOf(AccountProfileViewResponse), ...failures },
      },
    },
    async (req) => ({ data: toAccountProfileView(req.account!.profile ?? null), meta: meta(req) }),
  );

  app.patch(
    '/account/profile',
    {
      preValidation: [requireAccount(), strictBody(PatchProfileRequest)],
      schema: {
        operationId: 'patchAccountProfile',
        summary:
          'Change the PRESENT profile fields only: absent = unchanged, null clears the optional preferred locale and time zone. The names belong to the Profile section and the locale and time zone to the Language and region section: a field whose section the active role does not have is a 404. A profile that does not exist yet needs both names. Locale and time zone must be ACTIVE registry values. Idempotent: unchanged values write nothing',
        tags,
        security: bearer,
        body: schemaOf(PatchProfileRequest),
        response: { 200: schemaOf(ProfilePatchedResponse), ...failures },
      },
    },
    async (req) => {
      const body = parse(PatchProfileRequest, req.body);
      const fields = Object.keys(body) as (keyof typeof PROFILE_FIELD_SECTIONS)[];
      await assertAccountSections(req, [...new Set(fields.map((f) => PROFILE_FIELD_SECTIONS[f]))], 'all');
      const accountId = req.account!.accountId;
      const result = await run(req, () => req.server.accounts.patchProfile(accountId, body, { actor: `account:${accountId}` }));
      return {
        data: { changed: result.changed, profile: { ...result.profile, displayName: publicDisplayName(result.profile.firstName, result.profile.lastName) } },
        meta: meta(req),
      };
    },
  );

  app.get(
    '/account/contact-verification',
    {
      preValidation: [requireAccount(), requireAccountSection(S.contactVerification)],
      schema: {
        operationId: 'getAccountContactVerification',
        summary:
          'The Contact details section: the email and phone verification states (status NONE, PENDING or VERIFIED, addresses and numbers MASKED) and the derived summary. The same values as GET /account/me, composed from the contact domains (ID-002, ID-003); nothing is stored or copied here',
        tags,
        security: bearer,
        querystring: { type: 'object', properties: {}, additionalProperties: false },
        response: { 200: schemaOf(ContactVerificationSectionResponse), ...failures },
      },
    },
    async (req) => {
      const a = req.account!;
      return { data: { email: a.email, phone: a.phone, contacts: a.contacts }, meta: meta(req) };
    },
  );

  app.get(
    '/account/roles',
    {
      preValidation: [requireAccount(), requireAccountSection(S.roles)],
      schema: {
        operationId: 'getAccountRolesSection',
        summary:
          'The Roles section: the ACTIVE roles the account holds, the role this request acts as, the preferred role and the roles the caller can switch to. Switching is POST /account/active-role (validation only, no new login); there is no endpoint that grants a role',
        tags,
        security: bearer,
        querystring: { type: 'object', properties: {}, additionalProperties: false },
        response: { 200: schemaOf(AccountRolesSectionResponse), ...failures },
      },
    },
    async (req) => {
      const a = req.account!;
      return {
        data: {
          roles: a.roles.map((r) => ({ code: r.code, nameContentKey: r.nameContentKey })),
          activeRole: a.activeRole,
          primaryRole: a.primaryRole,
          switchableTo: a.roles.map((r) => r.code).filter((code) => code !== a.activeRole),
        },
        meta: meta(req),
      };
    },
  );

  if (opts.securitySummary)
    app.get(
      '/account/security-summary',
      {
        preValidation: [requireAccount(), requireAccountSection(S.security)],
        schema: {
          operationId: 'getAccountSecuritySummary',
          summary:
            'The Security section summary: whether two-step verification is set up (asked of the identity provider; `mfa.available` is false when it cannot be asked), the number of registered live sessions and whether this browser is trusted. The security centre (GET /account/security and the /account/security/* operations of ID-004) stays the place to act; nothing is duplicated',
          tags,
          security: bearer,
          querystring: { type: 'object', properties: {}, additionalProperties: false },
          response: { 200: schemaOf(SecuritySummaryResponse), ...failures },
        },
      },
      async (req) => {
        const p = req.principal!;
        const current = { accountId: req.account!.accountId, keycloakSessionId: p.sessionId! };
        return { data: await run(req, () => req.server.security.getSummary(current, { authTime: p.authTime, acr: p.acr })), meta: meta(req) };
      },
    );

  if (opts.privacySummary)
    app.get(
      '/account/privacy',
      {
        preValidation: [requireAccount(), requireAccountSection(S.privacyData)],
        schema: {
          operationId: 'getAccountPrivacySummary',
          summary:
            'The Privacy and data section summary: whether every REQUIRED agreement is accepted and how many are not (counts only, composed from the consent layer of ID-005; the consents themselves and their history stay in /account/consents), and the data-download contract (`dataDownload.available` is false until the export exists)',
          tags,
          security: bearer,
          querystring: { type: 'object', properties: {}, additionalProperties: false },
          response: { 200: schemaOf(PrivacySummaryResponse), ...failures },
        },
      },
      async (req) => {
        const r = await run(req, () => req.server.consent.getRequirements(req.account!.accountId, {}));
        return {
          data: { consents: { locale: r.locale, satisfied: r.satisfied, outstandingCount: r.outstanding.length }, dataDownload: { available: false } },
          meta: meta(req),
        };
      },
    );
}
