-- checkpoint: TRUST-001
-- purpose: add the provider VERIFICATION domain in a new `trust` schema: requirement definitions and the rules that say where they apply (market, service type), verification cases, their requirement instances (one per definition and cycle), document METADATA (the bytes live in private object storage), structured review decisions, external verification references and an immutable audit trail. Verification is multi-dimensional: there is no `verified` flag; the overall state is derived from the requirement states, and "verification approved" is NOT "live" (Go-Live is PRO-003).
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. No case, requirement, document, review, external reference or audit row is ever deleted or truncated (evidence history is kept: a case is cancelled, a requirement expires and a new cycle starts, a document is withdrawn or superseded by a later round).
-- backfill: none; every table is new. The seeds are reference data (4 requirement definitions of which only identity verification is ACTIVE and required, 7 document types, 7 reason codes, one all-markets rule for identity verification) plus configuration and content, and no case exists.
-- risk: low to medium. All objects are new and small. The only existing objects touched are READ by the guards (identity.accounts, geography.markets, catalog.service_types, content.entries). The configuration and content seeds insert rows exactly as their real lifecycles do.
-- destructive: none
-- events: the seeds emit no outbox events (they run before any consumer exists); every case, submission and decision after this migration goes through the trust service, which writes the outbox rows in the same transaction.
-- audit: the configuration and content seeds write their own audit trails exactly as the real workflows do; the trust audit trail starts empty.
-- DECISIONS: (1) the REQUIREMENT DEFINITION (what can be asked: a stable code, a type from a controlled vocabulary, how it is evidenced) is separate from the RULE (where it applies: a market and/or a service type, NULL = all) and from the INSTANCE (what a case holds for one provider), so policy changes without touching history; (2) the policy snapshot is the stable definition id on the instance plus its cycle: a policy change never edits an instance, the service adds or retires instances when the case is next evaluated; (3) an instance is one CYCLE of a requirement: re-verification supersedes an expired instance with cycle + 1 and the old approval stays as history; a ROUND counts the provider's evidence submissions inside a cycle, and every review names the round it decided; (4) the case status is DERIVED from the instances but stored (for the reviewers' queue and the one-live-case index), maintained by the service in the same transaction and checked by tests; the database guards its initial state (OPEN), refuses a return to OPEN and the cancellation of an approved or expired case, and freezes a cancelled one, but it cannot recompute the status; (5) documents are metadata rows (object key, type, verified size and content type, server-computed SHA-256, scan state), immutable once submitted; a resubmission is a new document in a later round, never an overwrite; (6) reviews are append-only with STRUCTURED reason codes and no free-text notes (a note would be sensitive text in an immutable table); (7) an external verification stores only the adapter name, the external id and a status snapshot, never a vendor payload; (8) `account_id` is not repeated on requirements or documents: ownership is read through the case; (9) no row is ever deleted.

-- =====================================================================================================================
-- 1. schema and the refusal function
-- =====================================================================================================================
CREATE SCHEMA trust;
COMMENT ON SCHEMA trust IS 'Application-owned provider verification domain (TRUST-001): requirement definitions and rules, verification cases and their requirement instances, document metadata, structured reviews, external verification references and an immutable audit trail. Account identity, contacts, the provider role and the provider registration are owned elsewhere and referenced by id only; Go-Live is PRO-003.';

CREATE FUNCTION trust.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (% is not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:ROW_IMMUTABLE';
END;
$$;
COMMENT ON FUNCTION trust.forbid_mutation() IS 'Refuses UPDATE, DELETE and TRUNCATE of append-only rows (reviews, audit) and TRUNCATE of every other trust table (ROW_IMMUTABLE).';

-- =====================================================================================================================
-- 2. reference data: requirement definitions, document types, reason codes
-- =====================================================================================================================
CREATE TABLE trust.requirement_definitions (
  requirement_definition_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  code                      text        NOT NULL,
  requirement_type          text        NOT NULL,
  evidence_kind             text        NOT NULL,
  expiry_required           boolean     NOT NULL DEFAULT false,
  status                    text        NOT NULL DEFAULT 'INACTIVE',
  name_content_key          text        GENERATED ALWAYS AS ('trust.requirement.' || code || '.name') STORED NOT NULL,
  instructions_content_key  text        GENERATED ALWAYS AS ('trust.requirement.' || code || '.instructions') STORED NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_requirement_definitions PRIMARY KEY (requirement_definition_id),
  CONSTRAINT uq_requirement_definitions__code UNIQUE (code),
  CONSTRAINT fk_requirement_definitions__name_content_key FOREIGN KEY (name_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT fk_requirement_definitions__instructions_content_key FOREIGN KEY (instructions_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT ck_requirement_definitions__code CHECK (code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND length(code) BETWEEN 2 AND 48),
  CONSTRAINT ck_requirement_definitions__type CHECK (requirement_type IN ('IDENTITY', 'BACKGROUND_CHECK', 'LICENSE', 'INSURANCE', 'CERTIFICATION', 'BUSINESS_REGISTRATION', 'OTHER_DOCUMENT')),
  CONSTRAINT ck_requirement_definitions__evidence_kind CHECK (evidence_kind IN ('DOCUMENT', 'EXTERNAL')),
  CONSTRAINT ck_requirement_definitions__status CHECK (status IN ('INACTIVE', 'ACTIVE', 'RETIRED'))
);
COMMENT ON TABLE trust.requirement_definitions IS 'WHAT a provider can be asked to prove (TRUST-001; PRD SV-09.01: identity, business, background, licence and insurance, configurable by category and market). A definition has a stable immutable code, a type from a controlled vocabulary and the way it is evidenced; WHERE it is required is a rule (trust.requirement_rules), what a case holds is an instance (trust.case_requirements). Platform-owned reference data, never deleted: INACTIVE (required nowhere) <-> ACTIVE, either -> RETIRED (terminal).';
COMMENT ON COLUMN trust.requirement_definitions.code IS 'Immutable lower-case snake_case identity (2 to 48). Never reused, never a display name.';
COMMENT ON COLUMN trust.requirement_definitions.requirement_type IS 'IDENTITY, BACKGROUND_CHECK, LICENSE, INSURANCE, CERTIFICATION, BUSINESS_REGISTRATION or OTHER_DOCUMENT. Immutable. Document types accepted as evidence are those of the same requirement type.';
COMMENT ON COLUMN trust.requirement_definitions.evidence_kind IS 'DOCUMENT (the provider uploads documents that staff review) or EXTERNAL (an external verification provider runs the check through the adapter boundary). Immutable.';
COMMENT ON COLUMN trust.requirement_definitions.expiry_required IS 'true = an approval must carry an expiry date (a licence, an insurance policy, a background check validity window: the reviewer takes it from the evidence). false = the approval does not expire. Deliberately not a global validity period: the validity belongs to each requirement and each approval (SV-09.01).';
COMMENT ON COLUMN trust.requirement_definitions.status IS 'INACTIVE (required nowhere), ACTIVE (rules may require it), RETIRED (terminal). Initial: INACTIVE or ACTIVE.';
COMMENT ON COLUMN trust.requirement_definitions.name_content_key IS 'GENERATED from the code (trust.requirement.<code>.name), a foreign key to content.entries: the name must exist as content.';
COMMENT ON COLUMN trust.requirement_definitions.instructions_content_key IS 'GENERATED from the code (trust.requirement.<code>.instructions), a foreign key to content.entries: what the provider must submit, as content.';

CREATE TABLE trust.document_types (
  document_type_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  code             text        NOT NULL,
  requirement_type text        NOT NULL,
  status           text        NOT NULL DEFAULT 'ACTIVE',
  name_content_key text        GENERATED ALWAYS AS ('trust.document_type.' || code || '.name') STORED NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_document_types PRIMARY KEY (document_type_id),
  CONSTRAINT uq_document_types__code UNIQUE (code),
  CONSTRAINT fk_document_types__name_content_key FOREIGN KEY (name_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT ck_document_types__code CHECK (code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND length(code) BETWEEN 2 AND 48),
  CONSTRAINT ck_document_types__requirement_type CHECK (requirement_type IN ('IDENTITY', 'BACKGROUND_CHECK', 'LICENSE', 'INSURANCE', 'CERTIFICATION', 'BUSINESS_REGISTRATION', 'OTHER_DOCUMENT')),
  CONSTRAINT ck_document_types__status CHECK (status IN ('ACTIVE', 'INACTIVE'))
);
COMMENT ON TABLE trust.document_types IS 'The kinds of document a provider can submit as evidence (a driver''s licence, a passport, an insurance certificate ...). Reference data: each type can evidence the requirements of ONE requirement type, so no join table is needed; which types a given market accepts is not modelled yet (DEBT-0087). Never deleted.';
COMMENT ON COLUMN trust.document_types.requirement_type IS 'The requirement type this document type can evidence. Immutable.';

CREATE TABLE trust.reason_codes (
  reason_code_id   uuid        NOT NULL DEFAULT gen_random_uuid(),
  code             text        NOT NULL,
  applies_to       text        NOT NULL,
  status           text        NOT NULL DEFAULT 'ACTIVE',
  name_content_key text        GENERATED ALWAYS AS ('trust.reason.' || lower(code) || '.name') STORED NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_reason_codes PRIMARY KEY (reason_code_id),
  CONSTRAINT uq_reason_codes__code UNIQUE (code),
  CONSTRAINT fk_reason_codes__name_content_key FOREIGN KEY (name_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT ck_reason_codes__code CHECK (code ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$' AND length(code) BETWEEN 3 AND 48),
  CONSTRAINT ck_reason_codes__applies_to CHECK (applies_to IN ('REJECT', 'ACTION_REQUIRED', 'BOTH')),
  CONSTRAINT ck_reason_codes__status CHECK (status IN ('ACTIVE', 'INACTIVE'))
);
COMMENT ON TABLE trust.reason_codes IS 'Structured, generic OPERATIONAL reasons for a rejection or an action-required decision (document unreadable, name mismatch ...). No legal conclusion and no free text: the wording is content (the provider reads it), the code is what is stored and audited. Never deleted.';

-- =====================================================================================================================
-- 3. policy: where a requirement applies
-- =====================================================================================================================
CREATE TABLE trust.requirement_rules (
  requirement_rule_id       uuid        NOT NULL DEFAULT gen_random_uuid(),
  requirement_definition_id uuid        NOT NULL,
  market_id                 uuid,
  service_type_id           uuid,
  enabled                   boolean     NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_requirement_rules PRIMARY KEY (requirement_rule_id),
  CONSTRAINT uq_requirement_rules__scope UNIQUE NULLS NOT DISTINCT (requirement_definition_id, market_id, service_type_id),
  CONSTRAINT fk_requirement_rules__definition_id FOREIGN KEY (requirement_definition_id) REFERENCES trust.requirement_definitions (requirement_definition_id) ON DELETE RESTRICT,
  CONSTRAINT fk_requirement_rules__market_id FOREIGN KEY (market_id) REFERENCES geography.markets (market_id) ON DELETE RESTRICT,
  CONSTRAINT fk_requirement_rules__service_type_id FOREIGN KEY (service_type_id) REFERENCES catalog.service_types (service_type_id) ON DELETE RESTRICT
);
COMMENT ON TABLE trust.requirement_rules IS 'WHERE a requirement applies (SV-09.01: configurable by category and market): an ENABLED rule requires its definition from a provider whose registration is in the rule''s market (NULL = every market) and offers the rule''s service type (NULL = every service type). Required = at least one enabled rule matches and the definition is ACTIVE. A rule is switched off, never deleted. The market and service type columns have no index of their own: they are never-deleted reference targets and the unique key serves the definition lookup.';
COMMENT ON COLUMN trust.requirement_rules.market_id IS 'NULL = every market. Otherwise the market (geography.markets, restrict).';
COMMENT ON COLUMN trust.requirement_rules.service_type_id IS 'NULL = every service type. Otherwise the service type (catalog.service_types, restrict). The service type is the policy key; template requirement hooks (CAT-002) will map onto it with the Gig builder (CAT-003).';

-- =====================================================================================================================
-- 4. verification cases and their requirement instances
-- =====================================================================================================================
CREATE TABLE trust.verification_cases (
  verification_case_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id           uuid        NOT NULL,
  case_number          integer     NOT NULL,
  status               text        NOT NULL DEFAULT 'OPEN',
  revision             integer     NOT NULL DEFAULT 1,
  submitted_at         timestamptz,
  decided_at           timestamptz,
  cancelled_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_verification_cases PRIMARY KEY (verification_case_id),
  CONSTRAINT uq_verification_cases__number UNIQUE (account_id, case_number),
  CONSTRAINT fk_verification_cases__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_verification_cases__number CHECK (case_number >= 1),
  CONSTRAINT ck_verification_cases__revision CHECK (revision >= 1),
  CONSTRAINT ck_verification_cases__status CHECK (status IN ('OPEN', 'IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'EXPIRED', 'CANCELLED')),
  CONSTRAINT ck_verification_cases__lifecycle CHECK (
    (status = 'OPEN' AND submitted_at IS NULL AND decided_at IS NULL AND cancelled_at IS NULL)
    OR (status IN ('IN_REVIEW', 'ACTION_REQUIRED', 'EXPIRED') AND submitted_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'APPROVED' AND submitted_at IS NOT NULL AND decided_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_verification_cases__live ON trust.verification_cases (account_id) WHERE status <> 'CANCELLED';
CREATE INDEX idx_verification_cases__queue ON trust.verification_cases (submitted_at, verification_case_id) WHERE status = 'IN_REVIEW';
COMMENT ON TABLE trust.verification_cases IS 'The verification case of ONE account (TRUST-001): the container of the requirements policy asks of that provider. The account is the existing identity account (the provider is not a second account) and the case holds no copy of its contacts, name or profile. At most one non-cancelled case per account (the live case, partial unique index); a cancelled case is history and a new one is the next case number. The status is the workflow position DERIVED from the requirement instances by the service and stored for the reviewers'' queue; APPROVED here is NOT Go-Live (PRO-003).';
COMMENT ON COLUMN trust.verification_cases.status IS 'OPEN (never submitted), IN_REVIEW, ACTION_REQUIRED, APPROVED, EXPIRED, CANCELLED (terminal). Derived by the service from the instances (see deriveCaseStatus) in the same transaction as every change of an instance; the guard fixes the initial state (OPEN), refuses a return to OPEN and the cancellation of an approved or expired case, and freezes a cancelled case; it cannot recompute the status.';
COMMENT ON COLUMN trust.verification_cases.revision IS 'Concurrency token of the case: the service bumps it on every change of the case or of any of its requirements, and a submit that names a revision is refused when it differs (STALE_CASE).';
COMMENT ON COLUMN trust.verification_cases.submitted_at IS 'When the provider first submitted evidence. Set once by the guard when the case leaves OPEN, never cleared.';
COMMENT ON COLUMN trust.verification_cases.decided_at IS 'When the case last became APPROVED (set by the guard); kept after a later expiry as the time of the last approval.';

CREATE TABLE trust.case_requirements (
  case_requirement_id       uuid        NOT NULL DEFAULT gen_random_uuid(),
  verification_case_id      uuid        NOT NULL,
  requirement_definition_id uuid        NOT NULL,
  cycle                     integer     NOT NULL DEFAULT 1,
  status                    text        NOT NULL DEFAULT 'NOT_STARTED',
  round                     integer     NOT NULL DEFAULT 0,
  revision                  integer     NOT NULL DEFAULT 1,
  required_at               timestamptz NOT NULL DEFAULT now(),
  submitted_at              timestamptz,
  decided_at                timestamptz,
  approved_at               timestamptz,
  expires_at                timestamptz,
  superseded_at             timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_case_requirements PRIMARY KEY (case_requirement_id),
  CONSTRAINT uq_case_requirements__cycle UNIQUE (verification_case_id, requirement_definition_id, cycle),
  CONSTRAINT fk_case_requirements__case_id FOREIGN KEY (verification_case_id) REFERENCES trust.verification_cases (verification_case_id) ON DELETE RESTRICT,
  CONSTRAINT fk_case_requirements__definition_id FOREIGN KEY (requirement_definition_id) REFERENCES trust.requirement_definitions (requirement_definition_id) ON DELETE RESTRICT,
  CONSTRAINT ck_case_requirements__cycle CHECK (cycle >= 1),
  CONSTRAINT ck_case_requirements__round CHECK (round >= 0),
  CONSTRAINT ck_case_requirements__revision CHECK (revision >= 1),
  CONSTRAINT ck_case_requirements__status CHECK (status IN ('NOT_STARTED', 'PENDING', 'IN_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED', 'EXPIRED', 'NOT_REQUIRED')),
  CONSTRAINT ck_case_requirements__evidence CHECK (status NOT IN ('PENDING', 'IN_REVIEW', 'ACTION_REQUIRED', 'REJECTED', 'APPROVED', 'EXPIRED') OR (round >= 1 AND submitted_at IS NOT NULL)),
  CONSTRAINT ck_case_requirements__approval CHECK (
    (status IN ('APPROVED', 'EXPIRED') AND approved_at IS NOT NULL AND (expires_at IS NULL OR expires_at > approved_at) AND (status = 'APPROVED' OR expires_at IS NOT NULL))
    OR (status NOT IN ('APPROVED', 'EXPIRED') AND approved_at IS NULL AND expires_at IS NULL)),
  CONSTRAINT ck_case_requirements__superseded CHECK (superseded_at IS NULL OR status = 'EXPIRED')
);
CREATE UNIQUE INDEX uq_case_requirements__current ON trust.case_requirements (verification_case_id, requirement_definition_id) WHERE superseded_at IS NULL;
CREATE INDEX idx_case_requirements__queue ON trust.case_requirements (updated_at, case_requirement_id) WHERE status IN ('PENDING', 'IN_REVIEW') AND superseded_at IS NULL;
CREATE INDEX idx_case_requirements__expiry ON trust.case_requirements (expires_at, case_requirement_id) WHERE status = 'APPROVED' AND expires_at IS NOT NULL AND superseded_at IS NULL;
COMMENT ON TABLE trust.case_requirements IS 'ONE CYCLE of one requirement of one case: what a provider has to prove, and where it stands (TRUST-001). The definition id is the policy snapshot (stable, immutable identity; a policy change never edits an instance). A requirement that expired is re-verified by a NEW cycle (cycle + 1) in the same case; the superseded instance and its approval stay as history. Within a cycle every provider evidence submission increments ROUND, and every review and document names its round. No account id is stored: ownership is read through the case.';
COMMENT ON COLUMN trust.case_requirements.status IS 'NOT_STARTED, PENDING (evidence submitted), IN_REVIEW, ACTION_REQUIRED, REJECTED (both let the provider resubmit: PR-02.03), APPROVED, EXPIRED (terminal for the cycle), NOT_REQUIRED (policy no longer asks). Transitions are fixed by the guard.';
COMMENT ON COLUMN trust.case_requirements.round IS 'Number of evidence submissions in this cycle (0 until the first). Incremented by the guard on every move to PENDING.';
COMMENT ON COLUMN trust.case_requirements.expires_at IS 'End of the approval''s validity (reviewer-supplied from the evidence, required when the definition says expiry_required). NULL = does not expire. Expiry is DERIVABLE from this timestamp (an APPROVED instance past it reads EXPIRED); the EXPIRED status is recorded by a sweep and only once the time has passed.';
COMMENT ON COLUMN trust.case_requirements.superseded_at IS 'Set when a newer cycle replaced this one (only an EXPIRED instance can be superseded). The current instance of a requirement is the one with superseded_at NULL (unique per case and definition).';

-- =====================================================================================================================
-- 5. evidence: document metadata, reviews, external references
-- =====================================================================================================================
CREATE TABLE trust.documents (
  verification_document_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  case_requirement_id      uuid        NOT NULL,
  document_type_id         uuid        NOT NULL,
  object_key               text        NOT NULL,
  mime_type                text        NOT NULL,
  size_bytes               bigint      NOT NULL,
  sha256                   text,
  status                   text        NOT NULL DEFAULT 'UPLOAD_PENDING',
  scan_status              text        NOT NULL DEFAULT 'PENDING',
  round                    integer,
  upload_expires_at        timestamptz NOT NULL,
  finalized_at             timestamptz,
  scanned_at               timestamptz,
  submitted_at             timestamptz,
  withdrawn_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_documents PRIMARY KEY (verification_document_id),
  CONSTRAINT uq_documents__object_key UNIQUE (object_key),
  CONSTRAINT fk_documents__case_requirement_id FOREIGN KEY (case_requirement_id) REFERENCES trust.case_requirements (case_requirement_id) ON DELETE RESTRICT,
  CONSTRAINT fk_documents__document_type_id FOREIGN KEY (document_type_id) REFERENCES trust.document_types (document_type_id) ON DELETE RESTRICT,
  CONSTRAINT ck_documents__object_key CHECK (object_key ~ '^trust/evidence/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  CONSTRAINT ck_documents__mime CHECK (mime_type ~ '^[a-z]+/[a-z0-9.+-]+$' AND length(mime_type) <= 100),
  CONSTRAINT ck_documents__size CHECK (size_bytes BETWEEN 1 AND 52428800),
  CONSTRAINT ck_documents__sha256 CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_documents__status CHECK (status IN ('UPLOAD_PENDING', 'ATTACHED', 'SUBMITTED', 'WITHDRAWN', 'ABANDONED')),
  CONSTRAINT ck_documents__scan CHECK (scan_status IN ('PENDING', 'CLEAN', 'INFECTED', 'ERROR')),
  CONSTRAINT ck_documents__lifecycle CHECK (
    (status = 'UPLOAD_PENDING' AND sha256 IS NULL AND finalized_at IS NULL AND round IS NULL AND submitted_at IS NULL AND withdrawn_at IS NULL)
    OR (status = 'ATTACHED' AND sha256 IS NOT NULL AND finalized_at IS NOT NULL AND round IS NULL AND submitted_at IS NULL AND withdrawn_at IS NULL)
    OR (status = 'SUBMITTED' AND sha256 IS NOT NULL AND finalized_at IS NOT NULL AND round IS NOT NULL AND round >= 1 AND submitted_at IS NOT NULL AND withdrawn_at IS NULL)
    OR (status = 'WITHDRAWN' AND sha256 IS NOT NULL AND finalized_at IS NOT NULL AND round IS NULL AND submitted_at IS NULL AND withdrawn_at IS NOT NULL)
    OR (status = 'ABANDONED' AND round IS NULL AND submitted_at IS NULL))
);
CREATE INDEX idx_documents__requirement ON trust.documents (case_requirement_id, created_at);
COMMENT ON TABLE trust.documents IS 'METADATA of a document submitted as evidence (TRUST-001; SV-09.02: sensitive documents are access-controlled and audited). The file bytes are NEVER in PostgreSQL: they live in private object storage under an unguessable key that exposes no account, name or content. The size and content type are verified against the stored object and the SHA-256 is computed by the server from the stored bytes when the upload is finalized (a client value is only compared). A document is a draft (UPLOAD_PENDING, ATTACHED) until the provider submits, then SUBMITTED in a round and frozen; resubmission is a NEW document in a later round, never an overwrite. Identical content uploaded twice is two documents: the hash never approves anything. No row is deleted.';
COMMENT ON COLUMN trust.documents.object_key IS 'Server-generated key in the private bucket (trust/evidence/<case id>/<document id>). Never returned by an API, never logged, never in an event or an audit row.';
COMMENT ON COLUMN trust.documents.sha256 IS 'SHA-256 of the stored bytes, computed by the server at finalize. Integrity evidence for reviewers only; never exposed to the provider.';
COMMENT ON COLUMN trust.documents.scan_status IS 'PENDING, CLEAN, INFECTED, ERROR. Written by the scanning port only. When clean scans are required (configuration, default true) a document that is not CLEAN cannot be attached, submitted, reviewed or downloaded.';
COMMENT ON COLUMN trust.documents.round IS 'The evidence round of the requirement the document was submitted in; NULL while it is a draft.';
COMMENT ON COLUMN trust.documents.upload_expires_at IS 'End of the upload authorization. A finalize after it is refused and the document is ABANDONED.';

CREATE TABLE trust.reviews (
  review_id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  case_requirement_id uuid        NOT NULL,
  round               integer     NOT NULL,
  decision            text        NOT NULL,
  reason_code         text,
  reviewer            text        NOT NULL,
  expires_at          timestamptz,
  correlation_id      text        NOT NULL,
  reviewed_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pk_reviews PRIMARY KEY (review_id),
  CONSTRAINT fk_reviews__case_requirement_id FOREIGN KEY (case_requirement_id) REFERENCES trust.case_requirements (case_requirement_id) ON DELETE RESTRICT,
  CONSTRAINT fk_reviews__reason_code FOREIGN KEY (reason_code) REFERENCES trust.reason_codes (code) ON DELETE RESTRICT,
  CONSTRAINT ck_reviews__round CHECK (round >= 1),
  CONSTRAINT ck_reviews__decision CHECK (decision IN ('STARTED', 'APPROVED', 'REJECTED', 'ACTION_REQUIRED')),
  CONSTRAINT ck_reviews__reason CHECK (
    (decision IN ('STARTED', 'APPROVED') AND reason_code IS NULL)
    OR (decision IN ('REJECTED', 'ACTION_REQUIRED') AND reason_code IS NOT NULL)),
  CONSTRAINT ck_reviews__expires CHECK (expires_at IS NULL OR decision = 'APPROVED'),
  CONSTRAINT ck_reviews__reviewer CHECK (reviewer ~ '^(admin|external):[A-Za-z0-9._:@-]{1,160}$')
);
CREATE UNIQUE INDEX uq_reviews__decision ON trust.reviews (case_requirement_id, round) WHERE decision <> 'STARTED';
CREATE UNIQUE INDEX uq_reviews__started ON trust.reviews (case_requirement_id, round) WHERE decision = 'STARTED';
CREATE INDEX idx_reviews__requirement ON trust.reviews (case_requirement_id, reviewed_at);
COMMENT ON TABLE trust.reviews IS 'The immutable decisions on the evidence of a requirement (TRUST-001, AD-02: inspect evidence, choose an authorized action, record the reason). One STARTED and at most ONE terminal decision (APPROVED, REJECTED, ACTION_REQUIRED) per requirement and round, so two reviewers cannot both decide the same evidence and a decision on stale evidence is refused. STRUCTURED reason codes only: there is no free-text note column (a note would be sensitive text that can never be redacted). Append-only.';
COMMENT ON COLUMN trust.reviews.reviewer IS '`admin:<Keycloak subject>` (admin identities have no application account, DEBT-0046) or `external:<adapter>` for a decision relayed from an external verification provider. No name.';

CREATE TABLE trust.external_verifications (
  external_verification_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  case_requirement_id      uuid        NOT NULL,
  round                    integer     NOT NULL,
  adapter                  text        NOT NULL,
  external_id              text        NOT NULL,
  status                   text        NOT NULL DEFAULT 'CREATED',
  last_checked_at          timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_external_verifications PRIMARY KEY (external_verification_id),
  CONSTRAINT uq_external_verifications__external UNIQUE (adapter, external_id),
  CONSTRAINT uq_external_verifications__round UNIQUE (case_requirement_id, round),
  CONSTRAINT fk_external_verifications__case_requirement_id FOREIGN KEY (case_requirement_id) REFERENCES trust.case_requirements (case_requirement_id) ON DELETE RESTRICT,
  CONSTRAINT ck_external_verifications__round CHECK (round >= 1),
  CONSTRAINT ck_external_verifications__adapter CHECK (adapter ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT ck_external_verifications__external_id CHECK (external_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT ck_external_verifications__status CHECK (status IN ('CREATED', 'PENDING', 'APPROVED', 'REJECTED', 'ERROR', 'CANCELLED'))
);
COMMENT ON TABLE trust.external_verifications IS 'The reference to a verification run by an EXTERNAL provider through the adapter boundary (TRUST-001; ID.me may be one future adapter): the adapter name, the provider''s own identifier and the last status the adapter reported. No vendor payload, no personal attribute, no evidence is stored here (structured fields only); a decision relayed from the provider is recorded as a review by `external:<adapter>`. One per requirement and round.';
COMMENT ON COLUMN trust.external_verifications.external_id IS 'The external provider''s identifier of the verification (a reference, not a credential). Unique per adapter.';

-- =====================================================================================================================
-- 6. audit
-- =====================================================================================================================
CREATE TABLE trust.audit_events (
  audit_event_id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  occurred_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor                     text        NOT NULL,
  action                    text        NOT NULL,
  verification_case_id      uuid,
  case_requirement_id       uuid,
  requirement_definition_id uuid,
  changes                   jsonb,
  reason_code               text,
  correlation_id            text        NOT NULL,
  CONSTRAINT pk_audit_events PRIMARY KEY (audit_event_id),
  CONSTRAINT fk_audit_events__case_id FOREIGN KEY (verification_case_id) REFERENCES trust.verification_cases (verification_case_id) ON DELETE RESTRICT,
  CONSTRAINT fk_audit_events__case_requirement_id FOREIGN KEY (case_requirement_id) REFERENCES trust.case_requirements (case_requirement_id) ON DELETE RESTRICT,
  CONSTRAINT fk_audit_events__definition_id FOREIGN KEY (requirement_definition_id) REFERENCES trust.requirement_definitions (requirement_definition_id) ON DELETE RESTRICT,
  CONSTRAINT ck_audit_events__action CHECK (action IN (
    'VERIFICATION_CASE_OPENED', 'VERIFICATION_REQUIREMENTS_SYNCED', 'VERIFICATION_DOCUMENT_UPLOAD_AUTHORIZED', 'VERIFICATION_DOCUMENT_SUBMITTED', 'VERIFICATION_DOCUMENT_REPLACED',
    'VERIFICATION_DOCUMENT_UPLOAD_REFUSED', 'VERIFICATION_DOCUMENT_ACCESSED', 'VERIFICATION_SUBMITTED', 'VERIFICATION_REVIEW_STARTED', 'VERIFICATION_APPROVED', 'VERIFICATION_REJECTED',
    'VERIFICATION_ACTION_REQUIRED', 'VERIFICATION_EXPIRED', 'VERIFICATION_REVERIFICATION_REQUESTED', 'VERIFICATION_CASE_CANCELLED', 'VERIFICATION_EXTERNAL_STARTED',
    'VERIFICATION_EXTERNAL_UPDATED', 'TRUST_REQUIREMENT_STATUS_CHANGED', 'TRUST_RULE_CHANGED')),
  CONSTRAINT ck_audit_events__subject CHECK (verification_case_id IS NOT NULL OR case_requirement_id IS NOT NULL OR requirement_definition_id IS NOT NULL),
  CONSTRAINT ck_audit_events__changes_object CHECK (changes IS NULL OR jsonb_typeof(changes) = 'object'),
  CONSTRAINT ck_audit_events__actor CHECK (length(btrim(actor)) > 0 AND length(actor) <= 200)
);
COMMENT ON TABLE trust.audit_events IS 'Immutable audit trail of the verification domain (TRUST-001). `changes` holds identifiers, codes, statuses and counts only: never document content, an object key, a hash, a signed URL, a vendor payload or personal data. Every read of evidence by a reviewer is recorded (VERIFICATION_DOCUMENT_ACCESSED). The case, requirement and definition columns have no index of their own: the table is written once and read only for investigation.';
COMMENT ON COLUMN trust.audit_events.actor IS '`account:<id>` (the provider), `admin:<subject>` (staff), `external:<adapter>` or `system:<job>`.';

-- =====================================================================================================================
-- 7. guards (SQLSTATE 23000, DETAIL `trust_rule:<KEY>`), immutability and TRUNCATE refusal
--    Lock order (the services follow it): case row FOR UPDATE -> requirement rows FOR UPDATE -> document rows. The guards read their parents FOR SHARE.
-- =====================================================================================================================
CREATE FUNCTION trust.guard_requirement_definitions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a requirement definition is never deleted: retire it' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('INACTIVE', 'ACTIVE') THEN
      RAISE EXCEPTION 'a requirement definition starts INACTIVE or ACTIVE' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:INITIAL_STATUS';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.requirement_definition_id, NEW.code, NEW.requirement_type, NEW.evidence_kind, NEW.created_at) IS DISTINCT FROM (OLD.requirement_definition_id, OLD.code, OLD.requirement_type, OLD.evidence_kind, OLD.created_at) THEN
    RAISE EXCEPTION 'the id, code, type and evidence kind of a requirement definition are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:IMMUTABLE_IDENTITY';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status || '>' || NEW.status) = ANY (ARRAY['INACTIVE>ACTIVE', 'ACTIVE>INACTIVE', 'INACTIVE>RETIRED', 'ACTIVE>RETIRED'])) THEN
      RAISE EXCEPTION 'the status transition is not allowed' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:STATUS_TRANSITION';
    END IF;
  ELSIF OLD.status = 'RETIRED' AND NEW.expiry_required IS DISTINCT FROM OLD.expiry_required THEN
    RAISE EXCEPTION 'a retired requirement definition is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:STATUS_TRANSITION';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_requirement_definitions__guard BEFORE INSERT OR UPDATE OR DELETE ON trust.requirement_definitions FOR EACH ROW EXECUTE FUNCTION trust.guard_requirement_definitions();
CREATE TRIGGER trg_requirement_definitions__no_truncate BEFORE TRUNCATE ON trust.requirement_definitions FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation();

CREATE FUNCTION trust.guard_document_types() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a document type is never deleted: deactivate it' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.document_type_id, NEW.code, NEW.requirement_type, NEW.created_at) IS DISTINCT FROM (OLD.document_type_id, OLD.code, OLD.requirement_type, OLD.created_at) THEN
      RAISE EXCEPTION 'the id, code and requirement type of a document type are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:IMMUTABLE_IDENTITY';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_document_types__guard BEFORE INSERT OR UPDATE OR DELETE ON trust.document_types FOR EACH ROW EXECUTE FUNCTION trust.guard_document_types();
CREATE TRIGGER trg_document_types__no_truncate BEFORE TRUNCATE ON trust.document_types FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation();

CREATE FUNCTION trust.guard_reason_codes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a reason code is never deleted: deactivate it' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.reason_code_id, NEW.code, NEW.applies_to, NEW.created_at) IS DISTINCT FROM (OLD.reason_code_id, OLD.code, OLD.applies_to, OLD.created_at) THEN
      RAISE EXCEPTION 'the id, code and scope of a reason code are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:IMMUTABLE_IDENTITY';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_reason_codes__guard BEFORE INSERT OR UPDATE OR DELETE ON trust.reason_codes FOR EACH ROW EXECUTE FUNCTION trust.guard_reason_codes();
CREATE TRIGGER trg_reason_codes__no_truncate BEFORE TRUNCATE ON trust.reason_codes FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation();

CREATE FUNCTION trust.guard_requirement_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a requirement rule is never deleted: switch it off' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.requirement_rule_id, NEW.requirement_definition_id, NEW.market_id, NEW.service_type_id, NEW.created_at)
     IS DISTINCT FROM (OLD.requirement_rule_id, OLD.requirement_definition_id, OLD.market_id, OLD.service_type_id, OLD.created_at) THEN
    RAISE EXCEPTION 'the definition, market and service type of a rule are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:IMMUTABLE_IDENTITY';
  END IF;
  IF NEW.enabled THEN
    SELECT status INTO d_status FROM trust.requirement_definitions WHERE requirement_definition_id = NEW.requirement_definition_id FOR SHARE;
    IF d_status = 'RETIRED' THEN
      RAISE EXCEPTION 'a retired requirement definition cannot be required' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:RULE_DEFINITION_RETIRED';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_requirement_rules__guard BEFORE INSERT OR UPDATE OR DELETE ON trust.requirement_rules FOR EACH ROW EXECUTE FUNCTION trust.guard_requirement_rules();
CREATE TRIGGER trg_requirement_rules__no_truncate BEFORE TRUNCATE ON trust.requirement_rules FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation();

CREATE FUNCTION trust.guard_verification_cases() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a_status text;
  v_max    integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a verification case is never deleted: cancel it' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' OR NEW.revision <> 1 OR NEW.submitted_at IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'a verification case starts OPEN at revision 1' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:CASE_MUST_START_OPEN';
    END IF;
    SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id FOR SHARE;
    IF a_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'only an ACTIVE account can open a verification case' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:ACCOUNT_NOT_ACTIVE';
    END IF;
    SELECT COALESCE(max(case_number), 0) INTO v_max FROM trust.verification_cases WHERE account_id = NEW.account_id;
    IF NEW.case_number <> v_max + 1 THEN
      RAISE EXCEPTION 'case numbers are contiguous: the next case is the highest plus one' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:CASE_NUMBER_SEQUENCE';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.verification_case_id, NEW.account_id, NEW.case_number, NEW.created_at) IS DISTINCT FROM (OLD.verification_case_id, OLD.account_id, OLD.case_number, OLD.created_at) THEN
    RAISE EXCEPTION 'the id, the account and the number of a verification case are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:IMMUTABLE_IDENTITY';
  END IF;
  IF OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'a cancelled verification case is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:CASE_FROZEN';
  END IF;
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'the revision of a verification case only grows' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:REVISION_ONLY_GROWS';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NEW.status = 'OPEN' THEN
      RAISE EXCEPTION 'a submitted verification case never returns to OPEN' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:STATUS_TRANSITION';
    END IF;
    IF NEW.status = 'CANCELLED' AND OLD.status NOT IN ('OPEN', 'IN_REVIEW', 'ACTION_REQUIRED') THEN
      RAISE EXCEPTION 'only a case that is not approved or expired can be cancelled' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:STATUS_TRANSITION';
    END IF;
  END IF;
  IF NEW.status = 'CANCELLED' THEN
    NEW.submitted_at := OLD.submitted_at;
    NEW.decided_at := OLD.decided_at;
    NEW.cancelled_at := now();
  ELSE
    NEW.submitted_at := COALESCE(OLD.submitted_at, CASE WHEN NEW.status = 'OPEN' THEN NULL ELSE now() END);
    NEW.cancelled_at := NULL;
    IF NEW.status = 'APPROVED' AND OLD.status <> 'APPROVED' THEN
      NEW.decided_at := now();
    ELSE
      NEW.decided_at := OLD.decided_at;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_verification_cases__guard BEFORE INSERT OR UPDATE OR DELETE ON trust.verification_cases FOR EACH ROW EXECUTE FUNCTION trust.guard_verification_cases();
CREATE TRIGGER trg_verification_cases__no_truncate BEFORE TRUNCATE ON trust.verification_cases FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation();

CREATE FUNCTION trust.guard_case_requirements() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c_status  text;
  d_status  text;
  d_expiry  boolean;
  v_max     integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a case requirement is never deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO c_status FROM trust.verification_cases WHERE verification_case_id = NEW.verification_case_id FOR SHARE;
    IF c_status IS NULL OR c_status = 'CANCELLED' THEN
      RAISE EXCEPTION 'a cancelled verification case is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:CASE_FROZEN';
    END IF;
    SELECT status INTO d_status FROM trust.requirement_definitions WHERE requirement_definition_id = NEW.requirement_definition_id FOR SHARE;
    IF d_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'only an ACTIVE requirement definition can be asked of a provider' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:REQUIREMENT_NOT_ACTIVE';
    END IF;
    IF NEW.status <> 'NOT_STARTED' OR NEW.round <> 0 OR NEW.revision <> 1 OR NEW.submitted_at IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.approved_at IS NOT NULL
       OR NEW.expires_at IS NOT NULL OR NEW.superseded_at IS NOT NULL THEN
      RAISE EXCEPTION 'a case requirement starts NOT_STARTED at round 0' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:MUST_START_NOT_STARTED';
    END IF;
    SELECT COALESCE(max(cycle), 0) INTO v_max FROM trust.case_requirements WHERE verification_case_id = NEW.verification_case_id AND requirement_definition_id = NEW.requirement_definition_id;
    IF NEW.cycle <> v_max + 1 THEN
      RAISE EXCEPTION 'cycles are contiguous: the next cycle is the highest plus one' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:CYCLE_SEQUENCE';
    END IF;
    IF v_max >= 1 AND NOT EXISTS (
      SELECT 1 FROM trust.case_requirements
      WHERE verification_case_id = NEW.verification_case_id AND requirement_definition_id = NEW.requirement_definition_id AND cycle = v_max AND status = 'EXPIRED' AND superseded_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a new cycle replaces an EXPIRED, superseded one' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:CYCLE_NEEDS_EXPIRED';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.case_requirement_id, NEW.verification_case_id, NEW.requirement_definition_id, NEW.cycle, NEW.created_at, NEW.required_at)
     IS DISTINCT FROM (OLD.case_requirement_id, OLD.verification_case_id, OLD.requirement_definition_id, OLD.cycle, OLD.created_at, OLD.required_at) THEN
    RAISE EXCEPTION 'the identity of a case requirement is immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:IMMUTABLE_IDENTITY';
  END IF;
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'a superseded cycle is frozen history' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:SUPERSEDED_FROZEN';
  END IF;
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'the revision of a case requirement only grows' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:REVISION_ONLY_GROWS';
  END IF;
  SELECT status INTO c_status FROM trust.verification_cases WHERE verification_case_id = NEW.verification_case_id FOR SHARE;
  IF c_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'a cancelled verification case is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:CASE_FROZEN';
  END IF;
  IF NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    IF OLD.status <> 'EXPIRED' OR NEW.status <> OLD.status OR (NEW.round, NEW.submitted_at, NEW.decided_at, NEW.approved_at, NEW.expires_at) IS DISTINCT FROM (OLD.round, OLD.submitted_at, OLD.decided_at, OLD.approved_at, OLD.expires_at) THEN
      RAISE EXCEPTION 'only an EXPIRED cycle can be superseded, and nothing else changes with it' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:SUPERSEDE_STATE';
    END IF;
    NEW.superseded_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status THEN
    -- the evidence and decision timestamps are the database's: a caller-supplied value is never stored
    NEW.submitted_at := OLD.submitted_at;
    NEW.decided_at := OLD.decided_at;
    IF NOT ((OLD.status || '>' || NEW.status) = ANY (ARRAY[
      'NOT_STARTED>PENDING', 'NOT_STARTED>NOT_REQUIRED', 'PENDING>IN_REVIEW', 'PENDING>ACTION_REQUIRED', 'PENDING>APPROVED', 'PENDING>REJECTED', 'PENDING>NOT_REQUIRED',
      'IN_REVIEW>ACTION_REQUIRED', 'IN_REVIEW>APPROVED', 'IN_REVIEW>REJECTED', 'IN_REVIEW>NOT_REQUIRED', 'ACTION_REQUIRED>PENDING', 'ACTION_REQUIRED>NOT_REQUIRED',
      'REJECTED>PENDING', 'REJECTED>NOT_REQUIRED', 'APPROVED>EXPIRED', 'NOT_REQUIRED>NOT_STARTED'])) THEN
      RAISE EXCEPTION 'the status transition is not allowed' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:STATUS_TRANSITION';
    END IF;
    IF NEW.status = 'PENDING' AND OLD.status IN ('NOT_STARTED', 'ACTION_REQUIRED', 'REJECTED') THEN
      IF NEW.round <> OLD.round + 1 THEN
        RAISE EXCEPTION 'every evidence submission starts the next round' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:ROUND_SEQUENCE';
      END IF;
      NEW.submitted_at := now();
    ELSIF NEW.round <> OLD.round THEN
      RAISE EXCEPTION 'the round only changes with a new submission' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:ROUND_SEQUENCE';
    END IF;
    IF NEW.status IN ('APPROVED', 'REJECTED', 'ACTION_REQUIRED') THEN
      NEW.decided_at := now();
    END IF;
    IF NEW.status = 'APPROVED' THEN
      SELECT expiry_required INTO d_expiry FROM trust.requirement_definitions WHERE requirement_definition_id = NEW.requirement_definition_id FOR SHARE;
      IF d_expiry AND NEW.expires_at IS NULL THEN
        RAISE EXCEPTION 'this requirement is approved with an expiry date' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:EXPIRY_REQUIRED';
      END IF;
      IF NEW.expires_at IS NOT NULL AND NEW.expires_at <= now() THEN
        RAISE EXCEPTION 'an approval cannot already be expired' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:EXPIRY_IN_PAST';
      END IF;
      NEW.approved_at := now();
    ELSIF NEW.status = 'EXPIRED' THEN
      IF OLD.expires_at IS NULL OR OLD.expires_at > clock_timestamp() THEN
        RAISE EXCEPTION 'an approval expires only when its end has passed' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:EXPIRY_NOT_REACHED';
      END IF;
      NEW.approved_at := OLD.approved_at;
      NEW.expires_at := OLD.expires_at;
    ELSE
      NEW.approved_at := NULL;
      NEW.expires_at := NULL;
    END IF;
  ELSIF (NEW.round, NEW.submitted_at, NEW.decided_at, NEW.approved_at, NEW.expires_at) IS DISTINCT FROM (OLD.round, OLD.submitted_at, OLD.decided_at, OLD.approved_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'the evidence and decision fields change only with the status' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:FIELDS_FROZEN';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_case_requirements__guard BEFORE INSERT OR UPDATE OR DELETE ON trust.case_requirements FOR EACH ROW EXECUTE FUNCTION trust.guard_case_requirements();
CREATE TRIGGER trg_case_requirements__no_truncate BEFORE TRUNCATE ON trust.case_requirements FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation();

CREATE FUNCTION trust.guard_documents() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  i  record;
  dt record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a document is never deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT cr.status, cr.superseded_at, d.requirement_type, d.evidence_kind, c.status AS case_status INTO i
    FROM trust.case_requirements cr JOIN trust.requirement_definitions d ON d.requirement_definition_id = cr.requirement_definition_id
         JOIN trust.verification_cases c ON c.verification_case_id = cr.verification_case_id
    WHERE cr.case_requirement_id = NEW.case_requirement_id FOR SHARE OF cr, c;
    IF FOUND AND i.case_status = 'CANCELLED' THEN
      RAISE EXCEPTION 'a cancelled verification case is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:CASE_FROZEN';
    END IF;
    IF NOT FOUND OR i.superseded_at IS NOT NULL OR i.status NOT IN ('NOT_STARTED', 'ACTION_REQUIRED', 'REJECTED') THEN
      RAISE EXCEPTION 'evidence can be added only while the requirement waits for it' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:DOCUMENT_REQUIREMENT_STATE';
    END IF;
    IF i.evidence_kind <> 'DOCUMENT' THEN
      RAISE EXCEPTION 'this requirement is evidenced externally, not by documents' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:DOCUMENT_NOT_SUPPORTED';
    END IF;
    SELECT requirement_type, status INTO dt FROM trust.document_types WHERE document_type_id = NEW.document_type_id FOR SHARE;
    IF dt.requirement_type IS DISTINCT FROM i.requirement_type OR dt.status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'this document type does not evidence this requirement' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:DOCUMENT_TYPE_MISMATCH';
    END IF;
    IF NEW.status <> 'UPLOAD_PENDING' OR NEW.scan_status <> 'PENDING' THEN
      RAISE EXCEPTION 'a document starts UPLOAD_PENDING and unscanned' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:DOCUMENT_MUST_START_PENDING';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.verification_document_id, NEW.case_requirement_id, NEW.document_type_id, NEW.object_key, NEW.mime_type, NEW.size_bytes, NEW.upload_expires_at, NEW.created_at)
     IS DISTINCT FROM (OLD.verification_document_id, OLD.case_requirement_id, OLD.document_type_id, OLD.object_key, OLD.mime_type, OLD.size_bytes, OLD.upload_expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'the metadata of a document is immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:IMMUTABLE_IDENTITY';
  END IF;
  IF OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN
    RAISE EXCEPTION 'the hash of a document is set once' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:HASH_IMMUTABLE';
  END IF;
  IF NEW.scan_status <> OLD.scan_status THEN
    IF NOT ((OLD.scan_status || '>' || NEW.scan_status) = ANY (ARRAY['PENDING>CLEAN', 'PENDING>INFECTED', 'PENDING>ERROR', 'ERROR>PENDING', 'ERROR>CLEAN', 'ERROR>INFECTED', 'CLEAN>INFECTED'])) THEN
      RAISE EXCEPTION 'the scan status transition is not allowed' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:SCAN_TRANSITION';
    END IF;
    NEW.scanned_at := CASE WHEN NEW.scan_status = 'PENDING' THEN NULL ELSE now() END;
  ELSE
    NEW.scanned_at := OLD.scanned_at;
  END IF;
  IF NEW.status <> OLD.status THEN
    IF OLD.status IN ('SUBMITTED', 'WITHDRAWN', 'ABANDONED') THEN
      RAISE EXCEPTION 'a submitted, withdrawn or abandoned document is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:DOCUMENT_FROZEN';
    END IF;
    IF NOT ((OLD.status || '>' || NEW.status) = ANY (ARRAY['UPLOAD_PENDING>ATTACHED', 'UPLOAD_PENDING>ABANDONED', 'ATTACHED>SUBMITTED', 'ATTACHED>WITHDRAWN'])) THEN
      RAISE EXCEPTION 'the status transition is not allowed' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:STATUS_TRANSITION';
    END IF;
    IF NEW.status = 'ATTACHED' THEN
      SELECT cr.status, cr.superseded_at, c.status AS case_status INTO i
      FROM trust.case_requirements cr JOIN trust.verification_cases c ON c.verification_case_id = cr.verification_case_id
      WHERE cr.case_requirement_id = NEW.case_requirement_id FOR SHARE OF cr, c;
      IF i.case_status = 'CANCELLED' THEN
        RAISE EXCEPTION 'a cancelled verification case is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:CASE_FROZEN';
      END IF;
      IF i.superseded_at IS NOT NULL OR i.status NOT IN ('NOT_STARTED', 'ACTION_REQUIRED', 'REJECTED') THEN
        RAISE EXCEPTION 'evidence can be added only while the requirement waits for it' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:DOCUMENT_REQUIREMENT_STATE';
      END IF;
      NEW.finalized_at := now();
    ELSIF NEW.status = 'SUBMITTED' THEN
      SELECT cr.status, cr.round, c.status AS case_status INTO i
      FROM trust.case_requirements cr JOIN trust.verification_cases c ON c.verification_case_id = cr.verification_case_id
      WHERE cr.case_requirement_id = NEW.case_requirement_id FOR SHARE OF cr, c;
      IF i.case_status = 'CANCELLED' THEN
        RAISE EXCEPTION 'a cancelled verification case is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:CASE_FROZEN';
      END IF;
      IF i.status <> 'PENDING' OR NEW.round IS DISTINCT FROM i.round THEN
        RAISE EXCEPTION 'a document is submitted in the round its requirement was just submitted in' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:DOCUMENT_ROUND';
      END IF;
      NEW.submitted_at := now();
    ELSIF NEW.status = 'WITHDRAWN' THEN
      NEW.withdrawn_at := now();
    END IF;
  ELSIF OLD.status IN ('SUBMITTED', 'WITHDRAWN', 'ABANDONED') AND (NEW.sha256, NEW.finalized_at, NEW.round, NEW.submitted_at, NEW.withdrawn_at) IS DISTINCT FROM (OLD.sha256, OLD.finalized_at, OLD.round, OLD.submitted_at, OLD.withdrawn_at) THEN
    RAISE EXCEPTION 'a submitted, withdrawn or abandoned document is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:DOCUMENT_FROZEN';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_documents__guard BEFORE INSERT OR UPDATE OR DELETE ON trust.documents FOR EACH ROW EXECUTE FUNCTION trust.guard_documents();
CREATE TRIGGER trg_documents__no_truncate BEFORE TRUNCATE ON trust.documents FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation();

CREATE FUNCTION trust.guard_reviews() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  i record;
  r record;
BEGIN
  SELECT cr.status, cr.round, cr.expires_at, cr.superseded_at, c.status AS case_status INTO i
  FROM trust.case_requirements cr JOIN trust.verification_cases c ON c.verification_case_id = cr.verification_case_id
  WHERE cr.case_requirement_id = NEW.case_requirement_id FOR SHARE OF cr, c;
  IF i.case_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'a cancelled verification case is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:CASE_FROZEN';
  END IF;
  IF i.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'a superseded cycle cannot be reviewed' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:REVIEW_SUPERSEDED';
  END IF;
  IF NEW.round <> i.round THEN
    RAISE EXCEPTION 'a review names the evidence round the requirement is in' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:REVIEW_ROUND';
  END IF;
  IF NOT ((NEW.decision = 'STARTED' AND i.status = 'IN_REVIEW') OR (NEW.decision = 'APPROVED' AND i.status = 'APPROVED')
          OR (NEW.decision = 'REJECTED' AND i.status = 'REJECTED') OR (NEW.decision = 'ACTION_REQUIRED' AND i.status = 'ACTION_REQUIRED')) THEN
    RAISE EXCEPTION 'a review records the state the requirement was just moved to' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:REVIEW_STATE';
  END IF;
  IF NEW.decision = 'APPROVED' AND NEW.expires_at IS DISTINCT FROM i.expires_at THEN
    RAISE EXCEPTION 'an approval review carries the expiry the requirement was approved with' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:REVIEW_EXPIRY';
  END IF;
  IF NEW.reason_code IS NOT NULL THEN
    SELECT status, applies_to INTO r FROM trust.reason_codes WHERE code = NEW.reason_code FOR SHARE;
    IF r.status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'this reason code is not in use' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:REASON_INACTIVE';
    END IF;
    IF NOT (r.applies_to = 'BOTH' OR (r.applies_to = 'REJECT' AND NEW.decision = 'REJECTED') OR (r.applies_to = 'ACTION_REQUIRED' AND NEW.decision = 'ACTION_REQUIRED')) THEN
      RAISE EXCEPTION 'this reason code does not apply to this decision' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:REASON_NOT_APPLICABLE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_reviews__guard BEFORE INSERT ON trust.reviews FOR EACH ROW EXECUTE FUNCTION trust.guard_reviews();
CREATE TRIGGER trg_reviews__immutable BEFORE UPDATE OR DELETE ON trust.reviews FOR EACH ROW EXECUTE FUNCTION trust.forbid_mutation();
CREATE TRIGGER trg_reviews__no_truncate BEFORE TRUNCATE ON trust.reviews FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation();

CREATE FUNCTION trust.guard_external_verifications() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  i record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an external verification reference is never deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT cr.status, cr.round, cr.superseded_at, d.evidence_kind, c.status AS case_status INTO i
    FROM trust.case_requirements cr JOIN trust.requirement_definitions d ON d.requirement_definition_id = cr.requirement_definition_id
         JOIN trust.verification_cases c ON c.verification_case_id = cr.verification_case_id
    WHERE cr.case_requirement_id = NEW.case_requirement_id FOR SHARE OF cr, c;
    IF FOUND AND i.case_status = 'CANCELLED' THEN
      RAISE EXCEPTION 'a cancelled verification case is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:CASE_FROZEN';
    END IF;
    IF NOT FOUND OR i.evidence_kind <> 'EXTERNAL' THEN
      RAISE EXCEPTION 'this requirement is not verified by an external provider' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:EXTERNAL_NOT_SUPPORTED';
    END IF;
    IF i.superseded_at IS NOT NULL OR i.status NOT IN ('PENDING', 'IN_REVIEW') OR NEW.round <> i.round OR NEW.status <> 'CREATED' THEN
      RAISE EXCEPTION 'an external verification belongs to the round the requirement was just submitted in' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:EXTERNAL_STATE';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.external_verification_id, NEW.case_requirement_id, NEW.round, NEW.adapter, NEW.external_id, NEW.created_at)
     IS DISTINCT FROM (OLD.external_verification_id, OLD.case_requirement_id, OLD.round, OLD.adapter, OLD.external_id, OLD.created_at) THEN
    RAISE EXCEPTION 'the identity of an external verification reference is immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:IMMUTABLE_IDENTITY';
  END IF;
  IF OLD.status IN ('APPROVED', 'REJECTED', 'CANCELLED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a finished external verification is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'trust_rule:EXTERNAL_FROZEN';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_external_verifications__guard BEFORE INSERT OR UPDATE OR DELETE ON trust.external_verifications FOR EACH ROW EXECUTE FUNCTION trust.guard_external_verifications();
CREATE TRIGGER trg_external_verifications__no_truncate BEFORE TRUNCATE ON trust.external_verifications FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation();

CREATE TRIGGER trg_audit_events__immutable BEFORE UPDATE OR DELETE ON trust.audit_events FOR EACH ROW EXECUTE FUNCTION trust.forbid_mutation();
CREATE TRIGGER trg_audit_events__no_truncate BEFORE TRUNCATE ON trust.audit_events FOR EACH STATEMENT EXECUTE FUNCTION trust.forbid_mutation();

COMMENT ON FUNCTION trust.guard_requirement_definitions() IS 'Guard of trust.requirement_definitions: never deleted, immutable identity, INACTIVE <-> ACTIVE -> RETIRED (terminal).';
COMMENT ON FUNCTION trust.guard_document_types() IS 'Guard of trust.document_types: never deleted, immutable code and requirement type.';
COMMENT ON FUNCTION trust.guard_reason_codes() IS 'Guard of trust.reason_codes: never deleted, immutable code and scope.';
COMMENT ON FUNCTION trust.guard_requirement_rules() IS 'Guard of trust.requirement_rules: never deleted, immutable scope, a retired definition cannot be required.';
COMMENT ON FUNCTION trust.guard_verification_cases() IS 'Guard of trust.verification_cases: starts OPEN at revision 1 for an ACTIVE account, contiguous case numbers, never back to OPEN, only an undecided case can be cancelled, a cancelled case is frozen; stamps submitted_at, decided_at and cancelled_at. It cannot recompute the status (the service derives it).';
COMMENT ON FUNCTION trust.guard_case_requirements() IS 'Guard of trust.case_requirements: the requirement status matrix, round and cycle sequencing, expiry rules, supersede rules and frozen history; stamps the evidence and decision timestamps itself.';
COMMENT ON FUNCTION trust.guard_documents() IS 'Guard of trust.documents: evidence only while the requirement waits for it and the case is live, immutable metadata, hash set once, scan and status transitions, frozen after submission.';
COMMENT ON FUNCTION trust.guard_reviews() IS 'Guard of trust.reviews (insert only): the review records the state and round the requirement was just moved to, with an applicable active reason.';
COMMENT ON FUNCTION trust.guard_external_verifications() IS 'Guard of trust.external_verifications: only for externally evidenced requirements in the round just submitted, immutable identity, finished verifications are frozen.';

-- =====================================================================================================================
-- 8. seed: the evidence policy (CFG-001), through the real configuration lifecycle
--    Typed values at PLATFORM scope, read fresh by the service, no code default (a missing or invalid value fails closed). STANDARD criticality: operational policy.
--    All six are ENGINEERING ASSUMPTIONS (the PRD fixes none of them); they are flagged in DEBT-0087 and are configuration, not code.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_approver    constant text := 'system:migration-review';
  v_correlation constant text := 'seed-0019';
  v_seed        record;
  v_parameter   uuid;
  v_request     uuid;
  v_holder      uuid;
  v_version     uuid;
  v_reason      text;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1, 'trust.document.max_size_bytes', 'INTEGER', 'bytes', 'Largest size of one verification document', '{"min": 1024, "max": 52428800}'::jsonb,
          '10485760'::jsonb, 'TRUST-001 engineering assumption, not in the PRD (10 MiB: enough for a phone photo or a scanned page; bounds the upload)'),
      (2, 'trust.document.allowed_mime_types', 'JSON', NULL::text, 'Content types accepted for verification documents: a list of MIME types; each needs a file-signature check in the service', '{"schema": {"type": "array", "items": {"type": "string", "pattern": "^[a-z]+/[a-z0-9.+-]+$"}, "uniqueItems": true, "minItems": 1, "maxItems": 10}}'::jsonb,
          '["application/pdf", "image/jpeg", "image/png"]'::jsonb, 'TRUST-001 engineering assumption, not in the PRD (the formats a person can produce with a phone)'),
      (3, 'trust.document.max_per_requirement', 'INTEGER', 'documents', 'Most documents a provider can attach to one requirement in one submission', '{"min": 1, "max": 20}'::jsonb,
          '5'::jsonb, 'TRUST-001 engineering assumption, not in the PRD (bounds the evidence of one submission)'),
      (4, 'trust.document.upload_url_ttl_seconds', 'INTEGER', 'seconds', 'How long an upload authorization stays valid', '{"min": 60, "max": 3600}'::jsonb,
          '300'::jsonb, 'TRUST-001 engineering assumption, not in the PRD (short-lived, single object)'),
      (5, 'trust.document.download_url_ttl_seconds', 'INTEGER', 'seconds', 'How long a reviewer download link stays valid', '{"min": 15, "max": 900}'::jsonb,
          '60'::jsonb, 'TRUST-001 engineering assumption, not in the PRD (SV-09.02: sensitive documents are access-controlled; links are short-lived)'),
      (6, 'trust.verification.require_clean_scan', 'BOOLEAN', NULL::text, 'Whether a verification document must pass the malware scan (CLEAN) before it can be attached, reviewed or downloaded', '{}'::jsonb,
          'true'::jsonb, 'TRUST-001: fail closed. Production has no scanner yet (DEBT-0087), so with this on nothing can be attached there until one exists; DEV and TEST use the fake scanner')
    ) AS t (ord, key, data_type, unit, description, rules, value, basis)
    ORDER BY ord
  LOOP
    v_reason := 'Initial value (migration 0019): ' || v_seed.basis;
    INSERT INTO configuration.parameters (key, data_type, unit, description, owner_role, validation_rules, sensitivity, approval_policy, criticality, is_required, created_by)
    VALUES (v_seed.key, v_seed.data_type, v_seed.unit, v_seed.description, 'platform', v_seed.rules, 'INTERNAL', 'SECOND_APPROVER', 'STANDARD', true, v_actor)
    RETURNING parameter_id INTO v_parameter;
    INSERT INTO configuration.parameter_scopes (parameter_id, scope_type) VALUES (v_parameter, 'PLATFORM');
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'PARAMETER_CREATED', v_parameter, 'parameter definition created', v_correlation);

    INSERT INTO configuration.change_requests (parameter_id, scope_type, scope_ref, proposed_value, effective_from, reason, requested_by, approval_policy)
    VALUES (v_parameter, 'PLATFORM', NULL, v_seed.value, v_from, v_reason, v_actor, 'SECOND_APPROVER')
    RETURNING change_request_id INTO v_request;
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, change_request_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'CHANGE_DRAFTED', v_parameter, v_request, v_reason, v_correlation);

    UPDATE configuration.change_requests SET state = 'PENDING_APPROVAL', updated_at = now() WHERE change_request_id = v_request AND state = 'DRAFT';
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, change_request_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'CHANGE_SUBMITTED', v_parameter, v_request, v_reason, v_correlation);

    INSERT INTO configuration.change_approvals (change_request_id, approver, decision, comment)
    VALUES (v_request, v_approver, 'APPROVE', 'Initial value reviewed with the migration (TRUST-001)');
    UPDATE configuration.change_requests SET state = 'APPROVED', updated_at = now() WHERE change_request_id = v_request AND state = 'PENDING_APPROVAL';
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, change_request_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_approver, 'CHANGE_APPROVED', v_parameter, v_request, 'Initial value reviewed with the migration (TRUST-001)', v_correlation);

    INSERT INTO configuration.parameter_values (parameter_id, scope_type, scope_ref) VALUES (v_parameter, 'PLATFORM', NULL) RETURNING parameter_value_id INTO v_holder;
    INSERT INTO configuration.value_versions (parameter_value_id, version, value, effective_from, reason, created_by)
    VALUES (v_holder, 1, v_seed.value, v_from, v_reason, v_actor)
    RETURNING version_id INTO v_version;
    UPDATE configuration.change_requests SET state = 'ACTIVE', value_version_id = v_version, updated_at = now() WHERE change_request_id = v_request AND state = 'APPROVED';
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, change_request_id, new_version_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'CHANGE_PUBLISHED', v_parameter, v_request, v_version, v_reason, v_correlation);
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, change_request_id, new_version_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'CHANGE_ACTIVATED', v_parameter, v_request, v_version, v_reason, v_correlation);
  END LOOP;
END
$seed$;

-- =====================================================================================================================
-- 9. seed: the copy of the verification flow and its reference data (CFG-002), through the real content lifecycle (en-US only)
--    Requirement names and instructions, document type names, reason messages, status labels, error messages and the page text of the TEMPORARY minimal flow; NO LEGAL TEXT.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0019';
  v_reason      constant text := 'Initial provider verification copy (migration 0019)';
  v_seed        record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1, 'UI_LABEL', 'trust.requirement.identity_verification.name', 'Name of the verification requirement identity_verification', 'Identity verification'),
      (2, 'PLAIN_TEXT', 'trust.requirement.identity_verification.instructions', 'Provider instructions of the verification requirement identity_verification', 'Upload a clear photo or scan of one valid government-issued photo ID. Make sure the whole document is visible and readable.'),
      (3, 'UI_LABEL', 'trust.requirement.background_check.name', 'Name of the verification requirement background_check', 'Background check'),
      (4, 'PLAIN_TEXT', 'trust.requirement.background_check.instructions', 'Provider instructions of the verification requirement background_check', 'A background check is run by our verification partner. Follow the steps it shows you.'),
      (5, 'UI_LABEL', 'trust.requirement.professional_license.name', 'Name of the verification requirement professional_license', 'Professional license'),
      (6, 'PLAIN_TEXT', 'trust.requirement.professional_license.instructions', 'Provider instructions of the verification requirement professional_license', 'Upload a clear copy of your current license, showing its number and its end date.'),
      (7, 'UI_LABEL', 'trust.requirement.liability_insurance.name', 'Name of the verification requirement liability_insurance', 'Liability insurance'),
      (8, 'PLAIN_TEXT', 'trust.requirement.liability_insurance.instructions', 'Provider instructions of the verification requirement liability_insurance', 'Upload your current insurance certificate, showing the coverage and its end date.'),
      (9, 'UI_LABEL', 'trust.document_type.drivers_license.name', 'Name of the verification document type drivers_license', 'Driver''s license'),
      (10, 'UI_LABEL', 'trust.document_type.state_id.name', 'Name of the verification document type state_id', 'State ID card'),
      (11, 'UI_LABEL', 'trust.document_type.passport.name', 'Name of the verification document type passport', 'Passport'),
      (12, 'UI_LABEL', 'trust.document_type.professional_license.name', 'Name of the verification document type professional_license', 'Professional license'),
      (13, 'UI_LABEL', 'trust.document_type.business_license.name', 'Name of the verification document type business_license', 'Business license'),
      (14, 'UI_LABEL', 'trust.document_type.insurance_certificate.name', 'Name of the verification document type insurance_certificate', 'Insurance certificate'),
      (15, 'UI_LABEL', 'trust.document_type.certification.name', 'Name of the verification document type certification', 'Certification'),
      (16, 'PLAIN_TEXT', 'trust.reason.document_unreadable.name', 'Provider-facing message of the verification reason DOCUMENT_UNREADABLE', 'The document could not be read. Upload a clearer copy.'),
      (17, 'PLAIN_TEXT', 'trust.reason.document_expired.name', 'Provider-facing message of the verification reason DOCUMENT_EXPIRED', 'The document has expired. Upload a current one.'),
      (18, 'PLAIN_TEXT', 'trust.reason.name_mismatch.name', 'Provider-facing message of the verification reason NAME_MISMATCH', 'The name on the document does not match your account.'),
      (19, 'PLAIN_TEXT', 'trust.reason.license_invalid.name', 'Provider-facing message of the verification reason LICENSE_INVALID', 'The license could not be confirmed as valid.'),
      (20, 'PLAIN_TEXT', 'trust.reason.insurance_expired.name', 'Provider-facing message of the verification reason INSURANCE_EXPIRED', 'The insurance coverage shown has expired.'),
      (21, 'PLAIN_TEXT', 'trust.reason.requires_resubmission.name', 'Provider-facing message of the verification reason REQUIRES_RESUBMISSION', 'Please submit your evidence again.'),
      (22, 'PLAIN_TEXT', 'trust.reason.other_review_required.name', 'Provider-facing message of the verification reason OTHER_REVIEW_REQUIRED', 'More information is needed. Please submit updated evidence.'),
      (23, 'UI_LABEL', 'trust.verification.requirement_status.not_started', 'Label of the verification requirement status not_started', 'Not started'),
      (24, 'UI_LABEL', 'trust.verification.requirement_status.pending', 'Label of the verification requirement status pending', 'Waiting for review'),
      (25, 'UI_LABEL', 'trust.verification.requirement_status.in_review', 'Label of the verification requirement status in_review', 'Being reviewed'),
      (26, 'UI_LABEL', 'trust.verification.requirement_status.action_required', 'Label of the verification requirement status action_required', 'Action needed'),
      (27, 'UI_LABEL', 'trust.verification.requirement_status.approved', 'Label of the verification requirement status approved', 'Approved'),
      (28, 'UI_LABEL', 'trust.verification.requirement_status.rejected', 'Label of the verification requirement status rejected', 'Not accepted'),
      (29, 'UI_LABEL', 'trust.verification.requirement_status.expired', 'Label of the verification requirement status expired', 'Expired'),
      (30, 'UI_LABEL', 'trust.verification.requirement_status.not_required', 'Label of the verification requirement status not_required', 'Not required'),
      (31, 'UI_LABEL', 'trust.verification.status.not_required', 'Label of the verification status not_required', 'Nothing to verify'),
      (32, 'UI_LABEL', 'trust.verification.status.not_started', 'Label of the verification status not_started', 'Not started'),
      (33, 'UI_LABEL', 'trust.verification.status.open', 'Label of the verification status open', 'Getting ready'),
      (34, 'UI_LABEL', 'trust.verification.status.in_review', 'Label of the verification status in_review', 'In review'),
      (35, 'UI_LABEL', 'trust.verification.status.action_required', 'Label of the verification status action_required', 'Action needed'),
      (36, 'UI_LABEL', 'trust.verification.status.approved', 'Label of the verification status approved', 'Verified'),
      (37, 'UI_LABEL', 'trust.verification.status.expired', 'Label of the verification status expired', 'Renewal needed'),
      (38, 'UI_LABEL', 'trust.verification.status.cancelled', 'Label of the verification status cancelled', 'Cancelled'),
      (39, 'UI_LABEL', 'trust.verification.document_status.upload_pending', 'Label of the verification document status upload_pending', 'Waiting for the file'),
      (40, 'UI_LABEL', 'trust.verification.document_status.attached', 'Label of the verification document status attached', 'Ready to submit'),
      (41, 'UI_LABEL', 'trust.verification.document_status.submitted', 'Label of the verification document status submitted', 'Submitted'),
      (42, 'UI_LABEL', 'trust.verification.document_status.withdrawn', 'Label of the verification document status withdrawn', 'Removed'),
      (43, 'UI_LABEL', 'trust.verification.document_status.abandoned', 'Label of the verification document status abandoned', 'Not accepted'),
      (44, 'UI_LABEL', 'trust.verification.scan_status.pending', 'Label of the verification document scan status pending', 'Not checked yet'),
      (45, 'UI_LABEL', 'trust.verification.scan_status.clean', 'Label of the verification document scan status clean', 'Checked'),
      (46, 'UI_LABEL', 'trust.verification.scan_status.infected', 'Label of the verification document scan status infected', 'Rejected by the safety check'),
      (47, 'UI_LABEL', 'trust.verification.scan_status.error', 'Label of the verification document scan status error', 'Could not be checked'),
      (48, 'PLAIN_TEXT', 'trust.verification.error.not_found', 'Verification error message not_found', 'We could not find that.'),
      (49, 'PLAIN_TEXT', 'trust.verification.error.account_not_active', 'Verification error message account_not_active', 'Your account is not active.'),
      (50, 'PLAIN_TEXT', 'trust.verification.error.prerequisite_not_met', 'Verification error message prerequisite_not_met', 'Finish your provider registration and verify your email and phone first.'),
      (51, 'PLAIN_TEXT', 'trust.verification.error.requirement_not_applicable', 'Verification error message requirement_not_applicable', 'That requirement does not apply to you.'),
      (52, 'PLAIN_TEXT', 'trust.verification.error.document_type_not_accepted', 'Verification error message document_type_not_accepted', 'That kind of document is not accepted for this requirement.'),
      (53, 'PLAIN_TEXT', 'trust.verification.error.mime_not_allowed', 'Verification error message mime_not_allowed', 'That file type is not allowed.'),
      (54, 'PLAIN_TEXT', 'trust.verification.error.file_too_large', 'Verification error message file_too_large', 'That file is too large.'),
      (55, 'PLAIN_TEXT', 'trust.verification.error.too_many_documents', 'Verification error message too_many_documents', 'You have added the most documents allowed for this requirement.'),
      (56, 'PLAIN_TEXT', 'trust.verification.error.evidence_not_accepted', 'Verification error message evidence_not_accepted', 'You cannot add documents to this requirement right now.'),
      (57, 'PLAIN_TEXT', 'trust.verification.error.upload_expired', 'Verification error message upload_expired', 'The upload took too long. Start again.'),
      (58, 'PLAIN_TEXT', 'trust.verification.error.object_missing', 'Verification error message object_missing', 'We did not receive your file. Try again.'),
      (59, 'PLAIN_TEXT', 'trust.verification.error.object_mismatch', 'Verification error message object_mismatch', 'The file did not match what you described. Try again with the original file.'),
      (60, 'PLAIN_TEXT', 'trust.verification.error.scan_unavailable', 'Verification error message scan_unavailable', 'We could not check your file right now. Try again later.'),
      (61, 'PLAIN_TEXT', 'trust.verification.error.scan_infected', 'Verification error message scan_infected', 'Your file was rejected by the safety check.'),
      (62, 'PLAIN_TEXT', 'trust.verification.error.invalid_state', 'Verification error message invalid_state', 'That is not possible right now.'),
      (63, 'PLAIN_TEXT', 'trust.verification.error.submission_incomplete', 'Verification error message submission_incomplete', 'Add a document for every requirement that needs one first.'),
      (64, 'PLAIN_TEXT', 'trust.verification.error.stale_case', 'Verification error message stale_case', 'This page is out of date. Reload it and try again.'),
      (65, 'PLAIN_TEXT', 'trust.verification.error.stale_round', 'Verification error message stale_round', 'The provider changed this evidence while you were reviewing it. Reload and review again.'),
      (66, 'PLAIN_TEXT', 'trust.verification.error.already_decided', 'Verification error message already_decided', 'This evidence was already decided.'),
      (67, 'PLAIN_TEXT', 'trust.verification.error.reason_invalid', 'Verification error message reason_invalid', 'Choose a valid reason.'),
      (68, 'PLAIN_TEXT', 'trust.verification.error.not_reverifiable', 'Verification error message not_reverifiable', 'This requirement cannot be verified again yet.'),
      (69, 'PLAIN_TEXT', 'trust.verification.error.external_unavailable', 'Verification error message external_unavailable', 'The verification service is not available right now.'),
      (70, 'PLAIN_TEXT', 'trust.verification.error.validation_failed', 'Verification error message validation_failed', 'Check the highlighted fields.'),
      (71, 'PLAIN_TEXT', 'trust.verification.error.conflict', 'Verification error message conflict', 'Another change happened at the same time. Try again.'),
      (72, 'PLAIN_TEXT', 'trust.verification.error.unavailable', 'Verification error message unavailable', 'Verification is temporarily unavailable.'),
      (73, 'UI_LABEL', 'trust.verification.page.title', 'Provider verification page copy title', 'Verification'),
      (74, 'PLAIN_TEXT', 'trust.verification.page.intro', 'Provider verification page copy intro', 'We check a few things before you can be offered to customers. Your documents are used only for this and are never shown to customers.'),
      (75, 'UI_LABEL', 'trust.verification.page.open_action', 'Provider verification page copy open_action', 'Start verification'),
      (76, 'UI_LABEL', 'trust.verification.page.requirements_heading', 'Provider verification page copy requirements_heading', 'What we need'),
      (77, 'UI_LABEL', 'trust.verification.page.documents_heading', 'Provider verification page copy documents_heading', 'Your documents'),
      (78, 'UI_LABEL', 'trust.verification.page.upload_heading', 'Provider verification page copy upload_heading', 'Add a document'),
      (79, 'UI_LABEL', 'trust.verification.page.document_type_label', 'Provider verification page copy document_type_label', 'Kind of document'),
      (80, 'UI_LABEL', 'trust.verification.page.file_label', 'Provider verification page copy file_label', 'File'),
      (81, 'PLAIN_TEXT', 'trust.verification.page.file_help', 'Provider verification page copy file_help', 'A PDF, JPEG or PNG file. Do not send a photo of a screen.'),
      (82, 'UI_LABEL', 'trust.verification.page.upload_action', 'Provider verification page copy upload_action', 'Upload'),
      (83, 'UI_LABEL', 'trust.verification.page.submit_action', 'Provider verification page copy submit_action', 'Submit for review'),
      (84, 'UI_LABEL', 'trust.verification.page.cancel_action', 'Provider verification page copy cancel_action', 'Cancel verification'),
      (85, 'UI_LABEL', 'trust.verification.page.withdraw_action', 'Provider verification page copy withdraw_action', 'Remove'),
      (86, 'UI_LABEL', 'trust.verification.page.reverify_action', 'Provider verification page copy reverify_action', 'Verify again'),
      (87, 'UI_LABEL', 'trust.verification.page.status_label', 'Provider verification page copy status_label', 'Status'),
      (88, 'UI_LABEL', 'trust.verification.page.reason_label', 'Provider verification page copy reason_label', 'Reason'),
      (89, 'UI_LABEL', 'trust.verification.page.valid_until_label', 'Provider verification page copy valid_until_label', 'Valid until'),
      (90, 'PLAIN_TEXT', 'trust.verification.page.empty_requirements', 'Provider verification page copy empty_requirements', 'Nothing needs to be verified for your account right now.'),
      (91, 'PLAIN_TEXT', 'trust.verification.page.empty_documents', 'Provider verification page copy empty_documents', 'No documents yet.'),
      (92, 'PLAIN_TEXT', 'trust.verification.page.prerequisite_hint', 'Provider verification page copy prerequisite_hint', 'Finish your provider registration and verify your email and phone first.'),
      (93, 'PLAIN_TEXT', 'trust.verification.page.submitted_notice', 'Provider verification page copy submitted_notice', 'Your documents were submitted for review.'),
      (94, 'PLAIN_TEXT', 'trust.verification.page.uploaded_notice', 'Provider verification page copy uploaded_notice', 'Your document was added. Submit when everything is ready.'),
      (95, 'PLAIN_TEXT', 'trust.verification.page.withdrawn_notice', 'Provider verification page copy withdrawn_notice', 'The document was removed.'),
      (96, 'PLAIN_TEXT', 'trust.verification.page.cancelled_notice', 'Provider verification page copy cancelled_notice', 'Your verification was cancelled.'),
      (97, 'PLAIN_TEXT', 'trust.verification.page.golive_note', 'Provider verification page copy golive_note', 'Being verified does not make you live. Going live needs other steps.')
    ) AS t (ord, content_type, key, description, body)
    ORDER BY ord
  LOOP
    INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
    VALUES (v_seed.key, v_seed.content_type, 'CONTENT', v_seed.description, 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'MARKET', v_actor)
    RETURNING entry_id INTO v_entry_id;
    INSERT INTO content.audit_events (occurred_at, actor, action, entry_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'ENTRY_CREATED', v_entry_id, v_reason, v_correlation);

    INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, status, approval_policy, effective_from, reason, created_by)
    VALUES (v_entry_id, 'en-US', 'PLATFORM', NULL, 1, v_seed.body, 'DRAFT', 'NONE', v_from, v_reason, v_actor)
    RETURNING version_id INTO v_version_id;
    INSERT INTO content.audit_events (occurred_at, actor, action, entry_id, version_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'VERSION_DRAFTED', v_entry_id, v_version_id, v_reason, v_correlation);
    UPDATE content.versions SET status = 'APPROVED', updated_at = now() WHERE version_id = v_version_id AND status = 'DRAFT';
    INSERT INTO content.audit_events (occurred_at, actor, action, entry_id, version_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'VERSION_APPROVED', v_entry_id, v_version_id, v_reason, v_correlation);
    UPDATE content.versions SET status = 'PUBLISHED', updated_at = now() WHERE version_id = v_version_id AND status = 'APPROVED';
    INSERT INTO content.audit_events (occurred_at, actor, action, entry_id, version_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'VERSION_PUBLISHED', v_entry_id, v_version_id, v_reason, v_correlation);
    INSERT INTO content.audit_events (occurred_at, actor, action, entry_id, version_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'VERSION_ACTIVATED', v_entry_id, v_version_id, v_reason, v_correlation);
  END LOOP;
END
$seed$;

-- =====================================================================================================================
-- 10. seed: reference data and the one rule the PRD requires
--     Only what is justified: PRD PR-02.06 makes APPROVED identity verification a condition of being bookable for every provider, so identity verification is ACTIVE with an
--     all-markets, all-service-types rule. The background check, licence and insurance definitions exist (the model is demonstrated) but are INACTIVE with NO rule: no market-,
--     category- or state-specific obligation is invented here (an administrator with trust-admin turns a requirement on where policy says so, DEBT-0087).
-- =====================================================================================================================
INSERT INTO trust.requirement_definitions (code, requirement_type, evidence_kind, expiry_required, status) VALUES
  ('identity_verification', 'IDENTITY', 'DOCUMENT', false, 'ACTIVE'),
  ('background_check', 'BACKGROUND_CHECK', 'EXTERNAL', true, 'INACTIVE'),
  ('professional_license', 'LICENSE', 'DOCUMENT', true, 'INACTIVE'),
  ('liability_insurance', 'INSURANCE', 'DOCUMENT', true, 'INACTIVE');
INSERT INTO trust.document_types (code, requirement_type) VALUES
  ('drivers_license', 'IDENTITY'),
  ('state_id', 'IDENTITY'),
  ('passport', 'IDENTITY'),
  ('professional_license', 'LICENSE'),
  ('business_license', 'BUSINESS_REGISTRATION'),
  ('insurance_certificate', 'INSURANCE'),
  ('certification', 'CERTIFICATION');
INSERT INTO trust.reason_codes (code, applies_to) VALUES
  ('DOCUMENT_UNREADABLE', 'BOTH'),
  ('DOCUMENT_EXPIRED', 'BOTH'),
  ('NAME_MISMATCH', 'BOTH'),
  ('LICENSE_INVALID', 'REJECT'),
  ('INSURANCE_EXPIRED', 'BOTH'),
  ('REQUIRES_RESUBMISSION', 'ACTION_REQUIRED'),
  ('OTHER_REVIEW_REQUIRED', 'BOTH');
INSERT INTO trust.requirement_rules (requirement_definition_id, market_id, service_type_id, enabled)
SELECT requirement_definition_id, NULL, NULL, true FROM trust.requirement_definitions WHERE code = 'identity_verification';
