-- checkpoint: ID-002
-- purpose: add the BananaGig-owned email contact and its verification to the identity schema: email_contacts (canonical address, lifecycle status, primary flag, source), email_verification_challenges (one row per send: HMAC code hash, HMAC magic-token hash, expiry, single use, attempt counter, delivery outcome), the audit extension (email actions and a contact reference), the eight verification.email.* configuration parameters with their PRD default values (CFG-001) and the verification email and screen copy (CFG-002)
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. Contacts, challenges and audit rows are never deleted (status changes and new rows instead); the seeded parameters and copy are changed through their own workflows, never by editing this file
-- backfill: none; the tables are new and no account has an email contact (contacts appear when a person adds an address, or when a trusted identity provider reports one verified)
-- risk: low to medium. Two new tables and guards, one additive change to identity.account_audit_events (one nullable column, one wider CHECK). The seeds are deterministic reference data: 8 configuration parameters with one approved PLATFORM value each and 34 managed copy entries. Nothing in this schema stores a plaintext verification code, a plaintext magic token or a credential: only HMAC-SHA-256 hashes (keyed with a server secret that is NOT in the database)
-- destructive: the CHECK constraint ck_account_audit_events__action is dropped and re-created WIDER (seven added email actions) in the same transaction; this is a pure widening, no row is changed or removed and the append-only trigger of the table is not involved (expand step of expand/migrate/contract, nothing is contracted)
-- events: the seeds emit no outbox events (they run before any consumer exists, like 0006 to 0009); every contact and verification change after this migration goes through the service, which writes the events in the same transaction
-- audit: the configuration seed writes the configuration audit trail (PARAMETER_CREATED ... CHANGE_ACTIVATED) and the content seed writes the content audit trail (ENTRY_CREATED ... VERSION_ACTIVATED), exactly as the real workflows do

-- =====================================================================================================================
-- 1. email contacts
-- =====================================================================================================================
CREATE TABLE identity.email_contacts (
  email_contact_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id       uuid        NOT NULL,
  email_normalized text        NOT NULL,
  status           text        NOT NULL,
  is_primary       boolean     NOT NULL DEFAULT false,
  source           text        NOT NULL,
  verified_at      timestamptz,
  disabled_at      timestamptz,
  disabled_reason  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_email_contacts PRIMARY KEY (email_contact_id),
  CONSTRAINT uq_email_contacts__account_contact UNIQUE (account_id, email_contact_id),
  CONSTRAINT fk_email_contacts__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_email_contacts__status CHECK (status IN ('PENDING', 'VERIFIED', 'REPLACEMENT_PENDING', 'DISABLED')),
  CONSTRAINT ck_email_contacts__source CHECK (source IN ('USER_ENTERED', 'IDP_VERIFIED')),
  CONSTRAINT ck_email_contacts__email_normalized CHECK (
    length(email_normalized) <= 254 AND email_normalized ~ '^[a-z0-9!#$%&''*+/=?^_`{|}~.-]{1,64}@[a-z0-9.-]{3,253}$'
  ),
  CONSTRAINT ck_email_contacts__primary_is_verified CHECK (NOT is_primary OR status = 'VERIFIED'),
  CONSTRAINT ck_email_contacts__verified_at CHECK (
    (status <> 'VERIFIED' OR verified_at IS NOT NULL) AND (status NOT IN ('PENDING', 'REPLACEMENT_PENDING') OR verified_at IS NULL)
  ),
  CONSTRAINT ck_email_contacts__idp_born_verified CHECK (source <> 'IDP_VERIFIED' OR verified_at IS NOT NULL),
  CONSTRAINT ck_email_contacts__disabled CHECK (
    (status = 'DISABLED') = (disabled_at IS NOT NULL) AND (status = 'DISABLED') = (disabled_reason IS NOT NULL)
  ),
  CONSTRAINT ck_email_contacts__disabled_reason CHECK (disabled_reason IS NULL OR disabled_reason IN ('REPLACED', 'SUPERSEDED'))
);
COMMENT ON TABLE identity.email_contacts IS 'The email addresses of an account, owned by BananaGig (NOT a copy of the Keycloak email claim: a plain claim is never trusted and never persisted; only an address that a TRUSTED identity provider reported verified, or one the person proved with a code or link, is VERIFIED). PERSONAL DATA: never logged, never in audit changes or events, returned to the owner only in a MASKED form. status: PENDING (first address, unverified), VERIFIED, REPLACEMENT_PENDING (a new address that replaces the verified primary once it verifies; the old address stays VERIFIED and primary until then), DISABLED (replaced or superseded, kept for history). The canonical form is produced by ONE function (contracts canonicalizeEmail: trimmed, domain case-insensitive and IDNA ASCII, local part a lower-cased dot-atom, no Gmail-style dot or plus folding) and is also the delivery address. Rows are never deleted.';
COMMENT ON COLUMN identity.email_contacts.email_normalized IS 'The canonical address (lower-case, ASCII). The comparison, uniqueness and delivery form; the original typing is not kept (single stored form, no derived duplicate).';
COMMENT ON COLUMN identity.email_contacts.is_primary IS 'The account''s primary active email: only a VERIFIED address can be primary and an account has at most one (partial unique index). Flips to true only together with the transition to VERIFIED and to false only together with DISABLED, so the primary is replaced atomically.';
COMMENT ON COLUMN identity.email_contacts.source IS 'USER_ENTERED (must be verified by code or link) or IDP_VERIFIED (a trusted identity provider reported the address verified; born VERIFIED). A claim without the verified flag from a trusted provider is neither: it is not persisted.';
COMMENT ON COLUMN identity.email_contacts.verified_at IS 'When ownership was proven (set exactly once with the transition to VERIFIED, immutable afterwards, kept when the address is later replaced).';
COMMENT ON COLUMN identity.email_contacts.disabled_reason IS 'REPLACED (a verified primary replaced by a newly verified address) or SUPERSEDED (a pending address replaced by a newer pending one before it verified).';

-- Uniqueness policy (docs/engineering/EMAIL_VERIFICATION.md "Uniqueness policy"):
--   verified duplication: one VERIFIED address belongs to at most ONE account (uq_email_contacts__verified_address). Two accounts can never hold the same verified address.
--   pending duplication: ALLOWED across accounts. A pending claim proves nothing, so it must neither block the real owner nor reveal that anyone else holds the address.
--   per account: at most one primary (uq_email_contacts__primary_per_account), at most one open candidate PENDING or REPLACEMENT_PENDING (uq_email_contacts__open_per_account) and one live row per address
--   (uq_email_contacts__live_address_per_account).
-- Index justification (DATA_MODEL_GUARDRAILS rule 11):
--   uq_email_contacts__verified_address: the lookup "is this address verified on any account" at the moment of verification, and the rule itself.
--   uq_email_contacts__primary_per_account: the lookup of the account's primary address (account_id prefix, read by /account/me) and the rule itself.
--   uq_email_contacts__open_per_account: the lookup of the account's pending candidate (read by /account/me and every verification call) and the rule itself.
--   uq_email_contacts__live_address_per_account: the rule only (an account cannot hold the same live address twice, for example verified and pending at once); live rows are at most two per account.
--   uq_email_contacts__account_contact (account_id, email_contact_id): the target of the composite foreign key of account_audit_events, so an audit row can only name a contact of the audited account. Its account_id prefix also serves every read of the contacts of ONE account (the summary, the whole-account invariant check, the history of DISABLED rows) and the account_id foreign key, which the partial indexes above cannot do for DISABLED rows.
--   No index on email_normalized for pending duplicates (no query filters by it); reads by account_id, including history, use uq_email_contacts__account_contact. A new index follows a real query path through its own review.
CREATE UNIQUE INDEX uq_email_contacts__verified_address ON identity.email_contacts (email_normalized) WHERE status = 'VERIFIED';
CREATE UNIQUE INDEX uq_email_contacts__primary_per_account ON identity.email_contacts (account_id) WHERE is_primary;
CREATE UNIQUE INDEX uq_email_contacts__open_per_account ON identity.email_contacts (account_id) WHERE status IN ('PENDING', 'REPLACEMENT_PENDING');
CREATE UNIQUE INDEX uq_email_contacts__live_address_per_account ON identity.email_contacts (account_id, email_normalized) WHERE status <> 'DISABLED';

-- =====================================================================================================================
-- 2. verification challenges (one row per send)
-- =====================================================================================================================
CREATE TABLE identity.email_verification_challenges (
  challenge_id        uuid        NOT NULL DEFAULT gen_random_uuid(),
  email_contact_id    uuid        NOT NULL,
  purpose             text        NOT NULL,
  code_hash           text        NOT NULL,
  magic_token_hash    text        NOT NULL,
  expires_at          timestamptz NOT NULL,
  used_at             timestamptz,
  consumed_via        text,
  attempt_count       integer     NOT NULL DEFAULT 0,
  invalidated_at      timestamptz,
  invalidation_reason text,
  delivery_status     text        NOT NULL DEFAULT 'PENDING',
  last_sent_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  correlation_id      text        NOT NULL,
  CONSTRAINT pk_email_verification_challenges PRIMARY KEY (challenge_id),
  CONSTRAINT uq_email_verification_challenges__magic_token_hash UNIQUE (magic_token_hash),
  CONSTRAINT fk_email_verification_challenges__email_contact_id FOREIGN KEY (email_contact_id) REFERENCES identity.email_contacts (email_contact_id) ON DELETE RESTRICT,
  CONSTRAINT ck_email_verification_challenges__purpose CHECK (purpose IN ('INITIAL_EMAIL', 'CHANGE_EMAIL')),
  CONSTRAINT ck_email_verification_challenges__code_hash CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_email_verification_challenges__magic_token_hash CHECK (magic_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_email_verification_challenges__expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_email_verification_challenges__attempts CHECK (attempt_count >= 0),
  CONSTRAINT ck_email_verification_challenges__consumed CHECK ((used_at IS NULL) = (consumed_via IS NULL) AND (consumed_via IS NULL OR consumed_via IN ('CODE', 'LINK'))),
  CONSTRAINT ck_email_verification_challenges__invalidated CHECK (
    (invalidated_at IS NULL) = (invalidation_reason IS NULL) AND (invalidation_reason IS NULL OR invalidation_reason IN ('SUPERSEDED', 'LOCKED', 'CONTACT_DISABLED', 'DELIVERY_FAILED'))
  ),
  CONSTRAINT ck_email_verification_challenges__closed_once CHECK (used_at IS NULL OR invalidated_at IS NULL),
  CONSTRAINT ck_email_verification_challenges__delivery CHECK (delivery_status IN ('PENDING', 'SENT', 'FAILED') AND ((delivery_status = 'SENT') = (last_sent_at IS NOT NULL))),
  CONSTRAINT ck_email_verification_challenges__correlation CHECK (length(btrim(correlation_id)) > 0 AND length(correlation_id) <= 200)
);
COMMENT ON TABLE identity.email_verification_challenges IS 'One verification intent per SEND: a resend issues a NEW challenge (new code, new magic token) and supersedes the open one, so the number of sends in a window is simply the number of rows (no separate counter to drift) and the history of sends is kept. The code and the magic token are shown ONCE (in the email); only their HMAC-SHA-256 (keyed with a server secret held outside the database) is stored, so a database leak cannot be used to verify an address and a 6-digit code cannot be brute-forced offline. SECURITY: single use (used_at, set under the row lock), expires with the challenge, wrong attempts are counted atomically (attempt_count) and the challenge locks when the configured maximum is reached. Rows are never deleted; used, locked and superseded challenges stay for the audit trail.';
COMMENT ON COLUMN identity.email_verification_challenges.purpose IS 'INITIAL_EMAIL or CHANGE_EMAIL, frozen at issuance from the contact''s status (PENDING = initial, REPLACEMENT_PENDING = change). A deliberate snapshot: the contact status changes when the address verifies, the purpose of this send must not.';
COMMENT ON COLUMN identity.email_verification_challenges.code_hash IS 'HMAC-SHA-256 hex of the numeric code, bound to the challenge id. The plaintext code is never stored or logged.';
COMMENT ON COLUMN identity.email_verification_challenges.magic_token_hash IS 'HMAC-SHA-256 hex of the 256-bit random magic-link token (unique: it is the lookup key of a link confirmation). The plaintext token is never stored or logged.';
COMMENT ON COLUMN identity.email_verification_challenges.attempt_count IS 'Wrong code attempts, incremented atomically under the challenge row lock; the configured maximum (verification.email.max_attempts) locks the challenge. A wrong magic token is not an attempt on any challenge (it matches none).';
COMMENT ON COLUMN identity.email_verification_challenges.last_sent_at IS 'When the delivery provider accepted the message (NULL while the send is pending or after a failed delivery). The resend cooldown counts from the CREATION of the newest challenge that is neither FAILED nor used, so a delivery still in flight holds a second send back, a failed delivery does not make the person wait and a verified address does not delay the next change; the per-hour and per-day caps count every challenge, so failing deliveries are bounded too.';
COMMENT ON COLUMN identity.email_verification_challenges.invalidation_reason IS 'SUPERSEDED (a newer challenge was issued), LOCKED (maximum wrong attempts reached), CONTACT_DISABLED (the address was replaced or superseded) or DELIVERY_FAILED (the message could not be sent, so the code was never delivered). An invalidated challenge can never verify.';

-- Index justification:
--   uq_email_verification_challenges__magic_token_hash: THE lookup of a link confirmation, and the guarantee that two challenges never share a token.
--   uq_email_verification_challenges__open_per_contact: the lookup of the contact's open (usable) challenge for a code confirmation, and the rule that a contact has at most one open challenge
--     (a resend supersedes the previous one in the same transaction).
--   idx_email_verification_challenges__contact_created: the send history of ONE contact, newest first: the resend cooldown (newest non-FAILED, unused row), the per-hour and per-day caps (rows since a moment) and the
--     verification timeline. It also covers the foreign key. Counting per account joins the account's few contacts to this index.
--   No index on expires_at: expiry is evaluated on the row loaded by key; there is no sweeper. A retention job would add a partial index through its own review.
CREATE UNIQUE INDEX uq_email_verification_challenges__open_per_contact ON identity.email_verification_challenges (email_contact_id) WHERE used_at IS NULL AND invalidated_at IS NULL;
CREATE INDEX idx_email_verification_challenges__contact_created ON identity.email_verification_challenges (email_contact_id, created_at DESC);

-- =====================================================================================================================
-- 3. audit extension: email actions and the contact they concern
-- =====================================================================================================================
ALTER TABLE identity.account_audit_events DROP CONSTRAINT ck_account_audit_events__action;
ALTER TABLE identity.account_audit_events ADD CONSTRAINT ck_account_audit_events__action CHECK (
  action IN ('ACCOUNT_CREATED', 'EXTERNAL_IDENTITY_LINKED', 'ROLE_GRANTED', 'ROLE_ACTIVATED', 'ROLE_DEACTIVATED', 'PRIMARY_ROLE_CHANGED', 'PROFILE_UPDATED',
             'EMAIL_ADDED', 'EMAIL_CHANGE_REQUESTED', 'EMAIL_VERIFICATION_REQUESTED', 'EMAIL_VERIFICATION_FAILED', 'EMAIL_VERIFICATION_LOCKED', 'EMAIL_VERIFIED', 'EMAIL_PRIMARY_CHANGED')
);
ALTER TABLE identity.account_audit_events ADD COLUMN email_contact_id uuid;
ALTER TABLE identity.account_audit_events
  ADD CONSTRAINT fk_account_audit_events__account_email_contact FOREIGN KEY (account_id, email_contact_id) REFERENCES identity.email_contacts (account_id, email_contact_id) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_account_audit_events__email_contact CHECK ((action LIKE 'EMAIL\_%') = (email_contact_id IS NOT NULL));
COMMENT ON COLUMN identity.account_audit_events.email_contact_id IS 'The email contact an EMAIL_* action concerns (NULL for every other action). The composite foreign key (account_id, email_contact_id) guarantees the contact belongs to the audited account. The audit trail names the contact by id and, in changes, by a MASKED address; it never holds a full address, a code, a token or a hash. The per-contact timeline is read through the per-account index with this column as a filter (an account has a handful of contacts), so no extra index is added.';

-- =====================================================================================================================
-- 4. guards: the database enforces the email lifecycle itself (defense in depth under the service)
--    Same conventions as 0009: every RAISE carries DETAIL 'identity_rule:<KEY>'; lock order account row, then contact row, then challenge row.
-- =====================================================================================================================
CREATE FUNCTION identity.guard_email_contacts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a_status    text;
  has_primary boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'email contacts cannot be deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.email_contact_id, NEW.account_id, NEW.email_normalized, NEW.source, NEW.created_at)
       IS DISTINCT FROM (OLD.email_contact_id, OLD.account_id, OLD.email_normalized, OLD.source, OLD.created_at) THEN
      RAISE EXCEPTION 'an email contact is immutable except for its lifecycle fields' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:IMMUTABLE_IDENTITY';
    END IF;
    IF OLD.status = 'DISABLED' THEN
      RAISE EXCEPTION 'a disabled email contact never changes again' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:IMMUTABLE_IDENTITY';
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
        RAISE EXCEPTION 'illegal email contact transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_STATUS_TRANSITION';
      END IF;
    END IF;
    IF NEW.status = 'VERIFIED' THEN
      IF OLD.status <> 'VERIFIED' THEN
        -- a verified address is the primary one (a second verified address per account has no use case yet); a closed account verifies nothing
        IF NOT NEW.is_primary THEN
          RAISE EXCEPTION 'an address is verified as the primary address of its account' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_PRIMARY_CHANGE';
        END IF;
        SELECT status INTO a_status FROM identity.accounts WHERE account_id = OLD.account_id FOR SHARE;
        IF a_status = 'CLOSED' THEN
          RAISE EXCEPTION 'a closed account cannot verify an email contact' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_CLOSED';
        END IF;
      END IF;
    END IF;
    IF NEW.is_primary IS DISTINCT FROM OLD.is_primary THEN
      IF NEW.is_primary THEN
        IF NOT (NEW.status = 'VERIFIED' AND OLD.status <> 'VERIFIED') THEN
          RAISE EXCEPTION 'an address becomes primary only when it is verified' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_PRIMARY_CHANGE';
        END IF;
      ELSE
        IF NEW.status <> 'DISABLED' THEN
          RAISE EXCEPTION 'the primary address stops being primary only when it is replaced' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_PRIMARY_CHANGE';
        END IF;
      END IF;
    END IF;
    IF NEW.status = 'DISABLED' THEN
      IF OLD.status = 'VERIFIED' THEN
        IF NEW.disabled_reason IS DISTINCT FROM 'REPLACED' THEN
          RAISE EXCEPTION 'a verified address is disabled only when it is replaced' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_STATUS_TRANSITION';
        END IF;
        -- the account row is locked before its siblings are read (a concurrent replacement or verification serializes with this)
        PERFORM 1 FROM identity.accounts WHERE account_id = OLD.account_id FOR UPDATE;
        IF NOT EXISTS (SELECT 1 FROM identity.email_contacts WHERE account_id = OLD.account_id AND status = 'REPLACEMENT_PENDING') THEN
          RAISE EXCEPTION 'the verified primary address can only be replaced by a verified replacement' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_PRIMARY_NOT_REPLACEABLE';
        END IF;
      ELSIF OLD.status IN ('PENDING', 'REPLACEMENT_PENDING') THEN
        IF NEW.disabled_reason IS DISTINCT FROM 'SUPERSEDED' THEN
          RAISE EXCEPTION 'a pending address is disabled only when it is superseded' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_STATUS_TRANSITION';
        END IF;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT. The account row is locked first: concurrent first-address inserts and the primary read below serialize on it.
  SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id FOR UPDATE;
  IF a_status = 'CLOSED' THEN
    RAISE EXCEPTION 'a closed account cannot receive an email contact' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_CLOSED';
  END IF;
  IF NEW.status = 'DISABLED' THEN
    RAISE EXCEPTION 'an email contact cannot be created disabled' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_STATUS_TRANSITION';
  END IF;
  SELECT EXISTS (SELECT 1 FROM identity.email_contacts WHERE account_id = NEW.account_id AND is_primary) INTO has_primary;
  IF NEW.status = 'PENDING' THEN
    IF has_primary THEN
      RAISE EXCEPTION 'an initial address cannot be added while a verified primary exists; request a change instead' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_INITIAL_WITH_PRIMARY';
    END IF;
  ELSIF NEW.status = 'REPLACEMENT_PENDING' THEN
    IF NOT has_primary THEN
      RAISE EXCEPTION 'a replacement address needs a verified primary to replace' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_REPLACEMENT_WITHOUT_PRIMARY';
    END IF;
  ELSIF NEW.status = 'VERIFIED' THEN
    IF NEW.source <> 'IDP_VERIFIED' THEN
      RAISE EXCEPTION 'only an address reported verified by a trusted identity provider is created verified' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_STATUS_TRANSITION';
    END IF;
    IF has_primary THEN
      RAISE EXCEPTION 'the account already has a verified primary address' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_INITIAL_WITH_PRIMARY';
    END IF;
    IF NOT NEW.is_primary THEN
      RAISE EXCEPTION 'an address is created verified as the primary address of its account' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_PRIMARY_CHANGE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_email_contacts__guard BEFORE INSERT OR UPDATE OR DELETE ON identity.email_contacts FOR EACH ROW EXECUTE FUNCTION identity.guard_email_contacts();

-- Whole-account invariants, checked once at COMMIT (so the multi-step replacement is allowed to pass through intermediate states inside its transaction):
--   a pending INITIAL address and a primary never coexist; a REPLACEMENT_PENDING address needs a primary; an account that ever replaced a primary still has one;
--   a contact that is no longer open (verified or disabled) has no open challenge left.
CREATE FUNCTION identity.check_email_account_invariants() RETURNS trigger LANGUAGE plpgsql AS $$
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
    FROM identity.email_contacts WHERE account_id = NEW.account_id;
  IF has_initial THEN
    IF has_primary THEN
      RAISE EXCEPTION 'an account cannot have a pending initial address and a verified primary' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_INVARIANT';
    END IF;
  END IF;
  IF has_replacement THEN
    IF NOT has_primary THEN
      RAISE EXCEPTION 'a replacement address needs a verified primary' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_INVARIANT';
    END IF;
  END IF;
  IF has_replaced THEN
    IF NOT has_primary THEN
      RAISE EXCEPTION 'an account that replaced its primary address must have a primary address' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_INVARIANT';
    END IF;
  END IF;
  IF NEW.status NOT IN ('PENDING', 'REPLACEMENT_PENDING') THEN
    IF EXISTS (SELECT 1 FROM identity.email_verification_challenges WHERE email_contact_id = NEW.email_contact_id AND used_at IS NULL AND invalidated_at IS NULL) THEN
      RAISE EXCEPTION 'a contact that is no longer pending cannot keep an open verification challenge' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:EMAIL_INVARIANT';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_email_contacts__invariants AFTER INSERT OR UPDATE ON identity.email_contacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.check_email_account_invariants();

CREATE FUNCTION identity.guard_email_verification_challenges() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c_status text;
  a_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verification challenges cannot be deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.challenge_id, NEW.email_contact_id, NEW.purpose, NEW.code_hash, NEW.magic_token_hash, NEW.expires_at, NEW.created_at, NEW.correlation_id)
       IS DISTINCT FROM (OLD.challenge_id, OLD.email_contact_id, OLD.purpose, OLD.code_hash, OLD.magic_token_hash, OLD.expires_at, OLD.created_at, OLD.correlation_id) THEN
      RAISE EXCEPTION 'a verification challenge is immutable except for its attempt, use, invalidation and delivery fields' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:IMMUTABLE_IDENTITY';
    END IF;
    IF OLD.used_at IS NOT NULL OR OLD.invalidated_at IS NOT NULL THEN
      RAISE EXCEPTION 'a used or invalidated challenge never changes again' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CHALLENGE_CLOSED';
    END IF;
    IF NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'the attempt counter only counts up, one attempt at a time' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CHALLENGE_ATTEMPTS';
    END IF;
    IF OLD.delivery_status <> 'PENDING' THEN
      IF (NEW.delivery_status, NEW.last_sent_at) IS DISTINCT FROM (OLD.delivery_status, OLD.last_sent_at) THEN
        RAISE EXCEPTION 'the delivery outcome is recorded once' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CHALLENGE_DELIVERY';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT: the contact row is locked, must be open, and the purpose must match its status
  SELECT a.status INTO a_status FROM identity.email_contacts k JOIN identity.accounts a ON a.account_id = k.account_id WHERE k.email_contact_id = NEW.email_contact_id FOR SHARE OF a;
  IF a_status = 'CLOSED' THEN
    RAISE EXCEPTION 'a closed account cannot receive a verification challenge' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ACCOUNT_CLOSED';
  END IF;
  SELECT status INTO c_status FROM identity.email_contacts WHERE email_contact_id = NEW.email_contact_id FOR UPDATE;
  IF c_status IS NULL OR c_status NOT IN ('PENDING', 'REPLACEMENT_PENDING') THEN
    RAISE EXCEPTION 'a verification challenge can only be issued for a pending address' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CHALLENGE_NOT_OPEN';
  END IF;
  IF (c_status = 'PENDING') <> (NEW.purpose = 'INITIAL_EMAIL') THEN
    RAISE EXCEPTION 'the challenge purpose does not match the address' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CHALLENGE_PURPOSE';
  END IF;
  IF NEW.attempt_count <> 0 OR NEW.used_at IS NOT NULL OR NEW.invalidated_at IS NOT NULL OR NEW.delivery_status <> 'PENDING' THEN
    RAISE EXCEPTION 'a new challenge starts unused, unlocked and unsent' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CHALLENGE_STATE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_email_verification_challenges__guard BEFORE INSERT OR UPDATE OR DELETE ON identity.email_verification_challenges FOR EACH ROW EXECUTE FUNCTION identity.guard_email_verification_challenges();

-- A challenge is consumed only together with the verification of its address (same transaction): checked at COMMIT.
CREATE FUNCTION identity.check_challenge_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c_status text;
BEGIN
  IF NEW.used_at IS NOT NULL THEN
    SELECT status INTO c_status FROM identity.email_contacts WHERE email_contact_id = NEW.email_contact_id;
    IF c_status IS DISTINCT FROM 'VERIFIED' THEN
      RAISE EXCEPTION 'a challenge is consumed only when its address is verified' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:CHALLENGE_CONSUMPTION';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_email_verification_challenges__consumption AFTER UPDATE ON identity.email_verification_challenges DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.check_challenge_consumption();

-- =====================================================================================================================
-- 5. seed: the verification.email.* configuration parameters (CFG-001), through the real change workflow
--    Defaults are the PRD values (SV-03.01, CU-03.06 reference table: 6 digits, 10 minutes, 30 seconds, 5 per hour, 10 per day, 5 attempts). The two rate-limit
--    parameters at the end are NOT in the PRD: they are an engineering assumption for the abuse limits of ID-002 and are flagged for the security owner (TECH_DEBT).
--    Security parameters: owner security, CRITICAL (never served from a cache or last-known-good), SECOND_APPROVER for every later change, PLATFORM scope only.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_approver    constant text := 'system:migration-review';
  v_correlation constant text := 'seed-0010';
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
      (1, 'verification.email.code.length',            'digits',   'Number of digits in an email verification code',                                                          '{"min": 4, "max": 10}'::jsonb,    6,  'PRD SV-03.01 default'),
      (2, 'verification.email.validity_minutes',       'minutes',  'Minutes an email verification code and magic link stay valid after they are issued',                      '{"min": 1, "max": 120}'::jsonb,   10, 'PRD SV-03.01 default'),
      (3, 'verification.email.resend_seconds',         'seconds',  'Minimum seconds between two verification emails for the same account (resend cooldown)',                  '{"min": 0, "max": 3600}'::jsonb,  30, 'PRD SV-03.01 default'),
      (4, 'verification.email.max_per_hour',           'sends',    'Maximum verification emails an account can request per rolling hour',                                     '{"min": 1, "max": 100}'::jsonb,   5,  'PRD SV-03.01 default'),
      (5, 'verification.email.max_per_day',            'sends',    'Maximum verification emails an account can request per rolling day',                                      '{"min": 1, "max": 1000}'::jsonb,  10, 'PRD CU-03.06 reference table default'),
      (6, 'verification.email.max_attempts',           'attempts', 'Maximum wrong code attempts on one verification before it locks and a new code is required',              '{"min": 1, "max": 20}'::jsonb,    5,  'PRD SV-03.01 default'),
      (7, 'verification.email.requests.max_per_hour',  'requests', 'Maximum email verification requests (set, send, confirm) per account and per source address per hour (abuse limit)', '{"min": 1, "max": 1000}'::jsonb, 30, 'ID-002 engineering assumption, not in the PRD; to be confirmed by the security owner'),
      (8, 'verification.email.address.max_per_hour',   'sends',    'Maximum verification emails sent to one email address per hour across all accounts (mailbox flooding limit)', '{"min": 1, "max": 100}'::jsonb,   5,  'ID-002 engineering assumption, not in the PRD; to be confirmed by the security owner')
    ) AS t (ord, key, unit, description, rules, value, basis)
    ORDER BY ord
  LOOP
    v_reason := 'Initial value (migration 0010): ' || v_seed.basis;
    INSERT INTO configuration.parameters (key, data_type, unit, description, owner_role, validation_rules, sensitivity, approval_policy, criticality, is_required, created_by)
    VALUES (v_seed.key, 'INTEGER', v_seed.unit, v_seed.description, 'security', v_seed.rules, 'INTERNAL', 'SECOND_APPROVER', 'CRITICAL', true, v_actor)
    RETURNING parameter_id INTO v_parameter;
    INSERT INTO configuration.parameter_scopes (parameter_id, scope_type) VALUES (v_parameter, 'PLATFORM');
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'PARAMETER_CREATED', v_parameter, 'parameter definition created', v_correlation);

    INSERT INTO configuration.change_requests (parameter_id, scope_type, scope_ref, proposed_value, effective_from, reason, requested_by, approval_policy)
    VALUES (v_parameter, 'PLATFORM', NULL, to_jsonb(v_seed.value), v_from, v_reason, v_actor, 'SECOND_APPROVER')
    RETURNING change_request_id INTO v_request;
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, change_request_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'CHANGE_DRAFTED', v_parameter, v_request, v_reason, v_correlation);

    UPDATE configuration.change_requests SET state = 'PENDING_APPROVAL', updated_at = now() WHERE change_request_id = v_request AND state = 'DRAFT';
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, change_request_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'CHANGE_SUBMITTED', v_parameter, v_request, v_reason, v_correlation);

    INSERT INTO configuration.change_approvals (change_request_id, approver, decision, comment)
    VALUES (v_request, v_approver, 'APPROVE', 'Initial value reviewed with the migration (ID-002)');
    UPDATE configuration.change_requests SET state = 'APPROVED', updated_at = now() WHERE change_request_id = v_request AND state = 'PENDING_APPROVAL';
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, change_request_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_approver, 'CHANGE_APPROVED', v_parameter, v_request, 'Initial value reviewed with the migration (ID-002)', v_correlation);

    INSERT INTO configuration.parameter_values (parameter_id, scope_type, scope_ref) VALUES (v_parameter, 'PLATFORM', NULL) RETURNING parameter_value_id INTO v_holder;
    INSERT INTO configuration.value_versions (parameter_value_id, version, value, effective_from, reason, created_by)
    VALUES (v_holder, 1, to_jsonb(v_seed.value), v_from, v_reason, v_actor)
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
-- 6. seed: the verification email and the verification screen copy (CFG-002), through the real content lifecycle
--    Typed variables: verification_code (STRING), verification_url (URL), expiry_minutes (COUNT) in the email; masked_email (STRING) and seconds (COUNT) on the screen.
--    The code and the link are credentials: they are marked SENSITIVE_PERSONAL so no consumer treats them as ordinary text.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0010';
  v_reason      constant text := 'Initial email verification copy (migration 0010)';
  v_seed        record;
  v_var         record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1,  'EMAIL_SUBJECT', 'account.email.verification.subject',        'Subject of the email that carries the email verification code and link',
           'Your BananaGig verification code', '[]'::jsonb),
      (2,  'EMAIL_BODY',    'account.email.verification.body',           'Body of the email that carries the email verification code and link',
           E'Your BananaGig verification code is **{verification_code}**.\n\nIt expires in {expiry_minutes, plural, one {# minute} other {# minutes}}. You can also [confirm your email address]({verification_url}).\n\nIf you did not ask for this, you can ignore this email. Your account stays as it is until the code is entered.',
           '[{"name": "verification_code", "type": "STRING", "description": "The one-time numeric code (a credential: never log it)", "example": "123456", "pii": "SENSITIVE_PERSONAL"},
             {"name": "verification_url", "type": "URL", "description": "The single-use magic link that confirms the address (a credential: never log it)", "example": "https://app.bananagig.example/verify-email?token=example", "pii": "SENSITIVE_PERSONAL"},
             {"name": "expiry_minutes", "type": "COUNT", "description": "Minutes until the code and the link expire", "example": 10, "pii": "NONE"}]'::jsonb),
      (3,  'UI_LABEL',      'account.email.verify.title',                'Title of the email verification screen', 'Verify your email', '[]'::jsonb),
      (4,  'PLAIN_TEXT',    'account.email.verify.intro',                'Introduction on the email verification screen',
           'We sent a verification code and a link to {masked_email}. Enter the code below or open the link in the email.',
           '[{"name": "masked_email", "type": "STRING", "description": "The masked address the code was sent to", "example": "a***@e***.com", "pii": "PERSONAL"}]'::jsonb),
      (5,  'UI_LABEL',      'account.email.verify.code_label',           'Label of the verification code input', 'Verification code', '[]'::jsonb),
      (6,  'UI_LABEL',      'account.email.verify.submit',               'Button that submits the verification code', 'Verify email', '[]'::jsonb),
      (7,  'UI_LABEL',      'account.email.verify.resend',               'Button that requests a new verification code', 'Resend code', '[]'::jsonb),
      (8,  'PLAIN_TEXT',    'account.email.verify.resend_wait',          'Countdown text before a new code can be requested',
           'You can request a new code in {seconds, plural, one {# second} other {# seconds}}.',
           '[{"name": "seconds", "type": "COUNT", "description": "Seconds left in the resend cooldown", "example": 30, "pii": "NONE"}]'::jsonb),
      (9,  'UI_LABEL',      'account.email.verify.change',               'Link that lets the person enter a different email address', 'Change email address', '[]'::jsonb),
      (10, 'PLAIN_TEXT',    'account.email.verify.sent',                 'Confirmation that a new verification email was sent', 'A new code is on its way.', '[]'::jsonb),
      (11, 'PLAIN_TEXT',    'account.email.verify.success',              'Confirmation that the email address is verified', 'Your email address is verified.', '[]'::jsonb),
      (12, 'UI_LABEL',      'account.email.link.title',                  'Title of the page opened from the magic link', 'Confirm your email address', '[]'::jsonb),
      (13, 'PLAIN_TEXT',    'account.email.link.body',                   'Text of the page opened from the magic link', 'Select the button to finish verifying your email address.', '[]'::jsonb),
      (14, 'UI_LABEL',      'account.email.link.confirm',                'Button that confirms the email address from the magic link page', 'Confirm email address', '[]'::jsonb),
      (15, 'UI_LABEL',      'account.email.status.none',                 'Label of the email verification status NONE', 'Not added', '[]'::jsonb),
      (16, 'UI_LABEL',      'account.email.status.pending',              'Label of the email verification status PENDING', 'Not verified', '[]'::jsonb),
      (17, 'UI_LABEL',      'account.email.status.verified',             'Label of the email verification status VERIFIED', 'Verified', '[]'::jsonb),
      (18, 'PLAIN_TEXT',    'account.email.error.required',              'Validation message: an email address is required', 'Enter your email address.', '[]'::jsonb),
      (19, 'PLAIN_TEXT',    'account.email.error.too_long',              'Validation message: an email address is too long', 'This email address is too long.', '[]'::jsonb),
      (20, 'PLAIN_TEXT',    'account.email.error.invalid_format',        'Validation message: an email address is not valid', 'Enter a valid email address.', '[]'::jsonb),
      (21, 'PLAIN_TEXT',    'account.email.error.invalid_characters',    'Validation message: an email address contains forbidden characters', 'This email address contains characters that are not allowed.', '[]'::jsonb),
      (22, 'PLAIN_TEXT',    'account.email.error.unsupported',           'Validation message: an email address format is not supported', 'This email address format is not supported.', '[]'::jsonb),
      (23, 'PLAIN_TEXT',    'account.email.error.not_pending',           'Message: there is no email address waiting to be verified', 'There is no email address waiting to be verified.', '[]'::jsonb),
      (24, 'PLAIN_TEXT',    'account.email.error.code_invalid',          'Message: the verification code is wrong', 'That code is not correct.', '[]'::jsonb),
      (25, 'PLAIN_TEXT',    'account.email.error.code_expired',          'Message: the verification code or link has expired', 'This verification has expired. Request a new one.', '[]'::jsonb),
      (26, 'PLAIN_TEXT',    'account.email.error.code_used',             'Message: the verification code or link was already used or replaced', 'This verification was already used or has been replaced. Request a new one.', '[]'::jsonb),
      (27, 'PLAIN_TEXT',    'account.email.error.verification_locked',   'Message: too many wrong attempts locked the verification', 'Too many incorrect attempts. Request a new code.', '[]'::jsonb),
      (28, 'PLAIN_TEXT',    'account.email.error.resend_too_soon',       'Message: a new code was requested too soon', 'Please wait a moment before requesting another code.', '[]'::jsonb),
      (29, 'PLAIN_TEXT',    'account.email.error.send_limit',            'Message: the verification email limit was reached', 'You have reached the limit of verification emails. Try again later.', '[]'::jsonb),
      (30, 'PLAIN_TEXT',    'account.email.error.unavailable',           'Message: the address cannot be verified for this account', 'This email address cannot be verified for your account.', '[]'::jsonb),
      (31, 'PLAIN_TEXT',    'account.email.error.delivery_failed',       'Message: the verification email could not be sent', 'We could not send the email. Try again in a moment.', '[]'::jsonb),
      (32, 'PLAIN_TEXT',    'account.email.error.rate_limited',          'Message: too many verification requests', 'Too many requests. Try again later.', '[]'::jsonb),
      (33, 'PLAIN_TEXT',    'account.email.error.link_invalid',          'Message: the verification link is not valid', 'This link is not valid. Request a new verification email.', '[]'::jsonb),
      (34, 'PLAIN_TEXT',    'account.email.link.sign_in_required',       'Text of the magic link page when the person is not signed in', 'Sign in to your account, then open the link in your email again.', '[]'::jsonb)
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
