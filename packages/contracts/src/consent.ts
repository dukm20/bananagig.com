// Public contracts of the account consent layer (ID-005, docs/engineering/CONSENT.md): purposes, the immutable consent event log, the derived current state, the
// requirement evaluation, the strict request bodies, the identity consent events and the error codes.
//
// Ownership (ADR-0037, ADR-0038): CFG-002 owns the legal documents and their immutable, hashed, localized versions. This layer owns only the ACCOUNT'S relationship to a
// version: that it accepted (or withdrew) a purpose, when, in which locale, and the hash of the exact text. No legal body text is ever copied here, into an event,
// or into an audit row. Current consent is DERIVED from the latest event of an account and purpose; nothing stores a "current_accepted" flag.
import { z } from 'zod';
import { envelope } from './envelope';

// ---------------------------------------------------------------- vocabularies
/** Stable purpose codes: upper snake case. New purposes are added by a migration (the document entry they bind to must exist). */
export const PURPOSE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
export const ConsentPurposeCode = z.string().regex(PURPOSE_CODE_PATTERN);
export type ConsentPurposeCode = z.infer<typeof ConsentPurposeCode>;
/** The purposes seeded by migration 0013 (the only ones a current product flow needs: CU-03 sign-up consent). Others are structurally supported. */
export const SEEDED_CONSENT_PURPOSES = ['TERMS_OF_SERVICE', 'PRIVACY_POLICY'] as const;
export const CONSENT_PURPOSE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type ConsentPurposeStatus = (typeof CONSENT_PURPOSE_STATUSES)[number];
/** Whether the person may withdraw an accepted consent. Structural (the legal nature of the purpose), so it is a column, not configuration. */
export const WITHDRAWAL_POLICIES = ['NOT_WITHDRAWABLE', 'WITHDRAWABLE'] as const;
export const WithdrawalPolicy = z.enum(WITHDRAWAL_POLICIES);
export type WithdrawalPolicy = z.infer<typeof WithdrawalPolicy>;
export const CONSENT_EVENT_TYPES = ['ACCEPTED', 'WITHDRAWN'] as const;
export const ConsentEventType = z.enum(CONSENT_EVENT_TYPES);
export type ConsentEventType = z.infer<typeof ConsentEventType>;
/** Where an event came from. The column exists so a trusted source (for example a back-office record) can be added by widening the CHECK. */
export const CONSENT_SOURCES = ['ACCOUNT_API'] as const;
export const ConsentSource = z.enum(CONSENT_SOURCES);
export type ConsentSource = z.infer<typeof ConsentSource>;

/**
 * What happens to an existing acceptance when a newer version of the document is in force (configuration, CFG-001, per purpose; never hardcoded per document).
 * Ordered from the weakest to the strongest requirement:
 *  - NO_REACCEPT: the acceptance of ANY version in ANY locale satisfies the purpose for good (editorial changes), even while no version is in force.
 *  - REACCEPT_FOR_NEW_USERS_ONLY: existing acceptors stay satisfied by any earlier version of the SAME locale as the one being evaluated, even while no version is in force;
 *    an account that never accepted in that locale must accept the version in force.
 *  - REACCEPT_REQUIRED: only the version in force, in the evaluated locale, satisfies the purpose (the conservative default); with no version in force the status is
 *    DOCUMENT_UNAVAILABLE.
 */
export const REACCEPTANCE_MODES = ['NO_REACCEPT', 'REACCEPT_FOR_NEW_USERS_ONLY', 'REACCEPT_REQUIRED'] as const;
export const ReacceptanceMode = z.enum(REACCEPTANCE_MODES);
export type ReacceptanceMode = z.infer<typeof ReacceptanceMode>;

/** The state of one purpose for one account, derived from its latest event. */
export const CONSENT_ACCEPTANCE_STATES = ['NONE', 'ACCEPTED', 'WITHDRAWN'] as const;
export const ConsentAcceptanceState = z.enum(CONSENT_ACCEPTANCE_STATES);
export type ConsentAcceptanceState = z.infer<typeof ConsentAcceptanceState>;
/**
 * The outcome of evaluating one purpose against policy, role and document:
 *  - NOT_REQUIRED: no role of the account requires it (it may still be accepted voluntarily).
 *  - SATISFIED: required and satisfied under the reacceptance mode (under NO_REACCEPT and REACCEPT_FOR_NEW_USERS_ONLY this includes the case where no version is in force).
 *  - OUTSTANDING: required, never accepted (or withdrawn), and a document is in force.
 *  - REACCEPTANCE_REQUIRED: required, accepted before, but the mode needs the version in force.
 *  - DOCUMENT_UNAVAILABLE: required, no version is in force in the evaluated locale (EXACT: no fallback), and the account is not already satisfied under a lenient mode;
 *    it cannot be accepted yet.
 */
export const CONSENT_REQUIREMENT_STATUSES = ['NOT_REQUIRED', 'SATISFIED', 'OUTSTANDING', 'REACCEPTANCE_REQUIRED', 'DOCUMENT_UNAVAILABLE'] as const;
export const ConsentRequirementStatus = z.enum(CONSENT_REQUIREMENT_STATUSES);
export type ConsentRequirementStatus = z.infer<typeof ConsentRequirementStatus>;
/** A required purpose that is not satisfied. */
export const isOutstandingStatus = (s: ConsentRequirementStatus): boolean =>
  s === 'OUTSTANDING' || s === 'REACCEPTANCE_REQUIRED' || s === 'DOCUMENT_UNAVAILABLE';

/** Content keys of the managed copy (CFG-002). */
export const consentPurposeLabelKey = (code: string): string => `account.consent.purpose.${code.toLowerCase()}`;
export const consentStatusLabelKey = (s: ConsentRequirementStatus): string => `account.consent.status.${s.toLowerCase()}`;
export const consentStateLabelKey = (s: ConsentAcceptanceState): string => `account.consent.state.${s.toLowerCase()}`;
export const consentEventLabelKey = (t: ConsentEventType): string => `account.consent.event.${t.toLowerCase()}`;
/** The configuration keys of a purpose's policy (CFG-001): who needs it, and what a newer version does to existing acceptances. */
export const consentRequiredForKey = (code: string): string => `consent.${code.toLowerCase()}.required_for`;
export const consentReacceptanceKey = (code: string): string => `consent.${code.toLowerCase()}.reacceptance`;
/** The key of the LEGAL entry a seeded purpose binds to. */
export const LEGAL_ENTRY_KEYS: Record<(typeof SEEDED_CONSENT_PURPOSES)[number], string> = {
  TERMS_OF_SERVICE: 'legal.terms_of_service',
  PRIVACY_POLICY: 'legal.privacy_policy',
};

// ---------------------------------------------------------------- read models (owner only)
/** The exact version an event binds to. The locale and the hash are those of the immutable version (the database proves it). */
export const ConsentVersionRefDto = z.object({
  /** `content.versions.version_id`. */
  versionId: z.string(),
  /** The version number within its entry, locale and scope. */
  version: z.number().int(),
  locale: z.string(),
  bodySha256: z.string(),
});
export type ConsentVersionRefDto = z.infer<typeof ConsentVersionRefDto>;

export const ConsentEventDto = z.object({
  consentEventId: z.string(),
  purposeCode: z.string(),
  eventType: ConsentEventType,
  /** 1, 2, 3 ... per account and purpose: the order of the history. */
  eventSeq: z.number().int(),
  document: ConsentVersionRefDto,
  occurredAt: z.string(),
  source: ConsentSource,
});
export type ConsentEventDto = z.infer<typeof ConsentEventDto>;

/** One purpose's derived current state for the account. */
export const ConsentCurrentDto = z.object({
  purposeCode: z.string(),
  labelContentKey: z.string(),
  state: ConsentAcceptanceState,
  withdrawable: z.boolean(),
  /** The latest event, or null when the account never had one. */
  latest: ConsentEventDto.nullable(),
});
export type ConsentCurrentDto = z.infer<typeof ConsentCurrentDto>;
export const AccountConsentsDto = z.object({
  current: z.array(ConsentCurrentDto),
  /** Every event of the account, newest first (bounded by CONSENT_HISTORY_LIMIT). */
  history: z.array(ConsentEventDto),
});
export type AccountConsentsDto = z.infer<typeof AccountConsentsDto>;
export const AccountConsentsResponse = envelope(AccountConsentsDto);
export const CONSENT_HISTORY_LIMIT = 200;

/** The version in force for a purpose in the evaluated locale (what a person would be shown and could accept now). */
export const ConsentDocumentDto = z.object({
  /** The key of the LEGAL entry (for the public content resolver). */
  entryKey: z.string(),
  versionId: z.string(),
  version: z.number().int(),
  locale: z.string(),
  bodySha256: z.string(),
  effectiveFrom: z.string(),
});
export type ConsentDocumentDto = z.infer<typeof ConsentDocumentDto>;

export const ConsentRequirementDto = z.object({
  purposeCode: z.string(),
  labelContentKey: z.string(),
  /** Some role of the account requires this purpose (configuration `consent.<purpose>.required_for`). */
  required: z.boolean(),
  status: ConsentRequirementStatus,
  acceptanceState: ConsentAcceptanceState,
  withdrawable: z.boolean(),
  reacceptance: ReacceptanceMode,
  /** The version in force in the evaluated locale, or null when there is none. */
  document: ConsentDocumentDto.nullable(),
  /** The account's latest ACCEPTED event for the purpose (when its state is ACCEPTED), else null. */
  accepted: ConsentEventDto.nullable(),
});
export type ConsentRequirementDto = z.infer<typeof ConsentRequirementDto>;
export const ConsentRequirementsDto = z.object({
  /** The locale the requirements were evaluated in (the account's preferred locale unless the caller asked for another). */
  locale: z.string(),
  requirements: z.array(ConsentRequirementDto),
  /** Every REQUIRED purpose is SATISFIED. */
  satisfied: z.boolean(),
  /** The required purposes that are not satisfied. */
  outstanding: z.array(z.string()),
});
export type ConsentRequirementsDto = z.infer<typeof ConsentRequirementsDto>;
export const ConsentRequirementsResponse = envelope(ConsentRequirementsDto);

// ---------------------------------------------------------------- operation results
export const AcceptConsentResultDto = z.object({
  /** False when the account had already accepted exactly this version (idempotent repeat): nothing was written. */
  changed: z.boolean(),
  event: ConsentEventDto,
});
export type AcceptConsentResultDto = z.infer<typeof AcceptConsentResultDto>;
export const AcceptConsentResponse = envelope(AcceptConsentResultDto);
export const WithdrawConsentResultDto = z.object({
  /** False when the consent was already withdrawn (idempotent repeat). */
  changed: z.boolean(),
  event: ConsentEventDto,
});
export type WithdrawConsentResultDto = z.infer<typeof WithdrawConsentResultDto>;
export const WithdrawConsentResponse = envelope(WithdrawConsentResultDto);

// ---------------------------------------------------------------- requests (strict: unknown fields are refused; nothing is coerced; the server sets every time)
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
/**
 * Accepts the version the person was SHOWN: its id, its locale and the hash of its text. The account comes from the token and the time from the server. The server
 * verifies the version is in force for the purpose and that the locale and hash are those of the immutable version; a mismatch is refused, never repaired.
 */
export const AcceptConsentRequest = z
  .object({
    versionId: z.string().uuid(),
    locale: z.string().min(2).max(35),
    bodySha256: z.string().regex(SHA256_HEX_PATTERN),
  })
  .strict();
export type AcceptConsentRequest = z.infer<typeof AcceptConsentRequest>;
export const WithdrawConsentRequest = z.object({}).strict();
export type WithdrawConsentRequest = z.infer<typeof WithdrawConsentRequest>;
export const ConsentPurposeParam = z.object({ purpose: ConsentPurposeCode }).strict();
/** `?locale=` of the requirements read: a locale tag, validated again against the registered locales by the service. */
export const ConsentRequirementsQuery = z.object({ locale: z.string().min(2).max(35).optional() }).strict();

// ---------------------------------------------------------------- events (transactional outbox; identifiers only, never legal text)
export const CONSENT_EVENTS = {
  accepted: 'bananagig.identity.consent-accepted.v1',
  withdrawn: 'bananagig.identity.consent-withdrawn.v1',
} as const;
export const ConsentEventPayload = z.object({
  accountId: z.string(),
  purposeCode: z.string(),
  consentEventId: z.string(),
  eventSeq: z.number().int(),
  /** `content.versions.version_id` of the text; the hash and the locale are reachable through it. */
  contentVersionId: z.string(),
});
export type ConsentEventPayload = z.infer<typeof ConsentEventPayload>;

// ---------------------------------------------------------------- error codes (mapped to `ACCOUNT_<code>` by the API layer)
export const CONSENT_ERROR_CODES = [
  /** The purpose code is unknown. */
  'CONSENT_PURPOSE_NOT_FOUND',
  /** The purpose exists but is INACTIVE: it cannot be accepted. */
  'CONSENT_PURPOSE_INACTIVE',
  /** The version id is unknown, is not a published version of the purpose's document, or is not in the platform scope (uniform: unpublished text is never disclosed). */
  'CONSENT_VERSION_NOT_FOUND',
  /** The version is published but not in force now (superseded, or not yet effective). */
  'CONSENT_VERSION_NOT_CURRENT',
  /** The locale the client claims differs from the locale of the version. */
  'CONSENT_LOCALE_MISMATCH',
  /** The hash the client claims differs from the hash of the version. */
  'CONSENT_HASH_MISMATCH',
  /** The purpose cannot be withdrawn. */
  'CONSENT_NOT_WITHDRAWABLE',
  /** Nothing is accepted for the purpose, so there is nothing to withdraw. */
  'CONSENT_NOT_ACCEPTED',
  /** The purpose is required for a role of the account and cannot be withdrawn while it is. */
  'CONSENT_REQUIRED_FOR_ROLE',
  /** Raised by `requireConsents` (future gated actions): required consents are outstanding. `details.outstanding` lists the purposes. */
  'CONSENT_REQUIRED',
] as const;
export type ConsentErrorCode = (typeof CONSENT_ERROR_CODES)[number];
export const consentErrorMessageKey = (code: ConsentErrorCode): string => `account.consent.error.${code.replace(/^CONSENT_/, '').toLowerCase()}`;
