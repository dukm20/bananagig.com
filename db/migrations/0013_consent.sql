-- checkpoint: ID-005
-- purpose: add the account's relationship to the legal documents to the identity schema: consent_purposes (what can be consented to, bound to exactly one LEGAL document entry of the content registry), consent_events (ONE append-only table that is both the immutable acceptance record and the history: ACCEPTED / WITHDRAWN events with a per-account-and-purpose sequence, each bound to the exact content version by a composite foreign key on version id, locale and body hash), the single in-force definition (identity.consent_version_state, shared by the guard trigger and the service), the guard triggers (eligibility under a share lock on the version row, sequence and transition rules, immutability including TRUNCATE), the audit extension (two consent actions and a consent event reference), the two seeded LEGAL document entry SHELLS (no versions, no text), the four consent policy parameters (CFG-001, ONE ENGINEERING ASSUMPTION flagged for the legal owner) and the consent screen copy (CFG-002)
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. Consent events and audit rows are never updated or deleted (a correction is a new event), the purposes are never deleted (status INACTIVE instead), the seeded entry shells, parameters and copy are changed through their own workflows, never by editing this file
-- backfill: none; every table is new and no account has a consent event (events appear when a person accepts a document). No existing row is rewritten: content.versions gets one additive UNIQUE constraint over columns that are already unique together (version_id is the primary key), and identity.account_audit_events gets one nullable column (NULL for every existing row) and a wider CHECK
-- risk: low to medium. Two new tables, one function and four guards, one additive unique constraint on content.versions (a second unique index on a table that is updated only by lifecycle changes: the indexed columns never change, so those updates stay HOT), one nullable column and one wider CHECK on identity.account_audit_events. The seeds are deterministic reference data: 2 LEGAL entry shells with no version (until Legal publishes the first versions through the content workflow the evaluator reports DOCUMENT_UNAVAILABLE and nothing can be accepted), 2 purposes, 4 configuration parameters with one approved PLATFORM value each and the managed consent copy. NO LEGAL TEXT is stored anywhere in this schema: an event holds only the id, the locale and the SHA-256 of the immutable content version it refers to; the audit row and the outbox event hold identifiers only
-- destructive: the CHECK constraint ck_account_audit_events__action is dropped and re-created WIDER (the two consent actions are added, all 37 existing actions are kept) in the same transaction; this is a pure widening, no row is changed or removed and the append-only trigger of the table is not involved (expand step of expand/migrate/contract, nothing is contracted). The BEFORE TRUNCATE trigger below REFUSES truncation of the consent events (a protection, not a TRUNCATE of anything)
-- events: the seeds emit no outbox events (they run before any consumer exists, like 0006 to 0012); every consent change after this migration goes through ConsentService, which writes the event in the same transaction
-- audit: the configuration seed writes the configuration audit trail (PARAMETER_CREATED ... CHANGE_ACTIVATED), the content seed writes the content audit trail (ENTRY_CREATED for the shells; ENTRY_CREATED ... VERSION_ACTIVATED for the copy), exactly as the real workflows do
-- ASSUMPTIONS (not in the PRD, flagged for the legal owner, recorded in TECH_DEBT): consent.terms_of_service.reacceptance and consent.privacy_policy.reacceptance default to REACCEPT_REQUIRED (the PRD does not say what a new version of a document does to existing acceptances; the conservative choice is that everyone accepts the version in force). The required_for values come from the PRD (CU-03 sign-up consent field, PR-01 provider sign-up): CUSTOMER and PROVIDER both accept the Terms of Service and the Privacy Policy

-- =====================================================================================================================
-- 1. content.versions: the target of the composite foreign key of the consent events
-- =====================================================================================================================
ALTER TABLE content.versions ADD CONSTRAINT uq_versions__version_locale_hash UNIQUE (version_id, locale, body_sha256);
COMMENT ON CONSTRAINT uq_versions__version_locale_hash ON content.versions IS 'The target of the composite foreign key (version_id, locale, body_sha256) of identity.consent_events: a consent event stores the locale and the hash it was shown, and the database proves they are those of the immutable version (the body, locale and hash of a version never change; the version row is never deleted). version_id alone is already unique, so this adds no rule of its own; it exists to be referenced.';

-- =====================================================================================================================
-- 2. the single definition of "this version is in force now" (shared by the guard trigger and the service query)
-- =====================================================================================================================
CREATE FUNCTION identity.consent_version_state(p_version_id uuid, p_entry_id uuid, p_at timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT CASE
      WHEN v.entry_id IS DISTINCT FROM p_entry_id OR v.scope_type <> 'PLATFORM' OR v.status NOT IN ('SCHEDULED', 'PUBLISHED', 'SUPERSEDED') THEN 'NOT_FOUND'
      WHEN e.is_active AND l.is_active AND v.effective_from <= p_at AND (v.effective_to IS NULL OR v.effective_to > p_at) THEN 'IN_FORCE'
      ELSE 'NOT_CURRENT'
    END
    FROM content.versions v
    JOIN content.entries e ON e.entry_id = v.entry_id
    JOIN content.locales l ON l.locale = v.locale
    WHERE v.version_id = p_version_id
  ), 'NOT_FOUND')
$$;
COMMENT ON FUNCTION identity.consent_version_state(uuid, uuid, timestamptz) IS 'THE definition of "in force", used by the consent guard trigger (under a FOR SHARE lock on the version row) and by every ConsentService query that asks which version a person is shown: it mirrors the content resolver (packages/content/src/resolver.ts, platform scope, EXACT locale for legal documents) exactly. NOT_FOUND = no such version, or it belongs to another entry than p_entry_id, or its scope is not PLATFORM, or it is not published (DRAFT, IN_REVIEW, APPROVED, REJECTED, CANCELLED never resolve and are indistinguishable from an unknown id). IN_FORCE = published (SCHEDULED, PUBLISHED or SUPERSEDED: these are workflow markers, the timestamps decide, so a SCHEDULED version whose start has passed but which the activation job has not yet advanced IS in force, exactly as the resolver serves it) AND the entry is active AND the locale is active AND effective_from <= p_at AND (effective_to IS NULL OR effective_to > p_at) (half-open window). NOT_CURRENT = published but outside its window now (superseded and closed, or not yet effective), or its entry or locale is inactive. The exclusion constraint of content.versions guarantees at most one IN_FORCE version per entry, locale and scope.';

-- =====================================================================================================================
-- 3. the two LEGAL document entry shells (no versions, no text), exactly as the content service creates an entry
-- =====================================================================================================================
DO $seed$
DECLARE
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0013';
  v_reason      constant text := 'Legal document shell (migration 0013): Legal publishes the first versions through the content workflow';
  v_seed        record;
  v_entry_id    uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1, 'legal.terms_of_service', 'The BananaGig Terms of Service that a person accepts to use the marketplace (legal document; versions are published by Legal through the content workflow)'),
      (2, 'legal.privacy_policy',   'The BananaGig Privacy Policy that a person accepts to use the marketplace (legal document; versions are published by Legal through the content workflow)')
    ) AS t (ord, key, description)
    ORDER BY ord
  LOOP
    INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
    VALUES (v_seed.key, 'LEGAL', 'LEGAL', v_seed.description, 'PUBLIC', 'CRITICAL', 'SECOND_APPROVER', 'EXACT', 'PLATFORM', v_actor)
    RETURNING entry_id INTO v_entry_id;
    INSERT INTO content.audit_events (occurred_at, actor, action, entry_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'ENTRY_CREATED', v_entry_id, v_reason, v_correlation);
  END LOOP;
END
$seed$;

-- =====================================================================================================================
-- 4. consent purposes
-- =====================================================================================================================
CREATE TABLE identity.consent_purposes (
  purpose_code      text        NOT NULL,
  document_entry_id uuid        NOT NULL,
  withdrawal_policy text        NOT NULL,
  status            text        NOT NULL DEFAULT 'ACTIVE',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_consent_purposes PRIMARY KEY (purpose_code),
  CONSTRAINT uq_consent_purposes__document_entry UNIQUE (document_entry_id),
  CONSTRAINT fk_consent_purposes__document_entry FOREIGN KEY (document_entry_id) REFERENCES content.entries (entry_id) ON DELETE RESTRICT,
  CONSTRAINT ck_consent_purposes__purpose_code CHECK (purpose_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT ck_consent_purposes__withdrawal_policy CHECK (withdrawal_policy IN ('NOT_WITHDRAWABLE', 'WITHDRAWABLE')),
  CONSTRAINT ck_consent_purposes__status CHECK (status IN ('ACTIVE', 'INACTIVE'))
);
COMMENT ON TABLE identity.consent_purposes IS 'What a person can consent to (reference data): a stable purpose code bound to exactly ONE LEGAL document entry of the content registry (CFG-002), the structural withdrawal policy and a status. The legal text and its versions live in content.versions; policy (which role needs which purpose, what a newer version does to an existing acceptance) is configuration (consent.<purpose>.required_for and consent.<purpose>.reacceptance), never a column here. A new purpose is a migration (a row, its LEGAL entry shell and two parameters). purpose_code, document_entry_id and withdrawal_policy are immutable (guard trigger); only status (and updated_at) change; rows are never deleted. Seeded: TERMS_OF_SERVICE and PRIVACY_POLICY (both NOT_WITHDRAWABLE: they are conditions of using the service).';
COMMENT ON COLUMN identity.consent_purposes.document_entry_id IS 'The LEGAL content entry whose versions this purpose records acceptance of (the guard trigger requires content_type LEGAL). UNIQUE: one purpose per document, so the purpose and the document cannot drift into two parallel catalogs (the purpose adds the structural withdrawal policy and the status, nothing the entry already says).';
COMMENT ON COLUMN identity.consent_purposes.withdrawal_policy IS 'NOT_WITHDRAWABLE (a condition of the service: the Terms of Service, the Privacy Policy) or WITHDRAWABLE (optional consents such as marketing, added later). Structural: it follows from the legal nature of the purpose, not from a business value, so it is a column and not configuration. Immutable.';
COMMENT ON COLUMN identity.consent_purposes.status IS 'ACTIVE (can be accepted and is evaluated) or INACTIVE (retired: it cannot be accepted any more, it is no longer evaluated, existing events remain and an accepted WITHDRAWABLE consent can still be withdrawn).';

CREATE FUNCTION identity.guard_consent_purposes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consent purposes cannot be deleted; deactivate them instead' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.purpose_code, NEW.document_entry_id, NEW.withdrawal_policy, NEW.created_at) IS DISTINCT FROM (OLD.purpose_code, OLD.document_entry_id, OLD.withdrawal_policy, OLD.created_at) THEN
      RAISE EXCEPTION 'a consent purpose is immutable except for its status' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CONSENT_PURPOSE_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  SELECT content_type INTO c_type FROM content.entries WHERE entry_id = NEW.document_entry_id;
  IF c_type IS DISTINCT FROM 'LEGAL' THEN
    RAISE EXCEPTION 'the document of a consent purpose must be a LEGAL content entry' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CONSENT_PURPOSE_DOCUMENT';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_consent_purposes__guard BEFORE INSERT OR UPDATE OR DELETE ON identity.consent_purposes FOR EACH ROW EXECUTE FUNCTION identity.guard_consent_purposes();

DO $seed$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO identity.consent_purposes (purpose_code, document_entry_id, withdrawal_policy, status)
  SELECT p.code, e.entry_id, 'NOT_WITHDRAWABLE', 'ACTIVE'
    FROM (VALUES ('TERMS_OF_SERVICE', 'legal.terms_of_service'), ('PRIVACY_POLICY', 'legal.privacy_policy')) AS p (code, key)
    JOIN content.entries e ON e.key = p.key;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected to seed 2 consent purposes, seeded %', v_count;
  END IF;
END
$seed$;

-- =====================================================================================================================
-- 5. consent events (the immutable acceptance record AND the history)
-- =====================================================================================================================
CREATE TABLE identity.consent_events (
  consent_event_id       uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id             uuid        NOT NULL,
  purpose_code           text        NOT NULL,
  event_seq              integer     NOT NULL,
  event_type             text        NOT NULL,
  version_id             uuid        NOT NULL,
  locale                 text        NOT NULL,
  body_sha256            text        NOT NULL,
  occurred_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  source                 text        NOT NULL DEFAULT 'ACCOUNT_API',
  application_session_id uuid,
  correlation_id         text        NOT NULL,
  CONSTRAINT pk_consent_events PRIMARY KEY (consent_event_id),
  CONSTRAINT uq_consent_events__account_purpose_seq UNIQUE (account_id, purpose_code, event_seq),
  CONSTRAINT uq_consent_events__account_event UNIQUE (account_id, consent_event_id),
  CONSTRAINT fk_consent_events__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_consent_events__purpose_code FOREIGN KEY (purpose_code) REFERENCES identity.consent_purposes (purpose_code) ON DELETE RESTRICT,
  CONSTRAINT fk_consent_events__version FOREIGN KEY (version_id, locale, body_sha256) REFERENCES content.versions (version_id, locale, body_sha256) ON DELETE RESTRICT,
  CONSTRAINT fk_consent_events__account_session FOREIGN KEY (account_id, application_session_id) REFERENCES identity.application_sessions (account_id, application_session_id) MATCH SIMPLE ON DELETE RESTRICT,
  CONSTRAINT ck_consent_events__event_seq CHECK (event_seq > 0),
  CONSTRAINT ck_consent_events__event_type CHECK (event_type IN ('ACCEPTED', 'WITHDRAWN')),
  CONSTRAINT ck_consent_events__body_sha256 CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_consent_events__source CHECK (source IN ('ACCOUNT_API')),
  CONSTRAINT ck_consent_events__correlation_id CHECK (length(btrim(correlation_id)) BETWEEN 1 AND 200)
);
COMMENT ON TABLE identity.consent_events IS 'The immutable record of what an ACCOUNT did with a legal document, and its history: one row per ACCEPTED or WITHDRAWN event, numbered per account and purpose (event_seq 1, 2, 3 ...; the first event is always ACCEPTED). Current consent is DERIVED from the latest event of an account and purpose; no current flag exists, and a correction is a new event, never a rewrite. Each event is bound to the EXACT text by the composite foreign key (version_id, locale, body_sha256) to content.versions: the version is immutable, so the row proves what was accepted without copying a word of it; the stored locale and hash cannot disagree with the version (the database proves it). The text itself is read through the version id. ACCEPTED is accepted only for a version that is IN FORCE at the moment of the insert (identity.consent_version_state, read under a FOR SHARE lock on the version row so a publication that closes the window serializes with the accept) and the sequence and transition rules are enforced by trigger. The row holds NO raw IP address, NO user agent and NO client timestamp: occurred_at is the database clock, set by the trigger. Rows are never updated, deleted or truncated. Not personal data beyond the account reference; no legal text.';
COMMENT ON COLUMN identity.consent_events.event_seq IS '1 for the first event of the account and purpose, then previous + 1 (the guard trigger enforces it). Two writers racing for the same number collide on uq_consent_events__account_purpose_seq (a unique violation) instead of forking the history. It is the order of the history; occurred_at is its time.';
COMMENT ON COLUMN identity.consent_events.event_type IS 'ACCEPTED (the account accepted the version) or WITHDRAWN (the account withdrew the acceptance of that same version). WITHDRAWN only follows ACCEPTED and only for a WITHDRAWABLE purpose; ACCEPTED after ACCEPTED must be a different, not older version; ACCEPTED after WITHDRAWN is a re-grant.';
COMMENT ON COLUMN identity.consent_events.version_id IS 'content.versions.version_id of the exact text (immutable, never deleted). Part of the composite foreign key with locale and body_sha256. A WITHDRAWN event carries the version of the acceptance it withdraws.';
COMMENT ON COLUMN identity.consent_events.locale IS 'The locale of the version, as stored in content.versions (compared exactly, never normalized). Part of the composite foreign key.';
COMMENT ON COLUMN identity.consent_events.body_sha256 IS 'Lower-case hex SHA-256 of the UTF-8 text of the version (computed by the content trigger, never by a caller). Part of the composite foreign key: the hash of the accepted text is proven by the database.';
COMMENT ON COLUMN identity.consent_events.occurred_at IS 'When the event was recorded: the DATABASE clock at the insert, set by the guard trigger (a value supplied by the caller is overwritten). For ACCEPTED it is the very instant at which the version was proven to be in force.';
COMMENT ON COLUMN identity.consent_events.source IS 'Where the event came from. ACCOUNT_API is the only source today (the person acted in their own session); the column exists so a trusted source, such as a back-office record, can be added by widening the CHECK.';
COMMENT ON COLUMN identity.consent_events.application_session_id IS 'The application session (ID-004) the person acted in, when the request had one. The composite foreign key (account_id, application_session_id) with MATCH SIMPLE guarantees it belongs to the same account. Never the Keycloak session id.';

-- Index justification (DATA_MODEL_GUARDRAILS rule 11):
--   uq_consent_events__account_purpose_seq (account_id, purpose_code, event_seq): THE lookup of "the latest event of an account and purpose" (ORDER BY event_seq DESC LIMIT 1, every accept, withdraw
--     and requirement evaluation) and of one purpose's history; also the rule that makes two racing writers collide instead of forking the history.
--   uq_consent_events__account_event (account_id, consent_event_id): the composite foreign key target of account_audit_events.
--   The consent history of ONE account (GET /account/consents, newest first, bounded by CONSENT_HISTORY_LIMIT) is a read of a handful of rows per account: it is served by the same
--     unique sequence index through its account_id prefix and sorted in memory. NO separate (account_id, occurred_at DESC) index: measured at 1M events, the planner used such an index
--     only to filter by account_id (the ORDER BY carries a tie-break, purpose_code and event_seq, that the index cannot satisfy), so it did the job of the unique index for 32 MB per 1M
--     events plus its insert maintenance.
--   NO index on version_id: content.versions rows are never deleted or re-keyed, so no foreign key check ever scans consent_events, and no query asks "who accepted this version" yet (a compliance
--     report would add its own index through its own data model review). None on purpose_code (served by the sequence key prefix after account_id; the purposes are never deleted) and none on
--     application_session_id (sessions are never deleted; nothing reads events by session).

-- =====================================================================================================================
-- 6. audit extension: two consent actions and the consent event they concern
-- =====================================================================================================================
ALTER TABLE identity.account_audit_events DROP CONSTRAINT ck_account_audit_events__action;
ALTER TABLE identity.account_audit_events ADD CONSTRAINT ck_account_audit_events__action CHECK (
  action IN ('ACCOUNT_CREATED', 'EXTERNAL_IDENTITY_LINKED', 'ROLE_GRANTED', 'ROLE_ACTIVATED', 'ROLE_DEACTIVATED', 'PRIMARY_ROLE_CHANGED', 'PROFILE_UPDATED',
             'EMAIL_ADDED', 'EMAIL_CHANGE_REQUESTED', 'EMAIL_VERIFICATION_REQUESTED', 'EMAIL_VERIFICATION_FAILED', 'EMAIL_VERIFICATION_LOCKED', 'EMAIL_VERIFIED', 'EMAIL_PRIMARY_CHANGED',
             'PHONE_ADDED', 'PHONE_CHANGE_REQUESTED', 'PHONE_VERIFICATION_REQUESTED', 'PHONE_VERIFICATION_FAILED', 'PHONE_VERIFICATION_LOCKED', 'PHONE_VERIFIED', 'PHONE_PRIMARY_CHANGED',
             'SESSION_CREATED', 'SESSION_ENDED', 'SESSION_REVOKED', 'SESSIONS_REVOKED_ALL', 'DEVICE_TRUSTED', 'DEVICE_UNTRUSTED', 'DEVICE_REMOVED',
             'MFA_ENROLLMENT_REQUESTED', 'MFA_ENABLED', 'MFA_DISABLED', 'RECOVERY_CODES_REQUESTED', 'RECOVERY_CODES_ENABLED', 'RECOVERY_CODES_DISABLED',
             'PASSWORD_RESET_REQUESTED', 'PASSWORD_CHANGED', 'PASSWORD_RESET_COMPLETED',
             'CONSENT_ACCEPTED', 'CONSENT_WITHDRAWN')
);
ALTER TABLE identity.account_audit_events ADD COLUMN consent_event_id uuid;
ALTER TABLE identity.account_audit_events
  ADD CONSTRAINT fk_account_audit_events__account_consent_event FOREIGN KEY (account_id, consent_event_id) REFERENCES identity.consent_events (account_id, consent_event_id) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_account_audit_events__consent_event CHECK ((action LIKE 'CONSENT\_%') = (consent_event_id IS NOT NULL));
COMMENT ON COLUMN identity.account_audit_events.consent_event_id IS 'The consent event a CONSENT_ACCEPTED or CONSENT_WITHDRAWN action concerns (NULL for every other action). The composite foreign key (account_id, consent_event_id) guarantees the event belongs to the audited account. The audit change holds only the purpose code and the event sequence; the version, its locale and its hash are reached through the event.';
-- the foreign key above has no index of its own: the referenced events are never deleted or re-keyed, and no query filters audit rows by this column (the timeline reads idx_account_audit_events__account)

-- =====================================================================================================================
-- 7. guards (same conventions as 0009 to 0012: DETAIL 'identity_rule:<KEY>'; lock order account row, purpose row, version row)
-- =====================================================================================================================
-- append-only: UPDATE and DELETE of a row, and TRUNCATE of the table, are refused (the same function and rule key as the audit tables)
CREATE TRIGGER trg_consent_events__immutable BEFORE UPDATE OR DELETE ON identity.consent_events FOR EACH ROW EXECUTE FUNCTION identity.forbid_mutation();
CREATE TRIGGER trg_consent_events__no_truncate BEFORE TRUNCATE ON identity.consent_events FOR EACH STATEMENT EXECUTE FUNCTION identity.forbid_mutation();

CREATE FUNCTION identity.guard_consent_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_now        timestamptz;
  a_status     text;
  p_entry      uuid;
  p_status     text;
  p_withdrawal text;
  prev_seq     integer;
  prev_type    text;
  prev_version uuid;
  prev_locale  text;
  prev_hash    text;
  prev_number  integer;
  new_number   integer;
  v_state      text;
BEGIN
  -- Lock order: the account row (the service already holds it FOR UPDATE; a writer outside the service takes the share lock here, so closing the account serializes with the insert),
  -- then the purpose row, then (ACCEPTED only) the content version row.
  SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id FOR SHARE;
  IF a_status = 'CLOSED' THEN
    RAISE EXCEPTION 'a closed account cannot receive a consent event' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_CLOSED';
  END IF;
  SELECT document_entry_id, status, withdrawal_policy INTO p_entry, p_status, p_withdrawal FROM identity.consent_purposes WHERE purpose_code = NEW.purpose_code FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports the unknown purpose
  END IF;

  -- the sequence: previous + 1 (the first event is 1). The unique key is the net underneath two writers that both read the same previous event.
  SELECT event_seq, event_type, version_id, locale, body_sha256 INTO prev_seq, prev_type, prev_version, prev_locale, prev_hash
    FROM identity.consent_events WHERE account_id = NEW.account_id AND purpose_code = NEW.purpose_code ORDER BY event_seq DESC LIMIT 1;
  IF NEW.event_seq IS DISTINCT FROM coalesce(prev_seq, 0) + 1 THEN
    RAISE EXCEPTION 'a consent event continues the history of its account and purpose with the next sequence number' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CONSENT_SEQUENCE';
  END IF;

  IF NEW.event_type = 'ACCEPTED' THEN
    IF p_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'the consent purpose is not active' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CONSENT_PURPOSE_INACTIVE';
    END IF;
    -- The version row is share-locked BEFORE the window is evaluated: a publication that closes the window (it updates this row) either committed first (and is seen below: the accept
    -- is refused) or waits for this transaction (the accept lands first, a valid historical fact). The statement that follows takes a fresh snapshot, so it sees what the lock waited for.
    PERFORM 1 FROM content.versions WHERE version_id = NEW.version_id FOR SHARE;
    v_now := clock_timestamp();
    v_state := identity.consent_version_state(NEW.version_id, p_entry, v_now);
    IF v_state = 'NOT_FOUND' THEN
      RAISE EXCEPTION 'the version is not a published platform version of the purpose document' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CONSENT_VERSION_NOT_FOUND';
    ELSIF v_state <> 'IN_FORCE' THEN
      RAISE EXCEPTION 'the version is not in force' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CONSENT_VERSION_NOT_CURRENT';
    END IF;
    IF prev_type = 'ACCEPTED' THEN
      IF prev_version = NEW.version_id THEN
        RAISE EXCEPTION 'this version is already accepted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CONSENT_DUPLICATE';
      END IF;
      -- no going back: in the same locale the new version number must be greater (version numbers are per entry, locale and scope, so another locale is not comparable)
      IF NEW.locale = prev_locale THEN
        SELECT version INTO prev_number FROM content.versions WHERE version_id = prev_version;
        SELECT version INTO new_number FROM content.versions WHERE version_id = NEW.version_id;
        IF new_number <= prev_number THEN
          RAISE EXCEPTION 'an older version cannot replace the accepted one' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CONSENT_VERSION_STALE';
        END IF;
      END IF;
    END IF;
  ELSIF NEW.event_type = 'WITHDRAWN' THEN
    IF p_withdrawal <> 'WITHDRAWABLE' THEN
      RAISE EXCEPTION 'this consent purpose cannot be withdrawn' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CONSENT_NOT_WITHDRAWABLE';
    END IF;
    IF prev_type IS DISTINCT FROM 'ACCEPTED' THEN
      RAISE EXCEPTION 'only an accepted consent can be withdrawn' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CONSENT_NOT_ACCEPTED';
    END IF;
    IF (NEW.version_id, NEW.locale, NEW.body_sha256) IS DISTINCT FROM (prev_version, prev_locale, prev_hash) THEN
      RAISE EXCEPTION 'a withdrawal refers to the version it withdraws' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CONSENT_WITHDRAWAL_VERSION';
    END IF;
    v_now := clock_timestamp();
  ELSE
    RETURN NEW; -- an unknown event type is refused by its CHECK constraint
  END IF;

  NEW.occurred_at := v_now;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_consent_events__guard BEFORE INSERT ON identity.consent_events FOR EACH ROW EXECUTE FUNCTION identity.guard_consent_events();

-- =====================================================================================================================
-- 8. seed: the consent policy parameters (CFG-001), through the real change workflow
--    required_for: the PRD makes both documents part of sign-up (CU-03 consent field, PR-01), for both roles. reacceptance: ENGINEERING ASSUMPTION, not in the PRD, flagged for the legal owner (TECH_DEBT):
--    what a newer version does to an existing acceptance. REACCEPT_REQUIRED is the conservative default (everyone accepts the version in force).
--    Legal parameters: CRITICAL (never cached, never last-known-good), SECOND_APPROVER, owner legal; overridable per COUNTRY and MARKET (the consent law differs by region; the engine reads PLATFORM today).
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_approver    constant text := 'system:migration-review';
  v_correlation constant text := 'seed-0013';
  v_seed        record;
  v_scope       text;
  v_parameter   uuid;
  v_request     uuid;
  v_holder      uuid;
  v_version     uuid;
  v_reason      text;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1, 'consent.terms_of_service.required_for', 'JSON', NULL::text, 'Application roles (CUSTOMER, PROVIDER) that must accept the Terms of Service: a list of role codes; an empty list means nobody is required to accept it',
          '{"schema": {"type": "array", "items": {"type": "string", "pattern": "^[A-Z][A-Z0-9_]{1,29}$"}, "uniqueItems": true, "maxItems": 10}}'::jsonb,
          'legal', ARRAY['PLATFORM', 'COUNTRY', 'MARKET'], '["CUSTOMER", "PROVIDER"]'::jsonb, 'PRD CU-03 sign-up consent and PR-01 provider sign-up: both roles accept the Terms of Service'),
      (2, 'consent.terms_of_service.reacceptance', 'ENUM', NULL::text, 'What a newer version of the Terms of Service does to an existing acceptance: NO_REACCEPT (any accepted version in any locale stays valid), REACCEPT_FOR_NEW_USERS_ONLY (an acceptance in the same locale stays valid) or REACCEPT_REQUIRED (only the version in force counts)',
          '{"enum": ["NO_REACCEPT", "REACCEPT_FOR_NEW_USERS_ONLY", "REACCEPT_REQUIRED"]}'::jsonb,
          'legal', ARRAY['PLATFORM', 'COUNTRY', 'MARKET'], '"REACCEPT_REQUIRED"'::jsonb, 'ID-005 engineering assumption, not in the PRD (conservative default: everyone accepts the version in force); to be confirmed by the legal owner'),
      (3, 'consent.privacy_policy.required_for', 'JSON', NULL::text, 'Application roles (CUSTOMER, PROVIDER) that must accept the Privacy Policy: a list of role codes; an empty list means nobody is required to accept it',
          '{"schema": {"type": "array", "items": {"type": "string", "pattern": "^[A-Z][A-Z0-9_]{1,29}$"}, "uniqueItems": true, "maxItems": 10}}'::jsonb,
          'legal', ARRAY['PLATFORM', 'COUNTRY', 'MARKET'], '["CUSTOMER", "PROVIDER"]'::jsonb, 'PRD CU-03 sign-up consent and PR-01 provider sign-up: both roles accept the Privacy Policy'),
      (4, 'consent.privacy_policy.reacceptance', 'ENUM', NULL::text, 'What a newer version of the Privacy Policy does to an existing acceptance: NO_REACCEPT (any accepted version in any locale stays valid), REACCEPT_FOR_NEW_USERS_ONLY (an acceptance in the same locale stays valid) or REACCEPT_REQUIRED (only the version in force counts)',
          '{"enum": ["NO_REACCEPT", "REACCEPT_FOR_NEW_USERS_ONLY", "REACCEPT_REQUIRED"]}'::jsonb,
          'legal', ARRAY['PLATFORM', 'COUNTRY', 'MARKET'], '"REACCEPT_REQUIRED"'::jsonb, 'ID-005 engineering assumption, not in the PRD (conservative default: everyone accepts the version in force); to be confirmed by the legal owner')
    ) AS t (ord, key, data_type, unit, description, rules, owner, scopes, value, basis)
    ORDER BY ord
  LOOP
    v_reason := 'Initial value (migration 0013): ' || v_seed.basis;
    INSERT INTO configuration.parameters (key, data_type, unit, description, owner_role, validation_rules, sensitivity, approval_policy, criticality, is_required, created_by)
    VALUES (v_seed.key, v_seed.data_type, v_seed.unit, v_seed.description, v_seed.owner, v_seed.rules, 'INTERNAL', 'SECOND_APPROVER', 'CRITICAL', true, v_actor)
    RETURNING parameter_id INTO v_parameter;
    FOREACH v_scope IN ARRAY v_seed.scopes LOOP
      INSERT INTO configuration.parameter_scopes (parameter_id, scope_type) VALUES (v_parameter, v_scope);
    END LOOP;
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
    VALUES (v_request, v_approver, 'APPROVE', 'Initial value reviewed with the migration (ID-005)');
    UPDATE configuration.change_requests SET state = 'APPROVED', updated_at = now() WHERE change_request_id = v_request AND state = 'PENDING_APPROVAL';
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, change_request_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_approver, 'CHANGE_APPROVED', v_parameter, v_request, 'Initial value reviewed with the migration (ID-005)', v_correlation);

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
-- 9. seed: the consent screen copy (CFG-002), through the real content lifecycle (en-US only)
--    NO LEGAL TEXT: these are labels, notices and error messages around the legal documents; the documents themselves are the LEGAL entries published by Legal.
--    Typed variables: version (COUNT) on document.version, locale (STRING) on document.locale and date (STRING) on accepted_on (formatted by the web server). No copy carries personal data.
--    The key sets follow the contract helpers: purpose.<code>, status.<requirement status>, state.<acceptance state>, event.<event type>, error.<consent error code without the CONSENT_ prefix>.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0013';
  v_reason      constant text := 'Initial consent copy (migration 0013)';
  v_seed        record;
  v_var         record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1,  'UI_LABEL',   'account.consent.title', 'Title of the consents page', 'Terms and consents', '[]'::jsonb),
      (2,  'PLAIN_TEXT', 'account.consent.intro', 'Introduction on the consents page', 'These are the documents that apply to your account. Nothing is accepted for you: an agreement is recorded only when you choose to accept it, together with the exact version you were shown.', '[]'::jsonb),
      (3,  'UI_LABEL',   'account.consent.requirements.title', 'Heading of the section listing what the person needs to accept', 'What you need to accept', '[]'::jsonb),
      (4,  'PLAIN_TEXT', 'account.consent.requirements.all_done', 'Message when every required agreement is accepted', 'You have accepted everything your account needs.', '[]'::jsonb),
      (5,  'PLAIN_TEXT', 'account.consent.requirements.outstanding_intro', 'Introduction before the list of agreements that still need acceptance', 'Please review and accept the following to continue.', '[]'::jsonb),
      (6,  'UI_LABEL',   'account.consent.history.title', 'Heading of the consent history section', 'Your consent history', '[]'::jsonb),
      (7,  'PLAIN_TEXT', 'account.consent.history.empty', 'Message when the person has no consent history', 'You have not accepted or withdrawn anything yet.', '[]'::jsonb),
      (8,  'PLAIN_TEXT', 'account.consent.document.unavailable_note', 'Note shown instead of a document that is not available in the language of the person', 'This document is not available in your language yet, so it cannot be accepted right now. Please try again later.', '[]'::jsonb),
      (9,  'UI_LABEL',   'account.consent.document.read', 'Label of the link that opens a legal document', 'Read the document', '[]'::jsonb),
      (10, 'PLAIN_TEXT', 'account.consent.document.version', 'The version number of a legal document', 'Version {version}',
            '[{"name": "version", "type": "COUNT", "description": "The version number of the document", "example": 3, "pii": "NONE"}]'::jsonb),
      (11, 'PLAIN_TEXT', 'account.consent.document.locale', 'The language of a legal document', 'Language: {locale}',
            '[{"name": "locale", "type": "STRING", "description": "The locale tag of the document, for example en-US", "example": "en-US", "pii": "NONE"}]'::jsonb),
      (12, 'UI_LABEL',   'account.consent.action.accept', 'Button that records the acceptance of a document', 'Accept', '[]'::jsonb),
      (13, 'UI_LABEL',   'account.consent.action.withdraw', 'Button that withdraws an accepted consent', 'Withdraw consent', '[]'::jsonb),
      (14, 'PLAIN_TEXT', 'account.consent.accepted_on', 'When a document was accepted', 'Accepted on {date}',
            '[{"name": "date", "type": "STRING", "description": "A readable date, formatted by the web server in the person time zone", "example": "Oct 16, 2026", "pii": "NONE"}]'::jsonb),
      (15, 'UI_LABEL',   'account.consent.purpose.terms_of_service', 'Label of the Terms of Service consent purpose', 'Terms of Service', '[]'::jsonb),
      (16, 'UI_LABEL',   'account.consent.purpose.privacy_policy', 'Label of the Privacy Policy consent purpose', 'Privacy Policy', '[]'::jsonb),
      (17, 'UI_LABEL',   'account.consent.status.not_required', 'Requirement status: not required for this account', 'Not required', '[]'::jsonb),
      (18, 'UI_LABEL',   'account.consent.status.satisfied', 'Requirement status: accepted', 'Accepted', '[]'::jsonb),
      (19, 'UI_LABEL',   'account.consent.status.outstanding', 'Requirement status: waiting for acceptance', 'Waiting for your acceptance', '[]'::jsonb),
      (20, 'UI_LABEL',   'account.consent.status.reacceptance_required', 'Requirement status: a newer version must be accepted', 'A newer version needs your acceptance', '[]'::jsonb),
      (21, 'UI_LABEL',   'account.consent.status.document_unavailable', 'Requirement status: the document is not available', 'Document not available', '[]'::jsonb),
      (22, 'UI_LABEL',   'account.consent.state.none', 'Consent state: never accepted', 'Not accepted', '[]'::jsonb),
      (23, 'UI_LABEL',   'account.consent.state.accepted', 'Consent state: accepted', 'Accepted', '[]'::jsonb),
      (24, 'UI_LABEL',   'account.consent.state.withdrawn', 'Consent state: withdrawn', 'Withdrawn', '[]'::jsonb),
      (25, 'UI_LABEL',   'account.consent.event.accepted', 'Consent history entry: accepted', 'Accepted', '[]'::jsonb),
      (26, 'UI_LABEL',   'account.consent.event.withdrawn', 'Consent history entry: withdrawn', 'Withdrawn', '[]'::jsonb),
      (27, 'PLAIN_TEXT', 'account.consent.notice.accepted', 'Consents page notice: acceptance recorded', 'Your acceptance was recorded.', '[]'::jsonb),
      (28, 'PLAIN_TEXT', 'account.consent.notice.withdrawn', 'Consents page notice: consent withdrawn', 'Your consent was withdrawn.', '[]'::jsonb),
      (29, 'PLAIN_TEXT', 'account.consent.notice.already_accepted', 'Consents page notice: this version was already accepted', 'You had already accepted this version.', '[]'::jsonb),
      (30, 'PLAIN_TEXT', 'account.consent.error.purpose_not_found', 'Consent error message: unknown purpose', 'That agreement was not found.', '[]'::jsonb),
      (31, 'PLAIN_TEXT', 'account.consent.error.purpose_inactive', 'Consent error message: purpose is not open for acceptance', 'That agreement is not open for acceptance.', '[]'::jsonb),
      (32, 'PLAIN_TEXT', 'account.consent.error.version_not_found', 'Consent error message: unknown document version', 'That document version was not found.', '[]'::jsonb),
      (33, 'PLAIN_TEXT', 'account.consent.error.version_not_current', 'Consent error message: the version is not the current one', 'That version is not the current one. Reload the page to see the current version.', '[]'::jsonb),
      (34, 'PLAIN_TEXT', 'account.consent.error.locale_mismatch', 'Consent error message: the language does not match the document', 'The language of the document does not match. Reload the page and try again.', '[]'::jsonb),
      (35, 'PLAIN_TEXT', 'account.consent.error.hash_mismatch', 'Consent error message: the document is not the one that was shown', 'The document is not the one you were shown. Reload the page to review the current version.', '[]'::jsonb),
      (36, 'PLAIN_TEXT', 'account.consent.error.not_withdrawable', 'Consent error message: the agreement cannot be withdrawn', 'This agreement cannot be withdrawn.', '[]'::jsonb),
      (37, 'PLAIN_TEXT', 'account.consent.error.not_accepted', 'Consent error message: nothing to withdraw', 'There is nothing to withdraw: this agreement is not accepted.', '[]'::jsonb),
      (38, 'PLAIN_TEXT', 'account.consent.error.required_for_role', 'Consent error message: the agreement is required for the account', 'This agreement is required for your account and cannot be withdrawn.', '[]'::jsonb),
      (39, 'PLAIN_TEXT', 'account.consent.error.required', 'Consent error message: required agreements are outstanding', 'Some required agreements still need your acceptance.', '[]'::jsonb),
      (40, 'PLAIN_TEXT', 'account.consent.error.unavailable', 'Consent error message: any failure that is not one of the consent error codes (service unavailable, unexpected error)', 'Consent could not be recorded right now. Please try again.', '[]'::jsonb)
    ) AS t (ord, content_type, key, description, body, variables)
    ORDER BY ord
  LOOP
    INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
    VALUES (v_seed.key, v_seed.content_type, 'CONTENT', v_seed.description, 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'PLATFORM', v_actor)
    RETURNING entry_id INTO v_entry_id;
    FOR v_var IN SELECT * FROM jsonb_to_recordset(v_seed.variables) AS x (name text, type text, description text, example jsonb, pii text) LOOP
      INSERT INTO content.entry_variables (entry_id, name, var_type, is_required, description, example_value, pii_class)
      VALUES (v_entry_id, v_var.name, v_var.type, true, v_var.description, v_var.example, v_var.pii);
    END LOOP;
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
