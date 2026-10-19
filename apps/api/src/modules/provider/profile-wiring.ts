// Composition helpers for the provider public profile (PRO-002): the ports of ProviderProfileService (and of the profile photo service) that need other packages, wired in the API
// composition root. They live here (not in the packages) so `provider` never imports `accounts`, `configuration`, `catalog` or `trust`. Every port answers FACTS (codes, names, booleans);
// nothing is copied into the profile and the public projection is derived on every read.
import type { AccountService } from '@bananagig/accounts';
import type { ConfigurationService } from '@bananagig/configuration';
import type { TrustRequirementType } from '@bananagig/contracts';
import type { PrivateObjectStore } from '@bananagig/platform';
import type { Database } from '@bananagig/database';
import { createGigPolicyProvider } from './gig-wiring';
import {
  ProfileError,
  ProfilePhotoService,
  UnavailablePrerequisites,
  parseProfilePolicy,
  profilePolicyKeys,
  profilePrerequisite,
  type AccountNamePort,
  type GigMediaScanner,
  type GigServiceNamePort,
  type PrerequisitePort,
  type ProfilePolicyProvider,
  type ProviderProfileService,
  type TrustSummaryPort,
} from '@bananagig/provider';

const unavailable = (reason: string): ProfileError => new ProfileError('UNAVAILABLE', 'the profile policy is not available', { reason });

/**
 * The profile policy comes from the configuration registry (CFG-001): seven typed values at PLATFORM scope, read fresh through the registry's own cache, with NO code default. A missing,
 * malformed or unreadable value is an outage of the policy (UNAVAILABLE): the operation fails closed (a public read answers 503, never a guess).
 */
export function createProfilePolicyProvider(configuration: Pick<ConfigurationService, 'resolveMany'>): ProfilePolicyProvider {
  return {
    async policy() {
      let values: Map<string, { value: unknown }>;
      try {
        values = (await configuration.resolveMany([...profilePolicyKeys()])).values;
      } catch {
        throw unavailable('POLICY_UNREADABLE');
      }
      return parseProfilePolicy(Object.fromEntries([...values].map(([key, resolved]) => [key, resolved.value])));
    },
  };
}

/**
 * The names of the account, read through the identity service. They feed ONLY the fallback `First L.`; the service never returns a full legal name. A missing profile row or an outage
 * of the account registry reads as "no name" / an outage of the profile, never as a guess.
 */
export function createAccountNamePort(accounts: Pick<AccountService, 'getAccountContext'>): AccountNamePort {
  return {
    async names(accountId) {
      try {
        const c = await accounts.getAccountContext(accountId, { allowUnusable: true, includeProfile: true });
        return c.profile === null ? null : { firstName: c.profile.firstName, lastName: c.profile.lastName };
      } catch (err) {
        // an unknown account has no name; anything else is an outage
        if (err !== null && typeof err === 'object' && (err as { code?: unknown }).code === 'NOT_FOUND') return null;
        throw new ProfileError('UNAVAILABLE', 'the account registry is unavailable');
      }
    },
  };
}

/** What the verification domain offers the profile (TRUST-001 `TrustService.publicBadgeTypes`): the requirement TYPE codes of the current approvals, nothing else. */
export interface PublicBadgeSource {
  publicBadgeTypes(accountId: string, allowedTypes: readonly TrustRequirementType[], now?: Date): Promise<readonly TrustRequirementType[]>;
}
/** Derived on every call (no cache): an approval that expires between two reads stops producing its badge. An outage of the verification domain is an outage of the profile read. */
export function createTrustSummaryPort(trust: PublicBadgeSource): TrustSummaryPort {
  return {
    async publicBadgeTypes(accountId, allowedTypes) {
      try {
        const types = await trust.publicBadgeTypes(accountId, allowedTypes);
        // narrow whatever came back to the allowed set, once each
        return [...new Set(types)].filter((t) => allowedTypes.includes(t));
      } catch {
        throw new ProfileError('UNAVAILABLE', 'the verification summary is unavailable');
      }
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface ServiceNameRow {
  gig_template_version_id: string;
  service_type_code: string;
  name_content_key: string;
}
/**
 * The service type name of Gig cards, from the EXACT template version each Gig was built from, in ONE statement however many Gigs there are (no N+1): template version -> template ->
 * service type -> its name content key. The wording is registry copy resolved by the reader; no text is read here. Read-only reference data of the catalogue (service type codes and
 * name keys never change once created), so no snapshot with the profile read is needed.
 */
export function createGigServiceNamePort(database: Pick<Database, 'query'>): GigServiceNamePort {
  return {
    async forTemplateVersions(ids) {
      const wanted = [...new Set(ids)].filter((i) => UUID.test(i));
      const out = new Map<string, { serviceTypeCode: string; nameContentKey: string }>();
      if (wanted.length === 0) return out;
      let rows: ServiceNameRow[];
      try {
        rows = await database.query<ServiceNameRow>(
          `SELECT v.gig_template_version_id, st.code AS service_type_code, st.name_content_key
             FROM catalog.gig_template_versions v
             JOIN catalog.gig_templates t ON t.gig_template_id = v.gig_template_id
             JOIN catalog.service_types st ON st.service_type_id = t.service_type_id
            WHERE v.gig_template_version_id = ANY($1::uuid[])`,
          [wanted],
        );
      } catch {
        throw new ProfileError('UNAVAILABLE', 'the service catalogue is unavailable');
      }
      for (const r of rows) out.set(r.gig_template_version_id, { serviceTypeCode: r.service_type_code, nameContentKey: r.name_content_key });
      return out;
    },
  };
}

/**
 * PRO-001's `profile` onboarding step, answered by the profile domain (PRO-002): NOT_STARTED (no profile), IN_PROGRESS (a profile that is not yet complete per the configured
 * requirements) or COMPLETE. PRO-001 owns no profile state and does not change its own lifecycle because of it; a failure of the profile domain reports the step NOT_AVAILABLE (it never
 * blocks or breaks the registration read). The other steps stay as they were.
 */
export function createProfilePrerequisites(
  profiles: Pick<ProviderProfileService, 'getReadinessFacts'>,
  rest: PrerequisitePort = UnavailablePrerequisites,
): PrerequisitePort {
  const step = profilePrerequisite(profiles);
  return {
    ...rest,
    async profile(accountId) {
      try {
        return await step(accountId);
      } catch {
        return { status: 'NOT_AVAILABLE' };
      }
    },
  };
}

/**
 * The profile photo service (PRO-002) on the same private bucket and scanner adapter as the Gig photos (keys under their own prefix), the media policy of the Gig photos (types, bounds,
 * TTLs, the clean-scan requirement) and the profile's own size cap. It records every change through the profile service's mutation primitive (locks, revision, audit, event) and reads the
 * public photo only through the target the profile service releases after every visibility and eligibility rule.
 */
export function createProfilePhotoService(d: {
  database: Database;
  store: PrivateObjectStore;
  scanner: GigMediaScanner;
  configuration: Pick<ConfigurationService, 'resolveMany'>;
  profiles: Pick<ProviderProfileService, 'readProfile' | 'mutateProfile' | 'getPublicPhotoTarget' | 'getOwnerPhotoTarget'>;
}): ProfilePhotoService {
  return new ProfilePhotoService({
    database: d.database,
    store: d.store,
    scanner: d.scanner,
    media: createGigPolicyProvider(d.configuration),
    policy: createProfilePolicyProvider(d.configuration),
    profiles: d.profiles,
    getPublicPhotoTarget: (id) => d.profiles.getPublicPhotoTarget(id),
    getOwnerPhotoTarget: (accountId) => d.profiles.getOwnerPhotoTarget(accountId),
  });
}
