// Authentication and authorization primitives. Authorization is ALWAYS enforced here on the server;
// hiding UI is never security. This is infrastructure only: business permissions arrive with their features.
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { bearerFromHeader, TokenValidationError, type TokenVerifier, type Principal } from '@bananagig/identity';
import { recordAuthResult } from '@bananagig/observability';
import { AppError } from '../errors';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireAuthenticated(); never contains token material. */
    principal?: Principal;
  }
  interface FastifyInstance {
    authVerifier: TokenVerifier;
  }
}

export interface AuthPluginOptions {
  verifier: TokenVerifier;
  realm: string;
}

const challenge = (realm: string, error?: string): Record<string, string> => ({
  'www-authenticate': error ? `Bearer realm="${realm}", error="${error}"` : `Bearer realm="${realm}"`,
});

export const authPlugin = fp(async (app: FastifyInstance, opts: AuthPluginOptions): Promise<void> => {
  app.decorate('authVerifier', opts.verifier);
  app.decorate('authRealm', opts.realm);
  app.decorateRequest('principal', undefined);
});

/**
 * Requires a valid access token (signature, issuer, audience, expiry, type). Responses never include provider payloads:
 * 401 AUTHENTICATION for missing/invalid tokens, 503 DEPENDENCY when the key set cannot be fetched.
 */
export function requireAuthenticated(): preHandlerAsyncHookHandler {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    if (request.principal) return; // already authenticated by an earlier guard on this request
    const realm = (request.server as unknown as { authRealm: string }).authRealm;
    const header = request.headers.authorization;
    if (header === undefined) {
      recordAuthResult({ ok: false, category: 'missing' }, 0);
      throw new AppError('AUTHENTICATION', 'AUTHENTICATION_REQUIRED', 'Authentication is required', undefined, challenge(realm));
    }
    const token = bearerFromHeader(header);
    const started = performance.now();
    if (!token) {
      recordAuthResult({ ok: false, category: 'malformed' }, 0);
      throw new AppError('AUTHENTICATION', 'INVALID_TOKEN', 'The access token is invalid or expired', undefined, challenge(realm, 'invalid_token'));
    }
    try {
      request.principal = await request.server.authVerifier.verifyAccessToken(token);
      recordAuthResult({ ok: true }, performance.now() - started);
    } catch (err) {
      const category = err instanceof TokenValidationError ? err.category : 'jwks_unavailable';
      recordAuthResult({ ok: false, category }, performance.now() - started);
      if (category === 'jwks_unavailable') throw new AppError('DEPENDENCY', 'AUTH_PROVIDER_UNAVAILABLE', 'Authentication is temporarily unavailable');
      throw new AppError('AUTHENTICATION', 'INVALID_TOKEN', 'The access token is invalid or expired', undefined, challenge(realm, 'invalid_token'));
    }
  };
}

const forbidden = (): AppError => new AppError('AUTHORIZATION', 'INSUFFICIENT_PERMISSIONS', 'You do not have permission to perform this action');

/** Realm (identity) roles: ALL listed roles are required. Authenticates first. */
export function requireRealmRole(...roles: string[]): preHandlerAsyncHookHandler {
  const authenticate = requireAuthenticated();
  return async function guard(request, reply) {
    await authenticate.call(request.server, request, reply);
    const have = new Set(request.principal!.realmRoles);
    if (!roles.every((r) => have.has(r))) throw forbidden();
  };
}

/** Realm (identity) roles: ANY one of the listed roles is enough. Authenticates first. */
export function requireAnyRole(...roles: string[]): preHandlerAsyncHookHandler {
  const authenticate = requireAuthenticated();
  return async function guard(request, reply) {
    await authenticate.call(request.server, request, reply);
    const have = new Set(request.principal!.realmRoles);
    if (!roles.some((r) => have.has(r))) throw forbidden();
  };
}

/** A role defined on one specific client (for example `bananagig-admin` / `admin-console-access`). */
export function requireClientRole(clientId: string, role: string): preHandlerAsyncHookHandler {
  const authenticate = requireAuthenticated();
  return async function guard(request, reply) {
    await authenticate.call(request.server, request, reply);
    if (!request.principal!.clientRoles[clientId]?.includes(role)) throw forbidden();
  };
}

/** Requires the token to come from a given identity context (admin console vs normal web client). */
export function requireAuthContext(context: Principal['authContext']): preHandlerAsyncHookHandler {
  const authenticate = requireAuthenticated();
  return async function guard(request, reply) {
    await authenticate.call(request.server, request, reply);
    if (request.principal!.authContext !== context) throw forbidden();
  };
}

/**
 * TEMPORARY infrastructure permission strategy for the configuration registry (CFG-001): admin-console identity context plus one of
 * three client roles on `bananagig-admin`. These are placeholders that will be mapped to application permissions
 * (docs/engineering/CONFIGURATION.md). Business roles such as finance or trust administration are NOT modelled here.
 */
export const CONFIGURATION_PERMISSIONS = { read: 'configuration-read', write: 'configuration-write', approve: 'configuration-approve' } as const;
export function requireConfigurationPermission(action: keyof typeof CONFIGURATION_PERMISSIONS): preHandlerAsyncHookHandler {
  const authenticate = requireAuthenticated();
  return async function guard(request, reply) {
    await authenticate.call(request.server, request, reply);
    const p = request.principal!;
    if (p.authContext !== 'admin' || !p.clientRoles[p.clientId]?.includes(CONFIGURATION_PERMISSIONS[action])) throw forbidden();
  };
}

/**
 * TEMPORARY permission strategy for the content registry (CFG-002), the same model as the configuration registry (DEBT-0021): admin-console
 * identity context plus client roles on `bananagig-admin`. `content-legal` is an additional role required to author, review or publish
 * entries owned by LEGAL (legal documents); it never replaces the ordinary permission.
 */
export const CONTENT_PERMISSIONS = { read: 'content-read', write: 'content-write', approve: 'content-approve' } as const;
export const CONTENT_LEGAL_ROLE = 'content-legal';

/** True when the principal comes from the admin identity context and holds the client role (never true for web/other tokens). */
export const hasAdminClientRole = (principal: Principal | undefined, role: string): boolean =>
  !!principal && principal.authContext === 'admin' && !!principal.clientRoles[principal.clientId]?.includes(role);
export const hasContentPermission = (principal: Principal | undefined, action: keyof typeof CONTENT_PERMISSIONS): boolean =>
  hasAdminClientRole(principal, CONTENT_PERMISSIONS[action]);

export function requireContentPermission(action: keyof typeof CONTENT_PERMISSIONS): preHandlerAsyncHookHandler {
  const authenticate = requireAuthenticated();
  return async function guard(request, reply) {
    await authenticate.call(request.server, request, reply);
    if (!hasContentPermission(request.principal, action)) throw forbidden();
  };
}

/** Handler-level check for entries owned by LEGAL: the caller must also hold `content-legal` (AUTHORIZATION 403 otherwise). */
export function assertContentLegal(principal: Principal | undefined): void {
  if (!hasAdminClientRole(principal, CONTENT_LEGAL_ROLE)) throw forbidden();
}

/**
 * For PUBLIC routes that serve more to privileged callers: no Authorization header means anonymous (no principal); a header that is present
 * must be a valid token (401 otherwise, RFC 6750), so a broken client credential is never silently downgraded. Authorization of the
 * principal is decided by the route (for example hasContentPermission).
 */
export function optionalAuthenticated(): preHandlerAsyncHookHandler {
  const authenticate = requireAuthenticated();
  return async function maybeAuthenticate(request, reply) {
    if (request.headers.authorization === undefined) return;
    await authenticate.call(request.server, request, reply);
  };
}
