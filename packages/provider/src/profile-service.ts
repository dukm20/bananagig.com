// The provider public profile service (PRO-002). The profile is a PRESENTATION aggregate: `provider.public_profiles` stores the display name, the bio, one photo reference and the
// visibility, nothing else. Everything a customer sees beyond that is derived at read time by `buildPublicProfile` (profile-projection.ts) from the domain that owns it.
//
// Ownership: every owner method scopes by the authenticated ACCOUNT (a profile of another account does not exist for the caller); the public methods take the opaque public id and answer
// the same `null` for everything that is not publicly readable. PUBLIC visibility is a preference, not Go-Live: a public read additionally needs an ACTIVE account, an ACTIVE PROVIDER role
// and a COMPLETED registration at read time and, once the configuration flag is on, a positive answer from the marketplace eligibility port (fail closed without one).
//
// Transactions and locks: every mutation locks the ACCOUNT row first, then the profile row, and asset rows only afterwards (the photo service runs inside the same primitive). A step that needs the policy or a port (validation, PUBLISHING) reads it BEFORE
// the transaction (a port may open its own snapshot, which cannot nest) and fails closed; hiding, removing a photo and every other mutation read NOTHING from other services, and the
// answer after the commit degrades instead of failing. Audit rows hold identifiers, field NAMES, revisions and the
// visibility, never the provider's text, never a photo id, key or hash; events hold identifiers and field names only. Both are written in the same transaction as the change; nothing is
// written for a no-op or a read.
import { randomUUID } from 'node:crypto';
import {
  PROFILE_AUDIT_ACTIONS,
  PROFILE_EVENTS,
  PROFILE_FIELD_NAMES,
  PROFILE_PHOTO_MIME_TYPES,
  SetProfileVisibilityRequest,
  UpdateProviderProfileRequest,
  derivePublicName,
  type GigMediaMimeType,
  type OwnerProfileStateDto,
  type PreviewProviderProfileDto,
  type ProfileAuditAction,
  type ProfileFieldName,
  type ProfileReadinessDto,
  type ProfileUpdatedPayload,
  type ProfileVisibility,
  type ProfileVisibilityChangedPayload,
  type ProviderProfilePolicy,
  type PublicProviderProfileDto,
} from '@bananagig/contracts';
import { sql, type Database, type Kysely, type DatabaseSchema, type Trx } from '@bananagig/database';
import { getCorrelationId, log } from '@bananagig/observability';
import { insertOutboxEvent } from '@bananagig/platform';
import type { z } from 'zod';
import { PROVIDER_ROLE_CODE } from './evaluator';
import { ProviderError, isDatabaseOutage } from './errors';
import type { GigPolicyProvider } from './gig-types';
import { ProfileError } from './profile-errors';
import { buildPublicProfile, loadBadges, resolvePhotoAsset, viaPort, type ProjectionDeps } from './profile-projection';
import type {
  AccountNamePort,
  GigServiceNamePort,
  MarketplaceEligibilityPort,
  ProfileMutationContext,
  ProfileMutationOutcome,
  ProfileMutator,
  ProfilePhotoTarget,
  ProfilePolicyProvider,
  ProfileReadContext,
  TrustSummaryPort,
} from './profile-types';
import { publishingIssues, validateProfileUpdate } from './profile-validate';
import { guardRuleOf } from './service';
import type { AccountFacts, AccountPort, MarketPort, PrerequisitePort, PrerequisiteState } from './types';

// the policy parser and the projection are part of the package surface (the API composition root wires the configuration-backed policy provider with them)
export { parseProfilePolicy, profilePolicyKeys } from './profile-policy';
export { buildPublicProfile } from './profile-projection';
export type { ProjectionDeps, ProjectionLocator, ProjectionOptions, ProjectionResult } from './profile-projection';
export { checkProfileText, publishingIssues, validateProfileUpdate } from './profile-validate';

type Executor = Kysely<DatabaseSchema> | Trx;
type Row = Record<string, unknown>;

export interface ProviderProfileDeps {
  db: Database;
  accounts: AccountPort;
  names: AccountNamePort;
  markets: MarketPort;
  trust: TrustSummaryPort;
  services: GigServiceNamePort;
  policy: ProfilePolicyProvider;
  /** Optional: consulted only when the policy flag `public_requires_marketplace_eligibility` is true (absent + true = the public read fails closed). */
  eligibility?: MarketplaceEligibilityPort;
  now?: () => Date;
  /**
   * Optional (compatible extension of the lead's skeleton): the Gig media policy, whose allowed content types the owner's limits report. Without it the limits list every type the
   * platform can verify (PROFILE_PHOTO_MIME_TYPES).
   */
  mediaPolicy?: Pick<GigPolicyProvider, 'media'>;
}

// ---------------------------------------------------------------- errors
const concurrent = () =>
  new ProfileError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', { reason: 'CONCURRENT_UPDATE', retryable: true });
const notFound = () => new ProfileError('PROFILE_NOT_FOUND', 'the profile was not found', {});
const stale = () => new ProfileError('STALE_PROFILE', 'the profile changed since it was read: read it again', { reason: 'STALE_PROFILE' });

/**
 * The account port belongs to the registration domain and throws ProviderError (ACCOUNT_NOT_ACTIVE, UNAVAILABLE, a retryable CONFLICT). The profile service speaks ProfileError only,
 * so the translation lives here. Any other error is rethrown unchanged.
 */
function translateAccountError(err: unknown): never {
  if (err instanceof ProviderError) {
    if (err.code === 'UNAVAILABLE') throw new ProfileError('UNAVAILABLE', 'the provider profile is unavailable');
    if (err.code === 'CONFLICT') throw concurrent();
    if (err.code === 'ACCOUNT_NOT_ACTIVE') throw new ProfileError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: 'ACCOUNT_NOT_ACTIVE' });
  }
  throw err;
}

/**
 * Translates database constraint, guard and concurrency failures into typed errors with fixed messages (no driver text, no SQL, no table names). Guard failures are classified by
 * `error.detail` (`provider_rule:<KEY>`), concurrency by SQLSTATE.
 */
export function mapProfileDbError(err: unknown): never {
  if (err instanceof ProviderError) translateAccountError(err);
  if (err instanceof ProfileError || err === null || typeof err !== 'object') throw err;
  const e = err as { code?: string; detail?: string };
  if (e.code === '40P01' || e.code === '40001' || e.code === '55P03' || e.code === '23505') throw concurrent();
  if (e.code === '22021' || e.code === '22P05')
    throw new ProfileError('VALIDATION_FAILED', 'the request contains a character that is not allowed', { reason: 'FORBIDDEN_CHARACTER' });
  if (e.code === '23000') {
    const rule = guardRuleOf(e.detail);
    switch (rule) {
      case 'ACCOUNT_NOT_ACTIVE':
        throw new ProfileError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: rule });
      case 'PROVIDER_NOT_ELIGIBLE':
      case 'REGISTRATION_NOT_COMPLETED':
        throw new ProfileError('PROVIDER_NOT_ELIGIBLE', 'the account is not an eligible provider', { reason: 'REGISTRATION_NOT_COMPLETED' });
      // an asset of another account is indistinguishable from one that does not exist
      case 'ASSET_OWNER':
        throw new ProfileError('MEDIA_NOT_FOUND', 'the photo was not found', {});
      case 'ASSET_NOT_USABLE':
        throw new ProfileError('MEDIA_REFUSED', 'the photo cannot be used', { reason: rule });
      default:
        throw new ProfileError('CONFLICT', 'the operation violates a profile integrity rule', rule ? { reason: rule } : {});
    }
  }
  if (e.code === '23514' || e.code === '23502') throw new ProfileError('VALIDATION_FAILED', 'the request is not valid', { reason: 'INVALID_VALUE' });
  if (e.code === '23503') throw new ProfileError('VALIDATION_FAILED', 'a referenced record does not exist', { reason: 'REFERENCE_NOT_FOUND' });
  if (isDatabaseOutage(err)) {
    log('error', 'provider profile database unavailable', { error: err instanceof Error ? err.name : 'unknown' });
    throw new ProfileError('UNAVAILABLE', 'the provider profile is unavailable');
  }
  throw err;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw new ProfileError('VALIDATION_FAILED', 'the request is not valid', {
    field: typeof first?.path[0] === 'string' ? first.path[0] : undefined,
    reason: 'INVALID_REQUEST',
  });
}

const actorOf = (accountId: string): string => `account:${accountId}`;
const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

// ---------------------------------------------------------------- the stored profile
interface ProfileRow {
  publicProfileId: string;
  displayName: string | null;
  bio: string | null;
  photoAssetId: string | null;
  pendingPhotoAssetId: string | null;
  visibility: ProfileVisibility;
  publishedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  /** The facts of the READY photo (null when there is none). */
  photo: { mimeType: GigMediaMimeType; width: number; height: number } | null;
}
function toProfileRow(r: Row): ProfileRow {
  return {
    publicProfileId: r.public_profile_id as string,
    displayName: (r.display_name as string | null) ?? null,
    bio: (r.bio as string | null) ?? null,
    photoAssetId: (r.photo_asset_id as string | null) ?? null,
    pendingPhotoAssetId: (r.pending_photo_asset_id as string | null) ?? null,
    visibility: r.visibility_status as ProfileVisibility,
    publishedAt: (r.published_at as Date | null) ?? null,
    revision: Number(r.revision),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    photo:
      r.photo_mime_type === null || r.photo_mime_type === undefined
        ? null
        : { mimeType: r.photo_mime_type as GigMediaMimeType, width: Number(r.photo_width), height: Number(r.photo_height) },
  };
}

/** What the owner's state and the readiness need besides the stored row; read BEFORE a transaction and reused for the answer after it (none of it is changed by a profile mutation). */
interface StatePre {
  /** Null only in a DEGRADED post-commit answer (the policy could not be read after a committed change); never null for a read. */
  policy: ProviderProfilePolicy | null;
  /** The number of public badges now derivable. */
  badgeCount: number;
  /** The first name and last initial of the account (null when the account has no name). */
  fallbackName: string | null;
  mimeTypes: readonly GigMediaMimeType[];
}

type InternalOutcome<T> = ProfileMutationOutcome<T> & { visibilityChange?: readonly [ProfileVisibility, ProfileVisibility] };
type InternalContext = ProfileMutationContext;

type IneligibleWhy = 'ACCOUNT_NOT_ACTIVE' | 'ROLE_NOT_ACTIVE' | 'REGISTRATION_NOT_COMPLETED';
function ineligibility(f: { status: string; providerRole: string | undefined; registered: boolean }): IneligibleWhy | null {
  if (f.status !== 'ACTIVE') return 'ACCOUNT_NOT_ACTIVE';
  if (f.providerRole !== 'ACTIVE') return 'ROLE_NOT_ACTIVE';
  if (!f.registered) return 'REGISTRATION_NOT_COMPLETED';
  return null;
}
function assertEligible(f: { status: string; providerRole: string | undefined; registered: boolean }): void {
  const why = ineligibility(f);
  if (why === 'ACCOUNT_NOT_ACTIVE') throw new ProfileError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: why });
  if (why !== null) throw new ProfileError('PROVIDER_NOT_ELIGIBLE', 'the account is not an eligible provider', { reason: why });
}

export class ProviderProfileService implements ProfileMutator {
  constructor(protected readonly deps: ProviderProfileDeps) {}

  private get db(): Executor {
    return this.deps.db.db;
  }
  private get projection(): ProjectionDeps {
    const { db, names, markets, trust, services, eligibility } = this.deps;
    return { db, names, markets, trust, services, ...(eligibility ? { eligibility } : {}) };
  }
  private tx<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.deps.db.transaction(fn).catch((e) => mapProfileDbError(e));
  }
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      return mapProfileDbError(e);
    }
  }

  // ------------------------------------------------------------------ shared reads (all owner-scoped)
  /** The CURRENT policy; a provider that throws anything but a typed error is an outage of the policy (fail closed). */
  private async policy(): Promise<ProviderProfilePolicy> {
    return viaPort('policy', () => this.deps.policy.policy());
  }
  private async loadProfile(ex: Executor, accountId: string, lock = false): Promise<ProfileRow | null> {
    const r = (
      await sql<Row>`SELECT p.*, pa.mime_type AS photo_mime_type, pa.width AS photo_width, pa.height AS photo_height
          FROM provider.public_profiles p
          LEFT JOIN provider.media_assets pa ON pa.media_asset_id = p.photo_asset_id AND pa.status = 'READY'
         WHERE p.account_id = ${accountId} ${lock ? sql`FOR UPDATE OF p` : sql``}`.execute(ex)
    ).rows[0];
    return r ? toProfileRow(r) : null;
  }
  private async hasPublishedGig(ex: Executor, accountId: string): Promise<boolean> {
    return (
      (
        await sql<Row>`SELECT EXISTS (SELECT 1 FROM provider.gigs g JOIN provider.gig_versions v ON v.gig_id = g.gig_id AND v.status = 'PUBLISHED'
                                   WHERE g.account_id = ${accountId} AND g.status = 'ACTIVE') AS present`.execute(ex)
      ).rows[0]!.present === true
    );
  }
  /** Role and registration facts of an account, in one statement (used under the account lock). */
  private async eligibilityFacts(ex: Executor, accountId: string): Promise<{ status: string; providerRole: string | undefined; registered: boolean }> {
    const r = (
      await sql<Row>`SELECT a.status,
             (SELECT m.status FROM identity.account_roles m JOIN identity.roles ro ON ro.role_id = m.role_id WHERE m.account_id = a.account_id AND ro.code = ${PROVIDER_ROLE_CODE}) AS provider_role,
             EXISTS (SELECT 1 FROM provider.registrations x WHERE x.account_id = a.account_id AND x.status = 'COMPLETED') AS registered
        FROM identity.accounts a WHERE a.account_id = ${accountId}`.execute(ex)
    ).rows[0];
    if (!r) throw new ProfileError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: 'ACCOUNT_NOT_ACTIVE' });
    return { status: r.status as string, providerRole: (r.provider_role as string | null) ?? undefined, registered: r.registered === true };
  }
  /** The account facts through the identity port, with its errors translated. */
  private async accountFacts(accountId: string): Promise<AccountFacts> {
    try {
      return await this.deps.accounts.facts(accountId);
    } catch (e) {
      return translateAccountError(e);
    }
  }

  /** Policy, badges, fallback name and the configured photo types: read before any transaction, reused for the answer after it. */
  private async statePre(accountId: string, policy?: ProviderProfilePolicy): Promise<StatePre> {
    const p = policy ?? (await this.policy());
    const [badges, names, mimeTypes] = await Promise.all([
      loadBadges(this.deps.trust, accountId, p),
      viaPort('names', () => this.deps.names.names(accountId)),
      this.photoMimeTypes(),
    ]);
    return { policy: p, badgeCount: badges.length, fallbackName: names ? derivePublicName(names.firstName, names.lastName) : null, mimeTypes };
  }
  /**
   * The same facts for the answer AFTER a committed change: every optional derived fact degrades on its own failure (the change is already committed, so it is never turned into an
   * error): no policy = zeroed limits and profileComplete false; no trust = no badge fact; no names = no fallback name; no media policy = no photo types. Each failure is logged by `viaPort`.
   */
  private async degradedPre(accountId: string, known?: ProviderProfilePolicy): Promise<StatePre> {
    const policy = known ?? (await this.policy().catch(() => null));
    const [badges, names, mimeTypes] = await Promise.all([
      policy ? loadBadges(this.deps.trust, accountId, policy).catch(() => []) : Promise.resolve([]),
      viaPort('names', () => this.deps.names.names(accountId)).catch(() => null),
      this.photoMimeTypes().catch(() => [] as GigMediaMimeType[]),
    ]);
    return { policy, badgeCount: badges.length, fallbackName: names ? derivePublicName(names.firstName, names.lastName) : null, mimeTypes };
  }
  private async photoMimeTypes(): Promise<readonly GigMediaMimeType[]> {
    if (!this.deps.mediaPolicy) return PROFILE_PHOTO_MIME_TYPES;
    const media = await viaPort('mediaPolicy', () => this.deps.mediaPolicy!.media());
    return PROFILE_PHOTO_MIME_TYPES.filter((t) => media.allowedMimeTypes.includes(t));
  }

  private readinessOf(row: ProfileRow | null, hasGig: boolean, pre: StatePre): ProfileReadinessDto {
    const displayNamePresent = row?.displayName != null;
    const publicNameAvailable = displayNamePresent || pre.fallbackName !== null;
    const bioPresent = row?.bio != null;
    const profilePhotoPresent = row?.photo != null;
    return {
      displayNamePresent,
      publicNameAvailable,
      bioPresent,
      profilePhotoPresent,
      hasPublishedGig: hasGig,
      trustSummaryAvailable: pre.badgeCount > 0,
      profileComplete:
        row !== null &&
        pre.policy !== null &&
        publishingIssues({ publicNameAvailable, bioPresent, photoPresent: profilePhotoPresent }, pre.policy).length === 0,
      visibility: row?.visibility ?? null,
    };
  }

  /** The owner's state, from the database (the row and the Gig fact) and the facts read before the transaction. */
  private async ownerState(accountId: string, pre: StatePre): Promise<OwnerProfileStateDto> {
    const [row, hasGig] = await this.read(() => Promise.all([this.loadProfile(this.db, accountId), this.hasPublishedGig(this.db, accountId)]));
    return {
      exists: row !== null,
      profile:
        row === null
          ? null
          : {
              publicProfileId: row.publicProfileId,
              displayName: row.displayName,
              publicName: row.displayName ?? pre.fallbackName,
              bio: row.bio,
              photo: row.photo,
              photoPending: row.pendingPhotoAssetId !== null,
              visibility: row.visibility,
              publishedAt: row.publishedAt === null ? null : toIso(row.publishedAt),
              revision: row.revision,
              createdAt: toIso(row.createdAt),
              updatedAt: toIso(row.updatedAt),
            },
      readiness: this.readinessOf(row, hasGig, pre),
      limits: pre.policy
        ? {
            displayNameMaxLength: pre.policy.displayNameMaxLength,
            bioMaxLength: pre.policy.bioMaxLength,
            bioRequired: pre.policy.bioRequired,
            photoRequired: pre.policy.photoRequired,
            photoMaxSizeBytes: pre.policy.photoMaxFileSizeBytes,
            photoMimeTypes: [...pre.mimeTypes],
          }
        : // degraded echo of a committed change (the policy was unreadable): nothing is invented, the client reads the profile again
          { displayNameMaxLength: 0, bioMaxLength: 0, bioRequired: false, photoRequired: false, photoMaxSizeBytes: 0, photoMimeTypes: [] },
    };
  }

  // ------------------------------------------------------------------ audit, events, locks
  private audit(trx: Trx, cid: string, a: { accountId: string; publicProfileId: string; action: ProfileAuditAction; changes: Record<string, unknown> }) {
    if (!PROFILE_AUDIT_ACTIONS.includes(a.action)) throw new Error('unknown profile audit action');
    return sql`INSERT INTO provider.profile_audit_events (actor, action, account_id, public_profile_id, changes, correlation_id)
      VALUES (${actorOf(a.accountId)}, ${a.action}, ${a.accountId}, ${a.publicProfileId}, ${JSON.stringify(a.changes)}::jsonb, ${cid})`.execute(trx);
  }
  private event(trx: Trx, cid: string, type: string, publicProfileId: string, accountId: string, payload: Record<string, unknown>) {
    return insertOutboxEvent(trx, {
      aggregateType: 'provider-profile',
      aggregateId: publicProfileId,
      eventType: type,
      actorType: 'user',
      actorId: actorOf(accountId),
      correlationId: cid,
      payload,
    });
  }
  /** The first lock of the ID-001 order: the account row, which must be ACTIVE. */
  private async lockAccount(trx: Trx, accountId: string): Promise<void> {
    const r = (await sql<Row>`SELECT status FROM identity.accounts WHERE account_id = ${accountId} FOR UPDATE`.execute(trx)).rows[0];
    if (!r || r.status !== 'ACTIVE') throw new ProfileError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: 'ACCOUNT_NOT_ACTIVE' });
  }

  // ------------------------------------------------------------------ owner reads
  /** The owner's state; `exists:false` (with readiness and limits) when the account has no profile yet. */
  async getOwnerProfile(accountId: string): Promise<OwnerProfileStateDto> {
    return this.ownerState(accountId, await this.statePre(accountId));
  }

  async getReadinessFacts(accountId: string): Promise<ProfileReadinessDto> {
    const pre = await this.statePre(accountId);
    const [row, hasGig] = await this.read(() => Promise.all([this.loadProfile(this.db, accountId), this.hasPublishedGig(this.db, accountId)]));
    return this.readinessOf(row, hasGig, pre);
  }

  /** The public projection of the owner's own profile, whatever its visibility, with `visibility` and `preview: true`. Throws PROFILE_NOT_FOUND when there is no profile. */
  async getPreview(accountId: string): Promise<PreviewProviderProfileDto> {
    const policy = await this.policy();
    const r = await this.read(() => buildPublicProfile(this.projection, policy, { accountId }, { ignoreVisibility: true }));
    switch (r.kind) {
      case 'ok':
        return { ...r.profile, preview: true, visibility: r.visibility };
      case 'ineligible':
        if (r.reason === 'ACCOUNT_NOT_ACTIVE') throw new ProfileError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: r.reason });
        throw new ProfileError('PROVIDER_NOT_ELIGIBLE', 'the account is not an eligible provider', { reason: r.reason });
      case 'name-unavailable':
        throw new ProfileError('PROFILE_INCOMPLETE', 'the profile has no name to show', {
          reason: 'PROFILE_INCOMPLETE',
          issues: [{ reason: 'PUBLIC_NAME_UNAVAILABLE', field: 'displayName' }],
        });
      default:
        throw notFound();
    }
  }

  // ------------------------------------------------------------------ public reads
  /** The public projection, or null for EVERYTHING that is not publicly readable (unknown id, PRIVATE, ineligible account, disabled role, incomplete registration, eligibility flag without a port). */
  async getPublicProfile(publicProfileId: string): Promise<PublicProviderProfileDto | null> {
    const policy = await this.policy();
    const r = await this.read(() => buildPublicProfile(this.projection, policy, { publicProfileId }));
    return r.kind === 'ok' ? r.profile : null;
  }
  /** The photo asset a public photo request may read, after the same rules as `getPublicProfile`; null otherwise. */
  async getPublicPhotoTarget(publicProfileId: string): Promise<ProfilePhotoTarget | null> {
    const policy = await this.policy();
    return this.read(() => resolvePhotoAsset(this.projection, policy, { publicProfileId }));
  }
  /** The owner's own READY photo (whatever the visibility); null when there is none. */
  async getOwnerPhotoTarget(accountId: string): Promise<ProfilePhotoTarget | null> {
    const row = await this.read(() => this.loadProfile(this.db, accountId));
    return row?.photo != null && row.photoAssetId !== null ? { assetId: row.photoAssetId } : null;
  }

  // ------------------------------------------------------------------ the mutation primitive
  /** @see ProfileMutator */
  async readProfile(accountId: string): Promise<ProfileReadContext> {
    const row = await this.read(() => this.loadProfile(this.db, accountId));
    if (!row) throw notFound();
    return { publicProfileId: row.publicProfileId, revision: row.revision, photoAssetId: row.photoAssetId, pendingPhotoAssetId: row.pendingPhotoAssetId };
  }

  /**
   * @see ProfileMutator
   *
   * REVISION CONTRACT (the database guard `provider.guard_public_profiles` forces it): the callback raises the revision ITSELF, in the same UPDATE that changes the row
   * (`... , revision = ctx.revision + 1`). A content change (name, bio, photo, visibility) without it, or an update that only raises the revision, is refused by the guard (REVISION).
   * When the callback returns `changed: true` this method verifies that the revision is exactly `ctx.revision + 1`, then writes the ONE audit row and the outbox event(s); it never
   * issues a revision-only UPDATE. A change of the pending upload pointer alone may keep the revision (`changed: false`) or raise it by one (`changed: true`).
   */
  async mutateProfile<T>(
    accountId: string,
    expectedRevision: number,
    run: (ctx: ProfileMutationContext) => Promise<ProfileMutationOutcome<T>>,
  ): Promise<{ value: T; state: OwnerProfileStateDto }> {
    return this.mutate(accountId, expectedRevision, run);
  }

  /**
   * The mutation transaction. NOTHING is read from another domain or from the configuration before it: an unpublish, a photo removal or any other change must succeed whatever the
   * state of the trust, names or policy services. A caller that needs such a fact reads it itself BEFORE calling this (fail closed for a publishing step). The answer after the commit
   * degrades instead of failing (`degradedPre`); `policy` is passed only when the caller already read it.
   *
   * Owner mutations require an ACTIVE account (locked first) and nothing more: an inactive role or registration does not stop an owner editing or hiding their presentation, because
   * public exposure is gated at READ time (and PUBLIC additionally needs the eligibility, checked by `setVisibility`).
   */
  private async mutate<T>(
    accountId: string,
    expectedRevision: number,
    run: (ctx: InternalContext) => Promise<InternalOutcome<T>>,
    policy?: ProviderProfilePolicy,
  ): Promise<{ value: T; state: OwnerProfileStateDto }> {
    const cid = getCorrelationId() ?? randomUUID();
    // a missing profile and a stale revision are answered before the transaction; both are checked again under the lock
    const known = await this.readProfile(accountId);
    if (known.revision !== expectedRevision) throw stale();
    const value = await this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const row = await this.loadProfile(trx, accountId, true);
      if (!row) throw notFound();
      if (row.revision !== expectedRevision) throw stale();
      const out = await run({
        trx,
        accountId,
        cid,
        publicProfileId: row.publicProfileId,
        revision: row.revision,
        photoAssetId: row.photoAssetId,
        pendingPhotoAssetId: row.pendingPhotoAssetId,
      });
      if (out.changed) await this.recordChange(trx, cid, accountId, row, out);
      return out.value;
    });
    return { value, state: await this.ownerState(accountId, await this.degradedPre(accountId, policy)) };
  }

  /**
   * Verifies the revision and writes the ONE audit row and the outbox event(s) of a real change, in the caller's transaction. The revision itself is raised by the `run` callback IN THE
   * SAME UPDATE as the change (`revision = ctx.revision + 1`): the database guard (REVISION) refuses a content change that does not raise it by exactly one, and refuses an update that
   * only raises it. A callback that reports a change without having raised the revision by exactly one is a programming error and rolls the transaction back.
   */
  private async recordChange(trx: Trx, cid: string, accountId: string, row: ProfileRow, out: InternalOutcome<unknown>): Promise<void> {
    const fields: ProfileFieldName[] = [...new Set(out.changedFields)];
    for (const f of fields) if (!PROFILE_FIELD_NAMES.includes(f)) throw new Error('unknown profile field name');
    const next = row.revision + 1;
    const now = (await sql<Row>`SELECT revision FROM provider.public_profiles WHERE public_profile_id = ${row.publicProfileId}`.execute(trx)).rows[0];
    if (Number(now?.revision) !== next) throw new Error('a profile mutation must raise the revision by exactly one in the update that makes the change');
    await this.audit(trx, cid, {
      accountId,
      publicProfileId: row.publicProfileId,
      action: out.action,
      changes: { changedFields: fields, revision: [row.revision, next], ...(out.visibilityChange ? { visibility: out.visibilityChange } : {}) },
    });
    const updated: ProfileUpdatedPayload = { accountId, publicProfileId: row.publicProfileId, revision: next, changedFields: fields };
    // a change that only moves the pending-upload pointer (publicChange:false) keeps its revision and audit row but is no public event
    if (out.publicChange !== false) await this.event(trx, cid, PROFILE_EVENTS.profileUpdated, row.publicProfileId, accountId, updated);
    if (out.visibilityChange) {
      const visibility: ProfileVisibilityChangedPayload = { accountId, publicProfileId: row.publicProfileId, visibility: out.visibilityChange[1] };
      await this.event(trx, cid, PROFILE_EVENTS.profileVisibilityChanged, row.publicProfileId, accountId, visibility);
    }
  }

  // ------------------------------------------------------------------ create
  /** Creates the profile (PRIVATE, revision 1). Idempotent: an existing profile is returned unchanged with `created:false`. */
  async createProfile(accountId: string): Promise<{ created: boolean; state: OwnerProfileStateDto }> {
    const cid = getCorrelationId() ?? randomUUID();
    const pre = await this.statePre(accountId);
    // the eligibility facts are read through the port BEFORE the transaction and again under the account lock
    const facts = await this.accountFacts(accountId);
    const registered = await this.read(async () => (await this.eligibilityFacts(this.db, accountId)).registered);
    assertEligible({ status: facts.status, providerRole: facts.memberships.find((m) => m.code === PROVIDER_ROLE_CODE)?.status, registered });
    const created = await this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      assertEligible(await this.eligibilityFacts(trx, accountId));
      const inserted = (
        await sql<Row>`INSERT INTO provider.public_profiles (account_id) VALUES (${accountId}) ON CONFLICT (account_id) DO NOTHING RETURNING public_profile_id`.execute(
          trx,
        )
      ).rows[0];
      if (!inserted) return false;
      const publicProfileId = inserted.public_profile_id as string;
      await this.audit(trx, cid, {
        accountId,
        publicProfileId,
        action: 'PROVIDER_PUBLIC_PROFILE_CREATED',
        changes: { revision: 1, visibility: 'PRIVATE' },
      });
      const payload: ProfileUpdatedPayload = { accountId, publicProfileId, revision: 1, changedFields: [] };
      await this.event(trx, cid, PROFILE_EVENTS.profileUpdated, publicProfileId, accountId, payload);
      return true;
    });
    return { created, state: await this.ownerState(accountId, pre) };
  }

  // ------------------------------------------------------------------ update (name, bio)
  /** `input` is an UpdateProviderProfileRequest (parsed here). */
  async updateProfile(accountId: string, input: unknown): Promise<OwnerProfileStateDto> {
    const body = parseInput(UpdateProviderProfileRequest, input);
    const policy = await this.policy();
    const checked = validateProfileUpdate(body, policy);
    if (!checked.ok) throw new ProfileError('VALIDATION_FAILED', 'the profile is not valid', { reason: 'PROFILE_INVALID', issues: checked.issues });
    const { change } = checked;
    // clearing the display name of a PUBLIC profile must leave a public name: the fallback is read BEFORE the transaction; a failing names port only matters if the profile turns out to be PUBLIC
    let fallbackName: string | null | undefined;
    if (change.displayName === null) {
      fallbackName = await viaPort('names', () => this.deps.names.names(accountId)).then(
        (n) => (n ? derivePublicName(n.firstName, n.lastName) : null),
        () => undefined,
      );
    }
    const { state } = await this.mutate(
      accountId,
      body.expectedRevision,
      async (ctx) => {
        const row = (await this.loadProfile(ctx.trx, accountId))!;
        const changedFields: ProfileFieldName[] = [];
        let displayName = row.displayName;
        let bio = row.bio;
        if (change.displayName !== undefined && change.displayName !== row.displayName) {
          displayName = change.displayName;
          changedFields.push('displayName');
        }
        if (change.bio !== undefined && change.bio !== row.bio) {
          bio = change.bio;
          changedFields.push('bio');
        }
        if (changedFields.length === 0) return { changed: false, action: 'PROVIDER_PUBLIC_PROFILE_UPDATED', changedFields, value: undefined };
        // a PUBLIC profile never falls below its publishing prerequisites through an edit (a PRIVATE one may clear anything)
        if (row.visibility === 'PUBLIC') {
          if (displayName === null && changedFields.includes('displayName') && fallbackName === undefined)
            throw new ProfileError('UNAVAILABLE', 'the provider profile is unavailable', { reason: 'DEPENDENCY_UNAVAILABLE' });
          const issues = publishingIssues(
            { publicNameAvailable: displayName !== null || (fallbackName ?? null) !== null, bioPresent: bio !== null, photoPresent: row.photo !== null },
            policy,
          ).filter((i) => i.field !== undefined && (changedFields as string[]).includes(i.field));
          if (issues.length > 0)
            throw new ProfileError('PROFILE_INCOMPLETE', 'a public profile must keep what it needs to be public', { reason: 'PROFILE_INCOMPLETE', issues });
        }
        await sql`UPDATE provider.public_profiles SET display_name = ${displayName}, bio = ${bio}, revision = ${ctx.revision + 1} WHERE public_profile_id = ${row.publicProfileId}`.execute(
          ctx.trx,
        );
        return { changed: true, action: 'PROVIDER_PUBLIC_PROFILE_UPDATED', changedFields, value: undefined };
      },
      policy,
    );
    return state;
  }

  // ------------------------------------------------------------------ visibility
  /** `input` is a SetProfileVisibilityRequest. PUBLIC needs the configured prerequisites (PROFILE_INCOMPLETE otherwise); PRIVATE is always allowed. */
  async setVisibility(accountId: string, input: unknown): Promise<OwnerProfileStateDto> {
    const body = parseInput(SetProfileVisibilityRequest, input);
    // PUBLIC is a publishing step: its facts are read first and a failing dependency fails it closed. PRIVATE reads NOTHING: hiding a profile never depends on another service.
    const pre = body.visibility === 'PUBLIC' ? await this.statePre(accountId) : undefined;
    const { state } = await this.mutate(
      accountId,
      body.expectedRevision,
      async (ctx) => {
        const row = (await this.loadProfile(ctx.trx, accountId))!;
        if (row.visibility === body.visibility) return { changed: false, action: 'PROVIDER_PROFILE_VISIBILITY_CHANGED', changedFields: [], value: undefined };
        if (body.visibility === 'PUBLIC') {
          assertEligible(await this.eligibilityFacts(ctx.trx, accountId));
          const issues = publishingIssues(
            { publicNameAvailable: row.displayName !== null || pre!.fallbackName !== null, bioPresent: row.bio !== null, photoPresent: row.photo !== null },
            pre!.policy!,
          );
          if (issues.length > 0)
            throw new ProfileError('PROFILE_INCOMPLETE', 'the profile cannot be made public yet', { reason: 'PROFILE_INCOMPLETE', issues });
        }
        await sql`UPDATE provider.public_profiles
          SET visibility_status = ${body.visibility}, revision = ${ctx.revision + 1}
        WHERE public_profile_id = ${row.publicProfileId}`.execute(ctx.trx);
        return {
          changed: true,
          action: 'PROVIDER_PROFILE_VISIBILITY_CHANGED',
          changedFields: ['visibility'],
          visibilityChange: [row.visibility, body.visibility],
          value: undefined,
        };
      },
      pre?.policy ?? undefined,
    );
    return state;
  }
}

/** The onboarding PROFILE step as a PrerequisitePort entry: NOT_STARTED (no row), IN_PROGRESS (a row but not complete), COMPLETE (complete per the configured requirements). */
export function profilePrerequisite(service: Pick<ProviderProfileService, 'getReadinessFacts'>): PrerequisitePort['profile'] {
  return async (accountId: string): Promise<PrerequisiteState> => {
    const facts = await service.getReadinessFacts(accountId);
    if (facts.visibility === null) return { status: 'NOT_STARTED' };
    return { status: facts.profileComplete ? 'COMPLETE' : 'IN_PROGRESS' };
  };
}
