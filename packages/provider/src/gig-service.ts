// The provider Gig service (CAT-003): Gig identity, immutable versions, editable drafts, normalised field values, publish, supersede and retire, the owner-only GigMenu read
// model and the readiness FACTS Go-Live (PRO-003) will read. A Gig is NOT live and NOT bookable; publishing a version changes nothing about the provider's visibility.
//
// Ownership and boundaries: the Gig template (CAT-002) is read through the GigTemplatePort (facts about an EXACT template version, never copied); the account and its roles through the
// AccountPort; the policy (limits and text lengths) is configuration. The provider's market is the market of the account's COMPLETED registration, and the price currency is the
// currency of that market, derived here and never accepted from a client. EVERY query filters by the account of the authenticated request: a Gig or version of another account is
// GIG_NOT_FOUND / GIG_VERSION_NOT_FOUND, indistinguishable from one that does not exist.
//
// Transactions and locks: every mutation locks the ACCOUNT row first (the ID-001 order), then the Gig row, then the version rows. Template and policy reads (catalog reads open their
// own repeatable-read snapshots, which cannot nest) happen BEFORE the transaction; the rules that can race with a template or service type retirement are enforced again by the database
// guards under FOR SHARE locks, and the facts of the account are read again under the account lock. Audit rows hold identifiers, changed field NAMES and counts, never the provider's
// text; events hold identifiers only.
import { randomUUID } from 'node:crypto';
import {
  CreateGigRequest,
  CreateGigVersionRequest,
  GIG_EVENTS,
  PublishGigRequest,
  RetireGigRequest,
  UpdateGigDraftRequest,
  type GigCreatedPayload,
  type GigDetailDto,
  type GigIssueDto,
  type GigMenuDto,
  type GigReadinessDto,
  type GigRetiredPayload,
  type GigTemplateChoicesDto,
  type GigTemplateLinkDto,
  type GigVersionDto,
  type GigVersionPublishedPayload,
  type ProviderGigPolicy,
} from '@bananagig/contracts';
import { sql, type Database, type DatabaseSchema, type Kysely, type Trx } from '@bananagig/database';
import { getCorrelationId, log } from '@bananagig/observability';
import { insertOutboxEvent } from '@bananagig/platform';
import type { z } from 'zod';
import { PROVIDER_ROLE_CODE } from './evaluator';
import { ProviderError, isDatabaseOutage } from './errors';
import { GigError } from './gig-errors';
import type { GigPolicyProvider, GigTemplatePort, GigTemplateStructure } from './gig-types';
import {
  gigDto,
  columnsOf,
  contentOf,
  summaryDto,
  toGigRow,
  toVersionRow,
  valueOfRow,
  versionDto,
  linkDto,
  type GigRow,
  type Row,
  type VersionRow,
} from './gig-view';
import { completenessIssues, issue, validateDraftInput, type FieldValue } from './gig-validate';
import { guardRuleOf } from './service';
import type { AccountFacts, AccountPort, PrerequisitePort, PrerequisiteState } from './types';

type Executor = Kysely<DatabaseSchema> | Trx;

export interface ProviderGigServiceDeps {
  database: Database;
  accounts: AccountPort;
  templates: GigTemplatePort;
  policy: GigPolicyProvider;
}

// ---------------------------------------------------------------- errors
export type GigGuardContext = 'create' | 'draft' | 'publish' | 'retire';

const concurrent = () =>
  new GigError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', { reason: 'CONCURRENT_UPDATE', retryable: true });

/** The template-side guard rules: what they mean when a Gig is created or a draft is started (the template is not available) and when it is published (the publish is blocked). */
const TEMPLATE_UNAVAILABLE_REASON: Record<string, string> = {
  TEMPLATE_NOT_ACTIVE: 'TEMPLATE_INACTIVE',
  TEMPLATE_RETIRED: 'TEMPLATE_RETIRED',
  TEMPLATE_VERSION_RETIRED: 'TEMPLATE_RETIRED',
  TEMPLATE_VERSION_NOT_ACTIVE: 'NO_ACTIVE_VERSION',
  SERVICE_TYPE_NOT_ACTIVE: 'SERVICE_TYPE_NOT_ACTIVE',
  SERVICE_TYPE_RETIRED: 'SERVICE_TYPE_NOT_ACTIVE',
};

/**
 * The account port belongs to the registration domain and throws ProviderError (ACCOUNT_NOT_ACTIVE, UNAVAILABLE, a retryable CONFLICT). The Gig service speaks GigError only, so
 * the translation lives here: the callers (and the API) never see another domain's error type. Any other error is rethrown unchanged.
 */
export function translateAccountError(err: unknown): never {
  if (err instanceof ProviderError) {
    if (err.code === 'UNAVAILABLE') throw new GigError('UNAVAILABLE', 'the provider Gigs are unavailable');
    if (err.code === 'CONFLICT') throw concurrent();
    if (err.code === 'ACCOUNT_NOT_ACTIVE') throw new GigError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: 'ACCOUNT_NOT_ACTIVE' });
  }
  throw err;
}

/**
 * Translates database constraint, guard and concurrency failures into typed errors with fixed messages (no driver text, no SQL, no table names). Guard failures are classified by
 * `error.detail` (`provider_rule:<KEY>`), concurrency by SQLSTATE. `context` says what the caller was doing: a template withdrawn while a version is being PUBLISHED blocks the publish.
 */
export function mapGigDbError(err: unknown, context: GigGuardContext = 'draft'): never {
  if (err instanceof ProviderError) translateAccountError(err);
  if (err instanceof GigError || err === null || typeof err !== 'object') throw err;
  const e = err as { code?: string; detail?: string };
  if (e.code === '40P01' || e.code === '40001' || e.code === '55P03' || e.code === '23505') throw concurrent();
  if (e.code === '22021' || e.code === '22P05')
    throw new GigError('VALIDATION_FAILED', 'the request contains a character that is not allowed', { reason: 'FORBIDDEN_CHARACTER' });
  if (e.code === '23000') {
    const rule = guardRuleOf(e.detail);
    switch (rule) {
      case 'ACCOUNT_NOT_ACTIVE':
        throw new GigError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: rule });
      case 'REGISTRATION_NOT_COMPLETED':
        throw new GigError('PROVIDER_NOT_ELIGIBLE', 'the provider registration is not completed', { reason: 'REGISTRATION_NOT_COMPLETED' });
      case 'SERVICE_NOT_SELECTED':
        throw new GigError('PROVIDER_NOT_ELIGIBLE', 'the service type was not selected at registration', { reason: 'SERVICE_NOT_SELECTED' });
      case 'GIG_RETIRED':
        throw new GigError('GIG_RETIRED', 'the Gig is retired', { reason: rule });
      case 'TEMPLATE_NOT_ACTIVE':
      case 'TEMPLATE_RETIRED':
      case 'TEMPLATE_VERSION_RETIRED':
      case 'TEMPLATE_VERSION_NOT_ACTIVE':
      case 'SERVICE_TYPE_NOT_ACTIVE':
      case 'SERVICE_TYPE_RETIRED':
        if (context === 'publish')
          throw new GigError('PUBLISH_BLOCKED', 'the Gig cannot be published', { reason: rule, issues: [issue('template', 'TEMPLATE_VERSION_RETIRED')] });
        throw new GigError('GIG_TEMPLATE_NOT_AVAILABLE', 'the Gig Template is not available', { reason: TEMPLATE_UNAVAILABLE_REASON[rule]! });
      case 'PRICE_NOT_PERMITTED':
        throw new GigError('VALIDATION_FAILED', 'the request is not valid', { reason: rule, issues: [issue('price', 'PRICE_NOT_PERMITTED')] });
      case 'DURATION_NOT_PERMITTED':
        throw new GigError('VALIDATION_FAILED', 'the request is not valid', { reason: rule, issues: [issue('duration', 'DURATION_NOT_PERMITTED')] });
      case 'DURATION_RANGE':
        throw new GigError('VALIDATION_FAILED', 'the request is not valid', { reason: rule, issues: [issue('duration', 'DURATION_OUT_OF_RANGE')] });
      case 'PRICE_CURRENCY':
        // the market currency changed under a stored price: the price must be entered again (never an untyped integrity failure, never provider text)
        if (context === 'publish')
          throw new GigError('PUBLISH_BLOCKED', 'the Gig cannot be published', { reason: rule, issues: [issue('price', 'PRICE_REQUIRED')] });
        throw new GigError('VALIDATION_FAILED', 'the request is not valid', { reason: rule, issues: [issue('price', 'PRICE_REQUIRED')] });
      case 'FIELD_TYPE_MISMATCH':
        throw new GigError('VALIDATION_FAILED', 'the request is not valid', { reason: rule, issues: [issue('field', 'FIELD_VALUE_INVALID')] });
      case 'FIELD_FIXED':
        throw new GigError('VALIDATION_FAILED', 'the request is not valid', { reason: rule, issues: [issue('field', 'FIELD_NOT_PROVIDER_EDITABLE')] });
      case 'FIELD_TYPE_UNSUPPORTED':
        throw new GigError('VALIDATION_FAILED', 'the request is not valid', { reason: rule, issues: [issue('field', 'FIELD_TYPE_NOT_SUPPORTED')] });
      case 'FIELD_NOT_IN_TEMPLATE_VERSION':
        throw new GigError('VALIDATION_FAILED', 'the request is not valid', { reason: rule, issues: [issue('field', 'FIELD_UNKNOWN')] });
      default:
        throw new GigError('CONFLICT', 'the operation violates a Gig integrity rule', rule ? { reason: rule } : {});
    }
  }
  if (e.code === '23514' || e.code === '23502') throw new GigError('VALIDATION_FAILED', 'the request is not valid', { reason: 'INVALID_VALUE' });
  if (e.code === '23503') throw new GigError('VALIDATION_FAILED', 'a referenced record does not exist', { reason: 'REFERENCE_NOT_FOUND' });
  if (isDatabaseOutage(err)) {
    log('error', 'provider gig database unavailable', { error: err instanceof Error ? err.message : String(err) });
    throw new GigError('UNAVAILABLE', 'the provider Gigs are unavailable');
  }
  throw err;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw new GigError('VALIDATION_FAILED', 'the request is not valid', {
    field: typeof first?.path[0] === 'string' ? first.path[0] : undefined,
    reason: 'INVALID_REQUEST',
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new GigError('GIG_NOT_FOUND', 'the Gig was not found', {});
/** An id that is not a UUID can never be owned: refused before any statement (the same answer as an unknown or foreign Gig). */
const assertGigId = (gigId: string): void => {
  if (typeof gigId !== 'string' || !UUID.test(gigId)) throw notFound();
};
const actorOf = (accountId: string): string => `account:${accountId}`;
const unavailableTemplate = () => new GigError('UNAVAILABLE', 'the Gig Template is unavailable', { reason: 'TEMPLATE_UNAVAILABLE' });

// ---------------------------------------------------------------- shared SQL
const gigSelect = sql`SELECT g.gig_id, g.account_id, g.status, g.gig_template_id, t.code AS template_code, t.name_content_key, st.code AS service_type_code, c.code AS category_code,
       g.created_at, g.updated_at, g.retired_at
  FROM provider.gigs g
  JOIN catalog.gig_templates t ON t.gig_template_id = g.gig_template_id
  JOIN catalog.service_types st ON st.service_type_id = t.service_type_id
  JOIN catalog.categories c ON c.category_id = st.category_id`;
const versionSelect = sql`SELECT v.*, tv.version_number AS template_version_number
  FROM provider.gig_versions v JOIN catalog.gig_template_versions tv ON tv.gig_template_version_id = v.gig_template_version_id`;

/** The COMPLETED registration of an account: its market (with the currency) and the codes of the service types it selected. */
interface RegistrationFacts {
  marketCode: string;
  currency: string;
  serviceTypeCodes: string[];
}

/** Why an account cannot create or publish Gigs; null when it can. */
type IneligibleReason = 'ACCOUNT_NOT_ACTIVE' | 'ROLE_NOT_ACTIVE' | 'REGISTRATION_NOT_COMPLETED';
function ineligibility(facts: AccountFacts, registration: RegistrationFacts | null): IneligibleReason | null {
  if (facts.status !== 'ACTIVE') return 'ACCOUNT_NOT_ACTIVE';
  if (facts.memberships.find((m) => m.code === PROVIDER_ROLE_CODE)?.status !== 'ACTIVE') return 'ROLE_NOT_ACTIVE';
  if (!registration) return 'REGISTRATION_NOT_COMPLETED';
  return null;
}
function assertEligible(facts: AccountFacts, registration: RegistrationFacts | null): RegistrationFacts {
  const why = ineligibility(facts, registration);
  if (why === 'ACCOUNT_NOT_ACTIVE') throw new GigError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: why });
  if (why !== null) throw new GigError('PROVIDER_NOT_ELIGIBLE', 'the account is not an eligible provider', { reason: why });
  return registration!;
}

/** Why a NEW Gig cannot be built from this template structure now (null = it can). */
function unavailableReason(s: GigTemplateStructure): string | null {
  if (s.templateStatus === 'RETIRED') return 'TEMPLATE_RETIRED';
  if (s.templateStatus !== 'ACTIVE') return 'TEMPLATE_INACTIVE';
  if (s.serviceTypeStatus !== 'ACTIVE') return 'SERVICE_TYPE_NOT_ACTIVE';
  if (s.versionStatus !== 'ACTIVE') return 'NO_ACTIVE_VERSION';
  return null;
}

export class ProviderGigService {
  constructor(protected readonly deps: ProviderGigServiceDeps) {}

  private get db(): Executor {
    return this.deps.database.db;
  }
  private tx<T>(context: GigGuardContext, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.deps.database.transaction(fn).catch((e) => mapGigDbError(e, context));
  }
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      return mapGigDbError(e);
    }
  }

  // ------------------------------------------------------------------ shared reads
  private async loadRegistration(ex: Executor, accountId: string): Promise<RegistrationFacts | null> {
    const r = (
      await sql<Row>`SELECT m.code AS market_code, m.currency_code,
             COALESCE((SELECT array_agg(st.code ORDER BY st.code COLLATE "C") FROM provider.registration_service_types rs JOIN catalog.service_types st ON st.service_type_id = rs.service_type_id
                        WHERE rs.provider_registration_id = r.provider_registration_id), '{}') AS service_type_codes
        FROM provider.registrations r JOIN geography.markets m ON m.market_id = r.market_id
       WHERE r.account_id = ${accountId} AND r.status = 'COMPLETED'`.execute(ex)
    ).rows[0];
    return r
      ? {
          marketCode: r.market_code as string,
          currency: (r.currency_code as string).trim(),
          serviceTypeCodes: ((r.service_type_codes as string[] | null) ?? []).slice(),
        }
      : null;
  }

  /** The Gig of the account (never by id alone). */
  private async loadGig(ex: Executor, accountId: string, gigId: string): Promise<GigRow> {
    if (!UUID.test(gigId)) throw notFound();
    const r = (await sql<Row>`${gigSelect} WHERE g.gig_id = ${gigId} AND g.account_id = ${accountId}`.execute(ex)).rows[0];
    if (!r) throw notFound();
    return toGigRow(r);
  }
  private async loadVersions(ex: Executor, gigId: string): Promise<VersionRow[]> {
    return (await sql<Row>`${versionSelect} WHERE v.gig_id = ${gigId} ORDER BY v.version_number DESC`.execute(ex)).rows.map(toVersionRow);
  }
  /** The field values of the given versions, by version id then field key. */
  private async loadValues(
    ex: Executor,
    versions: readonly VersionRow[],
    structures: ReadonlyMap<string, GigTemplateStructure>,
  ): Promise<Map<string, Map<string, FieldValue>>> {
    const out = new Map<string, Map<string, FieldValue>>(versions.map((v) => [v.gigVersionId, new Map()]));
    if (versions.length === 0) return out;
    const ids = versions.map((v) => v.gigVersionId);
    const rows = (
      await sql<Row>`SELECT gig_version_id, gig_template_field_id, text_value, integer_value, decimal_value, boolean_value, option_code, duration_minutes
        FROM provider.gig_version_field_values WHERE gig_version_id = ANY(${ids}::uuid[])`.execute(ex)
    ).rows;
    const tvOf = new Map(versions.map((v) => [v.gigVersionId, v.gigTemplateVersionId]));
    for (const r of rows) {
      const structure = structures.get(tvOf.get(r.gig_version_id as string)!);
      const field = structure?.fields.find((f) => f.gigTemplateFieldId === (r.gig_template_field_id as string));
      if (!field) continue;
      const value = valueOfRow(field, r);
      if (value !== undefined) out.get(r.gig_version_id as string)!.set(field.fieldKey, value);
    }
    return out;
  }
  /** The exact template structure of each distinct version, read through the port (never inside a transaction). */
  private async loadStructures(
    templateVersionIds: readonly string[],
    known?: ReadonlyMap<string, GigTemplateStructure>,
  ): Promise<Map<string, GigTemplateStructure>> {
    const out = new Map<string, GigTemplateStructure>();
    for (const id of new Set(templateVersionIds)) {
      // a version bound to a Gig never changes: what was read before a transaction is exactly what the answer after it needs
      const s = known?.get(id) ?? (await this.deps.templates.exactVersion(id));
      if (!s) throw unavailableTemplate();
      out.set(id, s);
    }
    return out;
  }
  private async marketCurrency(accountId: string): Promise<string | null> {
    return (await this.read(() => this.loadRegistration(this.db, accountId)))?.currency ?? null;
  }

  /** The DTOs of the given versions of a Gig (one values query, one port read per distinct template version). */
  private async buildVersions(
    accountId: string,
    versions: readonly VersionRow[],
    policy: ProviderGigPolicy,
    ex: Executor = this.db,
    known?: ReadonlyMap<string, GigTemplateStructure>,
  ): Promise<Map<string, GigVersionDto>> {
    const [structures, currency] = await Promise.all([
      this.loadStructures(
        versions.map((v) => v.gigTemplateVersionId),
        known,
      ),
      this.marketCurrency(accountId),
    ]);
    const values = await this.read(() => this.loadValues(ex, versions, structures));
    return new Map(
      versions.map((v) => [v.gigVersionId, versionDto(v, structures.get(v.gigTemplateVersionId)!, values.get(v.gigVersionId)!, policy, currency)]),
    );
  }

  // ------------------------------------------------------------------ audit and events
  private audit(trx: Trx, cid: string, a: { accountId: string; action: string; gigId: string; gigVersionId?: string; changes?: Record<string, unknown> }) {
    return sql`INSERT INTO provider.gig_audit_events (actor, action, account_id, gig_id, gig_version_id, changes, correlation_id)
      VALUES (${actorOf(a.accountId)}, ${a.action}, ${a.accountId}, ${a.gigId}, ${a.gigVersionId ?? null}, ${a.changes ? JSON.stringify(a.changes) : null}::jsonb, ${cid})`.execute(
      trx,
    );
  }
  private event(trx: Trx, cid: string, type: string, gigId: string, accountId: string, payload: Record<string, unknown>) {
    return insertOutboxEvent(trx, {
      aggregateType: 'provider-gig',
      aggregateId: gigId,
      eventType: type,
      actorType: 'user',
      actorId: actorOf(accountId),
      correlationId: cid,
      payload,
    });
  }

  // ------------------------------------------------------------------ locks
  /** The first lock of the ID-001 order: the account row, which must be ACTIVE. */
  private async lockAccount(trx: Trx, accountId: string): Promise<void> {
    const r = (await sql<Row>`SELECT status FROM identity.accounts WHERE account_id = ${accountId} FOR UPDATE`.execute(trx)).rows[0];
    if (!r || r.status !== 'ACTIVE') throw new GigError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: 'ACCOUNT_NOT_ACTIVE' });
  }
  /** The second lock: the Gig row of the account (a bare single-table statement, then the joined read). */
  private async lockGig(trx: Trx, accountId: string, gigId: string): Promise<GigRow> {
    if (!UUID.test(gigId)) throw notFound();
    const locked = (await sql<Row>`SELECT gig_id FROM provider.gigs WHERE gig_id = ${gigId} AND account_id = ${accountId} FOR UPDATE`.execute(trx)).rows[0];
    if (!locked) throw notFound();
    return this.loadGig(trx, accountId, gigId);
  }
  private async countDrafts(trx: Trx, accountId: string): Promise<number> {
    return Number(
      (
        await sql<Row>`SELECT count(*) AS n FROM provider.gig_versions v JOIN provider.gigs g ON g.gig_id = v.gig_id WHERE g.account_id = ${accountId} AND v.status = 'DRAFT'`.execute(
          trx,
        )
      ).rows[0]!.n,
    );
  }

  // ------------------------------------------------------------------ eligibility and templates
  /** The account facts through the identity port, with its errors translated (see translateAccountError). */
  private async facts(accountId: string): Promise<AccountFacts> {
    try {
      return await this.deps.accounts.facts(accountId);
    } catch (e) {
      return translateAccountError(e);
    }
  }
  /** The template version ids a Gig's versions are bound to (the Gig must be the account's). */
  private async boundTemplateVersionIds(accountId: string, gigId: string): Promise<string[]> {
    return this.read(async () => {
      await this.loadGig(this.db, accountId, gigId);
      return (await sql<Row>`SELECT DISTINCT gig_template_version_id FROM provider.gig_versions WHERE gig_id = ${gigId}`.execute(this.db)).rows.map(
        (r) => r.gig_template_version_id as string,
      );
    });
  }

  /** The facts that decide eligibility, read BEFORE a transaction. */
  private async eligibilityFacts(accountId: string): Promise<{ facts: AccountFacts; registration: RegistrationFacts | null }> {
    const [facts, registration] = await Promise.all([this.facts(accountId), this.read(() => this.loadRegistration(this.db, accountId))]);
    return { facts, registration };
  }

  /** The Gig Templates the account can start a Gig from now (its market's offering restricted to the service types of its completed registration). */
  async listGigTemplates(accountId: string): Promise<GigTemplateChoicesDto> {
    const { facts, registration } = await this.eligibilityFacts(accountId);
    if (ineligibility(facts, registration) !== null || !registration) return { marketCode: registration?.marketCode ?? null, templates: [] };
    const offered = await this.deps.templates.offered(registration.marketCode, registration.serviceTypeCodes);
    return {
      marketCode: registration.marketCode,
      templates: offered
        .filter((o) => registration.serviceTypeCodes.includes(o.serviceTypeCode))
        .map((o) => ({
          gigTemplateCode: o.gigTemplateCode,
          serviceTypeCode: o.serviceTypeCode,
          categoryCode: o.categoryCode,
          nameContentKey: o.nameContentKey,
          descriptionContentKey: o.descriptionContentKey,
          gigTemplateVersionNumber: o.versionNumber,
        })),
    };
  }

  // ------------------------------------------------------------------ reads
  /** GigMenu (owner-only): every Gig of the account with its current version and draft, in constant queries, plus readiness and limits. */
  async listProviderGigs(accountId: string): Promise<GigMenuDto> {
    const policy = await this.deps.policy.policy();
    const { facts, registration } = await this.eligibilityFacts(accountId);
    const { gigs, versions, counts } = await this.read(async () => {
      const gigRows = (await sql<Row>`${gigSelect} WHERE g.account_id = ${accountId} ORDER BY g.created_at DESC, g.gig_id`.execute(this.db)).rows.map(toGigRow);
      const versionRows = (
        await sql<Row>`${versionSelect} JOIN provider.gigs g ON g.gig_id = v.gig_id WHERE g.account_id = ${accountId} AND v.status IN ('PUBLISHED', 'DRAFT')`.execute(
          this.db,
        )
      ).rows.map(toVersionRow);
      const countRows = (
        await sql<Row>`SELECT v.gig_id, count(*) AS n FROM provider.gig_versions v JOIN provider.gigs g ON g.gig_id = v.gig_id WHERE g.account_id = ${accountId} GROUP BY v.gig_id`.execute(
          this.db,
        )
      ).rows;
      return { gigs: gigRows, versions: versionRows, counts: new Map(countRows.map((r) => [r.gig_id as string, Number(r.n)])) };
    });
    const published = new Map(versions.filter((v) => v.status === 'PUBLISHED').map((v) => [v.gigId, v]));
    const drafts = new Map(versions.filter((v) => v.status === 'DRAFT').map((v) => [v.gigId, v]));
    const activeCount = gigs.filter((g) => g.status === 'ACTIVE').length;
    const draftCount = drafts.size;
    const ineligible = ineligibility(facts, registration);
    const cannotCreateReason =
      ineligible !== null ? ('PROVIDER_NOT_ELIGIBLE' as const) : draftCount >= policy.maxDrafts ? ('DRAFT_LIMIT_REACHED' as const) : null;
    return {
      gigs: gigs.map((g) => {
        const cur = published.get(g.gigId);
        const dr = drafts.get(g.gigId);
        return {
          gig: gigDto(g),
          currentVersion: cur
            ? {
                versionNumber: cur.versionNumber,
                title: cur.title,
                shortPitch: cur.shortPitch,
                price: cur.priceAmountMinor === null || cur.priceCurrency === null ? null : { amountMinor: cur.priceAmountMinor, currency: cur.priceCurrency },
                durationMinutes: cur.durationMinutes,
                publishedAt: cur.publishedAt!,
              }
            : null,
          draftVersion: dr ? { versionNumber: dr.versionNumber, revision: dr.revision, title: dr.title, updatedAt: dr.updatedAt } : null,
          versionCount: counts.get(g.gigId) ?? 0,
        };
      }),
      readiness: {
        hasPublishedGig: published.size > 0,
        publishedGigCount: published.size,
        draftVersionCount: draftCount,
        goLive: { evaluated: false, eligible: false },
      },
      limits: { maxActive: policy.maxActive, maxDrafts: policy.maxDrafts, activeCount, draftCount },
      canCreate: cannotCreateReason === null,
      cannotCreateReason,
    };
  }

  /**
   * The detail of a Gig. After a commit it is given the template structures that were read BEFORE the transaction (`known`), so a template port failure after the change cannot turn a
   * committed mutation into an error; only the database is read.
   */
  private async detailOf(accountId: string, gigId: string, known?: ReadonlyMap<string, GigTemplateStructure>): Promise<GigDetailDto> {
    assertGigId(gigId);
    const policy = await this.deps.policy.policy();
    const { gig, versions } = await this.read(async () => ({
      gig: await this.loadGig(this.db, accountId, gigId),
      versions: await this.loadVersions(this.db, gigId),
    }));
    const current = versions.find((v) => v.status === 'PUBLISHED') ?? null;
    const draft = versions.find((v) => v.status === 'DRAFT') ?? null;
    const dtos = await this.buildVersions(
      accountId,
      [current, draft].filter((v): v is VersionRow => v !== null),
      policy,
      this.db,
      known,
    );
    return {
      gig: gigDto(gig),
      currentVersion: current ? dtos.get(current.gigVersionId)! : null,
      draftVersion: draft ? dtos.get(draft.gigVersionId)! : null,
      versions: versions.map(summaryDto),
    };
  }

  async getGig(accountId: string, gigId: string): Promise<GigDetailDto> {
    return this.detailOf(accountId, gigId);
  }

  async getGigVersion(accountId: string, gigId: string, versionNumber: number): Promise<GigVersionDto> {
    assertGigId(gigId);
    if (!Number.isSafeInteger(versionNumber) || versionNumber < 1 || versionNumber > 2_147_483_647) {
      await this.read(() => this.loadGig(this.db, accountId, gigId));
      throw new GigError('GIG_VERSION_NOT_FOUND', 'the Gig version was not found', {});
    }
    const policy = await this.deps.policy.policy();
    const version = await this.read(async () => {
      await this.loadGig(this.db, accountId, gigId);
      return (await sql<Row>`${versionSelect} WHERE v.gig_id = ${gigId} AND v.version_number = ${versionNumber}`.execute(this.db)).rows.map(toVersionRow)[0];
    });
    if (!version) throw new GigError('GIG_VERSION_NOT_FOUND', 'the Gig version was not found', {});
    return (await this.buildVersions(accountId, [version], policy)).get(version.gigVersionId)!;
  }

  /** The current PUBLISHED version of a Gig of the account, or null. */
  async getCurrentPublishedGigVersion(accountId: string, gigId: string): Promise<GigVersionDto | null> {
    assertGigId(gigId);
    const policy = await this.deps.policy.policy();
    const version = await this.read(async () => {
      await this.loadGig(this.db, accountId, gigId);
      return (await sql<Row>`${versionSelect} WHERE v.gig_id = ${gigId} AND v.status = 'PUBLISHED'`.execute(this.db)).rows.map(toVersionRow)[0];
    });
    if (!version) return null;
    return (await this.buildVersions(accountId, [version], policy)).get(version.gigVersionId)!;
  }

  /** Facts for Go-Live (PRO-003) and the onboarding GIGS step. Never says live or eligible. One statement. */
  async getGigReadinessFacts(accountId: string): Promise<GigReadinessDto> {
    const r = (
      await this.read(() =>
        sql<Row>`SELECT count(*) FILTER (WHERE v.status = 'PUBLISHED') AS published, count(*) FILTER (WHERE v.status = 'DRAFT') AS drafts
            FROM provider.gig_versions v JOIN provider.gigs g ON g.gig_id = v.gig_id WHERE g.account_id = ${accountId}`.execute(this.db),
      )
    ).rows[0]!;
    const published = Number(r.published);
    return { hasPublishedGig: published > 0, publishedGigCount: published, draftVersionCount: Number(r.drafts), goLive: { evaluated: false, eligible: false } };
  }

  /** The exact template link (template version, requirement hooks) of a version of a Gig of the account (default: the current published version, else the draft, else the newest). */
  async getGigTemplateLink(accountId: string, gigId: string, versionNumber?: number): Promise<GigTemplateLinkDto> {
    assertGigId(gigId);
    const version = await this.read(async () => {
      await this.loadGig(this.db, accountId, gigId);
      const all = await this.loadVersions(this.db, gigId);
      if (versionNumber !== undefined) return all.find((v) => v.versionNumber === versionNumber);
      return all.find((v) => v.status === 'PUBLISHED') ?? all.find((v) => v.status === 'DRAFT') ?? all[0];
    });
    if (!version) throw new GigError('GIG_VERSION_NOT_FOUND', 'the Gig version was not found', {});
    const s = await this.deps.templates.exactVersion(version.gigTemplateVersionId);
    if (!s) throw unavailableTemplate();
    return linkDto(s);
  }

  // ------------------------------------------------------------------ create
  private async findByClientRequest(ex: Executor, accountId: string, clientRequestId: string): Promise<GigRow | null> {
    const r = (await sql<Row>`${gigSelect} WHERE g.account_id = ${accountId} AND g.client_request_id = ${clientRequestId}`.execute(ex)).rows[0];
    return r ? toGigRow(r) : null;
  }
  private replay(existing: GigRow, wanted: string) {
    if (existing.gigTemplateCode !== wanted)
      throw new GigError('CONFLICT', 'the request id was already used for another Gig', { reason: 'CLIENT_REQUEST_ID_REUSED' });
  }

  /** Resolves the template a NEW Gig is built from and says exactly why it cannot be when it cannot. */
  private async templateForCreate(registration: RegistrationFacts, code: string): Promise<GigTemplateStructure> {
    const direct = await this.deps.templates.forCreate(registration.marketCode, code);
    const s = direct ?? (await this.deps.templates.byCode(code));
    if (!s) throw new GigError('GIG_TEMPLATE_NOT_FOUND', 'the Gig Template was not found', {});
    if (!registration.serviceTypeCodes.includes(s.serviceTypeCode))
      throw new GigError('PROVIDER_NOT_ELIGIBLE', 'the service type was not selected at registration', { reason: 'SERVICE_NOT_SELECTED' });
    const why = unavailableReason(s);
    if (why !== null) throw new GigError('GIG_TEMPLATE_NOT_AVAILABLE', 'the Gig Template is not available', { reason: why });
    if (!direct) throw new GigError('GIG_TEMPLATE_NOT_AVAILABLE', 'the Gig Template is not available', { reason: 'TEMPLATE_NOT_IN_MARKET' });
    return s;
  }

  /** Creates the Gig identity and its first DRAFT version. `created: false` when the same clientRequestId already created one. */
  async createGig(accountId: string, input: unknown): Promise<{ created: boolean; detail: GigDetailDto }> {
    const body = parseInput(CreateGigRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const policy = await this.deps.policy.policy();
    if (body.clientRequestId) {
      const existing = await this.read(() => this.findByClientRequest(this.db, accountId, body.clientRequestId!));
      if (existing) {
        this.replay(existing, body.gigTemplateCode);
        return { created: false, detail: await this.detailOf(accountId, existing.gigId) };
      }
    }
    // everything of other domains is read BEFORE the transaction
    const pre = await this.eligibilityFacts(accountId);
    const registration = assertEligible(pre.facts, pre.registration);
    const template = await this.templateForCreate(registration, body.gigTemplateCode);
    const result = await this.tx('create', async (trx) => {
      await this.lockAccount(trx, accountId);
      if (body.clientRequestId) {
        const existing = await this.findByClientRequest(trx, accountId, body.clientRequestId);
        if (existing) {
          this.replay(existing, body.gigTemplateCode);
          return { created: false, gigId: existing.gigId };
        }
      }
      // the account facts are read again under the lock: the role can change between the first read and here
      assertEligible(await this.facts(accountId), await this.loadRegistration(trx, accountId));
      const drafts = await this.countDrafts(trx, accountId);
      if (drafts >= policy.maxDrafts)
        throw new GigError('LIMIT_REACHED', 'the draft limit is reached', { reason: 'DRAFT_LIMIT_REACHED', limit: policy.maxDrafts });
      const gig = (
        await sql<Row>`INSERT INTO provider.gigs (account_id, gig_template_id, client_request_id)
          VALUES (${accountId}, ${template.gigTemplateId}, ${body.clientRequestId ?? null}) RETURNING gig_id`.execute(trx)
      ).rows[0]!;
      const gigId = gig.gig_id as string;
      const version = (
        await sql<Row>`INSERT INTO provider.gig_versions (gig_id, version_number, gig_template_version_id)
          VALUES (${gigId}, 1, ${template.gigTemplateVersionId}) RETURNING gig_version_id`.execute(trx)
      ).rows[0]!;
      const versionId = version.gig_version_id as string;
      await this.audit(trx, cid, {
        accountId,
        action: 'GIG_CREATED',
        gigId,
        changes: { status: [null, 'DRAFT'], versionNumber: 1, replayable: body.clientRequestId !== undefined },
      });
      await this.audit(trx, cid, {
        accountId,
        action: 'GIG_DRAFT_CREATED',
        gigId,
        gigVersionId: versionId,
        changes: { versionNumber: 1, revision: 1, copiedFromVersion: null },
      });
      const payload: GigCreatedPayload = { accountId, gigId, gigVersionId: versionId, gigTemplateVersionId: template.gigTemplateVersionId };
      await this.event(trx, cid, GIG_EVENTS.gigCreated, gigId, accountId, payload);
      return { created: true, gigId };
    });
    return { created: result.created, detail: await this.detailOf(accountId, result.gigId, new Map([[template.gigTemplateVersionId, template]])) };
  }

  // ------------------------------------------------------------------ next draft
  /** Starts the next DRAFT from the current published version of an ACTIVE Gig (same template version; content and field values copied). */
  async createNextDraft(accountId: string, gigId: string, input: unknown): Promise<GigDetailDto> {
    parseInput(CreateGigVersionRequest, input);
    assertGigId(gigId);
    const cid = getCorrelationId() ?? randomUUID();
    const policy = await this.deps.policy.policy();
    // the template structures are read before the transaction and reused for the answer after it
    const known = await this.loadStructures(await this.boundTemplateVersionIds(accountId, gigId));
    await this.tx('create', async (trx) => {
      await this.lockAccount(trx, accountId);
      const gig = await this.lockGig(trx, accountId, gigId);
      if (gig.status === 'RETIRED') throw new GigError('GIG_RETIRED', 'the Gig is retired', { reason: 'GIG_RETIRED' });
      const live = (
        await sql<Row>`SELECT gig_version_id, version_number, status, price_amount_minor IS NOT NULL AS has_price, price_currency FROM provider.gig_versions WHERE gig_id = ${gigId} AND status IN ('DRAFT', 'PUBLISHED') ORDER BY version_number FOR UPDATE`.execute(
          trx,
        )
      ).rows;
      if (live.some((v) => v.status === 'DRAFT')) throw new GigError('DRAFT_EXISTS', 'the Gig already has a draft', { reason: 'DRAFT_EXISTS' });
      const published = live.find((v) => v.status === 'PUBLISHED');
      if (!published) throw new GigError('NO_DRAFT', 'the Gig has no published version to start from', { reason: 'NOTHING_PUBLISHED' });
      const drafts = await this.countDrafts(trx, accountId);
      if (drafts >= policy.maxDrafts)
        throw new GigError('LIMIT_REACHED', 'the draft limit is reached', { reason: 'DRAFT_LIMIT_REACHED', limit: policy.maxDrafts });
      const next = Number((await sql<Row>`SELECT max(version_number) + 1 AS n FROM provider.gig_versions WHERE gig_id = ${gigId}`.execute(trx)).rows[0]!.n);
      const publishedId = published.gig_version_id as string;
      // the currency of a price is the provider's market currency NOW: a price stored in another currency (the market changed) is not carried over, the provider enters it again
      const currency = (await this.loadRegistration(trx, accountId))?.currency ?? null;
      const priceCopied = published.has_price === true && currency !== null && String(published.price_currency).trim() === currency;
      const created = (
        await sql<Row>`INSERT INTO provider.gig_versions (gig_id, version_number, gig_template_version_id, title, short_pitch, description, price_amount_minor, price_currency, duration_minutes)
          SELECT gig_id, ${next}, gig_template_version_id, title, short_pitch, description,
                 CASE WHEN ${priceCopied} THEN price_amount_minor END, CASE WHEN ${priceCopied} THEN price_currency END, duration_minutes
            FROM provider.gig_versions WHERE gig_version_id = ${publishedId} RETURNING gig_version_id`.execute(trx)
      ).rows[0]!;
      const newId = created.gig_version_id as string;
      const copied = Number(
        (
          await sql<Row>`WITH ins AS (
              INSERT INTO provider.gig_version_field_values (gig_version_id, gig_template_field_id, text_value, integer_value, decimal_value, boolean_value, option_code, duration_minutes)
              SELECT ${newId}, gig_template_field_id, text_value, integer_value, decimal_value, boolean_value, option_code, duration_minutes
                FROM provider.gig_version_field_values WHERE gig_version_id = ${publishedId} RETURNING 1)
            SELECT count(*) AS n FROM ins`.execute(trx)
        ).rows[0]!.n,
      );
      await this.audit(trx, cid, {
        accountId,
        action: 'GIG_DRAFT_CREATED',
        gigId,
        gigVersionId: newId,
        changes: { versionNumber: next, revision: 1, copiedFromVersion: Number(published.version_number), fieldValueCount: copied, priceCopied },
      });
    });
    return this.detailOf(accountId, gigId, known);
  }

  // ------------------------------------------------------------------ update draft
  /** The DRAFT of a Gig of the account, with the facts the pre-transaction work needs (no lock). */
  private async preDraft(accountId: string, gigId: string): Promise<{ gig: GigRow; draft: VersionRow }> {
    return this.read(async () => {
      const gig = await this.loadGig(this.db, accountId, gigId);
      if (gig.status === 'RETIRED') throw new GigError('GIG_RETIRED', 'the Gig is retired', { reason: 'GIG_RETIRED' });
      const draft = (await sql<Row>`${versionSelect} WHERE v.gig_id = ${gigId} AND v.status = 'DRAFT'`.execute(this.db)).rows.map(toVersionRow)[0];
      if (!draft) throw new GigError('NO_DRAFT', 'the Gig has no draft', { reason: 'NO_DRAFT' });
      return { gig, draft };
    });
  }
  private stale(): GigError {
    return new GigError('STALE_DRAFT', 'the draft changed since it was read: read it again', { reason: 'STALE_DRAFT' });
  }
  /** Locks the DRAFT row of a (locked) Gig and checks it is the one the caller read at the revision it named. */
  private async lockDraft(trx: Trx, gigId: string, expected: { gigVersionId: string; revision: number }): Promise<void> {
    const r = (await sql<Row>`SELECT gig_version_id, revision FROM provider.gig_versions WHERE gig_id = ${gigId} AND status = 'DRAFT' FOR UPDATE`.execute(trx))
      .rows[0];
    if (!r) throw new GigError('NO_DRAFT', 'the Gig has no draft', { reason: 'NO_DRAFT' });
    if (r.gig_version_id !== expected.gigVersionId || Number(r.revision) !== expected.revision) throw this.stale();
  }

  /** Replaces the whole editable content of the draft (omitted field values are cleared). */
  async updateDraft(accountId: string, gigId: string, input: unknown): Promise<GigDetailDto> {
    const body = parseInput(UpdateGigDraftRequest, input);
    assertGigId(gigId);
    const cid = getCorrelationId() ?? randomUUID();
    const policy = await this.deps.policy.policy();
    const { draft } = await this.preDraft(accountId, gigId);
    if (draft.revision !== body.expectedRevision) throw this.stale();
    const structure = (await this.loadStructures([draft.gigTemplateVersionId])).get(draft.gigTemplateVersionId)!;
    const { content, issues } = validateDraftInput(body, structure, policy);
    if (issues.length > 0) throw new GigError('VALIDATION_FAILED', 'the draft is not valid', { reason: 'DRAFT_INVALID', issues });
    const byKey = new Map(structure.fields.map((f) => [f.fieldKey, f]));
    await this.tx('draft', async (trx) => {
      await this.lockAccount(trx, accountId);
      const gig = await this.lockGig(trx, accountId, gigId);
      if (gig.status === 'RETIRED') throw new GigError('GIG_RETIRED', 'the Gig is retired', { reason: 'GIG_RETIRED' });
      await this.lockDraft(trx, gigId, { gigVersionId: draft.gigVersionId, revision: body.expectedRevision });
      const stored = (await sql<Row>`${versionSelect} WHERE v.gig_version_id = ${draft.gigVersionId}`.execute(trx)).rows.map(toVersionRow)[0]!;
      const existing = (await this.loadValues(trx, [stored], new Map([[stored.gigTemplateVersionId, structure]]))).get(stored.gigVersionId)!;
      // the currency is the provider's market currency, derived here at save time
      const currency = content.priceAmountMinor === null ? null : ((await this.loadRegistration(trx, accountId))?.currency ?? null);
      if (content.priceAmountMinor !== null && currency === null)
        throw new GigError('PROVIDER_NOT_ELIGIBLE', 'the provider registration is not completed', { reason: 'REGISTRATION_NOT_COMPLETED' });
      const changedFields: string[] = [];
      if (stored.title !== content.title) changedFields.push('title');
      if (stored.shortPitch !== content.shortPitch) changedFields.push('shortPitch');
      if (stored.description !== content.description) changedFields.push('description');
      if (stored.priceAmountMinor !== content.priceAmountMinor || stored.priceCurrency !== currency) changedFields.push('price');
      if (stored.durationMinutes !== content.durationMinutes) changedFields.push('duration');
      const changedKeys = [...new Set([...existing.keys(), ...content.values.keys()])].filter((k) => existing.get(k) !== content.values.get(k)).sort();
      if (changedFields.length === 0 && changedKeys.length === 0) return;
      await sql`UPDATE provider.gig_versions SET title = ${content.title}, short_pitch = ${content.shortPitch}, description = ${content.description},
          price_amount_minor = ${content.priceAmountMinor}::bigint, price_currency = ${currency}, duration_minutes = ${content.durationMinutes}::integer,
          revision = revision + 1, updated_at = now() WHERE gig_version_id = ${stored.gigVersionId}`.execute(trx);
      for (const key of changedKeys) {
        const f = byKey.get(key)!;
        const next = content.values.get(key);
        if (next === undefined) {
          await sql`DELETE FROM provider.gig_version_field_values WHERE gig_version_id = ${stored.gigVersionId} AND gig_template_field_id = ${f.gigTemplateFieldId}`.execute(
            trx,
          );
          continue;
        }
        const c = columnsOf(f, next);
        if (existing.has(key))
          await sql`UPDATE provider.gig_version_field_values SET text_value = ${c.text}, integer_value = ${c.integer}::bigint, decimal_value = ${c.decimal}::numeric,
              boolean_value = ${c.bool}::boolean, option_code = ${c.option}, duration_minutes = ${c.duration}::integer, updated_at = now()
            WHERE gig_version_id = ${stored.gigVersionId} AND gig_template_field_id = ${f.gigTemplateFieldId}`.execute(trx);
        else
          await sql`INSERT INTO provider.gig_version_field_values (gig_version_id, gig_template_field_id, text_value, integer_value, decimal_value, boolean_value, option_code, duration_minutes)
            VALUES (${stored.gigVersionId}, ${f.gigTemplateFieldId}, ${c.text}, ${c.integer}::bigint, ${c.decimal}::numeric, ${c.bool}::boolean, ${c.option}, ${c.duration}::integer)`.execute(
            trx,
          );
      }
      await this.audit(trx, cid, {
        accountId,
        action: 'GIG_DRAFT_UPDATED',
        gigId,
        gigVersionId: stored.gigVersionId,
        changes: {
          changedFields,
          changedFieldKeys: changedKeys,
          fieldValueCount: content.values.size,
          revision: [stored.revision, stored.revision + 1],
          versionNumber: stored.versionNumber,
        },
      });
    });
    return this.detailOf(accountId, gigId, new Map([[draft.gigTemplateVersionId, structure]]));
  }

  // ------------------------------------------------------------------ publish
  /** Publishes the draft (optimistic revision): supersedes the previous published version in the same transaction. */
  async publish(accountId: string, gigId: string, input: unknown): Promise<GigDetailDto> {
    const body = parseInput(PublishGigRequest, input);
    assertGigId(gigId);
    const cid = getCorrelationId() ?? randomUUID();
    // other domains and the policy first, never inside the transaction
    const policy = await this.deps.policy.policy();
    const { draft } = await this.preDraft(accountId, gigId);
    if (draft.revision !== body.expectedRevision) throw this.stale();
    const [pre, structure] = await Promise.all([
      this.eligibilityFacts(accountId),
      this.loadStructures([draft.gigTemplateVersionId]).then((m) => m.get(draft.gigTemplateVersionId)!),
    ]);
    const registration = assertEligible(pre.facts, pre.registration);
    if (!registration.serviceTypeCodes.includes(structure.serviceTypeCode))
      throw new GigError('PROVIDER_NOT_ELIGIBLE', 'the service type was not selected at registration', { reason: 'SERVICE_NOT_SELECTED' });
    const withdrawn = structure.versionStatus === 'RETIRED' || structure.templateStatus === 'RETIRED' || structure.serviceTypeStatus === 'RETIRED';
    if (!withdrawn) {
      if (structure.templateStatus !== 'ACTIVE')
        throw new GigError('GIG_TEMPLATE_NOT_AVAILABLE', 'the Gig Template is not available', { reason: 'TEMPLATE_INACTIVE' });
      if (structure.serviceTypeStatus !== 'ACTIVE')
        throw new GigError('GIG_TEMPLATE_NOT_AVAILABLE', 'the Gig Template is not available', { reason: 'SERVICE_TYPE_NOT_ACTIVE' });
      if (!(await this.deps.templates.enabledInMarket(registration.marketCode, structure.gigTemplateId)))
        throw new GigError('GIG_TEMPLATE_NOT_AVAILABLE', 'the Gig Template is not available', { reason: 'TEMPLATE_NOT_IN_MARKET' });
    }
    const values = (await this.read(() => this.loadValues(this.db, [draft], new Map([[draft.gigTemplateVersionId, structure]])))).get(draft.gigVersionId)!;
    // the content cannot change without a new revision, and the transaction checks the revision under the lock, so these issues hold when it commits
    const issues: GigIssueDto[] = completenessIssues(contentOf(draft, values), structure, policy, registration.currency);
    if (issues.length > 0) throw new GigError('PUBLISH_BLOCKED', 'the Gig cannot be published yet', { reason: 'PUBLISH_BLOCKED', issues });
    await this.tx('publish', async (trx) => {
      await this.lockAccount(trx, accountId);
      const gig = await this.lockGig(trx, accountId, gigId);
      if (gig.status === 'RETIRED') throw new GigError('GIG_RETIRED', 'the Gig is retired', { reason: 'GIG_RETIRED' });
      await this.lockDraft(trx, gigId, { gigVersionId: draft.gigVersionId, revision: body.expectedRevision });
      // the role can change between the first read and here
      assertEligible(await this.facts(accountId), await this.loadRegistration(trx, accountId));
      if (gig.status === 'DRAFT') {
        const active = Number(
          (await sql<Row>`SELECT count(*) AS n FROM provider.gigs WHERE account_id = ${accountId} AND status = 'ACTIVE'`.execute(trx)).rows[0]!.n,
        );
        if (active >= policy.maxActive)
          throw new GigError('LIMIT_REACHED', 'the active Gig limit is reached', { reason: 'ACTIVE_LIMIT_REACHED', limit: policy.maxActive });
      }
      const previous = (
        await sql<Row>`SELECT gig_version_id, version_number FROM provider.gig_versions WHERE gig_id = ${gigId} AND status = 'PUBLISHED' FOR UPDATE`.execute(
          trx,
        )
      ).rows[0];
      if (previous) {
        await sql`UPDATE provider.gig_versions SET status = 'SUPERSEDED', superseded_at = now(), updated_at = now() WHERE gig_version_id = ${previous.gig_version_id as string}`.execute(
          trx,
        );
        await this.audit(trx, cid, {
          accountId,
          action: 'GIG_VERSION_SUPERSEDED',
          gigId,
          gigVersionId: previous.gig_version_id as string,
          changes: { status: ['PUBLISHED', 'SUPERSEDED'], versionNumber: Number(previous.version_number), supersededBy: draft.versionNumber },
        });
      }
      await sql`UPDATE provider.gig_versions SET status = 'PUBLISHED', published_at = now(), updated_at = now() WHERE gig_version_id = ${draft.gigVersionId}`.execute(
        trx,
      );
      if (gig.status === 'DRAFT') await sql`UPDATE provider.gigs SET status = 'ACTIVE', updated_at = now() WHERE gig_id = ${gigId}`.execute(trx);
      await this.audit(trx, cid, {
        accountId,
        action: 'GIG_VERSION_PUBLISHED',
        gigId,
        gigVersionId: draft.gigVersionId,
        changes: {
          status: ['DRAFT', 'PUBLISHED'],
          versionNumber: draft.versionNumber,
          revision: draft.revision,
          fieldValueCount: values.size,
          gigStatus: [gig.status, 'ACTIVE'],
          supersededVersion: previous ? Number(previous.version_number) : null,
        },
      });
      const payload: GigVersionPublishedPayload = {
        accountId,
        gigId,
        gigVersionId: draft.gigVersionId,
        versionNumber: draft.versionNumber,
        gigTemplateVersionId: draft.gigTemplateVersionId,
        supersededGigVersionId: previous ? (previous.gig_version_id as string) : null,
      };
      await this.event(trx, cid, GIG_EVENTS.gigVersionPublished, gigId, accountId, payload);
    });
    return this.detailOf(accountId, gigId, new Map([[draft.gigTemplateVersionId, structure]]));
  }

  // ------------------------------------------------------------------ retire
  /** Retires the Gig (terminal): its draft and published versions are RETIRED, superseded versions stay, nothing is deleted. Repeating it changes nothing. */
  async retire(accountId: string, gigId: string, input: unknown): Promise<GigDetailDto> {
    parseInput(RetireGigRequest, input);
    assertGigId(gigId);
    const cid = getCorrelationId() ?? randomUUID();
    // best effort: retiring must not depend on the template domain, so a port failure here only means the answer after the commit reads the port again
    // (the retire is idempotent: a repeat after such a failure returns the detail without writing anything)
    const ids = await this.boundTemplateVersionIds(accountId, gigId);
    const known = await this.loadStructures(ids).catch(() => undefined);
    await this.tx('retire', async (trx) => {
      await this.lockAccount(trx, accountId);
      const gig = await this.lockGig(trx, accountId, gigId);
      if (gig.status === 'RETIRED') return;
      const open = (
        await sql<Row>`SELECT gig_version_id, version_number, status FROM provider.gig_versions WHERE gig_id = ${gigId} AND status IN ('DRAFT', 'PUBLISHED') ORDER BY version_number FOR UPDATE`.execute(
          trx,
        )
      ).rows;
      // the Gig first, its open versions second (the version guard retires a version only together with a RETIRED Gig; the commit-time check closes the loop)
      await sql`UPDATE provider.gigs SET status = 'RETIRED', retired_at = now(), updated_at = now() WHERE gig_id = ${gigId}`.execute(trx);
      await sql`UPDATE provider.gig_versions SET status = 'RETIRED', retired_at = now(), updated_at = now() WHERE gig_id = ${gigId} AND status IN ('DRAFT', 'PUBLISHED')`.execute(
        trx,
      );
      await this.audit(trx, cid, {
        accountId,
        action: 'GIG_RETIRED',
        gigId,
        changes: { status: [gig.status, 'RETIRED'], versionsRetired: open.length, retiredVersions: open.map((v) => Number(v.version_number)) },
      });
      const payload: GigRetiredPayload = { accountId, gigId };
      await this.event(trx, cid, GIG_EVENTS.gigRetired, gigId, accountId, payload);
    });
    return this.detailOf(accountId, gigId, known);
  }
}

/** The onboarding GIGS step as a PrerequisitePort entry: NOT_STARTED (no Gig draft or published), IN_PROGRESS (a draft but nothing published), COMPLETE (a published Gig). */
export function gigsPrerequisite(service: Pick<ProviderGigService, 'getGigReadinessFacts'>): PrerequisitePort['gigs'] {
  return async (accountId: string): Promise<PrerequisiteState> => {
    const facts = await service.getGigReadinessFacts(accountId);
    if (facts.hasPublishedGig) return { status: 'COMPLETE' };
    if (facts.draftVersionCount > 0) return { status: 'IN_PROGRESS' };
    return { status: 'NOT_STARTED' };
  };
}
