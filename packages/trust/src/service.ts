// The provider verification service (TRUST-001). Verification is MULTI-DIMENSIONAL: a case holds one requirement instance (per cycle) for everything policy asks of the provider,
// each evidenced by documents (private object storage) or an external verification and decided on its own by a reviewer. The overall state is DERIVED (see derive.ts); nothing
// here says "verified", and an approved case is NOT Go-Live (PRO-003).
//
// Ownership: the account, its contacts and the provider registration are read through ProviderContextPort and never copied; file bytes live in the private object store; scanning
// and external verification are ports. Every operation takes the caller's account id from the authenticated request (never from a client); reviewers are admin identities.
//
// Transactions and locks: provider operations lock the ACCOUNT row first (FOR UPDATE, the ID-001 order), then the case, then the requirement rows; reviewer and system operations lock
// the CASE first. So the order is account -> case -> requirement -> document everywhere, and a case is the unit of serialization. Object-store reads, deletes, download links and
// scanner and adapter calls NEVER happen while a lock is held: they run before the transaction, and the transaction re-checks the state it depended on. (Signing an upload URL is a
// local computation, not I/O, and is done inside the authorizing transaction.)
import { createHash, randomUUID } from 'node:crypto';
import {
  ApproveRequirementRequest,
  FinalizeDocumentRequest,
  RejectRequirementRequest,
  RequestActionRequest,
  RequestDocumentUploadRequest,
  SetRequirementRuleRequest,
  SetRequirementStatusRequest,
  StartReviewRequest,
  SubmitVerificationRequest,
  TRUST_EVENTS,
  TRUST_EVIDENCE_OPEN_STATUSES,
  isTrustDefinitionTransitionAllowed,
  type TrustCaseEventPayload,
  type TrustCaseStatus,
  type TrustDefinitionStatus,
  type TrustDocumentPolicy,
  type TrustExternalStatus,
  type TrustRequirementEventPayload,
  type TrustRequirementStatus,
  type TrustRequirementType,
  type TrustReviewDecision,
  type TrustScanStatus,
} from '@bananagig/contracts';
import { sql, type Database, type DatabaseSchema, type Kysely, type Trx } from '@bananagig/database';
import { getCorrelationId, log } from '@bananagig/observability';
import { ObjectStoreError, insertOutboxEvent, type PrivateObjectStore } from '@bananagig/platform';
import type { z } from 'zod';
import { DisabledEvidenceScanner, DisabledVerificationProvider } from './adapters';
import { deriveStatus, effectiveStatus, evaluateVerification } from './derive';
import { TrustError, isDatabaseOutage } from './errors';
import { queryPublicBadgeTypes } from './public-badges';
import { matchesSignature } from './signatures';
import type {
  AdminRequirementView,
  CaseDetailView,
  CaseRow,
  CaseSummaryView,
  DecisionResult,
  DocumentView,
  EvidenceScanner,
  InstanceRow,
  PolicyView,
  ProviderContext,
  ProviderContextPort,
  ProviderVerificationView,
  RequiredDefinition,
  ReviewView,
  TrustPolicyProvider,
  UploadAuthorizationView,
  VerificationProvider,
} from './types';

type Row = Record<string, unknown>;
type Executor = Kysely<DatabaseSchema> | Trx;

export interface TrustServiceDeps {
  database: Database;
  context: ProviderContextPort;
  policy: TrustPolicyProvider;
  store: PrivateObjectStore;
  /** Default: the disabled scanner (fail closed). */
  scanner?: EvidenceScanner;
  /** Default: the disabled provider. */
  external?: VerificationProvider;
  /** The clock for expiry decisions (default: the system clock). Database timestamps always come from the database. */
  now?: () => Date;
}

// ---------------------------------------------------------------- errors
const RULE_DETAIL = /^trust_rule:([A-Z][A-Z_]*)$/;
export function guardRuleOf(detail: unknown): string | undefined {
  return typeof detail === 'string' ? RULE_DETAIL.exec(detail)?.[1] : undefined;
}
const CONFLICT = (reason = 'CONCURRENT_UPDATE'): TrustError =>
  new TrustError('CONFLICT', 'the change conflicted with a concurrent update; repeat the request', { reason, retryable: true });
/** Translates database constraint, guard and concurrency failures into typed errors with fixed messages (no driver text, no SQL, no table names). */
export function mapDbError(err: unknown): never {
  if (err instanceof TrustError || err === null || typeof err !== 'object') throw err;
  const e = err as { code?: string; detail?: string; constraint?: string };
  if (e.code === '40P01' || e.code === '40001' || e.code === '55P03') throw CONFLICT();
  if (e.code === '22021' || e.code === '22P05')
    throw new TrustError('VALIDATION_FAILED', 'the request contains a character that is not allowed', { reason: 'FORBIDDEN_CHARACTER' });
  if (e.code === '23505') {
    if (e.constraint === 'uq_reviews__decision') throw new TrustError('ALREADY_DECIDED', 'this evidence was already decided', { reason: 'ALREADY_DECIDED' });
    throw CONFLICT();
  }
  if (e.code === '23000') {
    const rule = guardRuleOf(e.detail);
    switch (rule) {
      case 'ACCOUNT_NOT_ACTIVE':
        throw new TrustError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: rule });
      case 'REVIEW_ROUND':
      case 'ROUND_SEQUENCE':
        throw new TrustError('STALE_ROUND', 'the evidence changed since it was read', { reason: rule });
      case 'REASON_INACTIVE':
      case 'REASON_NOT_APPLICABLE':
        throw new TrustError('REASON_INVALID', 'that reason cannot be used for this decision', { reason: rule });
      case 'EXPIRY_REQUIRED':
      case 'EXPIRY_IN_PAST':
        throw new TrustError('VALIDATION_FAILED', 'the approval needs a valid end date', { reason: rule });
      case 'DOCUMENT_TYPE_MISMATCH':
        throw new TrustError('DOCUMENT_TYPE_NOT_ACCEPTED', 'that kind of document is not accepted for this requirement', { reason: rule });
      case 'DOCUMENT_NOT_SUPPORTED':
      case 'EXTERNAL_NOT_SUPPORTED':
        throw new TrustError('EVIDENCE_NOT_ACCEPTED', 'this requirement does not take that kind of evidence', { reason: rule });
      case 'CASE_FROZEN':
      case 'SUPERSEDED_FROZEN':
      case 'SUPERSEDE_STATE':
      case 'STATUS_TRANSITION':
      case 'DOCUMENT_FROZEN':
      case 'DOCUMENT_REQUIREMENT_STATE':
      case 'DOCUMENT_ROUND':
      case 'EXTERNAL_STATE':
      case 'EXTERNAL_FROZEN':
      case 'REVIEW_STATE':
      case 'REVIEW_SUPERSEDED':
      case 'REQUIREMENT_NOT_ACTIVE':
      case 'CYCLE_NEEDS_EXPIRED':
      case 'EXPIRY_NOT_REACHED':
        throw new TrustError('INVALID_STATE', 'that is not possible in the current state', { reason: rule });
      default:
        throw new TrustError('CONFLICT', 'the operation violates a verification integrity rule', rule ? { reason: rule } : {});
    }
  }
  if (e.code === '23503') throw new TrustError('VALIDATION_FAILED', 'a referenced record does not exist', { reason: 'REFERENCE_NOT_FOUND' });
  if (isDatabaseOutage(err)) {
    log('error', 'verification database unavailable', { error: err instanceof Error ? err.message : String(err) });
    throw new TrustError('UNAVAILABLE', 'verification is unavailable');
  }
  throw err;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new TrustError('VALIDATION_FAILED', 'the request is not valid', {
    field: typeof issue?.path[0] === 'string' ? issue.path[0] : undefined,
    reason: 'INVALID_REQUEST',
  });
}

const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));
const isoOrNull = (d: unknown): string | null => (d === null || d === undefined ? null : iso(d));
const actorOf = (accountId: string): string => `account:${accountId}`;
/** The longest validity an approval can be given (structural bound against a mistyped year; the reviewer takes the real date from the evidence). */
const MAX_VALIDITY_DAYS = 3660;
/** Grace after the upload authorization expires before an unfinalized document is considered gone (clock skew between the store and the database). */
/** Where the provider's bytes arrive: a SEPARATE key from the final one. The presigned PUT stays valid until it expires, so the bytes are verified, copied to the final key and the
 * upload key is no longer read: a replayed PUT can only write an object nothing reads. */
const uploadKeyOf = (objectKey: string): string => objectKey.replace(/^trust\/evidence\//, 'trust/upload/');
const mimeOf = (contentType: string | undefined): string | undefined => contentType?.split(';')[0]?.trim().toLowerCase();

const toCase = (r: Row): CaseRow => ({
  verificationCaseId: r.verification_case_id as string,
  accountId: r.account_id as string,
  caseNumber: Number(r.case_number),
  status: r.status as TrustCaseStatus,
  revision: Number(r.revision),
  openedAt: iso(r.created_at),
  submittedAt: isoOrNull(r.submitted_at),
  decidedAt: isoOrNull(r.decided_at),
});
const toInstance = (r: Row): InstanceRow => ({
  caseRequirementId: r.case_requirement_id as string,
  verificationCaseId: r.verification_case_id as string,
  requirementDefinitionId: r.requirement_definition_id as string,
  requirementCode: r.requirement_code as string,
  requirementType: r.requirement_type as InstanceRow['requirementType'],
  evidenceKind: r.evidence_kind as InstanceRow['evidenceKind'],
  expiryRequired: r.expiry_required as boolean,
  cycle: Number(r.cycle),
  status: r.status as TrustRequirementStatus,
  round: Number(r.round),
  revision: Number(r.revision),
  approvedAt: isoOrNull(r.approved_at),
  expiresAt: isoOrNull(r.expires_at),
  supersededAt: isoOrNull(r.superseded_at),
  latestReasonCode: (r.latest_reason_code as string | null) ?? null,
});
const toDocument = (r: Row): DocumentView => ({
  verificationDocumentId: r.verification_document_id as string,
  caseRequirementId: r.case_requirement_id as string,
  documentTypeCode: r.document_type_code as string,
  status: r.status as DocumentView['status'],
  scanStatus: r.scan_status as TrustScanStatus,
  mimeType: r.mime_type as string,
  sizeBytes: Number(r.size_bytes),
  round: r.round === null || r.round === undefined ? null : Number(r.round),
  createdAt: iso(r.created_at),
  submittedAt: isoOrNull(r.submitted_at),
  sha256: (r.sha256 as string | null) ?? null,
});
const toReview = (r: Row): ReviewView => ({
  reviewId: r.review_id as string,
  caseRequirementId: r.case_requirement_id as string,
  round: Number(r.round),
  decision: r.decision as TrustReviewDecision,
  reasonCode: (r.reason_code as string | null) ?? null,
  reviewer: r.reviewer as string,
  expiresAt: isoOrNull(r.expires_at),
  reviewedAt: iso(r.reviewed_at),
});

const instanceSelect = sql`SELECT cr.case_requirement_id, cr.verification_case_id, cr.requirement_definition_id, d.code AS requirement_code, d.requirement_type, d.evidence_kind, d.expiry_required,
       cr.cycle, cr.status, cr.round, cr.revision, cr.approved_at, cr.expires_at, cr.superseded_at,
       (SELECT v.reason_code FROM trust.reviews v WHERE v.case_requirement_id = cr.case_requirement_id AND v.decision IN ('ACTION_REQUIRED', 'REJECTED') ORDER BY v.round DESC LIMIT 1) AS latest_reason_code
  FROM trust.case_requirements cr JOIN trust.requirement_definitions d ON d.requirement_definition_id = cr.requirement_definition_id`;
const documentSelect = sql`SELECT doc.verification_document_id, doc.case_requirement_id, dt.code AS document_type_code, doc.status, doc.scan_status, doc.mime_type, doc.size_bytes, doc.round,
       doc.created_at, doc.submitted_at, doc.sha256
  FROM trust.documents doc JOIN trust.document_types dt ON dt.document_type_id = doc.document_type_id`;

export class TrustService {
  private readonly scanner: EvidenceScanner;
  private readonly external: VerificationProvider;
  private readonly now: () => Date;

  constructor(private readonly d: TrustServiceDeps) {
    this.scanner = d.scanner ?? new DisabledEvidenceScanner();
    this.external = d.external ?? new DisabledVerificationProvider();
    this.now = d.now ?? (() => new Date());
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
  /** What policy requires of a provider in this market with these service types: ACTIVE definitions with at least one matching enabled rule. */
  private async resolveRequired(ex: Executor, ctx: Pick<ProviderContext, 'marketCode' | 'serviceTypeCodes'>): Promise<RequiredDefinition[]> {
    const r = await sql<Row>`SELECT d.requirement_definition_id, d.code, d.requirement_type, d.evidence_kind, d.expiry_required
      FROM trust.requirement_definitions d
      WHERE d.status = 'ACTIVE' AND EXISTS (
        SELECT 1 FROM trust.requirement_rules r
          LEFT JOIN geography.markets m ON m.market_id = r.market_id
          LEFT JOIN catalog.service_types s ON s.service_type_id = r.service_type_id
        WHERE r.requirement_definition_id = d.requirement_definition_id AND r.enabled
          AND (r.market_id IS NULL OR m.code = ${ctx.marketCode})
          AND (r.service_type_id IS NULL OR s.code = ANY(${[...ctx.serviceTypeCodes]}::text[])))
      ORDER BY d.code COLLATE "C"`.execute(ex);
    return r.rows.map((x) => ({
      requirementDefinitionId: x.requirement_definition_id as string,
      code: x.code as string,
      requirementType: x.requirement_type as RequiredDefinition['requirementType'],
      evidenceKind: x.evidence_kind as RequiredDefinition['evidenceKind'],
      expiryRequired: x.expiry_required as boolean,
    }));
  }
  private async liveCase(ex: Executor, accountId: string): Promise<CaseRow | null> {
    const r = (await sql<Row>`SELECT * FROM trust.verification_cases WHERE account_id = ${accountId} AND status <> 'CANCELLED'`.execute(ex)).rows[0];
    return r ? toCase(r) : null;
  }
  private async currentInstances(ex: Executor, caseId: string): Promise<InstanceRow[]> {
    const r = await sql<Row>`${instanceSelect} WHERE cr.verification_case_id = ${caseId} AND cr.superseded_at IS NULL ORDER BY d.code COLLATE "C"`.execute(ex);
    return r.rows.map(toInstance);
  }
  private async caseDocuments(ex: Executor, caseId: string): Promise<DocumentView[]> {
    const r = await sql<Row>`${documentSelect}
      WHERE doc.case_requirement_id IN (SELECT case_requirement_id FROM trust.case_requirements WHERE verification_case_id = ${caseId} AND superseded_at IS NULL)
      ORDER BY doc.created_at, doc.verification_document_id`.execute(ex);
    return r.rows.map(toDocument);
  }
  private async documentTypesByRequirementType(ex: Executor): Promise<Map<string, string[]>> {
    const r = await sql<Row>`SELECT code, requirement_type FROM trust.document_types WHERE status = 'ACTIVE' ORDER BY code COLLATE "C"`.execute(ex);
    const out = new Map<string, string[]>();
    for (const x of r.rows) out.set(x.requirement_type as string, [...(out.get(x.requirement_type as string) ?? []), x.code as string]);
    return out;
  }
  /** Locks the account row (the first lock of the ID-001 order) and requires it to be ACTIVE. */
  private async lockAccount(trx: Trx, accountId: string): Promise<void> {
    const r = (await sql<Row>`SELECT status FROM identity.accounts WHERE account_id = ${accountId} FOR UPDATE`.execute(trx)).rows[0];
    if (!r || r.status !== 'ACTIVE')
      throw new TrustError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: r ? 'ACCOUNT_NOT_ACTIVE' : 'ACCOUNT_NOT_FOUND' });
  }
  /** The case row of an account FOR UPDATE (the live case), or null. */
  private async lockLiveCase(trx: Trx, accountId: string): Promise<CaseRow | null> {
    const r = (await sql<Row>`SELECT * FROM trust.verification_cases WHERE account_id = ${accountId} AND status <> 'CANCELLED' FOR UPDATE`.execute(trx))
      .rows[0];
    return r ? toCase(r) : null;
  }
  private async lockInstances(trx: Trx, caseId: string): Promise<InstanceRow[]> {
    const r =
      await sql<Row>`${instanceSelect} WHERE cr.verification_case_id = ${caseId} AND cr.superseded_at IS NULL ORDER BY d.code COLLATE "C" FOR UPDATE OF cr`.execute(
        trx,
      );
    return r.rows.map(toInstance);
  }

  private audit(
    trx: Trx,
    cid: string,
    a: {
      actor: string;
      action: string;
      caseId?: string | null;
      requirementId?: string | null;
      definitionId?: string | null;
      changes?: Record<string, unknown>;
      reasonCode?: string | null;
    },
  ) {
    return sql`INSERT INTO trust.audit_events (actor, action, verification_case_id, case_requirement_id, requirement_definition_id, changes, reason_code, correlation_id)
      VALUES (${a.actor}, ${a.action}, ${a.caseId ?? null}, ${a.requirementId ?? null}, ${a.definitionId ?? null}, ${a.changes ? JSON.stringify(a.changes) : null}::jsonb, ${a.reasonCode ?? null}, ${cid})`.execute(
      trx,
    );
  }
  private event(trx: Trx, cid: string, type: string, caseId: string, actor: string, payload: Record<string, unknown>) {
    return insertOutboxEvent(trx, {
      aggregateType: 'verification_case',
      aggregateId: caseId,
      eventType: type,
      actorType: actor.startsWith('account:') ? 'user' : 'system',
      actorId: actor,
      correlationId: cid,
      payload,
    });
  }
  private casePayload(c: Pick<CaseRow, 'verificationCaseId' | 'accountId' | 'caseNumber'>, status: TrustCaseStatus): TrustCaseEventPayload {
    return { accountId: c.accountId, verificationCaseId: c.verificationCaseId, caseNumber: c.caseNumber, status };
  }

  /**
   * Re-derives the stored status of a case from its current instances (the same function the overview uses) and bumps its revision. `submitted` is passed explicitly because the
   * submit flow derives the status of the submission it is making. Returns the new status.
   */
  private async recompute(trx: Trx, c: CaseRow, submitted: boolean): Promise<TrustCaseStatus> {
    const rows =
      await sql<Row>`SELECT status, expires_at FROM trust.case_requirements WHERE verification_case_id = ${c.verificationCaseId} AND superseded_at IS NULL`.execute(
        trx,
      );
    // an approval past its end counts as EXPIRED even before the sweep records it (the same rule the overview applies), so the stored status never says APPROVED for a case the
    // provider's own overview reads as EXPIRED
    const now = this.now();
    const next = deriveStatus(
      submitted,
      rows.rows.map((x) => effectiveStatus({ status: x.status as TrustRequirementStatus, expiresAt: isoOrNull(x.expires_at) }, now)),
    );
    await sql`UPDATE trust.verification_cases SET status = ${next}, revision = revision + 1 WHERE verification_case_id = ${c.verificationCaseId}`.execute(trx);
    return next;
  }

  /**
   * Brings the instances of a case in line with policy: adds the required definitions the case does not hold, turns a NOT_REQUIRED one back on, and marks the ones policy no longer
   * asks for NOT_REQUIRED (unless they are approved or expired: an approval is history and stays). Returns the codes added and retired.
   */
  private async sync(
    trx: Trx,
    c: CaseRow,
    required: readonly RequiredDefinition[],
    instances: readonly InstanceRow[],
  ): Promise<{ added: string[]; retired: string[] }> {
    const added: string[] = [];
    const retired: string[] = [];
    const byDefinition = new Map(instances.map((i) => [i.requirementDefinitionId, i]));
    const requiredIds = new Set(required.map((r) => r.requirementDefinitionId));
    for (const r of required) {
      const current = byDefinition.get(r.requirementDefinitionId);
      if (!current) {
        await sql`INSERT INTO trust.case_requirements (verification_case_id, requirement_definition_id, cycle) VALUES (${c.verificationCaseId}, ${r.requirementDefinitionId}, 1)`.execute(
          trx,
        );
        added.push(r.code);
      } else if (current.status === 'NOT_REQUIRED') {
        await sql`UPDATE trust.case_requirements SET status = 'NOT_STARTED', revision = revision + 1 WHERE case_requirement_id = ${current.caseRequirementId}`.execute(
          trx,
        );
        added.push(r.code);
      }
    }
    for (const i of instances) {
      if (requiredIds.has(i.requirementDefinitionId)) continue;
      if (['NOT_STARTED', 'PENDING', 'IN_REVIEW', 'ACTION_REQUIRED', 'REJECTED'].includes(i.status)) {
        await sql`UPDATE trust.case_requirements SET status = 'NOT_REQUIRED', revision = revision + 1 WHERE case_requirement_id = ${i.caseRequirementId}`.execute(
          trx,
        );
        retired.push(i.requirementCode);
      } else if (i.status === 'EXPIRED') {
        // an expired approval of something policy no longer asks for is history, not an open obligation: it must not keep the case EXPIRED
        await sql`UPDATE trust.case_requirements SET superseded_at = now() WHERE case_requirement_id = ${i.caseRequirementId}`.execute(trx);
        retired.push(i.requirementCode);
      }
    }
    return { added, retired };
  }

  private async policyOf(): Promise<TrustDocumentPolicy> {
    return this.d.policy.documents();
  }

  private requireContext(ctx: ProviderContext | null): ProviderContext {
    if (!ctx || !ctx.accountActive) throw new TrustError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: 'ACCOUNT_NOT_ACTIVE' });
    if (!ctx.registrationLive || !ctx.contactsVerified)
      throw new TrustError('PREREQUISITE_NOT_MET', 'finish the provider registration and verify the email and phone first', {
        reason: ctx.registrationLive ? 'CONTACT_NOT_VERIFIED' : 'REGISTRATION_REQUIRED',
      });
    return ctx;
  }

  // ------------------------------------------------------------------ the provider's overview
  /** The provider's verification state (one batched read per concern, never one per requirement or document). Writes nothing. */
  async getVerification(accountId: string, opts: { context?: ProviderContext | null } = {}): Promise<ProviderVerificationView> {
    return this.read(async () => {
      const ctx = opts.context !== undefined ? opts.context : await this.d.context.context(accountId);
      if (!ctx) throw new TrustError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: 'ACCOUNT_NOT_FOUND' });
      return this.buildView(this.db, accountId, ctx);
    });
  }
  /** PRO-002: the requirement TYPE codes (a subset of `allowedTypes`) the provider currently holds as approved and unexpired; derived on every call, one statement, nothing else leaves. */
  publicBadgeTypes(accountId: string, allowedTypes: readonly TrustRequirementType[], now: Date = this.now()): Promise<TrustRequirementType[]> {
    return this.read(() => queryPublicBadgeTypes(this.db, accountId, allowedTypes, now));
  }
  private async buildView(ex: Executor, accountId: string, ctx: ProviderContext): Promise<ProviderVerificationView> {
    const [required, liveCase, documentTypes] = await Promise.all([
      this.resolveRequired(ex, ctx),
      this.liveCase(ex, accountId),
      this.documentTypesByRequirementType(ex),
    ]);
    const [instances, documents] = liveCase
      ? await Promise.all([this.currentInstances(ex, liveCase.verificationCaseId), this.caseDocuments(ex, liveCase.verificationCaseId)])
      : [[], []];
    const view = evaluateVerification({
      now: this.now(),
      required,
      case: liveCase,
      instances,
      // withdrawn and abandoned uploads are noise for the provider overview (the full list keeps them)
      documents: documents.filter((x) => x.status !== 'WITHDRAWN' && x.status !== 'ABANDONED').map((x) => ({ ...x, sha256: null })),
      documentTypes,
    });
    return { ...view, prerequisiteMet: ctx.accountActive && ctx.registrationLive && ctx.contactsVerified };
  }

  /** Every document of the provider's live case, newest last, including withdrawn and abandoned uploads (history). No hash, no key. */
  async listDocuments(accountId: string): Promise<DocumentView[]> {
    return this.read(async () => {
      const c = await this.liveCase(this.db, accountId);
      if (!c) return [];
      return (await this.caseDocuments(this.db, c.verificationCaseId)).map((x) => ({ ...x, sha256: null }));
    });
  }

  // ------------------------------------------------------------------ open / sync
  /**
   * Opens the verification case, or resumes the live one and brings it in line with policy (new requirements appear, retired ones are marked NOT_REQUIRED). Idempotent. Needs a live
   * provider registration and the configured contacts verified (PRD: identity verification starts only after email and phone are verified). When policy requires nothing, no case
   * is created.
   */
  async openVerification(accountId: string): Promise<{ created: boolean; view: ProviderVerificationView }> {
    const cid = getCorrelationId() ?? randomUUID();
    const actor = actorOf(accountId);
    const ctx = this.requireContext(await this.d.context.context(accountId));
    return this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const required = await this.resolveRequired(trx, ctx);
      let created = false;
      let live = await this.lockLiveCase(trx, accountId);
      if (!live && required.length > 0) {
        const n = (await sql<Row>`SELECT COALESCE(max(case_number), 0) + 1 AS n FROM trust.verification_cases WHERE account_id = ${accountId}`.execute(trx))
          .rows[0]!.n;
        const inserted = (
          await sql<Row>`INSERT INTO trust.verification_cases (account_id, case_number) VALUES (${accountId}, ${Number(n)}) RETURNING *`.execute(trx)
        ).rows[0]!;
        live = toCase(inserted);
        created = true;
        const { added } = await this.sync(trx, live, required, []);
        await this.audit(trx, cid, {
          actor,
          action: 'VERIFICATION_CASE_OPENED',
          caseId: live.verificationCaseId,
          changes: { caseNumber: live.caseNumber, requirements: added },
        });
        await this.event(trx, cid, TRUST_EVENTS.caseOpened, live.verificationCaseId, actor, this.casePayload(live, 'OPEN'));
      } else if (live) {
        const instances = await this.lockInstances(trx, live.verificationCaseId);
        const { added, retired } = await this.sync(trx, live, required, instances);
        if (added.length > 0 || retired.length > 0) {
          await this.recompute(trx, live, live.submittedAt !== null);
          await this.audit(trx, cid, { actor, action: 'VERIFICATION_REQUIREMENTS_SYNCED', caseId: live.verificationCaseId, changes: { added, retired } });
        }
      }
      return { created, view: await this.buildView(trx, accountId, ctx) };
    });
  }

  /** Withdraws a case that was never decided (OPEN, IN_REVIEW or ACTION_REQUIRED). The account, the registration and the history stay; a new case is the next number. */
  async cancelVerification(accountId: string): Promise<{ changed: boolean; view: ProviderVerificationView }> {
    const cid = getCorrelationId() ?? randomUUID();
    const actor = actorOf(accountId);
    const ctx = await this.d.context.context(accountId);
    if (!ctx) throw new TrustError('ACCOUNT_NOT_ACTIVE', 'the account is not active', { reason: 'ACCOUNT_NOT_FOUND' });
    return this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const live = await this.lockLiveCase(trx, accountId);
      if (!live) {
        const latest = (
          await sql<Row>`SELECT status FROM trust.verification_cases WHERE account_id = ${accountId} ORDER BY case_number DESC LIMIT 1`.execute(trx)
        ).rows[0];
        if (latest?.status === 'CANCELLED') return { changed: false, view: await this.buildView(trx, accountId, ctx) };
        throw new TrustError('NOT_FOUND', 'there is no verification to cancel');
      }
      const approved =
        await sql<Row>`SELECT 1 FROM trust.case_requirements WHERE verification_case_id = ${live.verificationCaseId} AND superseded_at IS NULL AND status = 'APPROVED' LIMIT 1`.execute(
          trx,
        );
      if (approved.rows.length > 0)
        throw new TrustError('INVALID_STATE', 'a verification that holds approvals cannot be cancelled', { reason: 'HAS_APPROVALS' });
      if (!['OPEN', 'IN_REVIEW', 'ACTION_REQUIRED'].includes(live.status))
        throw new TrustError('INVALID_STATE', 'this verification can no longer be cancelled', { reason: 'CASE_NOT_CANCELLABLE' });
      await sql`UPDATE trust.verification_cases SET status = 'CANCELLED', revision = revision + 1 WHERE verification_case_id = ${live.verificationCaseId}`.execute(
        trx,
      );
      await this.audit(trx, cid, {
        actor,
        action: 'VERIFICATION_CASE_CANCELLED',
        caseId: live.verificationCaseId,
        changes: { status: [live.status, 'CANCELLED'] },
      });
      return { changed: true, view: await this.buildView(trx, accountId, ctx) };
    });
  }

  // ------------------------------------------------------------------ evidence: upload authorization, finalize, withdraw
  /**
   * Authorizes ONE upload: validates the request against the configured policy and the requirement's state, records a document in UPLOAD_PENDING with a server-generated object key,
   * and returns a one-object, short-lived URL. The key, the URL and the bytes are never logged or audited. The caller uploads the file, then finalizes.
   */
  async requestUpload(accountId: string, input: unknown): Promise<UploadAuthorizationView> {
    const body = parseInput(RequestDocumentUploadRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const actor = actorOf(accountId);
    const policy = await this.policyOf();
    if (!policy.allowedMimeTypes.includes(body.mimeType))
      throw new TrustError('MIME_NOT_ALLOWED', 'that file type is not allowed', { reason: 'MIME_NOT_ALLOWED' });
    if (body.sizeBytes > policy.maxSizeBytes)
      throw new TrustError('FILE_TOO_LARGE', 'that file is too large', { reason: 'FILE_TOO_LARGE', max: policy.maxSizeBytes });
    const staleKeys: string[] = [];
    const authorization = await this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const live = await this.lockLiveCase(trx, accountId);
      if (!live) throw new TrustError('NOT_FOUND', 'there is no verification yet', { reason: 'NO_CASE' });
      const instance = (await this.lockInstances(trx, live.verificationCaseId)).find((i) => i.requirementCode === body.requirementCode);
      if (!instance || instance.status === 'NOT_REQUIRED')
        throw new TrustError('REQUIREMENT_NOT_APPLICABLE', 'that requirement does not apply to you', { reason: 'REQUIREMENT_NOT_APPLICABLE' });
      if (instance.evidenceKind !== 'DOCUMENT' || !(TRUST_EVIDENCE_OPEN_STATUSES as readonly string[]).includes(effectiveStatus(instance, this.now())))
        throw new TrustError('EVIDENCE_NOT_ACCEPTED', 'you cannot add documents to this requirement right now', { reason: 'EVIDENCE_NOT_ACCEPTED' });
      const type = (
        await sql<Row>`SELECT document_type_id, requirement_type, status FROM trust.document_types WHERE code = ${body.documentTypeCode}`.execute(trx)
      ).rows[0];
      if (!type || type.status !== 'ACTIVE' || type.requirement_type !== instance.requirementType)
        throw new TrustError('DOCUMENT_TYPE_NOT_ACCEPTED', 'that kind of document is not accepted for this requirement', {
          reason: 'DOCUMENT_TYPE_NOT_ACCEPTED',
        });
      // expired, never-finalized authorizations of this case are closed here (and their objects deleted after the commit), so abandoned uploads cannot pile up
      const expired = await sql<Row>`UPDATE trust.documents SET status = 'ABANDONED'
          WHERE status = 'UPLOAD_PENDING' AND upload_expires_at <= now()
            AND case_requirement_id IN (SELECT case_requirement_id FROM trust.case_requirements WHERE verification_case_id = ${live.verificationCaseId})
          RETURNING verification_document_id, object_key, case_requirement_id`.execute(trx);
      for (const x of expired.rows) {
        staleKeys.push(x.object_key as string);
        await this.audit(trx, cid, {
          actor,
          action: 'VERIFICATION_DOCUMENT_UPLOAD_REFUSED',
          caseId: live.verificationCaseId,
          requirementId: x.case_requirement_id as string,
          changes: { verificationDocumentId: x.verification_document_id, reason: 'UPLOAD_EXPIRED' },
        });
      }
      const drafts = Number(
        (
          await sql<Row>`SELECT count(*) AS n FROM trust.documents
            WHERE case_requirement_id = ${instance.caseRequirementId} AND (status = 'ATTACHED' OR (status = 'UPLOAD_PENDING' AND upload_expires_at > now()))`.execute(
            trx,
          )
        ).rows[0]!.n,
      );
      if (drafts >= policy.maxDocumentsPerRequirement)
        throw new TrustError('TOO_MANY_DOCUMENTS', 'you have added the most documents allowed for this requirement', {
          reason: 'TOO_MANY_DOCUMENTS',
          max: policy.maxDocumentsPerRequirement,
        });

      const documentId = randomUUID();
      const key = `trust/evidence/${live.verificationCaseId}/${documentId}`;
      const upload = await this.d.store.createUploadUrl({
        key: uploadKeyOf(key),
        contentType: body.mimeType,
        contentLength: body.sizeBytes,
        ttlSeconds: policy.uploadUrlTtlSeconds,
      });
      const inserted = (
        await sql<Row>`INSERT INTO trust.documents (verification_document_id, case_requirement_id, document_type_id, object_key, mime_type, size_bytes, upload_expires_at)
          VALUES (${documentId}, ${instance.caseRequirementId}, ${type.document_type_id as string}, ${key}, ${body.mimeType}, ${body.sizeBytes}, ${upload.expiresAt})
          RETURNING verification_document_id`.execute(trx)
      ).rows[0]!;
      await this.audit(trx, cid, {
        actor,
        action: 'VERIFICATION_DOCUMENT_UPLOAD_AUTHORIZED',
        caseId: live.verificationCaseId,
        requirementId: instance.caseRequirementId,
        changes: {
          verificationDocumentId: inserted.verification_document_id,
          documentType: body.documentTypeCode,
          sizeBytes: body.sizeBytes,
          mimeType: body.mimeType,
        },
      });
      const doc = await this.documentById(trx, documentId);
      return { document: { ...doc, sha256: null }, upload: { url: upload.url, headers: upload.headers, expiresAt: upload.expiresAt.toISOString() } };
    });
    await this.deleteObjects(staleKeys, 'expired');
    return authorization;
  }

  /** Deletes the final and the upload object of each key, best effort (a failure is logged by kind, never with a key). */
  private async deleteObjects(objectKeys: readonly string[], why: string): Promise<void> {
    for (const key of objectKeys)
      for (const k of [key, uploadKeyOf(key)])
        await this.d.store
          .delete(k)
          .catch((err: unknown) => log('warn', `could not delete a ${why} evidence object`, { error: err instanceof ObjectStoreError ? err.code : 'unknown' }));
  }

  private async documentById(ex: Executor, documentId: string): Promise<DocumentView> {
    const r = (await sql<Row>`${documentSelect} WHERE doc.verification_document_id = ${documentId}`.execute(ex)).rows[0];
    if (!r) throw new TrustError('NOT_FOUND', 'we could not find that');
    return toDocument(r);
  }
  /** The document and its owner, or NOT_FOUND (not found and not yours are indistinguishable). */
  private async ownedDocument(
    ex: Executor,
    accountId: string,
    documentId: string,
  ): Promise<{ doc: DocumentView; objectKey: string; caseId: string; uploadExpiresAt: Date; requirementId: string }> {
    const r = (
      await sql<Row>`SELECT doc.verification_document_id, doc.object_key, doc.upload_expires_at, c.verification_case_id, c.account_id, doc.case_requirement_id
        FROM trust.documents doc JOIN trust.case_requirements cr ON cr.case_requirement_id = doc.case_requirement_id
             JOIN trust.verification_cases c ON c.verification_case_id = cr.verification_case_id
        WHERE doc.verification_document_id = ${documentId}`.execute(ex)
    ).rows[0];
    if (!r || r.account_id !== accountId) throw new TrustError('NOT_FOUND', 'we could not find that');
    return {
      doc: await this.documentById(ex, documentId),
      objectKey: r.object_key as string,
      caseId: r.verification_case_id as string,
      uploadExpiresAt: r.upload_expires_at as Date,
      requirementId: r.case_requirement_id as string,
    };
  }

  /** Refuses an upload for good: the document becomes ABANDONED (with the scan verdict when that was the reason), the object is deleted, and the refusal is audited by reason code. */
  private async abandon(accountId: string, documentId: string, reason: string, scan?: TrustScanStatus): Promise<void> {
    const cid = getCorrelationId() ?? randomUUID();
    let key: string | null = null;
    await this.tx(async (trx) => {
      const o = await this.ownedDocument(trx, accountId, documentId);
      await sql`SELECT verification_case_id FROM trust.verification_cases WHERE verification_case_id = ${o.caseId} FOR UPDATE`.execute(trx);
      const fresh = await this.documentById(trx, documentId);
      if (fresh.status !== 'UPLOAD_PENDING') return;
      await sql`UPDATE trust.documents SET status = 'ABANDONED', scan_status = ${scan ?? fresh.scanStatus} WHERE verification_document_id = ${documentId}`.execute(
        trx,
      );
      await this.audit(trx, cid, {
        actor: actorOf(accountId),
        action: 'VERIFICATION_DOCUMENT_UPLOAD_REFUSED',
        caseId: o.caseId,
        requirementId: o.requirementId,
        changes: { verificationDocumentId: documentId, reason },
      });
      key = o.objectKey;
    });
    if (key) await this.deleteObjects([key], 'refused');
  }

  /**
   * Finalizes an upload: the SERVER verifies the stored object (it exists, its size and content type are the authorized ones, its first bytes are the signature of that content type,
   * the SHA-256 it computes from the bytes equals the client's when the client gave one) and scans it; only then the document is ATTACHED. A mismatch or an infected file abandons
   * the document and deletes the object. With clean scans required and no working scanner the document stays UPLOAD_PENDING (fail closed) and the call can be repeated. Idempotent.
   * Object-store and scanner I/O happens before the transaction.
   */
  async finalizeDocument(accountId: string, documentId: string, input: unknown = {}): Promise<DocumentView> {
    const body = parseInput(FinalizeDocumentRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const owned = await this.read(() => this.ownedDocument(this.db, accountId, documentId));
    if (owned.doc.status === 'ATTACHED' || owned.doc.status === 'SUBMITTED') return { ...owned.doc, sha256: null };
    if (owned.doc.status !== 'UPLOAD_PENDING')
      throw new TrustError('INVALID_STATE', 'that document can no longer be finalized', { reason: 'DOCUMENT_NOT_PENDING' });
    if (owned.uploadExpiresAt.getTime() <= this.now().getTime()) {
      await this.abandon(accountId, documentId, 'UPLOAD_EXPIRED');
      throw new TrustError('UPLOAD_EXPIRED', 'the upload took too long', { reason: 'UPLOAD_EXPIRED' });
    }
    const policy = await this.policyOf();
    // the policy may have changed since the authorization: a type no longer allowed is refused
    if (!policy.allowedMimeTypes.includes(owned.doc.mimeType)) {
      await this.abandon(accountId, documentId, 'MIME_NOT_ALLOWED');
      throw new TrustError('MIME_NOT_ALLOWED', 'that file type is not allowed', { reason: 'MIME_NOT_ALLOWED' });
    }
    const uploadKey = uploadKeyOf(owned.objectKey);
    const mismatch = async (reason: string): Promise<never> => {
      await this.abandon(accountId, documentId, reason);
      throw new TrustError('OBJECT_MISMATCH', 'the file did not match what was described', { reason });
    };
    let info;
    let read: { bytes: Buffer; version: string } | null;
    try {
      info = await this.d.store.head(uploadKey);
      if (info === null) throw new TrustError('OBJECT_MISSING', 'we did not receive your file', { reason: 'OBJECT_MISSING' });
      if (info.size !== owned.doc.sizeBytes || info.size > policy.maxSizeBytes) return await mismatch('SIZE_MISMATCH');
      if (mimeOf(info.contentType) !== owned.doc.mimeType) return await mismatch('CONTENT_TYPE_MISMATCH');
      read = await this.d.store.readVersioned(uploadKey, owned.doc.sizeBytes);
    } catch (err) {
      if (err instanceof TrustError) throw err;
      if (err instanceof ObjectStoreError && err.code === 'TOO_LARGE') return mismatch('SIZE_MISMATCH');
      if (err instanceof ObjectStoreError && err.code === 'CHANGED') return mismatch('OBJECT_CHANGED');
      log('error', 'evidence object store unavailable', { error: err instanceof Error ? err.name : 'unknown' });
      throw new TrustError('UNAVAILABLE', 'verification is unavailable');
    }
    if (read === null) throw new TrustError('OBJECT_MISSING', 'we did not receive your file', { reason: 'OBJECT_MISSING' });
    const { bytes } = read;
    if (bytes.byteLength !== owned.doc.sizeBytes) return mismatch('SIZE_MISMATCH');
    if (!matchesSignature(owned.doc.mimeType, bytes)) return mismatch('SIGNATURE_MISMATCH');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (body.sha256 !== undefined && body.sha256 !== sha256) return mismatch('HASH_MISMATCH');

    let scanned: Exclude<TrustScanStatus, 'PENDING'>;
    try {
      scanned = (await this.scanner.scan({ key: owned.objectKey, size: bytes.byteLength, bytes })).status;
    } catch {
      scanned = 'ERROR';
    }
    if (scanned === 'INFECTED') {
      await this.abandon(accountId, documentId, 'SCAN_INFECTED', 'INFECTED');
      throw new TrustError('SCAN_INFECTED', 'the file was rejected by the safety check', { reason: 'SCAN_INFECTED' });
    }
    if (scanned === 'ERROR' && policy.requireCleanScan)
      throw new TrustError('SCAN_UNAVAILABLE', 'we could not check your file right now', { reason: 'SCAN_UNAVAILABLE' });

    // PROMOTE: copy exactly the bytes that were hashed and scanned to the final key (only while the upload object still has the version that was read), check what landed there, and
    // stop reading the upload key. The provider's presigned PUT may still be valid, but it can only ever write an object nothing reads again.
    try {
      await this.d.store.copyIfVersion(uploadKey, owned.objectKey, read.version);
      const landed = await this.d.store.read(owned.objectKey, owned.doc.sizeBytes);
      if (landed === null || !createHash('sha256').update(landed).digest().equals(Buffer.from(sha256, 'hex'))) return await mismatch('OBJECT_CHANGED');
    } catch (err) {
      if (err instanceof TrustError) throw err;
      if (err instanceof ObjectStoreError && err.code === 'CHANGED') return mismatch('OBJECT_CHANGED');
      log('error', 'evidence object store unavailable', { error: err instanceof Error ? err.name : 'unknown' });
      throw new TrustError('UNAVAILABLE', 'verification is unavailable');
    }

    const attached = await this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const o = await this.ownedDocument(trx, accountId, documentId);
      await sql`SELECT verification_case_id FROM trust.verification_cases WHERE verification_case_id = ${o.caseId} AND status <> 'CANCELLED' FOR UPDATE`.execute(
        trx,
      );
      const doc = await this.documentById(trx, documentId);
      if (doc.status === 'ATTACHED' || doc.status === 'SUBMITTED') return { ...doc, sha256: null };
      if (doc.status !== 'UPLOAD_PENDING')
        throw new TrustError('INVALID_STATE', 'that document can no longer be finalized', { reason: 'DOCUMENT_NOT_PENDING' });
      const instance = (
        await sql<Row>`SELECT status, superseded_at FROM trust.case_requirements WHERE case_requirement_id = ${o.requirementId} FOR UPDATE`.execute(trx)
      ).rows[0]!;
      if (instance.superseded_at !== null || !(TRUST_EVIDENCE_OPEN_STATUSES as readonly string[]).includes(instance.status as string))
        throw new TrustError('INVALID_STATE', 'you cannot add documents to this requirement right now', { reason: 'DOCUMENT_REQUIREMENT_STATE' });
      await sql`UPDATE trust.documents SET status = 'ATTACHED', sha256 = ${sha256}, scan_status = ${scanned} WHERE verification_document_id = ${documentId}`.execute(
        trx,
      );
      await sql`UPDATE trust.verification_cases SET revision = revision + 1 WHERE verification_case_id = ${o.caseId}`.execute(trx);
      await this.audit(trx, cid, {
        actor: actorOf(accountId),
        action: 'VERIFICATION_DOCUMENT_SUBMITTED',
        caseId: o.caseId,
        requirementId: o.requirementId,
        changes: { verificationDocumentId: documentId, scanStatus: scanned, sizeBytes: doc.sizeBytes },
      });
      return { ...(await this.documentById(trx, documentId)), sha256: null };
    }).catch(async (err: unknown) => {
      // the state changed while the bytes were being checked (withdrawn, cancelled ...): nothing will use the promoted copy
      // only the promoted copy goes: the upload object stays, so a later finalize can promote it again
      await this.d.store
        .delete(owned.objectKey)
        .catch((e: unknown) => log('warn', 'could not delete an unused evidence object', { error: e instanceof ObjectStoreError ? e.code : 'unknown' }));
      throw err;
    });
    await this.d.store
      .delete(uploadKey)
      .catch((err: unknown) => log('warn', 'could not delete an upload evidence object', { error: err instanceof ObjectStoreError ? err.code : 'unknown' }));
    return attached;
  }

  /** Removes a DRAFT document (UPLOAD_PENDING or ATTACHED) before it is submitted; a submitted document is history and cannot be removed. The stored object is deleted. */
  async withdrawDocument(accountId: string, documentId: string): Promise<DocumentView> {
    const cid = getCorrelationId() ?? randomUUID();
    let key: string | null = null;
    const result = await this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const o = await this.ownedDocument(trx, accountId, documentId);
      await sql`SELECT verification_case_id FROM trust.verification_cases WHERE verification_case_id = ${o.caseId} FOR UPDATE`.execute(trx);
      const doc = await this.documentById(trx, documentId);
      if (doc.status === 'WITHDRAWN' || doc.status === 'ABANDONED') return { ...doc, sha256: null };
      if (doc.status === 'SUBMITTED') throw new TrustError('INVALID_STATE', 'a submitted document cannot be removed', { reason: 'DOCUMENT_SUBMITTED' });
      if (doc.status === 'UPLOAD_PENDING')
        await sql`UPDATE trust.documents SET status = 'ABANDONED' WHERE verification_document_id = ${documentId}`.execute(trx);
      else await sql`UPDATE trust.documents SET status = 'WITHDRAWN' WHERE verification_document_id = ${documentId}`.execute(trx);
      await sql`UPDATE trust.verification_cases SET revision = revision + 1 WHERE verification_case_id = ${o.caseId} AND status <> 'CANCELLED'`.execute(trx);
      await this.audit(trx, cid, {
        actor: actorOf(accountId),
        action: 'VERIFICATION_DOCUMENT_REPLACED',
        caseId: o.caseId,
        requirementId: o.requirementId,
        changes: { verificationDocumentId: documentId },
      });
      key = o.objectKey;
      return { ...(await this.documentById(trx, documentId)), sha256: null };
    });
    if (key) await this.deleteObjects([key], 'withdrawn');
    return result;
  }

  // ------------------------------------------------------------------ submit
  /**
   * Submits the evidence for review: every requirement that waits for the provider (no evidence yet, action required, rejected) needs at least one finalized, clean document; they
   * all move to PENDING together in a new round and their documents become SUBMITTED (frozen). Policy is re-resolved under the lock, so a requirement that appeared meanwhile is
   * asked for here, not skipped. Idempotent: with nothing to submit nothing changes. A stale revision is refused.
   */
  async submitVerification(accountId: string, input: unknown): Promise<{ changed: boolean; view: ProviderVerificationView }> {
    const body = parseInput(SubmitVerificationRequest, input);
    const cid = getCorrelationId() ?? randomUUID();
    const actor = actorOf(accountId);
    const policy = await this.policyOf();
    const ctx = this.requireContext(await this.d.context.context(accountId));
    return this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const live = await this.lockLiveCase(trx, accountId);
      if (!live) throw new TrustError('NOT_FOUND', 'there is no verification yet', { reason: 'NO_CASE' });
      const required = await this.resolveRequired(trx, ctx);
      const instances = await this.lockInstances(trx, live.verificationCaseId);
      const targetsBefore = instances.filter((i) => (TRUST_EVIDENCE_OPEN_STATUSES as readonly string[]).includes(effectiveStatus(i, this.now())));
      const requiredCodes = new Set(required.map((r) => r.code));
      const missingFromCase = required.filter(
        (r) => !instances.some((i) => i.requirementDefinitionId === r.requirementDefinitionId && i.status !== 'NOT_REQUIRED'),
      );
      if (targetsBefore.filter((i) => requiredCodes.has(i.requirementCode)).length === 0 && missingFromCase.length === 0)
        return { changed: false, view: await this.buildView(trx, accountId, ctx) };
      if (body.expectedRevision !== live.revision)
        throw new TrustError('STALE_CASE', 'the verification changed since it was read: read it again', { reason: 'STALE_CASE' });

      const { added } = await this.sync(trx, live, required, instances);
      const current = added.length > 0 ? await this.lockInstances(trx, live.verificationCaseId) : instances;
      const targets = current.filter(
        (i) => requiredCodes.has(i.requirementCode) && (TRUST_EVIDENCE_OPEN_STATUSES as readonly string[]).includes(effectiveStatus(i, this.now())),
      );
      const drafts = new Map<string, DocumentView[]>();
      if (targets.length > 0) {
        const rows =
          await sql<Row>`${documentSelect} WHERE doc.case_requirement_id = ANY(${targets.map((t) => t.caseRequirementId)}::uuid[]) AND doc.status = 'ATTACHED' ORDER BY doc.created_at`.execute(
            trx,
          );
        for (const r of rows.rows) {
          const d = toDocument(r);
          drafts.set(d.caseRequirementId, [...(drafts.get(d.caseRequirementId) ?? []), d]);
        }
      }
      const incomplete = targets.filter((t) => {
        if (t.evidenceKind !== 'DOCUMENT') return true;
        const ds = drafts.get(t.caseRequirementId) ?? [];
        return ds.length === 0 || (policy.requireCleanScan && ds.some((x) => x.scanStatus !== 'CLEAN'));
      });
      if (incomplete.length > 0) {
        const codes = incomplete.map((t) => t.requirementCode);
        throw new TrustError('SUBMISSION_INCOMPLETE', 'add a document for every requirement that needs one first', { reason: 'SUBMISSION_INCOMPLETE', codes });
      }
      for (const t of targets) {
        await sql`UPDATE trust.case_requirements SET status = 'PENDING', round = round + 1, revision = revision + 1 WHERE case_requirement_id = ${t.caseRequirementId}`.execute(
          trx,
        );
        const round = t.round + 1;
        await sql`UPDATE trust.documents SET status = 'SUBMITTED', round = ${round} WHERE case_requirement_id = ${t.caseRequirementId} AND status = 'ATTACHED'`.execute(
          trx,
        );
      }
      const status = await this.recompute(trx, live, true);
      await this.audit(trx, cid, {
        actor,
        action: 'VERIFICATION_SUBMITTED',
        caseId: live.verificationCaseId,
        changes: {
          requirements: targets.map((t) => t.requirementCode),
          status: [live.status, status],
          documents: [...drafts.values()].reduce((n, x) => n + x.length, 0),
        },
      });
      await this.event(trx, cid, TRUST_EVENTS.submitted, live.verificationCaseId, actor, this.casePayload(live, status));
      return { changed: true, view: await this.buildView(trx, accountId, ctx) };
    });
  }

  // ------------------------------------------------------------------ re-verification
  /**
   * Starts a NEW cycle of a requirement whose approval ended: the expired instance (and its approval) stays as history, superseded by cycle + 1 in the same case. Needs the
   * requirement to still be required. Idempotent in effect: once the new cycle exists, the requirement is no longer EXPIRED and the call is refused as NOT_REVERIFIABLE.
   */
  async reverifyRequirement(accountId: string, requirementCode: string): Promise<ProviderVerificationView> {
    const cid = getCorrelationId() ?? randomUUID();
    const actor = actorOf(accountId);
    const ctx = this.requireContext(await this.d.context.context(accountId));
    return this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const live = await this.lockLiveCase(trx, accountId);
      if (!live) throw new TrustError('NOT_FOUND', 'there is no verification yet', { reason: 'NO_CASE' });
      const instances = await this.lockInstances(trx, live.verificationCaseId);
      const current = instances.find((i) => i.requirementCode === requirementCode);
      const required = await this.resolveRequired(trx, ctx);
      if (!current || !required.some((r) => r.code === requirementCode) || effectiveStatus(current, this.now()) !== 'EXPIRED')
        throw new TrustError('NOT_REVERIFIABLE', 'this requirement cannot be verified again yet', { reason: 'NOT_EXPIRED' });
      if (current.status === 'APPROVED') {
        // the approval ended but the sweep has not recorded it yet: record it here, in the same transaction
        // the DATABASE clock decides (the application clock may be ahead): an approval that has not ended there is not re-verifiable yet
        const flipped = await sql<Row>`UPDATE trust.case_requirements SET status = 'EXPIRED', revision = revision + 1
          WHERE case_requirement_id = ${current.caseRequirementId} AND status = 'APPROVED' AND expires_at <= clock_timestamp() RETURNING 1`.execute(trx);
        if (flipped.rows.length === 0) throw new TrustError('NOT_REVERIFIABLE', 'this requirement cannot be verified again yet', { reason: 'NOT_EXPIRED' });
        await this.audit(trx, cid, {
          actor,
          action: 'VERIFICATION_EXPIRED',
          caseId: live.verificationCaseId,
          requirementId: current.caseRequirementId,
          changes: { requirement: current.requirementCode },
        });
        await this.event(trx, cid, TRUST_EVENTS.expired, live.verificationCaseId, actor, this.requirementPayload(live, current, 'EXPIRED', null, 'EXPIRED'));
      }
      await sql`UPDATE trust.case_requirements SET superseded_at = now() WHERE case_requirement_id = ${current.caseRequirementId}`.execute(trx);
      await sql`INSERT INTO trust.case_requirements (verification_case_id, requirement_definition_id, cycle) VALUES (${live.verificationCaseId}, ${current.requirementDefinitionId}, ${current.cycle + 1})`.execute(
        trx,
      );
      const status = await this.recompute(trx, live, live.submittedAt !== null);
      await this.audit(trx, cid, {
        actor,
        action: 'VERIFICATION_REVERIFICATION_REQUESTED',
        caseId: live.verificationCaseId,
        requirementId: current.caseRequirementId,
        changes: { requirement: current.requirementCode, cycle: [current.cycle, current.cycle + 1], status: [live.status, status] },
      });
      return this.buildView(trx, accountId, ctx);
    });
  }

  private requirementPayload(
    c: Pick<CaseRow, 'verificationCaseId' | 'accountId' | 'caseNumber'>,
    i: Pick<InstanceRow, 'caseRequirementId' | 'requirementCode' | 'requirementType'>,
    caseStatus: TrustCaseStatus,
    reasonCode: string | null,
    requirementStatus: TrustRequirementStatus,
  ): TrustRequirementEventPayload {
    return {
      ...this.casePayload(c, caseStatus),
      caseRequirementId: i.caseRequirementId,
      requirementCode: i.requirementCode,
      requirementType: i.requirementType,
      requirementStatus,
      reasonCode,
    };
  }

  // ------------------------------------------------------------------ review (staff)
  /** Locks a requirement for a staff action: the CASE first (the serialization point of every case operation), then the instance. Refuses a cancelled case and a superseded cycle. */
  private async lockForReview(trx: Trx, caseRequirementId: string): Promise<{ c: CaseRow; i: InstanceRow }> {
    const head = (await sql<Row>`SELECT verification_case_id FROM trust.case_requirements WHERE case_requirement_id = ${caseRequirementId}`.execute(trx))
      .rows[0];
    if (!head) throw new TrustError('NOT_FOUND', 'we could not find that');
    const c = toCase(
      (await sql<Row>`SELECT * FROM trust.verification_cases WHERE verification_case_id = ${head.verification_case_id as string} FOR UPDATE`.execute(trx))
        .rows[0]!,
    );
    if (c.status === 'CANCELLED') throw new TrustError('INVALID_STATE', 'this verification was cancelled', { reason: 'CASE_FROZEN' });
    const i = toInstance((await sql<Row>`${instanceSelect} WHERE cr.case_requirement_id = ${caseRequirementId} FOR UPDATE OF cr`.execute(trx)).rows[0]!);
    if (i.supersededAt !== null) throw new TrustError('INVALID_STATE', 'a newer cycle replaced this requirement', { reason: 'SUPERSEDED_FROZEN' });
    return { c, i };
  }
  private reviewActor(subject: string): string {
    if (!/^[A-Za-z0-9._:@-]{1,160}$/.test(subject))
      throw new TrustError('VALIDATION_FAILED', 'the reviewer identity is not valid', { reason: 'REVIEWER_INVALID' });
    return `admin:${subject}`;
  }

  /** Starts the review of a submitted requirement (PENDING -> IN_REVIEW) for the named round. Idempotent for a review already started in that round. */
  async startReview(reviewerSubject: string, caseRequirementId: string, input: unknown): Promise<DecisionResult> {
    const body = parseInput(StartReviewRequest, input);
    const actor = this.reviewActor(reviewerSubject);
    const cid = getCorrelationId() ?? randomUUID();
    return this.tx(async (trx) => {
      const { c, i } = await this.lockForReview(trx, caseRequirementId);
      if (i.round !== body.round) throw new TrustError('STALE_ROUND', 'the provider changed this evidence since it was read', { reason: 'STALE_ROUND' });
      if (i.status === 'IN_REVIEW') return this.decisionResult(trx, caseRequirementId, c.status, false);
      if (i.status !== 'PENDING')
        throw new TrustError(
          ['APPROVED', 'REJECTED', 'ACTION_REQUIRED'].includes(i.status) ? 'ALREADY_DECIDED' : 'INVALID_STATE',
          'this evidence is not waiting for review',
          { reason: 'NOT_PENDING' },
        );
      await sql`UPDATE trust.case_requirements SET status = 'IN_REVIEW', revision = revision + 1 WHERE case_requirement_id = ${caseRequirementId}`.execute(trx);
      await sql`INSERT INTO trust.reviews (case_requirement_id, round, decision, reviewer, correlation_id) VALUES (${caseRequirementId}, ${i.round}, 'STARTED', ${actor}, ${cid})`.execute(
        trx,
      );
      const status = await this.recompute(trx, c, true);
      await this.audit(trx, cid, {
        actor,
        action: 'VERIFICATION_REVIEW_STARTED',
        caseId: c.verificationCaseId,
        requirementId: caseRequirementId,
        changes: { requirement: i.requirementCode, round: i.round },
      });
      return this.decisionResult(trx, caseRequirementId, status, true);
    });
  }

  /** Approves the evidence of the named round. `expiresAt` is required when the definition says approvals expire (the reviewer takes it from the evidence). */
  async approveRequirement(reviewerSubject: string, caseRequirementId: string, input: unknown): Promise<DecisionResult> {
    const body = parseInput(ApproveRequirementRequest, input);
    return this.decide(reviewerSubject, caseRequirementId, 'APPROVED', { round: body.round, expiresAt: body.expiresAt });
  }
  /** Refuses the evidence of the named round with a structured reason; the provider may resubmit (PR-02.03). */
  async rejectRequirement(reviewerSubject: string, caseRequirementId: string, input: unknown): Promise<DecisionResult> {
    const body = parseInput(RejectRequirementRequest, input);
    return this.decide(reviewerSubject, caseRequirementId, 'REJECTED', { round: body.round, reasonCode: body.reasonCode });
  }
  /** Asks the provider for more (a structured reason); the provider resubmits. */
  async requestAction(reviewerSubject: string, caseRequirementId: string, input: unknown): Promise<DecisionResult> {
    const body = parseInput(RequestActionRequest, input);
    return this.decide(reviewerSubject, caseRequirementId, 'ACTION_REQUIRED', { round: body.round, reasonCode: body.reasonCode });
  }

  private async decide(
    reviewerSubject: string,
    caseRequirementId: string,
    decision: Exclude<TrustReviewDecision, 'STARTED'>,
    body: { round: number; reasonCode?: string; expiresAt?: string },
  ): Promise<DecisionResult> {
    const actor = this.reviewActor(reviewerSubject);
    const cid = getCorrelationId() ?? randomUUID();
    const policy = await this.policyOf();
    return this.tx(async (trx) => {
      const { c, i } = await this.lockForReview(trx, caseRequirementId);
      // a provider resubmission makes a decision on the earlier round stale: nobody approves evidence they did not see
      if (body.round !== i.round) throw new TrustError('STALE_ROUND', 'the provider changed this evidence since it was read', { reason: 'STALE_ROUND' });
      const existing = (
        await sql<Row>`SELECT decision, reason_code, expires_at FROM trust.reviews WHERE case_requirement_id = ${caseRequirementId} AND round = ${i.round} AND decision <> 'STARTED'`.execute(
          trx,
        )
      ).rows[0];
      if (existing) {
        const sameEnd =
          body.expiresAt === undefined || (existing.expires_at !== null && new Date(body.expiresAt).getTime() === (existing.expires_at as Date).getTime());
        if (existing.decision === decision && (existing.reason_code ?? null) === (body.reasonCode ?? null) && sameEnd)
          return this.decisionResult(trx, caseRequirementId, c.status, false);
        throw new TrustError('ALREADY_DECIDED', 'this evidence was already decided', { reason: 'ALREADY_DECIDED' });
      }
      if (i.status !== 'PENDING' && i.status !== 'IN_REVIEW')
        throw new TrustError('INVALID_STATE', 'this evidence is not waiting for review', { reason: 'NOT_PENDING' });
      if (i.evidenceKind === 'EXTERNAL' && decision === 'APPROVED') {
        // an externally evidenced requirement is approved on the external provider's word: staff can complete it (an end date, say) but not invent it
        const ext = (
          await sql<Row>`SELECT status FROM trust.external_verifications WHERE case_requirement_id = ${caseRequirementId} AND round = ${i.round}`.execute(trx)
        ).rows[0];
        if (ext?.status !== 'APPROVED')
          throw new TrustError('INVALID_STATE', 'the external verification has not approved this requirement', { reason: 'EXTERNAL_NOT_APPROVED' });
      }
      if (i.evidenceKind === 'DOCUMENT') {
        const docs = (
          await sql<Row>`${documentSelect} WHERE doc.case_requirement_id = ${caseRequirementId} AND doc.status = 'SUBMITTED' AND doc.round = ${i.round}`.execute(
            trx,
          )
        ).rows.map(toDocument);
        if (docs.length === 0) throw new TrustError('INVALID_STATE', 'there is no submitted evidence to decide on', { reason: 'NO_EVIDENCE' });
        if (policy.requireCleanScan && docs.some((x) => x.scanStatus !== 'CLEAN'))
          throw new TrustError('SCAN_UNAVAILABLE', 'the evidence has not passed the safety check', { reason: 'SCAN_NOT_CLEAN' });
        if (docs.some((x) => x.scanStatus === 'INFECTED'))
          throw new TrustError('SCAN_INFECTED', 'the evidence was rejected by the safety check', { reason: 'SCAN_INFECTED' });
      }
      let expiresAt: Date | null = null;
      if (decision === 'APPROVED') {
        if (body.expiresAt !== undefined) {
          expiresAt = new Date(body.expiresAt);
          const now = this.now().getTime();
          if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now || expiresAt.getTime() > now + MAX_VALIDITY_DAYS * 86_400_000)
            throw new TrustError('VALIDATION_FAILED', 'the approval needs a valid end date', { field: 'expiresAt', reason: 'EXPIRY_INVALID' });
        } else if (i.expiryRequired) {
          throw new TrustError('VALIDATION_FAILED', 'the approval needs a valid end date', { field: 'expiresAt', reason: 'EXPIRY_REQUIRED' });
        }
      }
      await sql`UPDATE trust.case_requirements SET status = ${decision}, expires_at = ${expiresAt}, revision = revision + 1 WHERE case_requirement_id = ${caseRequirementId}`.execute(
        trx,
      );
      await sql`INSERT INTO trust.reviews (case_requirement_id, round, decision, reason_code, reviewer, expires_at, correlation_id)
        VALUES (${caseRequirementId}, ${i.round}, ${decision}, ${body.reasonCode ?? null}, ${actor}, ${expiresAt}, ${cid})`.execute(trx);
      const status = await this.recompute(trx, c, true);
      const action = decision === 'APPROVED' ? 'VERIFICATION_APPROVED' : decision === 'REJECTED' ? 'VERIFICATION_REJECTED' : 'VERIFICATION_ACTION_REQUIRED';
      await this.audit(trx, cid, {
        actor,
        action,
        caseId: c.verificationCaseId,
        requirementId: caseRequirementId,
        reasonCode: body.reasonCode ?? null,
        changes: {
          requirement: i.requirementCode,
          round: i.round,
          caseStatus: [c.status, status],
          ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
        },
      });
      const eventType =
        decision === 'APPROVED' ? TRUST_EVENTS.requirementApproved : decision === 'REJECTED' ? TRUST_EVENTS.requirementRejected : TRUST_EVENTS.actionRequired;
      await this.event(trx, cid, eventType, c.verificationCaseId, actor, this.requirementPayload(c, i, status, body.reasonCode ?? null, decision));
      if (status === 'APPROVED' && c.status !== 'APPROVED')
        await this.event(trx, cid, TRUST_EVENTS.completed, c.verificationCaseId, actor, this.casePayload(c, 'APPROVED'));
      return this.decisionResult(trx, caseRequirementId, status, true);
    });
  }

  /**
   * A short-lived download link for ONE document, for staff only. The access is audited BEFORE the link is created (no link without a record), the document must be finalized and
   * (when clean scans are required) CLEAN, and the link is an attachment with a policy lifetime. Nothing about the link is stored or logged.
   */
  async downloadDocument(reviewerSubject: string, documentId: string): Promise<{ url: string; expiresAt: string }> {
    const actor = this.reviewActor(reviewerSubject);
    const cid = getCorrelationId() ?? randomUUID();
    const policy = await this.policyOf();
    const row = await this.read(
      async () =>
        (
          await sql<Row>`SELECT doc.object_key, doc.mime_type, doc.status, doc.scan_status, doc.case_requirement_id, cr.verification_case_id, c.status AS case_status
          FROM trust.documents doc JOIN trust.case_requirements cr ON cr.case_requirement_id = doc.case_requirement_id
               JOIN trust.verification_cases c ON c.verification_case_id = cr.verification_case_id WHERE doc.verification_document_id = ${documentId}`.execute(
            this.db,
          )
        ).rows[0],
    );
    if (!row) throw new TrustError('NOT_FOUND', 'we could not find that');
    // reviewers see what the provider SUBMITTED, in a case that was not withdrawn: a draft is not evidence yet
    if (row.status !== 'SUBMITTED' || row.case_status === 'CANCELLED')
      throw new TrustError('INVALID_STATE', 'that document cannot be downloaded', { reason: 'DOCUMENT_NOT_AVAILABLE' });
    if (row.scan_status === 'INFECTED') throw new TrustError('SCAN_INFECTED', 'the document was rejected by the safety check', { reason: 'SCAN_INFECTED' });
    if (policy.requireCleanScan && row.scan_status !== 'CLEAN')
      throw new TrustError('SCAN_UNAVAILABLE', 'the document has not passed the safety check', { reason: 'SCAN_NOT_CLEAN' });
    await this.tx((trx) =>
      this.audit(trx, cid, {
        actor,
        action: 'VERIFICATION_DOCUMENT_ACCESSED',
        caseId: row.verification_case_id as string,
        requirementId: row.case_requirement_id as string,
        changes: { verificationDocumentId: documentId },
      }),
    );
    try {
      const link = await this.d.store.createDownloadUrl({
        key: row.object_key as string,
        ttlSeconds: policy.downloadUrlTtlSeconds,
        contentType: row.mime_type as string,
      });
      return { url: link.url, expiresAt: link.expiresAt.toISOString() };
    } catch (err) {
      log('error', 'evidence download link failed', { error: err instanceof Error ? err.name : 'unknown' });
      throw new TrustError('UNAVAILABLE', 'verification is unavailable');
    }
  }

  // ------------------------------------------------------------------ staff reads
  private async adminRequirements(ex: Executor, caseId: string, onlyCurrent: boolean): Promise<AdminRequirementView[]> {
    const instances = (
      await sql<Row>`${instanceSelect} WHERE cr.verification_case_id = ${caseId} ${onlyCurrent ? sql`AND cr.superseded_at IS NULL` : sql``} ORDER BY d.code COLLATE "C", cr.cycle`.execute(
        ex,
      )
    ).rows.map(toInstance);
    if (instances.length === 0) return [];
    const ids = instances.map((i) => i.caseRequirementId);
    const [reviews, documents, externals] = await Promise.all([
      sql<Row>`SELECT * FROM trust.reviews WHERE case_requirement_id = ANY(${ids}::uuid[]) ORDER BY reviewed_at, review_id`.execute(ex),
      sql<Row>`${documentSelect} WHERE doc.case_requirement_id = ANY(${ids}::uuid[]) ORDER BY doc.created_at, doc.verification_document_id`.execute(ex),
      sql<Row>`SELECT case_requirement_id, adapter, status, last_checked_at FROM trust.external_verifications WHERE case_requirement_id = ANY(${ids}::uuid[]) ORDER BY round`.execute(
        ex,
      ),
    ]);
    return instances.map((i) => {
      const ext = externals.rows.filter((e) => e.case_requirement_id === i.caseRequirementId).pop();
      return {
        caseRequirementId: i.caseRequirementId,
        requirementCode: i.requirementCode,
        requirementType: i.requirementType,
        evidenceKind: i.evidenceKind,
        status: i.status,
        cycle: i.cycle,
        round: i.round,
        approvedAt: i.approvedAt,
        expiresAt: i.expiresAt,
        superseded: i.supersededAt !== null,
        reviews: reviews.rows.filter((r) => r.case_requirement_id === i.caseRequirementId).map(toReview),
        documents: documents.rows.filter((r) => r.case_requirement_id === i.caseRequirementId).map(toDocument),
        external: ext
          ? {
              adapter: ext.adapter as string,
              status: ext.status as TrustExternalStatus,
              lastCheckedAt: isoOrNull(ext.last_checked_at),
            }
          : null,
      };
    });
  }
  private async decisionResult(ex: Executor, caseRequirementId: string, caseStatus: TrustCaseStatus, changed: boolean): Promise<DecisionResult> {
    const head = (await sql<Row>`SELECT verification_case_id FROM trust.case_requirements WHERE case_requirement_id = ${caseRequirementId}`.execute(ex))
      .rows[0]!;
    const all = await this.adminRequirements(ex, head.verification_case_id as string, false);
    const requirement = all.find((r) => r.caseRequirementId === caseRequirementId)!;
    return { requirement, caseStatus, changed };
  }

  /** The cases for the reviewers' queue (no names, no contacts): oldest submission first (a work queue, in the order of the reviewers' index), optionally one status, at most `limit` (default 50, max 100). */
  async listCases(opts: { status?: TrustCaseStatus; limit?: number } = {}): Promise<CaseSummaryView[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    return this.read(async () => {
      const r = await sql<Row>`SELECT c.verification_case_id, c.account_id, c.case_number, c.status, c.submitted_at, c.updated_at,
          (SELECT count(*) FROM trust.case_requirements cr WHERE cr.verification_case_id = c.verification_case_id AND cr.superseded_at IS NULL AND cr.status <> 'NOT_REQUIRED') AS requirement_count,
          (SELECT count(*) FROM trust.case_requirements cr WHERE cr.verification_case_id = c.verification_case_id AND cr.superseded_at IS NULL AND cr.status IN ('PENDING', 'IN_REVIEW')) AS awaiting
        FROM trust.verification_cases c
        WHERE ${opts.status ? sql`c.status = ${opts.status}` : sql`true`}
        ORDER BY c.submitted_at NULLS LAST, c.verification_case_id
        LIMIT ${limit}`.execute(this.db);
      return r.rows.map((x) => ({
        verificationCaseId: x.verification_case_id as string,
        accountId: x.account_id as string,
        caseNumber: Number(x.case_number),
        status: x.status as TrustCaseStatus,
        submittedAt: isoOrNull(x.submitted_at),
        updatedAt: iso(x.updated_at),
        requirementCount: Number(x.requirement_count),
        awaitingReviewCount: Number(x.awaiting),
      }));
    });
  }
  /** One case with every cycle of every requirement, the reviews, the document metadata (no key, no link) and the external references. */
  async getCase(caseId: string): Promise<CaseDetailView> {
    return this.read(async () => {
      const row = (await sql<Row>`SELECT * FROM trust.verification_cases WHERE verification_case_id = ${caseId}`.execute(this.db)).rows[0];
      if (!row) throw new TrustError('NOT_FOUND', 'we could not find that');
      const c = toCase(row);
      const requirements = await this.adminRequirements(this.db, caseId, false);
      return {
        case: {
          verificationCaseId: c.verificationCaseId,
          accountId: c.accountId,
          caseNumber: c.caseNumber,
          status: c.status,
          submittedAt: c.submittedAt,
          updatedAt: iso(row.updated_at),
          requirementCount: requirements.filter((r) => !r.superseded && r.status !== 'NOT_REQUIRED').length,
          awaitingReviewCount: requirements.filter((r) => !r.superseded && (r.status === 'PENDING' || r.status === 'IN_REVIEW')).length,
          revision: c.revision,
          openedAt: c.openedAt,
          decidedAt: c.decidedAt,
        },
        requirements,
      };
    });
  }

  // ------------------------------------------------------------------ policy administration (trust-admin)
  async getPolicy(): Promise<PolicyView> {
    return this.read(async () => {
      const [defs, rules, types] = await Promise.all([
        sql<Row>`SELECT code, requirement_type, evidence_kind, expiry_required, status FROM trust.requirement_definitions ORDER BY code COLLATE "C"`.execute(
          this.db,
        ),
        sql<Row>`SELECT d.code AS requirement_code, m.code AS market_code, s.code AS service_type_code, r.enabled
          FROM trust.requirement_rules r JOIN trust.requirement_definitions d ON d.requirement_definition_id = r.requirement_definition_id
          LEFT JOIN geography.markets m ON m.market_id = r.market_id LEFT JOIN catalog.service_types s ON s.service_type_id = r.service_type_id
          ORDER BY d.code COLLATE "C", m.code COLLATE "C" NULLS FIRST, s.code COLLATE "C" NULLS FIRST`.execute(this.db),
        sql<Row>`SELECT code, requirement_type FROM trust.document_types WHERE status = 'ACTIVE' ORDER BY code COLLATE "C"`.execute(this.db),
      ]);
      return {
        requirements: defs.rows.map((x) => ({
          code: x.code as string,
          requirementType: x.requirement_type as PolicyView['requirements'][number]['requirementType'],
          evidenceKind: x.evidence_kind as PolicyView['requirements'][number]['evidenceKind'],
          expiryRequired: x.expiry_required as boolean,
          status: x.status as string,
        })),
        rules: rules.rows.map((x) => ({
          requirementCode: x.requirement_code as string,
          marketCode: (x.market_code as string | null) ?? null,
          serviceTypeCode: (x.service_type_code as string | null) ?? null,
          enabled: x.enabled as boolean,
        })),
        documentTypes: types.rows.map((x) => ({
          code: x.code as string,
          requirementType: x.requirement_type as PolicyView['documentTypes'][number]['requirementType'],
        })),
      };
    });
  }

  /** Turns a requirement definition on or off, or retires it. Cases adopt the change when they are next evaluated (opening or submitting). Idempotent for the same status. */
  async setRequirementStatus(adminSubject: string, code: string, input: unknown): Promise<{ code: string; status: TrustDefinitionStatus; changed: boolean }> {
    const body = parseInput(SetRequirementStatusRequest, input);
    const actor = this.reviewActor(adminSubject);
    const cid = getCorrelationId() ?? randomUUID();
    return this.tx(async (trx) => {
      const d = (await sql<Row>`SELECT requirement_definition_id, status FROM trust.requirement_definitions WHERE code = ${code} FOR UPDATE`.execute(trx))
        .rows[0];
      if (!d) throw new TrustError('NOT_FOUND', 'we could not find that');
      const from = d.status as TrustDefinitionStatus;
      if (from === body.status) return { code, status: from, changed: false };
      if (!isTrustDefinitionTransitionAllowed(from, body.status))
        throw new TrustError('INVALID_STATE', 'that status change is not possible', { reason: 'STATUS_TRANSITION' });
      await sql`UPDATE trust.requirement_definitions SET status = ${body.status} WHERE requirement_definition_id = ${d.requirement_definition_id as string}`.execute(
        trx,
      );
      await this.audit(trx, cid, {
        actor,
        action: 'TRUST_REQUIREMENT_STATUS_CHANGED',
        definitionId: d.requirement_definition_id as string,
        changes: { requirement: code, status: [from, body.status] },
      });
      return { code, status: body.status, changed: true };
    });
  }

  /** Requires (or stops requiring) a definition for a market and/or a service type (null = all). Upsert; a rule is switched off, never deleted. Idempotent. */
  async setRequirementRule(
    adminSubject: string,
    input: unknown,
  ): Promise<{ requirementCode: string; marketCode: string | null; serviceTypeCode: string | null; enabled: boolean; changed: boolean }> {
    const body = parseInput(SetRequirementRuleRequest, input);
    const actor = this.reviewActor(adminSubject);
    const cid = getCorrelationId() ?? randomUUID();
    return this.tx(async (trx) => {
      const d = (await sql<Row>`SELECT requirement_definition_id FROM trust.requirement_definitions WHERE code = ${body.requirementCode}`.execute(trx)).rows[0];
      if (!d) throw new TrustError('NOT_FOUND', 'we could not find that', { reason: 'UNKNOWN_REQUIREMENT' });
      let marketId: string | null = null;
      if (body.marketCode !== null) {
        const m = (await sql<Row>`SELECT market_id FROM geography.markets WHERE code = ${body.marketCode}`.execute(trx)).rows[0];
        if (!m) throw new TrustError('VALIDATION_FAILED', 'that market does not exist', { field: 'marketCode', reason: 'UNKNOWN_MARKET' });
        marketId = m.market_id as string;
      }
      let serviceTypeId: string | null = null;
      if (body.serviceTypeCode !== null) {
        const s = (await sql<Row>`SELECT service_type_id FROM catalog.service_types WHERE code = ${body.serviceTypeCode}`.execute(trx)).rows[0];
        if (!s) throw new TrustError('VALIDATION_FAILED', 'that service type does not exist', { field: 'serviceTypeCode', reason: 'UNKNOWN_SERVICE_TYPE' });
        serviceTypeId = s.service_type_id as string;
      }
      const defId = d.requirement_definition_id as string;
      const existing = (
        await sql<Row>`SELECT requirement_rule_id, enabled FROM trust.requirement_rules
          WHERE requirement_definition_id = ${defId} AND market_id IS NOT DISTINCT FROM ${marketId} AND service_type_id IS NOT DISTINCT FROM ${serviceTypeId} FOR UPDATE`.execute(
          trx,
        )
      ).rows[0];
      const out = { requirementCode: body.requirementCode, marketCode: body.marketCode, serviceTypeCode: body.serviceTypeCode, enabled: body.enabled };
      if (existing && existing.enabled === body.enabled) return { ...out, changed: false };
      if (existing)
        await sql`UPDATE trust.requirement_rules SET enabled = ${body.enabled} WHERE requirement_rule_id = ${existing.requirement_rule_id as string}`.execute(
          trx,
        );
      else
        await sql`INSERT INTO trust.requirement_rules (requirement_definition_id, market_id, service_type_id, enabled) VALUES (${defId}, ${marketId}, ${serviceTypeId}, ${body.enabled})`.execute(
          trx,
        );
      await this.audit(trx, cid, {
        actor,
        action: 'TRUST_RULE_CHANGED',
        definitionId: defId,
        changes: { requirement: body.requirementCode, market: body.marketCode, serviceType: body.serviceTypeCode, enabled: body.enabled },
      });
      return { ...out, changed: true };
    });
  }

  // ------------------------------------------------------------------ expiry (a sweep, derivable meanwhile)
  /**
   * Records the approvals whose validity has ended: EXPIRED, the case re-derived, an audit row and an event each. The overview already READS an approval past its end as EXPIRED
   * (derived from the timestamp), so correctness never waits for this sweep; it exists so the event and the record are written. Safe to run concurrently and repeatedly.
   */
  async recordExpiries(limit = 100): Promise<number> {
    const due = await this.read(
      async () =>
        (
          await sql<Row>`SELECT cr.case_requirement_id, cr.verification_case_id FROM trust.case_requirements cr
            JOIN trust.verification_cases c ON c.verification_case_id = cr.verification_case_id AND c.status <> 'CANCELLED'
          WHERE cr.status = 'APPROVED' AND cr.superseded_at IS NULL AND cr.expires_at IS NOT NULL AND cr.expires_at <= clock_timestamp()
          ORDER BY cr.expires_at, cr.case_requirement_id LIMIT ${Math.min(Math.max(limit, 1), 500)}`.execute(this.db)
        ).rows,
    );
    let recorded = 0;
    for (const row of due) {
      const cid = getCorrelationId() ?? randomUUID();
      const done = await this.tx(async (trx) => {
        const c = (
          await sql<Row>`SELECT * FROM trust.verification_cases WHERE verification_case_id = ${row.verification_case_id as string} AND status <> 'CANCELLED' FOR UPDATE`.execute(
            trx,
          )
        ).rows[0];
        if (!c) return false;
        const i = (await sql<Row>`${instanceSelect} WHERE cr.case_requirement_id = ${row.case_requirement_id as string} FOR UPDATE OF cr`.execute(trx)).rows[0];
        if (!i || i.status !== 'APPROVED' || i.superseded_at !== null) return false;
        const caseRow = toCase(c);
        const inst = toInstance(i);
        await sql`UPDATE trust.case_requirements SET status = 'EXPIRED', revision = revision + 1 WHERE case_requirement_id = ${inst.caseRequirementId} AND expires_at <= clock_timestamp()`.execute(
          trx,
        );
        const after = (await sql<Row>`SELECT status FROM trust.case_requirements WHERE case_requirement_id = ${inst.caseRequirementId}`.execute(trx)).rows[0]!;
        if (after.status !== 'EXPIRED') return false;
        const status = await this.recompute(trx, caseRow, caseRow.submittedAt !== null);
        await this.audit(trx, cid, {
          actor: 'system:expiry',
          action: 'VERIFICATION_EXPIRED',
          caseId: caseRow.verificationCaseId,
          requirementId: inst.caseRequirementId,
          changes: { requirement: inst.requirementCode, caseStatus: [caseRow.status, status] },
        });
        await this.event(
          trx,
          cid,
          TRUST_EVENTS.expired,
          caseRow.verificationCaseId,
          'system:expiry',
          this.requirementPayload(caseRow, inst, status, null, 'EXPIRED'),
        );
        return true;
      });
      if (done) recorded += 1;
    }
    return recorded;
  }

  // ------------------------------------------------------------------ external verification (adapter boundary)
  /**
   * Starts a verification by the external provider for a requirement that is evidenced externally. The adapter call happens BEFORE the transaction (no lock is held across it); the
   * transaction then moves the requirement to PENDING in a new round and stores only the reference (adapter, external id, status). Idempotent: a requirement already submitted in
   * its current round returns the reference that exists.
   */
  async startExternalVerification(
    accountId: string,
    requirementCode: string,
  ): Promise<{ requirementCode: string; adapter: string; status: TrustExternalStatus; lastCheckedAt: string | null }> {
    const cid = getCorrelationId() ?? randomUUID();
    const actor = actorOf(accountId);
    this.requireContext(await this.d.context.context(accountId));
    const pre = await this.read(async () => {
      const c = await this.liveCase(this.db, accountId);
      if (!c) throw new TrustError('NOT_FOUND', 'there is no verification yet', { reason: 'NO_CASE' });
      const i = (await this.currentInstances(this.db, c.verificationCaseId)).find((x) => x.requirementCode === requirementCode);
      if (!i || i.status === 'NOT_REQUIRED')
        throw new TrustError('REQUIREMENT_NOT_APPLICABLE', 'that requirement does not apply to you', { reason: 'REQUIREMENT_NOT_APPLICABLE' });
      if (i.evidenceKind !== 'EXTERNAL')
        throw new TrustError('EVIDENCE_NOT_ACCEPTED', 'this requirement does not take that kind of evidence', { reason: 'EVIDENCE_NOT_ACCEPTED' });
      // the reference of the CURRENT round is the one to return, and only while that round is the one under way: after a rejection or a request for action the instance is
      // still in the round that was started, so the next start must open the next round (a new request to the provider), not return the finished one
      const underway = i.status === 'PENDING' || i.status === 'IN_REVIEW';
      const existing = underway
        ? (
            await sql<Row>`SELECT adapter, status, last_checked_at FROM trust.external_verifications WHERE case_requirement_id = ${i.caseRequirementId} AND round = ${i.round}`.execute(
              this.db,
            )
          ).rows[0]
        : undefined;
      return { i, existing };
    });
    if (pre.existing)
      return {
        requirementCode,
        adapter: pre.existing.adapter as string,
        status: pre.existing.status as TrustExternalStatus,
        lastCheckedAt: isoOrNull(pre.existing.last_checked_at),
      };
    if (!(TRUST_EVIDENCE_OPEN_STATUSES as readonly string[]).includes(effectiveStatus(pre.i, this.now())))
      throw new TrustError('EVIDENCE_NOT_ACCEPTED', 'you cannot start this verification right now', { reason: 'EVIDENCE_NOT_ACCEPTED' });
    const created = await this.external.create({ reference: pre.i.caseRequirementId, requirementType: pre.i.requirementType }).catch((err: unknown) => {
      if (err instanceof TrustError) throw err;
      log('error', 'external verification provider failed', { error: err instanceof Error ? err.name : 'unknown' });
      throw new TrustError('EXTERNAL_UNAVAILABLE', 'the verification service is not available right now');
    });
    try {
      return await this.tx(async (trx) => {
        await this.lockAccount(trx, accountId);
        const live = await this.lockLiveCase(trx, accountId);
        if (!live) throw new TrustError('NOT_FOUND', 'there is no verification yet', { reason: 'NO_CASE' });
        const i = (await this.lockInstances(trx, live.verificationCaseId)).find((x) => x.requirementCode === requirementCode);
        if (!i || i.evidenceKind !== 'EXTERNAL' || !(TRUST_EVIDENCE_OPEN_STATUSES as readonly string[]).includes(effectiveStatus(i, this.now())))
          throw new TrustError('EVIDENCE_NOT_ACCEPTED', 'you cannot start this verification right now', { reason: 'EVIDENCE_NOT_ACCEPTED' });
        await sql`UPDATE trust.case_requirements SET status = 'PENDING', round = round + 1, revision = revision + 1 WHERE case_requirement_id = ${i.caseRequirementId}`.execute(
          trx,
        );
        // the guard requires a reference to start CREATED; the status the adapter reported is recorded right after
        await sql`INSERT INTO trust.external_verifications (case_requirement_id, round, adapter, external_id)
          VALUES (${i.caseRequirementId}, ${i.round + 1}, ${this.external.name}, ${created.externalId})`.execute(trx);
        if (created.status !== 'CREATED')
          await sql`UPDATE trust.external_verifications SET status = ${created.status}, last_checked_at = now() WHERE adapter = ${this.external.name} AND external_id = ${created.externalId}`.execute(
            trx,
          );
        const status = await this.recompute(trx, live, true);
        await this.audit(trx, cid, {
          actor,
          action: 'VERIFICATION_EXTERNAL_STARTED',
          caseId: live.verificationCaseId,
          requirementId: i.caseRequirementId,
          changes: { requirement: i.requirementCode, adapter: this.external.name, round: i.round + 1 },
        });
        await this.event(trx, cid, TRUST_EVENTS.submitted, live.verificationCaseId, actor, this.casePayload(live, status));
        return {
          requirementCode,
          adapter: this.external.name,
          status: created.status,
          lastCheckedAt: created.status === 'CREATED' ? null : new Date().toISOString(),
        };
      });
    } catch (err) {
      await this.external.cancel(created.externalId).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Asks the external provider for the state of the current verification and records it. An APPROVED verification approves the requirement (reviewer `external:<adapter>`) when it
   * can: if the definition needs an approval end date and the provider reports none, the requirement goes to IN_REVIEW for staff to complete. A REJECTED one refuses it
   * (OTHER_REVIEW_REQUIRED). The adapter call happens before the transaction.
   */
  async refreshExternalVerification(
    accountId: string,
    requirementCode: string,
  ): Promise<{ requirementCode: string; adapter: string; status: TrustExternalStatus; lastCheckedAt: string | null }> {
    const cid = getCorrelationId() ?? randomUUID();
    this.requireContext(await this.d.context.context(accountId));
    const pre = await this.read(async () => {
      const c = await this.liveCase(this.db, accountId);
      if (!c) throw new TrustError('NOT_FOUND', 'there is no verification yet', { reason: 'NO_CASE' });
      const i = (await this.currentInstances(this.db, c.verificationCaseId)).find((x) => x.requirementCode === requirementCode);
      if (!i) throw new TrustError('REQUIREMENT_NOT_APPLICABLE', 'that requirement does not apply to you', { reason: 'REQUIREMENT_NOT_APPLICABLE' });
      const ext = (
        await sql<Row>`SELECT adapter, external_id, status FROM trust.external_verifications WHERE case_requirement_id = ${i.caseRequirementId} AND round = ${i.round}`.execute(
          this.db,
        )
      ).rows[0];
      if (!ext) throw new TrustError('NOT_FOUND', 'there is no external verification to refresh', { reason: 'NO_EXTERNAL' });
      return { i, ext };
    });
    if (pre.ext.adapter !== this.external.name) throw new TrustError('EXTERNAL_UNAVAILABLE', 'the verification service is not available right now');
    const summary = await this.external.status(pre.ext.external_id as string).catch((err: unknown) => {
      if (err instanceof TrustError) throw err;
      log('error', 'external verification provider failed', { error: err instanceof Error ? err.name : 'unknown' });
      throw new TrustError('EXTERNAL_UNAVAILABLE', 'the verification service is not available right now');
    });
    return this.tx(async (trx) => {
      await this.lockAccount(trx, accountId);
      const live = await this.lockLiveCase(trx, accountId);
      if (!live) throw new TrustError('NOT_FOUND', 'there is no verification yet', { reason: 'NO_CASE' });
      const i = (await this.lockInstances(trx, live.verificationCaseId)).find((x) => x.caseRequirementId === pre.i.caseRequirementId);
      if (!i) throw new TrustError('INVALID_STATE', 'a newer cycle replaced this requirement', { reason: 'SUPERSEDED_FROZEN' });
      const ext = (
        await sql<Row>`SELECT external_verification_id, status FROM trust.external_verifications WHERE case_requirement_id = ${i.caseRequirementId} AND round = ${pre.i.round} FOR UPDATE`.execute(
          trx,
        )
      ).rows[0];
      if (!ext) throw new TrustError('NOT_FOUND', 'there is no external verification to refresh', { reason: 'NO_EXTERNAL' });
      const out = { requirementCode, adapter: this.external.name, status: summary.status, lastCheckedAt: null as string | null };
      const terminal = ['APPROVED', 'REJECTED', 'CANCELLED'].includes(ext.status as string);
      if (terminal && ext.status !== summary.status) return { ...out, status: ext.status as TrustExternalStatus };
      if (ext.status !== summary.status || !terminal) {
        await sql`UPDATE trust.external_verifications SET status = ${terminal ? (ext.status as string) : summary.status}, last_checked_at = now() WHERE external_verification_id = ${ext.external_verification_id as string}`.execute(
          trx,
        );
      }
      const reviewable = i.round === pre.i.round && (i.status === 'PENDING' || i.status === 'IN_REVIEW');
      if (!terminal && reviewable && (summary.status === 'APPROVED' || summary.status === 'REJECTED')) {
        const actor = `external:${this.external.name}`;
        // an end date the provider reports is used only while it is in the future and within the structural bound; otherwise staff complete the approval
        const nowMs = this.now().getTime();
        const validUntil =
          summary.validUntil && summary.validUntil.getTime() > nowMs && summary.validUntil.getTime() <= nowMs + MAX_VALIDITY_DAYS * 86_400_000
            ? summary.validUntil
            : null;
        if (summary.status === 'APPROVED' && ((i.expiryRequired && !validUntil) || (summary.validUntil && !validUntil))) {
          // the provider approved but gave no end date and this requirement needs one: staff complete it
          if (i.status === 'PENDING') {
            await sql`UPDATE trust.case_requirements SET status = 'IN_REVIEW', revision = revision + 1 WHERE case_requirement_id = ${i.caseRequirementId}`.execute(
              trx,
            );
            await sql`UPDATE trust.verification_cases SET revision = revision + 1 WHERE verification_case_id = ${live.verificationCaseId}`.execute(trx);
          }
        } else {
          const decision = summary.status === 'APPROVED' ? 'APPROVED' : 'REJECTED';
          const expiresAt = decision === 'APPROVED' ? validUntil : null;
          await sql`UPDATE trust.case_requirements SET status = ${decision}, expires_at = ${expiresAt}, revision = revision + 1 WHERE case_requirement_id = ${i.caseRequirementId}`.execute(
            trx,
          );
          const reason = decision === 'REJECTED' ? 'OTHER_REVIEW_REQUIRED' : null;
          await sql`INSERT INTO trust.reviews (case_requirement_id, round, decision, reason_code, reviewer, expires_at, correlation_id)
            VALUES (${i.caseRequirementId}, ${i.round}, ${decision}, ${reason}, ${actor}, ${expiresAt}, ${cid})`.execute(trx);
          const status = await this.recompute(trx, live, true);
          await this.audit(trx, cid, {
            actor,
            action: decision === 'APPROVED' ? 'VERIFICATION_APPROVED' : 'VERIFICATION_REJECTED',
            caseId: live.verificationCaseId,
            requirementId: i.caseRequirementId,
            reasonCode: reason,
            changes: { requirement: i.requirementCode, round: i.round, caseStatus: [live.status, status] },
          });
          await this.event(
            trx,
            cid,
            decision === 'APPROVED' ? TRUST_EVENTS.requirementApproved : TRUST_EVENTS.requirementRejected,
            live.verificationCaseId,
            actor,
            this.requirementPayload(live, i, status, reason, decision),
          );
          if (status === 'APPROVED' && live.status !== 'APPROVED')
            await this.event(trx, cid, TRUST_EVENTS.completed, live.verificationCaseId, actor, this.casePayload(live, 'APPROVED'));
        }
      }
      await this.audit(trx, cid, {
        actor: `external:${this.external.name}`,
        action: 'VERIFICATION_EXTERNAL_UPDATED',
        caseId: live.verificationCaseId,
        requirementId: i.caseRequirementId,
        changes: { requirement: i.requirementCode, externalStatus: summary.status },
      });
      return { ...out, lastCheckedAt: new Date().toISOString() };
    });
  }
}
