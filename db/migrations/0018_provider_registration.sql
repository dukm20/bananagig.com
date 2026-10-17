-- checkpoint: PRO-001
-- purpose: add the provider-domain REGISTRATION: the state of an account that wants to become a provider, in a new `provider` schema. A provider is NOT a second account: one identity.accounts row holds the application roles CUSTOMER and PROVIDER (ID-001), and a registration is provider-domain state ABOUT that account (one row per attempt, the chosen market, the chosen service types, a draft revision, an immutable audit trail). Three concepts stay separate: the application ROLE (identity.account_roles: may this account act as PROVIDER?), the REGISTRATION (this schema: where is the account in onboarding?) and GO-LIVE eligibility (PRO-003: can the provider receive marketplace work?). Contact state (ID-002/003), consent (ID-005), verification (TRUST-001), subscription, profile and Gigs are NOT stored here: they are composed from their owners. Seeds: the five policy parameters of the registration (configuration, CFG-001) and the minimal copy of the flow (content, CFG-002). No registration is seeded.
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. No registration, selection or audit row is ever deleted or truncated (a registration is cancelled or completed and keeps its row; a restart is a new attempt), so there is nothing to restore; the seeded values and copy are changed through the configuration and content workflows, never by editing this file
-- backfill: none; every table is new and nothing references the provider schema yet. Accounts that already hold a PROVIDER membership from the Keycloak bootstrap (DEBT-0044) have no registration until they start one
-- risk: low. All objects are new and small. The only readers are the registration service and its API; the only existing objects touched are READ by the guards (identity.accounts, catalog.service_types) with FOR SHARE locks
-- destructive: none
-- events: the seeds emit no outbox events (they run before any consumer exists); every start, completion and cancellation after this migration goes through ProviderRegistrationService, which writes the event in the same transaction
-- audit: the configuration and content seeds write their own audit trails exactly as the real workflows do; the provider audit trail starts empty
-- DECISIONS: (1) one table row per ATTEMPT, so a cancelled registration keeps its history and a restart is the next attempt (a unique partial index allows at most one LIVE attempt, IN_PROGRESS or COMPLETED, per account); (2) status IN_PROGRESS -> COMPLETED | CANCELLED only: there is no SUBMITTED state because nothing reviews a submission yet, so submit validates and completes in one transaction (a review step would widen the CHECK); (3) the market is a nullable column of the attempt (one market per registration) and the service types are rows of a child table keyed by service_type_id: the taxonomy is referenced, never copied; (4) onboarding steps are DERIVED (contact, legal, verification, subscription, profile, Gigs live in their own domains) and are never persisted here; (5) `revision` is the concurrency token of the draft selections, frozen with the row once the registration leaves IN_PROGRESS; (6) a selection may only name an ACTIVE service type (the guard reads the service type FOR SHARE, so a concurrent retirement serializes); whether it is offered in the chosen market and whether the market is open for registration are POLICY (configuration) checked by the service and again at submit; (7) PLANNED markets are closed by default (`market_statuses_allowed` = ["ACTIVE"]): whether providers may pre-register in a planned market is an unresolved product decision (DEBT-0085); (8) no personal data: no email, phone, name, address, document or legal text is stored; the account is referenced by id only

-- =====================================================================================================================
-- 1. schema and the refusal function
-- =====================================================================================================================
CREATE SCHEMA provider;
COMMENT ON SCHEMA provider IS 'Application-owned provider domain (PRO-001): the registration of an account that wants to become a provider (attempts, the chosen market and service types, an audit trail). The provider is the same account as the customer; contact state, consent, verification, subscription, profile and Gigs belong to their own domains and are composed, never copied. Go-Live eligibility is PRO-003.';

CREATE FUNCTION provider.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (% is not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ROW_IMMUTABLE';
END;
$$;
COMMENT ON FUNCTION provider.forbid_mutation() IS 'Refuses UPDATE, DELETE and TRUNCATE of the audit trail and TRUNCATE of every other provider table (ROW_IMMUTABLE).';

-- =====================================================================================================================
-- 2. registrations (one row per attempt)
-- =====================================================================================================================
CREATE TABLE provider.registrations (
  provider_registration_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id               uuid        NOT NULL,
  attempt_number           integer     NOT NULL,
  status                   text        NOT NULL DEFAULT 'IN_PROGRESS',
  market_id                uuid,
  revision                 integer     NOT NULL DEFAULT 1,
  completed_at             timestamptz,
  cancelled_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_registrations PRIMARY KEY (provider_registration_id),
  CONSTRAINT uq_registrations__attempt UNIQUE (account_id, attempt_number),
  CONSTRAINT fk_registrations__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_registrations__market_id FOREIGN KEY (market_id) REFERENCES geography.markets (market_id) ON DELETE RESTRICT,
  CONSTRAINT ck_registrations__attempt CHECK (attempt_number >= 1),
  CONSTRAINT ck_registrations__revision CHECK (revision >= 1),
  CONSTRAINT ck_registrations__status CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT ck_registrations__lifecycle CHECK (
    (status = 'IN_PROGRESS' AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'COMPLETED' AND completed_at IS NOT NULL AND cancelled_at IS NULL AND market_id IS NOT NULL)
    OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND completed_at IS NULL))
);
CREATE UNIQUE INDEX uq_registrations__live ON provider.registrations (account_id) WHERE status <> 'CANCELLED';
COMMENT ON TABLE provider.registrations IS 'One ATTEMPT of an account to become a provider (PRO-001). The account is the existing identity account (the provider is not a second account); the application ROLE is identity.account_roles and the registration status is a separate fact; Go-Live eligibility is a third (PRO-003). A registration is IN_PROGRESS, then COMPLETED (submit validated by the server) or CANCELLED; both are terminal and the row is frozen. A restart after a cancellation is a NEW attempt. At most one live attempt (IN_PROGRESS or COMPLETED) per account. Never deleted or truncated. Holds no contact, consent, verification, subscription, profile or Gig state and no personal data.';
COMMENT ON COLUMN provider.registrations.account_id IS 'The identity account (foreign key, restrict). Taken from the authenticated request, never from a client.';
COMMENT ON COLUMN provider.registrations.attempt_number IS '1, 2, 3 per account: contiguous (the guard accepts only the highest plus one), so the history of attempts reads without gaps.';
COMMENT ON COLUMN provider.registrations.status IS 'IN_PROGRESS (editable, initial only), COMPLETED (the PRO-001 requirements were met when the account submitted; NOT verified, NOT subscribed, NOT live) or CANCELLED. There is no SUBMITTED state: submit validates and completes in one step.';
COMMENT ON COLUMN provider.registrations.market_id IS 'The market the provider intends to work in (one per registration), chosen while IN_PROGRESS. Whether its status allows registration is configuration (provider.registration.market_statuses_allowed), checked by the service at selection and at submit. NULL until chosen; required by COMPLETED.';
COMMENT ON COLUMN provider.registrations.revision IS 'Concurrency token of the draft selections: the service bumps it on every change while IN_PROGRESS and a write or submit that names a revision is refused when it is not the current one. Frozen once the registration leaves IN_PROGRESS.';

-- =====================================================================================================================
-- 3. registration_service_types (the service types the provider intends to offer)
-- =====================================================================================================================
CREATE TABLE provider.registration_service_types (
  provider_registration_id uuid        NOT NULL,
  service_type_id          uuid        NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_registration_service_types PRIMARY KEY (provider_registration_id, service_type_id),
  CONSTRAINT fk_registration_service_types__registration_id FOREIGN KEY (provider_registration_id) REFERENCES provider.registrations (provider_registration_id) ON DELETE RESTRICT,
  CONSTRAINT fk_registration_service_types__service_type_id FOREIGN KEY (service_type_id) REFERENCES catalog.service_types (service_type_id) ON DELETE RESTRICT
);
COMMENT ON TABLE provider.registration_service_types IS 'The service types (CAT-001) a registration intends to offer: a reference by service_type_id, nothing of the taxonomy is copied and no Gig is created. A selection changes only while the registration is IN_PROGRESS (a replace is a delete plus inserts in one transaction; an UPDATE is refused); afterwards the rows are history. A selection names an ACTIVE service type at the time it is made; a service type retired later stays explainable through the foreign key.';

-- =====================================================================================================================
-- 4. audit trail
-- =====================================================================================================================
CREATE TABLE provider.audit_events (
  audit_event_id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  occurred_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor                    text        NOT NULL,
  action                   text        NOT NULL,
  provider_registration_id uuid        NOT NULL,
  changes                  jsonb,
  reason                   text,
  correlation_id           text        NOT NULL,
  CONSTRAINT pk_audit_events PRIMARY KEY (audit_event_id),
  CONSTRAINT fk_audit_events__registration_id FOREIGN KEY (provider_registration_id) REFERENCES provider.registrations (provider_registration_id) ON DELETE RESTRICT,
  CONSTRAINT ck_audit_events__action CHECK (action IN (
    'PROVIDER_REGISTRATION_STARTED', 'PROVIDER_MARKET_SELECTED', 'PROVIDER_SERVICES_UPDATED', 'PROVIDER_REGISTRATION_COMPLETED', 'PROVIDER_REGISTRATION_CANCELLED')),
  CONSTRAINT ck_audit_events__changes_object CHECK (changes IS NULL OR jsonb_typeof(changes) = 'object'),
  CONSTRAINT ck_audit_events__reason CHECK (reason IS NULL OR (length(btrim(reason)) > 0 AND length(reason) <= 1000)),
  CONSTRAINT ck_audit_events__actor CHECK (length(btrim(actor)) > 0 AND length(actor) <= 200)
);
COMMENT ON TABLE provider.audit_events IS 'Append-only audit trail of the registration: who (account:<id> or system:<name>, never a token), what, when, the field-level diff (a JSON object of identifiers, codes and counts, never a contact, a text or a name), an optional reason and the correlation id. Reads are never audited. Rows are immutable and never truncated. Role changes are audited by the identity domain, contact and consent changes by theirs: they are not duplicated here.';

-- Index justification (DATA_MODEL_GUARDRAILS rule 11). Besides the primary keys and unique constraints:
--   uq_registrations__attempt (account_id, attempt_number): the registrations of ONE account (the current one is read through the partial key below; the latest attempt is the highest number) and the contiguity rule.
--   uq_registrations__live (account_id) WHERE status <> 'CANCELLED': THE lookup of the current registration of an account and the rule that there is at most one.
--   pk_registration_service_types (provider_registration_id, service_type_id): the selections of ONE registration and the uniqueness of a selection.
-- Foreign keys deliberately WITHOUT a supporting index (never-deleted targets, no filtered query on the referencing column): registrations.market_id (a management list of registrations by market does not exist yet; add an index through its own review when it does),
--   registration_service_types.service_type_id, audit_events.provider_registration_id.

-- =====================================================================================================================
-- 5. guards (all failures are SQLSTATE 23000 with DETAIL provider_rule:<KEY>)
--    Lock order: the ACCOUNT row (the service locks it FOR UPDATE first, the ID-001 order), then the registration row, then the service type rows (FOR SHARE).
-- =====================================================================================================================
CREATE FUNCTION provider.guard_registrations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a_status text;
  v_max    integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a provider registration is never deleted: cancel it' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'IN_PROGRESS' OR NEW.revision <> 1 OR NEW.completed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'a provider registration starts IN_PROGRESS at revision 1' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:MUST_START_IN_PROGRESS';
    END IF;
    SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id FOR SHARE;
    IF a_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'only an ACTIVE account can start a provider registration' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ACCOUNT_NOT_ACTIVE';
    END IF;
    SELECT COALESCE(max(attempt_number), 0) INTO v_max FROM provider.registrations WHERE account_id = NEW.account_id;
    IF NEW.attempt_number <> v_max + 1 THEN
      RAISE EXCEPTION 'attempt numbers are contiguous: the next attempt is the highest plus one' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:REGISTRATION_ATTEMPT_SEQUENCE';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.provider_registration_id, NEW.account_id, NEW.attempt_number, NEW.created_at) IS DISTINCT FROM (OLD.provider_registration_id, OLD.account_id, OLD.attempt_number, OLD.created_at) THEN
    RAISE EXCEPTION 'the id, the account and the attempt number of a registration are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:IMMUTABLE_IDENTITY';
  END IF;
  IF OLD.status <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'a completed or cancelled registration is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:REGISTRATION_FROZEN';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NEW.status NOT IN ('COMPLETED', 'CANCELLED') THEN
      RAISE EXCEPTION 'the status transition is not allowed' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:STATUS_TRANSITION';
    END IF;
    IF (NEW.market_id, NEW.revision) IS DISTINCT FROM (OLD.market_id, OLD.revision) THEN
      RAISE EXCEPTION 'a registration cannot change in the statement that completes or cancels it' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:REGISTRATION_FROZEN';
    END IF;
    IF NEW.status = 'COMPLETED' THEN
      SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id FOR SHARE;
      IF a_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'only an ACTIVE account can complete a provider registration' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ACCOUNT_NOT_ACTIVE';
      END IF;
      NEW.completed_at := now();
      NEW.cancelled_at := NULL;
    ELSE
      NEW.cancelled_at := now();
      NEW.completed_at := NULL;
    END IF;
  ELSE
    IF NEW.revision < OLD.revision THEN
      RAISE EXCEPTION 'the revision of a registration only grows' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:REVISION_ONLY_GROWS';
    END IF;
    NEW.completed_at := NULL;
    NEW.cancelled_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_registrations__guard BEFORE INSERT OR UPDATE OR DELETE ON provider.registrations FOR EACH ROW EXECUTE FUNCTION provider.guard_registrations();
CREATE TRIGGER trg_registrations__no_truncate BEFORE TRUNCATE ON provider.registrations FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation();
COMMENT ON FUNCTION provider.guard_registrations() IS 'Registration guard: starts IN_PROGRESS at revision 1 for an ACTIVE account (read FOR SHARE) with the next contiguous attempt number, never deleted, id/account/attempt immutable, IN_PROGRESS -> COMPLETED | CANCELLED only, a finished registration is frozen, a completion needs an ACTIVE account and changes nothing else, the revision only grows, timestamps maintained (NOT_DELETABLE, MUST_START_IN_PROGRESS, ACCOUNT_NOT_ACTIVE, REGISTRATION_ATTEMPT_SEQUENCE, IMMUTABLE_IDENTITY, REGISTRATION_FROZEN, STATUS_TRANSITION, REVISION_ONLY_GROWS).';

CREATE FUNCTION provider.guard_registration_service_types() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r_id      uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.provider_registration_id ELSE NEW.provider_registration_id END;
  r_status  text;
  st_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a selection is replaced, never updated' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:IMMUTABLE_IDENTITY';
  END IF;
  SELECT status INTO r_status FROM provider.registrations WHERE provider_registration_id = r_id FOR SHARE;
  IF r_status IS DISTINCT FROM 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'the selections of a registration change only while it is IN_PROGRESS' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:REGISTRATION_NOT_IN_PROGRESS';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  SELECT status INTO st_status FROM catalog.service_types WHERE service_type_id = NEW.service_type_id FOR SHARE;
  IF st_status = 'RETIRED' THEN
    RAISE EXCEPTION 'a RETIRED service type cannot be newly selected' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:SERVICE_TYPE_RETIRED';
  END IF;
  IF st_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'only an ACTIVE service type can be selected' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:SERVICE_TYPE_NOT_ACTIVE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_registration_service_types__guard BEFORE INSERT OR UPDATE OR DELETE ON provider.registration_service_types FOR EACH ROW EXECUTE FUNCTION provider.guard_registration_service_types();
CREATE TRIGGER trg_registration_service_types__no_truncate BEFORE TRUNCATE ON provider.registration_service_types FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation();
COMMENT ON FUNCTION provider.guard_registration_service_types() IS 'Selection guard: rows change only while the registration is IN_PROGRESS (read FOR SHARE so a concurrent completion or cancellation serializes), a selection is never updated, a newly selected service type must be ACTIVE (read FOR SHARE so a concurrent retirement or deactivation serializes) (REGISTRATION_NOT_IN_PROGRESS, IMMUTABLE_IDENTITY, SERVICE_TYPE_RETIRED, SERVICE_TYPE_NOT_ACTIVE).';

CREATE TRIGGER trg_audit_events__immutable BEFORE UPDATE OR DELETE ON provider.audit_events FOR EACH ROW EXECUTE FUNCTION provider.forbid_mutation();
CREATE TRIGGER trg_audit_events__no_truncate BEFORE TRUNCATE ON provider.audit_events FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation();

-- =====================================================================================================================
-- 6. seed: the registration policy (CFG-001), through the real configuration lifecycle
--    Typed values at PLATFORM scope, read fresh by the service, no code default (a missing or invalid value fails closed). STANDARD criticality: operational policy, not a legal requirement.
--    1 and 2: the PRD wants email and phone verified before any other provider onboarding step (PR-01.03, PR-01.05).
--    3: ENGINEERING ASSUMPTION, the PRD does not say whether providers may pre-register in a PLANNED market; the conservative default is ACTIVE markets only (DEBT-0085).
--    4: the PRD saves "the chosen area and service type" at sign-up (PR-01.07): at least one.
--    5: ENGINEERING ASSUMPTION (10), not in the PRD; bounds the size of a registration (DEBT-0085).
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_approver    constant text := 'system:migration-review';
  v_correlation constant text := 'seed-0018';
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
      (1, 'provider.registration.require_verified_email', 'BOOLEAN', NULL::text, 'Whether a provider registration needs the account''s email to be verified before the market and the service types can be chosen and before the registration can be submitted', '{}'::jsonb,
          'true'::jsonb, 'PRD PR-01.03 and PR-01.05: email and phone are verified before any other provider onboarding step'),
      (2, 'provider.registration.require_verified_phone', 'BOOLEAN', NULL::text, 'Whether a provider registration needs the account''s phone to be verified before the market and the service types can be chosen and before the registration can be submitted', '{}'::jsonb,
          'true'::jsonb, 'PRD PR-01.03 and PR-01.05: email and phone are verified before any other provider onboarding step'),
      (3, 'provider.registration.market_statuses_allowed', 'JSON', NULL::text, 'Market statuses (ACTIVE, PLANNED, INACTIVE) in which a provider may register: a list of statuses; the market must also be in effect when it is ACTIVE',
          '{"schema": {"type": "array", "items": {"type": "string", "enum": ["PLANNED", "ACTIVE", "INACTIVE"]}, "uniqueItems": true, "minItems": 1, "maxItems": 3}}'::jsonb,
          '["ACTIVE"]'::jsonb, 'PRO-001 engineering assumption, not in the PRD (conservative default: only ACTIVE markets accept provider registration; pre-registration in a PLANNED market is an open product decision, DEBT-0085)'),
      (4, 'provider.registration.min_service_types', 'INTEGER', 'service types', 'Minimum number of service types a provider registration must select before it can be submitted', '{"min": 0, "max": 50}'::jsonb,
          '1'::jsonb, 'PRD PR-01.07: the chosen area and service type are saved at sign-up'),
      (5, 'provider.registration.max_service_types', 'INTEGER', 'service types', 'Maximum number of service types a provider registration can select', '{"min": 1, "max": 50}'::jsonb,
          '10'::jsonb, 'PRO-001 engineering assumption, not in the PRD (bounds the size of a registration; DEBT-0085)')
    ) AS t (ord, key, data_type, unit, description, rules, value, basis)
    ORDER BY ord
  LOOP
    v_reason := 'Initial value (migration 0018): ' || v_seed.basis;
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
    VALUES (v_request, v_approver, 'APPROVE', 'Initial value reviewed with the migration (PRO-001)');
    UPDATE configuration.change_requests SET state = 'APPROVED', updated_at = now() WHERE change_request_id = v_request AND state = 'PENDING_APPROVAL';
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, change_request_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_approver, 'CHANGE_APPROVED', v_parameter, v_request, 'Initial value reviewed with the migration (PRO-001)', v_correlation);

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
-- 7. seed: the minimal copy of the registration flow (CFG-002), through the real content lifecycle (en-US only)
--    Labels, statuses, error messages and page text of the TEMPORARY minimal flow; NO LEGAL TEXT. No variables, no personal data.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0018';
  v_reason      constant text := 'Initial provider registration copy (migration 0018)';
  v_seed        record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1, 'UI_LABEL', 'provider.registration.step.account.label', 'Label of the onboarding step account', 'Your account'),
      (2, 'UI_LABEL', 'provider.registration.step.contact.label', 'Label of the onboarding step contact', 'Verified email and phone'),
      (3, 'UI_LABEL', 'provider.registration.step.legal.label', 'Label of the onboarding step legal', 'Agreements'),
      (4, 'UI_LABEL', 'provider.registration.step.market.label', 'Label of the onboarding step market', 'Where you work'),
      (5, 'UI_LABEL', 'provider.registration.step.services.label', 'Label of the onboarding step services', 'What you offer'),
      (6, 'UI_LABEL', 'provider.registration.step.verification.label', 'Label of the onboarding step verification', 'Verification'),
      (7, 'UI_LABEL', 'provider.registration.step.subscription.label', 'Label of the onboarding step subscription', 'Subscription'),
      (8, 'UI_LABEL', 'provider.registration.step.profile.label', 'Label of the onboarding step profile', 'Public profile'),
      (9, 'UI_LABEL', 'provider.registration.step.gigs.label', 'Label of the onboarding step gigs', 'Your services'),
      (10, 'UI_LABEL', 'provider.registration.step_status.not_started', 'Label of the onboarding step status not_started', 'Not started'),
      (11, 'UI_LABEL', 'provider.registration.step_status.in_progress', 'Label of the onboarding step status in_progress', 'In progress'),
      (12, 'UI_LABEL', 'provider.registration.step_status.complete', 'Label of the onboarding step status complete', 'Complete'),
      (13, 'UI_LABEL', 'provider.registration.step_status.blocked', 'Label of the onboarding step status blocked', 'Needs attention'),
      (14, 'UI_LABEL', 'provider.registration.step_status.not_available', 'Label of the onboarding step status not_available', 'Not available yet'),
      (15, 'UI_LABEL', 'provider.registration.step_status.not_required', 'Label of the onboarding step status not_required', 'Not required'),
      (16, 'UI_LABEL', 'provider.registration.status.in_progress', 'Label of the registration status in_progress', 'Registration in progress'),
      (17, 'UI_LABEL', 'provider.registration.status.completed', 'Label of the registration status completed', 'Registration complete'),
      (18, 'UI_LABEL', 'provider.registration.status.cancelled', 'Label of the registration status cancelled', 'Registration cancelled'),
      (19, 'UI_LABEL', 'provider.registration.role.none', 'Label of the provider role state none', 'Not a provider yet'),
      (20, 'UI_LABEL', 'provider.registration.role.pending', 'Label of the provider role state pending', 'Provider role requested'),
      (21, 'UI_LABEL', 'provider.registration.role.active', 'Label of the provider role state active', 'Provider role active'),
      (22, 'UI_LABEL', 'provider.registration.role.inactive', 'Label of the provider role state inactive', 'Provider role inactive'),
      (23, 'PLAIN_TEXT', 'provider.registration.error.registration_not_found', 'Provider registration error message registration_not_found', 'You have not started provider registration.'),
      (24, 'PLAIN_TEXT', 'provider.registration.error.registration_not_in_progress', 'Provider registration error message registration_not_in_progress', 'This registration can no longer be changed.'),
      (25, 'PLAIN_TEXT', 'provider.registration.error.role_inactive', 'Provider registration error message role_inactive', 'Your provider role is inactive. Contact support to restore it.'),
      (26, 'PLAIN_TEXT', 'provider.registration.error.account_not_active', 'Provider registration error message account_not_active', 'Your account is not active.'),
      (27, 'PLAIN_TEXT', 'provider.registration.error.prerequisite_not_met', 'Provider registration error message prerequisite_not_met', 'Verify your email and phone before you continue.'),
      (28, 'PLAIN_TEXT', 'provider.registration.error.market_not_eligible', 'Provider registration error message market_not_eligible', 'Provider registration is not open in that market.'),
      (29, 'PLAIN_TEXT', 'provider.registration.error.market_required', 'Provider registration error message market_required', 'Choose where you work first.'),
      (30, 'PLAIN_TEXT', 'provider.registration.error.service_type_not_eligible', 'Provider registration error message service_type_not_eligible', 'One of the selected services is not available in your market.'),
      (31, 'PLAIN_TEXT', 'provider.registration.error.service_count_out_of_range', 'Provider registration error message service_count_out_of_range', 'Choose a number of services within the allowed range.'),
      (32, 'PLAIN_TEXT', 'provider.registration.error.registration_incomplete', 'Provider registration error message registration_incomplete', 'Some steps are still open.'),
      (33, 'PLAIN_TEXT', 'provider.registration.error.stale_registration', 'Provider registration error message stale_registration', 'This page is out of date. Reload it and try again.'),
      (34, 'PLAIN_TEXT', 'provider.registration.error.validation_failed', 'Provider registration error message validation_failed', 'Check the highlighted fields.'),
      (35, 'PLAIN_TEXT', 'provider.registration.error.conflict', 'Provider registration error message conflict', 'Another change happened at the same time. Try again.'),
      (36, 'PLAIN_TEXT', 'provider.registration.error.unavailable', 'Provider registration error message unavailable', 'Provider registration is temporarily unavailable.'),
      (37, 'UI_LABEL', 'provider.registration.page.title', 'Provider registration page copy title', 'Become a provider'),
      (38, 'PLAIN_TEXT', 'provider.registration.page.intro', 'Provider registration page copy intro', 'Use your existing account to offer services on BananaGig. Your email, phone and agreements are reused, nothing is entered twice.'),
      (39, 'UI_LABEL', 'provider.registration.page.start_action', 'Provider registration page copy start_action', 'Start provider registration'),
      (40, 'UI_LABEL', 'provider.registration.page.market_heading', 'Provider registration page copy market_heading', 'Where you work'),
      (41, 'UI_LABEL', 'provider.registration.page.market_label', 'Provider registration page copy market_label', 'Market'),
      (42, 'PLAIN_TEXT', 'provider.registration.page.market_help', 'Provider registration page copy market_help', 'Choose the market where you plan to offer services.'),
      (43, 'UI_LABEL', 'provider.registration.page.services_heading', 'Provider registration page copy services_heading', 'What you offer'),
      (44, 'PLAIN_TEXT', 'provider.registration.page.services_help', 'Provider registration page copy services_help', 'Choose the services you plan to offer. You can build your offers later.'),
      (45, 'UI_LABEL', 'provider.registration.page.save_action', 'Provider registration page copy save_action', 'Save'),
      (46, 'UI_LABEL', 'provider.registration.page.submit_action', 'Provider registration page copy submit_action', 'Complete registration'),
      (47, 'UI_LABEL', 'provider.registration.page.cancel_action', 'Provider registration page copy cancel_action', 'Cancel registration'),
      (48, 'UI_LABEL', 'provider.registration.page.restart_action', 'Provider registration page copy restart_action', 'Start again'),
      (49, 'UI_LABEL', 'provider.registration.page.progress_heading', 'Provider registration page copy progress_heading', 'Your progress'),
      (50, 'PLAIN_TEXT', 'provider.registration.page.empty_markets', 'Provider registration page copy empty_markets', 'No market is open for provider registration yet.'),
      (51, 'PLAIN_TEXT', 'provider.registration.page.empty_services', 'Provider registration page copy empty_services', 'No services are available in this market yet.'),
      (52, 'PLAIN_TEXT', 'provider.registration.page.completed_notice', 'Provider registration page copy completed_notice', 'Your registration is complete. Verification, subscription and your offers come next; you are not live yet.'),
      (53, 'PLAIN_TEXT', 'provider.registration.page.cancelled_notice', 'Provider registration page copy cancelled_notice', 'Your registration was cancelled. Your account and your customer role are unchanged.'),
      (54, 'PLAIN_TEXT', 'provider.registration.page.golive_note', 'Provider registration page copy golive_note', 'You are not live yet. Going live needs steps that are not available yet.'),
      (55, 'PLAIN_TEXT', 'provider.registration.page.contact_hint', 'Provider registration page copy contact_hint', 'Verify your email and phone in your account first.'),
      (56, 'PLAIN_TEXT', 'provider.registration.page.legal_hint', 'Provider registration page copy legal_hint', 'Accept the required agreements in your account first.')
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
