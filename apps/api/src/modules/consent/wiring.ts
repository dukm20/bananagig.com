// Composition helpers for the account consent layer (ID-005): the ports of ConsentService that need other packages, wired in the API composition root. They live here
// (not in the package) so `accounts` never imports `configuration` or `content`.
import { PURPOSE_CODE_PATTERN } from '@bananagig/contracts';
import { AccountError, consentPolicyKeys, parseConsentPolicy, type ConsentPolicyProvider } from '@bananagig/accounts';
import type { ConfigurationService } from '@bananagig/configuration';
import type { ContentService } from '@bananagig/content';

/**
 * The consent policy comes from the configuration registry (CFG-001): per purpose `consent.<purpose>.required_for` (JSON array of role codes) and
 * `consent.<purpose>.reacceptance` (ENUM), at PLATFORM scope, read fresh through the registry's own cache, with NO code default. A missing, malformed or unreadable value
 * is an outage of the policy (AccountError UNAVAILABLE, reason POLICY_INVALID or POLICY_UNREADABLE): the operation fails closed and the API answers 503.
 */
export function createConsentPolicyProvider(configuration: Pick<ConfigurationService, 'resolveMany'>): ConsentPolicyProvider {
  return {
    async policy(purposeCode) {
      // a malformed purpose code never reaches the registry (and never becomes part of a configuration key)
      if (!PURPOSE_CODE_PATTERN.test(purposeCode))
        throw new AccountError('UNAVAILABLE', 'the consent policy is not available', { reason: 'POLICY_INVALID', field: 'purpose' });
      const keys = consentPolicyKeys(purposeCode);
      let values: Map<string, { value: unknown }>;
      try {
        values = (await configuration.resolveMany([keys.requiredFor, keys.reacceptance])).values;
      } catch {
        // the registry could not answer (or does not know the key): never a default, never the cause in the error
        throw new AccountError('UNAVAILABLE', 'the consent policy is not available', { reason: 'POLICY_UNREADABLE', purposeCode });
      }
      // validated by the service package's strict parser (the single definition of a valid consent policy)
      return parseConsentPolicy(purposeCode, Object.fromEntries([...values].map(([key, resolved]) => [key, resolved.value])));
    },
  };
}

/**
 * The locale legal documents are evaluated in when neither the request nor the profile names one: the PLATFORM DEFAULT row of `content.locales` (read through the
 * content service, so the registry stays the only reader of its tables). Nothing is cached here (the read is one small indexed query); a missing default row or an
 * unreadable registry fails closed with UNAVAILABLE.
 */
export function createDefaultLocaleResolver(content: Pick<ContentService, 'listLocales'>): () => Promise<string> {
  return async () => {
    let locales;
    try {
      locales = await content.listLocales({ activeOnly: true });
    } catch {
      throw new AccountError('UNAVAILABLE', 'the default locale is not available', { reason: 'DEFAULT_LOCALE_UNREADABLE' });
    }
    const platformDefault = locales.find((l) => l.isPlatformDefault)?.locale;
    if (!platformDefault) throw new AccountError('UNAVAILABLE', 'the default locale is not available', { reason: 'DEFAULT_LOCALE_MISSING' });
    return platformDefault;
  };
}
