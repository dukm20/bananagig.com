// The provider registration service (PRO-001): the registration of an account that wants to become a provider. A provider is NOT a second account. Three concepts stay apart:
// the application ROLE (identity.account_roles, owned by ID-001: this service only REQUESTS it as PENDING and activates it when the registration is completed), the REGISTRATION
// (provider.registrations: attempts, the chosen market, the chosen service types) and GO-LIVE eligibility (PRO-003, never here).
//
// Ownership: contact state (ID-002/003), consent (ID-005), the market (GEO-001), the service types (CAT-001) and the future prerequisites are read through PORTS wired in the API
// composition root; nothing of them is copied. Every operation takes the caller's account id from the authenticated request (never from a client).
//
// Transactions and locks: every mutation locks the ACCOUNT row first (FOR UPDATE, the ID-001 order), then the registration row, then the service type rows (FOR SHARE, in the guard).
// The consent port opens its own repeatable-read snapshot, which cannot nest, so consent (and the policy and the account facts) are evaluated BEFORE the transaction; the market and
// the offered service types are re-checked inside it, under the locks. The role port joins the transaction, so the role request and the registration are one change.
import { randomUUID } from 'node:crypto';
import {
  CancelProviderRegistrationRequest,
  PROVIDER_EVENTS,
  ReplaceProviderServicesRequest,
  SelectProviderMarketRequest,
  StartProviderRegistrationRequest,
  SubmitProviderRegistrationRequest,
  type ProviderRegistrationCompletedPayload,
  type ProviderRegistrationEventPayload,
  type ProviderRegistrationPolicy,
} from '@bananagig/contracts';
import { sql, type Database, type DatabaseSchema, type Kysely, type Trx } from '@bananagig/database';
import { getCorrelationId, log } from '@bananagig/observability';
import { insertOutboxEvent } from '@bananagig/platform';
import type { z } from 'zod';
import { ProviderError, isDatabaseOutage } from './errors';
import { PROVIDER_ROLE_CODE, contactState, evaluateRequirements, marketAcceptsProviders, providerRoleOf } from './evaluator';
import {
  UnavailablePrerequisites,
  type AccountFacts,
  type AccountPort,
  type CatalogPort,
  type ConsentPort,
  type MarketPort,
  type PolicyProvider,
  type PrerequisitePort,
  type PrerequisiteState,
  type RegistrationState,
  type RegistrationView,
  type Requirements,
} from './types';

type Row = Record<string, unknown>;
type Executor = Kysely<DatabaseSchema> | Trx;

export interface ProviderRegistrationServiceDeps {
  database: Database;
  accounts: AccountPort;
  consent: ConsentPort;
  markets: MarketPort;
  catalog: CatalogPort;
  policy: PolicyProvider;
  /** The prerequisites of later domains (default: all NOT_AVAILABLE). */
  prerequisites?: PrerequisitePort;
}

// ---------------------------------------------------------------- errors
/** The machine-readable key the migration puts in the DETAIL of every guard failure: exactly `provider_rule:<KEY>`. */
const RULE_DETAIL = /^provider_rule:([A-Z][A-Z_]*)$/;
export function guardRuleOf(detail: unknown): string | undefined {
  return typeof detail === 'string' ? RULE_DETAIL.exec(detail)?.[1] : undefined;
}
/**
 * Translates database constraint, guard and concurrency failures into typed errors with fixed messages (no driver text, no SQL, no table names). Guard failures are classified by
 * `error.detail` (`provider_rule:<KEY>`), concurrency by SQLSTATE.
 */
export function mapDbError(err: unknown): never {
  if (err instanceof ProviderError || err === null || typeof err !== 'object') throw err;
  const e = err as { code?: string; detail?: string; constraint?: string };
  if (e.code === '40P01' || e.code === '40001' || e.code === '55P03')
    throw new ProviderError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', { reason: 'CONCURRENT_UPDATE', retryable: true });
  if (e.code === '22021' || e.code === '22P05')
    throw new ProviderError('VALIDATION_FAILED', 'the request contains a character that is not allowed', { reason: 'FORBIDDEN_CHARACTER' });
  if (e.code === '23505')
    throw new ProviderError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', { reason: 'CONCURRENT_UPDATE', retryable: true });
  if (e.code === '23000') {
    const rule = guardRuleOf(e.detail);
    switch (rule) {
      case 'ACCOUNT_NOT_ACTIVE':
        throw new ProviderError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: rule });
      case 'REGISTRATION_NOT_IN_PROGRESS':
      case 'REGISTRATION_FROZEN':
      case 'STATUS_TRANSITION':
        throw new ProviderError('REGISTRATION_NOT_IN_PROGRESS', 'the registration is no longer in progress', { reason: rule });
      case 'SERVICE_TYPE_RETIRED':
      case 'SERVICE_TYPE_NOT_ACTIVE':
        throw new ProviderError('SERVICE_TYPE_NOT_ELIGIBLE', 'a selected service type is not available', { reason: rule });
      default:
        throw new ProviderError('CONFLICT', 'the operation violates a registration integrity rule', rule ? { reason: rule } : {});
    }
  }
  if (e.code === '23503') throw new ProviderError('VALIDATION_FAILED', 'a referenced record does not exist', { reason: 'REFERENCE_NOT_FOUND' });
  if (isDatabaseOutage(err)) {
    log('error', 'provider registration database unavailable', { error: err instanceof Error ? err.message : String(err) });
    throw new ProviderError('UNAVAILABLE', 'the provider registration is unavailable');
  }
  throw err;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new ProviderError('VALIDATION_FAILED', 'the request is not valid', {
    field: typeof issue?.path[0] === 'string' ? issue.path[0] : undefined,
    reason: 'INVALID_REQUEST',
  });
}

const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));
const toView = (r: Row): RegistrationView => ({
  providerRegistrationId: r.provider_registration_id as string,
  attempt: Number(r.attempt_number),
  status: r.status as RegistrationView['status'],
  revision: Number(r.revision),
  marketCode: (r.market_code as string | null) ?? null,
  serviceTypeCodes: ((r.service_type_codes as string[] | null) ?? []).slice(),
  createdAt: iso(r.created_at),
  completedAt: r.completed_at === null || r.completed_at === undefined ? null : iso(r.completed_at),
  cancelledAt: r.cancelled_at === null || r.cancelled_at === undefined ? null : iso(r.cancelled_at),
});
/** One statement: the registration with its market code and the codes of its selected service types. */
const registrationSelect = sql`SELECT r.provider_registration_id, r.account_id, r.attempt_number, r.status, r.revision, r.market_id, m.code AS market_code, r.created_at, r.completed_at, r.cancelled_at,
       COALESCE((SELECT array_agg(st.code ORDER BY st.code COLLATE "C") FROM provider.registration_service_types rs JOIN catalog.service_types st ON st.service_type_id = rs.service_type_id
                  WHERE rs.provider_registration_id = r.provider_registration_id), '{}') AS service_type_codes
  FROM provider.registrations r LEFT JOIN geography.markets m ON m.market_id = r.market_id`;

const actorOf = (accountId: string): string => `account:${accountId}`;
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const sortC = (xs: readonly string[]): string[] => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export class ProviderRegistrationService {
  private readonly prerequisites: PrerequisitePort;

  constructor(private readonly d: ProviderRegistrationServiceDeps) {
    this.prerequisites = d.prerequisites ?? UnavailablePrerequisites;
  }

  private get db(): Executor {
    return this.d.database.db;
  }
  private tx<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.d.database.transaction(fn).catch(mapDbError);
  }
  private read<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch(mapDbError);
  }

  // ------------------------------------------------------------------ shared reads
  private async loadLatest(ex: Executor, accountId: string): Promise<RegistrationView | null> {
    const r = (await sql<Row>`${registrationSelect} WHERE r.account_id = ${accountId} ORDER BY r.attempt_number DESC LIMIT 1`.execute(ex)).rows[0];
    return r ? toView(r) : null;
  }
  /** The live (IN_PROGRESS or COMPLETED) registration, locked FOR UPDATE by a bare statement first, then read. */
  private async lockLive(trx: Trx, accountId: string): Promise<{ id: string; marketId: string | null; view: RegistrationView } | null> {
    const locked =
      await sql<Row>`SELECT provider_registration_id, market_id FROM provider.registrations WHERE account_id = ${accountId} AND status <> 'CANCELLED' FOR UPDATE`.execute(
        trx,
      );
    const row = locked.rows[0];
    if (!row) return null;
    const id = row.provider_registration_id as string;
    const view = toView((await sql<Row>`${registrationSelect} WHERE r.provider_registration_id = ${id}`.execute(trx)).rows[0]!);
    return { id, marketId: (row.market_id as string | null) ?? null, view };
  }
  /** Locks the account row (the first lock of the ID-001 order) and requires it to be ACTIVE. */
  private async lockAccount(trx: Trx, accountId: string): Promise<void> {
    const r = (await sql<Row>`SELECT status FROM identity.accounts WHERE account_id = ${accountId} FOR UPDATE`.execute(trx)).rows[0];
    if (!r) throw new ProviderError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: 'ACCOUNT_NOT_FOUND' });
    if (r.status !== 'ACTIVE') throw new ProviderError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: 'ACCOUNT_NOT_ACTIVE' });
  }
  private audit(
    trx: Trx,
    cid: string,
    a: { actor: string; action: string; registrationId: string; changes?: Record<string, unknown>; reason?: string | null },
  ) {
    return sql`INSERT INTO provider.audit_events (actor, action, provider_registration_id, changes, reason, correlation_id)
      VALUES (${a.actor}, ${a.action}, ${a.registrationId}, ${a.changes ? JSON.stringify(a.changes) : null}::jsonb, ${a.reason ?? null}, ${cid})`.execute(trx);
  }
  private event(trx: Trx, cid: string, type: string, registrationId: string, actor: string, payload: Record<string, unknown>) {
    return insertOutboxEvent(trx, {
      aggregateType: 'provider_registration',
      aggregateId: registrationId,
      eventType: type,
      actorType: 'user',
      actorId: actor,
      correlationId: cid,
      payload,
    });
  }
  private expect(view: RegistrationView, expectedRevision: number | undefined): void {
    if (expectedRevision !== undefined && expectedRevision !== view.revision)
      throw new ProviderError('STALE_REGISTRATION', 'the registration changed since it was read: read it again', { reason: 'STALE_REGISTRATION' });
  }
  /** PRD PR-01.03/.05: email and phone are verified before any other onboarding step. */
  private assertContacts(policy: ProviderRegistrationPolicy, facts: AccountFacts): void {
    const c = contactState(policy, facts);
    if (c.status !== 'COMPLETE' && c.status !== 'NOT_REQUIRED')
      throw new ProviderError('PREREQUISITE_NOT_MET', 'verify your email and phone before you continue', { reason: 'CONTACT_NOT_VERIFIED', step: 'CONTACT' });
  }

  // ------------------------------------------------------------------ reads
  /** The role as the account holds it and the latest attempt. `facts` may be supplied by a caller that already loaded the account (the request guard). */
  async getRegistration(accountId: string, opts: { facts?: AccountFacts } = {}): Promise<RegistrationState> {
    const facts = opts.facts ?? (await this.d.accounts.facts(accountId));
    const registration = await this.read(() => this.loadLatest(this.db, accountId));
    return { providerRole: providerRoleOf(facts.memberships), registration };
  }

  /**
   * The derived onboarding state. Authoritative reads are batched by domain: the account facts (or the caller's), the latest registration with its selections (one statement),
   * the policy, the consent evaluation (only when a provider role exists), and, when a market is chosen, the market and the offered service types.
   */
  async getRequirements(accountId: string, opts: { locale?: string; facts?: AccountFacts } = {}): Promise<Requirements> {
    const facts = opts.facts ?? (await this.d.accounts.facts(accountId));
    const [policy, registration] = await Promise.all([this.d.policy.policy(), this.read(() => this.loadLatest(this.db, accountId))]);
    return this.evaluate(accountId, facts, policy, registration, opts.locale);
  }

  private async evaluate(
    accountId: string,
    facts: AccountFacts,
    policy: ProviderRegistrationPolicy,
    registration: RegistrationView | null,
    locale?: string,
  ): Promise<Requirements> {
    const role = providerRoleOf(facts.memberships);
    const live = registration !== null && registration.status !== 'CANCELLED' ? registration : null;
    const marketCode = live?.marketCode ?? null;
    const [consent, market, offered, verification, subscription, profile, gigs] = await Promise.all([
      role === 'PENDING' || role === 'ACTIVE' ? this.d.consent.requirements(accountId, { locale }) : Promise.resolve(null),
      marketCode === null ? Promise.resolve(null) : this.d.markets.lookup(marketCode),
      marketCode === null ? Promise.resolve(null) : this.d.catalog.offeredServiceTypes(marketCode),
      this.prerequisites.verification(accountId),
      this.prerequisites.subscription(accountId),
      this.prerequisites.profile(accountId),
      this.prerequisites.gigs(accountId),
    ]);
    return evaluateRequirements({ policy, account: facts, registration, consent, market, offered, future: { verification, subscription, profile, gigs } });
  }

  // ------------------------------------------------------------------ start (customer-to-provider entry)
  /**
   * Starts (or resumes) the provider registration of the caller's account. Idempotent: a live attempt (IN_PROGRESS or COMPLETED) is returned unchanged; after a cancellation the
   * next call starts a NEW attempt. The account keeps its CUSTOMER role, its contacts, its sessions and its consent history; the PROVIDER role is REQUESTED (PENDING), never
   * activated here. A deactivated (INACTIVE) provider role is not reactivated by a self-service start.
   */
  async startRegistration(accountId: string, input: unknown = {}): Promise<{ created: boolean; state: RegistrationState }> {
    parseInput(StartProviderRegistrationRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const actor = actorOf(accountId);
    return this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const live = await this.lockLive(trx, accountId);
      const facts = await this.d.accounts.facts(accountId);
      if (live) return { created: false, state: { providerRole: providerRoleOf(facts.memberships), registration: live.view } };
      const membership = facts.memberships.find((m) => m.code === PROVIDER_ROLE_CODE);
      if (membership?.status === 'INACTIVE') throw new ProviderError('ROLE_INACTIVE', 'the provider role is inactive', { reason: 'ROLE_INACTIVE' });
      if (!membership) await this.d.accounts.grantRole(accountId, PROVIDER_ROLE_CODE, { pending: true, actor, reason: 'Provider registration started' });
      const attempt = Number(
        (await sql<Row>`SELECT COALESCE(max(attempt_number), 0) + 1 AS n FROM provider.registrations WHERE account_id = ${accountId}`.execute(trx)).rows[0]!.n,
      );
      const inserted =
        await sql<Row>`INSERT INTO provider.registrations (account_id, attempt_number) VALUES (${accountId}, ${attempt}) RETURNING provider_registration_id`.execute(
          trx,
        );
      const id = inserted.rows[0]!.provider_registration_id as string;
      await this.audit(trx, cid, {
        actor,
        action: 'PROVIDER_REGISTRATION_STARTED',
        registrationId: id,
        changes: { attempt: [null, attempt], providerRole: [membership?.status ?? 'NONE', membership?.status ?? 'PENDING'] },
      });
      const payload: ProviderRegistrationEventPayload = { accountId, providerRegistrationId: id, attempt };
      await this.event(trx, cid, PROVIDER_EVENTS.registrationStarted, id, actor, payload);
      const view = toView((await sql<Row>`${registrationSelect} WHERE r.provider_registration_id = ${id}`.execute(trx)).rows[0]!);
      return { created: true, state: { providerRole: membership?.status ?? 'PENDING', registration: view } };
    });
  }

  // ------------------------------------------------------------------ market
  /**
   * Chooses the market. Needs the contacts verified (as configured), a market whose status the policy allows (and, when ACTIVE, in effect). Selected service types are kept and
   * reported as blocked by the evaluator when the new market does not offer them. Idempotent for the same market.
   */
  async selectMarket(accountId: string, input: unknown): Promise<RegistrationState> {
    const body = parseInput(SelectProviderMarketRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const actor = actorOf(accountId);
    const [policy, facts] = await Promise.all([this.d.policy.policy(), this.d.accounts.facts(accountId)]);
    this.assertContacts(policy, facts);
    const market = await this.d.markets.lookup(body.marketCode);
    if (!marketAcceptsProviders(policy, market))
      throw new ProviderError('MARKET_NOT_ELIGIBLE', 'provider registration is not open in that market', { reason: 'MARKET_NOT_ELIGIBLE' });
    return this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const live = await this.lockLive(trx, accountId);
      if (!live) throw new ProviderError('REGISTRATION_NOT_FOUND', 'the provider registration was not started', { reason: 'REGISTRATION_NOT_FOUND' });
      if (live.view.status !== 'IN_PROGRESS')
        throw new ProviderError('REGISTRATION_NOT_IN_PROGRESS', 'the registration is no longer in progress', { reason: 'REGISTRATION_NOT_IN_PROGRESS' });
      this.expect(live.view, body.expectedRevision);
      // the contacts are checked again under the lock: they can change between the first check and here
      const lockedFacts = await this.d.accounts.facts(accountId);
      this.assertContacts(policy, lockedFacts);
      const target = (await sql<Row>`SELECT market_id FROM geography.markets WHERE code = ${body.marketCode}`.execute(trx)).rows[0];
      if (!target) throw new ProviderError('MARKET_NOT_ELIGIBLE', 'provider registration is not open in that market', { reason: 'MARKET_NOT_ELIGIBLE' });
      const providerRole = providerRoleOf(lockedFacts.memberships);
      if (live.view.marketCode === body.marketCode) return { providerRole, registration: live.view };
      await sql`UPDATE provider.registrations SET market_id = ${target.market_id as string}, revision = revision + 1 WHERE provider_registration_id = ${live.id}`.execute(
        trx,
      );
      await this.audit(trx, cid, {
        actor,
        action: 'PROVIDER_MARKET_SELECTED',
        registrationId: live.id,
        changes: { market: [live.view.marketCode, body.marketCode], revision: [live.view.revision, live.view.revision + 1] },
      });
      const view = toView((await sql<Row>`${registrationSelect} WHERE r.provider_registration_id = ${live.id}`.execute(trx)).rows[0]!);
      return { providerRole, registration: view };
    });
  }

  // ------------------------------------------------------------------ services
  /**
   * Replaces the WHOLE set of selected service types. Needs the contacts verified, a chosen market that still accepts providers, and codes that the market OFFERS (ACTIVE service
   * types enabled under an enabled ACTIVE category); the count must lie within the configured [min, max]. Atomic and idempotent: an equal set writes nothing.
   */
  async replaceServiceTypes(accountId: string, input: unknown): Promise<RegistrationState> {
    const body = parseInput(ReplaceProviderServicesRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const actor = actorOf(accountId);
    const codes = sortC(body.serviceTypeCodes);
    const [policy, facts] = await Promise.all([this.d.policy.policy(), this.d.accounts.facts(accountId)]);
    this.assertContacts(policy, facts);
    if (codes.length < policy.minServiceTypes || codes.length > policy.maxServiceTypes)
      throw new ProviderError('SERVICE_COUNT_OUT_OF_RANGE', 'the number of selected service types is outside the allowed range', {
        reason: 'SERVICE_COUNT_OUT_OF_RANGE',
        min: policy.minServiceTypes,
        max: policy.maxServiceTypes,
      });
    return this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const live = await this.lockLive(trx, accountId);
      if (!live) throw new ProviderError('REGISTRATION_NOT_FOUND', 'the provider registration was not started', { reason: 'REGISTRATION_NOT_FOUND' });
      if (live.view.status !== 'IN_PROGRESS')
        throw new ProviderError('REGISTRATION_NOT_IN_PROGRESS', 'the registration is no longer in progress', { reason: 'REGISTRATION_NOT_IN_PROGRESS' });
      this.expect(live.view, body.expectedRevision);
      // the contacts are checked again under the lock: they can change between the first check and here
      const lockedFacts = await this.d.accounts.facts(accountId);
      this.assertContacts(policy, lockedFacts);
      const marketCode = live.view.marketCode;
      if (marketCode === null) throw new ProviderError('MARKET_REQUIRED', 'choose where you work first', { reason: 'MARKET_REQUIRED' });
      if (!marketAcceptsProviders(policy, await this.d.markets.lookup(marketCode)))
        throw new ProviderError('MARKET_NOT_ELIGIBLE', 'provider registration is not open in that market', { reason: 'MARKET_NOT_ELIGIBLE' });
      const offered = new Set(await this.d.catalog.offeredServiceTypes(marketCode));
      const ineligible = codes.filter((c) => !offered.has(c));
      if (ineligible.length > 0)
        throw new ProviderError('SERVICE_TYPE_NOT_ELIGIBLE', 'a selected service type is not available in your market', {
          reason: 'SERVICE_TYPE_NOT_ELIGIBLE',
          codes: ineligible.slice(0, 20),
        });
      const providerRole = providerRoleOf(lockedFacts.memberships);
      const current = live.view.serviceTypeCodes;
      if (sameSet(current, codes)) return { providerRole, registration: live.view };
      const removed = current.filter((c) => !codes.includes(c));
      const added = codes.filter((c) => !current.includes(c));
      if (removed.length > 0)
        await sql`DELETE FROM provider.registration_service_types WHERE provider_registration_id = ${live.id}
          AND service_type_id IN (SELECT service_type_id FROM catalog.service_types WHERE code = ANY(${removed}::text[]))`.execute(trx);
      if (added.length > 0)
        await sql`INSERT INTO provider.registration_service_types (provider_registration_id, service_type_id)
          SELECT ${live.id}, service_type_id FROM catalog.service_types WHERE code = ANY(${added}::text[]) ORDER BY code COLLATE "C"`.execute(trx);
      await sql`UPDATE provider.registrations SET revision = revision + 1 WHERE provider_registration_id = ${live.id}`.execute(trx);
      await this.audit(trx, cid, {
        actor,
        action: 'PROVIDER_SERVICES_UPDATED',
        registrationId: live.id,
        changes: { added, removed, count: [current.length, codes.length], revision: [live.view.revision, live.view.revision + 1] },
      });
      const view = toView((await sql<Row>`${registrationSelect} WHERE r.provider_registration_id = ${live.id}`.execute(trx)).rows[0]!);
      return { providerRole, registration: view };
    });
  }

  // ------------------------------------------------------------------ submit
  /**
   * Submits the registration: the SERVER validates every step PRO-001 owns or composes (account, contacts, agreements, market, service types) and completes it in one
   * transaction, activating a PENDING provider role. It does NOT verify, subscribe, publish or make the provider live. A repeat on a COMPLETED registration is a no-op.
   */
  async submitRegistration(accountId: string, input: unknown): Promise<{ changed: boolean; state: RegistrationState; requirements: Requirements }> {
    const body = parseInput(SubmitProviderRegistrationRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const actor = actorOf(accountId);
    // Prerequisites of other domains are evaluated BEFORE the transaction (consent opens its own snapshot, which cannot nest)
    const [policy, preFacts, preRegistration] = await Promise.all([
      this.d.policy.policy(),
      this.d.accounts.facts(accountId),
      this.read(() => this.loadLatest(this.db, accountId)),
    ]);
    if (preRegistration === null || preRegistration.status === 'CANCELLED')
      throw new ProviderError('REGISTRATION_NOT_FOUND', 'the provider registration was not started', { reason: 'REGISTRATION_NOT_FOUND' });
    if (preRegistration.status === 'IN_PROGRESS') this.expect(preRegistration, body.expectedRevision);
    const role = providerRoleOf(preFacts.memberships);
    // an INACTIVE role is named as such (its consent is not evaluated, so "incomplete: LEGAL" would send the person to a page that cannot help)
    if (role === 'INACTIVE' && preRegistration.status === 'IN_PROGRESS')
      throw new ProviderError('ROLE_INACTIVE', 'the provider role is inactive', { reason: 'ROLE_INACTIVE' });
    const consent = role === 'PENDING' || role === 'ACTIVE' ? await this.d.consent.requirements(accountId, {}) : null;
    // the facts of later checkpoints may become remote calls: they are read before the locks are taken, never while holding them
    const future = await this.futureFacts(accountId);
    return this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const live = await this.lockLive(trx, accountId);
      if (!live) throw new ProviderError('REGISTRATION_NOT_FOUND', 'the provider registration was not started', { reason: 'REGISTRATION_NOT_FOUND' });
      const facts = await this.d.accounts.facts(accountId);
      if (live.view.status === 'COMPLETED') {
        const requirements = await this.requirementsInTx(accountId, facts, policy, live.view, consent, future);
        return { changed: false, state: { providerRole: providerRoleOf(facts.memberships), registration: live.view }, requirements };
      }
      this.expect(live.view, body.expectedRevision);
      // lock the selected service types so none can be retired between the check and the commit
      if (live.view.serviceTypeCodes.length > 0)
        await sql`SELECT service_type_id FROM catalog.service_types WHERE code = ANY(${live.view.serviceTypeCodes}::text[]) ORDER BY code COLLATE "C" FOR SHARE`.execute(
          trx,
        );
      const requirements = await this.requirementsInTx(accountId, facts, policy, live.view, consent, future);
      if (!requirements.overall.registrationReady)
        throw new ProviderError('REGISTRATION_INCOMPLETE', 'some registration steps are still open', {
          reason: 'REGISTRATION_INCOMPLETE',
          steps: requirements.overall.blockedBy,
        });
      const membership = facts.memberships.find((m) => m.code === PROVIDER_ROLE_CODE);
      if (membership?.status === 'INACTIVE') throw new ProviderError('ROLE_INACTIVE', 'the provider role is inactive', { reason: 'ROLE_INACTIVE' });
      await sql`UPDATE provider.registrations SET status = 'COMPLETED' WHERE provider_registration_id = ${live.id}`.execute(trx);
      // the registration is complete: the account may now act as a provider (the role is the identity domain's; PENDING -> ACTIVE). Go-live is not decided here.
      let roleStatus = membership?.status ?? 'NONE';
      if (membership?.status !== 'ACTIVE') {
        const granted = await this.d.accounts.grantRole(accountId, PROVIDER_ROLE_CODE, { pending: false, actor, reason: 'Provider registration completed' });
        roleStatus = granted.status as typeof roleStatus;
      }
      await this.audit(trx, cid, {
        actor,
        action: 'PROVIDER_REGISTRATION_COMPLETED',
        registrationId: live.id,
        changes: {
          status: ['IN_PROGRESS', 'COMPLETED'],
          providerRole: [membership?.status ?? 'NONE', roleStatus],
          market: live.view.marketCode,
          serviceTypes: live.view.serviceTypeCodes.length,
        },
      });
      const payload: ProviderRegistrationCompletedPayload = {
        accountId,
        providerRegistrationId: live.id,
        attempt: live.view.attempt,
        marketCode: live.view.marketCode as string,
        serviceTypeCodes: live.view.serviceTypeCodes,
      };
      await this.event(trx, cid, PROVIDER_EVENTS.registrationCompleted, live.id, actor, payload);
      const view = toView((await sql<Row>`${registrationSelect} WHERE r.provider_registration_id = ${live.id}`.execute(trx)).rows[0]!);
      const done = {
        ...requirements,
        registration: view,
        providerRole: roleStatus as Requirements['providerRole'],
        overall: { ...requirements.overall, registrationComplete: true },
      };
      return { changed: true, state: { providerRole: roleStatus as RegistrationState['providerRole'], registration: view }, requirements: done };
    });
  }

  /** The evaluation INSIDE the registration transaction: consent was evaluated before it; the market and the offered service types are read under the locks. */
  private async requirementsInTx(
    accountId: string,
    facts: AccountFacts,
    policy: ProviderRegistrationPolicy,
    registration: RegistrationView,
    consent: Awaited<ReturnType<ConsentPort['requirements']>> | null,
    future: Awaited<ReturnType<ProviderRegistrationService['futureFacts']>>,
  ): Promise<Requirements> {
    const marketCode = registration.marketCode;
    const [market, offered] = await Promise.all([
      marketCode === null ? Promise.resolve(null) : this.d.markets.lookup(marketCode),
      marketCode === null ? Promise.resolve(null) : this.d.catalog.offeredServiceTypes(marketCode),
    ]);
    return evaluateRequirements({ policy, account: facts, registration, consent, market, offered, future });
  }

  /** The prerequisite facts of the checkpoints that come after this one (verification, subscription, profile, Gigs), one read each. */
  private async futureFacts(
    accountId: string,
  ): Promise<{ verification: PrerequisiteState; subscription: PrerequisiteState; profile: PrerequisiteState; gigs: PrerequisiteState }> {
    const [verification, subscription, profile, gigs] = await Promise.all([
      this.prerequisites.verification(accountId),
      this.prerequisites.subscription(accountId),
      this.prerequisites.profile(accountId),
      this.prerequisites.gigs(accountId),
    ]);
    return { verification, subscription, profile, gigs };
  }

  // ------------------------------------------------------------------ cancel
  /**
   * Cancels an IN_PROGRESS registration. The account, its CUSTOMER role, its contacts and its consent history are untouched; a PENDING provider role stays PENDING (it grants
   * nothing, and an INACTIVE role could not return to PENDING, so deactivating it would block a restart). A restart is a NEW attempt. Idempotent on a cancelled latest attempt;
   * a COMPLETED registration is not cancelled here.
   */
  async cancelRegistration(accountId: string, input: unknown = {}): Promise<{ changed: boolean; state: RegistrationState }> {
    parseInput(CancelProviderRegistrationRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const actor = actorOf(accountId);
    return this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const live = await this.lockLive(trx, accountId);
      const facts = await this.d.accounts.facts(accountId);
      if (!live) {
        const latest = await this.loadLatest(trx, accountId);
        if (latest?.status === 'CANCELLED') return { changed: false, state: { providerRole: providerRoleOf(facts.memberships), registration: latest } };
        throw new ProviderError('REGISTRATION_NOT_FOUND', 'the provider registration was not started', { reason: 'REGISTRATION_NOT_FOUND' });
      }
      if (live.view.status !== 'IN_PROGRESS')
        throw new ProviderError('REGISTRATION_NOT_IN_PROGRESS', 'a completed registration cannot be cancelled', { reason: 'REGISTRATION_NOT_IN_PROGRESS' });
      await sql`UPDATE provider.registrations SET status = 'CANCELLED' WHERE provider_registration_id = ${live.id}`.execute(trx);
      await this.audit(trx, cid, {
        actor,
        action: 'PROVIDER_REGISTRATION_CANCELLED',
        registrationId: live.id,
        changes: { status: ['IN_PROGRESS', 'CANCELLED'] },
      });
      const payload: ProviderRegistrationEventPayload = { accountId, providerRegistrationId: live.id, attempt: live.view.attempt };
      await this.event(trx, cid, PROVIDER_EVENTS.registrationCancelled, live.id, actor, payload);
      const view = toView((await sql<Row>`${registrationSelect} WHERE r.provider_registration_id = ${live.id}`.execute(trx)).rows[0]!);
      return { changed: true, state: { providerRole: providerRoleOf(facts.memberships), registration: view } };
    });
  }
}
