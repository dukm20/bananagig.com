// The account security layer (ID-004, docs/engineering/SESSIONS_AND_MFA.md, ADR-0034 to ADR-0036): the application session registry, the device registry with the
// trusted-browser window, the revocation watermark, the second-factor status and observed transitions, the security timeline and the password-reset request.
//
// Ownership: Keycloak owns passwords, TOTP, recovery codes and the protocol sessions. This service only ASKS it (SecurityIdentityProvider) and never stores a credential,
// a token or a code. BananaGig owns the rows in identity.application_sessions / account_devices, the watermark identity.accounts.sessions_not_before and the audit trail.
//
// Rules this file keeps:
//  - Every operation acts on the account the CALLER passes in, which the API derives from the verified token. There is no operation by arbitrary account id, and a
//    session or device id of ANOTHER account is simply "not found".
//  - ONE lock order everywhere: the account row (FOR UPDATE), then the device row, then the session rows. The only paths that do not take the account row FOR UPDATE are
//    the request-path touch (one statement on one session row, it waits for nothing) and first-sight creation (account row FOR SHARE, then an INSERT), so revoke-all
//    (FOR UPDATE) and a first sight serialize: either the new row exists when revoke-all runs (and is revoked) or the first sight reads the raised watermark.
//  - observeSession's common case is ONE statement: it reads the row state and touches last_seen_at (at most once a minute) in one round trip. A revoked session is
//    refused at once, which is what makes "sign out everywhere" immediate although access tokens live minutes. A row of another account is treated as revoked.
//  - Revocation in the database is authoritative; propagation to Keycloak is best effort AFTER the commit and never undoes it. The outcome is reported
//    (ENDED | UNAVAILABLE | NOT_NEEDED). No lock is held across a network call.
//  - Privacy: logs, errors, audit `changes`, events and results carry identifiers and codes only. The Keycloak session id (sid), tokens, the device secret, the user agent,
//    raw IP addresses, email addresses and the Keycloak subject never reach a log line, an error detail, an audit change or an event. The sid is read from the
//    database only to end the Keycloak session and is never returned.
//  - Observed second-factor and password transitions are written lazily by comparing Keycloak's state with the LAST such audit action of the account, under the
//    account lock, so two concurrent observers write one row.
import { randomUUID } from 'node:crypto';
import {
  KEYCLOAK_ACTION_OF_METHOD,
  MFA_METHODS,
  SECURITY_ACTIVITY_DEFAULT_LIMIT,
  SECURITY_ACTIVITY_MAX_LIMIT,
  SECURITY_ACTIVITY_TYPES,
  SECURITY_EVENTS,
  canonicalizeEmail,
  isMfaAcr,
  securityActivityLabelKey,
  type AccountStatus,
  type BrowserFamily,
  type DeviceClass,
  type DeviceRemovedDto,
  type DeviceSummaryDto,
  type DeviceTrustDto,
  type KeycloakPropagationOutcome,
  type MfaEnrollmentDto,
  type MfaMethod,
  type OsFamily,
  type RegisteredSessionDto,
  type SecurityActivityDto,
  type SecurityActivityType,
  type SecurityDevicesDto,
  type SecurityOverviewDto,
  type SecuritySessionsDto,
  type SessionRevocationReason,
  type SessionRevokedDto,
  type SessionsRevokedAllDto,
  type SignedOutDto,
} from '@bananagig/contracts';
import { sql, type Database, type DatabaseSchema, type Kysely, type Trx } from '@bananagig/database';
import { getCorrelationId, log } from '@bananagig/observability';
import { insertOutboxEvent, type RateLimiter } from '@bananagig/platform';
import { hashDimension } from './email-crypto';
import { AccountError } from './errors';
import { classifyUserAgent, hashDeviceSecret, isDeviceSecretShape } from './security-device';
import { assertSecurityPolicy } from './security-policy';
import {
  SecurityProviderUnavailableError,
  type CurrentSession,
  type IdentityUserSecurity,
  type ObservedSession,
  type RegisterSessionInput,
  type SecurityIdentityProvider,
  type SecurityOperations,
  type SecurityPolicy,
  type SecurityPolicyProvider,
  type SecurityRequestContext,
  type SessionObservation,
  type TimelineQuery,
  type TokenFacts,
} from './security-types';
import { assertUsable, mapDbError } from './service';
import { consumeRules } from './verification-core';

type Row = Record<string, unknown>;
type Executor = Kysely<DatabaseSchema> | Trx;

export interface SecurityServiceDeps {
  database: Database;
  /** The current policy (configuration registry in production). A failure propagates and the operation fails closed. */
  policy: SecurityPolicyProvider;
  /** Keycloak as seen by the security layer (the admin REST API in production; a null provider with `available = false` when no admin client is configured). */
  identityProvider: SecurityIdentityProvider;
  /** Reusable abuse limiter (Valkey): the password-reset request limits. */
  rateLimiter: RateLimiter;
  /** Key of the HMAC that hashes device secrets and limit dimensions (VERIFICATION_HASH_SECRET). */
  hashSecret: string;
  /** The application clock for token-derived values (step-up freshness). Database timestamps always use the database clock. */
  now?: () => Date;
  /** Minimum seconds between two `last_seen_at` touches of one session (default 60). */
  touchSeconds?: number;
  /** A session younger than this is never ended by the reconciliation with the identity provider (default 15): its Keycloak session may not be listed yet. */
  reconcileGraceSeconds?: number;
}

/** Window (minutes) added to the reset link lifetime when a password change is attributed to a reset request: clock skew between Keycloak and the database. */
const RESET_ATTRIBUTION_GRACE_MINUTES = 5;
/** The most sessions / devices one list returns (an account has a handful; this bounds a hostile one). */
const LIST_LIMIT = 200;
/** The most already-revoked sessions one listing re-tries to end at the identity provider. */
const REPROPAGATION_LIMIT = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The timeline cursor `before`: an ISO instant (1 to 6 fraction digits, Z or an offset) optionally followed by `_` and the audit event id (a uuid). The service itself
 * returns the composite form `<microsecond UTC instant>_<uuid>`; the plain instant means "strictly older than that instant".
 */
const BEFORE_SHAPE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))(?:_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}))?$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Whether an ISO instant (already matched by BEFORE_SHAPE) is a real moment: the calendar date exists (round-trip), the year is 1..9999, the hour is 0..23, the minute and
 * second 0..59 (no leap second, no hour 24) and a numeric offset is within +-15:59 (what PostgreSQL accepts). Checked here so a bad value is a validation error and never reaches PostgreSQL.
 */
function isRealInstant(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(text);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (y < 1 || y > 9999 || h > 23 || mi > 59 || sec > 59) return false;
  if (m[7] !== undefined && (Number(m[8]) > 15 || Number(m[9]) > 59)) return false;
  const probe = new Date(0);
  probe.setUTCFullYear(y, mo - 1, d);
  probe.setUTCHours(h, mi, sec, 0);
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d && probe.getUTCHours() === h;
}
// eslint-disable-next-line no-control-regex
const SESSION_ID_FORBIDDEN = /[\u0000- \u007F]/;

const actorOf = (accountId: string): string => `account:${accountId}`;
const iso = (v: unknown): string => (v as Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);
const errorCode = (err: unknown): string =>
  err instanceof SecurityProviderUnavailableError ? err.reason : err instanceof AccountError ? err.code : 'UNEXPECTED';

const sessionRevoked = (): AccountError => new AccountError('SESSION_REVOKED', 'the session was revoked');
const sessionNotFound = (): AccountError => new AccountError('SESSION_NOT_FOUND', 'the session was not found');
const deviceNotFound = (): AccountError => new AccountError('DEVICE_NOT_FOUND', 'the device was not found');

interface SessionRow {
  id: string;
  accountId: string;
  keycloakSessionId: string;
  deviceId: string | null;
  revoked: boolean;
  /** The reason of a revoked row, else null. */
  reason: string | null;
}
const toSession = (r: Row): SessionRow => ({
  id: r.application_session_id as string,
  accountId: r.account_id as string,
  keycloakSessionId: r.keycloak_session_id as string,
  deviceId: (r.account_device_id as string | null) ?? null,
  revoked: r.revoked === true,
  reason: (r.revocation_reason as string | null | undefined) ?? null,
});

interface DeviceRow {
  id: string;
  browser: BrowserFamily;
  os: OsFamily;
  deviceClass: DeviceClass;
  firstSeenAt: Date;
  lastSeenAt: Date;
  trustedUntil: Date | null;
  trusted: boolean;
  removed: boolean;
}
const toDevice = (r: Row): DeviceRow => ({
  id: r.account_device_id as string,
  browser: r.browser_family as BrowserFamily,
  os: r.os_family as OsFamily,
  deviceClass: r.device_class as DeviceClass,
  firstSeenAt: r.first_seen_at as Date,
  lastSeenAt: r.last_seen_at as Date,
  trustedUntil: (r.trusted_until as Date | null) ?? null,
  trusted: r.trusted === true,
  removed: r.removed_at !== null && r.removed_at !== undefined,
});
const DEVICE_COLUMNS = sql`d.account_device_id, d.browser_family, d.os_family, d.device_class, d.first_seen_at, d.last_seen_at, d.trusted_until, d.removed_at,
  (d.trusted_until > clock_timestamp() AND d.removed_at IS NULL) AS trusted`;
const summaryOf = (d: Pick<DeviceRow, 'browser' | 'os' | 'deviceClass'>): DeviceSummaryDto => ({ browser: d.browser, os: d.os, deviceClass: d.deviceClass });

interface Transition {
  action: string;
  changes: Record<string, unknown>;
  event?: { type: string; payload: Record<string, unknown> };
  /** A password change: every other live session that started before this moment is revoked with the transition. */
  endSessionsBefore?: Date;
}

export class SecurityService implements SecurityOperations {
  private readonly now: () => Date;
  private readonly touchSeconds: number;
  private readonly graceSeconds: number;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly d: SecurityServiceDeps) {
    this.now = d.now ?? ((): Date => new Date());
    this.touchSeconds = d.touchSeconds ?? 60;
    this.graceSeconds = d.reconcileGraceSeconds ?? 15;
  }

  // ------------------------------------------------------------------ plumbing
  private tx<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.d.database.transaction(fn).catch(mapDbError);
  }
  private get db(): Executor {
    return this.d.database.db;
  }

  /** Reads and validates the policy. A security limit has no code default: without the policy the operation does not happen. The cause is not logged. */
  private async policy(): Promise<SecurityPolicy> {
    try {
      return assertSecurityPolicy(await this.d.policy.policy());
    } catch (err) {
      if (err instanceof AccountError) throw err;
      log('error', 'security policy unavailable');
      throw new AccountError('UNAVAILABLE', 'the security policy is not available', { reason: 'POLICY_UNAVAILABLE' });
    }
  }

  /** Locks the account row (FOR UPDATE) and returns its status and watermark. `usable` refuses SUSPENDED and CLOSED accounts; revocations do not need it. */
  private async lockAccount(trx: Trx, accountId: string, usable: boolean): Promise<{ status: AccountStatus; watermark: Date | null }> {
    const r = await sql<Row>`SELECT status, sessions_not_before FROM identity.accounts WHERE account_id = ${accountId} FOR UPDATE`.execute(trx);
    if (r.rows.length === 0) throw new AccountError('NOT_FOUND', 'the account does not exist');
    const status = r.rows[0]!.status as AccountStatus;
    if (usable) assertUsable(status);
    return { status, watermark: (r.rows[0]!.sessions_not_before as Date | null) ?? null };
  }

  private audit(
    trx: Trx,
    cid: string,
    a: { accountId: string; action: string; sessionId?: string; deviceId?: string; changes?: Record<string, unknown> },
  ): Promise<unknown> {
    return sql`INSERT INTO identity.account_audit_events (actor, action, account_id, application_session_id, account_device_id, changes, correlation_id)
      VALUES (${actorOf(a.accountId)}, ${a.action}, ${a.accountId}, ${a.sessionId ?? null}, ${a.deviceId ?? null}, ${JSON.stringify(a.changes ?? {})}::jsonb, ${cid})`.execute(
      trx,
    );
  }
  private event(trx: Trx, cid: string, eventType: string, accountId: string, payload: Record<string, unknown>): Promise<string> {
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

  /** The Keycloak subject of the account, or null. The subject is a personal identifier: it is never logged or returned. */
  private async subjectOf(ex: Executor, accountId: string): Promise<string | null> {
    const r =
      await sql<Row>`SELECT provider_subject FROM identity.external_identities WHERE account_id = ${accountId} AND provider_type = 'KEYCLOAK' ORDER BY created_at LIMIT 1`.execute(
        ex,
      );
    return (r.rows[0]?.provider_subject as string | undefined) ?? null;
  }

  private async providerSessionStartedAt(accountId: string, sessionId: string): Promise<Date | null> {
    const provider = this.d.identityProvider;
    if (!provider.available) return null;
    const subject = await this.subjectOf(this.db, accountId).catch(mapDbError);
    if (!subject) return null;
    try {
      const session = (await provider.listSessions(subject)).find((s) => s.id === sessionId);
      const startedAt = session?.startedAt;
      return startedAt instanceof Date && Number.isFinite(startedAt.getTime()) ? startedAt : null;
    } catch (err) {
      log('warn', 'identity provider session start could not be read', { code: errorCode(err) });
      return null;
    }
  }

  private async currentSession(ex: Executor, current: CurrentSession, lock = false): Promise<SessionRow | null> {
    const rows = lock
      ? await sql<Row>`SELECT application_session_id, account_id, keycloak_session_id, account_device_id, revoked_at IS NOT NULL AS revoked, revocation_reason
          FROM identity.application_sessions WHERE keycloak_session_id = ${current.keycloakSessionId} AND account_id = ${current.accountId} FOR UPDATE`.execute(
          ex,
        )
      : await sql<Row>`SELECT application_session_id, account_id, keycloak_session_id, account_device_id, revoked_at IS NOT NULL AS revoked, revocation_reason
          FROM identity.application_sessions WHERE keycloak_session_id = ${current.keycloakSessionId} AND account_id = ${current.accountId}`.execute(ex);
    return rows.rows[0] ? toSession(rows.rows[0]) : null;
  }

  /** Runs a background task WITHOUT making the caller wait for it. A failure is logged as a code only (never a subject, address, link or session id). */
  private detach(task: string, fn: () => Promise<void>): void {
    const p: Promise<void> = Promise.resolve()
      .then(fn)
      .catch((err: unknown) => {
        log('warn', 'security background task failed', { task, code: errorCode(err) });
      })
      .finally(() => {
        this.pending.delete(p);
      });
    this.pending.add(p);
  }
  /** Waits until every detached task has settled (tests and graceful shutdown). */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // ------------------------------------------------------------------ Keycloak propagation (best effort, after the commit)
  private async endProviderSessions(sessionIds: readonly string[]): Promise<KeycloakPropagationOutcome> {
    if (sessionIds.length === 0) return 'NOT_NEEDED';
    if (!this.d.identityProvider.available) return 'UNAVAILABLE';
    let ok = true;
    for (const sid of sessionIds) {
      try {
        await this.d.identityProvider.endSession(sid);
      } catch (err) {
        ok = false;
        log('warn', 'identity provider session could not be ended', { code: errorCode(err) });
      }
    }
    return ok ? 'ENDED' : 'UNAVAILABLE';
  }

  // ------------------------------------------------------------------ sessions
  async observeSession(input: SessionObservation): Promise<ObservedSession> {
    const sid = input.keycloakSessionId;
    if (typeof sid !== 'string' || sid.length < 1 || sid.length > 100 || SESSION_ID_FORBIDDEN.test(sid))
      throw new AccountError('VALIDATION_FAILED', 'the session identifier is not usable', { reason: 'INVALID_SESSION_ID' });

    // The common case: ONE statement. `hit` reads the row state; `touch` moves last_seen_at when it is older than the touch interval. The touch carries its own
    // conditions (not revoked, same account, stale) because the row is re-checked after a concurrent update, which a join on `hit` would not be.
    const r = await sql<Row>`WITH hit AS (
        SELECT application_session_id, account_id, account_device_id, revoked_at IS NOT NULL AS revoked
          FROM identity.application_sessions WHERE keycloak_session_id = ${sid}
      ), touch AS (
        UPDATE identity.application_sessions s SET last_seen_at = clock_timestamp()
         WHERE s.keycloak_session_id = ${sid} AND s.account_id = ${input.accountId} AND s.revoked_at IS NULL
           AND s.last_seen_at < clock_timestamp() - make_interval(secs => ${this.touchSeconds})
        RETURNING 1
      )
      SELECT application_session_id, account_id, account_device_id, revoked FROM hit`
      .execute(this.db)
      .catch(mapDbError);
    const row = r.rows[0];
    if (row) {
      if (row.revoked === true || row.account_id !== input.accountId) throw sessionRevoked();
      return { applicationSessionId: row.application_session_id as string, accountDeviceId: (row.account_device_id as string | null) ?? null, created: false };
    }
    return this.firstSight(input);
  }

  /** First sight of a session: serialized with revoke-all through the account row (FOR SHARE here, FOR UPDATE there). Two concurrent first requests create ONE row. */
  private async firstSight(input: SessionObservation): Promise<ObservedSession> {
    const authTime =
      typeof input.authTime === 'number' && Number.isFinite(input.authTime) && input.authTime > 0 && input.authTime < 4_102_444_800 ? input.authTime : null;
    const watermarkBeforeLock = (
      await sql<Row>`SELECT sessions_not_before FROM identity.accounts WHERE account_id = ${input.accountId}`.execute(this.db).catch(mapDbError)
    ).rows[0]?.sessions_not_before as Date | null | undefined;
    let providerStartedAt: Date | null = null;
    if (watermarkBeforeLock && authTime !== null) {
      const authDeltaMs = authTime * 1000 - watermarkBeforeLock.getTime();
      if (authDeltaMs >= -2000 && authDeltaMs <= 2000) providerStartedAt = await this.providerSessionStartedAt(input.accountId, input.keycloakSessionId);
    }
    return this.tx(async (trx) => {
      const acc = (
        await sql<Row>`SELECT status, sessions_not_before
          FROM identity.accounts WHERE account_id = ${input.accountId} FOR SHARE`.execute(trx)
      ).rows[0];
      if (!acc) throw new AccountError('NOT_FOUND', 'the account does not exist');
      assertUsable(acc.status as AccountStatus);
      const watermark = (acc.sessions_not_before as Date | null) ?? null;
      if (watermark) {
        if (authTime === null) throw sessionRevoked();
        const authDeltaMs = authTime * 1000 - watermark.getTime();
        if (authDeltaMs < -2000) throw sessionRevoked();
        if (authDeltaMs <= 2000) {
          // Provider start times have whole-second precision; reserve a full second so an earlier
          // start within the reported second cannot pass the watermark.
          if (!providerStartedAt || providerStartedAt.getTime() - 1000 < watermark.getTime()) throw sessionRevoked();
        }
      }

      const cid = getCorrelationId() ?? randomUUID();
      const inserted = (
        await sql<Row>`INSERT INTO identity.application_sessions (account_id, keycloak_session_id) VALUES (${input.accountId}, ${input.keycloakSessionId})
          ON CONFLICT (keycloak_session_id) DO NOTHING RETURNING application_session_id`.execute(trx)
      ).rows[0];
      if (inserted) {
        const id = inserted.application_session_id as string;
        await this.audit(trx, cid, { accountId: input.accountId, action: 'SESSION_CREATED', sessionId: id });
        await this.event(trx, cid, SECURITY_EVENTS.sessionCreated, input.accountId, {
          accountId: input.accountId,
          applicationSessionId: id,
          accountDeviceId: null,
        });
        return { applicationSessionId: id, accountDeviceId: null, created: true };
      }
      // lost the race (or the sid exists for another account): read the winner's row
      const row = (
        await sql<Row>`SELECT application_session_id, account_id, account_device_id, revoked_at IS NOT NULL AS revoked
          FROM identity.application_sessions WHERE keycloak_session_id = ${input.keycloakSessionId}`.execute(trx)
      ).rows[0];
      if (!row || row.revoked === true || row.account_id !== input.accountId) throw sessionRevoked();
      return { applicationSessionId: row.application_session_id as string, accountDeviceId: (row.account_device_id as string | null) ?? null, created: false };
    });
  }

  async registerSession(input: RegisterSessionInput, ctx?: SecurityRequestContext): Promise<RegisteredSessionDto> {
    void ctx; // nothing is rate limited here (the web server calls it once per login); the context is accepted for interface symmetry
    if (!isDeviceSecretShape(input.deviceSecret))
      throw new AccountError('VALIDATION_FAILED', 'the device secret is not valid', { reason: 'INVALID_FIELD', field: 'device' });
    const family = classifyUserAgent(input.userAgent);
    const hash = hashDeviceSecret(this.d.hashSecret, input.accountId, input.deviceSecret);
    const registered = await this.tx(async (trx) => {
      await this.lockAccount(trx, input.accountId, true);
      const session = await this.currentSession(trx, input, true);
      if (!session) throw sessionNotFound();
      if (session.revoked) throw sessionRevoked();

      let device: DeviceRow | null = null;
      if (session.deviceId !== null) {
        // The session already has its browser (first device wins): the presented one is NOT created, so a replayed or foreign secret cannot add rows ("ghost devices").
        const own = (
          await sql<Row>`SELECT ${DEVICE_COLUMNS} FROM identity.account_devices d WHERE d.account_id = ${input.accountId} AND d.account_device_id = ${session.deviceId} FOR UPDATE`.execute(
            trx,
          )
        ).rows[0];
        device = own ? toDevice(own) : null;
      } else {
        const created = (
          await sql<Row>`INSERT INTO identity.account_devices (account_id, device_hash, browser_family, os_family, device_class)
            VALUES (${input.accountId}, ${hash}, ${family.browser}, ${family.os}, ${family.deviceClass})
            ON CONFLICT (account_id, device_hash) DO NOTHING RETURNING account_device_id`.execute(trx)
        ).rows[0];
        const deviceId = (created?.account_device_id as string | undefined) ?? undefined;
        const found = (
          await sql<Row>`SELECT ${DEVICE_COLUMNS} FROM identity.account_devices d WHERE d.account_id = ${input.accountId}
            AND ${deviceId ? sql`d.account_device_id = ${deviceId}` : sql`d.device_hash = ${hash}`} FOR UPDATE`.execute(trx)
        ).rows[0];
        device = found ? toDevice(found) : null;
        // a removed browser is terminal: it is not attached again
        if (device?.removed) device = null;
        if (device)
          await sql`UPDATE identity.application_sessions SET account_device_id = ${device.id} WHERE application_session_id = ${session.id} AND account_device_id IS NULL`.execute(
            trx,
          );
      }
      if (device && !device.removed) {
        // the family fields keep their FIRST values (immutable); only the seen time moves
        await sql`UPDATE identity.account_devices SET last_seen_at = GREATEST(last_seen_at, clock_timestamp()) WHERE account_device_id = ${device.id}`.execute(
          trx,
        );
      }
      return {
        sessionId: session.id,
        deviceId: device?.id ?? null,
        deviceTrusted: device?.trusted === true,
        trustedUntil: device?.trusted ? isoOrNull(device.trustedUntil) : null,
      };
    });
    // best effort, after the commit: a login is the natural moment to notice a password change made elsewhere (it ends the older sessions). A failure only skips it.
    await this.observeAfterRegister(input);
    return registered;
  }

  private async observeAfterRegister(current: CurrentSession): Promise<void> {
    try {
      const p = await this.policy();
      const security = await this.readSecurity(current.accountId);
      if (security) await this.observeTransitions(current, security, p);
    } catch (err) {
      log('warn', 'security state could not be observed at registration', { code: errorCode(err) });
    }
  }

  /** The second-factor and password state from the identity provider, or null when it cannot answer (not configured, no subject, provider failure). */
  private async readSecurity(accountId: string): Promise<IdentityUserSecurity | null> {
    const provider = this.d.identityProvider;
    if (!provider.available) return null;
    const subject = await this.subjectOf(this.db, accountId).catch(mapDbError);
    if (!subject) return null;
    try {
      return await provider.getUserSecurity(subject);
    } catch (err) {
      log('warn', 'identity provider security state could not be read', { code: errorCode(err) });
      return null;
    }
  }

  async listSessions(current: CurrentSession): Promise<SecuritySessionsDto> {
    const p = await this.policy();
    const windowSeconds = p.keepSignedInDays * 86400;
    await this.closeExpired(current, windowSeconds);
    const reconciled = await this.reconcile(current, windowSeconds);
    // The current session is placed first BEFORE the limit is applied, so it can never be dropped by it. The live rows of an account are few (partial index on account_id).
    const rows = (
      await sql<Row>`SELECT s.application_session_id, s.keycloak_session_id, s.account_device_id, s.created_at, s.last_seen_at,
          d.browser_family, d.os_family, d.device_class, d.trusted_until, d.removed_at, (d.trusted_until > clock_timestamp() AND d.removed_at IS NULL) AS trusted
        FROM identity.application_sessions s
        LEFT JOIN identity.account_devices d ON d.account_id = s.account_id AND d.account_device_id = s.account_device_id
        WHERE s.account_id = ${current.accountId} AND s.revoked_at IS NULL
          AND (s.keycloak_session_id = ${current.keycloakSessionId} OR s.last_seen_at > clock_timestamp() - make_interval(secs => ${windowSeconds}))
        ORDER BY (s.keycloak_session_id = ${current.keycloakSessionId}) DESC, s.last_seen_at DESC, s.application_session_id LIMIT ${LIST_LIMIT}`
        .execute(this.db)
        .catch(mapDbError)
    ).rows;
    const sessions = rows.map((r) => {
      const hasDevice = r.account_device_id !== null && r.account_device_id !== undefined;
      const trusted = r.trusted === true;
      return {
        sessionId: r.application_session_id as string,
        current: r.keycloak_session_id === current.keycloakSessionId,
        status: 'ACTIVE' as const,
        device: hasDevice ? { browser: r.browser_family as BrowserFamily, os: r.os_family as OsFamily, deviceClass: r.device_class as DeviceClass } : null,
        deviceId: hasDevice ? (r.account_device_id as string) : null,
        createdAt: iso(r.created_at),
        lastSeenAt: iso(r.last_seen_at),
        trusted,
        trustedUntil: trusted ? isoOrNull(r.trusted_until) : null,
      };
    });
    return { sessions, reconciled };
  }

  /**
   * A live row not seen for longer than the keep-signed-in window is dead by definition (the identity provider session cannot outlive it): it is closed here
   * (KEYCLOAK_ENDED, audit SESSION_ENDED with `expired: true`, event) under the account lock, whether or not the identity provider can be asked. The current session is never closed.
   */
  private async closeExpired(current: CurrentSession, windowSeconds: number): Promise<void> {
    const any = (
      await sql<Row>`SELECT 1 AS x FROM identity.application_sessions WHERE account_id = ${current.accountId} AND revoked_at IS NULL AND keycloak_session_id <> ${current.keycloakSessionId}
          AND last_seen_at <= clock_timestamp() - make_interval(secs => ${windowSeconds}) LIMIT 1`
        .execute(this.db)
        .catch(mapDbError)
    ).rows;
    if (any.length === 0) return;
    await this.tx(async (trx) => {
      await this.lockAccount(trx, current.accountId, false);
      const ended = (
        await sql<Row>`UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'KEYCLOAK_ENDED'
          WHERE account_id = ${current.accountId} AND revoked_at IS NULL AND keycloak_session_id <> ${current.keycloakSessionId}
            AND last_seen_at <= clock_timestamp() - make_interval(secs => ${windowSeconds})
          RETURNING application_session_id`.execute(trx)
      ).rows.map((r) => r.application_session_id as string);
      const cid = getCorrelationId() ?? randomUUID();
      for (const id of ended) {
        await this.audit(trx, cid, {
          accountId: current.accountId,
          action: 'SESSION_ENDED',
          sessionId: id,
          changes: { reason: 'KEYCLOAK_ENDED', expired: true },
        });
        await this.event(trx, cid, SECURITY_EVENTS.sessionRevoked, current.accountId, {
          accountId: current.accountId,
          applicationSessionId: id,
          reason: 'KEYCLOAK_ENDED',
        });
      }
    });
  }

  /**
   * Compares the account's live rows with the identity provider's own sessions and ends (KEYCLOAK_ENDED) the rows the provider no longer knows. Returns whether the
   * provider answered. Never touches the current session (its token is valid right now) or a session younger than the grace period. A provider failure mutates nothing.
   * It also RETRIES the propagation of earlier revocations: rows revoked within the window (any reason but KEYCLOAK_ENDED) that the provider still lists are ended again
   * (at most 20 per call, never the current session).
   */
  private async reconcile(current: CurrentSession, windowSeconds: number): Promise<boolean> {
    const provider = this.d.identityProvider;
    if (!provider.available) return false;
    const subject = await this.subjectOf(this.db, current.accountId).catch(mapDbError);
    if (!subject) return false;
    // the cutoff is taken BEFORE the provider is asked: a session created while the call was in flight is never judged by a list that predates it
    const cutoff = (await sql<Row>`SELECT clock_timestamp() - make_interval(secs => ${this.graceSeconds}) AS cutoff`.execute(this.db).catch(mapDbError))
      .rows[0]!.cutoff as Date;
    let known: string[];
    try {
      known = (await provider.listSessions(subject)).map((s) => s.id);
    } catch (err) {
      log('warn', 'identity provider sessions could not be listed', { code: errorCode(err) });
      return false;
    }
    await this.tx(async (trx) => {
      await this.lockAccount(trx, current.accountId, false);
      const ended = (
        await sql<Row>`UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'KEYCLOAK_ENDED'
          WHERE account_id = ${current.accountId} AND revoked_at IS NULL AND keycloak_session_id <> ${current.keycloakSessionId}
            AND created_at < ${cutoff} AND keycloak_session_id <> ALL(${known}::text[])
          RETURNING application_session_id`.execute(trx)
      ).rows.map((r) => r.application_session_id as string);
      const cid = getCorrelationId() ?? randomUUID();
      for (const id of ended) {
        await this.audit(trx, cid, { accountId: current.accountId, action: 'SESSION_ENDED', sessionId: id, changes: { reason: 'KEYCLOAK_ENDED' } });
        await this.event(trx, cid, SECURITY_EVENTS.sessionRevoked, current.accountId, {
          accountId: current.accountId,
          applicationSessionId: id,
          reason: 'KEYCLOAK_ENDED',
        });
      }
    });
    if (known.length > 0) {
      const stillAlive = (
        await sql<Row>`SELECT keycloak_session_id FROM identity.application_sessions
          WHERE keycloak_session_id = ANY(${known}::text[]) AND account_id = ${current.accountId} AND keycloak_session_id <> ${current.keycloakSessionId}
            AND revoked_at IS NOT NULL AND revocation_reason <> 'KEYCLOAK_ENDED' AND revoked_at > clock_timestamp() - make_interval(secs => ${windowSeconds})
          LIMIT ${REPROPAGATION_LIMIT}`
          .execute(this.db)
          .catch(mapDbError)
      ).rows.map((r) => r.keycloak_session_id as string);
      await this.endProviderSessions(stillAlive);
    }
    return true;
  }

  /** Writes the audit rows and events of sessions that were just revoked (the UPDATE itself is done by the caller, under the account lock). */
  private async revokeRows(trx: Trx, cid: string, accountId: string, rows: readonly { id: string }[], reason: SessionRevocationReason): Promise<void> {
    for (const row of rows) {
      await this.audit(trx, cid, { accountId, action: 'SESSION_REVOKED', sessionId: row.id, changes: { reason } });
      await this.event(trx, cid, SECURITY_EVENTS.sessionRevoked, accountId, { accountId, applicationSessionId: row.id, reason });
    }
  }

  async revokeSession(current: CurrentSession, sessionId: string): Promise<SessionRevokedDto> {
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw sessionNotFound();
    const result = await this.tx(async (trx) => {
      await this.lockAccount(trx, current.accountId, false);
      const target = (
        await sql<Row>`SELECT application_session_id, account_id, keycloak_session_id, account_device_id, revoked_at IS NOT NULL AS revoked, revocation_reason
          FROM identity.application_sessions WHERE application_session_id = ${sessionId} AND account_id = ${current.accountId} FOR UPDATE`.execute(trx)
      ).rows[0];
      if (!target) throw sessionNotFound();
      const row = toSession(target);
      const isCurrent = row.keycloakSessionId === current.keycloakSessionId;
      // already revoked: nothing changes, but an earlier propagation may have failed, so the identity provider is asked again (it tolerates an unknown session)
      if (row.revoked)
        return { id: row.id, changed: false, current: isCurrent, sid: (row.reason === 'KEYCLOAK_ENDED' ? null : row.keycloakSessionId) as string | null };
      await sql`UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'REVOKED_BY_USER' WHERE application_session_id = ${row.id} AND revoked_at IS NULL`.execute(
        trx,
      );
      await this.revokeRows(trx, getCorrelationId() ?? randomUUID(), current.accountId, [row], 'REVOKED_BY_USER');
      return { id: row.id, changed: true, current: isCurrent, sid: row.keycloakSessionId as string | null };
    });
    const keycloak = result.sid ? await this.endProviderSessions([result.sid]) : 'NOT_NEEDED';
    return { sessionId: result.id, changed: result.changed, current: result.current, keycloak };
  }

  async revokeAllSessions(current: CurrentSession, options: { includeCurrent: boolean }): Promise<SessionsRevokedAllDto> {
    const includeCurrent = options.includeCurrent === true;
    const done = await this.tx(async (trx) => {
      const { status } = await this.lockAccount(trx, current.accountId, false);
      const revoked = (
        await sql<Row>`UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'SIGN_OUT_EVERYWHERE'
          WHERE account_id = ${current.accountId} AND revoked_at IS NULL AND (${includeCurrent} OR keycloak_session_id <> ${current.keycloakSessionId})
          RETURNING application_session_id`.execute(trx)
      ).rows.map((r) => ({ id: r.application_session_id as string }));
      const cid = getCorrelationId() ?? randomUUID();
      await this.revokeRows(trx, cid, current.accountId, revoked, 'SIGN_OUT_EVERYWHERE');
      // the watermark: sessions the API has not seen yet and whose login predates this moment are refused on first sight. A CLOSED account is immutable and has no use for it.
      if (status !== 'CLOSED')
        await sql`UPDATE identity.accounts SET sessions_not_before = GREATEST(clock_timestamp(), coalesce(sessions_not_before, '-infinity'::timestamptz)), updated_at = now() WHERE account_id = ${current.accountId}`.execute(
          trx,
        );
      await this.audit(trx, cid, { accountId: current.accountId, action: 'SESSIONS_REVOKED_ALL', changes: { revokedCount: revoked.length, includeCurrent } });
      await this.event(trx, cid, SECURITY_EVENTS.sessionsRevokedAll, current.accountId, {
        accountId: current.accountId,
        revokedCount: revoked.length,
        includeCurrent,
      });
      const subject = await this.subjectOf(trx, current.accountId);
      return { count: revoked.length, subject };
    });
    return { revokedCount: done.count, keycloak: await this.endAllInProvider(done.subject, current.keycloakSessionId, includeCurrent) };
  }

  /** After a revoke-all commit: end the user's Keycloak sessions (all of them, or all except the current one). */
  private async endAllInProvider(subject: string | null, currentSid: string, includeCurrent: boolean): Promise<KeycloakPropagationOutcome> {
    const provider = this.d.identityProvider;
    if (!subject || !provider.available) return 'UNAVAILABLE';
    try {
      if (includeCurrent) {
        await provider.endAllSessions(subject);
        return 'ENDED';
      }
      const others = (await provider.listSessions(subject)).map((s) => s.id).filter((id) => id !== currentSid);
      return others.length === 0 ? 'NOT_NEEDED' : await this.endProviderSessions(others);
    } catch (err) {
      log('warn', 'identity provider sessions could not be ended', { code: errorCode(err) });
      return 'UNAVAILABLE';
    }
  }

  async signOutCurrentSession(current: CurrentSession): Promise<SignedOutDto> {
    const result = await this.tx(async (trx) => {
      await this.lockAccount(trx, current.accountId, false);
      const row = await this.currentSession(trx, current, true);
      if (!row) return { changed: false, sid: null as string | null };
      if (row.revoked) return { changed: false, sid: (row.reason === 'KEYCLOAK_ENDED' ? null : row.keycloakSessionId) as string | null };
      await sql`UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'SIGN_OUT' WHERE application_session_id = ${row.id} AND revoked_at IS NULL`.execute(
        trx,
      );
      await this.revokeRows(trx, getCorrelationId() ?? randomUUID(), current.accountId, [row], 'SIGN_OUT');
      return { changed: true, sid: row.keycloakSessionId as string | null };
    });
    return { changed: result.changed, keycloak: result.sid ? await this.endProviderSessions([result.sid]) : 'NOT_NEEDED' };
  }

  // ------------------------------------------------------------------ devices
  async listDevices(current: CurrentSession): Promise<SecurityDevicesDto> {
    const own = await this.currentSession(this.db, current).catch(mapDbError);
    const rows = (
      await sql<Row>`SELECT ${DEVICE_COLUMNS},
          GREATEST(d.last_seen_at, coalesce((SELECT max(s.last_seen_at) FROM identity.application_sessions s WHERE s.account_id = d.account_id AND s.account_device_id = d.account_device_id), d.last_seen_at)) AS seen_at
        FROM identity.account_devices d WHERE d.account_id = ${current.accountId} AND d.removed_at IS NULL ORDER BY seen_at DESC, d.account_device_id LIMIT ${LIST_LIMIT}`
        .execute(this.db)
        .catch(mapDbError)
    ).rows;
    return {
      devices: rows.map((r) => {
        const d = toDevice(r);
        return {
          deviceId: d.id,
          current: own?.deviceId === d.id,
          device: summaryOf(d),
          firstSeenAt: iso(d.firstSeenAt),
          lastSeenAt: iso(r.seen_at),
          trusted: d.trusted,
          trustedUntil: d.trusted ? isoOrNull(d.trustedUntil) : null,
        };
      }),
    };
  }

  /** Locks the account, the current session and its device (that order); the device must exist, belong to the account and not be removed. */
  private async lockCurrentDevice(trx: Trx, current: CurrentSession): Promise<DeviceRow> {
    await this.lockAccount(trx, current.accountId, true);
    const session = await this.currentSession(trx, current);
    if (!session) throw sessionNotFound();
    if (session.revoked) throw sessionRevoked();
    if (session.deviceId === null) throw new AccountError('DEVICE_REQUIRED', 'this session has no registered browser');
    const row = (
      await sql<Row>`SELECT ${DEVICE_COLUMNS} FROM identity.account_devices d WHERE d.account_id = ${current.accountId} AND d.account_device_id = ${session.deviceId} FOR UPDATE`.execute(
        trx,
      )
    ).rows[0];
    const device = row ? toDevice(row) : null;
    if (!device || device.removed) throw deviceNotFound();
    return device;
  }

  async trustCurrentDevice(current: CurrentSession): Promise<DeviceTrustDto> {
    const p = await this.policy();
    return this.tx(async (trx) => {
      const device = await this.lockCurrentDevice(trx, current);
      // renewing an already trusted browser extends the window from now; the account lock makes two renewals run one after the other
      const updated = (
        await sql<Row>`UPDATE identity.account_devices SET trusted_at = clock_timestamp(), trusted_until = clock_timestamp() + make_interval(secs => ${p.trustedBrowserDays * 86400})
          WHERE account_device_id = ${device.id} AND removed_at IS NULL RETURNING trusted_until`.execute(trx)
      ).rows[0]!;
      await this.audit(trx, getCorrelationId() ?? randomUUID(), {
        accountId: current.accountId,
        action: 'DEVICE_TRUSTED',
        deviceId: device.id,
        changes: { trustedBrowserDays: p.trustedBrowserDays, renewed: device.trusted },
      });
      return { deviceId: device.id, trusted: true, trustedUntil: iso(updated.trusted_until) };
    });
  }

  async untrustCurrentDevice(current: CurrentSession): Promise<DeviceTrustDto> {
    return this.tx(async (trx) => {
      const device = await this.lockCurrentDevice(trx, current);
      if (device.trusted) {
        await sql`UPDATE identity.account_devices SET trusted_at = NULL, trusted_until = NULL WHERE account_device_id = ${device.id}`.execute(trx);
        await this.audit(trx, getCorrelationId() ?? randomUUID(), { accountId: current.accountId, action: 'DEVICE_UNTRUSTED', deviceId: device.id });
      }
      return { deviceId: device.id, trusted: false, trustedUntil: null };
    });
  }

  async removeDevice(current: CurrentSession, deviceId: string): Promise<DeviceRemovedDto> {
    if (typeof deviceId !== 'string' || !UUID.test(deviceId)) throw deviceNotFound();
    const windowSeconds = (await this.policy()).keepSignedInDays * 86400;
    const result = await this.tx(async (trx) => {
      await this.lockAccount(trx, current.accountId, false);
      const row = (
        await sql<Row>`SELECT ${DEVICE_COLUMNS} FROM identity.account_devices d WHERE d.account_id = ${current.accountId} AND d.account_device_id = ${deviceId} FOR UPDATE`.execute(
          trx,
        )
      ).rows[0];
      if (!row) throw deviceNotFound();
      const device = toDevice(row);
      if (device.removed) {
        // already removed: nothing changes, but the identity provider is asked again to end the sessions that were revoked with it (bounded, within the window)
        const again = (
          await sql<Row>`SELECT keycloak_session_id FROM identity.application_sessions
            WHERE account_id = ${current.accountId} AND account_device_id = ${device.id} AND revoked_at IS NOT NULL AND revocation_reason <> 'KEYCLOAK_ENDED'
              AND revoked_at > clock_timestamp() - make_interval(secs => ${windowSeconds}) ORDER BY revoked_at DESC LIMIT ${REPROPAGATION_LIMIT}`.execute(trx)
        ).rows.map((r) => r.keycloak_session_id as string);
        return { changed: false, sids: [] as string[], again };
      }
      await sql`UPDATE identity.account_devices SET trusted_at = NULL, trusted_until = NULL, removed_at = clock_timestamp() WHERE account_device_id = ${device.id}`.execute(
        trx,
      );
      const cid = getCorrelationId() ?? randomUUID();
      await this.audit(trx, cid, { accountId: current.accountId, action: 'DEVICE_REMOVED', deviceId: device.id, changes: { wasTrusted: device.trusted } });
      const revoked = (
        await sql<Row>`UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'DEVICE_REMOVED'
          WHERE account_id = ${current.accountId} AND account_device_id = ${device.id} AND revoked_at IS NULL
          RETURNING application_session_id, keycloak_session_id`.execute(trx)
      ).rows.map((r) => ({ id: r.application_session_id as string, keycloakSessionId: r.keycloak_session_id as string }));
      await this.revokeRows(trx, cid, current.accountId, revoked, 'DEVICE_REMOVED');
      return { changed: true, sids: revoked.map((r) => r.keycloakSessionId), again: [] as string[] };
    });
    return {
      deviceId,
      changed: result.changed,
      sessionsRevoked: result.sids.length,
      keycloak: await this.endProviderSessions([...result.sids, ...result.again]),
    };
  }

  async isDeviceTrusted(current: CurrentSession): Promise<boolean> {
    const r = await sql<Row>`SELECT (d.trusted_until > clock_timestamp() AND d.removed_at IS NULL) AS trusted
      FROM identity.application_sessions s JOIN identity.account_devices d ON d.account_id = s.account_id AND d.account_device_id = s.account_device_id
      WHERE s.keycloak_session_id = ${current.keycloakSessionId} AND s.account_id = ${current.accountId} AND s.revoked_at IS NULL`
      .execute(this.db)
      .catch(mapDbError);
    return r.rows[0]?.trusted === true;
  }

  // ------------------------------------------------------------------ second factor, step-up state, recovery
  async getOverview(current: CurrentSession, token: TokenFacts): Promise<SecurityOverviewDto> {
    const p = await this.policy();
    const session = await this.currentSession(this.db, current).catch(mapDbError);
    if (!session) throw sessionNotFound();
    if (session.revoked) throw sessionRevoked();

    let device: DeviceRow | null = null;
    if (session.deviceId !== null) {
      const row = (
        await sql<Row>`SELECT ${DEVICE_COLUMNS} FROM identity.account_devices d WHERE d.account_id = ${current.accountId} AND d.account_device_id = ${session.deviceId}`
          .execute(this.db)
          .catch(mapDbError)
      ).rows[0];
      device = row ? toDevice(row) : null;
    }

    // the second-factor state comes from the identity provider; when it cannot answer the flags are false and `available` says they mean "unknown"
    const security = await this.readSecurity(current.accountId);
    if (security) await this.observeTransitions(current, security, p);

    const authMs = typeof token.authTime === 'number' && Number.isFinite(token.authTime) && token.authTime > 0 ? token.authTime * 1000 : null;
    const recentUntilMs = authMs === null ? null : authMs + p.stepUpValidMinutes * 60_000;
    return {
      mfa: {
        available: security !== null,
        totpConfigured: security?.otpConfigured === true,
        recoveryCodesConfigured: security?.recoveryCodesConfigured === true,
      },
      stepUp: {
        authenticatedAt: authMs === null ? null : new Date(authMs).toISOString(),
        mfaSatisfied: isMfaAcr(token.acr),
        recentUntil: recentUntilMs !== null && recentUntilMs > this.now().getTime() ? new Date(recentUntilMs).toISOString() : null,
      },
      currentSession: {
        sessionId: session.id,
        deviceId: device && !device.removed ? device.id : null,
        deviceTrusted: device?.trusted === true,
        trustedUntil: device?.trusted ? isoOrNull(device.trustedUntil) : null,
      },
      policy: { trustedBrowserDays: p.trustedBrowserDays, stepUpValidMinutes: p.stepUpValidMinutes, activityLogDays: p.activityLogDays },
    };
  }

  /**
   * The transitions Keycloak's state implies relative to the LAST audited state of the account. Pure reads; the caller decides whether to write.
   *  - A second factor that is already configured the FIRST time it is seen, with no enrolment request audited before, is a BASELINE: it is anchored with `changes.baseline = true`
   *    and NO event (it is state that pre-dates the audit trail, not a transition); baseline rows are not shown on the timeline.
   *  - A password changed after the last audited change (or, before any, after the account was created) is a change. It ends the account's OTHER sessions started before it.
   */
  private async pendingTransitions(ex: Executor, accountId: string, sec: IdentityUserSecurity, p: SecurityPolicy): Promise<Transition[]> {
    const rows = (
      await sql<Row>`(SELECT 'MFA' AS fam, action, occurred_at, changes FROM identity.account_audit_events WHERE account_id = ${accountId} AND action IN ('MFA_ENABLED', 'MFA_DISABLED') ORDER BY occurred_at DESC LIMIT 1)
        UNION ALL (SELECT 'RECOVERY', action, occurred_at, changes FROM identity.account_audit_events WHERE account_id = ${accountId} AND action IN ('RECOVERY_CODES_ENABLED', 'RECOVERY_CODES_DISABLED') ORDER BY occurred_at DESC LIMIT 1)
        UNION ALL (SELECT 'MFAREQ', action, occurred_at, changes FROM identity.account_audit_events WHERE account_id = ${accountId} AND action = 'MFA_ENROLLMENT_REQUESTED' ORDER BY occurred_at DESC LIMIT 1)
        UNION ALL (SELECT 'RECREQ', action, occurred_at, changes FROM identity.account_audit_events WHERE account_id = ${accountId} AND action = 'RECOVERY_CODES_REQUESTED' ORDER BY occurred_at DESC LIMIT 1)
        UNION ALL (SELECT 'PASSWORD', action, occurred_at, changes FROM identity.account_audit_events WHERE account_id = ${accountId} AND action IN ('PASSWORD_CHANGED', 'PASSWORD_RESET_COMPLETED') ORDER BY occurred_at DESC LIMIT 1)
        UNION ALL (SELECT 'RESET', action, occurred_at, changes FROM identity.account_audit_events WHERE account_id = ${accountId} AND action = 'PASSWORD_RESET_REQUESTED' ORDER BY occurred_at DESC LIMIT 1)
        UNION ALL (SELECT 'ACCOUNT', '', created_at, NULL::jsonb FROM identity.accounts WHERE account_id = ${accountId})`.execute(ex)
    ).rows;
    const by = (fam: string): Row | undefined => rows.find((r) => r.fam === fam);
    const out: Transition[] = [];

    const factor = (
      configured: boolean,
      lastAction: string | undefined,
      requested: boolean,
      method: 'TOTP' | 'RECOVERY_CODES',
      enabled: string,
      disabled: string,
    ): void => {
      if (configured && lastAction !== enabled) {
        const baseline = lastAction === undefined && !requested;
        out.push(
          baseline
            ? { action: enabled, changes: { method, baseline: true } }
            : { action: enabled, changes: { method }, event: { type: SECURITY_EVENTS.mfaEnabled, payload: { accountId, method } } },
        );
      } else if (!configured && lastAction === enabled) {
        out.push({ action: disabled, changes: { method }, event: { type: SECURITY_EVENTS.mfaDisabled, payload: { accountId, method } } });
      }
    };
    factor(sec.otpConfigured, by('MFA')?.action as string | undefined, by('MFAREQ') !== undefined, 'TOTP', 'MFA_ENABLED', 'MFA_DISABLED');
    factor(
      sec.recoveryCodesConfigured,
      by('RECOVERY')?.action as string | undefined,
      by('RECREQ') !== undefined,
      'RECOVERY_CODES',
      'RECOVERY_CODES_ENABLED',
      'RECOVERY_CODES_DISABLED',
    );

    const pw = sec.passwordChangedAt;
    if (pw instanceof Date && Number.isFinite(pw.getTime())) {
      const lastPw = by('PASSWORD');
      const recorded =
        typeof (lastPw?.changes as { passwordChangedAt?: unknown } | null | undefined)?.passwordChangedAt === 'string'
          ? Date.parse((lastPw!.changes as { passwordChangedAt: string }).passwordChangedAt)
          : NaN;
      const created = (by('ACCOUNT')?.occurred_at as Date).getTime();
      // the reference is the password change already audited (or, before any, the creation of the account: the password that existed at sign-up is not "a change")
      const reference = Math.max(Number.isFinite(recorded) ? recorded : 0, created);
      if (pw.getTime() > reference) {
        const reset = by('RESET');
        const resetAt = reset ? (reset.occurred_at as Date).getTime() : NaN;
        const lastPwAt = lastPw ? (lastPw.occurred_at as Date).getTime() : -Infinity;
        const completesReset =
          reset !== undefined &&
          resetAt > lastPwAt &&
          pw.getTime() > resetAt &&
          pw.getTime() <= resetAt + (p.resetLinkValidityMinutes + RESET_ATTRIBUTION_GRACE_MINUTES) * 60_000;
        const changes = { passwordChangedAt: pw.toISOString() };
        out.push(
          completesReset
            ? {
                action: 'PASSWORD_RESET_COMPLETED',
                changes,
                event: { type: SECURITY_EVENTS.passwordResetCompleted, payload: { accountId } },
                endSessionsBefore: pw,
              }
            : { action: 'PASSWORD_CHANGED', changes, endSessionsBefore: pw },
        );
      }
    }
    return out;
  }

  /**
   * Writes the observed transitions under the account lock (re-evaluated inside it, so concurrent observers write once). A password change or reset ALSO revokes every
   * other live session of the account that started before the new password (reason PASSWORD_CHANGED; the current session is kept; the watermark is not touched) and ends
   * them at the identity provider after the commit. A failure never breaks the caller.
   */
  private async observeTransitions(current: CurrentSession, sec: IdentityUserSecurity, p: SecurityPolicy): Promise<void> {
    const accountId = current.accountId;
    try {
      if ((await this.pendingTransitions(this.db, accountId, sec, p)).length === 0) return;
      const ended = await this.tx(async (trx) => {
        const { status } = await this.lockAccount(trx, accountId, false);
        if (status === 'CLOSED') return [];
        const cid = getCorrelationId() ?? randomUUID();
        const sids: string[] = [];
        for (const t of await this.pendingTransitions(trx, accountId, sec, p)) {
          await this.audit(trx, cid, { accountId, action: t.action, changes: t.changes });
          if (t.event) await this.event(trx, cid, t.event.type, accountId, t.event.payload);
          if (t.endSessionsBefore) {
            const revoked = (
              await sql<Row>`UPDATE identity.application_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'PASSWORD_CHANGED'
                WHERE account_id = ${accountId} AND revoked_at IS NULL AND keycloak_session_id <> ${current.keycloakSessionId} AND created_at < ${t.endSessionsBefore}
                RETURNING application_session_id, keycloak_session_id`.execute(trx)
            ).rows.map((r) => ({ id: r.application_session_id as string, keycloakSessionId: r.keycloak_session_id as string }));
            await this.revokeRows(trx, cid, accountId, revoked, 'PASSWORD_CHANGED');
            sids.push(...revoked.map((r) => r.keycloakSessionId));
          }
        }
        return sids;
      });
      if (ended.length > 0) await this.endProviderSessions(ended);
    } catch (err) {
      log('warn', 'security state transitions could not be recorded', { code: errorCode(err) });
    }
  }

  async startMfaEnrollment(current: CurrentSession, method: MfaMethod): Promise<MfaEnrollmentDto> {
    if (!(MFA_METHODS as readonly string[]).includes(method))
      throw new AccountError('VALIDATION_FAILED', 'the method is not supported', { reason: 'INVALID_FIELD', field: 'method' });
    await this.tx(async (trx) => {
      await this.lockAccount(trx, current.accountId, true);
      await this.audit(trx, getCorrelationId() ?? randomUUID(), {
        accountId: current.accountId,
        action: method === 'TOTP' ? 'MFA_ENROLLMENT_REQUESTED' : 'RECOVERY_CODES_REQUESTED',
        changes: { method },
      });
    });
    return { method, keycloakAction: KEYCLOAK_ACTION_OF_METHOD[method] };
  }

  async hasMfaEnrolled(accountId: string): Promise<boolean | null> {
    const provider = this.d.identityProvider;
    if (!provider.available) return null;
    try {
      const subject = await this.subjectOf(this.db, accountId);
      if (!subject) return null;
      return (await provider.getUserSecurity(subject)).otpConfigured;
    } catch (err) {
      log('warn', 'identity provider security state could not be read', { code: errorCode(err) });
      return null;
    }
  }

  // ------------------------------------------------------------------ timeline
  async listActivity(accountId: string, query: TimelineQuery): Promise<SecurityActivityDto> {
    const p = await this.policy();
    const requested = typeof query.limit === 'number' && Number.isFinite(query.limit) ? Math.floor(query.limit) : SECURITY_ACTIVITY_DEFAULT_LIMIT;
    const limit = Math.min(Math.max(requested, 1), SECURITY_ACTIVITY_MAX_LIMIT);
    const before = query.before;
    let cursor: { at: string; id: string } | undefined;
    if (before !== undefined) {
      const m = typeof before === 'string' ? BEFORE_SHAPE.exec(before) : null;
      if (!m || !isRealInstant(m[1]!))
        throw new AccountError('VALIDATION_FAILED', 'the cursor is not a valid timestamp', { reason: 'INVALID_FIELD', field: 'before' });
      // a plain instant is compared with the nil uuid, so it stays strictly older than that instant
      cursor = { at: m[1]!, id: (m[2] ?? NIL_UUID).toLowerCase() };
    }

    const rows = (
      await sql<Row>`SELECT e.audit_event_id, e.action, e.occurred_at, to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_text,
          e.application_session_id, d.browser_family, d.os_family, d.device_class
        FROM identity.account_audit_events e
        LEFT JOIN identity.application_sessions s ON s.account_id = e.account_id AND s.application_session_id = e.application_session_id
        LEFT JOIN identity.account_devices d ON d.account_id = s.account_id AND d.account_device_id = s.account_device_id
        WHERE e.account_id = ${accountId} AND e.action = ANY(${[...SECURITY_ACTIVITY_TYPES]}::text[])
          AND e.occurred_at >= clock_timestamp() - make_interval(secs => ${p.activityLogDays * 86400})
          AND NOT coalesce(e.changes @> '{"baseline": true}'::jsonb, false)
          ${cursor ? sql`AND (e.occurred_at, e.audit_event_id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
        ORDER BY e.occurred_at DESC, e.audit_event_id DESC LIMIT ${limit + 1}`
        .execute(this.db)
        .catch(mapDbError)
    ).rows;
    // The cursor is composite: the microsecond timestamp AND the audit event id of the last entry, matching ORDER BY (occurred_at, audit_event_id) DESC, so events that
    // share a microsecond are neither skipped nor repeated across pages.
    const page = rows.slice(0, limit);
    return {
      entries: page.map((r) => {
        const type = r.action as SecurityActivityType;
        const hasDevice = r.browser_family !== null && r.browser_family !== undefined;
        return {
          id: r.audit_event_id as string,
          type,
          occurredAt: iso(r.occurred_at),
          outcome: 'SUCCESS' as const,
          labelContentKey: securityActivityLabelKey(type),
          sessionId: (r.application_session_id as string | null) ?? null,
          device: hasDevice ? { browser: r.browser_family as BrowserFamily, os: r.os_family as OsFamily, deviceClass: r.device_class as DeviceClass } : null,
        };
      }),
      nextBefore:
        rows.length > limit ? `${page[page.length - 1]!.occurred_text as string}_${(page[page.length - 1]!.audit_event_id as string).toLowerCase()}` : null,
    };
  }

  getPolicy(): Promise<SecurityPolicy> {
    return this.policy();
  }

  // ------------------------------------------------------------------ password reset
  async requestPasswordReset(email: string, ctx: SecurityRequestContext): Promise<void> {
    const p = await this.policy();
    const parsed = canonicalizeEmail(email);
    // an address that cannot be canonical is limited by a keyed hash of what was sent, so garbage cannot be used to dodge the limit; nothing else happens for it
    const dimension = parsed.ok ? parsed.value : (typeof email === 'string' ? email : '').slice(0, 320);
    const rules = [
      { name: 'password-reset:email', key: hashDimension(this.d.hashSecret, 'email', dimension), limit: p.resetMaxRequestsPerHour, windowSeconds: 3600 },
    ];
    if (ctx.clientIp)
      rules.push({
        name: 'password-reset:ip',
        key: hashDimension(this.d.hashSecret, 'ip', ctx.clientIp),
        limit: p.resetMaxRequestsPerHour,
        windowSeconds: 3600,
      });
    const outcome = await consumeRules(this.d.rateLimiter, rules);
    if (outcome.kind === 'REFUSED')
      throw new AccountError('PASSWORD_RESET_RATE_LIMITED', 'too many requests', { retryAfterSeconds: outcome.retryAfterSeconds });
    if (outcome.kind === 'UNAVAILABLE') {
      // each request can send an email: without counters the request is refused (fail closed)
      log('error', 'password reset rate limiter unavailable; request refused');
      throw new AccountError('UNAVAILABLE', 'the request cannot be accepted right now', { reason: 'RATE_LIMITER_UNAVAILABLE' });
    }
    if (!parsed.ok) return;
    const canonical = parsed.value;

    // Everything below depends on whether the address belongs to an account, so NONE of it is awaited: what the caller waits for is identical for a known, an unknown and an
    // invalid address (policy read, hashing, the Valkey consumption above). The lookup, the audit and the Keycloak calls run detached; drain() waits for them.
    this.detach('password-reset', async () => {
      const found = (
        await sql<Row>`SELECT c.account_id FROM identity.email_contacts c JOIN identity.accounts a ON a.account_id = c.account_id
          WHERE c.email_normalized = ${canonical} AND c.status = 'VERIFIED' AND c.is_primary AND a.status <> 'CLOSED' LIMIT 1`
          .execute(this.db)
          .catch(mapDbError)
      ).rows[0];
      if (!found) return;
      const accountId = found.account_id as string;
      const subject = await this.subjectOf(this.db, accountId).catch(mapDbError);
      if (!subject) return;
      const recorded = await this.tx(async (trx) => {
        const { status } = await this.lockAccount(trx, accountId, false);
        if (status === 'CLOSED') return false;
        const cid = getCorrelationId() ?? randomUUID();
        await this.audit(trx, cid, { accountId, action: 'PASSWORD_RESET_REQUESTED' });
        await this.event(trx, cid, SECURITY_EVENTS.passwordResetRequested, accountId, { accountId });
        return true;
      });
      if (!recorded) return;
      // the address Keycloak knows must equal the verified one, otherwise nothing is sent
      const known = await this.d.identityProvider.getUserSecurity(subject);
      if (known.email === null || known.email.toLowerCase() !== canonical.toLowerCase()) return;
      await this.d.identityProvider.sendPasswordResetEmail(subject, { lifespanSeconds: p.resetLinkValidityMinutes * 60 });
    });
  }
}
