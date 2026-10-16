// The phone contact and its SMS verification (ID-003, docs/engineering/PHONE_VERIFICATION.md, ADR-0030, ADR-0031). BananaGig owns the marketplace contact state;
// Keycloak is not a phone store and never receives the number. The structure follows the hardened email verification (ID-002) without the magic link.
//
// Rules this file keeps (each one differs from or adds to the email rules where noted):
//  - Every call acts on the account the CALLER passes in, which the API derives from the verified token. There is no operation by arbitrary account id.
//  - ONE lock order everywhere: account row (FOR UPDATE), then the account's phone contact rows, then the challenge row, then (verification only) the advisory lock of the
//    number. A code, a resend and a replacement for the same account therefore run one after the other.
//  - The code is shown ONCE (in the SMS). Only an HMAC (keyed, bound to the challenge id, in its own domain) is stored; comparisons are constant-time; no code, number or
//    hash is logged, audited, put in an event or returned by an API. The audit trail and the events name the contact by id, the audit also by a MASKED number.
//  - Sending is two-phase: the challenge commits first, the SMS is delivered OUTSIDE any transaction, then the outcome is recorded. A failed delivery closes its
//    challenge (the code never reached anyone) and does not start the resend cooldown.
//  - Wrong attempts are counted under the challenge row lock; the attempt that reaches the maximum locks the challenge. The count is committed although the call fails.
//  - Limits: cooldown and hour/day caps are counted from the database (per ACCOUNT). The reusable Valkey limiter adds source address, device and the NUMBER (a keyed
//    hash, never the raw number), because an SMS costs money: it fails CLOSED for every operation that can send. Confirmation fails open (the attempt counter bounds it).
//  - Line type: when the country/market policy blocks any line type the number is classified by the PhoneIntelligence port BEFORE anything is stored or sent; a lookup
//    that fails is a refusal (fail closed), never an accept. The result is stored as a snapshot and re-applied at send and confirm without calling the vendor again.
//  - Accounts per number: the configured maximum (default 1) is enforced under a transaction advisory lock on the number, and the guard trigger enforces it again
//    with the same lock. Pending claims are never counted and never reveal anything; the typed refusal comes only AFTER a correct code.
import { randomUUID } from 'node:crypto';
import {
  PHONE_EVENTS,
  maskPhone,
  phoneIssueMessageKey,
  type AccountPhoneSummaryDto,
  type AccountStatus,
  type PhoneChangeRequestedPayload,
  type PhoneContactAddedPayload,
  type PhoneLineType,
  type PhoneOpenStatus,
  type PhonePurpose,
  type PhoneVerificationFailedPayload,
  type PhoneVerificationSentPayload,
  type PhoneVerifiedPayload,
} from '@bananagig/contracts';
import { sql, type Database, type DatabaseSchema, type Kysely, type Trx } from '@bananagig/database';
import { getCorrelationId, log } from '@bananagig/observability';
import { SmsDeliveryError, insertOutboxEvent, type PhoneIntelligence, type RateLimiter, type SmsSender } from '@bananagig/platform';
import { hashDimension } from './email-crypto';
import { AccountError } from './errors';
import { canonicalizePhone } from './phone';
import { hashPhoneCode } from './phone-crypto';
import {
  assertPhoneVerificationPolicy,
  isLineTypeBlocked,
  type PhoneCountryDirectory,
  type PhonePolicyProvider,
  type PhoneVerificationPolicy,
} from './phone-policy';
import { loadPhoneSummary, phonePurposeOfStatus } from './phone-state';
import { assertUsable, mapDbError } from './service';
import { consumeRules, evaluateSendWindows, requestRules, type LimitContext } from './verification-core';
import { generateNumericCode, hashesEqual } from './verification-crypto';

type Row = Record<string, unknown>;

export const PHONE_VERIFICATION_TEMPLATE_KEY = 'sms.verification.phone';
/** The vendor lookup must answer within this; a slower answer is a failed lookup (fail closed). */
export const PHONE_LOOKUP_TIMEOUT_MS = 5000;

export interface PhoneVerificationDeps {
  database: Database;
  /** The current limits and the country/market policy (configuration registry in production). A failure propagates and the service fails closed. */
  policy: PhonePolicyProvider;
  /** Delivery port (the fake sink in dev/CI, a vendor in production). No vendor SDK lives in this service. */
  sender: SmsSender;
  /** Line-type / risk classification port. */
  intelligence: PhoneIntelligence;
  /** Countries (geography): which accept phone numbers and the default for a national-format number. */
  countries: PhoneCountryDirectory;
  /** Key of the HMAC that hashes codes and limit dimensions (VERIFICATION_HASH_SECRET). */
  hashSecret: string;
  /** Reusable abuse limiter (Valkey). Omitted only in tests that exercise the database limits alone. */
  rateLimiter?: RateLimiter;
  templateKey?: string;
}

/** Facts about the request that the abuse limits need. Nothing here is stored. */
export type PhoneRequestContext = LimitContext;

export interface SetPhoneResult {
  /** False when the call changed nothing (the number was already the pending or the primary one). */
  changed: boolean;
  phone: AccountPhoneSummaryDto;
}
export interface SendPhoneVerificationResult {
  sentAt: Date;
  expiresAt: Date;
  resendAvailableAt: Date;
  codeLength: number;
  validityMinutes: number;
  phone: AccountPhoneSummaryDto;
}
export interface ConfirmPhoneResult {
  /** False for a repeated confirmation of a number that was already verified (idempotent, no side effect). */
  changed: boolean;
  phone: AccountPhoneSummaryDto;
}
export interface PhoneDetail extends AccountPhoneSummaryDto {
  resendAvailableAt: Date | null;
  attemptsRemaining: number | null;
  codeLength: number;
  validityMinutes: number;
}

interface ContactRow {
  id: string;
  phone: string;
  country: string;
  status: 'PENDING' | 'VERIFIED' | 'REPLACEMENT_PENDING';
  isPrimary: boolean;
  lineType: PhoneLineType | null;
}
interface ChallengeRow {
  id: string;
  contactId: string;
  purpose: PhonePurpose;
  codeHash: string;
  attemptCount: number;
  expired: boolean;
  used: boolean;
  invalidationReason: string | null;
}

const toContact = (r: Row): ContactRow => ({
  id: r.phone_contact_id as string,
  phone: r.phone_e164 as string,
  country: r.country_code as string,
  status: r.status as ContactRow['status'],
  isPrimary: r.is_primary === true,
  lineType: (r.line_type as PhoneLineType | null) ?? null,
});
const toChallenge = (r: Row): ChallengeRow => ({
  id: r.challenge_id as string,
  contactId: r.phone_contact_id as string,
  purpose: r.purpose as PhonePurpose,
  codeHash: r.code_hash as string,
  attemptCount: r.attempt_count as number,
  expired: r.expired === true,
  used: r.used_at !== null,
  invalidationReason: (r.invalidation_reason as string | null) ?? null,
});

const CHALLENGE_COLUMNS = sql`challenge_id, phone_contact_id, purpose, code_hash, attempt_count, used_at, invalidation_reason, expires_at, (expires_at <= clock_timestamp()) AS expired`;
const CONTACT_COLUMNS = sql`phone_contact_id, phone_e164, country_code, status, is_primary, line_type`;
const actorOf = (accountId: string): string => `account:${accountId}`;

type AttemptOutcome =
  | { kind: 'OK'; result: ConfirmPhoneResult }
  | { kind: 'WRONG'; attemptsRemaining: number; locked: boolean }
  | { kind: 'LOCKED' }
  | { kind: 'FAIL'; error: AccountError };

/** A timestamp column must arrive as a Date: anything else would silently disable the send caps, so it is an error. */
const assertDate = (t: unknown): Date => {
  if (t instanceof Date) return t;
  throw new Error('unexpected timestamp type in the send window');
};

export class PhoneVerificationService {
  private readonly templateKey: string;

  constructor(private readonly d: PhoneVerificationDeps) {
    this.templateKey = d.templateKey ?? PHONE_VERIFICATION_TEMPLATE_KEY;
  }

  private tx<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.d.database.transaction(fn).catch(mapDbError);
  }

  // ------------------------------------------------------------------ policy and limits
  private async policy(country?: string): Promise<PhoneVerificationPolicy> {
    try {
      return assertPhoneVerificationPolicy(await this.d.policy.policy(country));
    } catch (err) {
      if (err instanceof AccountError) throw err;
      // a security limit has no code default: without the policy the operation does not happen. The cause is not logged.
      log('error', 'phone verification policy unavailable');
      throw new AccountError('UNAVAILABLE', 'the phone verification policy is not available', { reason: 'POLICY_UNAVAILABLE' });
    }
  }

  /**
   * Consumes the abuse limits of one request. `strict` (operations that can send an SMS or create work) fails CLOSED when the counters are unreachable; otherwise the
   * request proceeds (confirmation is bounded by the attempt counter in PostgreSQL). A refusal never says which dimension refused.
   */
  private async limit(mode: 'strict' | 'lenient', accountId: string, ctx: PhoneRequestContext, p: PhoneVerificationPolicy, phone?: string): Promise<void> {
    const rules = requestRules('phone-verification', this.d.hashSecret, accountId, ctx, p.requestsPerHour);
    if (phone)
      rules.push({ name: 'phone-verification:number', key: hashDimension(this.d.hashSecret, 'phone', phone), limit: p.numberPerHour, windowSeconds: 3600 });
    const outcome = await consumeRules(this.d.rateLimiter, rules);
    if (outcome.kind === 'REFUSED') throw new AccountError('PHONE_RATE_LIMITED', 'too many requests', { retryAfterSeconds: outcome.retryAfterSeconds });
    if (outcome.kind === 'UNAVAILABLE') {
      if (mode === 'strict') {
        log('error', 'phone verification rate limiter unavailable; request refused');
        throw new AccountError('UNAVAILABLE', 'the request cannot be accepted right now', { reason: 'RATE_LIMITER_UNAVAILABLE' });
      }
      log('warn', 'phone verification rate limiter unavailable; the attempt counter still applies');
    }
  }

  // ------------------------------------------------------------------ rows
  private async lockAccount(trx: Trx, accountId: string): Promise<void> {
    const r = await sql<Row>`SELECT status FROM identity.accounts WHERE account_id = ${accountId} FOR UPDATE`.execute(trx);
    if (r.rows.length === 0) throw new AccountError('NOT_FOUND', 'the account does not exist');
    assertUsable(r.rows[0]!.status as AccountStatus);
  }

  private async liveContacts(ex: Kysely<DatabaseSchema> | Trx, accountId: string, lock: boolean): Promise<ContactRow[]> {
    const rows = lock
      ? await sql<Row>`SELECT ${CONTACT_COLUMNS} FROM identity.phone_contacts WHERE account_id = ${accountId} AND status <> 'DISABLED' ORDER BY created_at FOR UPDATE`.execute(
          ex,
        )
      : await sql<Row>`SELECT ${CONTACT_COLUMNS} FROM identity.phone_contacts WHERE account_id = ${accountId} AND status <> 'DISABLED' ORDER BY created_at`.execute(
          ex,
        );
    return rows.rows.map(toContact);
  }

  private audit(trx: Trx, cid: string, a: { accountId: string; contactId: string; action: string; changes: Record<string, unknown> }) {
    return sql`INSERT INTO identity.account_audit_events (actor, action, account_id, phone_contact_id, changes, correlation_id)
      VALUES (${actorOf(a.accountId)}, ${a.action}, ${a.accountId}, ${a.contactId}, ${JSON.stringify(a.changes)}::jsonb, ${cid})`.execute(trx);
  }
  private event(trx: Trx, cid: string, eventType: string, accountId: string, payload: Record<string, unknown>) {
    return insertOutboxEvent(trx, {
      aggregateType: 'identity_account',
      aggregateId: accountId,
      eventType,
      actorType: 'user',
      actorId: actorOf(accountId),
      correlationId: cid,
      payload,
    });
  }

  // ------------------------------------------------------------------ reading
  /** The cheap, masked phone state of an account (no configuration read). */
  async getPhoneSummary(accountId: string): Promise<AccountPhoneSummaryDto> {
    return loadPhoneSummary(this.d.database.db, accountId).catch(mapDbError);
  }

  /** The state for the verification screen: the summary plus the resend countdown, the attempts left and the code policy of the number's country. */
  async getPhoneDetail(accountId: string): Promise<PhoneDetail> {
    const live = await this.liveContacts(this.d.database.db, accountId, false).catch(mapDbError);
    const p = await this.policy((live.find((c) => c.status !== 'VERIFIED') ?? live[0])?.country);
    return this.tx(async (trx) => {
      const summary = await loadPhoneSummary(trx, accountId);
      const t = (
        await sql<Row>`SELECT
            (SELECT max(c.created_at) FILTER (WHERE c.delivery_status <> 'FAILED' AND c.used_at IS NULL) FROM identity.phone_verification_challenges c
              JOIN identity.phone_contacts k ON k.phone_contact_id = c.phone_contact_id WHERE k.account_id = ${accountId}) AS last_issued,
            (SELECT c.attempt_count FROM identity.phone_verification_challenges c JOIN identity.phone_contacts k ON k.phone_contact_id = c.phone_contact_id
              WHERE k.account_id = ${accountId} AND k.status IN ('PENDING', 'REPLACEMENT_PENDING') AND c.used_at IS NULL AND c.invalidated_at IS NULL AND c.expires_at > clock_timestamp()
              LIMIT 1) AS attempts,
            clock_timestamp() AS now`.execute(trx)
      ).rows[0]!;
      const now = t.now as Date;
      const lastIssued = (t.last_issued as Date | null) ?? null;
      const availableAt = summary.pending && lastIssued ? new Date(lastIssued.getTime() + p.resendSeconds * 1000) : null;
      return {
        ...summary,
        resendAvailableAt: availableAt && availableAt > now ? availableAt : null,
        attemptsRemaining: t.attempts === null ? null : Math.max(0, p.maxAttempts - (t.attempts as number)),
        codeLength: p.codeLength,
        validityMinutes: p.validityMinutes,
      };
    });
  }

  // ------------------------------------------------------------------ add or change the number
  /**
   * Resolves the input to a canonical number of an ACTIVE country: E.164 produced by the numbering library (country-aware, the default coming from the caller or from
   * geography), then the country must be active and its configured dialing code must be the number's calling code. The refusal carries an issue code only.
   */
  private async resolvePhone(rawPhone: unknown, countryHint?: string): Promise<{ e164: string; country: string }> {
    let parsed = canonicalizePhone(rawPhone, countryHint);
    if (!parsed.ok && parsed.code === 'COUNTRY_REQUIRED' && countryHint === undefined) {
      const fallback = await this.d.countries.defaultCountry();
      if (fallback !== undefined) parsed = canonicalizePhone(rawPhone, fallback);
    }
    if (!parsed.ok) throw this.invalid(parsed.code);
    const country = await this.d.countries.active(parsed.countryCode);
    if (!country || country.dialingCode !== `+${parsed.callingCode}`) throw this.invalid('COUNTRY_NOT_SUPPORTED');
    return { e164: parsed.e164, country: parsed.countryCode };
  }

  private invalid(code: Parameters<typeof phoneIssueMessageKey>[0]): AccountError {
    return new AccountError('PHONE_INVALID', 'the phone number is not valid', { reason: code, messageKey: phoneIssueMessageKey(code) });
  }

  /** Classifies a number. A failing or slow lookup is PHONE_RISK_UNAVAILABLE (the market blocks line types, so an unclassified number cannot be accepted). */
  private async classify(e164: string, country: string): Promise<PhoneLineType> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const lookup = this.d.intelligence.lookup(e164, country);
      lookup.catch(() => undefined);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('lookup timed out')), PHONE_LOOKUP_TIMEOUT_MS);
      });
      return (await Promise.race([lookup, timeout])).lineType;
    } catch {
      log('warn', 'phone line-type lookup failed; the number is refused');
      throw new AccountError('PHONE_RISK_UNAVAILABLE', 'the phone number could not be checked right now', { retryable: true });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private notAccepted(): AccountError {
    return new AccountError('PHONE_NOT_ACCEPTED', 'the phone number is not accepted', { reason: 'LINE_POLICY' });
  }

  /**
   * Sets the number to verify. No SMS is sent here (see sendVerification).
   *  - without a verified primary the number becomes the PENDING initial number (INITIAL_PHONE);
   *  - with a verified primary it becomes a REPLACEMENT_PENDING candidate (CHANGE_PHONE): the verified number stays active and primary until the new one verifies;
   *  - the same pending number again is a no-op; the primary number again withdraws a pending change; a different number supersedes the pending one.
   * The number must belong to an ACTIVE country and satisfy the country/market line-type policy. The answer is the same whatever any other account holds.
   */
  async setPhone(accountId: string, rawPhone: unknown, input: { country?: string } & PhoneRequestContext = {}): Promise<SetPhoneResult> {
    const { e164, country } = await this.resolvePhone(rawPhone, input.country);
    const p = await this.policy(country);
    await this.limit('strict', accountId, input, p);
    const cid = getCorrelationId() ?? randomUUID();
    let lookedUp: { lineType: PhoneLineType; at: Date } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      // peek (no lock): a number that is already this account's primary or pending number needs no vendor lookup
      const peek = await this.liveContacts(this.d.database.db, accountId, false).catch(mapDbError);
      const known = peek.some((c) => c.phone === e164);
      if (!known && p.blockedLineTypes.length > 0 && !lookedUp) {
        const lineType = await this.classify(e164, country);
        if (isLineTypeBlocked(lineType, p.blockedLineTypes)) throw this.notAccepted();
        lookedUp = { lineType, at: new Date() };
      }
      const result = await this.tx(async (trx): Promise<SetPhoneResult | 'LOOKUP_NEEDED'> => {
        await this.lockAccount(trx, accountId);
        const live = await this.liveContacts(trx, accountId, true);
        const primary = live.find((c) => c.isPrimary);
        const open = live.find((c) => c.status === 'PENDING' || c.status === 'REPLACEMENT_PENDING');
        if (primary && primary.phone === e164) {
          // the person went back to the verified number: a pending change is withdrawn, otherwise nothing happens
          if (open) await this.supersede(trx, open);
          return { changed: open !== undefined, phone: await loadPhoneSummary(trx, accountId) };
        }
        if (open && open.phone === e164) return { changed: false, phone: await loadPhoneSummary(trx, accountId) };
        if (p.blockedLineTypes.length > 0 && !lookedUp) return 'LOOKUP_NEEDED'; // the state changed after the peek: classify, then try again
        if (open) await this.supersede(trx, open);
        const status: PhoneOpenStatus = primary ? 'REPLACEMENT_PENDING' : 'PENDING';
        const purpose = phonePurposeOfStatus(status);
        const inserted = (
          await sql<Row>`INSERT INTO identity.phone_contacts (account_id, phone_e164, country_code, status, source, line_type, line_type_checked_at)
            VALUES (${accountId}, ${e164}, ${country}, ${status}, 'USER_ENTERED', ${lookedUp?.lineType ?? null}, ${lookedUp?.at ?? null}) RETURNING phone_contact_id`.execute(
            trx,
          )
        ).rows[0]!;
        const contactId = inserted.phone_contact_id as string;
        await this.audit(trx, cid, {
          accountId,
          contactId,
          action: primary ? 'PHONE_CHANGE_REQUESTED' : 'PHONE_ADDED',
          changes: {
            status: [null, status],
            maskedPhone: maskPhone(e164),
            countryCode: country,
            purpose,
            ...(lookedUp ? { lineType: lookedUp.lineType } : {}),
            ...(open ? { supersededContactId: open.id } : {}),
            ...(primary ? { replacesContactId: primary.id } : {}),
          },
        });
        await this.event(trx, cid, PHONE_EVENTS.contactAdded, accountId, {
          accountId,
          phoneContactId: contactId,
          purpose,
          source: 'USER_ENTERED',
          status,
        } satisfies PhoneContactAddedPayload);
        if (primary)
          await this.event(trx, cid, PHONE_EVENTS.changeRequested, accountId, {
            accountId,
            phoneContactId: contactId,
            replacesPhoneContactId: primary.id,
          } satisfies PhoneChangeRequestedPayload);
        return { changed: true, phone: await loadPhoneSummary(trx, accountId) };
      });
      if (result !== 'LOOKUP_NEEDED') return result;
    }
    throw new AccountError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', { reason: 'CONCURRENT_UPDATE', retryable: true });
  }

  /** Disables a pending number (SUPERSEDED) and closes its open challenge. The account row is already locked. */
  private async supersede(trx: Trx, candidate: ContactRow): Promise<void> {
    await sql`UPDATE identity.phone_verification_challenges SET invalidated_at = clock_timestamp(), invalidation_reason = 'CONTACT_DISABLED'
      WHERE phone_contact_id = ${candidate.id} AND used_at IS NULL AND invalidated_at IS NULL`.execute(trx);
    await sql`UPDATE identity.phone_contacts SET status = 'DISABLED', disabled_at = clock_timestamp(), disabled_reason = 'SUPERSEDED', updated_at = now()
      WHERE phone_contact_id = ${candidate.id}`.execute(trx);
  }

  // ------------------------------------------------------------------ send
  /** The authoritative resend cooldown and hour/day caps of one account (same semantics as the email: see EMAIL_VERIFICATION.md "Limits"). */
  private async checkSendWindows(ex: Kysely<DatabaseSchema> | Trx, accountId: string, p: PhoneVerificationPolicy): Promise<void> {
    const w = (
      await sql<Row>`SELECT max(c.created_at) FILTER (WHERE c.delivery_status <> 'FAILED' AND c.used_at IS NULL) AS last_issued,
          array_agg(c.created_at ORDER BY c.created_at) AS created, clock_timestamp() AS now
        FROM identity.phone_verification_challenges c JOIN identity.phone_contacts k ON k.phone_contact_id = c.phone_contact_id
        WHERE k.account_id = ${accountId} AND c.created_at > clock_timestamp() - interval '1 day'`.execute(ex)
    ).rows[0]!;
    const refusal = evaluateSendWindows({
      lastIssued: (w.last_issued as Date | null) ?? null,
      created: ((w.created as Date[] | null) ?? []).map(assertDate),
      now: w.now as Date,
      resendSeconds: p.resendSeconds,
      maxPerHour: p.maxPerHour,
      maxPerDay: p.maxPerDay,
    });
    if (!refusal) return;
    const retryAfterSeconds = refusal.retryAfterSeconds;
    if (refusal.kind === 'COOLDOWN') throw new AccountError('PHONE_RESEND_TOO_SOON', 'a verification text was sent a moment ago', { retryAfterSeconds });
    throw new AccountError(
      'PHONE_SEND_LIMIT',
      refusal.kind === 'HOUR_CAP' ? 'the hourly limit of verification texts was reached' : 'the daily limit of verification texts was reached',
      { retryAfterSeconds },
    );
  }

  /**
   * Issues a verification code for the account's pending number and delivers it by SMS. A resend supersedes the previous challenge. Enforces the cooldown and the hour
   * and day caps (database), the line-type policy (snapshot) and the abuse limits (Valkey, including the per-number budget).
   */
  async sendVerification(accountId: string, ctx: PhoneRequestContext = {}): Promise<SendPhoneVerificationResult> {
    const cid = getCorrelationId() ?? randomUUID();
    // the number is needed for its policy and the per-number limit: read it first (no lock), then re-read under the lock
    const peek = (
      await sql<Row>`SELECT a.status, k.phone_e164, k.country_code, k.line_type FROM identity.accounts a
        LEFT JOIN identity.phone_contacts k ON k.account_id = a.account_id AND k.status IN ('PENDING', 'REPLACEMENT_PENDING')
        WHERE a.account_id = ${accountId}`
        .execute(this.d.database.db)
        .catch(mapDbError)
    ).rows[0];
    if (!peek) throw new AccountError('NOT_FOUND', 'the account does not exist');
    assertUsable(peek.status as AccountStatus);
    if (peek.phone_e164 === null) throw new AccountError('PHONE_NOT_PENDING', 'there is no phone number waiting to be verified');
    const p = await this.policy(peek.country_code as string);
    if (isLineTypeBlocked((peek.line_type as PhoneLineType | null) ?? null, p.blockedLineTypes)) throw this.notAccepted();
    // refused by the cooldown or a cap: nothing will be sent, so the per-number budget must not be spent. The same check runs again under the lock.
    await this.checkSendWindows(this.d.database.db, accountId, p).catch(mapDbError);

    const code = generateNumericCode(p.codeLength);
    const challengeId = randomUUID();
    const issued = await this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const live = await this.liveContacts(trx, accountId, true);
      const candidate = live.find((c) => c.status === 'PENDING' || c.status === 'REPLACEMENT_PENDING');
      if (!candidate) throw new AccountError('PHONE_NOT_PENDING', 'there is no phone number waiting to be verified');
      // the policy, the line type and the per-number budget above were decided for the number read before the lock: if it was replaced meanwhile, start over
      if (candidate.phone !== peek.phone_e164)
        throw new AccountError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', {
          reason: 'CONCURRENT_UPDATE',
          retryable: true,
        });
      await this.checkSendWindows(trx, accountId, p);
      // the abuse limits are charged last, under the account lock and only for a send that will happen (cooldown and caps already passed), to the number the text goes to
      await this.limit('strict', accountId, ctx, p, candidate.phone);
      const locale = (await sql<Row>`SELECT preferred_locale FROM identity.account_profiles WHERE account_id = ${accountId}`.execute(trx)).rows[0]
        ?.preferred_locale as string | undefined;
      await sql`UPDATE identity.phone_verification_challenges SET invalidated_at = clock_timestamp(), invalidation_reason = 'SUPERSEDED'
        WHERE phone_contact_id = ${candidate.id} AND used_at IS NULL AND invalidated_at IS NULL`.execute(trx);
      const purpose = phonePurposeOfStatus(candidate.status as PhoneOpenStatus);
      const row = (
        await sql<Row>`INSERT INTO identity.phone_verification_challenges (challenge_id, phone_contact_id, purpose, code_hash, expires_at, created_at, correlation_id)
          VALUES (${challengeId}, ${candidate.id}, ${purpose}, ${hashPhoneCode(this.d.hashSecret, challengeId, code)},
                  clock_timestamp() + make_interval(mins => ${p.validityMinutes}), clock_timestamp(), ${cid})
          RETURNING created_at, expires_at`.execute(trx)
      ).rows[0]!;
      await this.audit(trx, cid, {
        accountId,
        contactId: candidate.id,
        action: 'PHONE_VERIFICATION_REQUESTED',
        changes: { maskedPhone: maskPhone(candidate.phone), purpose, challengeId },
      });
      return { candidate, purpose, issuedAt: row.created_at as Date, expiresAt: row.expires_at as Date, locale: locale ?? undefined };
    });

    // delivery happens outside any transaction; a failure closes the challenge (the code never reached anyone)
    let failure: SmsDeliveryError | undefined;
    try {
      await this.d.sender.send({
        to: issued.candidate.phone,
        templateKey: this.templateKey,
        variables: { verification_code: code, expiry_minutes: p.validityMinutes },
        locale: issued.locale,
        correlationId: cid,
      });
    } catch (err) {
      failure = err instanceof SmsDeliveryError ? err : new SmsDeliveryError('UNAVAILABLE', 'the SMS provider is unavailable', true);
    }

    if (failure) {
      await this.tx(async (trx) => {
        await sql`UPDATE identity.phone_verification_challenges SET delivery_status = 'FAILED', invalidated_at = clock_timestamp(), invalidation_reason = 'DELIVERY_FAILED'
          WHERE challenge_id = ${challengeId} AND delivery_status = 'PENDING' AND used_at IS NULL AND invalidated_at IS NULL`.execute(trx);
      });
      log('warn', 'verification SMS could not be delivered', { code: failure.code, retryable: failure.retryable, challengeId });
      throw new AccountError('PHONE_DELIVERY_FAILED', 'the verification text could not be sent', { retryable: failure.retryable });
    }

    return this.tx(async (trx) => {
      const sent = (
        await sql<Row>`UPDATE identity.phone_verification_challenges SET delivery_status = 'SENT', last_sent_at = clock_timestamp()
          WHERE challenge_id = ${challengeId} AND delivery_status = 'PENDING' AND used_at IS NULL AND invalidated_at IS NULL
          RETURNING last_sent_at`.execute(trx)
      ).rows[0];
      const sentAt = (sent?.last_sent_at as Date | undefined) ?? new Date();
      if (sent)
        await this.event(trx, cid, PHONE_EVENTS.verificationSent, accountId, {
          accountId,
          phoneContactId: issued.candidate.id,
          challengeId,
          purpose: issued.purpose,
          expiresAt: issued.expiresAt.toISOString(),
        } satisfies PhoneVerificationSentPayload);
      return {
        sentAt,
        expiresAt: issued.expiresAt,
        resendAvailableAt: new Date(issued.issuedAt.getTime() + p.resendSeconds * 1000),
        codeLength: p.codeLength,
        validityMinutes: p.validityMinutes,
        phone: await loadPhoneSummary(trx, accountId),
      };
    });
  }

  // ------------------------------------------------------------------ confirm
  /** Confirms the pending number with the code from the SMS. Wrong codes are counted; repeating a successful confirmation is idempotent. */
  async confirmCode(accountId: string, code: string, ctx: PhoneRequestContext = {}): Promise<ConfirmPhoneResult> {
    const peek = await this.liveContacts(this.d.database.db, accountId, false).catch(mapDbError);
    const p = await this.policy((peek.find((c) => c.status !== 'VERIFIED') ?? peek[0])?.country);
    await this.limit('lenient', accountId, ctx, p);
    const cid = getCorrelationId() ?? randomUUID();
    const outcome = await this.tx(async (trx): Promise<AttemptOutcome> => {
      await this.lockAccount(trx, accountId);
      const live = await this.liveContacts(trx, accountId, true);
      const candidate = live.find((c) => c.status === 'PENDING' || c.status === 'REPLACEMENT_PENDING');
      if (!candidate) {
        if (live.some((c) => c.isPrimary)) return { kind: 'OK', result: { changed: false, phone: await loadPhoneSummary(trx, accountId) } };
        return { kind: 'FAIL', error: new AccountError('PHONE_NOT_PENDING', 'there is no phone number waiting to be verified') };
      }
      const open = (
        await sql<Row>`SELECT ${CHALLENGE_COLUMNS} FROM identity.phone_verification_challenges
          WHERE phone_contact_id = ${candidate.id} AND used_at IS NULL AND invalidated_at IS NULL FOR UPDATE`.execute(trx)
      ).rows[0];
      if (!open) return { kind: 'FAIL', error: await this.noOpenChallengeError(trx, candidate.id) };
      const ch = toChallenge(open);
      if (ch.expired) return { kind: 'FAIL', error: new AccountError('PHONE_CODE_EXPIRED', 'the verification has expired') };
      if (ch.attemptCount >= p.maxAttempts) {
        await this.lockChallenge(trx, ch.id);
        return { kind: 'LOCKED' };
      }
      if (hashesEqual(ch.codeHash, hashPhoneCode(this.d.hashSecret, ch.id, code))) {
        return { kind: 'OK', result: await this.completeVerification(trx, cid, accountId, candidate, live, ch, p) };
      }
      // a code from an earlier SMS of this number (superseded by a resend) is "used or replaced", not a wrong guess: it never verifies and costs no attempt
      const earlier = (
        await sql<Row>`SELECT challenge_id, code_hash FROM identity.phone_verification_challenges
          WHERE phone_contact_id = ${candidate.id} AND invalidation_reason = 'SUPERSEDED' ORDER BY created_at DESC LIMIT 3`.execute(trx)
      ).rows;
      const matchesEarlier = earlier.map((e) => hashesEqual(e.code_hash as string, hashPhoneCode(this.d.hashSecret, e.challenge_id as string, code)));
      if (matchesEarlier.includes(true)) return { kind: 'FAIL', error: new AccountError('PHONE_CODE_USED', 'the verification was already used or replaced') };
      // wrong code: count it under the row lock; the attempt that reaches the maximum locks the challenge. Committed even though the call then fails.
      const counted = (
        await sql<Row>`UPDATE identity.phone_verification_challenges
          SET attempt_count = attempt_count + 1,
              invalidated_at = CASE WHEN attempt_count + 1 >= ${p.maxAttempts} THEN clock_timestamp() END,
              invalidation_reason = CASE WHEN attempt_count + 1 >= ${p.maxAttempts} THEN 'LOCKED' END
          WHERE challenge_id = ${ch.id} RETURNING attempt_count, invalidated_at`.execute(trx)
      ).rows[0]!;
      const attempts = counted.attempt_count as number;
      const locked = counted.invalidated_at !== null;
      // the counted attempt (and the lock) must survive a failing audit or event write: those run in a savepoint whose failure is logged, not propagated
      await sql`SAVEPOINT wrong_attempt_record`.execute(trx);
      try {
        await this.audit(trx, cid, {
          accountId,
          contactId: candidate.id,
          action: 'PHONE_VERIFICATION_FAILED',
          changes: { maskedPhone: maskPhone(candidate.phone), attempt: attempts, challengeId: ch.id },
        });
        if (locked)
          await this.audit(trx, cid, {
            accountId,
            contactId: candidate.id,
            action: 'PHONE_VERIFICATION_LOCKED',
            changes: { maskedPhone: maskPhone(candidate.phone), challengeId: ch.id, attempts },
          });
        await this.event(trx, cid, PHONE_EVENTS.verificationFailed, accountId, {
          accountId,
          phoneContactId: candidate.id,
          challengeId: ch.id,
          attemptCount: attempts,
          locked,
        } satisfies PhoneVerificationFailedPayload);
        await sql`RELEASE SAVEPOINT wrong_attempt_record`.execute(trx);
      } catch (err) {
        await sql`ROLLBACK TO SAVEPOINT wrong_attempt_record`.execute(trx);
        log('error', 'the record of a wrong verification attempt could not be written; the attempt itself is counted', {
          challengeId: ch.id,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
      return { kind: 'WRONG', attemptsRemaining: Math.max(0, p.maxAttempts - attempts), locked };
    });
    switch (outcome.kind) {
      case 'OK':
        return outcome.result;
      case 'FAIL':
        throw outcome.error;
      case 'LOCKED':
        throw new AccountError('PHONE_VERIFICATION_LOCKED', 'too many incorrect attempts; request a new code');
      case 'WRONG':
        if (outcome.locked) throw new AccountError('PHONE_VERIFICATION_LOCKED', 'too many incorrect attempts; request a new code');
        throw new AccountError('PHONE_CODE_INVALID', 'the code is not correct', { attemptsRemaining: outcome.attemptsRemaining });
    }
  }

  private closedChallengeError(reason: string): AccountError {
    if (reason === 'LOCKED') return new AccountError('PHONE_VERIFICATION_LOCKED', 'too many incorrect attempts; request a new code');
    if (reason === 'DELIVERY_FAILED') return new AccountError('PHONE_CODE_INVALID', 'the code is not correct');
    return new AccountError('PHONE_CODE_USED', 'the verification was already used or replaced');
  }

  /** Why a pending number has no usable challenge: locked, superseded, never delivered or never sent. */
  private async noOpenChallengeError(trx: Trx, contactId: string): Promise<AccountError> {
    const newest = (
      await sql<Row>`SELECT invalidation_reason FROM identity.phone_verification_challenges WHERE phone_contact_id = ${contactId} ORDER BY created_at DESC LIMIT 1`.execute(
        trx,
      )
    ).rows[0];
    if (!newest) return new AccountError('PHONE_CODE_INVALID', 'the code is not correct');
    return this.closedChallengeError((newest.invalidation_reason as string | null) ?? 'SUPERSEDED');
  }

  private async lockChallenge(trx: Trx, challengeId: string): Promise<void> {
    await sql`UPDATE identity.phone_verification_challenges SET invalidated_at = clock_timestamp(), invalidation_reason = 'LOCKED'
      WHERE challenge_id = ${challengeId} AND used_at IS NULL AND invalidated_at IS NULL`.execute(trx);
  }

  /**
   * Verifies the number in ONE transaction: re-applies the line policy to the snapshot, serializes on the number and enforces the accounts-per-number maximum,
   * replaces the old primary when this is a change, flips the contact to VERIFIED and primary, consumes the challenge, and writes the audit rows and events.
   * The caller holds the account lock and the challenge row lock.
   */
  private async completeVerification(
    trx: Trx,
    cid: string,
    accountId: string,
    contact: ContactRow,
    live: ContactRow[],
    ch: ChallengeRow,
    p: PhoneVerificationPolicy,
  ): Promise<ConfirmPhoneResult> {
    // the market may have started to block this line type since the number was added: the snapshot is applied again, without calling the vendor
    if (isLineTypeBlocked(contact.lineType, p.blockedLineTypes)) throw this.notAccepted();
    // one transaction lock per NUMBER: every verification of this number, from any account, runs one after the other, so the count below cannot be raced
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'phone:' + contact.phone}, 0))`.execute(trx);
    const holders = (
      await sql<Row>`SELECT count(DISTINCT k.account_id)::int AS n FROM identity.phone_contacts k JOIN identity.accounts a ON a.account_id = k.account_id
        WHERE k.phone_e164 = ${contact.phone} AND k.status = 'VERIFIED' AND k.account_id <> ${accountId} AND a.status <> 'CLOSED'`.execute(trx)
    ).rows[0]!.n as number;
    // the person has just proven the phone, so the typed answer is allowed (before this point nothing says whether anyone else holds the number)
    if (holders >= p.maxAccountsPerNumber)
      throw new AccountError('PHONE_UNAVAILABLE', 'this phone number cannot be verified for this account', { reason: 'NUMBER_UNAVAILABLE' });
    await sql`SELECT set_config('app.phone_max_accounts', ${String(p.maxAccountsPerNumber)}, true)`.execute(trx); // the guard trigger enforces the same value again

    const old = contact.status === 'REPLACEMENT_PENDING' ? live.find((c) => c.isPrimary) : undefined;
    if (old)
      await sql`UPDATE identity.phone_contacts SET status = 'DISABLED', is_primary = false, disabled_at = clock_timestamp(), disabled_reason = 'REPLACED', updated_at = now()
        WHERE phone_contact_id = ${old.id}`.execute(trx);
    await sql`UPDATE identity.phone_contacts SET status = 'VERIFIED', is_primary = true, verified_at = clock_timestamp(), updated_at = now()
      WHERE phone_contact_id = ${contact.id}`.execute(trx);
    await sql`UPDATE identity.phone_verification_challenges SET used_at = clock_timestamp() WHERE challenge_id = ${ch.id}`.execute(trx);
    await this.audit(trx, cid, {
      accountId,
      contactId: contact.id,
      action: 'PHONE_VERIFIED',
      changes: { status: [contact.status, 'VERIFIED'], maskedPhone: maskPhone(contact.phone), purpose: ch.purpose, challengeId: ch.id },
    });
    if (old)
      await this.audit(trx, cid, {
        accountId,
        contactId: contact.id,
        action: 'PHONE_PRIMARY_CHANGED',
        changes: { from: maskPhone(old.phone), to: maskPhone(contact.phone), replacedContactId: old.id },
      });
    await this.event(trx, cid, PHONE_EVENTS.verified, accountId, {
      accountId,
      phoneContactId: contact.id,
      purpose: ch.purpose,
      replacedPhoneContactId: old?.id ?? null,
    } satisfies PhoneVerifiedPayload);
    return { changed: true, phone: await loadPhoneSummary(trx, accountId) };
  }
}
