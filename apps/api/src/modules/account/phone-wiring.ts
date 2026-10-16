// Composition helpers for the phone verification (ID-003): the ports of PhoneVerificationService and RenderingSmsSender that need other packages, wired in the API
// composition root. They live here (not in the packages) so `accounts` and `platform` never import `configuration`, `content` or `geography`.
import {
  PHONE_POLICY_KEYS,
  PHONE_POLICY_PARAMETER_KEYS,
  parsePhoneVerificationPolicy,
  type PhoneCountryDirectory,
  type PhonePolicyProvider,
} from '@bananagig/accounts';
import type { ConfigurationService } from '@bananagig/configuration';
import { ContentError, renderResolved, type ContentService } from '@bananagig/content';
import type { GeographyService } from '@bananagig/geography';
import type { SmsRenderer } from '@bananagig/platform';

/**
 * The phone verification limits and the country/market policy come from the configuration registry (CFG-001): CRITICAL parameters, read fresh, never defaulted in code.
 * Accounts per number and the blocked line types resolve with the number's COUNTRY (a country override beats the platform value); a market override applies once
 * accounts have a market (DEBT-0063).
 */
export function createPhonePolicyProvider(configuration: Pick<ConfigurationService, 'resolveMany'>): PhonePolicyProvider {
  return {
    async policy(country) {
      const { values } = await configuration.resolveMany([...PHONE_POLICY_PARAMETER_KEYS], country ? { country } : {});
      return parsePhoneVerificationPolicy(Object.fromEntries([...values].map(([key, resolved]) => [key, resolved.value])));
    },
  };
}
void PHONE_POLICY_KEYS;

/** Renders `sms.verification.phone.body` from the managed content registry (CFG-002); each entry receives only the variables it defines (the registry is strict). */
export function createContentSmsRenderer(content: Pick<ContentService, 'resolveMany' | 'listLocales'>): SmsRenderer {
  return {
    async render(templateKey, variables, locale) {
      const requested = locale ?? (await content.listLocales({ activeOnly: true })).find((l) => l.isPlatformDefault)?.locale ?? 'en-US';
      const key = `${templateKey}.body`;
      const { items } = await content.resolveMany([key], { locale: requested });
      const resolved = items.get(key);
      if (!resolved) throw new ContentError('NO_CONTENT', 'an SMS template entry has no effective content', { key });
      const defined = new Set(resolved.variables.map((v) => v.name));
      const rendered = renderResolved(resolved, Object.fromEntries(Object.entries(variables).filter(([name]) => defined.has(name))));
      return { body: rendered.value, templateVersion: `${rendered.version}` };
    },
  };
}

/**
 * Countries that accept phone numbers come from geography: ONLY an ACTIVE country is accepted (public visibility), with its configured dialing code. The default
 * country of a national-format number is the only ACTIVE country (launch: the United States); with several active countries the caller must name one.
 */
export function createPhoneCountryDirectory(geography: Pick<GeographyService, 'getCountry' | 'getActiveCountries'>): PhoneCountryDirectory {
  return {
    async active(isoAlpha2) {
      try {
        // the public view answers for ACTIVE countries only (a PLANNED or INACTIVE one is COUNTRY_NOT_FOUND) and carries no status field, so success IS ACTIVE
        const country = await geography.getCountry(isoAlpha2, { management: false });
        return { dialingCode: country.dialingCode };
      } catch (err) {
        if (err instanceof Error && 'code' in err && (err as { code?: string }).code === 'COUNTRY_NOT_FOUND') return null;
        throw err;
      }
    },
    async defaultCountry() {
      const active = await geography.getActiveCountries();
      return active.length === 1 ? active[0]!.code : undefined;
    },
  };
}
