// Composition helpers for the provider registration (PRO-001): the ports of ProviderRegistrationService that need other packages, wired in the API composition root. They live
// here (not in the package) so `provider` never imports `accounts`, `consent`, `geography`, `catalog` or `configuration`.
import { AccountError, type AccountService, type ConsentOperations } from '@bananagig/accounts';
import type { CatalogService } from '@bananagig/catalog';
import type { ConfigurationService } from '@bananagig/configuration';
import { GeographyError, type GeographyService } from '@bananagig/geography';
import {
  ProviderError,
  parseProviderPolicy,
  providerPolicyKeys,
  type AccountPort,
  type CatalogPort,
  type ConsentPort,
  type MarketPort,
  type PolicyProvider,
} from '@bananagig/provider';

/** Account facts and the role request, over the identity domain. A closed account is reported with its status, not hidden. */
export function createAccountPort(accounts: Pick<AccountService, 'getAccountContext' | 'grantRole'>): AccountPort {
  return {
    async facts(accountId) {
      try {
        const c = await accounts.getAccountContext(accountId, { allowUnusable: true });
        return {
          accountId: c.accountId,
          status: c.status,
          memberships: c.memberships.map((m) => ({ code: m.code, status: m.status })),
          emailVerified: c.contacts.emailVerified,
          phoneVerified: c.contacts.phoneVerified,
        };
      } catch (err) {
        if (err instanceof AccountError && err.code === 'NOT_FOUND')
          throw new ProviderError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: 'ACCOUNT_NOT_FOUND' });
        if (err instanceof AccountError && err.code === 'UNAVAILABLE') throw new ProviderError('UNAVAILABLE', 'the account registry is unavailable');
        if (err instanceof AccountError && err.code === 'CONFLICT')
          throw new ProviderError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', {
            reason: 'CONCURRENT_UPDATE',
            retryable: true,
          });
        throw err;
      }
    },
    async grantRole(accountId, roleCode, opts) {
      try {
        return await accounts.grantRole(accountId, roleCode, { actor: opts.actor, reason: opts.reason, source: 'SIGNUP', pending: opts.pending });
      } catch (err) {
        // an INACTIVE membership cannot go back to PENDING; the service already refuses to ask, this is the net underneath
        if (err instanceof AccountError && err.code === 'INVALID_STATE')
          throw new ProviderError('ROLE_INACTIVE', 'the provider role is inactive', { reason: 'ROLE_INACTIVE' });
        if (err instanceof AccountError && err.code === 'UNAVAILABLE') throw new ProviderError('UNAVAILABLE', 'the account registry is unavailable');
        if (err instanceof AccountError && err.code === 'CONFLICT')
          throw new ProviderError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', {
            reason: 'CONCURRENT_UPDATE',
            retryable: true,
          });
        throw err;
      }
    },
  };
}

/** The consent state as ID-005 evaluates it. Any failure of the evaluation (policy, documents, database) is an outage: the registration fails closed. */
export function createConsentPort(consent: Pick<ConsentOperations, 'getRequirements'>): ConsentPort {
  return {
    async requirements(accountId, opts) {
      try {
        const r = await consent.getRequirements(accountId, opts.locale === undefined ? {} : { locale: opts.locale });
        const required = r.requirements.filter((x) => x.required);
        return {
          satisfied: r.satisfied,
          outstanding: r.outstanding,
          unavailable: required.filter((x) => x.status === 'DOCUMENT_UNAVAILABLE').map((x) => x.purposeCode),
          requiredCount: required.length,
        };
      } catch (err) {
        if (err instanceof AccountError && err.code === 'VALIDATION_FAILED')
          throw new ProviderError('VALIDATION_FAILED', 'the locale is not valid', { reason: 'INVALID_LOCALE', field: 'locale' });
        throw new ProviderError('UNAVAILABLE', 'the consent state is unavailable');
      }
    },
  };
}

/** Any market, any status, over the geography registry (management read): the registration policy decides which statuses accept providers. */
export function createMarketPort(geography: Pick<GeographyService, 'getMarket'>): MarketPort {
  return {
    async lookup(code) {
      try {
        const m = await geography.getMarket(code, { management: true });
        const now = Date.now();
        const from = Date.parse(m.effectiveFrom);
        const to = m.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(m.effectiveTo);
        return { code: m.code, status: m.status ?? 'INACTIVE', inEffect: from <= now && now < to };
      } catch (err) {
        if (err instanceof GeographyError && err.code === 'MARKET_NOT_FOUND') return null;
        throw new ProviderError('UNAVAILABLE', 'the market registry is unavailable');
      }
    },
  };
}

/** The service types a provider can choose in a market, over the catalogue. */
export function createCatalogPort(catalog: Pick<CatalogService, 'offeredServiceTypeCodes'>): CatalogPort {
  return {
    async offeredServiceTypes(marketCode) {
      try {
        return await catalog.offeredServiceTypeCodes(marketCode);
      } catch {
        throw new ProviderError('UNAVAILABLE', 'the catalogue is unavailable');
      }
    },
  };
}

/**
 * The registration policy comes from the configuration registry (CFG-001): five typed values at PLATFORM scope, read fresh through the registry's own cache, with NO code
 * default. A missing, malformed or unreadable value is an outage of the policy (UNAVAILABLE): the operation fails closed.
 */
export function createProviderPolicyProvider(configuration: Pick<ConfigurationService, 'resolveMany'>): PolicyProvider {
  return {
    async policy() {
      let values: Map<string, { value: unknown }>;
      try {
        values = (await configuration.resolveMany([...providerPolicyKeys()])).values;
      } catch {
        throw new ProviderError('UNAVAILABLE', 'the provider registration policy is not available', { reason: 'POLICY_UNREADABLE' });
      }
      return parseProviderPolicy(Object.fromEntries([...values].map(([key, resolved]) => [key, resolved.value])));
    },
  };
}
