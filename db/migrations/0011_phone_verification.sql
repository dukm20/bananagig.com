-- checkpoint: ID-003
-- purpose: add the BananaGig-owned phone contact and its SMS verification to the identity schema: phone_contacts (E.164 number, country, lifecycle status, primary flag, source, line-type snapshot), phone_verification_challenges (one row per send: HMAC code hash, expiry, single use, attempt counter, delivery outcome), the audit extension (phone actions and a contact reference), the ten verification.phone.* configuration parameters (CFG-001; two of them market/country scoped policy) and the SMS and screen copy (CFG-002)
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. Contacts, challenges and audit rows are never deleted (status changes and new rows instead); the seeded parameters and copy are changed through their own workflows, never by editing this file
-- backfill: none; the tables are new and no account has a phone contact (contacts appear when a person adds a number)
-- risk: low to medium. Two new tables and guards, one additive change to identity.account_audit_events (one nullable column, one wider CHECK). The seeds are deterministic reference data: 10 configuration parameters with one approved PLATFORM value each and 33 managed copy entries. Nothing in this schema stores a plaintext verification code or a credential: only HMAC-SHA-256 hashes (keyed with a server secret that is NOT in the database). The phone number itself is personal data (E.164) and is stored only here
-- destructive: the CHECK constraint ck_account_audit_events__action is dropped and re-created WIDER (seven added phone actions) in the same transaction; this is a pure widening, no row is changed or removed and the append-only trigger of the table is not involved (expand step of expand/migrate/contract, nothing is contracted)
-- events: the seeds emit no outbox events (they run before any consumer exists, like 0006 to 0010); every contact and verification change after this migration goes through the service, which writes the events in the same transaction
-- audit: the configuration seed writes the configuration audit trail (PARAMETER_CREATED ... CHANGE_ACTIVATED) and the content seed writes the content audit trail (ENTRY_CREATED ... VERSION_ACTIVATED), exactly as the real workflows do

-- =====================================================================================================================
-- 1. phone contacts
-- =====================================================================================================================
CREATE TABLE identity.phone_contacts (
  phone_contact_id     uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id           uuid        NOT NULL,
  phone_e164           text        NOT NULL,
  country_code         char(2)     NOT NULL,
  status               text        NOT NULL,
  is_primary           boolean     NOT NULL DEFAULT false,
  source               text        NOT NULL,
  line_type            text,
  line_type_checked_at timestamptz,
  verified_at          timestamptz,
  disabled_at          timestamptz,
  disabled_reason      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_phone_contacts PRIMARY KEY (phone_contact_id),
  CONSTRAINT uq_phone_contacts__account_contact UNIQUE (account_id, phone_contact_id),
  CONSTRAINT fk_phone_contacts__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_phone_contacts__country_code FOREIGN KEY (country_code) REFERENCES geography.countries (iso_alpha2) ON DELETE RESTRICT,
  CONSTRAINT ck_phone_contacts__status CHECK (status IN ('PENDING', 'VERIFIED', 'REPLACEMENT_PENDING', 'DISABLED')),
  CONSTRAINT ck_phone_contacts__source CHECK (source IN ('USER_ENTERED')),
  CONSTRAINT ck_phone_contacts__phone_e164 CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT ck_phone_contacts__country_code CHECK (country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT ck_phone_contacts__line_type CHECK (line_type IS NULL OR line_type IN ('MOBILE', 'LANDLINE', 'VOIP', 'VIRTUAL', 'UNKNOWN', 'HIGH_RISK')),
  CONSTRAINT ck_phone_contacts__line_type_pair CHECK ((line_type IS NULL) = (line_type_checked_at IS NULL)),
  CONSTRAINT ck_phone_contacts__primary_is_verified CHECK (NOT is_primary OR status = 'VERIFIED'),
  CONSTRAINT ck_phone_contacts__verified_at CHECK (
    (status <> 'VERIFIED' OR verified_at IS NOT NULL) AND (status NOT IN ('PENDING', 'REPLACEMENT_PENDING') OR verified_at IS NULL)
  ),
  CONSTRAINT ck_phone_contacts__disabled CHECK (
    (status = 'DISABLED') = (disabled_at IS NOT NULL) AND (status = 'DISABLED') = (disabled_reason IS NOT NULL)
  ),
  CONSTRAINT ck_phone_contacts__disabled_reason CHECK (disabled_reason IS NULL OR disabled_reason IN ('REPLACED', 'SUPERSEDED'))
);
COMMENT ON TABLE identity.phone_contacts IS 'The phone numbers of an account, owned by BananaGig (NEVER stored in or copied to Keycloak). PERSONAL DATA: never logged, never in audit changes or events, returned to the owner only in a MASKED form and never to another marketplace user. status: PENDING (first number, unverified), VERIFIED, REPLACEMENT_PENDING (a new number that replaces the verified primary once it verifies; the old number stays VERIFIED and primary until then), DISABLED (replaced or superseded, kept for history). The canonical form is E.164 produced by ONE function (accounts canonicalizePhone over libphonenumber-js: country-aware input, no formatting characters, no extension); display formatting is derived later and no national-number copy is stored. Rows are never deleted.';
COMMENT ON COLUMN identity.phone_contacts.phone_e164 IS 'The canonical number: a plus sign, a non-zero first digit and 7 to 15 digits in all. The comparison, uniqueness and delivery form.';
COMMENT ON COLUMN identity.phone_contacts.country_code IS 'ISO 3166-1 alpha-2 country the number belongs to, as determined by the numbering library from the number itself (a shared calling code such as +1 is resolved to US or CA). A foreign key to geography.countries: the country must exist, and the service accepts only ACTIVE countries whose dialing_code equals the number''s calling code. Used to select the country-scoped policy.';
COMMENT ON COLUMN identity.phone_contacts.is_primary IS 'The account''s primary active phone: only a VERIFIED number can be primary, an account has at most one (partial unique index), and a number becomes VERIFIED only as the primary (guard), so is_primary and status = VERIFIED coincide.';
COMMENT ON COLUMN identity.phone_contacts.line_type IS 'SNAPSHOT of what the phone-intelligence adapter reported when the number was added (MOBILE, LANDLINE, VOIP, VIRTUAL, UNKNOWN, HIGH_RISK); NULL when no lookup was needed because the market blocks no line type. A snapshot of an external fact at a time, kept so a later policy change can be applied without calling the vendor again; immutable.';
COMMENT ON COLUMN identity.phone_contacts.source IS 'Provenance. Only USER_ENTERED exists: a number must be proven by an SMS code. The column exists so a trusted source can be added by widening the CHECK.';

-- Uniqueness policy (docs/engineering/PHONE_VERIFICATION.md "Uniqueness policy"):
--   verified duplication: NOT a unique index. How many accounts may verify one number is DATA (verification.phone.max_accounts_per_number, default 1, scoped by country and market),
--     so it cannot be a constraint of the schema. It is enforced by the service under a transaction advisory lock on the number AND by the guard trigger below, which takes the same
--     lock and refuses a verification beyond the value the service passes (transaction setting app.phone_max_accounts) or beyond the structural ceiling of 5 accounts per number.
--   pending duplication: ALLOWED across accounts (a pending claim proves nothing; it must neither block the real owner nor reveal that anyone else holds the number).
--   per account: at most one primary, at most one open candidate, one live row per number.
-- Index justification (DATA_MODEL_GUARDRAILS rule 11):
--   uq_phone_contacts__primary_per_account: the lookup of the account's primary number (account_id prefix, read by /account/me) and the rule itself.
--   uq_phone_contacts__open_per_account: the lookup of the account's pending candidate (read by /account/me and every verification call) and the rule itself.
--   uq_phone_contacts__live_number_per_account: the rule only (an account cannot hold the same live number twice).
--   idx_phone_contacts__verified_number (phone_e164) WHERE status = 'VERIFIED': the count of accounts that hold a number verified (policy and guard), the one lookup by number.
--   uq_phone_contacts__account_contact (account_id, phone_contact_id): the target of the composite foreign key of account_audit_events, so an audit row can only name a contact of the
--     audited account; its account_id prefix also serves every read of the contacts of ONE account (history of DISABLED rows included) and the account_id foreign key.
--   No index on country_code: countries are never deleted and no query filters contacts by country.
CREATE UNIQUE INDEX uq_phone_contacts__primary_per_account ON identity.phone_contacts (account_id) WHERE is_primary;
CREATE UNIQUE INDEX uq_phone_contacts__open_per_account ON identity.phone_contacts (account_id) WHERE status IN ('PENDING', 'REPLACEMENT_PENDING');
CREATE UNIQUE INDEX uq_phone_contacts__live_number_per_account ON identity.phone_contacts (account_id, phone_e164) WHERE status <> 'DISABLED';
CREATE INDEX idx_phone_contacts__verified_number ON identity.phone_contacts (phone_e164) WHERE status = 'VERIFIED';

-- =====================================================================================================================
-- 2. verification challenges (one row per send; SMS has no magic link)
-- =====================================================================================================================
CREATE TABLE identity.phone_verification_challenges (
  challenge_id        uuid        NOT NULL DEFAULT gen_random_uuid(),
  phone_contact_id    uuid        NOT NULL,
  purpose             text        NOT NULL,
  code_hash           text        NOT NULL,
  expires_at          timestamptz NOT NULL,
  used_at             timestamptz,
  attempt_count       integer     NOT NULL DEFAULT 0,
  invalidated_at      timestamptz,
  invalidation_reason text,
  delivery_status     text        NOT NULL DEFAULT 'PENDING',
  last_sent_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  correlation_id      text        NOT NULL,
  CONSTRAINT pk_phone_verification_challenges PRIMARY KEY (challenge_id),
  CONSTRAINT fk_phone_verification_challenges__phone_contact_id FOREIGN KEY (phone_contact_id) REFERENCES identity.phone_contacts (phone_contact_id) ON DELETE RESTRICT,
  CONSTRAINT ck_phone_verification_challenges__purpose CHECK (purpose IN ('INITIAL_PHONE', 'CHANGE_PHONE')),
  CONSTRAINT ck_phone_verification_challenges__code_hash CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_phone_verification_challenges__expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_phone_verification_challenges__attempts CHECK (attempt_count >= 0),
  CONSTRAINT ck_phone_verification_challenges__invalidated CHECK (
    (invalidated_at IS NULL) = (invalidation_reason IS NULL) AND (invalidation_reason IS NULL OR invalidation_reason IN ('SUPERSEDED', 'LOCKED', 'CONTACT_DISABLED', 'DELIVERY_FAILED'))
  ),
  CONSTRAINT ck_phone_verification_challenges__closed_once CHECK (used_at IS NULL OR invalidated_at IS NULL),
  CONSTRAINT ck_phone_verification_challenges__delivery CHECK (delivery_status IN ('PENDING', 'SENT', 'FAILED') AND ((delivery_status = 'SENT') = (last_sent_at IS NOT NULL))),
  CONSTRAINT ck_phone_verification_challenges__correlation CHECK (length(btrim(correlation_id)) > 0 AND length(correlation_id) <= 200)
);
COMMENT ON TABLE identity.phone_verification_challenges IS 'One verification intent per SMS SEND, the hardened ID-002 model without the magic link: a resend issues a NEW challenge (new code) and supersedes the open one, so the number of sends in a window is the number of rows (no counter to drift) and the history of sends is kept. The code is shown ONCE (in the SMS); only its HMAC-SHA-256 (keyed with a server secret held outside the database, bound to the challenge id, domain-separated from the email codes) is stored. SECURITY: single use (used_at, set under the row lock), expires with the challenge, wrong attempts are counted atomically (attempt_count) and the challenge locks when the configured maximum is reached. Rows are never deleted.';
COMMENT ON COLUMN identity.phone_verification_challenges.purpose IS 'INITIAL_PHONE or CHANGE_PHONE, frozen at issuance from the contact''s status (PENDING = initial, REPLACEMENT_PENDING = change). A deliberate snapshot: the contact status changes when the number verifies, the purpose of this send must not.';
COMMENT ON COLUMN identity.phone_verification_challenges.code_hash IS 'HMAC-SHA-256 hex of the numeric code. The plaintext code is never stored or logged.';
COMMENT ON COLUMN identity.phone_verification_challenges.last_sent_at IS 'When the SMS sender accepted the message (NULL while the send is pending or after a failed delivery). The resend cooldown counts from the CREATION of the newest challenge that is neither FAILED nor used, so a delivery in flight holds a second send back and a failed delivery does not make the person wait; the per-hour and per-day caps count every challenge, so failing deliveries are bounded too.';
COMMENT ON COLUMN identity.phone_verification_challenges.invalidation_reason IS 'SUPERSEDED (a newer challenge was issued), LOCKED (maximum wrong attempts reached), CONTACT_DISABLED (the number was replaced or superseded) or DELIVERY_FAILED (the SMS could not be sent, so the code was never delivered). An invalidated challenge can never verify.';

-- Index justification:
--   uq_phone_verification_challenges__open_per_contact: the lookup of the contact's open (usable) challenge for a code confirmation and the rule that a contact has at most one open challenge.
--   idx_phone_verification_challenges__contact_created: the send history of ONE contact, newest first: the resend cooldown (newest non-FAILED, unused row), the per-hour and per-day caps
--     (rows since a moment) and the verification timeline. It also covers the foreign key. Counting per account joins the account's few contacts to this index.
--   No index on expires_at: expiry is evaluated on the row loaded by key; there is no sweeper.
CREATE UNIQUE INDEX uq_phone_verification_challenges__open_per_contact ON identity.phone_verification_challenges (phone_contact_id) WHERE used_at IS NULL AND invalidated_at IS NULL;
CREATE INDEX idx_phone_verification_challenges__contact_created ON identity.phone_verification_challenges (phone_contact_id, created_at DESC);

-- =====================================================================================================================
-- 3. audit extension: phone actions and the contact they concern
-- =====================================================================================================================
ALTER TABLE identity.account_audit_events DROP CONSTRAINT ck_account_audit_events__action;
ALTER TABLE identity.account_audit_events ADD CONSTRAINT ck_account_audit_events__action CHECK (
  action IN ('ACCOUNT_CREATED', 'EXTERNAL_IDENTITY_LINKED', 'ROLE_GRANTED', 'ROLE_ACTIVATED', 'ROLE_DEACTIVATED', 'PRIMARY_ROLE_CHANGED', 'PROFILE_UPDATED',
             'EMAIL_ADDED', 'EMAIL_CHANGE_REQUESTED', 'EMAIL_VERIFICATION_REQUESTED', 'EMAIL_VERIFICATION_FAILED', 'EMAIL_VERIFICATION_LOCKED', 'EMAIL_VERIFIED', 'EMAIL_PRIMARY_CHANGED',
             'PHONE_ADDED', 'PHONE_CHANGE_REQUESTED', 'PHONE_VERIFICATION_REQUESTED', 'PHONE_VERIFICATION_FAILED', 'PHONE_VERIFICATION_LOCKED', 'PHONE_VERIFIED', 'PHONE_PRIMARY_CHANGED')
);
ALTER TABLE identity.account_audit_events ADD COLUMN phone_contact_id uuid;
ALTER TABLE identity.account_audit_events
  ADD CONSTRAINT fk_account_audit_events__account_phone_contact FOREIGN KEY (account_id, phone_contact_id) REFERENCES identity.phone_contacts (account_id, phone_contact_id) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_account_audit_events__phone_contact CHECK ((action LIKE 'PHONE\_%') = (phone_contact_id IS NOT NULL));
COMMENT ON COLUMN identity.account_audit_events.phone_contact_id IS 'The phone contact a PHONE_* action concerns (NULL for every other action). The composite foreign key (account_id, phone_contact_id) guarantees the contact belongs to the audited account. The audit trail names the contact by id and, in changes, by a MASKED number; it never holds a full number, a code or a hash.';

-- =====================================================================================================================
-- 4. guards (same conventions as 0009 and 0010: DETAIL 'identity_rule:<KEY>', lock order account row, contact row, challenge row)
-- =====================================================================================================================
CREATE FUNCTION identity.guard_phone_contacts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a_status    text;
  has_primary boolean;
  setting     text;
  cap         integer;
  holders     integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'phone contacts cannot be deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.phone_contact_id, NEW.account_id, NEW.phone_e164, NEW.country_code, NEW.source, NEW.line_type, NEW.line_type_checked_at, NEW.created_at)
       IS DISTINCT FROM (OLD.phone_contact_id, OLD.account_id, OLD.phone_e164, OLD.country_code, OLD.source, OLD.line_type, OLD.line_type_checked_at, OLD.created_at) THEN
      RAISE EXCEPTION 'a phone contact is immutable except for its lifecycle fields' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:IMMUTABLE_IDENTITY';
    END IF;
    IF OLD.status = 'DISABLED' THEN
      RAISE EXCEPTION 'a disabled phone contact never changes again' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:IMMUTABLE_IDENTITY';
    END IF;
    IF OLD.verified_at IS NOT NULL THEN
      IF NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
        RAISE EXCEPTION 'verified_at is set once' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:IMMUTABLE_IDENTITY';
      END IF;
    END IF;
    IF NEW.status <> OLD.status THEN
      IF NOT (
           (OLD.status = 'PENDING'             AND NEW.status IN ('VERIFIED', 'DISABLED'))
        OR (OLD.status = 'REPLACEMENT_PENDING' AND NEW.status IN ('VERIFIED', 'DISABLED'))
        OR (OLD.status = 'VERIFIED'            AND NEW.status = 'DISABLED')) THEN
        RAISE EXCEPTION 'illegal phone contact transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_STATUS_TRANSITION';
      END IF;
    END IF;
    IF NEW.status = 'VERIFIED' THEN
      IF OLD.status <> 'VERIFIED' THEN
        -- a verified number is the primary one; a closed account verifies nothing
        IF NOT NEW.is_primary THEN
          RAISE EXCEPTION 'a number is verified as the primary number of its account' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_PRIMARY_CHANGE';
        END IF;
        SELECT status INTO a_status FROM identity.accounts WHERE account_id = OLD.account_id FOR SHARE;
        IF a_status = 'CLOSED' THEN
          RAISE EXCEPTION 'a closed account cannot verify a phone contact' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_CLOSED';
        END IF;
        -- how many accounts may hold one verified number: serialize the verifications of ONE number, then count the OTHER accounts that hold it. The ceiling is the value the
        -- service passes in the transaction setting app.phone_max_accounts (1 to 5, from configuration), or the structural 5 for any other writer.
        PERFORM pg_advisory_xact_lock(hashtextextended('phone:' || OLD.phone_e164, 0));
        setting := current_setting('app.phone_max_accounts', true);
        cap := CASE WHEN setting ~ '^[1-5]$' THEN setting::integer ELSE 5 END;
        SELECT count(DISTINCT k.account_id) INTO holders FROM identity.phone_contacts k JOIN identity.accounts a ON a.account_id = k.account_id
          WHERE k.phone_e164 = OLD.phone_e164 AND k.status = 'VERIFIED' AND k.account_id <> OLD.account_id AND a.status <> 'CLOSED'; -- a CLOSED account no longer holds its number (a recycled number)
        IF holders >= cap THEN
          RAISE EXCEPTION 'the number is already verified on the maximum number of accounts' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_NUMBER_CAP';
        END IF;
      END IF;
    END IF;
    IF NEW.is_primary IS DISTINCT FROM OLD.is_primary THEN
      IF NEW.is_primary THEN
        IF NOT (NEW.status = 'VERIFIED' AND OLD.status <> 'VERIFIED') THEN
          RAISE EXCEPTION 'a number becomes primary only when it is verified' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_PRIMARY_CHANGE';
        END IF;
      ELSE
        IF NEW.status <> 'DISABLED' THEN
          RAISE EXCEPTION 'the primary number stops being primary only when it is replaced' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_PRIMARY_CHANGE';
        END IF;
      END IF;
    END IF;
    IF NEW.status = 'DISABLED' THEN
      IF OLD.status = 'VERIFIED' THEN
        IF NEW.disabled_reason IS DISTINCT FROM 'REPLACED' THEN
          RAISE EXCEPTION 'a verified number is disabled only when it is replaced' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_STATUS_TRANSITION';
        END IF;
        -- the account row is locked before its siblings are read (a concurrent replacement or verification serializes with this)
        PERFORM 1 FROM identity.accounts WHERE account_id = OLD.account_id FOR UPDATE;
        IF NOT EXISTS (SELECT 1 FROM identity.phone_contacts WHERE account_id = OLD.account_id AND status = 'REPLACEMENT_PENDING') THEN
          RAISE EXCEPTION 'the verified primary number can only be replaced by a verified replacement' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_PRIMARY_NOT_REPLACEABLE';
        END IF;
      ELSIF OLD.status IN ('PENDING', 'REPLACEMENT_PENDING') THEN
        IF NEW.disabled_reason IS DISTINCT FROM 'SUPERSEDED' THEN
          RAISE EXCEPTION 'a pending number is disabled only when it is superseded' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_STATUS_TRANSITION';
        END IF;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT. The account row is locked first: concurrent first-number inserts and the primary read below serialize on it.
  SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id FOR UPDATE;
  IF a_status = 'CLOSED' THEN
    RAISE EXCEPTION 'a closed account cannot receive a phone contact' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_CLOSED';
  END IF;
  IF NEW.status NOT IN ('PENDING', 'REPLACEMENT_PENDING') THEN
    RAISE EXCEPTION 'a phone contact is created pending (a number is verified by a code, never born verified)' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_STATUS_TRANSITION';
  END IF;
  SELECT EXISTS (SELECT 1 FROM identity.phone_contacts WHERE account_id = NEW.account_id AND is_primary) INTO has_primary;
  IF NEW.status = 'PENDING' THEN
    IF has_primary THEN
      RAISE EXCEPTION 'an initial number cannot be added while a verified primary exists; request a change instead' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_INITIAL_WITH_PRIMARY';
    END IF;
  ELSIF NEW.status = 'REPLACEMENT_PENDING' THEN
    IF NOT has_primary THEN
      RAISE EXCEPTION 'a replacement number needs a verified primary to replace' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_REPLACEMENT_WITHOUT_PRIMARY';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_phone_contacts__guard BEFORE INSERT OR UPDATE OR DELETE ON identity.phone_contacts FOR EACH ROW EXECUTE FUNCTION identity.guard_phone_contacts();

-- Whole-account invariants, checked once at COMMIT (so the multi-step replacement may pass through intermediate states inside its transaction):
--   a pending INITIAL number and a primary never coexist; a REPLACEMENT_PENDING number needs a primary; an account that ever replaced a primary still has one;
--   a contact that is no longer open has no open challenge left.
CREATE FUNCTION identity.check_phone_account_invariants() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  has_primary     boolean;
  has_initial     boolean;
  has_replacement boolean;
  has_replaced    boolean;
BEGIN
  SELECT coalesce(bool_or(is_primary), false),
         coalesce(bool_or(status = 'PENDING'), false),
         coalesce(bool_or(status = 'REPLACEMENT_PENDING'), false),
         coalesce(bool_or(status = 'DISABLED' AND disabled_reason = 'REPLACED'), false)
    INTO has_primary, has_initial, has_replacement, has_replaced
    FROM identity.phone_contacts WHERE account_id = NEW.account_id;
  IF has_initial THEN
    IF has_primary THEN
      RAISE EXCEPTION 'an account cannot have a pending initial number and a verified primary' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_INVARIANT';
    END IF;
  END IF;
  IF has_replacement THEN
    IF NOT has_primary THEN
      RAISE EXCEPTION 'a replacement number needs a verified primary' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_INVARIANT';
    END IF;
  END IF;
  IF has_replaced THEN
    IF NOT has_primary THEN
      RAISE EXCEPTION 'an account that replaced its primary number must have a primary number' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_INVARIANT';
    END IF;
  END IF;
  IF NEW.status NOT IN ('PENDING', 'REPLACEMENT_PENDING') THEN
    IF EXISTS (SELECT 1 FROM identity.phone_verification_challenges WHERE phone_contact_id = NEW.phone_contact_id AND used_at IS NULL AND invalidated_at IS NULL) THEN
      RAISE EXCEPTION 'a contact that is no longer pending cannot keep an open verification challenge' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_INVARIANT';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_phone_contacts__invariants AFTER INSERT OR UPDATE ON identity.phone_contacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.check_phone_account_invariants();

CREATE FUNCTION identity.guard_phone_verification_challenges() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c_status text;
  a_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verification challenges cannot be deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.challenge_id, NEW.phone_contact_id, NEW.purpose, NEW.code_hash, NEW.expires_at, NEW.created_at, NEW.correlation_id)
       IS DISTINCT FROM (OLD.challenge_id, OLD.phone_contact_id, OLD.purpose, OLD.code_hash, OLD.expires_at, OLD.created_at, OLD.correlation_id) THEN
      RAISE EXCEPTION 'a verification challenge is immutable except for its attempt, use, invalidation and delivery fields' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:IMMUTABLE_IDENTITY';
    END IF;
    IF OLD.used_at IS NOT NULL OR OLD.invalidated_at IS NOT NULL THEN
      RAISE EXCEPTION 'a used or invalidated challenge never changes again' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_CHALLENGE_CLOSED';
    END IF;
    IF NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'the attempt counter only counts up, one attempt at a time' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_CHALLENGE_ATTEMPTS';
    END IF;
    IF OLD.delivery_status <> 'PENDING' THEN
      IF (NEW.delivery_status, NEW.last_sent_at) IS DISTINCT FROM (OLD.delivery_status, OLD.last_sent_at) THEN
        RAISE EXCEPTION 'the delivery outcome is recorded once' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_CHALLENGE_DELIVERY';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT: the contact row is locked, must be open, and the purpose must match its status; a closed account receives nothing
  SELECT a.status INTO a_status FROM identity.phone_contacts k JOIN identity.accounts a ON a.account_id = k.account_id WHERE k.phone_contact_id = NEW.phone_contact_id FOR SHARE OF a;
  IF a_status = 'CLOSED' THEN
    RAISE EXCEPTION 'a closed account cannot receive a verification challenge' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_CLOSED';
  END IF;
  SELECT status INTO c_status FROM identity.phone_contacts WHERE phone_contact_id = NEW.phone_contact_id FOR UPDATE;
  IF c_status IS NULL OR c_status NOT IN ('PENDING', 'REPLACEMENT_PENDING') THEN
    RAISE EXCEPTION 'a verification challenge can only be issued for a pending number' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_CHALLENGE_NOT_OPEN';
  END IF;
  IF (c_status = 'PENDING') <> (NEW.purpose = 'INITIAL_PHONE') THEN
    RAISE EXCEPTION 'the challenge purpose does not match the number' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_CHALLENGE_PURPOSE';
  END IF;
  IF NEW.attempt_count <> 0 OR NEW.used_at IS NOT NULL OR NEW.invalidated_at IS NOT NULL OR NEW.delivery_status <> 'PENDING' THEN
    RAISE EXCEPTION 'a new challenge starts unused, unlocked and unsent' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_CHALLENGE_STATE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_phone_verification_challenges__guard BEFORE INSERT OR UPDATE OR DELETE ON identity.phone_verification_challenges FOR EACH ROW EXECUTE FUNCTION identity.guard_phone_verification_challenges();

-- A challenge is consumed only together with the verification of its number (same transaction): checked at COMMIT.
CREATE FUNCTION identity.check_phone_challenge_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c_status text;
BEGIN
  IF NEW.used_at IS NOT NULL THEN
    SELECT status INTO c_status FROM identity.phone_contacts WHERE phone_contact_id = NEW.phone_contact_id;
    IF c_status IS DISTINCT FROM 'VERIFIED' THEN
      RAISE EXCEPTION 'a challenge is consumed only when its number is verified' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:PHONE_CHALLENGE_CONSUMPTION';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_phone_verification_challenges__consumption AFTER UPDATE ON identity.phone_verification_challenges DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.check_phone_challenge_consumption();

-- =====================================================================================================================
-- 5. seed: the verification.phone.* configuration parameters (CFG-001), through the real change workflow
--    Channel-specific keys (NOT the email values reused). The six code-policy values are the PRD defaults (SV-03.01: 6 digits, 10 minutes, 30 seconds, 5 per hour, 10 per day, 5 attempts).
--    max_accounts_per_number (1) and blocked_line_types (virtual and high-risk) are the PRD SV-03.02 / CU-03.06 defaults and may be overridden per COUNTRY and MARKET (the PRD makes them market
--    policy). The last two limits are NOT in the PRD: they are an engineering assumption for the abuse limits of ID-003, flagged for the security owner (TECH_DEBT).
--    Security parameters: CRITICAL (never cached, never last-known-good), SECOND_APPROVER for every later change.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_approver    constant text := 'system:migration-review';
  v_correlation constant text := 'seed-0011';
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
      (1,  'verification.phone.code.length',              'INTEGER', 'digits',   'Number of digits in a phone verification code',                                                           '{"min": 4, "max": 10}'::jsonb,    'security', ARRAY['PLATFORM'],                    '6'::jsonb,   'PRD SV-03.01 default'),
      (2,  'verification.phone.validity_minutes',         'INTEGER', 'minutes',  'Minutes a phone verification code stays valid after it is issued',                                        '{"min": 1, "max": 120}'::jsonb,   'security', ARRAY['PLATFORM'],                    '10'::jsonb,  'PRD SV-03.01 default'),
      (3,  'verification.phone.resend_seconds',           'INTEGER', 'seconds',  'Minimum seconds between two verification SMS for the same account (resend cooldown)',                    '{"min": 0, "max": 3600}'::jsonb,  'security', ARRAY['PLATFORM'],                    '30'::jsonb,  'PRD SV-03.01 default'),
      (4,  'verification.phone.max_per_hour',             'INTEGER', 'sends',    'Maximum verification SMS an account can request per rolling hour',                                       '{"min": 1, "max": 100}'::jsonb,   'security', ARRAY['PLATFORM'],                    '5'::jsonb,   'PRD SV-03.01 default'),
      (5,  'verification.phone.max_per_day',              'INTEGER', 'sends',    'Maximum verification SMS an account can request per rolling day',                                        '{"min": 1, "max": 1000}'::jsonb,  'security', ARRAY['PLATFORM'],                    '10'::jsonb,  'PRD CU-03.06 reference table default'),
      (6,  'verification.phone.max_attempts',             'INTEGER', 'attempts', 'Maximum wrong code attempts on one phone verification before it locks and a new code is required',      '{"min": 1, "max": 20}'::jsonb,    'security', ARRAY['PLATFORM'],                    '5'::jsonb,   'PRD SV-03.01 default'),
      (7,  'verification.phone.max_accounts_per_number',  'INTEGER', 'accounts', 'Maximum number of accounts that may hold the same phone number verified (country and market policy)',     '{"min": 1, "max": 5}'::jsonb,     'trust',    ARRAY['PLATFORM', 'COUNTRY', 'MARKET'], '1'::jsonb,   'PRD SV-03.02 default (1 per role)'),
      (8,  'verification.phone.blocked_line_types',       'JSON',    NULL,       'Line types a phone number may NOT have to be accepted: a list of LANDLINE, VOIP, VIRTUAL, UNKNOWN, HIGH_RISK (country and market policy)',
           '{"schema": {"type": "array", "items": {"type": "string", "enum": ["LANDLINE", "VOIP", "VIRTUAL", "UNKNOWN", "HIGH_RISK"]}, "uniqueItems": true, "maxItems": 5}}'::jsonb,
           'trust', ARRAY['PLATFORM', 'COUNTRY', 'MARKET'], '["VIRTUAL", "HIGH_RISK"]'::jsonb, 'PRD SV-03.02 default (virtual and high-risk)'),
      (9,  'verification.phone.requests.max_per_hour',    'INTEGER', 'requests', 'Maximum phone verification requests (set, send, confirm) per account and per source address per hour (abuse limit)', '{"min": 1, "max": 1000}'::jsonb, 'security', ARRAY['PLATFORM'], '30'::jsonb, 'ID-003 engineering assumption, not in the PRD; to be confirmed by the security owner'),
      (10, 'verification.phone.number.max_per_hour',      'INTEGER', 'sends',    'Maximum verification SMS sent to one phone number per hour across all accounts (SMS pumping and flooding limit)', '{"min": 1, "max": 100}'::jsonb, 'security', ARRAY['PLATFORM'], '5'::jsonb, 'ID-003 engineering assumption, not in the PRD; to be confirmed by the security owner')
    ) AS t (ord, key, data_type, unit, description, rules, owner, scopes, value, basis)
    ORDER BY ord
  LOOP
    v_reason := 'Initial value (migration 0011): ' || v_seed.basis;
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
    VALUES (v_request, v_approver, 'APPROVE', 'Initial value reviewed with the migration (ID-003)');
    UPDATE configuration.change_requests SET state = 'APPROVED', updated_at = now() WHERE change_request_id = v_request AND state = 'PENDING_APPROVAL';
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, change_request_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_approver, 'CHANGE_APPROVED', v_parameter, v_request, 'Initial value reviewed with the migration (ID-003)', v_correlation);

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
-- 6. seed: the verification SMS and the phone screen copy (CFG-002), through the real content lifecycle
--    Typed variables: verification_code (STRING, a credential, SENSITIVE_PERSONAL) and expiry_minutes (COUNT) in the SMS; masked_phone (STRING, PERSONAL) and seconds (COUNT) on the screen.
--    The SMS stays concise (one segment in GSM-7) and carries no account id, no personal data and no link.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0011';
  v_reason      constant text := 'Initial phone verification copy (migration 0011)';
  v_seed        record;
  v_var         record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1,  'PLAIN_TEXT', 'sms.verification.phone.body',            'Text of the SMS that carries the phone verification code',
           'BananaGig: {verification_code} is your verification code. It expires in {expiry_minutes, plural, one {# minute} other {# minutes}}. Never share this code.',
           '[{"name": "verification_code", "type": "STRING", "description": "The one-time numeric code (a credential: never log it)", "example": "123456", "pii": "SENSITIVE_PERSONAL"},
             {"name": "expiry_minutes", "type": "COUNT", "description": "Minutes until the code expires", "example": 10, "pii": "NONE"}]'::jsonb),
      (2,  'UI_LABEL',   'account.phone.verify.title',             'Title of the phone verification screen', 'Verify your phone', '[]'::jsonb),
      (3,  'PLAIN_TEXT', 'account.phone.verify.intro',             'Introduction on the phone verification screen',
           'We sent a verification code by text message to {masked_phone}. Enter the code below.',
           '[{"name": "masked_phone", "type": "STRING", "description": "The masked number the code was sent to", "example": "+*******0142", "pii": "PERSONAL"}]'::jsonb),
      (4,  'UI_LABEL',   'account.phone.verify.number_label',      'Label of the mobile phone number input', 'Mobile phone number', '[]'::jsonb),
      (5,  'UI_LABEL',   'account.phone.verify.country_label',     'Label of the country selector of the phone number input', 'Country', '[]'::jsonb),
      (6,  'UI_LABEL',   'account.phone.verify.code_label',        'Label of the phone verification code input', 'Verification code', '[]'::jsonb),
      (7,  'UI_LABEL',   'account.phone.verify.submit',            'Button that submits the phone verification code', 'Verify phone', '[]'::jsonb),
      (8,  'UI_LABEL',   'account.phone.verify.resend',            'Button that requests a new phone verification code', 'Resend code', '[]'::jsonb),
      (9,  'PLAIN_TEXT', 'account.phone.verify.resend_wait',       'Countdown text before a new phone code can be requested',
           'You can request a new code in {seconds, plural, one {# second} other {# seconds}}.',
           '[{"name": "seconds", "type": "COUNT", "description": "Seconds left in the resend cooldown", "example": 30, "pii": "NONE"}]'::jsonb),
      (10, 'UI_LABEL',   'account.phone.verify.change',            'Link that lets the person enter a different phone number', 'Change phone number', '[]'::jsonb),
      (11, 'PLAIN_TEXT', 'account.phone.verify.sent',              'Confirmation that a new verification SMS was sent', 'A new code is on its way.', '[]'::jsonb),
      (12, 'PLAIN_TEXT', 'account.phone.verify.success',           'Confirmation that the phone number is verified', 'Your phone number is verified.', '[]'::jsonb),
      (13, 'UI_LABEL',   'account.phone.status.none',              'Label of the phone verification status NONE', 'Not added', '[]'::jsonb),
      (14, 'UI_LABEL',   'account.phone.status.pending',           'Label of the phone verification status PENDING', 'Not verified', '[]'::jsonb),
      (15, 'UI_LABEL',   'account.phone.status.verified',          'Label of the phone verification status VERIFIED', 'Verified', '[]'::jsonb),
      (16, 'PLAIN_TEXT', 'account.phone.error.required',           'Validation message: a phone number is required', 'Enter your mobile phone number.', '[]'::jsonb),
      (17, 'PLAIN_TEXT', 'account.phone.error.too_long',           'Validation message: a phone number is too long', 'This phone number is too long.', '[]'::jsonb),
      (18, 'PLAIN_TEXT', 'account.phone.error.invalid_characters', 'Validation message: a phone number contains forbidden characters', 'This phone number contains characters that are not allowed.', '[]'::jsonb),
      (19, 'PLAIN_TEXT', 'account.phone.error.invalid_number',     'Validation message: a phone number is not valid', 'Enter a valid mobile phone number.', '[]'::jsonb),
      (20, 'PLAIN_TEXT', 'account.phone.error.country_required',   'Validation message: the country of a national number is needed', 'Choose the country of this phone number.', '[]'::jsonb),
      (21, 'PLAIN_TEXT', 'account.phone.error.country_not_supported', 'Validation message: phone numbers of this country are not accepted', 'Phone numbers of this country are not supported yet.', '[]'::jsonb),
      (22, 'PLAIN_TEXT', 'account.phone.error.not_pending',        'Message: there is no phone number waiting to be verified', 'There is no phone number waiting to be verified.', '[]'::jsonb),
      (23, 'PLAIN_TEXT', 'account.phone.error.code_invalid',       'Message: the phone verification code is wrong', 'That code is not correct.', '[]'::jsonb),
      (24, 'PLAIN_TEXT', 'account.phone.error.code_expired',       'Message: the phone verification code has expired', 'This code has expired. Request a new one.', '[]'::jsonb),
      (25, 'PLAIN_TEXT', 'account.phone.error.code_used',          'Message: the phone verification code was already used or replaced', 'This code was already used or has been replaced. Request a new one.', '[]'::jsonb),
      (26, 'PLAIN_TEXT', 'account.phone.error.verification_locked', 'Message: too many wrong attempts locked the phone verification', 'Too many incorrect attempts. Request a new code.', '[]'::jsonb),
      (27, 'PLAIN_TEXT', 'account.phone.error.resend_too_soon',    'Message: a new phone code was requested too soon', 'Please wait a moment before requesting another code.', '[]'::jsonb),
      (28, 'PLAIN_TEXT', 'account.phone.error.send_limit',         'Message: the phone verification limit was reached', 'You have reached the limit of verification texts. Try again later.', '[]'::jsonb),
      (29, 'PLAIN_TEXT', 'account.phone.error.unavailable',        'Message: the number cannot be verified for this account', 'This phone number cannot be verified for your account.', '[]'::jsonb),
      (30, 'PLAIN_TEXT', 'account.phone.error.not_accepted',       'Message: the number is not accepted (line type or risk policy)', 'We cannot accept this phone number. Use a different mobile number.', '[]'::jsonb),
      (31, 'PLAIN_TEXT', 'account.phone.error.risk_unavailable',   'Message: the number could not be checked', 'We could not check this phone number right now. Try again in a moment.', '[]'::jsonb),
      (32, 'PLAIN_TEXT', 'account.phone.error.delivery_failed',    'Message: the verification SMS could not be sent', 'We could not send the text message. Try again in a moment.', '[]'::jsonb),
      (33, 'PLAIN_TEXT', 'account.phone.error.rate_limited',       'Message: too many phone verification requests', 'Too many requests. Try again later.', '[]'::jsonb)
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
