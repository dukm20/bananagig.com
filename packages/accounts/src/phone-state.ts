// The phone state of an account as the API and application services read it: whether a verified primary number exists, the pending number, and the timing facts
// of its newest verification. One cheap query, no configuration read, and the number is ALWAYS masked (docs/engineering/PHONE_VERIFICATION.md).
import { maskPhone, type AccountPhoneSummaryDto, type PhoneOpenStatus, type PhonePurpose, type PhoneSource } from '@bananagig/contracts';
import { sql, type Kysely, type DatabaseSchema, type Trx } from '@bananagig/database';

type Row = Record<string, unknown>;
type Executor = Kysely<DatabaseSchema> | Trx;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);

export const phonePurposeOfStatus = (status: PhoneOpenStatus): PhonePurpose => (status === 'PENDING' ? 'INITIAL_PHONE' : 'CHANGE_PHONE');

/** The phone summary of one account (primary and pending number, masked). Reads live rows only; DISABLED history is not part of the summary. */
export async function loadPhoneSummary(ex: Executor, accountId: string): Promise<AccountPhoneSummaryDto> {
  const rows = (
    await sql<Row>`SELECT c.phone_e164, c.country_code, c.status, c.is_primary, c.source, c.verified_at,
        usable.expires_at AS usable_expires_at, sent.last_sent_at
      FROM identity.phone_contacts c
      LEFT JOIN LATERAL (
        SELECT x.expires_at FROM identity.phone_verification_challenges x
        WHERE x.phone_contact_id = c.phone_contact_id AND x.used_at IS NULL AND x.invalidated_at IS NULL AND x.expires_at > clock_timestamp()
        ORDER BY x.created_at DESC LIMIT 1
      ) usable ON true
      LEFT JOIN LATERAL (
        SELECT max(y.last_sent_at) AS last_sent_at FROM identity.phone_verification_challenges y WHERE y.phone_contact_id = c.phone_contact_id
      ) sent ON true
      WHERE c.account_id = ${accountId} AND c.status <> 'DISABLED'`.execute(ex)
  ).rows;
  const primaryRow = rows.find((r) => r.is_primary === true);
  const pendingRow = rows.find((r) => r.status === 'PENDING' || r.status === 'REPLACEMENT_PENDING');
  return {
    phoneVerificationStatus: primaryRow ? 'VERIFIED' : pendingRow ? 'PENDING' : 'NONE',
    primary: primaryRow
      ? {
          maskedPhone: maskPhone(primaryRow.phone_e164 as string),
          countryCode: (primaryRow.country_code as string).trim(),
          verifiedAt: iso(primaryRow.verified_at)!,
          source: primaryRow.source as PhoneSource,
        }
      : null,
    pending: pendingRow
      ? {
          maskedPhone: maskPhone(pendingRow.phone_e164 as string),
          countryCode: (pendingRow.country_code as string).trim(),
          purpose: phonePurposeOfStatus(pendingRow.status as PhoneOpenStatus),
          status: pendingRow.status as PhoneOpenStatus,
          lastSentAt: iso(pendingRow.last_sent_at),
          expiresAt: iso(pendingRow.usable_expires_at),
        }
      : null,
  };
}
