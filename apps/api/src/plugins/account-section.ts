// Server-side authorization of the shared account area (ACC-001, docs/engineering/ACCOUNT_AREA.md): a section that the ACTIVE role of the request does not have is
// answered exactly like a section that does not exist (404 ACCOUNT_SECTION_NOT_FOUND), whatever the front end shows. Hiding a menu entry is never the control.
//
// Policy (documented choice): 404, not 403. 403 would confirm that the section exists and belongs to another persona; the account area follows the "hidden means
// absent" rule of the marketplace APIs, and an unknown, planned, retired or not-enabled section are the same answer. 401 and the 403 of the account guard (admin
// context, suspended or closed account, role not held) still come first. For a route whose sections are STATIC (the reads and PUT /account/profile) the section is
// checked before the body, so a body is never evaluated for a section the role does not have; PATCH /account/profile derives the sections from the fields present, so its
// strict body shape (400) is checked first and the sections second (404).
//
// The guard reads the role's enabled sections ONCE per request (memoized on the request): a route that needs two sections costs one registry read.
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AccountAreaOperations } from '@bananagig/accounts';
import { sectionNotFound } from '@bananagig/accounts';
import type { AccountSectionDto } from '@bananagig/contracts';
import { toAppError } from '../modules/account/dto';

declare module 'fastify' {
  interface FastifyRequest {
    /** The enabled sections of the active role, read once per request by the section guards. */
    accountSections?: Promise<AccountSectionDto[]>;
  }
  interface FastifyInstance {
    /** The account area registry (ACC-001); present when the account area routes are registered. */
    accountArea: AccountAreaOperations;
  }
}

/** The enabled sections of the request's active role (one registry read per request). */
export function sectionsOfRequest(request: FastifyRequest): Promise<AccountSectionDto[]> {
  request.accountSections ??= request.server.accountArea.sectionsOf(request.account!.activeRole);
  return request.accountSections;
}

/** Throws the uniform 404 unless the request's active role has ALL (`mode: 'all'`) or AT LEAST ONE (`'any'`) of the sections. */
export async function assertAccountSections(request: FastifyRequest, codes: readonly string[], mode: 'all' | 'any' = 'all'): Promise<void> {
  const enabled = new Set((await sectionsOfRequest(request).catch(toAppError)).map((s) => s.code));
  const ok = mode === 'all' ? codes.every((c) => enabled.has(c)) : codes.some((c) => enabled.has(c));
  if (!ok) toAppError(sectionNotFound());
}

/** preValidation hook: list it AFTER requireAccount(). All the given sections are required. */
export const requireAccountSection =
  (...codes: string[]): preHandlerAsyncHookHandler =>
  async (request) =>
    assertAccountSections(request, codes, 'all');

/** preValidation hook: at least one of the given sections is required (a read model shared by several sections). */
export const requireAnyAccountSection =
  (...codes: string[]): preHandlerAsyncHookHandler =>
  async (request) =>
    assertAccountSections(request, codes, 'any');
