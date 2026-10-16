// Composition helpers for the account security layer (ID-004): the ports of SecurityService that need other packages, wired in the API composition root. They live
// here (not in the packages) so `accounts` never imports `configuration` or `identity`.
import {
  SECURITY_POLICY_PARAMETER_KEYS,
  SecurityProviderUnavailableError,
  parseSecurityPolicy,
  type IdentityProviderSession,
  type IdentityUserSecurity,
  type SecurityIdentityProvider,
  type SecurityPolicyProvider,
} from '@bananagig/accounts';
import type { ConfigurationService } from '@bananagig/configuration';
import { KeycloakAdminError, type KeycloakSecurityProvider } from '@bananagig/identity';

/** The security limits come from the configuration registry (CFG-001): CRITICAL parameters, read fresh, never defaulted in code (a missing value fails the operation closed). */
export function createSecurityPolicyProvider(configuration: Pick<ConfigurationService, 'resolveMany'>): SecurityPolicyProvider {
  return {
    async policy() {
      const { values } = await configuration.resolveMany([...SECURITY_POLICY_PARAMETER_KEYS]);
      return parseSecurityPolicy(Object.fromEntries([...values].map(([key, resolved]) => [key, resolved.value])));
    },
  };
}

/** Used when no admin client can be configured: every question is "unavailable" (the overview reports `mfa.available=false`, revocation stays application-side only). */
export function createUnavailableSecurityIdentityProvider(): SecurityIdentityProvider {
  const unavailable = (): never => {
    throw new SecurityProviderUnavailableError('NOT_CONFIGURED');
  };
  return {
    available: false,
    getUserSecurity: async () => unavailable(),
    listSessions: async () => unavailable(),
    endSession: async () => unavailable(),
    endAllSessions: async () => unavailable(),
    sendPasswordResetEmail: async () => unavailable(),
  };
}

/**
 * Adapts the Keycloak admin client to the port: every failure becomes SecurityProviderUnavailableError carrying only the client's CODE (never a response body, a token, a
 * URL or an id), so the service handles one error type. Anything that is not a KeycloakAdminError (a programming error) is reduced to UNEXPECTED, not passed through.
 */
export function createKeycloakSecurityIdentityProvider(admin: KeycloakSecurityProvider): SecurityIdentityProvider {
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw new SecurityProviderUnavailableError(err instanceof KeycloakAdminError ? err.code : 'UNEXPECTED');
    }
  };
  return {
    available: admin.available,
    getUserSecurity: (subject): Promise<IdentityUserSecurity> => guard(() => admin.getUserSecurity(subject)),
    listSessions: (subject): Promise<IdentityProviderSession[]> => guard(() => admin.listSessions(subject)),
    endSession: (sessionId) => guard(() => admin.endSession(sessionId)),
    endAllSessions: (subject) => guard(() => admin.endAllSessions(subject)),
    sendPasswordResetEmail: (subject, options) => guard(() => admin.sendPasswordResetEmail(subject, options)),
  };
}

/**
 * Waits for the security layer's detached work (the password-reset call to Keycloak runs after the response) before the database closes, but never longer than
 * `timeoutMs`: a stuck provider must not block the shutdown. Failures of the drain are ignored (the work is best effort by design).
 */
export async function drainWithTimeout(drain: (() => Promise<void>) | undefined, timeoutMs = 5000): Promise<void> {
  if (!drain) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      drain().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
