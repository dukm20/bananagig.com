// Integration tests of TrustService.publicBadgeTypes (PRO-002) over a real, freshly migrated PostgreSQL database (migration 0019 with its guards and seeds).
//
// The states under test are written with plain SQL (the guards of the trust tables are switched off for the INSERT only, so an approval can be crafted with any end date, including
// one in the past that no sweep has recorded). The CHECK constraints stay on: they are part of what is proven (a superseded instance can only be EXPIRED). Each test uses its own
// accounts, so nothing is shared except the seeded policy tables.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TRUST_POLICY_KEYS,
  TRUST_REQUIREMENT_STATUSES,
  TRUST_REQUIREMENT_TYPES,
  type TrustRequirementStatus,
  type TrustRequirementType,
} from '@bananagig/contracts';
import type { Database } from '@bananagig/database';
import { MemoryObjectStore } from '@bananagig/platform';
import { createIsolatedDatabase, createTestPool, sleep, type IsolatedDatabase } from '@bananagig/testing';
import { StaticTrustPolicyProvider, TrustService, parseTrustPolicy } from './index';

type Pool = ReturnType<typeof createTestPool>;
const K = TRUST_POLICY_KEYS;
const POLICY = parseTrustPolicy({
  [K.maxSizeBytes]: 10_485_760,
  [K.allowedMimeTypes]: ['application/pdf'],
  [K.maxDocumentsPerRequirement]: 5,
  [K.uploadUrlTtlSeconds]: 300,
  [K.downloadUrlTtlSeconds]: 60,
  [K.requireCleanScan]: true,
});
const ALL = [...TRUST_REQUIREMENT_TYPES];

let iso: IsolatedDatabase;
let pool: Pool;
const statements: string[] = [];
let transactionsOpened = 0;
let svc: TrustService;
const mkService = (now?: () => Date): TrustService =>
  new TrustService({
    database: iso.database as Database,
    context: { context: async () => null },
    policy: new StaticTrustPolicyProvider(POLICY),
    store: new MemoryObjectStore(),
    ...(now ? { now } : {}),
  });

beforeAll(async () => {
  iso = await createIsolatedDatabase({
    database: {
      onQuery: (e) => statements.push(e.sql),
      onTransaction: () => {
        transactionsOpened++;
      },
    },
  });
  pool = createTestPool(iso.url, 5);
  svc = mkService();
  // two extra definitions of already-seeded types (several instances of one type) and one of a type nothing seeds
  await addDefinition('extra_identity', 'IDENTITY');
  await addDefinition('extra_certification', 'CERTIFICATION');
});
afterAll(async () => {
  await pool?.end();
  await iso?.drop();
});

const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => (await pool.query(text, params)).rows as T[];

async function addDefinition(code: string, type: string): Promise<void> {
  await q(
    `INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
     SELECT k, 'UI_LABEL', 'CONTENT', 'public badge test copy', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', 'badge-itest' FROM unnest($1::text[]) AS k`,
    [[`trust.requirement.${code}.name`, `trust.requirement.${code}.instructions`]],
  );
  await q(`INSERT INTO trust.requirement_definitions (code, requirement_type, evidence_kind, expiry_required) VALUES ($1, $2, 'DOCUMENT', false)`, [
    code,
    type,
  ]);
}

async function mkAccount(): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const id = (await c.query(`INSERT INTO identity.accounts (status) VALUES ('ACTIVE') RETURNING account_id`)).rows[0].account_id as string;
    await c.query(
      `INSERT INTO identity.account_status_history (account_id, from_status, to_status, actor, correlation_id) VALUES ($1, NULL, 'ACTIVE', 'test', 'test')`,
      [id],
    );
    await c.query('COMMIT');
    return id;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

interface Req {
  /** A seeded or extra definition code. */
  code: string;
  status: TrustRequirementStatus;
  cycle?: number;
  superseded?: boolean;
  /** The end of validity relative to now, in milliseconds (negative = in the past); null/undefined = does not expire. APPROVED and EXPIRED only. */
  endsInMs?: number | null;
}
let caseSeq = 0;
/** Writes a case (with its status) and requirement instances for an account, bypassing the guards for the inserts only. */
async function craft(accountId: string, requirements: readonly Req[], caseStatus: 'OPEN' | 'IN_REVIEW' | 'CANCELLED' = 'IN_REVIEW'): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE trust.verification_cases DISABLE TRIGGER USER');
    await c.query('ALTER TABLE trust.case_requirements DISABLE TRIGGER USER');
    const caseId = (
      await c.query(
        `INSERT INTO trust.verification_cases (account_id, case_number, status, submitted_at, cancelled_at)
         VALUES ($1, $2, $3, CASE WHEN $3 = 'OPEN' THEN NULL ELSE now() END, CASE WHEN $3 = 'CANCELLED' THEN now() ELSE NULL END) RETURNING verification_case_id`,
        [accountId, ++caseSeq, caseStatus],
      )
    ).rows[0].verification_case_id as string;
    for (const r of requirements) {
      const evidence = r.status !== 'NOT_STARTED' && r.status !== 'NOT_REQUIRED';
      const approval = r.status === 'APPROVED' || r.status === 'EXPIRED';
      await c.query(
        `INSERT INTO trust.case_requirements (verification_case_id, requirement_definition_id, cycle, status, round, submitted_at, approved_at, expires_at, superseded_at)
         SELECT $1, d.requirement_definition_id, $3, $4, $5,
                CASE WHEN $6 THEN now() - interval '20 days' END,
                CASE WHEN $7 THEN now() - interval '10 days' END,
                CASE WHEN $7 AND $8::double precision IS NOT NULL THEN now() + $8::double precision * interval '1 millisecond' END,
                CASE WHEN $9 THEN now() END
           FROM trust.requirement_definitions d WHERE d.code = $2`,
        [caseId, r.code, r.cycle ?? 1, r.status, evidence ? 1 : 0, evidence, approval, r.endsInMs ?? null, r.superseded === true],
      );
    }
    await c.query('ALTER TABLE trust.case_requirements ENABLE TRIGGER USER');
    await c.query('ALTER TABLE trust.verification_cases ENABLE TRIGGER USER');
    await c.query('COMMIT');
    return caseId;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
const DAY = 86_400_000;

describe('publicBadgeTypes: what earns a badge', () => {
  it('an APPROVED current requirement earns the badge of its type, for every type; the answer is in vocabulary order', async () => {
    const a = await mkAccount();
    await craft(a, [
      { code: 'liability_insurance', status: 'APPROVED', endsInMs: 30 * DAY },
      { code: 'identity_verification', status: 'APPROVED' },
      { code: 'professional_license', status: 'APPROVED', endsInMs: 30 * DAY },
      { code: 'background_check', status: 'APPROVED', endsInMs: 30 * DAY },
      { code: 'extra_certification', status: 'APPROVED' },
    ]);
    expect(await svc.publicBadgeTypes(a, ['INSURANCE', 'CERTIFICATION', 'IDENTITY', 'LICENSE', 'BACKGROUND_CHECK'])).toEqual([
      'IDENTITY',
      'BACKGROUND_CHECK',
      'LICENSE',
      'INSURANCE',
      'CERTIFICATION',
    ]);
    for (const t of ['IDENTITY', 'BACKGROUND_CHECK', 'LICENSE', 'INSURANCE', 'CERTIFICATION'] as const) expect(await svc.publicBadgeTypes(a, [t])).toEqual([t]);
  });

  it('every status other than APPROVED earns nothing (NOT_STARTED, PENDING, IN_REVIEW, ACTION_REQUIRED, REJECTED, EXPIRED, NOT_REQUIRED)', async () => {
    for (const status of TRUST_REQUIREMENT_STATUSES) {
      if (status === 'APPROVED') continue;
      const a = await mkAccount();
      await craft(a, [{ code: 'identity_verification', status, endsInMs: status === 'EXPIRED' ? -DAY : null }]);
      expect(await svc.publicBadgeTypes(a, ALL), status).toEqual([]);
    }
  });

  it('a requirement whose only document was withdrawn is NOT_STARTED and earns nothing', async () => {
    // withdrawal is a DOCUMENT status: it never makes a requirement approved, so the requirement stays where it was
    const a = await mkAccount();
    await craft(a, [{ code: 'identity_verification', status: 'NOT_STARTED' }]);
    expect(await svc.publicBadgeTypes(a, ALL)).toEqual([]);
  });

  it('an approval whose end has passed earns nothing even before the sweep records it (stored APPROVED, derived EXPIRED), and nothing when recorded', async () => {
    const derived = await mkAccount();
    await craft(derived, [{ code: 'liability_insurance', status: 'APPROVED', endsInMs: -1000 }]);
    expect(
      await q(`SELECT cr.status FROM trust.case_requirements cr JOIN trust.verification_cases c USING (verification_case_id) WHERE c.account_id = $1`, [
        derived,
      ]),
    ).toEqual([{ status: 'APPROVED' }]);
    expect(await svc.publicBadgeTypes(derived, ALL)).toEqual([]);
    const recorded = await mkAccount();
    await craft(recorded, [{ code: 'liability_insurance', status: 'EXPIRED', endsInMs: -1000 }]);
    expect(await svc.publicBadgeTypes(recorded, ALL)).toEqual([]);
  });

  it("an approval that ends exactly now is expired (the boundary is the evaluator's: expires_at <= now)", async () => {
    const a = await mkAccount();
    await craft(a, [{ code: 'liability_insurance', status: 'APPROVED', endsInMs: 5 * DAY }]);
    const mine = new Date(
      (
        await q<{ t: Date }>(
          `SELECT cr.expires_at AS t FROM trust.case_requirements cr JOIN trust.verification_cases c USING (verification_case_id) WHERE c.account_id = $1`,
          [a],
        )
      )[0]!.t,
    );
    expect(await svc.publicBadgeTypes(a, ALL, new Date(mine.getTime() - 1))).toEqual(['INSURANCE']);
    expect(await svc.publicBadgeTypes(a, ALL, mine)).toEqual([]);
    expect(await svc.publicBadgeTypes(a, ALL, new Date(mine.getTime() + 1))).toEqual([]);
  });

  it('an approval that expires between two reads disappears on the second read (no cache), on the real clock', async () => {
    const a = await mkAccount();
    await craft(a, [{ code: 'liability_insurance', status: 'APPROVED', endsInMs: 1500 }]);
    expect(await svc.publicBadgeTypes(a, ALL)).toEqual(['INSURANCE']);
    await sleep(1800);
    expect(await svc.publicBadgeTypes(a, ALL)).toEqual([]);
  });

  it('the default clock is the service clock (an injected clock decides expiry), an explicit instant overrides it', async () => {
    const a = await mkAccount();
    await craft(a, [{ code: 'liability_insurance', status: 'APPROVED', endsInMs: 2 * DAY }]);
    const future = mkService(() => new Date(Date.now() + 3 * DAY));
    expect(await svc.publicBadgeTypes(a, ALL)).toEqual(['INSURANCE']);
    expect(await future.publicBadgeTypes(a, ALL)).toEqual([]);
    expect(await future.publicBadgeTypes(a, ALL, new Date())).toEqual(['INSURANCE']);
  });

  it('a live approval with no end date (it does not expire) keeps its badge', async () => {
    const a = await mkAccount();
    await craft(a, [{ code: 'identity_verification', status: 'APPROVED' }]);
    expect(await svc.publicBadgeTypes(a, ALL, new Date(Date.now() + 3650 * DAY))).toEqual(['IDENTITY']);
  });
});

describe('publicBadgeTypes: cycles and the current case', () => {
  it('the CHECK constraints make a superseded instance EXPIRED only, so a superseded approval cannot exist to be counted', async () => {
    const a = await mkAccount();
    await expect(craft(a, [{ code: 'liability_insurance', status: 'APPROVED', endsInMs: DAY, superseded: true }])).rejects.toMatchObject({
      constraint: 'ck_case_requirements__superseded',
    });
  });

  it('cycle 1 (EXPIRED, superseded) and cycle 2 APPROVED: the badge comes from cycle 2', async () => {
    const a = await mkAccount();
    await craft(a, [
      { code: 'liability_insurance', status: 'EXPIRED', cycle: 1, superseded: true, endsInMs: -DAY },
      { code: 'liability_insurance', status: 'APPROVED', cycle: 2, endsInMs: 30 * DAY },
    ]);
    expect(await svc.publicBadgeTypes(a, ALL)).toEqual(['INSURANCE']);
  });

  it('cycle 2 not approved (NOT_STARTED, PENDING, REJECTED) means no badge although cycle 1 was once approved', async () => {
    for (const status of ['NOT_STARTED', 'PENDING', 'IN_REVIEW', 'ACTION_REQUIRED', 'REJECTED'] as const) {
      const a = await mkAccount();
      await craft(a, [
        { code: 'liability_insurance', status: 'EXPIRED', cycle: 1, superseded: true, endsInMs: -DAY },
        { code: 'liability_insurance', status: status, cycle: 2 },
      ]);
      expect(await svc.publicBadgeTypes(a, ALL), status).toEqual([]);
    }
  });

  it('cycle 2 APPROVED but already past its end: no badge (cycle 1 does not revive it)', async () => {
    const a = await mkAccount();
    await craft(a, [
      { code: 'liability_insurance', status: 'EXPIRED', cycle: 1, superseded: true, endsInMs: -3 * DAY },
      { code: 'liability_insurance', status: 'APPROVED', cycle: 2, endsInMs: -1000 },
    ]);
    expect(await svc.publicBadgeTypes(a, ALL)).toEqual([]);
  });

  it('a cancelled case earns nothing; only the live case of an account counts', async () => {
    const a = await mkAccount();
    await craft(a, [{ code: 'identity_verification', status: 'APPROVED' }], 'CANCELLED');
    expect(await svc.publicBadgeTypes(a, ALL)).toEqual([]);
    await craft(a, [{ code: 'liability_insurance', status: 'APPROVED', endsInMs: DAY }], 'IN_REVIEW');
    expect(await svc.publicBadgeTypes(a, ALL)).toEqual(['INSURANCE']);
  });

  it("an unknown account, an account without a case and another account's approvals give an empty answer", async () => {
    const holder = await mkAccount();
    await craft(holder, [{ code: 'identity_verification', status: 'APPROVED' }]);
    const bare = await mkAccount();
    expect(await svc.publicBadgeTypes(randomUUID(), ALL)).toEqual([]);
    expect(await svc.publicBadgeTypes(bare, ALL)).toEqual([]);
    expect(await svc.publicBadgeTypes(holder, ALL)).toEqual(['IDENTITY']);
    expect(await svc.publicBadgeTypes('not-a-uuid', ALL)).toEqual([]);
  });

  it('an OPEN case with no approved requirement earns nothing', async () => {
    const a = await mkAccount();
    await craft(a, [{ code: 'identity_verification', status: 'NOT_STARTED' }], 'OPEN');
    expect(await svc.publicBadgeTypes(a, ALL)).toEqual([]);
  });
});

describe('publicBadgeTypes: the allow-list and the shape of the answer', () => {
  it('a type outside the allow-list earns nothing, even when approved; an empty allow-list answers [] without any statement', async () => {
    const a = await mkAccount();
    await craft(a, [
      { code: 'identity_verification', status: 'APPROVED' },
      { code: 'liability_insurance', status: 'APPROVED', endsInMs: DAY },
      { code: 'professional_license', status: 'APPROVED', endsInMs: DAY },
    ]);
    expect(await svc.publicBadgeTypes(a, ['IDENTITY', 'BACKGROUND_CHECK'])).toEqual(['IDENTITY']);
    expect(await svc.publicBadgeTypes(a, ['BACKGROUND_CHECK', 'CERTIFICATION'])).toEqual([]);
    const s0 = statements.length;
    expect(await svc.publicBadgeTypes(a, [])).toEqual([]);
    expect(statements.length - s0).toBe(0);
  });

  it('an unknown code in the allow-list is ignored and never matches', async () => {
    const a = await mkAccount();
    await craft(a, [{ code: 'identity_verification', status: 'APPROVED' }]);
    expect(await svc.publicBadgeTypes(a, ['IDENTITY', "x'; DROP TABLE trust.case_requirements; --" as TrustRequirementType])).toEqual(['IDENTITY']);
    expect(await svc.publicBadgeTypes(a, ['identity' as TrustRequirementType])).toEqual([]);
  });

  it('several approved instances of one type give ONE badge', async () => {
    const a = await mkAccount();
    await craft(a, [
      { code: 'identity_verification', status: 'APPROVED' },
      { code: 'extra_identity', status: 'APPROVED', endsInMs: 10 * DAY },
    ]);
    expect(await svc.publicBadgeTypes(a, ALL)).toEqual(['IDENTITY']);
  });

  it('one approved and one expired instance of the same type still give the badge; both expired give none', async () => {
    const a = await mkAccount();
    await craft(a, [
      { code: 'identity_verification', status: 'APPROVED' },
      { code: 'extra_identity', status: 'APPROVED', endsInMs: -1000 },
    ]);
    expect(await svc.publicBadgeTypes(a, ALL)).toEqual(['IDENTITY']);
    const b = await mkAccount();
    await craft(b, [
      { code: 'identity_verification', status: 'EXPIRED', endsInMs: -DAY },
      { code: 'extra_identity', status: 'APPROVED', endsInMs: -1000 },
    ]);
    expect(await svc.publicBadgeTypes(b, ALL)).toEqual([]);
  });

  it('the answer holds requirement type codes only: no id, date, count, document type, reason or boolean', async () => {
    const a = await mkAccount();
    await craft(a, [
      { code: 'identity_verification', status: 'APPROVED' },
      { code: 'extra_identity', status: 'APPROVED', endsInMs: 10 * DAY },
      { code: 'liability_insurance', status: 'APPROVED', endsInMs: 10 * DAY },
    ]);
    const out = await svc.publicBadgeTypes(a, ALL);
    expect(Array.isArray(out)).toBe(true);
    expect(out.every((t) => typeof t === 'string' && (TRUST_REQUIREMENT_TYPES as readonly string[]).includes(t))).toBe(true);
    expect(out).toEqual(['IDENTITY', 'INSURANCE']);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no uuid
    expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no date
    expect(json).not.toMatch(/passport|drivers_license|insurance_certificate|REASON|true|false|[0-9]/);
  });
});

describe('publicBadgeTypes: statement budget', () => {
  it('is exactly one statement and no transaction, whatever the number of instances, types or cycles', async () => {
    const small = await mkAccount();
    await craft(small, [{ code: 'identity_verification', status: 'APPROVED' }]);
    const big = await mkAccount();
    await craft(big, [
      { code: 'identity_verification', status: 'APPROVED' },
      { code: 'extra_identity', status: 'APPROVED', endsInMs: DAY },
      { code: 'background_check', status: 'APPROVED', endsInMs: DAY },
      { code: 'professional_license', status: 'EXPIRED', cycle: 1, superseded: true, endsInMs: -DAY },
      { code: 'professional_license', status: 'APPROVED', cycle: 2, endsInMs: DAY },
      { code: 'liability_insurance', status: 'PENDING' },
      { code: 'extra_certification', status: 'APPROVED' },
    ]);
    for (const [account, allowed] of [
      [small, ALL],
      [big, ALL],
      [big, ['IDENTITY']],
      [randomUUID(), ALL],
    ] as const) {
      const s0 = statements.length;
      const t0 = transactionsOpened;
      await svc.publicBadgeTypes(account, allowed);
      const used = statements.slice(s0);
      expect(used).toHaveLength(1);
      expect(used[0]).toMatch(/trust\.case_requirements/);
      expect(transactionsOpened - t0).toBe(0);
    }
    expect(await svc.publicBadgeTypes(big, ALL)).toEqual(['IDENTITY', 'BACKGROUND_CHECK', 'LICENSE', 'CERTIFICATION']);
  });

  it('writes nothing: the case and its requirements are unchanged by reading', async () => {
    const a = await mkAccount();
    await craft(a, [{ code: 'liability_insurance', status: 'APPROVED', endsInMs: -1000 }]);
    const before = await q(
      `SELECT cr.status, cr.revision, cr.updated_at, c.revision AS case_revision FROM trust.case_requirements cr JOIN trust.verification_cases c USING (verification_case_id) WHERE c.account_id = $1`,
      [a],
    );
    await svc.publicBadgeTypes(a, ALL);
    expect(
      await q(
        `SELECT cr.status, cr.revision, cr.updated_at, c.revision AS case_revision FROM trust.case_requirements cr JOIN trust.verification_cases c USING (verification_case_id) WHERE c.account_id = $1`,
        [a],
      ),
    ).toEqual(before);
    expect(
      await q(
        `SELECT 1 FROM trust.audit_events WHERE verification_case_id IN (SELECT verification_case_id FROM trust.verification_cases WHERE account_id = $1)`,
        [a],
      ),
    ).toEqual([]);
  });
});
