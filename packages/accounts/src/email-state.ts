// The email state of an account as the API and application services read it: whether a verified primary address exists, the pending address, and the
// timing facts of its newest verification. One cheap query, no configuration read, and the address is ALWAYS masked (docs/engineering/EMAIL_VERIFICATION.md).
import { maskEmail, type AccountEmailSummaryDto, type EmailOpenStatus, type EmailPurpose, type EmailSource } from '@bananagig/contracts';
import { sql, type Kysely, type DatabaseSchema, type Trx } from '@bananagig/database';

type Row = Record<string, unknown>;
type Executor = Kysely<DatabaseSchema> | Trx;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);

export const purposeOfStatus = (status: EmailOpenStatus): EmailPurpose => (status === 'PENDING' ? 'INITIAL_EMAIL' : 'CHANGE_EMAIL');

/** The email summary of one account (primary and pending address, masked). Reads live rows only; DISABLED history is not part of the summary. */
export async function loadEmailSummary(ex: Executor, accountId: string): Promise<AccountEmailSummaryDto> {
  const rows = (
    await sql<Row>`SELECT c.email_normalized, c.status, c.is_primary, c.source, c.verified_at,
        usable.expires_at AS usable_expires_at, sent.last_sent_at
      FROM identity.email_contacts c
      LEFT JOIN LATERAL (
        SELECT x.expires_at FROM identity.email_verification_challenges x
        WHERE x.email_contact_id = c.email_contact_id AND x.used_at IS NULL AND x.invalidated_at IS NULL AND x.expires_at > clock_timestamp()
        ORDER BY x.created_at DESC LIMIT 1
      ) usable ON true
      LEFT JOIN LATERAL (
        SELECT max(y.last_sent_at) AS last_sent_at FROM identity.email_verification_challenges y WHERE y.email_contact_id = c.email_contact_id
      ) sent ON true
      WHERE c.account_id = ${accountId} AND c.status <> 'DISABLED'`.execute(ex)
  ).rows;
  const primaryRow = rows.find((r) => r.is_primary === true);
  const pendingRow = rows.find((r) => r.status === 'PENDING' || r.status === 'REPLACEMENT_PENDING');
  return {
    emailVerificationStatus: primaryRow ? 'VERIFIED' : pendingRow ? 'PENDING' : 'NONE',
    primary: primaryRow
      ? { maskedEmail: maskEmail(primaryRow.email_normalized as string), verifiedAt: iso(primaryRow.verified_at)!, source: primaryRow.source as EmailSource }
      : null,
    pending: pendingRow
      ? {
          maskedEmail: maskEmail(pendingRow.email_normalized as string),
          purpose: purposeOfStatus(pendingRow.status as EmailOpenStatus),
          status: pendingRow.status as EmailOpenStatus,
          lastSentAt: iso(pendingRow.last_sent_at),
          expiresAt: iso(pendingRow.usable_expires_at),
        }
      : null,
  };
}
