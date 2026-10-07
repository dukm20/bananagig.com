// Process-wide wiring for the auth handlers (lazy: never at import time, so `next build` needs no environment).
import { Redis } from 'iovalkey';
import { createTokenVerifier, oidcEndpoints } from '@bananagig/identity';
import { log } from '@bananagig/observability';
import { serverApi, serverConfig } from '../server';
import { ValkeySessionStore } from './store';
import type { AuthConfig, AuthDeps } from './types';

export function buildAuthConfig(cfg: ReturnType<typeof serverConfig>): AuthConfig {
  const secure = cfg.identity.webPublicUrl.startsWith('https://');
  const e = oidcEndpoints({ publicUrl: cfg.identity.publicUrl, internalUrl: cfg.keycloakUrl, realm: cfg.identity.realm });
  return {
    clientId: cfg.identity.webClientId,
    webOrigin: new URL(cfg.identity.webPublicUrl).origin,
    webPublicUrl: cfg.identity.webPublicUrl,
    redirectUri: `${cfg.identity.webPublicUrl}/auth/callback`,
    postLogoutRedirectUri: `${cfg.identity.webPublicUrl}/`,
    endpoints: { authorization: e.authorization, endSession: e.endSession, token: e.token },
    cookieSecure: secure,
    // __Host- requires Secure, Path=/ and no Domain: applied to the long-lived session cookie whenever we are on https.
    sessionCookie: secure ? '__Host-bg_session' : 'bg_session',
    txCookie: 'bg_auth_tx',
  };
}

let cached: AuthDeps | undefined;
export function authDeps(): AuthDeps {
  if (cached) return cached;
  const cfg = serverConfig();
  const redis = new Redis(cfg.valkeyUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
  redis.on('error', () => undefined);
  const e = oidcEndpoints({ publicUrl: cfg.identity.publicUrl, internalUrl: cfg.keycloakUrl, realm: cfg.identity.realm });
  cached = {
    cfg: buildAuthConfig(cfg),
    store: new ValkeySessionStore(redis, cfg.env),
    verifier: createTokenVerifier({ issuer: e.issuer, apiAudience: cfg.identity.apiAudience, jwks: { url: e.jwks } }),
    api: (accessToken) => serverApi(accessToken),
    log: (level, message, attrs) => log(level, message, attrs),
  };
  return cached;
}
