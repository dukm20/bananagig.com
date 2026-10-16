// The account consent layer (ID-005, ADR-0037, ADR-0038): which legal documents an account must accept, which exact version it accepted, and the append-only history.
//
// Ownership: CFG-002 owns the legal documents (LEGAL entries) and their immutable, hashed, localized versions. This service owns only the ACCOUNT'S relationship to a version
// (identity.consent_events). Policy (who needs which purpose, what a newer version does) is configuration (CFG-001), read through ConsentPolicyProvider, never code.
//
// Rules this file keeps:
//  - Every operation acts on the account the CALLER passes in (the API derives it from the verified token). The client never supplies an account id, a time, an address or a
//    status; the server sets the time (the database clock).
//  - ONE lock order everywhere: the account row (FOR UPDATE), then (in the guard trigger) the purpose row and the content version row (FOR SHARE), then the insert. Accept and
//    withdraw of one account serialize on the account row; a publication that closes the window of a version serializes with an accept on the version row.
//  - "In force" has ONE definition: the SQL function identity.consent_version_state, used by the guard trigger (under the share lock) and by every query here. It mirrors the
//    content resolver (published statuses, platform scope, active entry and locale, half-open window). The service pre-checks it only to give a precise error; the trigger is
//    the arbiter.
//  - Current consent is DERIVED from the latest event. Nothing is rewritten: a withdrawal or a newer acceptance is a new event.
//  - Policy is read OUTSIDE the transaction (before the account lock) and every read is validated strictly; a missing or malformed value fails closed
//    (AccountError UNAVAILABLE, reason POLICY_UNAVAILABLE / POLICY_INVALID).
//  - Privacy: logs, errors, audit `changes`, events and results carry identifiers and codes only. No legal text is read or stored here, and a hash or a version id the client
//    claimed is never echoed in an error.
import { randomUUID } from 'node:crypto';
import {
  CONSENT_EVENTS,
  CONSENT_HISTORY_LIMIT,
  PURPOSE_CODE_PATTERN,
  SHA256_HEX_PATTERN,
  consentPurposeLabelKey,
  type AcceptConsentRequest,
  type AcceptConsentResultDto,
  type AccountConsentsDto,
  type AccountStatus,
  type ConsentCurrentDto,
  type ConsentEventDto,
  type ConsentEventPayload,
  type ConsentEventType,
  type ConsentRequirementDto,
  type ConsentRequirementsDto,
  type WithdrawConsentResultDto,
} from '@bananagig/contracts';
import { sql, type Database, type DatabaseSchema, type Kysely, type Trx } from '@bananagig/database';
import { getCorrelationId, log } from '@bananagig/observability';
import { insertOutboxEvent } from '@bananagig/platform';
import { acceptanceStateOf, evaluateRequirement, isRequiredFor, summarizeRequirements } from './consent-evaluate';
import { assertConsentPolicy, parseRequiredFor } from './consent-policy';
import type { ConsentOperations, ConsentPolicy, ConsentPolicyProvider, ConsentRequestContext, RequirementOptions } from './consent-types';
import { AccountError } from './errors';
import { assertUsable, mapDbError, ruleOf } from './service';

type Row = Record<string, unknown>;
type Executor = Kysely<DatabaseSchema> | Trx;

export interface ConsentServiceDeps {
  database: Database;
  /** The current policy of a purpose (configuration registry in production). A failure propagates as UNAVAILABLE: a legal requirement has no code default. */
  policy: ConsentPolicyProvider;
  /** The platform default locale. Optional: when absent it is read from content.locales (is_platform_default). */
  defaultLocale?: () => Promise<string>;
  /** Accepted for interface symmetry with the other services. Every legal timestamp (window checks, occurred_at) is the DATABASE clock; this clock is not used. */
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Locale tags are 2 to 35 characters (the contract bound); anything else is refused before it reaches the database. */
const LOCALE_SHAPE = /^[A-Za-z0-9-]{2,35}$/;
/** The sequence key: the net underneath two writers that read the same previous event. */
const SEQ_CONSTRAINT = 'uq_consent_events__account_purpose_seq';

const actorOf = (accountId: string): string => `account:${accountId}`;
const iso = (v: unknown): string => (v as Date).toISOString();

const purposeNotFound = (): AccountError => new AccountError('CONSENT_PURPOSE_NOT_FOUND', 'the consent purpose was not found');
const invalidField = (field: string, reason = 'INVALID_FIELD'): AccountError =>
  new AccountError('VALIDATION_FAILED', 'the request contains a value that is not valid', { reason, field });
const concurrent = (): AccountError =>
  new AccountError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', { reason: 'CONCURRENT_UPDATE', retryable: true });

/** Thrown (internally) when the guard trigger or the sequence key reports that another writer got the same event number first. */
class SequenceCollision extends Error {}

/**
 * Translates the consent guard rules (`identity_rule:CONSENT_*`) into typed consent errors, and a collision on the sequence key into SequenceCollision; everything else is
 * classified by the common mapper. The trigger is the arbiter: the service pre-checks to give precise errors, so these mappings are the net for a race.
 */
function mapConsentDbError(err: unknown): never {
  if (err instanceof SequenceCollision || err instanceof AccountError) throw err;
  const e = (err ?? {}) as { code?: string; detail?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === SEQ_CONSTRAINT) throw new SequenceCollision();
  if (e.code === '23000') {
    switch (ruleOf(e.detail)) {
      case 'CONSENT_SEQUENCE':
      case 'CONSENT_DUPLICATE':
        throw new SequenceCollision();
      case 'CONSENT_PURPOSE_INACTIVE':
        throw new AccountError('CONSENT_PURPOSE_INACTIVE', 'the consent purpose is not active');
      case 'CONSENT_VERSION_NOT_FOUND':
        throw new AccountError('CONSENT_VERSION_NOT_FOUND', 'the document version was not found');
      case 'CONSENT_VERSION_NOT_CURRENT':
      case 'CONSENT_VERSION_STALE':
        throw new AccountError('CONSENT_VERSION_NOT_CURRENT', 'the document version is not the current one');
      case 'CONSENT_NOT_WITHDRAWABLE':
        throw new AccountError('CONSENT_NOT_WITHDRAWABLE', 'the consent purpose cannot be withdrawn');
      case 'CONSENT_NOT_ACCEPTED':
        throw new AccountError('CONSENT_NOT_ACCEPTED', 'the consent is not accepted');
      default:
    }
  }
  return mapDbError(err);
}

interface PurposeRow {
  code: string;
  entryId: string;
  entryKey: string;
  withdrawal: 'NOT_WITHDRAWABLE' | 'WITHDRAWABLE';
  status: 'ACTIVE' | 'INACTIVE';
}
const toPurpose = (r: Row): PurposeRow => ({
  code: r.purpose_code as string,
  entryId: r.document_entry_id as string,
  entryKey: r.entry_key as string,
  withdrawal: r.withdrawal_policy as PurposeRow['withdrawal'],
  status: r.status as PurposeRow['status'],
});

const toEventDto = (r: Row): ConsentEventDto => ({
  consentEventId: r.consent_event_id as string,
  purposeCode: r.purpose_code as string,
  eventType: r.event_type as ConsentEventType,
  eventSeq: Number(r.event_seq),
  document: { versionId: r.version_id as string, version: Number(r.version), locale: r.locale as string, bodySha256: r.body_sha256 as string },
  occurredAt: iso(r.occurred_at),
  source: r.source as 'ACCOUNT_API',
});

/** The columns of an event joined with its version number (alias `e` = identity.consent_events, `v` = content.versions). */
const EVENT_COLUMNS = sql`e.consent_event_id, e.purpose_code, e.event_type, e.event_seq, e.version_id, v.version, e.locale, e.body_sha256, e.occurred_at, e.source`;

/** A validated accept claim. */
interface Claim {
  versionId: string;
  locale: string;
  bodySha256: string;
}
function parseClaim(input: AcceptConsentRequest): Claim {
  const raw = input as unknown as Record<string, unknown> | null;
  if (raw === null || typeof raw !== 'object') throw invalidField('body');
  const { versionId, locale, bodySha256 } = raw;
  if (typeof versionId !== 'string' || !UUID.test(versionId)) throw invalidField('versionId');
  if (typeof locale !== 'string' || !LOCALE_SHAPE.test(locale)) throw invalidField('locale');
  if (typeof bodySha256 !== 'string' || !SHA256_HEX_PATTERN.test(bodySha256)) throw invalidField('bodySha256');
  // a uuid is case-insensitive by definition (the stored value is lower case); the locale is compared EXACTLY and the hash is lower-case hex by its contract
  return { versionId: versionId.toLowerCase(), locale, bodySha256 };
}

const requestCorrelation = (): string => {
  const cid = getCorrelationId();
  return cid && cid.trim().length > 0 && cid.length <= 200 ? cid : randomUUID();
};

export class ConsentService implements ConsentOperations {
  constructor(private readonly d: ConsentServiceDeps) {}

  // ------------------------------------------------------------------ plumbing
  private tx<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.d.database.transaction(fn).catch(mapConsentDbError);
  }
  /** Runs reads in ONE consistent snapshot: a read-only REPEATABLE READ transaction (no lock is taken; the only extra cost is the transaction control). */
  private snapshot<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.d.database.transaction(fn, { isolationLevel: 'repeatable read', readOnly: true }).catch(mapDbError);
  }
  private get db(): Executor {
    return this.d.database.db;
  }

  /** Reads one purpose's policy and validates its shape. A failure is an outage of the policy: the operation fails closed. The cause is not logged (it may echo configuration). */
  private async readPolicy(purposeCode: string): Promise<ConsentPolicy> {
    try {
      return assertConsentPolicy(purposeCode, await this.d.policy.policy(purposeCode));
    } catch (err) {
      if (err instanceof AccountError) throw err;
      log('error', 'consent policy unavailable', { purposeCode });
      throw new AccountError('UNAVAILABLE', 'the consent policy is not available', { reason: 'POLICY_UNAVAILABLE', purposeCode });
    }
  }

  private async lockAccount(trx: Trx, accountId: string): Promise<AccountStatus> {
    if (!UUID.test(accountId)) throw new AccountError('NOT_FOUND', 'the account does not exist');
    const r = await sql<Row>`SELECT status FROM identity.accounts WHERE account_id = ${accountId} FOR UPDATE`.execute(trx);
    if (r.rows.length === 0) throw new AccountError('NOT_FOUND', 'the account does not exist');
    return r.rows[0]!.status as AccountStatus;
  }

  private async loadPurpose(ex: Executor, code: string): Promise<PurposeRow | null> {
    if (typeof code !== 'string' || !PURPOSE_CODE_PATTERN.test(code)) return null;
    const r = await sql<Row>`SELECT p.purpose_code, p.document_entry_id, e.key AS entry_key, p.withdrawal_policy, p.status
      FROM identity.consent_purposes p JOIN content.entries e ON e.entry_id = p.document_entry_id WHERE p.purpose_code = ${code}`.execute(ex);
    return r.rows[0] ? toPurpose(r.rows[0]) : null;
  }

  private async latestEvent(ex: Executor, accountId: string, purposeCode: string): Promise<ConsentEventDto | null> {
    const r = await sql<Row>`SELECT ${EVENT_COLUMNS} FROM identity.consent_events e JOIN content.versions v ON v.version_id = e.version_id
      WHERE e.account_id = ${accountId} AND e.purpose_code = ${purposeCode} ORDER BY e.event_seq DESC LIMIT 1`.execute(ex);
    return r.rows[0] ? toEventDto(r.rows[0]) : null;
  }

  private audit(trx: Trx, cid: string, a: { accountId: string; action: string; consentEventId: string; changes: Record<string, unknown> }): Promise<unknown> {
    return sql`INSERT INTO identity.account_audit_events (actor, action, account_id, consent_event_id, changes, correlation_id)
      VALUES (${actorOf(a.accountId)}, ${a.action}, ${a.accountId}, ${a.consentEventId}, ${JSON.stringify(a.changes)}::jsonb, ${cid})`.execute(trx);
  }
  private event(trx: Trx, cid: string, eventType: string, accountId: string, payload: ConsentEventPayload): Promise<string> {
    return insertOutboxEvent(trx, {
      aggregateType: 'identity_account',
      aggregateId: accountId,
      eventType,
      actorType: 'user',
      actorId: actorOf(accountId),
      correlationId: cid,
      payload: { ...payload },
    });
  }

  /** Appends one event inside the caller's transaction (the account row is already locked) with its audit row and outbox event. The guard trigger sets occurred_at. */
  private async append(
    trx: Trx,
    cid: string,
    a: {
      accountId: string;
      purposeCode: string;
      eventSeq: number;
      type: ConsentEventType;
      versionId: string;
      versionNumber: number;
      locale: string;
      bodySha256: string;
      sessionId: string | null;
    },
  ): Promise<ConsentEventDto> {
    const inserted = (
      await sql<Row>`INSERT INTO identity.consent_events (account_id, purpose_code, event_seq, event_type, version_id, locale, body_sha256, application_session_id, correlation_id)
        VALUES (${a.accountId}, ${a.purposeCode}, ${a.eventSeq}, ${a.type}, ${a.versionId}, ${a.locale}, ${a.bodySha256}, ${a.sessionId}, ${cid})
        RETURNING consent_event_id, occurred_at, source`.execute(trx)
    ).rows[0]!;
    const consentEventId = inserted.consent_event_id as string;
    await this.audit(trx, cid, {
      accountId: a.accountId,
      action: a.type === 'ACCEPTED' ? 'CONSENT_ACCEPTED' : 'CONSENT_WITHDRAWN',
      consentEventId,
      changes: { purposeCode: a.purposeCode, eventSeq: a.eventSeq },
    });
    await this.event(trx, cid, a.type === 'ACCEPTED' ? CONSENT_EVENTS.accepted : CONSENT_EVENTS.withdrawn, a.accountId, {
      accountId: a.accountId,
      purposeCode: a.purposeCode,
      consentEventId,
      eventSeq: a.eventSeq,
      contentVersionId: a.versionId,
    });
    return {
      consentEventId,
      purposeCode: a.purposeCode,
      eventType: a.type,
      eventSeq: a.eventSeq,
      document: { versionId: a.versionId, version: a.versionNumber, locale: a.locale, bodySha256: a.bodySha256 },
      occurredAt: iso(inserted.occurred_at),
      source: inserted.source as 'ACCOUNT_API',
    };
  }

  private sessionIdOf(ctx: ConsentRequestContext | undefined): string | null {
    const id = ctx?.applicationSessionId;
    return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
  }

  // ------------------------------------------------------------------ reads
  async getConsents(accountId: string): Promise<AccountConsentsDto> {
    if (!UUID.test(accountId)) throw new AccountError('NOT_FOUND', 'the account does not exist');
    // ONE consistent snapshot (read-only REPEATABLE READ): a concurrent accept can never make the history show an event that `current` does not
    return this.snapshot(async (trx) => {
      const exists = await sql<Row>`SELECT 1 FROM identity.accounts WHERE account_id = ${accountId}`.execute(trx);
      if (exists.rows.length === 0) throw new AccountError('NOT_FOUND', 'the account does not exist');
      // one row per purpose that is ACTIVE or has events of this account, with its latest event
      const current =
        await sql<Row>`SELECT p.purpose_code, p.withdrawal_policy, l.consent_event_id, l.event_type, l.event_seq, l.version_id, l.version, l.locale, l.body_sha256, l.occurred_at, l.source
        FROM identity.consent_purposes p
        LEFT JOIN LATERAL (SELECT ${EVENT_COLUMNS} FROM identity.consent_events e JOIN content.versions v ON v.version_id = e.version_id
                            WHERE e.account_id = ${accountId} AND e.purpose_code = p.purpose_code ORDER BY e.event_seq DESC LIMIT 1) l ON true
       WHERE p.status = 'ACTIVE' OR l.consent_event_id IS NOT NULL
       ORDER BY p.purpose_code`.execute(trx);
      const history = await sql<Row>`SELECT ${EVENT_COLUMNS} FROM identity.consent_events e JOIN content.versions v ON v.version_id = e.version_id
        WHERE e.account_id = ${accountId} ORDER BY e.occurred_at DESC, e.purpose_code, e.event_seq DESC LIMIT ${CONSENT_HISTORY_LIMIT}`.execute(trx);
      return {
        current: current.rows.map((r): ConsentCurrentDto => {
          const latest = r.consent_event_id === null ? null : toEventDto(r);
          return {
            purposeCode: r.purpose_code as string,
            labelContentKey: consentPurposeLabelKey(r.purpose_code as string),
            state: acceptanceStateOf(latest === null ? null : { eventType: latest.eventType }),
            withdrawable: r.withdrawal_policy === 'WITHDRAWABLE',
            latest,
          };
        }),
        history: history.rows.map(toEventDto),
      };
    });
  }

  async getRequirements(accountId: string, options: RequirementOptions = {}): Promise<ConsentRequirementsDto> {
    if (!UUID.test(accountId)) throw new AccountError('NOT_FOUND', 'the account does not exist');
    const requestedLocale = options.locale;
    if (requestedLocale !== undefined && (typeof requestedLocale !== 'string' || !LOCALE_SHAPE.test(requestedLocale)))
      throw invalidField('locale', 'INVALID_LOCALE');
    const wanted = options.purposes === undefined ? undefined : [...new Set(options.purposes)];
    if (wanted !== undefined) for (const code of wanted) if (typeof code !== 'string' || !PURPOSE_CODE_PATTERN.test(code)) throw purposeNotFound();

    // The account context (roles, locales) and the facts (version in force, latest event) are read in ONE consistent snapshot (read-only REPEATABLE READ); the policy
    // is read afterwards, outside the transaction (configuration I/O never runs inside it).
    const { roles, knownRoles, locale, facts } = await this.snapshot(async (trx) => {
      // the account, its considered roles (PENDING and ACTIVE: a requested provider role already needs the provider's agreements), the locales and the role codes
      const ctx = (
        await sql<Row>`SELECT
            (SELECT preferred_locale FROM identity.account_profiles WHERE account_id = a.account_id) AS preferred_locale,
            (SELECT locale FROM content.locales WHERE is_platform_default) AS platform_default,
            coalesce((SELECT array_agg(r.code ORDER BY r.code) FROM identity.account_roles ar JOIN identity.roles r ON r.role_id = ar.role_id
                       WHERE ar.account_id = a.account_id AND ar.status IN ('PENDING', 'ACTIVE')), '{}') AS roles,
            coalesce((SELECT array_agg(code) FROM identity.roles), '{}') AS all_roles,
            ${requestedLocale ?? null}::text IS NOT NULL AND EXISTS (SELECT 1 FROM content.locales WHERE locale = ${requestedLocale ?? null}) AS locale_registered
          FROM identity.accounts a WHERE a.account_id = ${accountId}`.execute(trx)
      ).rows[0];
      if (!ctx) throw new AccountError('NOT_FOUND', 'the account does not exist');
      if (requestedLocale !== undefined && ctx.locale_registered !== true) throw invalidField('locale', 'INVALID_LOCALE');

      // the evaluated locale: the one the caller asked for, else the profile's, else the platform default. Never a fallback between legal documents: the caller passes the
      // locale it SHOWS, and a version in another locale is never offered.
      let evaluated: string | null = requestedLocale ?? (ctx.preferred_locale as string | null) ?? null;
      if (evaluated === null) {
        try {
          evaluated = this.d.defaultLocale ? await this.d.defaultLocale() : ((ctx.platform_default as string | null) ?? null);
        } catch {
          evaluated = null;
        }
        if (evaluated === null) throw new AccountError('UNAVAILABLE', 'the platform default locale is not available', { reason: 'NO_PLATFORM_DEFAULT' });
      }
      const locale: string = evaluated;

      // every purpose with the version in force in the locale (ONE definition of "in force") and the account's latest event
      const facts = await sql<Row>`WITH clk AS (SELECT clock_timestamp() AS t)
        SELECT p.purpose_code, p.document_entry_id, e.key AS entry_key, p.withdrawal_policy, p.status,
               f.version_id AS doc_version_id, f.version AS doc_version, f.locale AS doc_locale, f.body_sha256 AS doc_hash, f.effective_from AS doc_from,
               l.consent_event_id, l.event_type, l.event_seq, l.version_id, l.version, l.locale, l.body_sha256, l.occurred_at, l.source
          FROM identity.consent_purposes p
          JOIN content.entries e ON e.entry_id = p.document_entry_id
          CROSS JOIN clk
          LEFT JOIN LATERAL (SELECT v.version_id, v.version, v.locale, v.body_sha256, v.effective_from FROM content.versions v
                              WHERE v.entry_id = p.document_entry_id AND v.locale = ${locale}
                                AND identity.consent_version_state(v.version_id, p.document_entry_id, clk.t) = 'IN_FORCE'
                              ORDER BY v.version DESC LIMIT 1) f ON true
          LEFT JOIN LATERAL (SELECT ${EVENT_COLUMNS} FROM identity.consent_events e JOIN content.versions v ON v.version_id = e.version_id
                              WHERE e.account_id = ${accountId} AND e.purpose_code = p.purpose_code ORDER BY e.event_seq DESC LIMIT 1) l ON true
         ORDER BY p.purpose_code`.execute(trx);
      return { roles: ctx.roles as string[], knownRoles: new Set(ctx.all_roles as string[]), locale, facts };
    });

    return (async () => {
      if (wanted !== undefined) {
        const known = new Set(facts.rows.map((r) => r.purpose_code as string));
        for (const code of wanted) if (!known.has(code)) throw purposeNotFound();
      }
      // evaluated: every ACTIVE purpose, or the ACTIVE ones among the requested (an INACTIVE purpose is not evaluated)
      const evaluated = facts.rows.filter((r) => r.status === 'ACTIVE' && (wanted === undefined || wanted.includes(r.purpose_code as string)));

      const policies = await Promise.all(evaluated.map((r) => this.readPolicy(r.purpose_code as string)));
      const requirements = evaluated.map((r, i): ConsentRequirementDto => {
        const code = r.purpose_code as string;
        // an unknown role code in the configuration must not silently require nothing: it is an invalid policy
        const policy = policies[i]!;
        parseRequiredFor(code, policy.requiredForRoles, knownRoles);
        const latest = r.consent_event_id === null ? null : toEventDto(r);
        const document =
          r.doc_version_id === null
            ? null
            : {
                entryKey: r.entry_key as string,
                versionId: r.doc_version_id as string,
                version: Number(r.doc_version),
                locale: r.doc_locale as string,
                bodySha256: r.doc_hash as string,
                effectiveFrom: iso(r.doc_from),
              };
        const result = evaluateRequirement({
          required: isRequiredFor(policy.requiredForRoles, roles),
          reacceptance: policy.reacceptance,
          evaluatedLocale: locale,
          document: document === null ? null : { versionId: document.versionId, locale: document.locale },
          latest: latest === null ? null : { eventType: latest.eventType, versionId: latest.document.versionId, locale: latest.document.locale },
        });
        return {
          purposeCode: code,
          labelContentKey: consentPurposeLabelKey(code),
          required: isRequiredFor(policy.requiredForRoles, roles),
          status: result.status,
          acceptanceState: result.acceptanceState,
          withdrawable: r.withdrawal_policy === 'WITHDRAWABLE',
          reacceptance: policy.reacceptance,
          document,
          accepted: latest !== null && latest.eventType === 'ACCEPTED' ? latest : null,
        };
      });
      return { locale, requirements, ...summarizeRequirements(requirements) };
    })().catch(mapDbError);
  }

  // ------------------------------------------------------------------ accept
  async accept(accountId: string, purposeCode: string, input: AcceptConsentRequest, ctx?: ConsentRequestContext): Promise<AcceptConsentResultDto> {
    const claim = parseClaim(input);
    if (typeof purposeCode !== 'string' || !PURPOSE_CODE_PATTERN.test(purposeCode)) throw purposeNotFound();
    const sessionId = this.sessionIdOf(ctx);
    try {
      return await this.tx((trx) => this.acceptOnce(trx, accountId, purposeCode, claim, sessionId));
    } catch (err) {
      if (!(err instanceof SequenceCollision)) throw err;
      // a writer outside the account lock took the event number: re-read once. The same acceptance is an idempotent repeat, anything else is a conflict.
      const latest = await this.latestEvent(this.db, accountId, purposeCode).catch(mapDbError);
      if (latest && latest.eventType === 'ACCEPTED' && latest.document.versionId === claim.versionId) return { changed: false, event: latest };
      throw concurrent();
    }
  }

  private async acceptOnce(trx: Trx, accountId: string, purposeCode: string, claim: Claim, sessionId: string | null): Promise<AcceptConsentResultDto> {
    assertUsable(await this.lockAccount(trx, accountId));
    const purpose = await this.loadPurpose(trx, purposeCode);
    if (!purpose) throw purposeNotFound();
    const latest = await this.latestEvent(trx, accountId, purposeCode);
    const version = (
      await sql<Row>`SELECT v.version, v.locale, v.body_sha256, identity.consent_version_state(v.version_id, ${purpose.entryId}, clock_timestamp()) AS state
        FROM content.versions v WHERE v.version_id = ${claim.versionId}`.execute(trx)
    ).rows[0];
    // Check order (information control: a caller must not learn the locale or the hash of a version that is not in force from the CLASS of the error):
    // (a) unknown, another document's, not published and not platform-scope versions are ONE answer (unpublished text is never disclosed);
    if (!version || version.state === 'NOT_FOUND') throw new AccountError('CONSENT_VERSION_NOT_FOUND', 'the document version was not found');
    const claimMatches = (): void => {
      if (version.locale !== claim.locale) throw new AccountError('CONSENT_LOCALE_MISMATCH', 'the locale does not match the document version');
      if (version.body_sha256 !== claim.bodySha256) throw new AccountError('CONSENT_HASH_MISMATCH', 'the hash does not match the document version');
    };
    // (b) the same acceptance again (the latest event accepts this very version, so the account already knows it): the claim is still checked against the version, then
    //     nothing is written, even if the version has been superseded or the purpose deactivated since;
    if (latest !== null && latest.eventType === 'ACCEPTED' && latest.document.versionId === claim.versionId) {
      claimMatches();
      return { changed: false, event: latest };
    }
    // (c) a retired purpose, (d) a version that is not in force, BEFORE any comparison of the claim: a stale or scheduled version with a wrong locale or hash is 409, never 400;
    if (purpose.status !== 'ACTIVE') throw new AccountError('CONSENT_PURPOSE_INACTIVE', 'the consent purpose is not active');
    if (version.state !== 'IN_FORCE') throw new AccountError('CONSENT_VERSION_NOT_CURRENT', 'the document version is not the current one');
    // (e) only now the claim (locale compared exactly) and (f) the insert.
    claimMatches();
    const event = await this.append(trx, requestCorrelation(), {
      accountId,
      purposeCode,
      eventSeq: (latest?.eventSeq ?? 0) + 1,
      type: 'ACCEPTED',
      versionId: claim.versionId,
      versionNumber: Number(version.version),
      locale: claim.locale,
      bodySha256: claim.bodySha256,
      sessionId,
    });
    return { changed: true, event };
  }

  // ------------------------------------------------------------------ withdraw
  async withdraw(accountId: string, purposeCode: string, ctx?: ConsentRequestContext): Promise<WithdrawConsentResultDto> {
    if (typeof purposeCode !== 'string' || !PURPOSE_CODE_PATTERN.test(purposeCode)) throw purposeNotFound();
    const sessionId = this.sessionIdOf(ctx);
    // structural facts first (immutable columns): no lock, no policy read for a purpose that can never be withdrawn
    const pre = await this.loadPurpose(this.db, purposeCode).catch(mapDbError);
    if (!pre) throw purposeNotFound();
    if (pre.withdrawal !== 'WITHDRAWABLE') throw new AccountError('CONSENT_NOT_WITHDRAWABLE', 'the consent purpose cannot be withdrawn');
    // the policy is read BEFORE the account lock (no configuration I/O while a lock is held); an INACTIVE purpose is not evaluated, so it is required of nobody
    const policy = pre.status === 'ACTIVE' ? await this.readPolicy(purposeCode) : null;
    try {
      return await this.tx((trx) => this.withdrawOnce(trx, accountId, purposeCode, policy, sessionId));
    } catch (err) {
      if (!(err instanceof SequenceCollision)) throw err;
      const latest = await this.latestEvent(this.db, accountId, purposeCode).catch(mapDbError);
      if (latest && latest.eventType === 'WITHDRAWN') return { changed: false, event: latest };
      throw concurrent();
    }
  }

  private async withdrawOnce(
    trx: Trx,
    accountId: string,
    purposeCode: string,
    policy: ConsentPolicy | null,
    sessionId: string | null,
  ): Promise<WithdrawConsentResultDto> {
    assertUsable(await this.lockAccount(trx, accountId));
    const purpose = await this.loadPurpose(trx, purposeCode);
    if (!purpose) throw purposeNotFound();
    if (purpose.withdrawal !== 'WITHDRAWABLE') throw new AccountError('CONSENT_NOT_WITHDRAWABLE', 'the consent purpose cannot be withdrawn');
    const latest = await this.latestEvent(trx, accountId, purposeCode);
    if (latest === null) throw new AccountError('CONSENT_NOT_ACCEPTED', 'the consent is not accepted');
    if (latest.eventType === 'WITHDRAWN') return { changed: false, event: latest };
    if (purpose.status === 'ACTIVE') {
      // the roles are read under the account lock: a concurrent grant of a role (which share-locks the account row) waits for this transaction
      const held = await sql<Row>`SELECT r.code FROM identity.account_roles ar JOIN identity.roles r ON r.role_id = ar.role_id
        WHERE ar.account_id = ${accountId} AND ar.status IN ('PENDING', 'ACTIVE')`.execute(trx);
      const known = await sql<Row>`SELECT code FROM identity.roles`.execute(trx);
      // the purpose was INACTIVE (no policy read) when the call started and ACTIVE when the lock was taken: reactivated in between; fail closed, the caller repeats
      if (policy === null) throw concurrent();
      const effective = policy;
      parseRequiredFor(purposeCode, effective.requiredForRoles, new Set(known.rows.map((r) => r.code as string)));
      if (
        isRequiredFor(
          effective.requiredForRoles,
          held.rows.map((r) => r.code as string),
        )
      )
        throw new AccountError('CONSENT_REQUIRED_FOR_ROLE', 'the consent is required for a role of the account', { purposeCode });
    }
    const event = await this.append(trx, requestCorrelation(), {
      accountId,
      purposeCode,
      eventSeq: latest.eventSeq + 1,
      type: 'WITHDRAWN',
      versionId: latest.document.versionId,
      versionNumber: latest.document.version,
      locale: latest.document.locale,
      bodySha256: latest.document.bodySha256,
      sessionId,
    });
    return { changed: true, event };
  }

  // ------------------------------------------------------------------ for the flows that need consent
  // NOTE for the flows that gate on these: an account with no PENDING or ACTIVE role has every purpose NOT_REQUIRED (nothing is required of nobody), so a gate must grant
  // the role first and pass an explicit, NON-EMPTY `purposes` list. An explicitly empty list is a caller bug that would silently pass the gate: it is refused here
  // (getRequirements, a read, evaluates nothing for it).
  private gateOptions(options: RequirementOptions | undefined): RequirementOptions | undefined {
    if (options?.purposes !== undefined && options.purposes.length === 0) throw invalidField('purposes');
    return options;
  }
  async listOutstandingConsents(accountId: string, options?: RequirementOptions): Promise<ConsentRequirementDto[]> {
    const r = await this.getRequirements(accountId, this.gateOptions(options));
    return r.requirements.filter((x) => r.outstanding.includes(x.purposeCode));
  }
  async hasRequiredConsents(accountId: string, options?: RequirementOptions): Promise<boolean> {
    return (await this.getRequirements(accountId, this.gateOptions(options))).satisfied;
  }
  async requireConsents(accountId: string, options?: RequirementOptions): Promise<void> {
    const r = await this.getRequirements(accountId, this.gateOptions(options));
    if (!r.satisfied) throw new AccountError('CONSENT_REQUIRED', 'required consents are outstanding', { outstanding: r.outstanding });
  }
}
