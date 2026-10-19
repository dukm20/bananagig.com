// The public trust badges of a provider (PRO-002): which kinds of verification a provider currently holds, derived on every call from the live verification case (TRUST-001).
//
// There is no `verified` flag and nothing is cached or copied: a badge for requirement TYPE T exists only while the provider's CURRENT case holds a non-superseded requirement
// instance of type T whose EFFECTIVE status (derive.ts `effectiveStatus`: an approval past its end reads EXPIRED even before the sweep records it) is APPROVED at the moment of the
// read. The answer is the type codes only: never an id, a date, a count, a document type, a reason or a reviewer. Several approved instances of one type give one badge.
//
// One statement, whatever the number of instances or types. The statement selects only the (type, end of validity) pairs of APPROVED instances; the effective status is decided in
// JavaScript by the same function the provider's own overview uses, so the two can never disagree about an expiry.
import { TRUST_REQUIREMENT_TYPES, type TrustRequirementType } from '@bananagig/contracts';
import { sql, type DatabaseSchema, type Kysely, type Trx } from '@bananagig/database';
import { effectiveStatus } from './derive';

type Executor = Kysely<DatabaseSchema> | Trx;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_TYPES: ReadonlySet<string> = new Set(TRUST_REQUIREMENT_TYPES);

/**
 * The requirement types (a subset of `allowedTypes`, in the canonical vocabulary order) the account's current case holds as APPROVED and not expired at `now`. An unknown account, a
 * malformed account id, a missing or cancelled case and an empty allow-list give `[]` (the last without a query).
 */
export async function queryPublicBadgeTypes(
  ex: Executor,
  accountId: string,
  allowedTypes: readonly TrustRequirementType[],
  now: Date,
): Promise<TrustRequirementType[]> {
  const allowed = new Set(allowedTypes.filter((t) => KNOWN_TYPES.has(t)));
  if (allowed.size === 0 || typeof accountId !== 'string' || !UUID.test(accountId)) return [];
  const r = await sql<{ requirement_type: string; expires_at: Date | string | null }>`SELECT DISTINCT d.requirement_type, cr.expires_at
      FROM trust.verification_cases c
      JOIN trust.case_requirements cr ON cr.verification_case_id = c.verification_case_id
      JOIN trust.requirement_definitions d ON d.requirement_definition_id = cr.requirement_definition_id
     WHERE c.account_id = ${accountId} AND c.status <> 'CANCELLED'
       AND cr.superseded_at IS NULL AND cr.status = 'APPROVED'
       AND d.requirement_type = ANY(${[...allowed]}::text[])`.execute(ex);
  const present = new Set<string>();
  for (const row of r.rows) {
    const expiresAt = row.expires_at === null ? null : new Date(row.expires_at).toISOString();
    if (effectiveStatus({ status: 'APPROVED', expiresAt }, now) === 'APPROVED') present.add(row.requirement_type);
  }
  return TRUST_REQUIREMENT_TYPES.filter((t) => present.has(t));
}
