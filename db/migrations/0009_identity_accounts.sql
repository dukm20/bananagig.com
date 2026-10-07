-- checkpoint: ID-001
-- purpose: create the identity schema, the application-owned account model: accounts, the external identity mapping to Keycloak (issuer + subject), application roles as reference data (CUSTOMER, PROVIDER), account role membership with a primary role, an immutable account status history, a one-to-one core profile (first and last name, locale, time zone override) and an immutable audit trail; seed the two roles and the account shell copy
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. Accounts, memberships, identities, history and audit rows are never deleted (status changes and new rows instead), so there is nothing to restore; reference rows are never deleted
-- backfill: none; every table is new and no account is seeded (accounts appear on the first authenticated request of a person, from the verified Keycloak identity)
-- risk: low; all objects are new. The seeds are deterministic reference data: two roles and 17 managed copy entries (role names, account status labels, session account labels, name and account-state messages). No personal data, no credentials, no tokens, no Keycloak secrets are stored anywhere in this schema
-- events: the seeds emit no outbox events (they run before any consumer exists, like 0006 to 0008); every account, identity, role and status change after this migration goes through the service, which writes the events
-- audit: the content seed writes the content audit trail (ENTRY_CREATED ... VERSION_ACTIVATED) exactly like 0006 to 0008

-- =====================================================================================================================
-- 1. schema
-- =====================================================================================================================
CREATE SCHEMA identity;
COMMENT ON SCHEMA identity IS 'Application-owned account identity (ID-001): accounts, the mapping to the Keycloak identity (issuer + subject), application roles and memberships, status history, core profile and audit. Keycloak owns credentials, authentication, MFA and protocol sessions; none of that is mirrored here. Admin identities are separate logins in the admin context and never have an account in this schema.';

-- =====================================================================================================================
-- 2. roles (reference data)
-- =====================================================================================================================
CREATE TABLE identity.roles (
  role_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  code             text        NOT NULL,
  name_content_key text        NOT NULL,
  status           text        NOT NULL DEFAULT 'ACTIVE',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_roles PRIMARY KEY (role_id),
  CONSTRAINT uq_roles__code UNIQUE (code),
  CONSTRAINT fk_roles__name_content_key FOREIGN KEY (name_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT ck_roles__code_format CHECK (code ~ '^[A-Z][A-Z0-9_]{1,29}$'),
  CONSTRAINT ck_roles__name_content_key_format CHECK (name_content_key ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$'),
  CONSTRAINT ck_roles__status CHECK (status IN ('ACTIVE', 'INACTIVE'))
);
COMMENT ON TABLE identity.roles IS 'Application roles as reference data (CUSTOMER, PROVIDER). These are marketplace roles of an account, NOT Keycloak roles and NOT fine-grained permissions (those come with the features that need them). The display name is managed content (name_content_key), never a column. Rows are never deleted; the code is immutable; a role cannot be deactivated while an account still holds it.';

-- =====================================================================================================================
-- 3. accounts, memberships, external identities, status history, profile, audit
-- =====================================================================================================================
CREATE TABLE identity.accounts (
  account_id      uuid        NOT NULL DEFAULT gen_random_uuid(),
  status          text        NOT NULL,
  primary_role_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  CONSTRAINT pk_accounts PRIMARY KEY (account_id),
  CONSTRAINT ck_accounts__status CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED', 'CLOSED')),
  CONSTRAINT ck_accounts__closed_at CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
COMMENT ON TABLE identity.accounts IS 'The BananaGig application account of one person. It holds NO Keycloak subject (identity linkage is identity.external_identities), NO credentials, NO contact data (email and phone persistence belongs to the verification checkpoints) and NO address. status is the CURRENT state; every change is recorded in identity.account_status_history (current state plus immutable history is intentional: the current state is read on every authenticated request). Rows are never deleted.';
COMMENT ON COLUMN identity.accounts.status IS 'PENDING (created, not yet activated: no bootstrap path creates it today), ACTIVE, SUSPENDED (blocked by the platform), CLOSURE_REQUESTED (still usable, closure pending), CLOSED (terminal). Transitions are enforced by trigger: PENDING to ACTIVE or CLOSED; ACTIVE to SUSPENDED or CLOSURE_REQUESTED; SUSPENDED to ACTIVE, CLOSURE_REQUESTED or CLOSED; CLOSURE_REQUESTED to ACTIVE or CLOSED. No financial closure semantics exist yet.';
COMMENT ON COLUMN identity.accounts.primary_role_id IS 'The preferred application role of the account, used as the active role when a request names none. Composite foreign key (account_id, primary_role_id) to identity.account_roles: it can only name a role the account holds, and the trigger requires that membership to be ACTIVE; it is cleared before that membership is deactivated and when the account is closed. NULL when the account holds no active role.';

CREATE TABLE identity.account_roles (
  account_id     uuid        NOT NULL,
  role_id        uuid        NOT NULL,
  status         text        NOT NULL,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  activated_at   timestamptz,
  deactivated_at timestamptz,
  granted_by     text        NOT NULL,
  grant_source   text        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_account_roles PRIMARY KEY (account_id, role_id),
  CONSTRAINT fk_account_roles__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_account_roles__role_id FOREIGN KEY (role_id) REFERENCES identity.roles (role_id) ON DELETE RESTRICT,
  CONSTRAINT ck_account_roles__status CHECK (status IN ('PENDING', 'ACTIVE', 'INACTIVE')),
  CONSTRAINT ck_account_roles__lifecycle CHECK (
    (status = 'PENDING' AND activated_at IS NULL AND deactivated_at IS NULL)
    OR (status = 'ACTIVE' AND activated_at IS NOT NULL AND deactivated_at IS NULL)
    OR (status = 'INACTIVE' AND deactivated_at IS NOT NULL)
  ),
  CONSTRAINT ck_account_roles__grant_source CHECK (grant_source IN ('BOOTSTRAP', 'SIGNUP', 'ADMIN', 'SYSTEM')),
  CONSTRAINT ck_account_roles__granted_by CHECK (length(btrim(granted_by)) > 0 AND length(granted_by) <= 200)
);
COMMENT ON TABLE identity.account_roles IS 'Role membership: one row per (account, role), so an account can hold CUSTOMER and PROVIDER at once and a role can never be held twice (the primary key IS the "unique active membership" rule; re-granting a deactivated role reactivates the row). status PENDING (granted, not yet active), ACTIVE, INACTIVE; the history of grants and deactivations is in identity.account_audit_events. granted_by and grant_source describe the latest grant. Rows are never deleted.';

ALTER TABLE identity.accounts
  ADD CONSTRAINT fk_accounts__primary_role FOREIGN KEY (account_id, primary_role_id) REFERENCES identity.account_roles (account_id, role_id) ON DELETE RESTRICT;

CREATE TABLE identity.external_identities (
  external_identity_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id           uuid        NOT NULL,
  provider_type        text        NOT NULL,
  issuer               text        NOT NULL,
  provider_subject     text        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_external_identities PRIMARY KEY (external_identity_id),
  CONSTRAINT uq_external_identities__provider_issuer_subject UNIQUE (provider_type, issuer, provider_subject),
  CONSTRAINT fk_external_identities__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_external_identities__provider_type CHECK (provider_type IN ('KEYCLOAK')),
  CONSTRAINT ck_external_identities__issuer CHECK (length(btrim(issuer)) > 0 AND length(issuer) <= 512 AND issuer !~ '[\u0001-\u001F\u007F]'),
  CONSTRAINT ck_external_identities__subject CHECK (length(btrim(provider_subject)) > 0 AND length(provider_subject) <= 255 AND provider_subject !~ '[\u0001-\u001F\u007F]')
);
COMMENT ON TABLE identity.external_identities IS 'Maps an identity provider login to ONE account. For Keycloak, provider_subject is the immutable JWT sub and issuer the realm issuer. The unique key (provider_type, issuer, provider_subject) makes one subject link to at most one account, and it is the lookup path of every authenticated request. Future social federation still arrives through the Keycloak subject. Nothing about credentials or sessions is stored. Rows are never deleted or re-pointed; only last_seen_at changes.';
COMMENT ON COLUMN identity.external_identities.last_seen_at IS 'Last authenticated request seen for this identity, touched at most once per configured interval (IDENTITY_LAST_SEEN_TOUCH_SECONDS) so authenticated reads do not write on every request.';

CREATE TABLE identity.account_status_history (
  status_history_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  history_seq       bigint      GENERATED ALWAYS AS IDENTITY,
  account_id        uuid        NOT NULL,
  from_status       text,
  to_status         text        NOT NULL,
  reason            text,
  actor             text        NOT NULL,
  occurred_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id    text        NOT NULL,
  CONSTRAINT pk_account_status_history PRIMARY KEY (status_history_id),
  CONSTRAINT uq_account_status_history__seq UNIQUE (history_seq),
  CONSTRAINT fk_account_status_history__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_account_status_history__from_status CHECK (from_status IS NULL OR from_status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED', 'CLOSED')),
  CONSTRAINT ck_account_status_history__to_status CHECK (to_status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSURE_REQUESTED', 'CLOSED')),
  CONSTRAINT ck_account_status_history__changed CHECK (from_status IS DISTINCT FROM to_status),
  CONSTRAINT ck_account_status_history__reason CHECK (reason IS NULL OR (length(btrim(reason)) > 0 AND length(reason) <= 1000)),
  CONSTRAINT ck_account_status_history__actor CHECK (length(btrim(actor)) > 0 AND length(actor) <= 200)
);
COMMENT ON TABLE identity.account_status_history IS 'Append-only history of the account status: from_status (NULL for the creation row), to_status, reason, actor, time and correlation id. history_seq gives a total order even inside one transaction. Two deferred constraint triggers require, at commit, that the newest row equals the CURRENT account status and that every row continues the previous one (from_status = the previous to_status), so the current state and its history cannot drift in either direction. Rows are immutable.';

CREATE TABLE identity.account_profiles (
  account_id      uuid        NOT NULL,
  first_name      text        NOT NULL,
  last_name       text        NOT NULL,
  preferred_locale text,
  time_zone_id    uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_account_profiles PRIMARY KEY (account_id),
  CONSTRAINT fk_account_profiles__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_account_profiles__preferred_locale FOREIGN KEY (preferred_locale) REFERENCES content.locales (locale) ON DELETE RESTRICT,
  CONSTRAINT fk_account_profiles__time_zone_id FOREIGN KEY (time_zone_id) REFERENCES geography.time_zones (time_zone_id) ON DELETE RESTRICT,
  CONSTRAINT ck_account_profiles__first_name CHECK (length(first_name) BETWEEN 1 AND 50 AND first_name !~ '(^\s|\s$)' AND first_name !~ '[\u0001-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]'),
  CONSTRAINT ck_account_profiles__last_name CHECK (length(last_name) BETWEEN 1 AND 50 AND last_name !~ '(^\s|\s$)' AND last_name !~ '[\u0001-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]')
);
COMMENT ON TABLE identity.account_profiles IS 'Core profile of an account, one row at most (account_id is the key): first and last name (1 to 50 characters, trimmed, no control or bidirectional-override characters: the PRD sign-up rule, a structural constraint and not a configurable policy), the preferred locale (content.locales, the single locale authority) and an optional time zone override (geography.time_zones, never free text). The row exists once the person has given a name, so the name columns are NOT NULL. There is no stored display name: the public display (first name and last initial) is derived on read. Contact data (email, phone), photo, bio and provider or business details are NOT here. PERSONAL DATA: never logged, never in audit changes, never in a public API.';

CREATE TABLE identity.account_audit_events (
  audit_event_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor          text        NOT NULL,
  action         text        NOT NULL,
  account_id     uuid        NOT NULL,
  role_id        uuid,
  changes        jsonb,
  reason         text,
  correlation_id text        NOT NULL,
  CONSTRAINT pk_account_audit_events PRIMARY KEY (audit_event_id),
  CONSTRAINT fk_account_audit_events__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_account_audit_events__role_id FOREIGN KEY (role_id) REFERENCES identity.roles (role_id) ON DELETE RESTRICT,
  CONSTRAINT ck_account_audit_events__action CHECK (action IN ('ACCOUNT_CREATED', 'EXTERNAL_IDENTITY_LINKED', 'ROLE_GRANTED', 'ROLE_ACTIVATED', 'ROLE_DEACTIVATED', 'PRIMARY_ROLE_CHANGED', 'PROFILE_UPDATED')),
  CONSTRAINT ck_account_audit_events__role CHECK ((action LIKE 'ROLE\_%') = (role_id IS NOT NULL)),
  CONSTRAINT ck_account_audit_events__changes_object CHECK (changes IS NULL OR jsonb_typeof(changes) = 'object'),
  CONSTRAINT ck_account_audit_events__actor CHECK (length(btrim(actor)) > 0 AND length(actor) <= 200)
);
COMMENT ON TABLE identity.account_audit_events IS 'Append-only audit of account mutations other than status (status changes are the structured identity.account_status_history): account created, external identity linked, role granted, activated and deactivated, primary role changed, profile updated. changes is a JSON object because its shape depends on the action; it never holds a token, a subject, a name or any personal value (profile updates record the NAMES of the changed fields only). Rows are immutable.';

-- Index justification (DATA_MODEL_GUARDRAILS rule 11). Besides the primary keys and unique constraints (each a lookup path or a foreign key target):
--   uq_external_identities__provider_issuer_subject: THE lookup of every authenticated request (issuer + subject -> account), and the rule that one identity links one account.
--   pk_account_roles (account_id, role_id): the membership list of one account (prefix account_id) and the composite foreign key target of accounts.primary_role_id; an account holds a handful of roles, so no
--     separate partial index on status = 'ACTIVE' is needed.
--   pk_account_profiles (account_id): profile lookup by account.
--   idx_account_status_history__account / idx_account_audit_events__account: the timeline of ONE account, newest first. These are the only tables that grow per account and are read per account.
CREATE INDEX idx_account_status_history__account ON identity.account_status_history (account_id, history_seq DESC);
CREATE INDEX idx_account_audit_events__account ON identity.account_audit_events (account_id, occurred_at DESC);

-- Foreign keys deliberately WITHOUT a supporting index (DATA_MODEL_GUARDRAILS rule 11; same list and reasons as NORMALIZATION_LOG.md, ID-001). Accounts, roles, locales and time zones are never
-- deleted or re-keyed, so no foreign key check ever scans the referencing table, and no query filters by these columns yet:
--   external_identities.account_id: lookups go from the identity to the account, never from an account to its identities in a hot path (an account has one Keycloak identity).
--   account_roles.role_id: "who holds role X" is an administrative query that does not exist yet; a role is never deleted.
--   accounts.primary_role_id: covered by the composite key to account_roles; read through the account row.
--   roles.name_content_key, account_profiles.preferred_locale, account_profiles.time_zone_id, account_audit_events.role_id: never-deleted reference targets, no filtered query.
-- An index is added through its own data model review when a query path appears (administrative role listing, account search); there are no speculative indexes.

-- =====================================================================================================================
-- 4. guards: the database enforces the lifecycle and immutability itself (defense in depth under the service)
--    Every RAISE carries a machine-readable key in DETAIL (exactly 'identity_rule:<KEY>'); the service classifies by that key, never by message text.
--    Lock order (service and triggers): the account row first (FOR UPDATE), then the role row (FOR SHARE), then the membership, identity and profile rows of that account.
--    A rule that reads sibling rows (is this role the primary role of the account?) locks the owning account row first.
-- =====================================================================================================================
CREATE FUNCTION identity.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (% is not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ROW_IMMUTABLE';
END;
$$;
CREATE TRIGGER trg_account_status_history__immutable BEFORE UPDATE OR DELETE ON identity.account_status_history FOR EACH ROW EXECUTE FUNCTION identity.forbid_mutation();
CREATE TRIGGER trg_account_audit_events__immutable BEFORE UPDATE OR DELETE ON identity.account_audit_events FOR EACH ROW EXECUTE FUNCTION identity.forbid_mutation();

CREATE FUNCTION identity.guard_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'roles cannot be deleted; deactivate them instead' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.role_id, NEW.code, NEW.created_at) IS DISTINCT FROM (OLD.role_id, OLD.code, OLD.created_at) THEN
      RAISE EXCEPTION 'role identity (id and code) is immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:IMMUTABLE_IDENTITY';
    END IF;
    IF OLD.status = 'ACTIVE' AND NEW.status = 'INACTIVE' THEN
      IF EXISTS (SELECT 1 FROM identity.account_roles WHERE role_id = OLD.role_id AND status IN ('PENDING', 'ACTIVE')) THEN
        RAISE EXCEPTION 'role % is held by an account and cannot be deactivated', OLD.code USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ROLE_IN_USE';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_roles__guard BEFORE UPDATE OR DELETE ON identity.roles FOR EACH ROW EXECUTE FUNCTION identity.guard_roles();

CREATE FUNCTION identity.guard_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounts cannot be deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:NOT_DELETABLE';
  END IF;
  -- OLD does not exist for INSERT, so INSERT and UPDATE are handled in separate branches
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('PENDING', 'ACTIVE') OR NEW.primary_role_id IS NOT NULL THEN
      RAISE EXCEPTION 'an account starts PENDING or ACTIVE and without a primary role' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_INITIAL_STATE';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.account_id, NEW.created_at) IS DISTINCT FROM (OLD.account_id, OLD.created_at) THEN
    RAISE EXCEPTION 'account identity is immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:IMMUTABLE_IDENTITY';
  END IF;
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'a CLOSED account cannot change' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_CLOSED';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'PENDING' AND NEW.status IN ('ACTIVE', 'CLOSED'))
      OR (OLD.status = 'ACTIVE' AND NEW.status IN ('SUSPENDED', 'CLOSURE_REQUESTED'))
      OR (OLD.status = 'SUSPENDED' AND NEW.status IN ('ACTIVE', 'CLOSURE_REQUESTED', 'CLOSED'))
      OR (OLD.status = 'CLOSURE_REQUESTED' AND NEW.status IN ('ACTIVE', 'CLOSED'))
    ) THEN
      RAISE EXCEPTION 'account status cannot change from % to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_STATUS_TRANSITION';
    END IF;
    IF NEW.status = 'CLOSED' THEN
      -- the account row is locked by this UPDATE, so a concurrent grant (which share-locks the account row) serializes with it
      IF NEW.primary_role_id IS NOT NULL OR EXISTS (SELECT 1 FROM identity.account_roles WHERE account_id = OLD.account_id AND status IN ('PENDING', 'ACTIVE')) THEN
        RAISE EXCEPTION 'a closed account cannot hold an active role or a primary role' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_HAS_ACTIVE_ROLES';
      END IF;
    END IF;
  END IF;
  IF NEW.primary_role_id IS NOT NULL AND NEW.primary_role_id IS DISTINCT FROM OLD.primary_role_id THEN
    SELECT status INTO m_status FROM identity.account_roles WHERE account_id = NEW.account_id AND role_id = NEW.primary_role_id FOR SHARE;
    IF m_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'the primary role must be an ACTIVE role of the account' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PRIMARY_ROLE_NOT_ACTIVE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_accounts__guard BEFORE INSERT OR UPDATE OR DELETE ON identity.accounts FOR EACH ROW EXECUTE FUNCTION identity.guard_accounts();

-- the CURRENT status of an account must equal its newest history row at commit (deferred: the service writes the row and the status in one transaction).
-- The check reads the account row as it is at commit, not the row version that queued the event, so a transaction that passes through a transient
-- status (suspend and reactivate) is fine as long as the end state and the history agree. Two deferred triggers: one on the account (a status change
-- without its history row) and one on the history (a stray row, or a row whose from_status does not continue the previous row).
CREATE FUNCTION identity.check_status_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  newest text;
  current_status text;
BEGIN
  SELECT status INTO current_status FROM identity.accounts WHERE account_id = NEW.account_id;
  SELECT to_status INTO newest FROM identity.account_status_history WHERE account_id = NEW.account_id ORDER BY history_seq DESC LIMIT 1;
  IF newest IS DISTINCT FROM current_status THEN
    RAISE EXCEPTION 'the account status and its newest status history row must agree' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:STATUS_HISTORY_MISMATCH';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_accounts__status_history AFTER INSERT OR UPDATE OF status ON identity.accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.check_status_history();

CREATE FUNCTION identity.check_status_history_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous text;
  newest text;
  current_status text;
BEGIN
  SELECT to_status INTO previous FROM identity.account_status_history WHERE account_id = NEW.account_id AND history_seq < NEW.history_seq ORDER BY history_seq DESC LIMIT 1;
  IF NEW.from_status IS DISTINCT FROM previous THEN
    RAISE EXCEPTION 'a status history row must continue the previous row of the account' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:STATUS_HISTORY_MISMATCH';
  END IF;
  SELECT status INTO current_status FROM identity.accounts WHERE account_id = NEW.account_id;
  SELECT to_status INTO newest FROM identity.account_status_history WHERE account_id = NEW.account_id ORDER BY history_seq DESC LIMIT 1;
  IF newest IS DISTINCT FROM current_status THEN
    RAISE EXCEPTION 'the account status and its newest status history row must agree' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:STATUS_HISTORY_MISMATCH';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_account_status_history__consistent AFTER INSERT ON identity.account_status_history DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.check_status_history_row();

CREATE FUNCTION identity.guard_account_roles() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r_status text;
  a_status text;
  activating boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'role memberships cannot be deleted; deactivate them instead' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('PENDING', 'ACTIVE') THEN
      RAISE EXCEPTION 'a membership starts PENDING or ACTIVE' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ROLE_STATUS_TRANSITION';
    END IF;
    activating := true;
  ELSE
    IF (NEW.account_id, NEW.role_id) IS DISTINCT FROM (OLD.account_id, OLD.role_id) THEN
      RAISE EXCEPTION 'membership identity (account and role) is immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:IMMUTABLE_IDENTITY';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
      (OLD.status = 'PENDING' AND NEW.status IN ('ACTIVE', 'INACTIVE'))
      OR (OLD.status = 'ACTIVE' AND NEW.status = 'INACTIVE')
      OR (OLD.status = 'INACTIVE' AND NEW.status = 'ACTIVE')
    ) THEN
      RAISE EXCEPTION 'membership status cannot change from % to %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ROLE_STATUS_TRANSITION';
    END IF;
    activating := NEW.status = 'ACTIVE' AND OLD.status <> 'ACTIVE';
  END IF;
  IF activating THEN
    -- share locks: a concurrent role deactivation or account closure (which need the row lock) serializes with this change
    SELECT status INTO r_status FROM identity.roles WHERE role_id = NEW.role_id FOR SHARE;
    IF NEW.status IN ('ACTIVE', 'PENDING') AND r_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'the role is not ACTIVE' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ROLE_NOT_ACTIVE';
    END IF;
    SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id FOR SHARE;
    IF a_status = 'CLOSED' THEN
      RAISE EXCEPTION 'a closed account cannot receive a role' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_CLOSED';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE' THEN
      -- the primary role must be cleared (or moved) first; the account row is locked before it is read, so a concurrent change of the primary role serializes with this
      PERFORM 1 FROM identity.accounts WHERE account_id = OLD.account_id FOR UPDATE;
      IF EXISTS (SELECT 1 FROM identity.accounts WHERE account_id = OLD.account_id AND primary_role_id = OLD.role_id) THEN
        RAISE EXCEPTION 'the membership is the primary role of the account; change the primary role first' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PRIMARY_ROLE_IN_USE';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_account_roles__guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_roles FOR EACH ROW EXECUTE FUNCTION identity.guard_account_roles();

CREATE FUNCTION identity.guard_external_identities() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'external identities cannot be deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.external_identity_id, NEW.account_id, NEW.provider_type, NEW.issuer, NEW.provider_subject, NEW.created_at)
       IS DISTINCT FROM (OLD.external_identity_id, OLD.account_id, OLD.provider_type, OLD.issuer, OLD.provider_subject, OLD.created_at) THEN
      RAISE EXCEPTION 'an external identity is immutable except for last_seen_at' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:IMMUTABLE_IDENTITY';
    END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id FOR SHARE;
  IF a_status = 'CLOSED' THEN
    RAISE EXCEPTION 'a closed account cannot receive an identity link' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_CLOSED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_external_identities__guard BEFORE INSERT OR UPDATE OR DELETE ON identity.external_identities FOR EACH ROW EXECUTE FUNCTION identity.guard_external_identities();

CREATE FUNCTION identity.guard_account_profiles() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'profiles cannot be deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.account_id, NEW.created_at) IS DISTINCT FROM (OLD.account_id, OLD.created_at) THEN
      RAISE EXCEPTION 'profile identity is immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:IMMUTABLE_IDENTITY';
    END IF;
  END IF;
  SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id FOR SHARE;
  IF a_status = 'CLOSED' THEN
    RAISE EXCEPTION 'the profile of a closed account cannot change' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_CLOSED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_account_profiles__guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_profiles FOR EACH ROW EXECUTE FUNCTION identity.guard_account_profiles();

-- =====================================================================================================================
-- 5. seed: managed copy (role names, account status labels, session account labels, name and account-state messages), through the real content lifecycle
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0009';
  v_reason      constant text := 'Initial account shell copy (migration 0009)';
  v_seed        record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1,  'UI_LABEL',   'identity.role.customer.name',          'Display name of the CUSTOMER application role',                       'Customer'),
      (2,  'UI_LABEL',   'identity.role.provider.name',          'Display name of the PROVIDER application role',                       'Provider'),
      (3,  'UI_LABEL',   'account.status.pending',               'Label of the account status PENDING',                                 'Pending'),
      (4,  'UI_LABEL',   'account.status.active',                'Label of the account status ACTIVE',                                  'Active'),
      (5,  'UI_LABEL',   'account.status.suspended',             'Label of the account status SUSPENDED',                               'Suspended'),
      (6,  'UI_LABEL',   'account.status.closure_requested',     'Label of the account status CLOSURE_REQUESTED',                       'Closure requested'),
      (7,  'UI_LABEL',   'account.status.closed',                'Label of the account status CLOSED',                                  'Closed'),
      (8,  'UI_LABEL',   'session.account.id',                   'Session page label of the account identifier',                        'Account'),
      (9,  'UI_LABEL',   'session.account.status',               'Session page label of the account status',                            'Account status'),
      (10, 'UI_LABEL',   'session.account.roles',                'Session page label of the application roles of the account',          'Application roles'),
      (11, 'UI_LABEL',   'session.account.active_role',          'Session page label of the active application role',                   'Active role'),
      (12, 'PLAIN_TEXT', 'session.account.unavailable',          'Session page message when the account could not be loaded',           'Account details are unavailable.'),
      (13, 'PLAIN_TEXT', 'account.error.name_required',          'Validation message: a name is required',                              'Enter a name.'),
      (14, 'PLAIN_TEXT', 'account.error.name_too_long',          'Validation message: a name exceeds the maximum length',               'This name is too long.'),
      (15, 'PLAIN_TEXT', 'account.error.name_invalid_characters','Validation message: a name contains characters that are not allowed', 'This name contains characters that are not allowed.'),
      (16, 'PLAIN_TEXT', 'account.error.suspended',              'Message shown for a suspended account',                               'This account is suspended.'),
      (17, 'PLAIN_TEXT', 'account.error.closed',                 'Message shown for a closed account',                                  'This account is closed.')
    ) AS t (ord, content_type, key, description, body)
    ORDER BY ord
  LOOP
    INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
    VALUES (v_seed.key, v_seed.content_type, 'CONTENT', v_seed.description, 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'PLATFORM', v_actor)
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
-- 6. seed: the two application roles (reference data, no accounts)
-- =====================================================================================================================
INSERT INTO identity.roles (code, name_content_key, status) VALUES
  ('CUSTOMER', 'identity.role.customer.name', 'ACTIVE'),
  ('PROVIDER', 'identity.role.provider.name', 'ACTIVE');
