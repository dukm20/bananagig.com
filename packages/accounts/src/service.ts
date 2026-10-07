// The account service: the BananaGig application account of a person, linked to a verified Keycloak identity. Keycloak owns authentication; this
// service owns the account, its roles, its status and its core profile in PostgreSQL. Transaction boundaries live here. Events go through the
// transactional outbox in the same transaction as the change.
//
// Rules this file keeps (docs/engineering/ACCOUNTS.md, ADR-0025, ADR-0026):
//  - The identity comes ONLY from a verified token (VerifiedIdentity). No client-supplied account id, subject or role is ever read.
//  - One external identity (provider, issuer, subject) links at most one account: the unique key decides, not application code. Concurrent first
//    requests insert the same key; the loser gets a unique violation, rolls back its half-created account and re-reads the winner's.
//  - ONE lock order everywhere: the account row (FOR UPDATE) first, then the role row (FOR SHARE), then the membership, identity and profile rows of that account.
//  - Roles are memberships (one row per account and role, reactivated on re-grant). Granting is idempotent. The active role of a request is resolved
//    from the memberships PostgreSQL holds and is never persisted: switching role changes the application context only, not the Keycloak session.
//  - Every status change writes an immutable history row in the same transaction (a deferred trigger checks the newest row equals the status).
//  - Nothing here logs or returns a token, a subject or a name; audit changes name fields, never values.
import { randomUUID } from 'node:crypto';
import {
  IDENTITY_EVENTS,
  isAccountStatusTransitionAllowed,
  canonicalizeLocale,
  profileIssueMessageKey,
  validateProfileName,
  type AccountCreatedPayload,
  type AccountProfileDto,
  type AccountRolePayload,
  type AccountStatus,
  type AccountStatusChangedPayload,
  type ExternalIdentityLinkedPayload,
  type RoleGrantSource,
} from '@bananagig/contracts';
import { sql, type Database, type Kysely, type DatabaseSchema, type Trx } from '@bananagig/database';
import { getCorrelationId, log } from '@bananagig/observability';
import { insertOutboxEvent } from '@bananagig/platform';
import { AccountError, isDatabaseOutage } from './errors';
import { bootstrapRoleCodes, parseVerifiedIdentity, resolveActiveRole, type MembershipView, type VerifiedIdentity } from './identity';

type Row = Record<string, unknown>;
type Executor = Kysely<DatabaseSchema> | Trx;

// ---------------------------------------------------------------- public types
export interface AccountServiceDeps {
  database: Database;
  /** Minimum seconds between two updates of external_identities.last_seen_at (default 300; 0 = every request). */
  lastSeenTouchSeconds?: number;
}
export interface AccountRoleView {
  code: string;
  nameContentKey: string;
}
export interface AccountContext {
  accountId: string;
  status: AccountStatus;
  /** The ACTIVE roles of the account. */
  roles: AccountRoleView[];
  /** Every membership (any status), for callers that must tell "not held" from "not active". */
  memberships: MembershipView[];
  primaryRole: string | null;
  /** The role this request acts as (see resolveActiveRole), or null. */
  activeRole: string | null;
  profile: AccountProfileDto | null;
  createdAt: Date;
  /** True only for the call that created the account. */
  created: boolean;
}
export interface LoadOptions {
  /** The role the request names (header or role switch). Validated against the account's memberships. */
  requestedRole?: string | null;
  includeProfile?: boolean;
  /** Return SUSPENDED and CLOSED accounts instead of refusing them (administrative callers). */
  allowUnusable?: boolean;
}
export interface RoleChangeOptions {
  /** Who acts: `account:<id>`, `admin:<subject>` or `system:<name>`. Never a token. */
  actor: string;
  reason?: string;
}
export interface GrantRoleOptions extends RoleChangeOptions {
  source: RoleGrantSource;
  /** Grant the membership without activating it (PENDING). */
  pending?: boolean;
}
export interface ProfileInput {
  firstName: string;
  lastName: string;
  preferredLocale?: string | null;
  timeZone?: string | null;
}

// ---------------------------------------------------------------- errors
const RULE_DETAIL = /^identity_rule:([A-Z][A-Z_]*)$/;
export const ruleOf = (detail: unknown): string | undefined => (typeof detail === 'string' ? RULE_DETAIL.exec(detail)?.[1] : undefined);

function guardError(rule: string | undefined): AccountError {
  switch (rule) {
    case 'ACCOUNT_CLOSED':
      return new AccountError('CLOSED', 'the account is closed', { reason: rule });
    case 'ROLE_NOT_ACTIVE':
    case 'PRIMARY_ROLE_NOT_ACTIVE':
      return new AccountError('ROLE_NOT_ACTIVE', 'the role is not active', { reason: rule });
    case 'PRIMARY_ROLE_IN_USE':
      return new AccountError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', {
        reason: 'CONCURRENT_UPDATE',
        retryable: true,
      });
    case 'ACCOUNT_STATUS_TRANSITION':
    case 'ACCOUNT_HAS_ACTIVE_ROLES':
    case 'ROLE_IN_USE':
    case 'ROLE_STATUS_TRANSITION':
    case 'ACCOUNT_INITIAL_STATE':
    case 'STATUS_HISTORY_MISMATCH':
      return new AccountError('INVALID_STATE', 'the operation is not allowed in the current state', { reason: rule });
    case 'IMMUTABLE_IDENTITY':
    case 'NOT_DELETABLE':
    case 'ROW_IMMUTABLE':
      return new AccountError('INVALID_STATE', 'the record is immutable', { reason: 'IMMUTABLE' });
    default:
      return new AccountError('INVALID_STATE', 'the operation violates an account integrity rule');
  }
}

/**
 * Translates database constraint, guard and concurrency failures into typed errors with fixed messages (no driver text, no SQL, no table names).
 * Guard (trigger) failures are classified by `error.detail` (`identity_rule:<KEY>`), never by message text.
 */
export function mapDbError(err: unknown): never {
  if (err instanceof AccountError) throw err;
  const e = (err ?? {}) as { code?: string; detail?: string; constraint?: string };
  if (e.code === '40P01' || e.code === '40001' || e.code === '55P03')
    throw new AccountError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', { reason: 'CONCURRENT_UPDATE', retryable: true });
  if (e.code === '23505') throw new AccountError('CONFLICT', 'a record with this identity already exists', { reason: 'DUPLICATE', constraint: e.constraint });
  if (e.code === '23000') throw guardError(ruleOf(e.detail));
  if (e.code === '23514') throw new AccountError('VALIDATION_FAILED', 'the value violates an account constraint', { constraint: e.constraint });
  if (e.code === '23503') throw new AccountError('VALIDATION_FAILED', 'a referenced record does not exist', { constraint: e.constraint });
  if (e.code === '22021' || e.code === '22P05')
    throw new AccountError('VALIDATION_FAILED', 'the request contains a character that is not allowed', { reason: 'FORBIDDEN_CHARACTER' });
  if (isDatabaseOutage(err)) {
    // the driver message is not logged: it can echo statement text; the SQLSTATE or the error class is enough to diagnose an outage
    log('error', 'account database unavailable', { code: e.code ?? (err instanceof Error ? err.name : 'unknown') });
    throw new AccountError('UNAVAILABLE', 'the account database is unavailable');
  }
  throw err;
}

/** SUSPENDED and CLOSED accounts cannot be used (the API answers 403). The error carries the status only. */
export function assertUsable(status: AccountStatus): void {
  if (status === 'SUSPENDED') throw new AccountError('SUSPENDED', 'the account is suspended', { status });
  if (status === 'CLOSED') throw new AccountError('CLOSED', 'the account is closed', { status });
}

const actorType = (actor: string): 'user' | 'system' => (actor.startsWith('system:') ? 'system' : 'user');
const requireActor = (actor: unknown): string => {
  if (typeof actor !== 'string' || actor.trim() === '' || actor.length > 200)
    throw new AccountError('VALIDATION_FAILED', 'the actor is required', { reason: 'INVALID_FIELD', field: 'actor' });
  return actor;
};
const requireReason = (reason: unknown): string | null => {
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 1000)
    throw new AccountError('VALIDATION_FAILED', 'the reason must be a non-blank string of at most 1000 characters', {
      reason: 'INVALID_FIELD',
      field: 'reason',
    });
  return reason;
};

export class AccountService {
  private readonly touchSeconds: number;

  constructor(private readonly d: AccountServiceDeps) {
    this.touchSeconds = d.lastSeenTouchSeconds ?? 300;
  }

  private get db(): Executor {
    return this.d.database.db;
  }
  private tx<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.d.database.transaction(fn).catch(mapDbError);
  }

  // ------------------------------------------------------------------ reading
  private async loadContext(ex: Executor, accountId: string, opts: LoadOptions & { created?: boolean } = {}): Promise<AccountContext> {
    const a = (
      await sql<Row>`SELECT a.account_id, a.status, a.created_at, pr.code AS primary_code
        FROM identity.accounts a LEFT JOIN identity.roles pr ON pr.role_id = a.primary_role_id WHERE a.account_id = ${accountId}`.execute(ex)
    ).rows[0];
    if (!a) throw new AccountError('NOT_FOUND', 'the account does not exist');
    const status = a.status as AccountStatus;
    if (!opts.allowUnusable) assertUsable(status);
    const memberRows = (
      await sql<Row>`SELECT r.code, r.name_content_key, m.status, m.activated_at
        FROM identity.account_roles m JOIN identity.roles r ON r.role_id = m.role_id WHERE m.account_id = ${accountId}
        ORDER BY m.activated_at NULLS LAST, r.code`.execute(ex)
    ).rows;
    const memberships: MembershipView[] = memberRows.map((r) => ({ code: r.code as string, status: r.status as MembershipView['status'] }));
    const primaryRole = (a.primary_code as string | null) ?? null;
    const activeRole = resolveActiveRole({ requested: opts.requestedRole, memberships, primaryRole });
    let profile: AccountProfileDto | null = null;
    if (opts.includeProfile) {
      const p = (
        await sql<Row>`SELECT p.first_name, p.last_name, p.preferred_locale, z.iana_name
          FROM identity.account_profiles p LEFT JOIN geography.time_zones z ON z.time_zone_id = p.time_zone_id WHERE p.account_id = ${accountId}`.execute(ex)
      ).rows[0];
      if (p)
        profile = {
          firstName: p.first_name as string,
          lastName: p.last_name as string,
          preferredLocale: (p.preferred_locale as string | null) ?? null,
          timeZone: (p.iana_name as string | null) ?? null,
        };
    }
    return {
      accountId,
      status,
      roles: memberRows.filter((r) => r.status === 'ACTIVE').map((r) => ({ code: r.code as string, nameContentKey: r.name_content_key as string })),
      memberships,
      primaryRole,
      activeRole,
      profile,
      createdAt: a.created_at as Date,
      created: opts.created === true,
    };
  }

  /** The context of a known account (internal callers: the account id comes from a verified identity, never from a client). */
  async getAccountContext(accountId: string, opts: LoadOptions = {}): Promise<AccountContext> {
    return this.loadContext(this.db, accountId, opts).catch(mapDbError);
  }

  // ------------------------------------------------------------------ provisioning
  /**
   * Returns the account linked to a verified identity, creating account and link atomically on the first request. Idempotent and safe under
   * concurrency: the unique key (provider, issuer, subject) admits one winner, and every other caller returns the winner's account.
   * Initial roles come from the one-time bootstrap policy (ADR-0025); an identity with no mapped realm role starts with no role.
   */
  async ensureAccountForIdentity(identity: VerifiedIdentity, opts: LoadOptions = {}): Promise<AccountContext> {
    const id = parseVerifiedIdentity(identity);
    for (let attempt = 0; attempt < 3; attempt++) {
      const linked = await this.findLinked(id);
      if (linked) {
        await this.touchLastSeen(linked.externalIdentityId);
        return this.loadContext(this.db, linked.accountId, opts).catch(mapDbError);
      }
      try {
        const accountId = await this.createAccount(id);
        return await this.loadContext(this.db, accountId, { ...opts, created: true }).catch(mapDbError);
      } catch (err) {
        // another request created the account for the same identity first: its link row wins, ours rolled back; read it
        if (err instanceof AccountError && err.code === 'CONFLICT' && String(err.details.constraint ?? '').startsWith('uq_external_identities')) continue;
        throw err;
      }
    }
    throw new AccountError('CONFLICT', 'the account could not be provisioned; repeat the request', { reason: 'CONCURRENT_UPDATE', retryable: true });
  }

  private async findLinked(id: VerifiedIdentity): Promise<{ accountId: string; externalIdentityId: string } | null> {
    const r = await sql<Row>`SELECT external_identity_id, account_id FROM identity.external_identities
      WHERE provider_type = ${id.providerType} AND issuer = ${id.issuer} AND provider_subject = ${id.subject}`
      .execute(this.db)
      .catch(mapDbError);
    const row = r.rows[0];
    return row ? { accountId: row.account_id as string, externalIdentityId: row.external_identity_id as string } : null;
  }

  /** Touches last_seen_at at most once per interval; a failure never fails the request (it is only an operational hint). */
  private async touchLastSeen(externalIdentityId: string): Promise<void> {
    try {
      await sql`UPDATE identity.external_identities SET last_seen_at = now()
        WHERE external_identity_id = ${externalIdentityId} AND last_seen_at < now() - make_interval(secs => ${this.touchSeconds})`.execute(this.db);
    } catch {
      log('warn', 'account last_seen_at could not be updated');
    }
  }

  private async createAccount(id: VerifiedIdentity): Promise<string> {
    const cid = getCorrelationId() ?? randomUUID();
    const actor = 'system:account-bootstrap';
    return this.tx(async (trx) => {
      const created = await sql<Row>`INSERT INTO identity.accounts (status) VALUES ('ACTIVE') RETURNING account_id`.execute(trx);
      const accountId = created.rows[0]!.account_id as string;
      await sql`INSERT INTO identity.account_status_history (account_id, from_status, to_status, reason, actor, correlation_id)
        VALUES (${accountId}, NULL, 'ACTIVE', 'account created from the first verified identity', ${actor}, ${cid})`.execute(trx);
      // the unique key decides who wins a race: a duplicate raises 23505 here and the whole transaction (including the account above) rolls back
      await sql`INSERT INTO identity.external_identities (account_id, provider_type, issuer, provider_subject)
        VALUES (${accountId}, ${id.providerType}, ${id.issuer}, ${id.subject})`.execute(trx);
      await this.audit(trx, cid, { actor, action: 'ACCOUNT_CREATED', accountId, changes: { status: [null, 'ACTIVE'] } });
      await this.audit(trx, cid, { actor, action: 'EXTERNAL_IDENTITY_LINKED', accountId, changes: { providerType: id.providerType } });
      await this.event(trx, cid, IDENTITY_EVENTS.accountCreated, accountId, actor, { accountId, status: 'ACTIVE' } satisfies AccountCreatedPayload);
      await this.event(trx, cid, IDENTITY_EVENTS.externalIdentityLinked, accountId, actor, {
        accountId,
        providerType: id.providerType,
      } satisfies ExternalIdentityLinkedPayload);
      for (const code of bootstrapRoleCodes(id.identityRoles)) await this.grantInTx(trx, cid, accountId, code, { actor, source: 'BOOTSTRAP' });
      return accountId;
    });
  }

  // ------------------------------------------------------------------ roles
  private async lockAccount(trx: Trx, accountId: string): Promise<AccountStatus> {
    const locked = await sql<Row>`SELECT 1 FROM identity.accounts WHERE account_id = ${accountId} FOR UPDATE`.execute(trx);
    if (locked.rows.length === 0) throw new AccountError('NOT_FOUND', 'the account does not exist');
    return (await sql<Row>`SELECT status FROM identity.accounts WHERE account_id = ${accountId}`.execute(trx)).rows[0]!.status as AccountStatus;
  }

  private async roleByCode(trx: Trx, code: string): Promise<{ roleId: string; status: string }> {
    const locked = await sql<Row>`SELECT 1 FROM identity.roles WHERE code = ${code} FOR SHARE`.execute(trx);
    if (locked.rows.length === 0) throw new AccountError('ROLE_NOT_FOUND', 'the role does not exist', { role: String(code).slice(0, 30) });
    const r = (await sql<Row>`SELECT role_id, status FROM identity.roles WHERE code = ${code}`.execute(trx)).rows[0]!;
    return { roleId: r.role_id as string, status: r.status as string };
  }

  /** Grants (or reactivates) a role inside a transaction whose account row is already locked or brand new. Returns whether anything changed. */
  private async grantInTx(trx: Trx, cid: string, accountId: string, roleCode: string, o: GrantRoleOptions): Promise<{ changed: boolean; status: string }> {
    const role = await this.roleByCode(trx, roleCode);
    if (role.status !== 'ACTIVE') throw new AccountError('ROLE_NOT_ACTIVE', 'the role is not active', { role: roleCode });
    const reason = requireReason(o.reason);
    const wanted = o.pending ? 'PENDING' : 'ACTIVE';
    const existing = await sql<Row>`SELECT 1 FROM identity.account_roles WHERE account_id = ${accountId} AND role_id = ${role.roleId} FOR UPDATE`.execute(trx);
    let current: string | null = null;
    if (existing.rows.length > 0)
      current = (await sql<Row>`SELECT status FROM identity.account_roles WHERE account_id = ${accountId} AND role_id = ${role.roleId}`.execute(trx)).rows[0]!
        .status as string;

    if (current === null) {
      await sql`INSERT INTO identity.account_roles (account_id, role_id, status, activated_at, granted_by, grant_source)
        VALUES (${accountId}, ${role.roleId}, ${wanted}, ${wanted === 'ACTIVE' ? sql`now()` : sql`NULL`}, ${o.actor}, ${o.source})`.execute(trx);
      await this.audit(trx, cid, {
        actor: o.actor,
        action: 'ROLE_GRANTED',
        accountId,
        roleId: role.roleId,
        changes: { status: [null, wanted], source: o.source },
        reason,
      });
    } else if (current === 'ACTIVE' || (current === 'PENDING' && wanted === 'PENDING')) {
      return { changed: false, status: current }; // idempotent: already in the wanted state
    } else if (wanted === 'PENDING') {
      throw new AccountError('INVALID_STATE', 'an inactive role cannot go back to pending', { reason: 'ROLE_STATUS_TRANSITION' });
    } else {
      await sql`UPDATE identity.account_roles SET status = 'ACTIVE', activated_at = now(), deactivated_at = NULL, granted_at = now(), granted_by = ${o.actor},
          grant_source = ${o.source}, updated_at = now() WHERE account_id = ${accountId} AND role_id = ${role.roleId}`.execute(trx);
      await this.audit(trx, cid, {
        actor: o.actor,
        action: 'ROLE_ACTIVATED',
        accountId,
        roleId: role.roleId,
        changes: { status: [current, 'ACTIVE'], source: o.source },
        reason,
      });
    }
    if (wanted === 'ACTIVE') {
      await this.event(trx, cid, IDENTITY_EVENTS.accountRoleGranted, accountId, o.actor, {
        accountId,
        roleCode,
        source: o.source,
      } satisfies AccountRolePayload);
      // the first active role becomes the preferred (primary) role
      const acc = (await sql<Row>`SELECT primary_role_id FROM identity.accounts WHERE account_id = ${accountId}`.execute(trx)).rows[0]!;
      if (acc.primary_role_id === null) {
        await sql`UPDATE identity.accounts SET primary_role_id = ${role.roleId}, updated_at = now() WHERE account_id = ${accountId}`.execute(trx);
        await this.audit(trx, cid, { actor: o.actor, action: 'PRIMARY_ROLE_CHANGED', accountId, changes: { primaryRole: [null, roleCode] }, reason });
      }
    }
    return { changed: true, status: wanted };
  }

  /**
   * Grants a role to an account: idempotent (an ACTIVE membership is left alone and nothing is written), reactivates a deactivated membership, audited,
   * and emits account-role-granted when the membership becomes ACTIVE. Server-side only: there is deliberately no endpoint for it.
   */
  async grantRole(accountId: string, roleCode: string, opts: GrantRoleOptions): Promise<{ changed: boolean; status: string }> {
    const actor = requireActor(opts.actor);
    requireReason(opts.reason); // validated before a transaction is opened (grantInTx validates again, cheaply)
    const cid = getCorrelationId() ?? randomUUID();
    return this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      return this.grantInTx(trx, cid, accountId, roleCode, { ...opts, actor });
    });
  }

  /** Deactivates a role membership (idempotent). A primary role moves to another ACTIVE role, or is cleared, in the same transaction. */
  async deactivateRole(accountId: string, roleCode: string, opts: RoleChangeOptions): Promise<{ changed: boolean }> {
    const actor = requireActor(opts.actor);
    const reason = requireReason(opts.reason);
    const cid = getCorrelationId() ?? randomUUID();
    return this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      return this.deactivateInTx(trx, cid, accountId, roleCode, actor, reason);
    });
  }

  private async deactivateInTx(
    trx: Trx,
    cid: string,
    accountId: string,
    roleCode: string,
    actor: string,
    reason: string | null,
  ): Promise<{ changed: boolean }> {
    const role = (await sql<Row>`SELECT role_id FROM identity.roles WHERE code = ${roleCode}`.execute(trx)).rows[0];
    if (!role) throw new AccountError('ROLE_NOT_HELD', 'the account does not hold that role', { role: String(roleCode).slice(0, 30) });
    const roleId = role.role_id as string;
    const locked = await sql<Row>`SELECT 1 FROM identity.account_roles WHERE account_id = ${accountId} AND role_id = ${roleId} FOR UPDATE`.execute(trx);
    if (locked.rows.length === 0) throw new AccountError('ROLE_NOT_HELD', 'the account does not hold that role', { role: roleCode });
    const current = (await sql<Row>`SELECT status FROM identity.account_roles WHERE account_id = ${accountId} AND role_id = ${roleId}`.execute(trx)).rows[0]!
      .status as string;
    if (current === 'INACTIVE') return { changed: false };
    const acc = (await sql<Row>`SELECT primary_role_id FROM identity.accounts WHERE account_id = ${accountId}`.execute(trx)).rows[0]!;
    if (acc.primary_role_id === roleId) {
      const next = (
        await sql<Row>`SELECT r.role_id, r.code FROM identity.account_roles m JOIN identity.roles r ON r.role_id = m.role_id
          WHERE m.account_id = ${accountId} AND m.role_id <> ${roleId} AND m.status = 'ACTIVE' ORDER BY m.activated_at, r.code LIMIT 1`.execute(trx)
      ).rows[0];
      await sql`UPDATE identity.accounts SET primary_role_id = ${(next?.role_id as string | undefined) ?? null}, updated_at = now() WHERE account_id = ${accountId}`.execute(
        trx,
      );
      await this.audit(trx, cid, {
        actor,
        action: 'PRIMARY_ROLE_CHANGED',
        accountId,
        changes: { primaryRole: [roleCode, (next?.code as string | undefined) ?? null] },
        reason,
      });
    }
    await sql`UPDATE identity.account_roles SET status = 'INACTIVE', deactivated_at = now(), updated_at = now() WHERE account_id = ${accountId} AND role_id = ${roleId}`.execute(
      trx,
    );
    await this.audit(trx, cid, { actor, action: 'ROLE_DEACTIVATED', accountId, roleId, changes: { status: [current, 'INACTIVE'] }, reason });
    // only a membership that was announced (account-role-granted, i.e. ACTIVE) is announced as deactivated; a PENDING one never was
    if (current === 'ACTIVE')
      await this.event(trx, cid, IDENTITY_EVENTS.accountRoleDeactivated, accountId, actor, { accountId, roleCode } satisfies AccountRolePayload);
    return { changed: true };
  }

  /** Sets (or clears, with null) the preferred role. It must be an ACTIVE membership of the account. */
  async setPrimaryRole(accountId: string, roleCode: string | null, opts: RoleChangeOptions): Promise<{ changed: boolean }> {
    const actor = requireActor(opts.actor);
    const reason = requireReason(opts.reason);
    const cid = getCorrelationId() ?? randomUUID();
    return this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const cur = (
        await sql<Row>`SELECT r.code FROM identity.accounts a LEFT JOIN identity.roles r ON r.role_id = a.primary_role_id WHERE a.account_id = ${accountId}`.execute(
          trx,
        )
      ).rows[0]!.code as string | null;
      if (cur === roleCode) return { changed: false };
      let roleId: string | null = null;
      if (roleCode !== null) {
        const m = (
          await sql<Row>`SELECT m.status, r.role_id FROM identity.account_roles m JOIN identity.roles r ON r.role_id = m.role_id WHERE m.account_id = ${accountId} AND r.code = ${roleCode}`.execute(
            trx,
          )
        ).rows[0];
        if (!m) throw new AccountError('ROLE_NOT_HELD', 'the account does not hold that role', { role: String(roleCode).slice(0, 30) });
        if (m.status !== 'ACTIVE') throw new AccountError('ROLE_NOT_ACTIVE', 'that role is not active for the account', { role: roleCode });
        roleId = m.role_id as string;
      }
      await sql`UPDATE identity.accounts SET primary_role_id = ${roleId}, updated_at = now() WHERE account_id = ${accountId}`.execute(trx);
      await this.audit(trx, cid, { actor, action: 'PRIMARY_ROLE_CHANGED', accountId, changes: { primaryRole: [cur, roleCode] }, reason });
      return { changed: true };
    });
  }

  /**
   * The context for switching the active role. Pure validation: the requested role must be an ACTIVE membership of the account (ROLE_NOT_HELD or
   * ROLE_NOT_ACTIVE otherwise). Nothing is written and no Keycloak session is touched; the caller (the web server session) remembers the role and sends
   * it with later requests, where it is validated again.
   */
  async selectActiveRole(accountId: string, roleCode: string): Promise<AccountContext> {
    return this.loadContext(this.db, accountId, { requestedRole: roleCode, includeProfile: true }).catch(mapDbError);
  }

  // ------------------------------------------------------------------ status
  /**
   * Changes the account status along the state machine (CLOSED is terminal; closing deactivates every role and clears the primary role in the same
   * transaction). Idempotent for the current status. Writes the immutable history row, an event and, for closure, the role audit rows.
   */
  async changeStatus(accountId: string, to: AccountStatus, opts: RoleChangeOptions): Promise<{ changed: boolean; from: AccountStatus }> {
    const actor = requireActor(opts.actor);
    const reason = requireReason(opts.reason);
    const cid = getCorrelationId() ?? randomUUID();
    return this.tx(async (trx) => {
      const from = await this.lockAccount(trx, accountId);
      if (from === to) return { changed: false, from };
      if (!isAccountStatusTransitionAllowed(from, to))
        throw new AccountError('INVALID_STATE', `the account cannot change from ${from} to ${to}`, { reason: 'ACCOUNT_STATUS_TRANSITION', from, to });
      if (to === 'CLOSED') {
        const primary = (
          await sql<Row>`SELECT r.code FROM identity.accounts a JOIN identity.roles r ON r.role_id = a.primary_role_id WHERE a.account_id = ${accountId}`.execute(
            trx,
          )
        ).rows[0];
        await sql`UPDATE identity.accounts SET primary_role_id = NULL, updated_at = now() WHERE account_id = ${accountId}`.execute(trx);
        if (primary)
          await this.audit(trx, cid, {
            actor,
            action: 'PRIMARY_ROLE_CHANGED',
            accountId,
            changes: { primaryRole: [primary.code as string, null] },
            reason: reason ?? 'account closed',
          });
        const open = await sql<Row>`SELECT r.code FROM identity.account_roles m JOIN identity.roles r ON r.role_id = m.role_id
          WHERE m.account_id = ${accountId} AND m.status IN ('PENDING', 'ACTIVE') ORDER BY r.code`.execute(trx);
        for (const r of open.rows) await this.deactivateInTx(trx, cid, accountId, r.code as string, actor, reason ?? 'account closed');
      }
      await sql`UPDATE identity.accounts SET status = ${to}, closed_at = ${to === 'CLOSED' ? sql`now()` : sql`NULL`}, updated_at = now() WHERE account_id = ${accountId}`.execute(
        trx,
      );
      await sql`INSERT INTO identity.account_status_history (account_id, from_status, to_status, reason, actor, correlation_id)
        VALUES (${accountId}, ${from}, ${to}, ${reason}, ${actor}, ${cid})`.execute(trx);
      await this.event(trx, cid, IDENTITY_EVENTS.accountStatusChanged, accountId, actor, {
        accountId,
        fromStatus: from,
        toStatus: to,
      } satisfies AccountStatusChangedPayload);
      return { changed: true, from };
    });
  }

  // ------------------------------------------------------------------ profile
  /**
   * Replaces the core profile of the account: first and last name (trimmed, 1 to 50 characters), optional preferred locale (an ACTIVE locale) and time
   * zone override (an ACTIVE registered zone). Idempotent: an unchanged profile writes nothing. The audit row names the changed fields, never their values.
   */
  async upsertProfile(accountId: string, input: ProfileInput, opts: { actor: string }): Promise<{ changed: boolean; profile: AccountProfileDto }> {
    const actor = requireActor(opts.actor);
    const issues: { field: string; code: string; messageKey: string }[] = [];
    const first = validateProfileName(input.firstName);
    const last = validateProfileName(input.lastName);
    if (!first.ok) issues.push({ field: 'firstName', code: first.code, messageKey: profileIssueMessageKey(first.code) });
    if (!last.ok) issues.push({ field: 'lastName', code: last.code, messageKey: profileIssueMessageKey(last.code) });
    if (issues.length > 0 || !first.ok || !last.ok)
      throw new AccountError('VALIDATION_FAILED', 'the profile is not valid', { reason: 'INVALID_PROFILE', issues });
    let locale: string | null = null;
    if (input.preferredLocale !== undefined && input.preferredLocale !== null) {
      locale = canonicalizeLocale(input.preferredLocale);
      if (locale === null)
        throw new AccountError('VALIDATION_FAILED', 'the preferred locale is not valid', { reason: 'INVALID_FIELD', field: 'preferredLocale' });
    }
    const cid = getCorrelationId() ?? randomUUID();
    return this.tx(async (trx) => {
      assertUsable(await this.lockAccount(trx, accountId));
      if (locale !== null) {
        const l = await sql<Row>`SELECT 1 FROM content.locales WHERE locale = ${locale} AND is_active FOR SHARE`.execute(trx);
        if (l.rows.length === 0)
          throw new AccountError('VALIDATION_FAILED', 'the preferred locale is not available', { reason: 'UNKNOWN_LOCALE', field: 'preferredLocale' });
      }
      let zoneId: string | null = null;
      if (input.timeZone !== undefined && input.timeZone !== null) {
        const z = (
          await sql<Row>`SELECT time_zone_id FROM geography.time_zones WHERE iana_name = ${input.timeZone} AND status = 'ACTIVE' FOR SHARE`.execute(trx)
        ).rows[0];
        if (!z) throw new AccountError('VALIDATION_FAILED', 'the time zone is not available', { reason: 'UNKNOWN_TIME_ZONE', field: 'timeZone' });
        zoneId = z.time_zone_id as string;
      }
      const before = (
        await sql<Row>`SELECT first_name, last_name, preferred_locale, time_zone_id FROM identity.account_profiles WHERE account_id = ${accountId} FOR UPDATE`.execute(
          trx,
        )
      ).rows[0];
      const changedFields = [
        ...(before?.first_name !== first.value ? ['firstName'] : []),
        ...(before?.last_name !== last.value ? ['lastName'] : []),
        ...((before?.preferred_locale ?? null) !== locale ? ['preferredLocale'] : []),
        ...((before?.time_zone_id ?? null) !== zoneId ? ['timeZone'] : []),
      ];
      const profile: AccountProfileDto = { firstName: first.value, lastName: last.value, preferredLocale: locale, timeZone: input.timeZone ?? null };
      if (before && changedFields.length === 0) return { changed: false, profile };
      await sql`INSERT INTO identity.account_profiles (account_id, first_name, last_name, preferred_locale, time_zone_id)
        VALUES (${accountId}, ${first.value}, ${last.value}, ${locale}, ${zoneId})
        ON CONFLICT (account_id) DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, preferred_locale = EXCLUDED.preferred_locale,
          time_zone_id = EXCLUDED.time_zone_id, updated_at = now()`.execute(trx);
      await this.audit(trx, cid, { actor, action: 'PROFILE_UPDATED', accountId, changes: { fields: changedFields } });
      return { changed: true, profile };
    });
  }

  // ------------------------------------------------------------------ audit and events
  private audit(
    trx: Trx,
    cid: string,
    a: { actor: string; action: string; accountId: string; roleId?: string; changes?: Record<string, unknown>; reason?: string | null },
  ) {
    return sql`INSERT INTO identity.account_audit_events (actor, action, account_id, role_id, changes, reason, correlation_id)
      VALUES (${a.actor}, ${a.action}, ${a.accountId}, ${a.roleId ?? null}, ${a.changes ? JSON.stringify(a.changes) : null}::jsonb, ${a.reason ?? null}, ${cid})`.execute(
      trx,
    );
  }
  private event(trx: Trx, cid: string, eventType: string, accountId: string, actor: string, payload: Record<string, unknown>) {
    return insertOutboxEvent(trx, {
      aggregateType: 'identity_account',
      aggregateId: accountId,
      eventType,
      actorType: actorType(actor),
      actorId: actor,
      correlationId: cid,
      payload,
    });
  }
}
