// The application account of the caller (ID-001). Keycloak authenticates; this guard maps the VERIFIED identity (issuer + subject of a validated access
// token) to the BananaGig account and the application roles in PostgreSQL. It never reads an account id, subject or role from the client:
//  - the account comes from the verified token only (a request cannot choose another account);
//  - the active role is the one the request names in `x-active-role`, accepted ONLY when it is an ACTIVE membership of that account;
//  - Keycloak realm roles are used once, at account creation (the bootstrap policy, ADR-0025), and never again;
//  - the admin identity context has no application account (admin identities are separate logins): it is refused with 403.
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { ACTIVE_ROLE_HEADER } from '@bananagig/contracts';
import type {
  AccountAreaOperations,
  AccountContext,
  AccountService,
  ConsentOperations,
  EmailVerificationService,
  ObservedSession,
  PhoneVerificationService,
  SecurityOperations,
} from '@bananagig/accounts';
import { AppError } from '../errors';
import { toAppError } from '../modules/account/dto';
import { challenge, requireAuthenticated } from './auth';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireAccount(); the application account of the verified caller. Contains no token material and no Keycloak subject. */
    account?: AccountContext;
    /** Set by requireAccount() when the security layer is wired (ID-004): the application session of the verified token's `sid`. Holds ids only. */
    securitySession?: ObservedSession;
  }
  interface FastifyInstance {
    accounts: AccountService;
    /** The email contact and its verification (ID-002); present when the email routes are registered. */
    emailVerification: EmailVerificationService;
    /** The phone contact and its verification (ID-003); present when the phone routes are registered. */
    phoneVerification: PhoneVerificationService;
    /** The application sessions, devices, MFA status and password reset (ID-004); present when the security routes are registered. */
    security: SecurityOperations;
    /** Consent and legal-version history (ID-005); present when the consent routes are registered. */
    consent: ConsentOperations;
  }
}

export const accountPlugin = fp(
  async (
    app: FastifyInstance,
    opts: {
      accounts: AccountService;
      emailVerification?: EmailVerificationService;
      phoneVerification?: PhoneVerificationService;
      security?: SecurityOperations;
      consent?: ConsentOperations;
      accountArea?: AccountAreaOperations;
    },
  ): Promise<void> => {
    app.decorate('accounts', opts.accounts);
    if (opts.emailVerification) app.decorate('emailVerification', opts.emailVerification);
    if (opts.phoneVerification) app.decorate('phoneVerification', opts.phoneVerification);
    if (opts.security) app.decorate('security', opts.security);
    if (opts.consent) app.decorate('consent', opts.consent);
    if (opts.accountArea) app.decorate('accountArea', opts.accountArea);
    app.decorateRequest('account', undefined);
    app.decorateRequest('securitySession', undefined);
  },
);

export interface RequireAccountOptions {
  /** Load the caller's own core profile too. */
  includeProfile?: boolean;
  /** Resolve the active role from the x-active-role header (default true). The role switch endpoint turns it off: it validates the body instead. */
  honorActiveRoleHeader?: boolean;
}

/**
 * Authenticates (401), requires the normal web identity context (403 for admin and other contexts), maps the verified identity to its account,
 * creating it on the first request, and refuses SUSPENDED and CLOSED accounts (403). Sets `request.account`. List it first in `preValidation`.
 *
 * When the security layer is wired (ID-004) it also resolves the token's `sid` to an application session (created on first sight) and sets
 * `request.securitySession`: a token without `sid` is 401 INVALID_TOKEN, and a revoked session is 401 SESSION_REVOKED at once, although the access token itself
 * is still valid for up to its lifetime ("sign out everywhere" takes effect immediately). Without the security service nothing changes.
 */
export function requireAccount(options: RequireAccountOptions = {}): preHandlerAsyncHookHandler {
  const authenticate = requireAuthenticated();
  const honorHeader = options.honorActiveRoleHeader !== false;
  return async function account(request, reply) {
    await authenticate.call(request.server, request, reply);
    const p = request.principal!;
    if (p.authContext !== 'web') throw new AppError('AUTHORIZATION', 'ACCOUNT_CONTEXT_NOT_SUPPORTED', 'This identity context has no application account');
    const header = request.headers[ACTIVE_ROLE_HEADER];
    request.account = await request.server.accounts
      .ensureAccountForIdentity(
        { providerType: 'KEYCLOAK', issuer: p.issuer, subject: p.subject, identityRoles: p.realmRoles },
        { requestedRole: honorHeader ? (Array.isArray(header) ? header.join(',') : header) : undefined, includeProfile: options.includeProfile },
      )
      .catch(toAppError);
    const security = request.server.security as SecurityOperations | undefined;
    if (security) {
      const realm = (request.server as unknown as { authRealm: string }).authRealm;
      // the Keycloak session id comes ONLY from the verified token; it is never read from the client
      if (!p.sessionId)
        throw new AppError('AUTHENTICATION', 'INVALID_TOKEN', 'The access token is invalid or expired', undefined, challenge(realm, 'invalid_token'));
      request.securitySession = await security
        .observeSession({ accountId: request.account.accountId, keycloakSessionId: p.sessionId, authTime: p.authTime })
        .catch((err: unknown) => toAppError(err, realm));
    }
  };
}
