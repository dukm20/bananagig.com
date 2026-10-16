-- checkpoint: ID-004
-- purpose: add the BananaGig-owned application session registry and device registry to the identity schema: application_sessions (one row per identity-provider session the API has seen: derived liveness, revocation with a reason, the browser it came from; fillfactor 80 so the once-a-minute last_seen_at touch is a HOT update), account_devices (the browsers of an account: keyed hash of a device secret, coarse browser/OS/device-class families, the trusted-browser window, removal), the revocation watermark identity.accounts.sessions_not_before ("sign out everywhere"), the audit extension (16 security actions, a session reference and a device reference), the six session/MFA/recovery configuration parameters (CFG-001, three of them PRD values and THREE ENGINEERING ASSUMPTIONS flagged for the security owner) and the security screen copy (CFG-002)
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. Sessions, devices and audit rows are never deleted (revocation and removal are columns, not deletes); the seeded parameters and copy are changed through their own workflows, never by editing this file
-- backfill: none; the tables are new and the new column is nullable (NULL = no "sign out everywhere" has happened). Sessions appear when the API first sees a token of a login
-- risk: low to medium. Two new tables and guards, one nullable column on identity.accounts, one wider CHECK and two nullable columns on identity.account_audit_events. The seeds are deterministic reference data: 6 configuration parameters with one approved PLATFORM value each and the managed security copy. Nothing in this schema stores a credential, a token, a TOTP secret, a recovery code, a raw IP address or a raw user agent: the device secret is stored only as a keyed HMAC-SHA-256 hash (key outside the database) and the user agent only as three coarse families. Keycloak keeps passwords, TOTP, recovery codes and its own protocol sessions
-- destructive: the CHECK constraint ck_account_audit_events__action is dropped and re-created WIDER (sixteen added security actions) in the same transaction; this is a pure widening, no row is changed or removed and the append-only trigger of the table is not involved (expand step of expand/migrate/contract, nothing is contracted)
-- events: the seeds emit no outbox events (they run before any consumer exists, like 0006 to 0011); every session, device and revocation change after this migration goes through SecurityService, which writes the events in the same transaction
-- audit: the configuration seed writes the configuration audit trail (PARAMETER_CREATED ... CHANGE_ACTIVATED) and the content seed writes the content audit trail (ENTRY_CREATED ... VERSION_ACTIVATED), exactly as the real workflows do
-- ASSUMPTIONS (not in the PRD, flagged for the security owner, recorded in TECH_DEBT): security.step_up_valid_minutes = 15, security.activity_log_days = 90, reset_link.max_requests_per_hour = 5. The three PRD values are session.trusted_browser_days = 30 (CU-09.13), session.keep_signed_in_days = 30 (SV-01.12; it MUST equal the realm remember-me lifetimes) and reset_link.validity_minutes = 60 (CU-03.11)

-- =====================================================================================================================
-- 1. the revocation watermark
-- =====================================================================================================================
ALTER TABLE identity.accounts ADD COLUMN sessions_not_before timestamptz;
COMMENT ON COLUMN identity.accounts.sessions_not_before IS 'The "sign out everywhere" watermark: the moment of the account''s latest revoke-all. It only affects a session FIRST SEEN after it: a login whose auth_time is older than this moment (the identity provider session existed, the API had not seen it yet) is refused as revoked. A session that already has a row is governed by its own revoked_at. The comparison tolerates 2 seconds of clock skew between the identity provider and the database (auth_time is whole seconds): a first-seen session is refused only when auth_time + 2 s < sessions_not_before. It never moves back or to NULL, and never into the future (guard trigger). NULL = no revoke-all has happened. Not personal data.';

-- =====================================================================================================================
-- 2. devices (browsers)
-- =====================================================================================================================
CREATE TABLE identity.account_devices (
  account_device_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id        uuid        NOT NULL,
  device_hash       char(64)    NOT NULL,
  browser_family    text        NOT NULL,
  os_family         text        NOT NULL,
  device_class      text        NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  trusted_at        timestamptz,
  trusted_until     timestamptz,
  removed_at        timestamptz,
  CONSTRAINT pk_account_devices PRIMARY KEY (account_device_id),
  CONSTRAINT uq_account_devices__account_hash UNIQUE (account_id, device_hash),
  CONSTRAINT uq_account_devices__account_device UNIQUE (account_id, account_device_id),
  CONSTRAINT fk_account_devices__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_account_devices__device_hash CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_account_devices__browser_family CHECK (browser_family IN ('CHROME', 'FIREFOX', 'SAFARI', 'EDGE', 'OPERA', 'OTHER')),
  CONSTRAINT ck_account_devices__os_family CHECK (os_family IN ('WINDOWS', 'MACOS', 'LINUX', 'IOS', 'ANDROID', 'OTHER')),
  CONSTRAINT ck_account_devices__device_class CHECK (device_class IN ('DESKTOP', 'MOBILE', 'TABLET', 'OTHER')),
  CONSTRAINT ck_account_devices__seen_order CHECK (last_seen_at >= first_seen_at),
  CONSTRAINT ck_account_devices__trust_pair CHECK ((trusted_at IS NULL) = (trusted_until IS NULL)),
  CONSTRAINT ck_account_devices__trust_window CHECK (trusted_until IS NULL OR trusted_until > trusted_at),
  CONSTRAINT ck_account_devices__removed_untrusted CHECK (removed_at IS NULL OR trusted_until IS NULL)
);
COMMENT ON TABLE identity.account_devices IS 'The browsers an account has signed in from, as the API knows them. The web server issues an HttpOnly cookie holding a random 32-byte secret and registers it at login; ONLY device_hash = HMAC-SHA-256(VERIFICATION_HASH_SECRET, domain bananagig:device:v1, account id, secret) is stored (hex), so a database leak yields no usable cookie and the same browser has a different hash on every account. The user agent is reduced to three closed families (browser, operating system, device class) and discarded; no raw IP and no location is stored. trusted_until is the TRUSTED BROWSER window (configuration session.trusted_browser_days): it expires by comparison with the clock (no sweeper), is cleared by untrust/removal, and has NO effect on the identity provider''s own prompt for a second factor and never bypasses a step-up check. A removed device is terminal (a new browser gets a new row). Rows are never deleted. first_seen_at is the creation time of the row (this table has no separate created_at).';
COMMENT ON COLUMN identity.account_devices.device_hash IS 'Hex HMAC-SHA-256 of the device secret, keyed with a server secret held outside the database and bound to the account. The secret itself is never stored or logged. Immutable.';
COMMENT ON COLUMN identity.account_devices.browser_family IS 'CHROME, FIREFOX, SAFARI, EDGE, OPERA or OTHER: the FIRST classification of the user agent at registration (a closed vocabulary; the user agent itself is discarded). Immutable.';
COMMENT ON COLUMN identity.account_devices.os_family IS 'WINDOWS, MACOS, LINUX, IOS, ANDROID or OTHER (first classification, immutable).';
COMMENT ON COLUMN identity.account_devices.device_class IS 'DESKTOP, MOBILE, TABLET or OTHER (first classification, immutable).';
COMMENT ON COLUMN identity.account_devices.last_seen_at IS 'When the browser last registered a login. The "last seen" shown to the owner is GREATEST of this and the newest last_seen_at of the device''s sessions (derived on read, so the hot request path never writes this row). Never moves back.';
COMMENT ON COLUMN identity.account_devices.trusted_until IS 'End of the trusted-browser window, or NULL when the browser is not trusted. Trusted = trusted_until > clock_timestamp() AND removed_at IS NULL, evaluated by the reader; an elapsed window needs no write. trusted_at and trusted_until are set and cleared together.';
COMMENT ON COLUMN identity.account_devices.removed_at IS 'The owner removed the browser (it is untrusted and its sessions were revoked in the same transaction). Terminal: it cannot be trusted or un-removed.';

-- =====================================================================================================================
-- 3. application sessions
-- =====================================================================================================================
CREATE TABLE identity.application_sessions (
  application_session_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id             uuid        NOT NULL,
  keycloak_session_id    text        NOT NULL,
  account_device_id      uuid,
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at             timestamptz,
  revocation_reason      text,
  CONSTRAINT pk_application_sessions PRIMARY KEY (application_session_id),
  CONSTRAINT uq_application_sessions__keycloak_session UNIQUE (keycloak_session_id),
  CONSTRAINT uq_application_sessions__account_session UNIQUE (account_id, application_session_id),
  CONSTRAINT fk_application_sessions__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_application_sessions__account_device FOREIGN KEY (account_id, account_device_id) REFERENCES identity.account_devices (account_id, account_device_id) MATCH SIMPLE ON DELETE RESTRICT,
  CONSTRAINT ck_application_sessions__keycloak_session_id CHECK (length(keycloak_session_id) BETWEEN 1 AND 100 AND keycloak_session_id !~ '[\u0001-\u0020\u007F]'),
  CONSTRAINT ck_application_sessions__revocation_reason CHECK (revocation_reason IS NULL OR revocation_reason IN ('SIGN_OUT', 'REVOKED_BY_USER', 'SIGN_OUT_EVERYWHERE', 'KEYCLOAK_ENDED', 'DEVICE_REMOVED', 'PASSWORD_CHANGED')),
  CONSTRAINT ck_application_sessions__revoked_pair CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL)),
  CONSTRAINT ck_application_sessions__seen_order CHECK (last_seen_at >= created_at AND (revoked_at IS NULL OR revoked_at >= created_at))
) WITH (fillfactor = 80);
COMMENT ON TABLE identity.application_sessions IS 'The application session registry: one row per identity-provider (Keycloak) session that the API has seen on an authenticated web request, created on first sight. It exists so a person can see and END their sessions and so "sign out everywhere" takes effect at once although access tokens live minutes: every web-context request resolves the token''s sid to its row and a revoked row is refused immediately. Keycloak remains the owner of the protocol session; this table never holds a token. keycloak_session_id is the sid claim: an identifier that is never logged, never returned by an API and never put in an audit change or an event (the API hands out the application_session_id). Liveness is DERIVED, not stored: ACTIVE = revoked_at IS NULL (within the configured keep-signed-in window and still known to the identity provider when it can be asked); there is no status column and no expires_at. Revocation is terminal and carries its reason. Rows are never deleted.';
COMMENT ON COLUMN identity.application_sessions.keycloak_session_id IS 'The sid claim of the identity provider session (1 to 100 visible characters). Unique across accounts: a session belongs to exactly one account, and a request whose sid belongs to another account is treated as revoked. SENSITIVE: never logged, returned or audited.';
COMMENT ON COLUMN identity.application_sessions.account_device_id IS 'The browser the login came from, attached once by the web server after login (registerSession). NULL until then (and for a login that never registered a device). Composite foreign key (account_id, account_device_id) with MATCH SIMPLE: a NULL device is not checked, a set device must belong to the same account. Set once, never changed (guard trigger).';
COMMENT ON COLUMN identity.application_sessions.last_seen_at IS 'Last authenticated request seen, touched at most once per minute (one statement on the request path). Never moves back.';
COMMENT ON COLUMN identity.application_sessions.revocation_reason IS 'SIGN_OUT (the person signed out of this session), REVOKED_BY_USER (revoked from the session list), SIGN_OUT_EVERYWHERE (revoke-all), KEYCLOAK_ENDED (the identity provider no longer knows it, or it outlived the keep-signed-in window: found while listing), DEVICE_REMOVED (its browser was removed) or PASSWORD_CHANGED (the password changed or was reset after the session started; PRD CU-09.12). NULL while the session is not revoked; set together with revoked_at, immutable once set.';

-- Index justification (DATA_MODEL_GUARDRAILS rule 11):
--   uq_account_devices__account_hash (account_id, device_hash): THE lookup of registerSession (upsert by the hashed cookie) and the rule that one browser is one row per account.
--   uq_account_devices__account_device (account_id, account_device_id): the composite foreign key target of application_sessions and account_audit_events; its account_id prefix also serves every
--     read of ONE account's devices (an account has a handful), so the device list needs no further index.
--   uq_application_sessions__keycloak_session (keycloak_session_id): THE lookup of every authenticated web request (sid -> row), the one-statement touch, and the rule that a sid is one row (two concurrent
--     first requests insert ONE row).
--   uq_application_sessions__account_session (account_id, application_session_id): the composite foreign key target of account_audit_events; also the key of revoke-by-id (a session of another account is not found).
--   idx_application_sessions__account_live (account_id) WHERE revoked_at IS NULL: the session list, revoke-all, the expiry close and the reconciliation read ONLY the live sessions of one account (a handful,
--     at most ~200); the list sorts them in memory. Deliberately NOT keyed on last_seen_at: last_seen_at is written on the request path once a minute per session, and an indexed column would make
--     every touch a non-HOT update (new index entries, bloat). With no index on last_seen_at and fillfactor 80 the touch is a HOT update. Partial: revoked rows (the large majority over time) are never read here.
--   idx_application_sessions__device (account_id, account_device_id) WHERE account_device_id IS NOT NULL: "the sessions of a device" for removing a browser, the trusted flag of the session list and the derived
--     last-seen of the device list; also the foreign key to account_devices. Neither column is written after the one-time device attach, so it does not defeat HOT updates.
--   idx_account_audit_events__account_security_state (account_id, occurred_at DESC) WHERE action IN (the nine observed actions): "the latest audited state of a second factor, of the password and of the reset
--     request of ONE account" (SecurityService reads it on every security overview and every login registration). Without it these rare actions would be found by scanning the account's whole audit history
--     (one SESSION_CREATED row per login). Partial: the common rows (sessions, devices, contacts) are not in it.
--   No index on revoked_at / revocation_reason (no query filters history by it; the re-propagation lookup goes by keycloak_session_id) and none on created_at.
CREATE INDEX idx_application_sessions__account_live ON identity.application_sessions (account_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_application_sessions__device ON identity.application_sessions (account_id, account_device_id) WHERE account_device_id IS NOT NULL;

-- =====================================================================================================================
-- 4. audit extension: security actions and the session/device they concern
-- =====================================================================================================================
ALTER TABLE identity.account_audit_events DROP CONSTRAINT ck_account_audit_events__action;
ALTER TABLE identity.account_audit_events ADD CONSTRAINT ck_account_audit_events__action CHECK (
  action IN ('ACCOUNT_CREATED', 'EXTERNAL_IDENTITY_LINKED', 'ROLE_GRANTED', 'ROLE_ACTIVATED', 'ROLE_DEACTIVATED', 'PRIMARY_ROLE_CHANGED', 'PROFILE_UPDATED',
             'EMAIL_ADDED', 'EMAIL_CHANGE_REQUESTED', 'EMAIL_VERIFICATION_REQUESTED', 'EMAIL_VERIFICATION_FAILED', 'EMAIL_VERIFICATION_LOCKED', 'EMAIL_VERIFIED', 'EMAIL_PRIMARY_CHANGED',
             'PHONE_ADDED', 'PHONE_CHANGE_REQUESTED', 'PHONE_VERIFICATION_REQUESTED', 'PHONE_VERIFICATION_FAILED', 'PHONE_VERIFICATION_LOCKED', 'PHONE_VERIFIED', 'PHONE_PRIMARY_CHANGED',
             'SESSION_CREATED', 'SESSION_ENDED', 'SESSION_REVOKED', 'SESSIONS_REVOKED_ALL', 'DEVICE_TRUSTED', 'DEVICE_UNTRUSTED', 'DEVICE_REMOVED',
             'MFA_ENROLLMENT_REQUESTED', 'MFA_ENABLED', 'MFA_DISABLED', 'RECOVERY_CODES_REQUESTED', 'RECOVERY_CODES_ENABLED', 'RECOVERY_CODES_DISABLED',
             'PASSWORD_RESET_REQUESTED', 'PASSWORD_CHANGED', 'PASSWORD_RESET_COMPLETED')
);
ALTER TABLE identity.account_audit_events ADD COLUMN application_session_id uuid;
ALTER TABLE identity.account_audit_events ADD COLUMN account_device_id uuid;
-- SESSION\_% matches SESSION_CREATED, SESSION_ENDED and SESSION_REVOKED but NOT SESSIONS_REVOKED_ALL (the underscore is literal); DEVICE\_% matches the three DEVICE_ actions
ALTER TABLE identity.account_audit_events
  ADD CONSTRAINT fk_account_audit_events__account_session FOREIGN KEY (account_id, application_session_id) REFERENCES identity.application_sessions (account_id, application_session_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_account_audit_events__account_device FOREIGN KEY (account_id, account_device_id) REFERENCES identity.account_devices (account_id, account_device_id) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_account_audit_events__session CHECK ((action LIKE 'SESSION\_%') = (application_session_id IS NOT NULL)),
  ADD CONSTRAINT ck_account_audit_events__device CHECK ((action LIKE 'DEVICE\_%') = (account_device_id IS NOT NULL));
COMMENT ON COLUMN identity.account_audit_events.application_session_id IS 'The application session a SESSION_* action concerns (NULL for every other action, SESSIONS_REVOKED_ALL included). The composite foreign key (account_id, application_session_id) guarantees the session belongs to the audited account. Never the Keycloak session id. The coarse device of an event is read through the session.';
COMMENT ON COLUMN identity.account_audit_events.account_device_id IS 'The device a DEVICE_* action concerns (NULL for every other action). The composite foreign key (account_id, account_device_id) guarantees the device belongs to the audited account.';
CREATE INDEX idx_account_audit_events__account_security_state ON identity.account_audit_events (account_id, occurred_at DESC)
  WHERE action IN ('MFA_ENABLED', 'MFA_DISABLED', 'RECOVERY_CODES_ENABLED', 'RECOVERY_CODES_DISABLED', 'MFA_ENROLLMENT_REQUESTED', 'RECOVERY_CODES_REQUESTED',
                   'PASSWORD_CHANGED', 'PASSWORD_RESET_COMPLETED', 'PASSWORD_RESET_REQUESTED');
-- the foreign keys above have no index of their own: the referenced rows are never deleted or re-keyed, and no query filters audit rows by these columns (the timeline reads idx_account_audit_events__account and joins
-- the session by its primary key)

-- =====================================================================================================================
-- 5. guards (same conventions as 0009 to 0011: DETAIL 'identity_rule:<KEY>'; lock order account row, device row, session row)
-- =====================================================================================================================
CREATE FUNCTION identity.guard_accounts_sessions_not_before() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sessions_not_before IS NOT NULL AND (NEW.sessions_not_before IS NULL OR NEW.sessions_not_before < OLD.sessions_not_before) THEN
    RAISE EXCEPTION 'the sessions watermark never moves back' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:SESSIONS_WATERMARK';
  END IF;
  IF NEW.sessions_not_before > clock_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION 'the sessions watermark cannot be in the future' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:SESSIONS_WATERMARK';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_accounts__sessions_not_before BEFORE UPDATE OF sessions_not_before ON identity.accounts
  FOR EACH ROW WHEN (OLD.sessions_not_before IS DISTINCT FROM NEW.sessions_not_before) EXECUTE FUNCTION identity.guard_accounts_sessions_not_before();

CREATE FUNCTION identity.guard_account_devices() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'devices cannot be deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.account_device_id, NEW.account_id, NEW.device_hash, NEW.browser_family, NEW.os_family, NEW.device_class, NEW.first_seen_at)
       IS DISTINCT FROM (OLD.account_device_id, OLD.account_id, OLD.device_hash, OLD.browser_family, OLD.os_family, OLD.device_class, OLD.first_seen_at) THEN
      RAISE EXCEPTION 'a device is immutable except for its seen, trust and removal fields' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:DEVICE_IMMUTABLE';
    END IF;
    IF NEW.last_seen_at < OLD.last_seen_at THEN
      RAISE EXCEPTION 'last_seen_at never moves back' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:DEVICE_LAST_SEEN_MONOTONIC';
    END IF;
    IF OLD.removed_at IS NOT NULL AND (NEW.removed_at, NEW.trusted_at, NEW.trusted_until) IS DISTINCT FROM (OLD.removed_at, OLD.trusted_at, OLD.trusted_until) THEN
      RAISE EXCEPTION 'a removed device is terminal: it cannot be trusted or restored' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:DEVICE_REMOVED_TERMINAL';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT: a closed account gets no device; a device is never born removed
  SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id FOR SHARE;
  IF a_status = 'CLOSED' THEN
    RAISE EXCEPTION 'a closed account cannot receive a device' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_CLOSED';
  END IF;
  IF NEW.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a device is never created removed' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:DEVICE_REMOVED_TERMINAL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_account_devices__guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_devices FOR EACH ROW EXECUTE FUNCTION identity.guard_account_devices();

CREATE FUNCTION identity.guard_application_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a_status  text;
  d_removed timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sessions cannot be deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.application_session_id, NEW.account_id, NEW.keycloak_session_id, NEW.created_at) IS DISTINCT FROM (OLD.application_session_id, OLD.account_id, OLD.keycloak_session_id, OLD.created_at) THEN
      RAISE EXCEPTION 'a session is immutable except for its seen, device and revocation fields' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:SESSION_IMMUTABLE';
    END IF;
    -- a revoked session never changes again (revocation and its reason are terminal; nothing else moves after it)
    IF OLD.revoked_at IS NOT NULL THEN
      IF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'a revoked session never changes again' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:SESSION_REVOKED_TERMINAL';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.account_device_id IS NOT NULL AND NEW.account_device_id IS DISTINCT FROM OLD.account_device_id THEN
      RAISE EXCEPTION 'the device of a session is set once' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:SESSION_DEVICE_IMMUTABLE';
    END IF;
    IF NEW.last_seen_at < OLD.last_seen_at THEN
      RAISE EXCEPTION 'last_seen_at never moves back' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:SESSION_LAST_SEEN_MONOTONIC';
    END IF;
    IF OLD.account_device_id IS NULL AND NEW.account_device_id IS NOT NULL THEN
      -- the device row is share-locked: a concurrent removal of the browser (which needs the row lock) serializes with this attach
      SELECT removed_at INTO d_removed FROM identity.account_devices WHERE account_id = NEW.account_id AND account_device_id = NEW.account_device_id FOR SHARE;
      IF d_removed IS NOT NULL THEN
        RAISE EXCEPTION 'a removed device cannot receive a session' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:DEVICE_REMOVED_TERMINAL';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT: a closed account gets no new session; a session is never attached to a removed device
  SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id FOR SHARE;
  IF a_status = 'CLOSED' THEN
    RAISE EXCEPTION 'a closed account cannot receive a session' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_CLOSED';
  END IF;
  IF NEW.account_device_id IS NOT NULL THEN
    SELECT removed_at INTO d_removed FROM identity.account_devices WHERE account_id = NEW.account_id AND account_device_id = NEW.account_device_id FOR SHARE;
    IF d_removed IS NOT NULL THEN
      RAISE EXCEPTION 'a removed device cannot receive a session' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:DEVICE_REMOVED_TERMINAL';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_application_sessions__guard BEFORE INSERT OR UPDATE OR DELETE ON identity.application_sessions FOR EACH ROW EXECUTE FUNCTION identity.guard_application_sessions();

-- =====================================================================================================================
-- 6. seed: the session, MFA and recovery configuration parameters (CFG-001), through the real change workflow
--    Three values are PRD defaults (CU-09.13 trusted browser 30 days, SV-01.12 keep signed in 30 days, CU-03.11 reset link 60 minutes). THREE ARE ENGINEERING ASSUMPTIONS, NOT IN THE PRD, flagged for the security
--    owner (TECH_DEBT): the step-up freshness (15 minutes), the length of the security timeline (90 days; CU-09.20 says "the configured period") and the password-reset request limit (5 per hour).
--    session.keep_signed_in_days MUST equal the remember-me lifetimes of the Keycloak realm (a test checks this). Security parameters: CRITICAL (never cached, never last-known-good), SECOND_APPROVER.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_approver    constant text := 'system:migration-review';
  v_correlation constant text := 'seed-0012';
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
      (1, 'session.trusted_browser_days',     'INTEGER', 'days',     'Days a browser the person marked as trusted stays trusted (shown on the security page; it does not change when the sign-in service asks for a code)', '{"min": 1, "max": 365}'::jsonb,  'security', ARRAY['PLATFORM'], '30'::jsonb, 'PRD CU-09.13 default'),
      (2, 'session.keep_signed_in_days',      'INTEGER', 'days',     'Days an identity-provider session lives when the person chose to stay signed in; MUST equal the remember-me lifetimes of the realm',            '{"min": 1, "max": 90}'::jsonb,   'security', ARRAY['PLATFORM'], '30'::jsonb, 'PRD SV-01.12 default'),
      (3, 'reset_link.validity_minutes',      'INTEGER', 'minutes',  'Minutes a single-use password reset link stays valid',                                                                                         '{"min": 5, "max": 1440}'::jsonb, 'security', ARRAY['PLATFORM'], '60'::jsonb, 'PRD CU-03.11 default'),
      (4, 'security.step_up_valid_minutes',   'INTEGER', 'minutes',  'Minutes an authentication counts as recent for a sensitive action before the person must confirm the sign-in again',                          '{"min": 1, "max": 60}'::jsonb,   'security', ARRAY['PLATFORM'], '15'::jsonb, 'ID-004 engineering assumption, not in the PRD; to be confirmed by the security owner'),
      (5, 'security.activity_log_days',       'INTEGER', 'days',     'Days of security activity (sign-ins, session and browser changes, second-factor and password changes) shown to the owner',                   '{"min": 30, "max": 730}'::jsonb, 'security', ARRAY['PLATFORM'], '90'::jsonb, 'ID-004 engineering assumption (PRD CU-09.20 says the configured period without a value); to be confirmed by the security owner'),
      (6, 'reset_link.max_requests_per_hour', 'INTEGER', 'requests', 'Maximum password reset requests per email address and per source address per hour (abuse limit; each request can send an email)',            '{"min": 1, "max": 20}'::jsonb,   'security', ARRAY['PLATFORM'], '5'::jsonb,  'ID-004 engineering assumption, not in the PRD; to be confirmed by the security owner')
    ) AS t (ord, key, data_type, unit, description, rules, owner, scopes, value, basis)
    ORDER BY ord
  LOOP
    v_reason := 'Initial value (migration 0012): ' || v_seed.basis;
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
    VALUES (v_request, v_approver, 'APPROVE', 'Initial value reviewed with the migration (ID-004)');
    UPDATE configuration.change_requests SET state = 'APPROVED', updated_at = now() WHERE change_request_id = v_request AND state = 'PENDING_APPROVAL';
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, change_request_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_approver, 'CHANGE_APPROVED', v_parameter, v_request, 'Initial value reviewed with the migration (ID-004)', v_correlation);

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
-- 7. seed: the security screen and password reset copy (CFG-002), through the real content lifecycle (en-US only)
--    Typed variables: when (STRING) on sessions.last_seen and date (STRING) on devices.trusted_until, both formatted by the web server. No copy carries personal data.
--    devices.trust_note states plainly that the sign-in service still decides when it asks for a code.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0012';
  v_reason      constant text := 'Initial security copy (migration 0012)';
  v_seed        record;
  v_var         record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1, 'UI_LABEL', 'account.security.title', 'Title of the account security page', 'Security', '[]'::jsonb),
      (2, 'UI_LABEL', 'account.security.mfa.title', 'Heading of the second-factor section of the security page', 'Two-step verification', '[]'::jsonb),
      (3, 'UI_LABEL', 'account.security.mfa.status.enabled', 'Label of a second-factor method that is turned on', 'On', '[]'::jsonb),
      (4, 'UI_LABEL', 'account.security.mfa.status.disabled', 'Label of a second-factor method that is turned off', 'Off', '[]'::jsonb),
      (5, 'UI_LABEL', 'account.security.mfa.status.unknown', 'Label of a second-factor method whose state could not be checked', 'Could not be checked right now', '[]'::jsonb),
      (6, 'UI_LABEL', 'account.security.mfa.totp.label', 'Label of the authenticator app method', 'Authenticator app', '[]'::jsonb),
      (7, 'UI_LABEL', 'account.security.mfa.totp.enable', 'Button that starts setting up the authenticator app', 'Set up authenticator app', '[]'::jsonb),
      (8, 'UI_LABEL', 'account.security.mfa.recovery.label', 'Label of the recovery codes method', 'Recovery codes', '[]'::jsonb),
      (9, 'UI_LABEL', 'account.security.mfa.recovery.generate', 'Button that starts generating recovery codes', 'Generate recovery codes', '[]'::jsonb),
      (10, 'PLAIN_TEXT', 'account.security.mfa.recovery.warning', 'Warning shown with the recovery codes action', 'Recovery codes let you sign in if you lose your authenticator app. They are shown once, so store them somewhere safe.', '[]'::jsonb),
      (11, 'PLAIN_TEXT', 'account.security.mfa.stepup_note', 'Note explaining that sensitive actions ask for the sign-in to be confirmed again', 'For sensitive changes we may ask you to confirm your sign-in again, even when you are already signed in.', '[]'::jsonb),
      (12, 'UI_LABEL', 'account.security.sessions.title', 'Heading of the sessions section of the security page', 'Where you are signed in', '[]'::jsonb),
      (13, 'UI_LABEL', 'account.security.sessions.current', 'Marker of the session the person is using now', 'This session', '[]'::jsonb),
      (14, 'UI_LABEL', 'account.security.sessions.sign_out', 'Button that signs out one session', 'Sign out', '[]'::jsonb),
      (15, 'UI_LABEL', 'account.security.sessions.sign_out_everywhere', 'Button that signs out every other session', 'Sign out everywhere else', '[]'::jsonb),
      (16, 'PLAIN_TEXT', 'account.security.sessions.empty', 'Message when the person has no other active session', 'No other active sessions.', '[]'::jsonb),
      (17, 'PLAIN_TEXT', 'account.security.sessions.unreconciled', 'Message when the session list could not be compared with the sign-in service', 'We could not check these sessions with the sign-in service right now. Some of them may already have ended.', '[]'::jsonb),
      (18, 'PLAIN_TEXT', 'account.security.sessions.last_seen', 'When a session was last active', 'Last active {when}', '[{"name": "when", "type": "STRING", "description": "A readable date and time, formatted by the web server in the person time zone", "example": "Oct 16, 2026, 9:30 AM", "pii": "NONE"}]'::jsonb),
      (19, 'UI_LABEL', 'account.security.devices.title', 'Heading of the browsers section of the security page', 'Browsers', '[]'::jsonb),
      (20, 'UI_LABEL', 'account.security.devices.trust', 'Button that marks the current browser as trusted', 'Trust this browser', '[]'::jsonb),
      (21, 'UI_LABEL', 'account.security.devices.untrust', 'Button that stops trusting the current browser', 'Stop trusting this browser', '[]'::jsonb),
      (22, 'UI_LABEL', 'account.security.devices.remove', 'Button that removes a browser and signs out its sessions', 'Remove', '[]'::jsonb),
      (23, 'PLAIN_TEXT', 'account.security.devices.trust_note', 'Honest note about what trusting a browser does', 'Trusting a browser is recorded on your account and shown here. The sign-in service still decides when it asks for a verification code, so trusting a browser does not by itself skip that step, and it never replaces the extra confirmation required for sensitive changes.', '[]'::jsonb),
      (24, 'PLAIN_TEXT', 'account.security.devices.none', 'Message when no browser is known yet', 'No browsers yet.', '[]'::jsonb),
      (25, 'PLAIN_TEXT', 'account.security.devices.trusted_until', 'Until when a browser stays trusted', 'Trusted until {date}', '[{"name": "date", "type": "STRING", "description": "A readable date, formatted by the web server in the person time zone", "example": "Nov 15, 2026", "pii": "NONE"}]'::jsonb),
      (26, 'UI_LABEL', 'account.security.activity.title', 'Heading of the security activity section of the security page', 'Recent security activity', '[]'::jsonb),
      (27, 'PLAIN_TEXT', 'account.security.activity.empty', 'Message when there is no recent security activity', 'No recent security activity.', '[]'::jsonb),
      (28, 'UI_LABEL', 'account.security.activity.session_created', 'Security activity label: signed in', 'Signed in', '[]'::jsonb),
      (29, 'UI_LABEL', 'account.security.activity.session_ended', 'Security activity label: session ended', 'Session ended', '[]'::jsonb),
      (30, 'UI_LABEL', 'account.security.activity.session_revoked', 'Security activity label: session signed out', 'Session signed out', '[]'::jsonb),
      (31, 'UI_LABEL', 'account.security.activity.sessions_revoked_all', 'Security activity label: signed out of all sessions', 'Signed out of all sessions', '[]'::jsonb),
      (32, 'UI_LABEL', 'account.security.activity.device_trusted', 'Security activity label: browser trusted', 'Browser trusted', '[]'::jsonb),
      (33, 'UI_LABEL', 'account.security.activity.device_untrusted', 'Security activity label: browser no longer trusted', 'Browser no longer trusted', '[]'::jsonb),
      (34, 'UI_LABEL', 'account.security.activity.device_removed', 'Security activity label: browser removed', 'Browser removed', '[]'::jsonb),
      (35, 'UI_LABEL', 'account.security.activity.mfa_enrollment_requested', 'Security activity label: authenticator app setup started', 'Authenticator app setup started', '[]'::jsonb),
      (36, 'UI_LABEL', 'account.security.activity.mfa_enabled', 'Security activity label: authenticator app turned on', 'Authenticator app turned on', '[]'::jsonb),
      (37, 'UI_LABEL', 'account.security.activity.mfa_disabled', 'Security activity label: authenticator app turned off', 'Authenticator app turned off', '[]'::jsonb),
      (38, 'UI_LABEL', 'account.security.activity.recovery_codes_requested', 'Security activity label: recovery codes requested', 'Recovery codes requested', '[]'::jsonb),
      (39, 'UI_LABEL', 'account.security.activity.recovery_codes_enabled', 'Security activity label: recovery codes generated', 'Recovery codes generated', '[]'::jsonb),
      (40, 'UI_LABEL', 'account.security.activity.recovery_codes_disabled', 'Security activity label: recovery codes removed', 'Recovery codes removed', '[]'::jsonb),
      (41, 'UI_LABEL', 'account.security.activity.password_reset_requested', 'Security activity label: password reset requested', 'Password reset requested', '[]'::jsonb),
      (42, 'UI_LABEL', 'account.security.activity.password_changed', 'Security activity label: password changed', 'Password changed', '[]'::jsonb),
      (43, 'UI_LABEL', 'account.security.activity.password_reset_completed', 'Security activity label: password reset completed', 'Password reset completed', '[]'::jsonb),
      (44, 'UI_LABEL', 'account.security.activity.email_verified', 'Security activity label: email address verified', 'Email address verified', '[]'::jsonb),
      (45, 'UI_LABEL', 'account.security.activity.email_primary_changed', 'Security activity label: primary email address changed', 'Primary email address changed', '[]'::jsonb),
      (46, 'UI_LABEL', 'account.security.activity.phone_verified', 'Security activity label: phone number verified', 'Phone number verified', '[]'::jsonb),
      (47, 'UI_LABEL', 'account.security.activity.phone_primary_changed', 'Security activity label: primary phone number changed', 'Primary phone number changed', '[]'::jsonb),
      (48, 'UI_LABEL', 'account.security.browser.chrome', 'Coarse browser label: Chrome', 'Chrome', '[]'::jsonb),
      (49, 'UI_LABEL', 'account.security.browser.firefox', 'Coarse browser label: Firefox', 'Firefox', '[]'::jsonb),
      (50, 'UI_LABEL', 'account.security.browser.safari', 'Coarse browser label: Safari', 'Safari', '[]'::jsonb),
      (51, 'UI_LABEL', 'account.security.browser.edge', 'Coarse browser label: Edge', 'Edge', '[]'::jsonb),
      (52, 'UI_LABEL', 'account.security.browser.opera', 'Coarse browser label: Opera', 'Opera', '[]'::jsonb),
      (53, 'UI_LABEL', 'account.security.browser.other', 'Coarse browser label: Other browser', 'Other browser', '[]'::jsonb),
      (54, 'UI_LABEL', 'account.security.os.windows', 'Coarse operating system label: Windows', 'Windows', '[]'::jsonb),
      (55, 'UI_LABEL', 'account.security.os.macos', 'Coarse operating system label: macOS', 'macOS', '[]'::jsonb),
      (56, 'UI_LABEL', 'account.security.os.linux', 'Coarse operating system label: Linux', 'Linux', '[]'::jsonb),
      (57, 'UI_LABEL', 'account.security.os.ios', 'Coarse operating system label: iOS', 'iOS', '[]'::jsonb),
      (58, 'UI_LABEL', 'account.security.os.android', 'Coarse operating system label: Android', 'Android', '[]'::jsonb),
      (59, 'UI_LABEL', 'account.security.os.other', 'Coarse operating system label: Other system', 'Other system', '[]'::jsonb),
      (60, 'UI_LABEL', 'account.security.device_class.desktop', 'Coarse device class label: Computer', 'Computer', '[]'::jsonb),
      (61, 'UI_LABEL', 'account.security.device_class.mobile', 'Coarse device class label: Phone', 'Phone', '[]'::jsonb),
      (62, 'UI_LABEL', 'account.security.device_class.tablet', 'Coarse device class label: Tablet', 'Tablet', '[]'::jsonb),
      (63, 'UI_LABEL', 'account.security.device_class.other', 'Coarse device class label: Other device', 'Other device', '[]'::jsonb),
      (64, 'PLAIN_TEXT', 'account.security.notice.session_revoked', 'Security page notice: session revoked', 'The session was signed out.', '[]'::jsonb),
      (65, 'PLAIN_TEXT', 'account.security.notice.signed_out_elsewhere', 'Security page notice: signed out elsewhere', 'You were signed out because this session was ended from another place.', '[]'::jsonb),
      (66, 'PLAIN_TEXT', 'account.security.notice.device_trusted', 'Security page notice: device trusted', 'This browser is now trusted.', '[]'::jsonb),
      (67, 'PLAIN_TEXT', 'account.security.notice.device_untrusted', 'Security page notice: device untrusted', 'This browser is no longer trusted.', '[]'::jsonb),
      (68, 'PLAIN_TEXT', 'account.security.notice.device_removed', 'Security page notice: device removed', 'The browser was removed and its sessions were signed out.', '[]'::jsonb),
      (69, 'PLAIN_TEXT', 'account.security.notice.mfa_return_success', 'Security page notice: mfa return success', 'Your change to two-step verification was saved.', '[]'::jsonb),
      (70, 'PLAIN_TEXT', 'account.security.notice.mfa_return_cancelled', 'Security page notice: mfa return cancelled', 'Two-step verification was not changed.', '[]'::jsonb),
      (71, 'PLAIN_TEXT', 'account.security.error.session_revoked', 'Security error message: session revoked', 'This session was signed out. Sign in again to continue.', '[]'::jsonb),
      (72, 'PLAIN_TEXT', 'account.security.error.step_up_required', 'Security error message: step up required', 'Confirm your sign-in again to continue.', '[]'::jsonb),
      (73, 'PLAIN_TEXT', 'account.security.error.mfa_enrollment_required', 'Security error message: mfa enrollment required', 'Set up an authenticator app to continue.', '[]'::jsonb),
      (74, 'PLAIN_TEXT', 'account.security.error.session_not_found', 'Security error message: session not found', 'That session was not found.', '[]'::jsonb),
      (75, 'PLAIN_TEXT', 'account.security.error.device_not_found', 'Security error message: device not found', 'That browser was not found.', '[]'::jsonb),
      (76, 'PLAIN_TEXT', 'account.security.error.device_required', 'Security error message: device required', 'This action needs a registered browser. Sign in again and retry.', '[]'::jsonb),
      (77, 'PLAIN_TEXT', 'account.security.error.security_unavailable', 'Security error message: security unavailable', 'Account security is temporarily unavailable. Try again in a moment.', '[]'::jsonb),
      (78, 'PLAIN_TEXT', 'account.security.error.password_reset_rate_limited', 'Security error message: password reset rate limited', 'Too many password reset requests. Try again later.', '[]'::jsonb),
      (79, 'UI_LABEL', 'account.password_reset.title', 'Title of the password reset page', 'Reset your password', '[]'::jsonb),
      (80, 'PLAIN_TEXT', 'account.password_reset.intro', 'Introduction on the password reset page', 'Enter the email address of your account. If it is a verified address of an account, we will send you a link to choose a new password.', '[]'::jsonb),
      (81, 'UI_LABEL', 'account.password_reset.email_label', 'Label of the email input on the password reset page', 'Email address', '[]'::jsonb),
      (82, 'UI_LABEL', 'account.password_reset.submit', 'Button that requests the password reset link', 'Send reset link', '[]'::jsonb),
      (83, 'PLAIN_TEXT', 'account.password_reset.accepted', 'Answer to every password reset request (it never says whether an account exists)', 'If that email address belongs to an account, a reset link is on its way. The link can be used once and expires soon.', '[]'::jsonb),
      (84, 'UI_LABEL', 'account.password_reset.back_to_sign_in', 'Link from the password reset page back to sign in', 'Back to sign in', '[]'::jsonb),
      (85, 'PLAIN_TEXT', 'account.password_reset.error.invalid_email', 'Validation message: the email address on the password reset page is not valid', 'Enter a valid email address.', '[]'::jsonb),
      (86, 'PLAIN_TEXT', 'account.password_reset.error.rate_limited', 'Message: too many password reset requests', 'Too many requests. Try again later.', '[]'::jsonb)
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
