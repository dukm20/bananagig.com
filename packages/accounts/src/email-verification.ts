// The email contact and its verification (ID-002, docs/engineering/EMAIL_VERIFICATION.md, ADR-0027). BananaGig owns the marketplace contact state;
// Keycloak remains the authentication authority and its email claim is never trusted blindly (see decideIdpEmail).
//
// Rules this file keeps:
//  - Every call acts on the account the CALLER passes in, which the API derives from the verified token. There is no operation by arbitrary account id.
//  - ONE lock order everywhere: account row (FOR UPDATE), then the account's email contact rows, then the challenge row. A code, a link, a resend and a
//    replacement for the same account therefore run one after the other, and the partial unique indexes are the net underneath.
//  - A code or a token is shown ONCE (in the email). Only HMAC hashes are stored; comparisons are constant-time; no secret, address or hash is logged,
//    audited, put in an event or returned by an API. The audit trail and the events name the contact by id, the audit also by a MASKED address.
//  - Sending is two-phase: the challenge commits first, the message is delivered OUTSIDE any transaction (a slow SMTP relay never holds a lock), then the
//    outcome is recorded. A failed delivery closes its challenge (the code never reached anyone) and does not start the resend cooldown.
//  - Wrong attempts are counted under the challenge row lock, so concurrent guesses cannot exceed the configured maximum; the attempt that reaches it locks the
//    challenge. The count is committed even though the call then fails.
//  - A challenge is single use: the row lock plus the used_at update make a code and a link racing verify exactly once; the loser finds the address verified and
//    gets an idempotent success with no second side effect.
//  - Limits: the per-account cooldown and the hourly and daily caps are counted from the database (authoritative, restart-proof). The reusable Valkey limiter
//    adds the dimensions the database cannot see (source address, target address, device). It fails CLOSED where a request sends mail and OPEN only where an
//    authoritative limit exists elsewhere (confirmation: the attempt counter).
//  - Nothing here reveals whether an address is verified on ANOTHER account until the caller has proven control of the mailbox (a correct code or link).
import { randomUUID } from 'node:crypto';
import {
  EMAIL_EVENTS,
  canonicalizeEmail,
  emailIssueMessageKey,
  maskEmail,
  type AccountEmailSummaryDto,
  type AccountStatus,
  type EmailChangeRequestedPayload,
  type EmailContactAddedPayload,
  type EmailOpenStatus,
  type EmailPurpose,
  type EmailSource,
  type EmailVerificationFailedPayload,
  type EmailVerificationSentPayload,
  type EmailVerifiedPayload,
} from '@bananagig/contracts';
import { sql, type Database, type DatabaseSchema, type Kysely, type Trx } from '@bananagig/database';
import { getCorrelationId, log } from '@bananagig/observability';
import { EmailDeliveryError, insertOutboxEvent, RateLimiterUnavailableError, type EmailSender, type RateLimiter, type RateRule } from '@bananagig/platform';
import { generateMagicToken, generateVerificationCode, hashDimension, hashMagicToken, hashVerificationCode, hashesEqual } from './email-crypto';
import {
  assertEmailVerificationPolicy,
  decideIdpEmail,
  type EmailVerificationPolicy,
  type IdpEmailAssertion,
  type VerificationPolicyProvider,
} from './email-policy';
import { loadEmailSummary, purposeOfStatus } from './email-state';
import { AccountError } from './errors';
import { assertUsable, mapDbError } from './service';

type Row = Record<string, unknown>;

export const VERIFICATION_TEMPLATE_KEY = 'account.email.verification';

export interface EmailVerificationDeps {
  database: Database;
  /** The current limits (configuration registry in production). A failure propagates and the service fails closed. */
  policy: VerificationPolicyProvider;
  /** Delivery port (SMTP/Mailpit adapter, or a production provider). No SMTP lives in this service. */
  sender: EmailSender;
  /** Builds the magic link for a plaintext token (the public web origin belongs to the composition root). */
  linkFor: (token: string) => string;
  /** Key of the HMAC that hashes codes, tokens and limit dimensions (VERIFICATION_HASH_SECRET). */
  hashSecret: string;
  /** Reusable abuse limiter (Valkey). Omitted only in tests that exercise the database limits alone. */
  rateLimiter?: RateLimiter;
  /** Template key of the verification message. Default `account.email.verification`. */
  templateKey?: string;
}

/** Facts about the request that the abuse limits need. Nothing here is stored. */
export interface EmailRequestContext {
  /** The client address as the API sees it (hashed before it becomes a counter key). */
  clientIp?: string;
  /** A device or session identifier, where the caller has one. */
  deviceId?: string;
}

export interface SetEmailResult {
  /** False when the call changed nothing (the address was already the pending or the primary one). */
  changed: boolean;
  email: AccountEmailSummaryDto;
}
export interface SendVerificationResult {
  sentAt: Date;
  expiresAt: Date;
  resendAvailableAt: Date;
  codeLength: number;
  validityMinutes: number;
  email: AccountEmailSummaryDto;
}
export interface ConfirmEmailResult {
  /** False for a repeated confirmation of an address that was already verified (idempotent, no side effect). */
  changed: boolean;
  email: AccountEmailSummaryDto;
}
export interface EmailDetail extends AccountEmailSummaryDto {
  resendAvailableAt: Date | null;
  attemptsRemaining: number | null;
  codeLength: number;
  validityMinutes: number;
}
export type IdpEmailBootstrapResult =
  | { applied: true; email: AccountEmailSummaryDto }
  | { applied: false; reason: 'NOT_VERIFIED' | 'UNTRUSTED_SOURCE' | 'NO_EMAIL' | 'INVALID_EMAIL' | 'ACCOUNT_HAS_EMAIL' | 'ADDRESS_UNAVAILABLE' };

interface ContactRow {
  id: string;
  email: string;
  status: 'PENDING' | 'VERIFIED' | 'REPLACEMENT_PENDING';
  isPrimary: boolean;
  source: EmailSource;
}
interface ChallengeRow {
  id: string;
  contactId: string;
  purpose: EmailPurpose;
  codeHash: string;
  attemptCount: number;
  expired: boolean;
  used: boolean;
  invalidationReason: string | null;
  expiresAt: Date;
}

const toContact = (r: Row): ContactRow => ({
  id: r.email_contact_id as string,
  email: r.email_normalized as string,
  status: r.status as ContactRow['status'],
  isPrimary: r.is_primary === true,
  source: r.source as EmailSource,
});
const toChallenge = (r: Row): ChallengeRow => ({
  id: r.challenge_id as string,
  contactId: r.email_contact_id as string,
  purpose: r.purpose as EmailPurpose,
  codeHash: r.code_hash as string,
  attemptCount: r.attempt_count as number,
  expired: r.expired === true,
  used: r.used_at !== null,
  invalidationReason: (r.invalidation_reason as string | null) ?? null,
  expiresAt: r.expires_at as Date,
});

const CHALLENGE_COLUMNS = sql`challenge_id, email_contact_id, purpose, code_hash, attempt_count, used_at, invalidation_reason, expires_at, (expires_at <= clock_timestamp()) AS expired`;
const actorOf = (accountId: string): string => `account:${accountId}`;
const ceilSeconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

type AttemptOutcome =
  | { kind: 'OK'; result: ConfirmEmailResult }
  | { kind: 'WRONG'; attemptsRemaining: number; locked: boolean }
  | { kind: 'LOCKED' }
  | { kind: 'FAIL'; error: AccountError };

export class EmailVerificationService {
  private readonly templateKey: string;

  constructor(private readonly d: EmailVerificationDeps) {
    this.templateKey = d.templateKey ?? VERIFICATION_TEMPLATE_KEY;
  }

  private tx<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.d.database.transaction(fn).catch(mapDbError);
  }

  // ------------------------------------------------------------------ policy and limits
  private async policy(): Promise<EmailVerificationPolicy> {
    try {
      return assertEmailVerificationPolicy(await this.d.policy.policy());
    } catch (err) {
      if (err instanceof AccountError) throw err;
      // a security limit has no code default: without the policy the operation does not happen. The cause is not logged (it can name configuration keys only, but never values).
      log('error', 'email verification policy unavailable');
      throw new AccountError('UNAVAILABLE', 'the email verification policy is not available', { reason: 'POLICY_UNAVAILABLE' });
    }
  }

  /**
   * Consumes the abuse limits of one request. `strict` (operations that send mail) fails CLOSED when the counters are unreachable; otherwise the request
   * proceeds (confirmation is bounded by the attempt counter in PostgreSQL). A refusal never says which dimension refused.
   */
  private async limit(mode: 'strict' | 'lenient', accountId: string, ctx: EmailRequestContext, p: EmailVerificationPolicy, address?: string): Promise<void> {
    const limiter = this.d.rateLimiter;
    if (!limiter) return;
    const rules: RateRule[] = [{ name: 'email-verification:account', key: accountId, limit: p.requestsPerHour, windowSeconds: 3600 }];
    if (ctx.clientIp)
      rules.push({ name: 'email-verification:ip', key: hashDimension(this.d.hashSecret, 'ip', ctx.clientIp), limit: p.requestsPerHour, windowSeconds: 3600 });
    if (ctx.deviceId)
      rules.push({
        name: 'email-verification:device',
        key: hashDimension(this.d.hashSecret, 'device', ctx.deviceId),
        limit: p.requestsPerHour,
        windowSeconds: 3600,
      });
    if (address)
      rules.push({ name: 'email-verification:address', key: hashDimension(this.d.hashSecret, 'email', address), limit: p.addressPerHour, windowSeconds: 3600 });
    try {
      const decision = await limiter.consume(rules);
      if (!decision.allowed) throw new AccountError('EMAIL_RATE_LIMITED', 'too many requests', { retryAfterSeconds: decision.retryAfterSeconds });
    } catch (err) {
      if (err instanceof AccountError) throw err;
      if (!(err instanceof RateLimiterUnavailableError)) throw err;
      if (mode === 'strict') {
        log('error', 'email verification rate limiter unavailable; request refused');
        throw new AccountError('UNAVAILABLE', 'the request cannot be accepted right now', { reason: 'RATE_LIMITER_UNAVAILABLE' });
      }
      log('warn', 'email verification rate limiter unavailable; the attempt counter still applies');
    }
  }

  // ------------------------------------------------------------------ rows
  private async lockAccount(trx: Trx, accountId: string): Promise<void> {
    const r = await sql<Row>`SELECT status FROM identity.accounts WHERE account_id = ${accountId} FOR UPDATE`.execute(trx);
    if (r.rows.length === 0) throw new AccountError('NOT_FOUND', 'the account does not exist');
    assertUsable(r.rows[0]!.status as AccountStatus);
  }

  private async liveContacts(trx: Trx, accountId: string): Promise<ContactRow[]> {
    return (
      await sql<Row>`SELECT email_contact_id, email_normalized, status, is_primary, source FROM identity.email_contacts
        WHERE account_id = ${accountId} AND status <> 'DISABLED' ORDER BY created_at FOR UPDATE`.execute(trx)
    ).rows.map(toContact);
  }

  private audit(trx: Trx, cid: string, a: { accountId: string; contactId: string; action: string; changes: Record<string, unknown> }) {
    return sql`INSERT INTO identity.account_audit_events (actor, action, account_id, email_contact_id, changes, correlation_id)
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
  /** The cheap, masked email state of an account (no configuration read). */
  async getEmailSummary(accountId: string): Promise<AccountEmailSummaryDto> {
    return loadEmailSummary(this.d.database.db, accountId).catch(mapDbError);
  }

  /** The state for the verification screen: the summary plus the resend countdown, the attempts left and the code policy. */
  async getEmailDetail(accountId: string): Promise<EmailDetail> {
    const p = await this.policy();
    return this.tx(async (trx) => {
      const summary = await loadEmailSummary(trx, accountId);
      const t = (
        await sql<Row>`SELECT
            (SELECT max(c.created_at) FILTER (WHERE c.delivery_status <> 'FAILED' AND c.used_at IS NULL) FROM identity.email_verification_challenges c JOIN identity.email_contacts k ON k.email_contact_id = c.email_contact_id
              WHERE k.account_id = ${accountId}) AS last_issued,
            (SELECT c.attempt_count FROM identity.email_verification_challenges c JOIN identity.email_contacts k ON k.email_contact_id = c.email_contact_id
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

  // ------------------------------------------------------------------ add or change the address
  /**
   * Sets the address to verify. No verification email is sent here (see sendVerification).
   *  - without a verified primary the address becomes the PENDING initial address (INITIAL_EMAIL);
   *  - with a verified primary it becomes a REPLACEMENT_PENDING candidate (CHANGE_EMAIL): the verified address stays active and primary until the new one verifies;
   *  - the same pending address again is a no-op; the primary address again withdraws a pending change; a different address supersedes the pending one.
   * The answer is the same whatever any other account holds: another account's pending or verified claim is never consulted here.
   */
  async setEmail(accountId: string, rawEmail: unknown, ctx: EmailRequestContext = {}): Promise<SetEmailResult> {
    const canonical = canonicalizeEmail(rawEmail);
    if (!canonical.ok)
      throw new AccountError('EMAIL_INVALID', 'the email address is not valid', { reason: canonical.code, messageKey: emailIssueMessageKey(canonical.code) });
    const email = canonical.value;
    const p = await this.policy();
    await this.limit('strict', accountId, ctx, p);
    const cid = getCorrelationId() ?? randomUUID();
    return this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const live = await this.liveContacts(trx, accountId);
      const primary = live.find((c) => c.isPrimary);
      const open = live.find((c) => c.status === 'PENDING' || c.status === 'REPLACEMENT_PENDING');

      if (primary && primary.email === email) {
        // the person went back to the verified address: a pending change is withdrawn, otherwise nothing happens
        if (!open) return { changed: false, email: await loadEmailSummary(trx, accountId) };
        await this.supersede(trx, open);
        return { changed: true, email: await loadEmailSummary(trx, accountId) };
      }
      if (open && open.email === email) return { changed: false, email: await loadEmailSummary(trx, accountId) };
      if (open) await this.supersede(trx, open);

      const status: EmailOpenStatus = primary ? 'REPLACEMENT_PENDING' : 'PENDING';
      const purpose = purposeOfStatus(status);
      const inserted = (
        await sql<Row>`INSERT INTO identity.email_contacts (account_id, email_normalized, status, source)
          VALUES (${accountId}, ${email}, ${status}, 'USER_ENTERED') RETURNING email_contact_id`.execute(trx)
      ).rows[0]!;
      const contactId = inserted.email_contact_id as string;
      await this.audit(trx, cid, {
        accountId,
        contactId,
        action: primary ? 'EMAIL_CHANGE_REQUESTED' : 'EMAIL_ADDED',
        changes: {
          status: [null, status],
          maskedEmail: maskEmail(email),
          purpose,
          ...(open ? { supersededContactId: open.id } : {}),
          ...(primary ? { replacesContactId: primary.id } : {}),
        },
      });
      await this.event(trx, cid, EMAIL_EVENTS.contactAdded, accountId, {
        accountId,
        emailContactId: contactId,
        purpose,
        source: 'USER_ENTERED',
        status,
      } satisfies EmailContactAddedPayload);
      if (primary)
        await this.event(trx, cid, EMAIL_EVENTS.changeRequested, accountId, {
          accountId,
          emailContactId: contactId,
          replacesEmailContactId: primary.id,
        } satisfies EmailChangeRequestedPayload);
      return { changed: true, email: await loadEmailSummary(trx, accountId) };
    });
  }

  /** Disables a pending address (SUPERSEDED) and closes its open challenge. The account row is already locked. */
  private async supersede(trx: Trx, candidate: ContactRow): Promise<void> {
    await sql`UPDATE identity.email_verification_challenges SET invalidated_at = clock_timestamp(), invalidation_reason = 'CONTACT_DISABLED'
      WHERE email_contact_id = ${candidate.id} AND used_at IS NULL AND invalidated_at IS NULL`.execute(trx);
    await sql`UPDATE identity.email_contacts SET status = 'DISABLED', disabled_at = clock_timestamp(), disabled_reason = 'SUPERSEDED', updated_at = now()
      WHERE email_contact_id = ${candidate.id}`.execute(trx);
  }

  // ------------------------------------------------------------------ send
  /**
   * The authoritative resend cooldown and hour/day caps of one account, counted from its challenge rows. The cooldown runs from the CREATION of the newest
   * challenge that is neither FAILED nor used: a delivery still in flight counts (a second send cannot slip past it), a failed delivery does not, and a
   * verified address does not hold back the next change. The caps count every challenge, failed deliveries included.
   */
  private async checkSendWindows(ex: Kysely<DatabaseSchema> | Trx, accountId: string, p: EmailVerificationPolicy): Promise<void> {
    const w = (
      await sql<Row>`SELECT max(c.created_at) FILTER (WHERE c.delivery_status <> 'FAILED' AND c.used_at IS NULL) AS last_issued,
          array_agg(c.created_at ORDER BY c.created_at) AS created, clock_timestamp() AS now
        FROM identity.email_verification_challenges c JOIN identity.email_contacts k ON k.email_contact_id = c.email_contact_id
        WHERE k.account_id = ${accountId} AND c.created_at > clock_timestamp() - interval '1 day'`.execute(ex)
    ).rows[0]!;
    const now = w.now as Date;
    const lastIssued = (w.last_issued as Date | null) ?? null;
    const created = ((w.created as Date[] | null) ?? []).filter((t) => t instanceof Date);
    if (lastIssued) {
      const waitMs = lastIssued.getTime() + p.resendSeconds * 1000 - now.getTime();
      if (waitMs > 0) throw new AccountError('EMAIL_RESEND_TOO_SOON', 'a verification email was sent a moment ago', { retryAfterSeconds: ceilSeconds(waitMs) });
    }
    const capWait = (windowMs: number, cap: number): number => {
      const inWindow = created.filter((t) => t.getTime() > now.getTime() - windowMs);
      if (inWindow.length < cap) return 0;
      // the slot frees when the (count - cap + 1)-th oldest request leaves the window
      return inWindow[inWindow.length - cap]!.getTime() + windowMs - now.getTime();
    };
    const hourWait = capWait(3_600_000, p.maxPerHour);
    if (hourWait > 0)
      throw new AccountError('EMAIL_SEND_LIMIT', 'the hourly limit of verification emails was reached', { retryAfterSeconds: ceilSeconds(hourWait) });
    const dayWait = capWait(86_400_000, p.maxPerDay);
    if (dayWait > 0)
      throw new AccountError('EMAIL_SEND_LIMIT', 'the daily limit of verification emails was reached', { retryAfterSeconds: ceilSeconds(dayWait) });
  }

  /**
   * Issues a verification (a code and a magic link in ONE message) for the account's pending address and delivers it. A resend supersedes the previous
   * challenge. Enforces the cooldown, the hourly and the daily cap (database, authoritative) and the abuse limits (Valkey).
   */
  async sendVerification(accountId: string, ctx: EmailRequestContext = {}): Promise<SendVerificationResult> {
    const p = await this.policy();
    const cid = getCorrelationId() ?? randomUUID();
    // the address is needed for the per-address limit: read it first (no lock), then re-read under the lock
    const peek = (
      await sql<Row>`SELECT a.status, k.email_normalized FROM identity.accounts a
        LEFT JOIN identity.email_contacts k ON k.account_id = a.account_id AND k.status IN ('PENDING', 'REPLACEMENT_PENDING')
        WHERE a.account_id = ${accountId}`
        .execute(this.d.database.db)
        .catch(mapDbError)
    ).rows[0];
    if (!peek) throw new AccountError('NOT_FOUND', 'the account does not exist');
    assertUsable(peek.status as AccountStatus);
    if (peek.email_normalized === null) throw new AccountError('EMAIL_NOT_PENDING', 'there is no email address waiting to be verified');
    // refused by the cooldown or a cap: nothing will be sent, so the per-address budget (emails to one address) must not be spent. The same check runs again under the lock.
    await this.checkSendWindows(this.d.database.db, accountId, p).catch(mapDbError);
    await this.limit('strict', accountId, ctx, p, peek.email_normalized as string);

    const code = generateVerificationCode(p.codeLength);
    const token = generateMagicToken();
    const challengeId = randomUUID();
    const issued = await this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const live = await this.liveContacts(trx, accountId);
      const candidate = live.find((c) => c.status === 'PENDING' || c.status === 'REPLACEMENT_PENDING');
      if (!candidate) throw new AccountError('EMAIL_NOT_PENDING', 'there is no email address waiting to be verified');

      await this.checkSendWindows(trx, accountId, p);

      const locale = (await sql<Row>`SELECT preferred_locale FROM identity.account_profiles WHERE account_id = ${accountId}`.execute(trx)).rows[0]
        ?.preferred_locale as string | undefined;

      await sql`UPDATE identity.email_verification_challenges SET invalidated_at = clock_timestamp(), invalidation_reason = 'SUPERSEDED'
        WHERE email_contact_id = ${candidate.id} AND used_at IS NULL AND invalidated_at IS NULL`.execute(trx);
      const purpose = purposeOfStatus(candidate.status as EmailOpenStatus);
      const row = (
        await sql<Row>`INSERT INTO identity.email_verification_challenges (challenge_id, email_contact_id, purpose, code_hash, magic_token_hash, expires_at, created_at, correlation_id)
          VALUES (${challengeId}, ${candidate.id}, ${purpose}, ${hashVerificationCode(this.d.hashSecret, challengeId, code)}, ${hashMagicToken(this.d.hashSecret, token)},
                  clock_timestamp() + make_interval(mins => ${p.validityMinutes}), clock_timestamp(), ${cid})
          RETURNING created_at, expires_at`.execute(trx)
      ).rows[0]!;
      await this.audit(trx, cid, {
        accountId,
        contactId: candidate.id,
        action: 'EMAIL_VERIFICATION_REQUESTED',
        changes: { maskedEmail: maskEmail(candidate.email), purpose, challengeId },
      });
      return { candidate, purpose, issuedAt: row.created_at as Date, expiresAt: row.expires_at as Date, locale: locale ?? undefined };
    });

    // delivery happens outside any transaction; a failure closes the challenge (the code never reached anyone)
    let failure: EmailDeliveryError | undefined;
    try {
      await this.d.sender.send({
        to: issued.candidate.email,
        templateKey: this.templateKey,
        variables: { verification_code: code, verification_url: this.d.linkFor(token), expiry_minutes: p.validityMinutes },
        locale: issued.locale,
        correlationId: cid,
      });
    } catch (err) {
      failure = err instanceof EmailDeliveryError ? err : new EmailDeliveryError('UNAVAILABLE', 'the mail server is unavailable', true);
    }

    if (failure) {
      await this.tx(async (trx) => {
        await sql`UPDATE identity.email_verification_challenges SET delivery_status = 'FAILED', invalidated_at = clock_timestamp(), invalidation_reason = 'DELIVERY_FAILED'
          WHERE challenge_id = ${challengeId} AND delivery_status = 'PENDING' AND used_at IS NULL AND invalidated_at IS NULL`.execute(trx);
      });
      log('warn', 'verification email could not be delivered', { code: failure.code, retryable: failure.retryable, challengeId });
      throw new AccountError('EMAIL_DELIVERY_FAILED', 'the verification email could not be sent', { retryable: failure.retryable });
    }

    return this.tx(async (trx) => {
      const sent = (
        await sql<Row>`UPDATE identity.email_verification_challenges SET delivery_status = 'SENT', last_sent_at = clock_timestamp()
          WHERE challenge_id = ${challengeId} AND delivery_status = 'PENDING' AND used_at IS NULL AND invalidated_at IS NULL
          RETURNING last_sent_at`.execute(trx)
      ).rows[0];
      const sentAt = (sent?.last_sent_at as Date | undefined) ?? new Date();
      if (sent)
        await this.event(trx, cid, EMAIL_EVENTS.verificationSent, accountId, {
          accountId,
          emailContactId: issued.candidate.id,
          challengeId,
          purpose: issued.purpose,
          expiresAt: issued.expiresAt.toISOString(),
        } satisfies EmailVerificationSentPayload);
      return {
        sentAt,
        expiresAt: issued.expiresAt,
        resendAvailableAt: new Date(issued.issuedAt.getTime() + p.resendSeconds * 1000),
        codeLength: p.codeLength,
        validityMinutes: p.validityMinutes,
        email: await loadEmailSummary(trx, accountId),
      };
    });
  }

  // ------------------------------------------------------------------ confirm
  /** Confirms the pending address with the code from the email. Wrong codes are counted; repeating a successful confirmation is idempotent. */
  async confirmCode(accountId: string, code: string, ctx: EmailRequestContext = {}): Promise<ConfirmEmailResult> {
    const p = await this.policy();
    await this.limit('lenient', accountId, ctx, p);
    const cid = getCorrelationId() ?? randomUUID();
    const outcome = await this.tx(async (trx): Promise<AttemptOutcome> => {
      await this.lockAccount(trx, accountId);
      const live = await this.liveContacts(trx, accountId);
      const candidate = live.find((c) => c.status === 'PENDING' || c.status === 'REPLACEMENT_PENDING');
      if (!candidate) {
        if (live.some((c) => c.isPrimary)) return { kind: 'OK', result: { changed: false, email: await loadEmailSummary(trx, accountId) } };
        return { kind: 'FAIL', error: new AccountError('EMAIL_NOT_PENDING', 'there is no email address waiting to be verified') };
      }
      const open = (
        await sql<Row>`SELECT ${CHALLENGE_COLUMNS} FROM identity.email_verification_challenges
          WHERE email_contact_id = ${candidate.id} AND used_at IS NULL AND invalidated_at IS NULL FOR UPDATE`.execute(trx)
      ).rows[0];
      if (!open) return { kind: 'FAIL', error: await this.noOpenChallengeError(trx, candidate.id) };
      const ch = toChallenge(open);
      if (ch.expired) return { kind: 'FAIL', error: new AccountError('EMAIL_CODE_EXPIRED', 'the verification has expired') };
      if (ch.attemptCount >= p.maxAttempts) {
        await this.lockChallenge(trx, ch.id);
        return { kind: 'LOCKED' };
      }
      if (hashesEqual(ch.codeHash, hashVerificationCode(this.d.hashSecret, ch.id, code))) {
        return { kind: 'OK', result: await this.completeVerification(trx, cid, accountId, candidate, live, ch, 'CODE') };
      }
      // a code from an earlier email of this address (superseded by a resend) is "used or replaced", not a wrong guess: it never verifies and costs no attempt
      const earlier = (
        await sql<Row>`SELECT challenge_id, code_hash FROM identity.email_verification_challenges
          WHERE email_contact_id = ${candidate.id} AND invalidation_reason = 'SUPERSEDED' ORDER BY created_at DESC LIMIT 3`.execute(trx)
      ).rows;
      const matchesEarlier = earlier.map((e) => hashesEqual(e.code_hash as string, hashVerificationCode(this.d.hashSecret, e.challenge_id as string, code)));
      if (matchesEarlier.includes(true)) return { kind: 'FAIL', error: new AccountError('EMAIL_CODE_USED', 'the verification was already used or replaced') };
      // wrong code: count it under the row lock; the attempt that reaches the maximum locks the challenge. Committed even though the call then fails.
      const counted = (
        await sql<Row>`UPDATE identity.email_verification_challenges
          SET attempt_count = attempt_count + 1,
              invalidated_at = CASE WHEN attempt_count + 1 >= ${p.maxAttempts} THEN clock_timestamp() END,
              invalidation_reason = CASE WHEN attempt_count + 1 >= ${p.maxAttempts} THEN 'LOCKED' END
          WHERE challenge_id = ${ch.id} RETURNING attempt_count, invalidated_at`.execute(trx)
      ).rows[0]!;
      const attempts = counted.attempt_count as number;
      const locked = counted.invalidated_at !== null;
      await this.audit(trx, cid, {
        accountId,
        contactId: candidate.id,
        action: 'EMAIL_VERIFICATION_FAILED',
        changes: { maskedEmail: maskEmail(candidate.email), attempt: attempts, challengeId: ch.id },
      });
      if (locked)
        await this.audit(trx, cid, {
          accountId,
          contactId: candidate.id,
          action: 'EMAIL_VERIFICATION_LOCKED',
          changes: { maskedEmail: maskEmail(candidate.email), challengeId: ch.id, attempts },
        });
      await this.event(trx, cid, EMAIL_EVENTS.verificationFailed, accountId, {
        accountId,
        emailContactId: candidate.id,
        challengeId: ch.id,
        attemptCount: attempts,
        locked,
      } satisfies EmailVerificationFailedPayload);
      return { kind: 'WRONG', attemptsRemaining: Math.max(0, p.maxAttempts - attempts), locked };
    });
    return this.settle(outcome);
  }

  /** Confirms the pending address with the magic-link token (opened by the person, posted by the web server). */
  async confirmLink(accountId: string, token: string, ctx: EmailRequestContext = {}): Promise<ConfirmEmailResult> {
    const p = await this.policy();
    await this.limit('lenient', accountId, ctx, p);
    const cid = getCorrelationId() ?? randomUUID();
    const tokenHash = hashMagicToken(this.d.hashSecret, token);
    const found = (
      await sql<Row>`SELECT c.challenge_id, k.account_id FROM identity.email_verification_challenges c JOIN identity.email_contacts k ON k.email_contact_id = c.email_contact_id
        WHERE c.magic_token_hash = ${tokenHash}`
        .execute(this.d.database.db)
        .catch(mapDbError)
    ).rows[0];
    // an unknown token and another account's token are indistinguishable
    if (!found || found.account_id !== accountId) throw new AccountError('EMAIL_LINK_INVALID', 'the verification link is not valid');
    const outcome = await this.tx(async (trx): Promise<AttemptOutcome> => {
      await this.lockAccount(trx, accountId);
      const live = await this.liveContacts(trx, accountId);
      const row = (
        await sql<Row>`SELECT ${CHALLENGE_COLUMNS} FROM identity.email_verification_challenges WHERE challenge_id = ${found.challenge_id as string} FOR UPDATE`.execute(
          trx,
        )
      ).rows[0];
      if (!row) return { kind: 'FAIL', error: new AccountError('EMAIL_LINK_INVALID', 'the verification link is not valid') };
      const ch = toChallenge(row);
      const contact = live.find((c) => c.id === ch.contactId);
      if (ch.used) {
        // consumed by the code (or by an earlier click) a moment ago: the address is verified, so this is an idempotent success
        if (contact?.status === 'VERIFIED') return { kind: 'OK', result: { changed: false, email: await loadEmailSummary(trx, accountId) } };
        return { kind: 'FAIL', error: new AccountError('EMAIL_CODE_USED', 'the verification was already used or replaced') };
      }
      if (ch.invalidationReason !== null) return { kind: 'FAIL', error: this.closedChallengeError(ch.invalidationReason) };
      if (!contact || contact.status === 'VERIFIED')
        return { kind: 'FAIL', error: new AccountError('EMAIL_CODE_USED', 'the verification was already used or replaced') };
      if (ch.expired) return { kind: 'FAIL', error: new AccountError('EMAIL_CODE_EXPIRED', 'the verification has expired') };
      return { kind: 'OK', result: await this.completeVerification(trx, cid, accountId, contact, live, ch, 'LINK') };
    });
    return this.settle(outcome);
  }

  private settle(outcome: AttemptOutcome): ConfirmEmailResult {
    switch (outcome.kind) {
      case 'OK':
        return outcome.result;
      case 'FAIL':
        throw outcome.error;
      case 'LOCKED':
        throw new AccountError('EMAIL_VERIFICATION_LOCKED', 'too many incorrect attempts; request a new code');
      case 'WRONG':
        if (outcome.locked) throw new AccountError('EMAIL_VERIFICATION_LOCKED', 'too many incorrect attempts; request a new code');
        throw new AccountError('EMAIL_CODE_INVALID', 'the code is not correct', { attemptsRemaining: outcome.attemptsRemaining });
    }
  }

  private closedChallengeError(reason: string): AccountError {
    if (reason === 'LOCKED') return new AccountError('EMAIL_VERIFICATION_LOCKED', 'too many incorrect attempts; request a new code');
    if (reason === 'DELIVERY_FAILED') return new AccountError('EMAIL_CODE_INVALID', 'the code is not correct');
    return new AccountError('EMAIL_CODE_USED', 'the verification was already used or replaced');
  }

  /** Why a pending address has no usable challenge: locked, superseded, never delivered or never sent. */
  private async noOpenChallengeError(trx: Trx, contactId: string): Promise<AccountError> {
    const newest = (
      await sql<Row>`SELECT invalidation_reason FROM identity.email_verification_challenges WHERE email_contact_id = ${contactId} ORDER BY created_at DESC LIMIT 1`.execute(
        trx,
      )
    ).rows[0];
    if (!newest) return new AccountError('EMAIL_CODE_INVALID', 'the code is not correct');
    return this.closedChallengeError((newest.invalidation_reason as string | null) ?? 'SUPERSEDED');
  }

  private async lockChallenge(trx: Trx, challengeId: string): Promise<void> {
    await sql`UPDATE identity.email_verification_challenges SET invalidated_at = clock_timestamp(), invalidation_reason = 'LOCKED'
      WHERE challenge_id = ${challengeId} AND used_at IS NULL AND invalidated_at IS NULL`.execute(trx);
  }

  /**
   * Verifies the address in ONE transaction: replaces the old primary when this is a change, flips the contact to VERIFIED and primary, consumes the
   * challenge, and writes the audit rows and events. The caller holds the account lock and the challenge row lock.
   */
  private async completeVerification(
    trx: Trx,
    cid: string,
    accountId: string,
    contact: ContactRow,
    live: ContactRow[],
    ch: ChallengeRow,
    method: 'CODE' | 'LINK',
  ): Promise<ConfirmEmailResult> {
    // the address may already be verified on another account: the person has just proven the mailbox, so the typed answer is allowed (and the unique index is the net)
    const elsewhere =
      await sql<Row>`SELECT 1 FROM identity.email_contacts WHERE email_normalized = ${contact.email} AND status = 'VERIFIED' AND account_id <> ${accountId}`.execute(
        trx,
      );
    if (elsewhere.rows.length > 0)
      throw new AccountError('EMAIL_UNAVAILABLE', 'this email address cannot be verified for this account', { reason: 'ADDRESS_UNAVAILABLE' });

    const old = contact.status === 'REPLACEMENT_PENDING' ? live.find((c) => c.isPrimary) : undefined;
    if (old)
      await sql`UPDATE identity.email_contacts SET status = 'DISABLED', is_primary = false, disabled_at = clock_timestamp(), disabled_reason = 'REPLACED', updated_at = now()
        WHERE email_contact_id = ${old.id}`.execute(trx);
    await sql`UPDATE identity.email_contacts SET status = 'VERIFIED', is_primary = true, verified_at = clock_timestamp(), updated_at = now()
      WHERE email_contact_id = ${contact.id}`.execute(trx);
    await sql`UPDATE identity.email_verification_challenges SET used_at = clock_timestamp(), consumed_via = ${method} WHERE challenge_id = ${ch.id}`.execute(
      trx,
    );
    await this.audit(trx, cid, {
      accountId,
      contactId: contact.id,
      action: 'EMAIL_VERIFIED',
      changes: { status: [contact.status, 'VERIFIED'], maskedEmail: maskEmail(contact.email), method, purpose: ch.purpose, challengeId: ch.id },
    });
    if (old)
      await this.audit(trx, cid, {
        accountId,
        contactId: contact.id,
        action: 'EMAIL_PRIMARY_CHANGED',
        changes: { from: maskEmail(old.email), to: maskEmail(contact.email), replacedContactId: old.id },
      });
    await this.event(trx, cid, EMAIL_EVENTS.verified, accountId, {
      accountId,
      emailContactId: contact.id,
      purpose: ch.purpose,
      source: contact.source,
      method,
      replacedEmailContactId: old?.id ?? null,
    } satisfies EmailVerifiedPayload);
    return { changed: true, email: await loadEmailSummary(trx, accountId) };
  }

  // ------------------------------------------------------------------ trusted identity provider email
  /**
   * Applies the explicit trust policy (decideIdpEmail) to an email a provider reported: ONLY a verified address from a trusted provider becomes a VERIFIED
   * contact (source IDP_VERIFIED), and only when the account has no email contact yet. Everything else changes nothing (a plain claim is never persisted).
   * Not wired to any HTTP path in ID-002: access tokens carry no email claim; the first caller is a future brokered-login flow.
   */
  async bootstrapIdpEmail(accountId: string, assertion: IdpEmailAssertion, trustedProviders: ReadonlySet<string>): Promise<IdpEmailBootstrapResult> {
    const decision = decideIdpEmail(assertion, trustedProviders);
    if (decision.kind === 'IGNORE') return { applied: false, reason: decision.reason };
    if (decision.kind === 'SUGGESTION') return { applied: false, reason: decision.reason };
    const cid = getCorrelationId() ?? randomUUID();
    try {
      return await this.tx(async (trx): Promise<IdpEmailBootstrapResult> => {
        await this.lockAccount(trx, accountId);
        if ((await this.liveContacts(trx, accountId)).length > 0) return { applied: false, reason: 'ACCOUNT_HAS_EMAIL' };
        const elsewhere = await sql<Row>`SELECT 1 FROM identity.email_contacts WHERE email_normalized = ${decision.email} AND status = 'VERIFIED'`.execute(trx);
        if (elsewhere.rows.length > 0) return { applied: false, reason: 'ADDRESS_UNAVAILABLE' };
        const inserted = (
          await sql<Row>`INSERT INTO identity.email_contacts (account_id, email_normalized, status, is_primary, source, verified_at)
            VALUES (${accountId}, ${decision.email}, 'VERIFIED', true, 'IDP_VERIFIED', clock_timestamp()) RETURNING email_contact_id`.execute(trx)
        ).rows[0]!;
        const contactId = inserted.email_contact_id as string;
        await this.audit(trx, cid, {
          accountId,
          contactId,
          action: 'EMAIL_ADDED',
          changes: { status: [null, 'VERIFIED'], maskedEmail: maskEmail(decision.email), source: 'IDP_VERIFIED', purpose: 'INITIAL_EMAIL' },
        });
        await this.audit(trx, cid, {
          accountId,
          contactId,
          action: 'EMAIL_VERIFIED',
          changes: { status: [null, 'VERIFIED'], maskedEmail: maskEmail(decision.email), method: 'IDP', purpose: 'INITIAL_EMAIL' },
        });
        await this.event(trx, cid, EMAIL_EVENTS.contactAdded, accountId, {
          accountId,
          emailContactId: contactId,
          purpose: 'INITIAL_EMAIL',
          source: 'IDP_VERIFIED',
          status: 'VERIFIED',
        } satisfies EmailContactAddedPayload);
        await this.event(trx, cid, EMAIL_EVENTS.verified, accountId, {
          accountId,
          emailContactId: contactId,
          purpose: 'INITIAL_EMAIL',
          source: 'IDP_VERIFIED',
          method: 'IDP',
          replacedEmailContactId: null,
        } satisfies EmailVerifiedPayload);
        return { applied: true, email: await loadEmailSummary(trx, accountId) };
      });
    } catch (err) {
      // another account verified the same address between the check and the insert: the unique index decided
      if (err instanceof AccountError && err.code === 'EMAIL_UNAVAILABLE') return { applied: false, reason: 'ADDRESS_UNAVAILABLE' };
      throw err;
    }
  }
}
