// The ONE projection of the provider public profile (PRO-002), shared by the public read, the owner preview and the public photo gate.
//
// The profile row stores presentation only. Everything else is DERIVED on every call from the domain that owns it: the account and its role and registration (SQL, one statement), the
// fallback public name (identity names port), the badges (trust port), the Gig service names (one batch through the Gig service name port) and the market (market port). Nothing is
// cached and nothing is copied.
//
// CONSISTENCY (an accepted deviation from the spec's single snapshot, recorded as debt): the profile row, the eligibility facts, the market CODE, the photo facts and the Gig summaries
// come from ONE statement, i.e. one snapshot: a Gig retirement or a visibility change that commits while the read runs is either visible in all of it or in none of it. The trust badges,
// the fallback name, the service names and the market lookup (status, window) are SEPARATE reads through ports, made after that statement and outside any transaction (a port may open
// its own snapshot, which cannot nest). Their staleness is bounded by one request: e.g. an approval that expires between the statement and the trust read is simply not shown.
// STATEMENT BUDGET: the service issues exactly ONE statement for any number of Gigs (a hidden or unknown profile costs the same single statement; a malformed id none). What a port
// issues is the port adapter's own business; the number of port CALLS per read is pinned instead (trust once, services once and only with Gigs, names at most once, none when hidden).
//
// EXPOSURE: a profile that is not publicly readable (unknown id, PRIVATE, ineligible account, disabled role, incomplete registration, marketplace eligibility not granted or not wired,
// no public name) yields the SAME `null` for the public callers, so the answer cannot tell a private profile from an unknown one. The account id never leaves this module.
import {
  derivePublicName,
  type ProfileVisibility,
  type PublicGigSummaryDto,
  type PublicProviderProfileDto,
  type ProviderProfilePolicy,
  type TrustRequirementType,
} from '@bananagig/contracts';
import { sql, type Database } from '@bananagig/database';
import { log } from '@bananagig/observability';
import { ProfileError } from './profile-errors';
import type { AccountNamePort, GigServiceNamePort, MarketplaceEligibilityPort, TrustSummaryPort } from './profile-types';
import type { MarketPort } from './types';

type Row = Record<string, unknown>;

export interface ProjectionDeps {
  db: Database;
  names: AccountNamePort;
  markets: MarketPort;
  trust: TrustSummaryPort;
  services: GigServiceNamePort;
  eligibility?: MarketplaceEligibilityPort;
}

export type ProjectionLocator = { publicProfileId: string } | { accountId: string };

export interface ProjectionOptions {
  /** The owner's preview: PRIVATE profiles are built too and the marketplace eligibility flag is not consulted. The account, role and registration rules still apply. */
  ignoreVisibility?: boolean;
}

export type IneligibleReason = 'ACCOUNT_NOT_ACTIVE' | 'ROLE_NOT_ACTIVE' | 'REGISTRATION_NOT_COMPLETED' | 'MARKETPLACE_NOT_ELIGIBLE';

export type ProjectionResult =
  | { kind: 'ok'; profile: PublicProviderProfileDto; visibility: ProfileVisibility }
  /** No such profile. */
  | { kind: 'not-found' }
  /** The profile exists and is PRIVATE (only reported when visibility is not ignored). */
  | { kind: 'private' }
  | { kind: 'ineligible'; reason: IneligibleReason }
  /** Neither a display name nor a legal name to derive one from: not publishable and not readable. */
  | { kind: 'name-unavailable' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A port that fails is an outage of that dependency: the read fails closed (UNAVAILABLE), never with a guess, and the log line names the port only (no message, no values). */
export async function viaPort<T>(port: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ProfileError) throw e;
    log('error', 'provider profile dependency unavailable', { port, error: e instanceof Error ? e.name : 'unknown' });
    throw new ProfileError('UNAVAILABLE', 'the provider profile is unavailable', { reason: 'DEPENDENCY_UNAVAILABLE' });
  }
}

/** The badges of the account: the allowed types the trust port reports, intersected with the configured list again (defence in depth), in the configured order, once each. */
export async function loadBadges(trust: TrustSummaryPort, accountId: string, policy: ProviderProfilePolicy): Promise<TrustRequirementType[]> {
  const allowed = policy.publicBadgeTypes;
  if (allowed.length === 0) return [];
  const got = new Set(await viaPort('trust', () => trust.publicBadgeTypes(accountId, allowed)));
  return allowed.filter((t) => got.has(t));
}

/** The names of the account (first name and last initial are derived from them; the legal name is never returned from this module). */
export async function loadPublicName(names: AccountNamePort, accountId: string, displayName: string | null): Promise<string | null> {
  if (displayName !== null) return displayName;
  const n = await viaPort('names', () => names.names(accountId));
  return n ? derivePublicName(n.firstName, n.lastName) : null;
}

const GIGS_JSON = sql`COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'gigId', g.gig_id,
             'title', v.title,
             'shortPitch', v.short_pitch,
             'templateVersionId', v.gig_template_version_id,
             'amountMinor', v.price_amount_minor::text,
             'currency', v.price_currency::text,
             'durationMinutes', v.duration_minutes,
             'variantCount', (SELECT count(*) FROM provider.gig_version_variants x WHERE x.gig_version_id = v.gig_version_id),
             'addOnCount', (SELECT count(*) FROM provider.gig_version_add_ons x WHERE x.gig_version_id = v.gig_version_id),
             'photoCount', (SELECT count(*) FROM provider.gig_version_media x JOIN provider.media_assets xa ON xa.media_asset_id = x.media_asset_id
                             WHERE x.gig_version_id = v.gig_version_id AND xa.status = 'READY')
           ) ORDER BY v.published_at, g.gig_id)
      FROM provider.gigs g
      JOIN provider.gig_versions v ON v.gig_id = g.gig_id AND v.status = 'PUBLISHED'
     WHERE g.account_id = p.account_id AND g.status = 'ACTIVE'), '[]'::jsonb)`;

/** The profile with the facts that decide whether it can be shown, and (when asked) the Gig summaries: ONE statement. */
async function loadRow(db: Database, locator: ProjectionLocator, withGigs: boolean): Promise<Row | undefined> {
  const where = 'publicProfileId' in locator ? sql`p.public_profile_id = ${locator.publicProfileId}` : sql`p.account_id = ${locator.accountId}`;
  const gigs = withGigs ? GIGS_JSON : sql`'[]'::jsonb`;
  return (
    await sql<Row>`SELECT p.public_profile_id, p.account_id, p.display_name, p.bio, p.visibility_status, p.photo_asset_id,
             pa.mime_type AS photo_mime_type, pa.width AS photo_width, pa.height AS photo_height,
             ac.status AS account_status,
             EXISTS (SELECT 1 FROM identity.account_roles ar JOIN identity.roles ro ON ro.role_id = ar.role_id
                      WHERE ar.account_id = p.account_id AND ro.code = 'PROVIDER' AND ar.status = 'ACTIVE') AS provider_role_active,
             (r.provider_registration_id IS NOT NULL) AS registration_completed,
             m.code AS market_code,
             ${gigs} AS gigs
        FROM provider.public_profiles p
        JOIN identity.accounts ac ON ac.account_id = p.account_id
        LEFT JOIN provider.media_assets pa ON pa.media_asset_id = p.photo_asset_id AND pa.status = 'READY'
        LEFT JOIN provider.registrations r ON r.account_id = p.account_id AND r.status = 'COMPLETED'
        LEFT JOIN geography.markets m ON m.market_id = r.market_id
       WHERE ${where}`.execute(db.db)
  ).rows[0];
}

type Gate = { kind: 'ok'; row: Row; publicName: string } | Exclude<ProjectionResult, { kind: 'ok' }>;

/** Every rule that decides whether the profile may be shown, in a fixed order; the cheap, local rules first, the ports last. */
async function gate(
  deps: ProjectionDeps,
  policy: ProviderProfilePolicy,
  locator: ProjectionLocator,
  opts: ProjectionOptions,
  withGigs: boolean,
): Promise<Gate> {
  if ('publicProfileId' in locator && (typeof locator.publicProfileId !== 'string' || !UUID.test(locator.publicProfileId))) return { kind: 'not-found' };
  const row = await loadRow(deps.db, locator, withGigs);
  if (!row) return { kind: 'not-found' };
  if (!opts.ignoreVisibility && row.visibility_status !== 'PUBLIC') return { kind: 'private' };
  if (row.account_status !== 'ACTIVE') return { kind: 'ineligible', reason: 'ACCOUNT_NOT_ACTIVE' };
  if (row.provider_role_active !== true) return { kind: 'ineligible', reason: 'ROLE_NOT_ACTIVE' };
  if (row.registration_completed !== true) return { kind: 'ineligible', reason: 'REGISTRATION_NOT_COMPLETED' };
  const accountId = row.account_id as string;
  // PRO-003 / SEARCH gate: with the flag on, a positive answer is required; with no port wired the read fails closed. A preview never asks.
  if (!opts.ignoreVisibility && policy.publicRequiresMarketplaceEligibility) {
    const ok = deps.eligibility ? await viaPort('eligibility', () => deps.eligibility!.isEligible(accountId)) : false;
    if (!ok) return { kind: 'ineligible', reason: 'MARKETPLACE_NOT_ELIGIBLE' };
  }
  const publicName = await loadPublicName(deps.names, accountId, (row.display_name as string | null) ?? null);
  if (publicName === null) return { kind: 'name-unavailable' };
  return { kind: 'ok', row, publicName };
}

const toInt = (v: unknown): number => Number(v);

/**
 * The public projection of a profile. The preview calls this with `ignoreVisibility`; the public read without it. See the module comment for the consistency, exposure and statement
 * budget rules.
 */
export async function buildPublicProfile(
  deps: ProjectionDeps,
  policy: ProviderProfilePolicy,
  locator: ProjectionLocator,
  opts: ProjectionOptions = {},
): Promise<ProjectionResult> {
  const g = await gate(deps, policy, locator, opts, true);
  if (g.kind !== 'ok') return g;
  const { row } = g;
  const accountId = row.account_id as string;
  const rawGigs = (row.gigs as Row[] | null) ?? [];
  const marketCode = (row.market_code as string | null) ?? null;
  const [badges, serviceNames, market] = await Promise.all([
    loadBadges(deps.trust, accountId, policy),
    rawGigs.length === 0
      ? Promise.resolve(new Map<string, { serviceTypeCode: string; nameContentKey: string }>())
      : viaPort('services', () => deps.services.forTemplateVersions([...new Set(rawGigs.map((x) => x.templateVersionId as string))])),
    marketCode === null ? Promise.resolve(null) : viaPort('markets', () => deps.markets.lookup(marketCode)),
  ]);
  // a Gig whose service type the port cannot name is left out rather than shown with an invented label
  const gigs: PublicGigSummaryDto[] = [];
  for (const x of rawGigs) {
    const service = serviceNames.get(x.templateVersionId as string);
    if (!service) continue;
    const amount = x.amountMinor === null || x.amountMinor === undefined ? null : Number(x.amountMinor);
    gigs.push({
      gigId: x.gigId as string,
      title: x.title as string,
      shortPitch: (x.shortPitch as string | null) ?? null,
      serviceTypeCode: service.serviceTypeCode,
      serviceTypeNameContentKey: service.nameContentKey,
      price: amount === null || !Number.isSafeInteger(amount) || x.currency === null ? null : { amountMinor: amount, currency: String(x.currency).trim() },
      durationMinutes: x.durationMinutes === null || x.durationMinutes === undefined ? null : toInt(x.durationMinutes),
      variantCount: toInt(x.variantCount),
      addOnCount: toInt(x.addOnCount),
      photoCount: toInt(x.photoCount),
    });
  }
  const mime = row.photo_mime_type as string | null;
  const profile: PublicProviderProfileDto = {
    publicProfileId: row.public_profile_id as string,
    displayName: g.publicName,
    bio: (row.bio as string | null) ?? null,
    photo:
      mime === null ? null : { mimeType: mime as 'image/jpeg' | 'image/png' | 'image/webp', width: toInt(row.photo_width), height: toInt(row.photo_height) },
    badges: badges.map((type) => ({ type })),
    market: market !== null && market.status === 'ACTIVE' && market.inEffect ? { code: market.code } : null,
    gigs,
    ratings: { available: false },
    drops: { available: false },
  };
  return { kind: 'ok', profile, visibility: row.visibility_status as ProfileVisibility };
}

/**
 * The photo a request may read: the SAME gate as the public profile (one statement, no Gig summaries), so a photo is exactly as visible as the profile. Null for everything else, and
 * for a profile without a READY photo.
 */
export async function resolvePhotoAsset(
  deps: ProjectionDeps,
  policy: ProviderProfilePolicy,
  locator: ProjectionLocator,
  opts: ProjectionOptions = {},
): Promise<{ assetId: string } | null> {
  const g = await gate(deps, policy, locator, opts, false);
  if (g.kind !== 'ok') return null;
  const assetId = g.row.photo_asset_id as string | null;
  return assetId !== null && g.row.photo_mime_type !== null ? { assetId } : null;
}
