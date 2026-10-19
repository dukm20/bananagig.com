-- checkpoint: PRO-002
-- purpose: add the PROVIDER PUBLIC PROFILE in the existing `provider` schema. provider.public_profiles is a PRESENTATION AGGREGATE: it stores only what the provider authors for customers (an optional display name, an optional plain-text bio, one profile photo by REFERENCE to an asset, a two-state visibility) and a revision for optimistic concurrency. Everything else a customer sees is DERIVED at read time from the domain that owns it (the fallback public name from identity.account_profiles, trust badges from the live verification case, Gig summaries from published Gig versions, the market from the COMPLETED registration): no verified flag, no Gig field, no price, no rating is copied. The profile has its own opaque public identifier (public_profile_id, the ONLY identifier ever exposed publicly) next to the internal account_id (unique: one profile per provider account). The photo reuses the CAT-004 asset pipeline: provider.media_assets gains an immutable `purpose` (GIG_PHOTO default, PROFILE_PHOTO) so a profile photo can never be attached to a Gig version and a Gig photo can never be a profile photo (guards on both sides), and the asset guard now counts references from the profile (photo_asset_id and pending_photo_asset_id) so a referenced asset is neither abandoned nor deleted. An immutable audit trail (provider.profile_audit_events) records four actions. Seeds: seven policy parameters (configuration, CFG-001) and the copy of the profile flow (content, CFG-002). No profile, asset or audit row is seeded.
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. No profile or audit row is ever deleted or truncated (a profile is hidden by setting it PRIVATE; its history stays), the new asset column has a constant default and is immutable, so there is nothing to restore; the seeded values and copy are changed through the configuration and content workflows, never by editing this file
-- backfill: none. The new media_assets column defaults to GIG_PHOTO for every existing asset (every existing asset is a Gig photo); no profile exists until a provider creates one
-- risk: P0 data class (public exposure of provider data) but low migration risk. New objects: two tables and three functions (two guards and one helper). Existing objects touched: (1) provider.media_assets: one NOT NULL column with a constant default (metadata only on PostgreSQL 11+, no rewrite) and a CHECK on it (one scan of a small table); (2) provider.guard_media_assets replaced (its 0022 body plus the immutable purpose and the profile references in the delete and abandon rules); (3) provider.guard_gig_version_media replaced (its 0021 body plus one purpose check). The replaced guards behave exactly as before for every statement that was legal, except that an asset referenced by a profile is now refused ABANDONED / DELETED and a PROFILE_PHOTO asset is refused as a Gig photo
-- destructive: none (no DROP, no DELETE, no TRUNCATE)
-- events: the seeds emit no outbox events (they run before any consumer exists); every profile change after this migration goes through ProviderProfileService, which writes audit and the outbox event in the same transaction
-- audit: the configuration and content seeds write their own audit trails exactly as the real workflows do (correlation seed-0024); the profile audit trail starts empty
-- ASSUMPTIONS (flagged as debt, product configuration, changed through the change-request workflow; the PRD gives none of these numbers): display name at most 60 characters (structural ceiling 100), bio at most 1000 characters (structural ceiling 5000), a bio is NOT required for a public profile (provider.profile.bio.required = false), a photo is NOT required (provider.profile.photo.required = false), a profile photo is at most 2 MiB (2097152 bytes; the Gig photo limit is 10 MB, a profile photo is small and is read into memory on every public request, so it is capped lower; structural ceiling 25 MiB), the customer-visible trust badge types are IDENTITY, BACKGROUND_CHECK and INSURANCE (provider.profile.public_badge_types; a listed type still needs an APPROVED, current requirement of that type; LICENSE, CERTIFICATION, BUSINESS_REGISTRATION and OTHER_DOCUMENT are off until the owner decides), and the marketplace-eligibility gate is OFF (provider.profile.public_requires_marketplace_eligibility = false until PRO-003 / Go-Live exists; with the flag on and no eligibility port wired a public read fails closed). Two parameters are CRITICAL because they decide what the public sees (the badge list and the eligibility gate must never be served stale); the other five are STANDARD. The badge labels say what the platform did, not more: "Identity checked", "Background check completed", "Insurance on file", "License on file", "Certification on file", "Business registration on file", "Additional document on file" (owner copy decision, debt). OPEN OWNER QUESTION: the PRD (CU-02.11) shows customers first name and last initial only, while PR-09.02 lists a display name separately from the legal name; this migration permits a provider-entered display name that may differ (the default when none is set is first name and last initial). The profile photo object key stays provider/gig-media/<asset id> (ck_media_assets__object_key_derived of 0022 is not relaxed: the prefix names the store folder, not the purpose; a purpose-specific prefix would need an expand/contract change of that CHECK and of the service, recorded as debt)
-- DECISIONS: (1) presentation aggregate, not a source of truth: the profile row holds provider-authored presentation only; trust, Gigs, market and legal names are never copied (no drift to detect); (2) TWO identifiers: public_profile_id (random, opaque, the only public identifier) and account_id (internal, UNIQUE: the one-profile rule). The public id is not derived from the account id or the name, so it can be rotated by a future migration without touching identity, and a public payload never needs the account id; (3) display_name and bio are NULL until entered; NULL means "use the default" (display name) or "none" (bio), so there is no empty-string state: both CHECKs refuse blank text. Provider text is plain text; the service owns the Unicode-property rules (normalisation, HTML-looking markup, invisible characters of every plane); the database holds structural ceilings (100 / 5000 code points), trimmed and non-blank, NFC, and a backstop against control, bidirectional-override and the common invisible BMP characters (a strict SUBSET of what the service refuses, so no value the service accepts can be refused here); (4) the photo is a REFERENCE to a READY asset (photo_asset_id) plus at most ONE unfinished upload (pending_photo_asset_id), never a URL, key or hash on the profile; the two pointers are different assets (CHECK); a new authorization abandons the previous pending upload: the service clears the pointer first (the asset guard refuses to abandon a referenced asset); (5) the asset purpose separates the two uses of the same bytes pipeline: GIG_PHOTO only by gig_version_media, PROFILE_PHOTO only by public_profiles, enforced in BOTH guards (ASSET_PURPOSE) and immutable after insert; (6) reference-aware asset guard: an asset is never DELETED while any attachment or profile pointer references it, and never ABANDONED while an attachment of a version that is not RETIRED or ANY profile pointer references it; a profile reference never becomes history, so it always blocks until the service clears the pointer; (7) visibility has two states, PRIVATE (default) and PUBLIC; published_at is maintained by the guard and equals the time of the latest PRIVATE -> PUBLIC change (CHECK: (visibility_status = PUBLIC) = (published_at IS NOT NULL)). There is NO suspended or hidden state: nothing could reach it; moderation adds it by a forward migration. PUBLIC is a preference and does NOT mean live or bookable (Go-Live is PRO-003); whether a PUBLIC profile is actually served is decided at read time (account ACTIVE, provider role ACTIVE, registration COMPLETED, optional marketplace eligibility); (8) revision: +1 on every effective change of display name, bio, photo or visibility (REVISION guard); a change of only the pending upload pointer may keep or raise it (the sweep that clears an expired pending upload does not invalidate the owner's view); a no-op update keeps it; (9) lock order account -> profile -> asset, never asset first: the profile guard takes the asset row FOR SHARE after the profile row it is already updating, and the asset guard (which holds the asset row lock) only READS the profile pointers without a lock, so an attach/clear and a sweep serialize on the asset row without a deadlock; (10) no index for a PUBLIC listing: nothing lists or searches profiles yet (SEARCH, PRO-003); a partial index on visibility_status is NOT added speculatively; (11) the audit table repeats account_id (the owner at the time of the event, guard-checked against the profile) so a trail reads per account, stores field NAMES, revision and visibility only (never the bio, name, photo ids, keys or hashes) and is immutable; (12) no JSON column on the profile (every fact is a typed column); the audit `changes` object is the one JSON value and holds identifiers only

-- =====================================================================================================================
-- 1. provider.media_assets.purpose (what a stored photo is for)
-- =====================================================================================================================
ALTER TABLE provider.media_assets ADD COLUMN purpose text NOT NULL DEFAULT 'GIG_PHOTO';
ALTER TABLE provider.media_assets ADD CONSTRAINT ck_media_assets__purpose CHECK (purpose IN ('GIG_PHOTO', 'PROFILE_PHOTO'));
COMMENT ON COLUMN provider.media_assets.purpose IS 'What the asset is for (PRO-002): GIG_PHOTO (the default; every asset before 0024) can be attached only to a Gig version (provider.gig_version_media), PROFILE_PHOTO only referenced by the provider''s public profile (provider.public_profiles.photo_asset_id / pending_photo_asset_id). Both guards enforce it (ASSET_PURPOSE); it is immutable after insert (IMMUTABLE_IDENTITY). The bytes pipeline (integrity checks, scan, promotion, clean-up) is the same for both; the object key stays provider/gig-media/<asset id>. The profile size limit (provider.profile.photo.max_file_size_bytes) is enforced by the service at authorization.';

-- =====================================================================================================================
-- 2. provider.public_profiles (the presentation aggregate)
-- =====================================================================================================================
CREATE TABLE provider.public_profiles (
  public_profile_id        uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id               uuid        NOT NULL,
  display_name             text,
  bio                      text,
  photo_asset_id           uuid,
  pending_photo_asset_id   uuid,
  visibility_status        text        NOT NULL DEFAULT 'PRIVATE',
  revision                 integer     NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  published_at             timestamptz,
  CONSTRAINT pk_public_profiles PRIMARY KEY (public_profile_id),
  CONSTRAINT uq_public_profiles__account UNIQUE (account_id),
  CONSTRAINT fk_public_profiles__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_public_profiles__photo_asset_id FOREIGN KEY (photo_asset_id) REFERENCES provider.media_assets (media_asset_id) ON DELETE RESTRICT,
  CONSTRAINT fk_public_profiles__pending_photo_asset_id FOREIGN KEY (pending_photo_asset_id) REFERENCES provider.media_assets (media_asset_id) ON DELETE RESTRICT,
  CONSTRAINT ck_public_profiles__visibility CHECK (visibility_status IN ('PRIVATE', 'PUBLIC')),
  CONSTRAINT ck_public_profiles__revision CHECK (revision >= 1),
  CONSTRAINT ck_public_profiles__display_name CHECK (
    display_name IS NULL
    OR (length(btrim(display_name)) > 0 AND char_length(display_name) <= 100 AND display_name !~ '(^\s|\s$)' AND display_name IS NFC NORMALIZED
        AND display_name !~ '[\u0001-\u001F\u007F-\u009F\u00AD\u0600-\u0605\u061C\u06DD\u070F\u180E\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\u2800\uFEFF\uFFF9-\uFFFB]')),
  CONSTRAINT ck_public_profiles__bio CHECK (
    bio IS NULL
    OR (length(btrim(bio)) > 0 AND char_length(bio) <= 5000 AND bio !~ '(^\s|\s$)' AND bio IS NFC NORMALIZED
        AND bio !~ '[\u0001-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u0600-\u0605\u061C\u06DD\u070F\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\u2800\uFEFF\uFFF9-\uFFFB]')),
  CONSTRAINT ck_public_profiles__photo_distinct CHECK (photo_asset_id IS NULL OR pending_photo_asset_id IS NULL OR photo_asset_id <> pending_photo_asset_id),
  CONSTRAINT ck_public_profiles__lifecycle CHECK ((visibility_status = 'PUBLIC') = (published_at IS NOT NULL))
);
CREATE INDEX idx_public_profiles__photo_asset ON provider.public_profiles (photo_asset_id) WHERE photo_asset_id IS NOT NULL;
CREATE INDEX idx_public_profiles__pending_photo_asset ON provider.public_profiles (pending_photo_asset_id) WHERE pending_photo_asset_id IS NOT NULL;
COMMENT ON TABLE provider.public_profiles IS 'The PUBLIC PROFILE of a provider (PRO-002): a PRESENTATION AGGREGATE holding only what the provider authors for customers (optional display name, optional plain-text bio, one photo by reference to a READY asset, visibility) plus a revision. It is NOT a source of truth for anything else: trust badges, Gig summaries, the fallback public name (first name and last initial, from identity.account_profiles), the market and the service type names are DERIVED on every read from the domain that owns them, so nothing here can drift. One row per provider account (account_id is unique) with its own random, opaque public_profile_id, the only identifier ever exposed publicly (the account id never appears in a public payload, URL or public-path log). Visibility is PRIVATE (default; owner and preview only) or PUBLIC (the owner chose to show it): PUBLIC does NOT mean live or bookable (Go-Live is PRO-003) and a public read additionally needs, at read time, an ACTIVE account, an ACTIVE provider role, a COMPLETED registration and, when configured, marketplace eligibility. No moderation state exists yet. Never deleted or truncated. The display name and the bio are provider PLAIN TEXT: they never appear in audit rows, events, logs or error details.';
COMMENT ON COLUMN provider.public_profiles.public_profile_id IS 'The opaque public identifier of the profile (random uuid, not derived from the account or the name): the ONLY identifier customers, URLs and public payloads ever see. Immutable.';
COMMENT ON COLUMN provider.public_profiles.account_id IS 'The owner: the identity account (foreign key, restrict), taken from the authenticated request and never from a client. UNIQUE: one profile per provider account. Immutable. INTERNAL: it never appears in a public payload, URL or public-path log field. The account must be ACTIVE and have a COMPLETED provider registration when the profile is created (guard).';
COMMENT ON COLUMN provider.public_profiles.display_name IS 'The name the provider chose to show customers: provider plain text, single line, NFC, trimmed, non-blank when present, at most 100 code points (the configured limit provider.profile.display_name.max_length is lower and enforced by the service), no control, bidirectional-override or common invisible characters (structural backstop). NULL = the provider entered none: the public name is then derived on read as first name and last initial (PRD CU-02.11, "Jane D."). The legal name is never shown. Never audited, logged or put in an event.';
COMMENT ON COLUMN provider.public_profiles.bio IS 'The provider''s description of themselves and their work: provider plain text, may span lines, NFC, trimmed, non-blank when present, at most 5000 code points (the configured limit provider.profile.bio.max_length is lower and enforced by the service), no control (except line feed and tab), bidirectional-override or common invisible characters. NULL = none. Not content (CFG-002) and not moderated yet (a recorded future boundary: there is no approval flag). Never audited, logged or put in an event.';
COMMENT ON COLUMN provider.public_profiles.photo_asset_id IS 'The READY asset shown as the profile photo (provider.media_assets, restrict). The asset must be a PROFILE_PHOTO of the SAME account and READY when set (ASSET_PURPOSE, ASSET_OWNER, ASSET_NOT_USABLE). While it is referenced the asset can be neither abandoned nor deleted (ASSET_REFERENCED); the service replaces the pointer and the old asset becomes an orphan the reference-aware clean-up removes. Never the object key, a URL or a hash. Public delivery is through the API as sanitised bytes, never the stored object.';
COMMENT ON COLUMN provider.public_profiles.pending_photo_asset_id IS 'At most ONE unfinished profile photo upload: an UPLOAD_PENDING PROFILE_PHOTO asset of the same account. A new authorization abandons the previous pending upload (the service clears this pointer first: a referenced asset cannot be abandoned). Different from photo_asset_id (CHECK). Cleared when the upload is finalized (it becomes photo_asset_id) or expires.';
COMMENT ON COLUMN provider.public_profiles.visibility_status IS 'PRIVATE (initial; owner and preview only) or PUBLIC (the owner chose to show it). Owner-controlled in both directions; the service requires the configured prerequisites (bio / photo) to set PUBLIC. There is no SUSPENDED or HIDDEN state until moderation exists.';
COMMENT ON COLUMN provider.public_profiles.revision IS 'Optimistic concurrency token: starts at 1 and rises by exactly one with every effective change of display name, bio, photo or visibility (REVISION guard); a change of only the pending upload pointer may keep or raise it; a no-op update keeps it. Every mutation names the revision it read (a stale one is refused by the service).';
COMMENT ON COLUMN provider.public_profiles.published_at IS 'The time of the latest PRIVATE -> PUBLIC change, maintained by the guard; NULL exactly while the profile is PRIVATE (ck_public_profiles__lifecycle).';
-- Index justification (DATA_MODEL_GUARDRAILS rule 11). Besides the primary key and the unique constraint:
--   pk_public_profiles (public_profile_id): THE public lookup (GET /providers/{publicProfileId}), one row by opaque id.
--   uq_public_profiles__account (account_id): the one-profile-per-account rule, THE owner lookup (every owner read and mutation filters by account) and the support of the foreign key to the account (its leading column).
--   idx_public_profiles__photo_asset (photo_asset_id) WHERE photo_asset_id IS NOT NULL and idx_public_profiles__pending_photo_asset (pending_photo_asset_id) WHERE pending_photo_asset_id IS NOT NULL: the support of the two foreign keys to the asset AND the reference lookups of the asset guard (is this asset a profile photo or a pending upload?), the reference-aware orphan sweep and the expired-pending sweep. Partial: most profiles have no pending upload and many no photo, so the indexes stay small; the lookups are equalities, which imply NOT NULL.
--   NOT created: a partial index on visibility_status = 'PUBLIC'. Nothing lists, searches or counts public profiles yet (SEARCH and PRO-003 come later); the one public read is by primary key. A listing index gets its own review when that query exists.

-- =====================================================================================================================
-- 3. provider.profile_audit_events (immutable audit)
-- =====================================================================================================================
CREATE TABLE provider.profile_audit_events (
  audit_event_id    uuid        NOT NULL DEFAULT gen_random_uuid(),
  occurred_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor             text        NOT NULL,
  account_id        uuid        NOT NULL,
  public_profile_id uuid        NOT NULL,
  action            text        NOT NULL,
  changes           jsonb,
  correlation_id    text        NOT NULL,
  CONSTRAINT pk_profile_audit_events PRIMARY KEY (audit_event_id),
  CONSTRAINT fk_profile_audit_events__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_profile_audit_events__public_profile_id FOREIGN KEY (public_profile_id) REFERENCES provider.public_profiles (public_profile_id) ON DELETE RESTRICT,
  CONSTRAINT ck_profile_audit_events__action CHECK (action IN ('PROVIDER_PUBLIC_PROFILE_CREATED', 'PROVIDER_PUBLIC_PROFILE_UPDATED', 'PROVIDER_PROFILE_PHOTO_CHANGED', 'PROVIDER_PROFILE_VISIBILITY_CHANGED')),
  CONSTRAINT ck_profile_audit_events__changes_object CHECK (changes IS NULL OR (jsonb_typeof(changes) = 'object' AND length(changes::text) <= 2000)),
  CONSTRAINT ck_profile_audit_events__actor CHECK (length(btrim(actor)) > 0 AND length(actor) <= 200)
);
CREATE INDEX idx_profile_audit_events__profile ON provider.profile_audit_events (public_profile_id, occurred_at);
COMMENT ON TABLE provider.profile_audit_events IS 'Append-only audit trail of the public profiles (PRO-002): who (account:<id> or system:<name>, never a token), what (PROVIDER_PUBLIC_PROFILE_CREATED, PROVIDER_PUBLIC_PROFILE_UPDATED, PROVIDER_PROFILE_PHOTO_CHANGED, PROVIDER_PROFILE_VISIBILITY_CHANGED), when, the owning account and profile, a small JSON object of field NAMES, the revision and the visibility (at most 2000 characters; NEVER the display name, the bio, an asset id, an object key, a hash or a URL) and the correlation id. Reads (including every public read) are never audited. Rows are immutable and never truncated. The account of a row must own the profile (guard). The account column is the owner at the time of the event, kept so the trail can be read per account without a join.';
COMMENT ON COLUMN provider.profile_audit_events.changes IS 'A JSON object of identifiers only: the NAMES of the changed fields, the revision and the visibility. Never provider text and never an asset reference. At most 2000 characters (ck_profile_audit_events__changes_object).';
-- Index justification (DATA_MODEL_GUARDRAILS rule 11):
--   idx_profile_audit_events__profile (public_profile_id, occurred_at): the history of ONE profile in time order and the support of the foreign key to the profile (its leading column).
-- Foreign key deliberately WITHOUT a supporting index: profile_audit_events.account_id (the account is never deleted, the trail is read per profile, and the owner lookup of an account goes through uq_public_profiles__account).

-- =====================================================================================================================
-- 4. guards (all failures are SQLSTATE 23000 with DETAIL provider_rule:<KEY>)
--    Lock order: ACCOUNT (the service locks it FOR UPDATE first), then the PROFILE, then the ASSET (never the asset first). The profile guard takes the asset row FOR SHARE (after the profile row it is already updating); the asset guard holds the asset row lock and only READS the profile pointers without a lock, so no cycle exists.
-- =====================================================================================================================

-- ------------------------------------------------------------------ the asset behind a profile pointer
CREATE FUNCTION provider.assert_profile_photo_asset(p_account_id uuid, p_asset_id uuid, p_required_status text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  a_account uuid;
  a_status  text;
  a_purpose text;
BEGIN
  -- FOR SHARE: a concurrent abandon or delete of the asset waits for this transaction, and the asset guard then finds the reference
  SELECT account_id, status, purpose INTO a_account, a_status, a_purpose FROM provider.media_assets WHERE media_asset_id = p_asset_id FOR SHARE;
  IF a_account IS NULL THEN
    RETURN; -- the foreign key reports the missing asset
  END IF;
  IF a_account <> p_account_id THEN
    RAISE EXCEPTION 'the asset belongs to another account' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ASSET_OWNER';
  END IF;
  IF a_purpose <> 'PROFILE_PHOTO' THEN
    RAISE EXCEPTION 'only a PROFILE_PHOTO asset can be a profile photo' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ASSET_PURPOSE';
  END IF;
  IF a_status <> p_required_status THEN
    RAISE EXCEPTION 'the asset is not in the state this profile pointer needs' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ASSET_NOT_USABLE';
  END IF;
END;
$$;
COMMENT ON FUNCTION provider.assert_profile_photo_asset(uuid, uuid, text) IS 'Helper of the profile guard: the asset (taken FOR SHARE, so a concurrent abandon or delete serializes) belongs to the profile''s account (ASSET_OWNER), has the purpose PROFILE_PHOTO (ASSET_PURPOSE) and is in the status the pointer needs: READY for photo_asset_id, UPLOAD_PENDING for pending_photo_asset_id (ASSET_NOT_USABLE). A missing asset is left to the foreign key.';

-- ----------------------------------------------------------------------------------------------- profiles
CREATE FUNCTION provider.guard_public_profiles() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a_status       text;
  v_registration uuid;
  v_content      boolean;
  v_pending      boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a public profile is never deleted: set it PRIVATE' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:NO_DELETE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.visibility_status <> 'PRIVATE' OR NEW.revision <> 1 OR NEW.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'a public profile starts PRIVATE at revision 1' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:MUST_START_PRIVATE';
    END IF;
    SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id FOR SHARE;
    IF a_status IS NULL THEN
      RETURN NEW; -- the foreign key reports the missing account
    END IF;
    IF a_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'only an ACTIVE account can create a public profile' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ACCOUNT_NOT_ACTIVE';
    END IF;
    SELECT provider_registration_id INTO v_registration FROM provider.registrations WHERE account_id = NEW.account_id AND status = 'COMPLETED';
    IF v_registration IS NULL THEN
      RAISE EXCEPTION 'a public profile needs a COMPLETED provider registration' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:PROVIDER_NOT_ELIGIBLE';
    END IF;
    IF NEW.photo_asset_id IS NOT NULL THEN
      PERFORM provider.assert_profile_photo_asset(NEW.account_id, NEW.photo_asset_id, 'READY');
    END IF;
    IF NEW.pending_photo_asset_id IS NOT NULL THEN
      PERFORM provider.assert_profile_photo_asset(NEW.account_id, NEW.pending_photo_asset_id, 'UPLOAD_PENDING');
    END IF;
    NEW.published_at := NULL;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE
  IF (NEW.public_profile_id, NEW.account_id, NEW.created_at) IS DISTINCT FROM (OLD.public_profile_id, OLD.account_id, OLD.created_at) THEN
    RAISE EXCEPTION 'the public id, the owner and the creation time of a profile are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:IMMUTABLE_IDENTITY';
  END IF;
  v_content := (NEW.display_name, NEW.bio, NEW.photo_asset_id, NEW.visibility_status) IS DISTINCT FROM (OLD.display_name, OLD.bio, OLD.photo_asset_id, OLD.visibility_status);
  v_pending := NEW.pending_photo_asset_id IS DISTINCT FROM OLD.pending_photo_asset_id;
  IF v_content THEN
    IF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'a change of the name, the bio, the photo or the visibility raises the revision by exactly one' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:REVISION';
    END IF;
  ELSIF v_pending THEN
    IF NEW.revision NOT IN (OLD.revision, OLD.revision + 1) THEN
      RAISE EXCEPTION 'a change of the pending upload alone keeps the revision or raises it by one' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:REVISION';
    END IF;
  ELSIF NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION 'an update that changes nothing keeps the revision' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:REVISION';
  END IF;
  -- the asset behind a pointer is checked when the pointer is set to a different asset (the profile row is already locked by this statement; the asset follows)
  IF NEW.photo_asset_id IS NOT NULL AND NEW.photo_asset_id IS DISTINCT FROM OLD.photo_asset_id THEN
    PERFORM provider.assert_profile_photo_asset(NEW.account_id, NEW.photo_asset_id, 'READY');
  END IF;
  IF NEW.pending_photo_asset_id IS NOT NULL AND v_pending THEN
    PERFORM provider.assert_profile_photo_asset(NEW.account_id, NEW.pending_photo_asset_id, 'UPLOAD_PENDING');
  END IF;
  -- published_at is maintained here and never accepted from a caller
  IF NEW.visibility_status = 'PUBLIC' THEN
    IF OLD.visibility_status = 'PUBLIC' THEN
      NEW.published_at := OLD.published_at;
    ELSE
      NEW.published_at := now();
    END IF;
  ELSE
    NEW.published_at := NULL;
  END IF;
  IF v_content OR v_pending OR NEW.revision <> OLD.revision THEN
    NEW.updated_at := now();
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_public_profiles__guard BEFORE INSERT OR UPDATE OR DELETE ON provider.public_profiles FOR EACH ROW EXECUTE FUNCTION provider.guard_public_profiles();
CREATE TRIGGER trg_public_profiles__no_truncate BEFORE TRUNCATE ON provider.public_profiles FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation();
COMMENT ON FUNCTION provider.guard_public_profiles() IS 'Profile guard: created PRIVATE at revision 1 for an ACTIVE account (read FOR SHARE) with a COMPLETED provider registration; never deleted; the public id, the owner and the creation time immutable; the revision rises by exactly one with a change of the display name, bio, photo or visibility, may keep or raise by one when only the pending upload pointer changes, and never moves on a no-op update; a photo pointer set to a different asset is checked by provider.assert_profile_photo_asset (READY for the photo, UPLOAD_PENDING for the pending upload, PROFILE_PHOTO, same account); published_at and updated_at are maintained (published_at = time of the latest PRIVATE -> PUBLIC change, NULL while PRIVATE) (NO_DELETE, MUST_START_PRIVATE, ACCOUNT_NOT_ACTIVE, PROVIDER_NOT_ELIGIBLE, IMMUTABLE_IDENTITY, REVISION, ASSET_OWNER, ASSET_PURPOSE, ASSET_NOT_USABLE). Whether a PUBLIC profile is served is decided at read time, not here.';

-- ------------------------------------------------------------------------------------------------- audit
CREATE FUNCTION provider.guard_profile_audit_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p_account uuid;
BEGIN
  SELECT account_id INTO p_account FROM provider.public_profiles WHERE public_profile_id = NEW.public_profile_id;
  IF p_account IS NOT NULL AND p_account <> NEW.account_id THEN
    RAISE EXCEPTION 'the audit row names an account that does not own the profile' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:AUDIT_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_profile_audit_events__guard BEFORE INSERT ON provider.profile_audit_events FOR EACH ROW EXECUTE FUNCTION provider.guard_profile_audit_events();
CREATE TRIGGER trg_profile_audit_events__immutable BEFORE UPDATE OR DELETE ON provider.profile_audit_events FOR EACH ROW EXECUTE FUNCTION provider.forbid_mutation();
CREATE TRIGGER trg_profile_audit_events__no_truncate BEFORE TRUNCATE ON provider.profile_audit_events FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation();
COMMENT ON FUNCTION provider.guard_profile_audit_events() IS 'Audit insert guard: the account of the row owns the profile whose id it names (AUDIT_MISMATCH); a missing profile is left to the foreign key. The row is checked only at INSERT, because UPDATE, DELETE and TRUNCATE of the trail are refused outright by provider.forbid_mutation (ROW_IMMUTABLE), so the trail cannot be rewritten to disagree with the profile later.';

-- =====================================================================================================================
-- 5. the asset guard (the body of 0022) now also freezes the purpose and counts the references of a profile
--    DELETED: refused while ANY attachment or ANY profile pointer references the asset. ABANDONED: refused while an attachment of a version that is not RETIRED or ANY profile pointer does
--    (a profile reference never becomes history: the service clears the pointer first). The references are READ without a lock; the asset row lock held by this statement serializes with the FOR SHARE of the profile and attachment guards.
-- =====================================================================================================================
CREATE OR REPLACE FUNCTION provider.guard_media_assets() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a_status   text;
  v_one_way  boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a media asset is never deleted: its bytes are removed and it is marked DELETED' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:NO_DELETE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'UPLOAD_PENDING' OR NEW.ready_at IS NOT NULL THEN
      RAISE EXCEPTION 'an asset starts as UPLOAD_PENDING' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:MUST_START_PENDING';
    END IF;
    SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id FOR SHARE;
    IF a_status IS NULL THEN
      RETURN NEW; -- the foreign key reports the missing account
    END IF;
    IF a_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'only an ACTIVE account can upload a photo' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ACCOUNT_NOT_ACTIVE';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF (NEW.media_asset_id, NEW.account_id, NEW.object_key, NEW.mime_type, NEW.size_bytes, NEW.upload_expires_at, NEW.created_at, NEW.purpose)
     IS DISTINCT FROM (OLD.media_asset_id, OLD.account_id, OLD.object_key, OLD.mime_type, OLD.size_bytes, OLD.upload_expires_at, OLD.created_at, OLD.purpose) THEN
    RAISE EXCEPTION 'the id, the owner, the key, the type, the size, the purpose, the authorization window and the creation time of an asset are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:IMMUTABLE_IDENTITY';
  END IF;
  -- the two removal markers only go from NULL to a timestamp
  v_one_way := (OLD.objects_removed_at IS NOT NULL AND NEW.objects_removed_at IS DISTINCT FROM OLD.objects_removed_at)
            OR (OLD.upload_key_removed_at IS NOT NULL AND NEW.upload_key_removed_at IS DISTINCT FROM OLD.upload_key_removed_at);
  IF v_one_way THEN
    RAISE EXCEPTION 'a removal marker is set once and never cleared or moved' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:MARKER_ONE_WAY';
  END IF;
  IF OLD.status IN ('ABANDONED', 'DELETED') THEN
    -- frozen, except that the removal markers can still be set
    IF (to_jsonb(NEW) - ARRAY['updated_at', 'objects_removed_at', 'upload_key_removed_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at', 'objects_removed_at', 'upload_key_removed_at']) THEN
      RAISE EXCEPTION 'an abandoned or deleted asset is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ASSET_FROZEN';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status = 'READY' AND (NEW.sha256, NEW.width, NEW.height, NEW.scan_status, NEW.ready_at) IS DISTINCT FROM (OLD.sha256, OLD.width, OLD.height, OLD.scan_status, OLD.ready_at) THEN
      RAISE EXCEPTION 'the bytes facts of a READY asset are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:BYTES_IMMUTABLE';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'UPLOAD_PENDING' AND NEW.status IN ('READY', 'ABANDONED')) OR (OLD.status = 'READY' AND NEW.status = 'DELETED')) THEN
    RAISE EXCEPTION 'the asset status transition is not allowed' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:STATUS_TRANSITION';
  END IF;
  IF OLD.status = 'READY' AND (NEW.sha256, NEW.width, NEW.height, NEW.scan_status, NEW.ready_at) IS DISTINCT FROM (OLD.sha256, OLD.width, OLD.height, OLD.scan_status, OLD.ready_at) THEN
    RAISE EXCEPTION 'the bytes facts of a READY asset are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:BYTES_IMMUTABLE';
  END IF;
  -- this statement holds the row lock of the asset (the row is locked before a BEFORE UPDATE trigger runs), and an attacher or a profile holds it FOR SHARE until it commits, so the checks below see every committed reference
  IF NEW.status = 'DELETED' AND (
       EXISTS (SELECT 1 FROM provider.gig_version_media WHERE media_asset_id = OLD.media_asset_id)
       OR EXISTS (SELECT 1 FROM provider.public_profiles WHERE photo_asset_id = OLD.media_asset_id)
       OR EXISTS (SELECT 1 FROM provider.public_profiles WHERE pending_photo_asset_id = OLD.media_asset_id)) THEN
    RAISE EXCEPTION 'an asset that an attachment or a profile references is never deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ASSET_REFERENCED';
  END IF;
  -- an unfinished upload can be abandoned when every attachment that references it belongs to a RETIRED version (the Gig was retired with the draft); a version in any other status still holds it, and a profile pointer always does
  IF NEW.status = 'ABANDONED' AND (
       EXISTS (SELECT 1 FROM provider.gig_version_media m JOIN provider.gig_versions v ON v.gig_version_id = m.gig_version_id
                WHERE m.media_asset_id = OLD.media_asset_id AND v.status <> 'RETIRED')
       OR EXISTS (SELECT 1 FROM provider.public_profiles WHERE photo_asset_id = OLD.media_asset_id)
       OR EXISTS (SELECT 1 FROM provider.public_profiles WHERE pending_photo_asset_id = OLD.media_asset_id)) THEN
    RAISE EXCEPTION 'an asset that an attachment of a version that is not RETIRED or a profile references is not abandoned' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ASSET_REFERENCED';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION provider.guard_media_assets() IS 'Asset guard: created UPLOAD_PENDING for an ACTIVE account (read FOR SHARE); never deleted; id, owner, key, type, size, PURPOSE, authorization window and creation time immutable; UPLOAD_PENDING -> READY | ABANDONED and READY -> DELETED only; ABANDONED and DELETED frozen except for the two one-way removal markers objects_removed_at and upload_key_removed_at (set once, never cleared or moved); the bytes facts of a READY asset immutable; DELETED is refused while ANY attachment or ANY profile pointer (photo_asset_id, pending_photo_asset_id) references the asset, and ABANDONED while an attachment of a version that is not RETIRED or any profile pointer does (NO_DELETE, MUST_START_PENDING, ACCOUNT_NOT_ACTIVE, IMMUTABLE_IDENTITY, MARKER_ONE_WAY, ASSET_FROZEN, BYTES_IMMUTABLE, STATUS_TRANSITION, ASSET_REFERENCED). The attachment and profile guards take the asset row FOR SHARE and the UPDATE here holds its row lock, so an attach / pointer change and a sweep cannot race; this guard only READS the references (lock order account, profile or version, asset).';

-- =====================================================================================================================
-- 6. the attachment guard (the body of 0021) now refuses a PROFILE_PHOTO asset as a Gig photo
-- =====================================================================================================================
CREATE OR REPLACE FUNCTION provider.guard_gig_version_media() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_version    uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.gig_version_id ELSE NEW.gig_version_id END;
  v_status     text;
  v_tv         uuid;
  v_gig        uuid;
  v_account    uuid;
  f_tv         uuid;
  f_type       text;
  f_max        integer;
  a_account    uuid;
  a_status     text;
  a_purpose    text;
  v_count      integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.gig_version_media_id, NEW.gig_version_id, NEW.media_asset_id, NEW.gig_template_field_id, NEW.created_at)
       IS DISTINCT FROM (OLD.gig_version_media_id, OLD.gig_version_id, OLD.media_asset_id, OLD.gig_template_field_id, OLD.created_at) THEN
      RAISE EXCEPTION 'the id, the version, the asset, the field and the creation time of an attachment are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:IMMUTABLE_IDENTITY';
    END IF;
  END IF;
  -- FOR NO KEY UPDATE: two concurrent attachments of the same version serialize here, so the per-field maximum cannot be exceeded; it also keeps a concurrent publication behind the change
  SELECT status, gig_template_version_id, gig_id INTO v_status, v_tv, v_gig FROM provider.gig_versions WHERE gig_version_id = v_version FOR NO KEY UPDATE;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    IF v_status IS NULL AND TG_OP = 'INSERT' THEN
      RETURN NEW; -- the foreign key reports the missing version
    END IF;
    RAISE EXCEPTION 'the photos of a Gig version change only while it is a DRAFT' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:VERSION_FROZEN';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  -- INSERT: the field belongs to the bound template version, is a MEDIA field and does not prohibit photos (frozen catalogue facts, read without a lock)
  SELECT gig_template_version_id, field_type, max_items INTO f_tv, f_type, f_max FROM catalog.gig_template_fields WHERE gig_template_field_id = NEW.gig_template_field_id;
  IF f_tv IS NULL THEN
    RETURN NEW; -- the foreign key reports the missing field
  END IF;
  IF f_tv <> v_tv THEN
    RAISE EXCEPTION 'the field does not belong to the template version of the Gig version' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:FIELD_NOT_IN_TEMPLATE_VERSION';
  END IF;
  IF f_type <> 'MEDIA' THEN
    RAISE EXCEPTION 'a photo attaches to a MEDIA field only' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:FIELD_TYPE_MISMATCH';
  END IF;
  IF f_max IS NOT NULL AND f_max = 0 THEN
    RAISE EXCEPTION 'this MEDIA field prohibits photos (max_items = 0)' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:MEDIA_PROHIBITED';
  END IF;
  -- the asset belongs to the account of the Gig, is a Gig photo and is still usable; FOR SHARE keeps the clean-up from deleting it before this transaction commits
  SELECT account_id INTO v_account FROM provider.gigs WHERE gig_id = v_gig;
  SELECT account_id, status, purpose INTO a_account, a_status, a_purpose FROM provider.media_assets WHERE media_asset_id = NEW.media_asset_id FOR SHARE;
  IF a_account IS NULL THEN
    RETURN NEW; -- the foreign key reports the missing asset
  END IF;
  IF a_account <> v_account THEN
    RAISE EXCEPTION 'the asset belongs to another account' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ASSET_OWNER';
  END IF;
  IF a_purpose <> 'GIG_PHOTO' THEN
    RAISE EXCEPTION 'only a GIG_PHOTO asset can be attached to a Gig version' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ASSET_PURPOSE';
  END IF;
  IF a_status NOT IN ('UPLOAD_PENDING', 'READY') THEN
    RAISE EXCEPTION 'the asset is not usable (abandoned or deleted)' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ASSET_NOT_USABLE';
  END IF;
  IF f_max IS NOT NULL THEN
    SELECT count(*)::integer INTO v_count FROM provider.gig_version_media WHERE gig_version_id = NEW.gig_version_id AND gig_template_field_id = NEW.gig_template_field_id;
    IF v_count >= f_max THEN
      RAISE EXCEPTION 'the MEDIA field already holds its maximum number of photos' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:MEDIA_FIELD_FULL';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION provider.guard_gig_version_media() IS 'Attachment guard: rows change (insert, update, delete) only while the parent version is a DRAFT (the version row is taken FOR NO KEY UPDATE, so concurrent attachments of one version serialize and a concurrent publication waits); id, version, asset, field and creation time immutable; on insert the field belongs to the version''s bound template version, is a MEDIA field and does not prohibit photos, the asset (taken FOR SHARE) belongs to the Gig''s account, has the purpose GIG_PHOTO (a PROFILE_PHOTO asset is refused since 0024) and is UPLOAD_PENDING or READY, and the field is below its max_items (VERSION_FROZEN, IMMUTABLE_IDENTITY, FIELD_NOT_IN_TEMPLATE_VERSION, FIELD_TYPE_MISMATCH, MEDIA_PROHIBITED, ASSET_OWNER, ASSET_PURPOSE, ASSET_NOT_USABLE, MEDIA_FIELD_FULL). Catalogue facts are read without locks (frozen structure). Minimums are checked at publication.';

-- =====================================================================================================================
-- 7. seed: the profile policy (CFG-001), through the real configuration lifecycle
--    Typed values at PLATFORM scope, read fresh by the service, no code default (a missing or invalid value fails closed). The bounds mirror the structural ceilings of the contract and of the CHECK constraints above (100, 5000, 26214400).
--    CRITICAL: the badge list and the eligibility gate decide what the public sees and must never be served stale; the other five are STANDARD. EVERY value is a PRO-002 ENGINEERING / PRODUCT ASSUMPTION (the PRD gives none); see the header.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_approver    constant text := 'system:migration-review';
  v_correlation constant text := 'seed-0024';
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
      (1, 'provider.profile.display_name.max_length', 'INTEGER', 'characters', 'Maximum length of a provider display name, in characters (Unicode code points)', '{"min": 1, "max": 100}'::jsonb,
          '60'::jsonb, 'STANDARD', 'PRO-002 assumption, not in the PRD (structural ceiling 100)'),
      (2, 'provider.profile.bio.max_length', 'INTEGER', 'characters', 'Maximum length of a provider bio, in characters (Unicode code points)', '{"min": 1, "max": 5000}'::jsonb,
          '1000'::jsonb, 'STANDARD', 'PRO-002 assumption, not in the PRD (structural ceiling 5000)'),
      (3, 'provider.profile.bio.required', 'BOOLEAN', NULL::text, 'Whether a bio is required before a profile can be made public', '{}'::jsonb,
          'false'::jsonb, 'STANDARD', 'PRO-002 assumption: a bio is not required (owner decision pending, debt)'),
      (4, 'provider.profile.photo.required', 'BOOLEAN', NULL::text, 'Whether a profile photo is required before a profile can be made public', '{}'::jsonb,
          'false'::jsonb, 'STANDARD', 'PRO-002 assumption: a photo is not required (owner decision pending, debt)'),
      (5, 'provider.profile.photo.max_file_size_bytes', 'INTEGER', 'bytes', 'Maximum size of one uploaded profile photo, in bytes (the whole file is read into memory to be verified and again on every public request, so it is lower than the Gig photo limit)', '{"min": 1, "max": 26214400}'::jsonb,
          '2097152'::jsonb, 'STANDARD', 'PRO-002 assumption, not in the PRD (2 MiB)'),
      (6, 'provider.profile.public_badge_types', 'JSON', NULL::text, 'Trust requirement types a customer may see as a badge on a public profile: a list of requirement types (a listed type still needs an APPROVED, current requirement of that type; an empty list shows no badge)',
          '{"schema": {"type": "array", "items": {"type": "string", "enum": ["IDENTITY", "BACKGROUND_CHECK", "LICENSE", "INSURANCE", "CERTIFICATION", "BUSINESS_REGISTRATION", "OTHER_DOCUMENT"]}, "uniqueItems": true, "minItems": 0, "maxItems": 7}}'::jsonb,
          '["IDENTITY", "BACKGROUND_CHECK", "INSURANCE"]'::jsonb, 'CRITICAL', 'PRO-002 assumption: identity, background check and insurance are customer-appropriate badges; the other types are off until the owner decides (debt)'),
      (7, 'provider.profile.public_requires_marketplace_eligibility', 'BOOLEAN', NULL::text, 'Whether a public profile is served only for a provider the marketplace-eligibility port approves (Go-Live, PRO-003). With true and no port wired, a public read fails closed', '{}'::jsonb,
          'false'::jsonb, 'CRITICAL', 'PRO-002 assumption: off until PRO-003 (Go-Live) exists; flip it when that checkpoint wires the port (debt)')
    ) AS t (ord, key, data_type, unit, description, rules, value, criticality, basis)
    ORDER BY ord
  LOOP
    v_reason := 'Initial value (migration 0024): ' || v_seed.basis;
    INSERT INTO configuration.parameters (key, data_type, unit, description, owner_role, validation_rules, sensitivity, approval_policy, criticality, is_required, created_by)
    VALUES (v_seed.key, v_seed.data_type, v_seed.unit, v_seed.description, 'platform', v_seed.rules, 'INTERNAL', 'SECOND_APPROVER', v_seed.criticality, true, v_actor)
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
    VALUES (v_request, v_approver, 'APPROVE', 'Initial value reviewed with the migration (PRO-002)');
    UPDATE configuration.change_requests SET state = 'APPROVED', updated_at = now() WHERE change_request_id = v_request AND state = 'PENDING_APPROVAL';
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, change_request_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_approver, 'CHANGE_APPROVED', v_parameter, v_request, 'Initial value reviewed with the migration (PRO-002)', v_correlation);

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
-- 8. seed: the copy of the public profile flow (CFG-002), through the real content lifecycle (en-US only)
--    One message per visibility (2), per error code (12), per issue reason (11), per trust requirement type badge (7), the UI keys of the TEMPORARY minimal profile pages and three empty-state words.
--    NO LEGAL TEXT and NO provider text. No variables (limits and counts are rendered next to the words by the page), no personal data, no numbers. Photo refusal reasons REUSE provider.gig.media.refused.* (0023).
--    Wording rule: say what the platform did and no more (a badge is "checked" / "completed" / "on file", never "guaranteed"); the base price is the price with no variant selected, not "from" the cheapest.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0024';
  v_reason      constant text := 'Initial provider public profile copy (migration 0024)';
  v_seed        record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1, 'UI_LABEL', 'provider.profile.visibility.private', 'Profile copy: visibility.private', 'Private'),
      (2, 'UI_LABEL', 'provider.profile.visibility.public', 'Profile copy: visibility.public', 'Public'),
      (3, 'PLAIN_TEXT', 'provider.profile.error.profile_not_found', 'Profile copy: error.profile_not_found', 'We could not find that profile.'),
      (4, 'PLAIN_TEXT', 'provider.profile.error.provider_not_eligible', 'Profile copy: error.provider_not_eligible', 'Finish your provider registration before you set up a public profile.'),
      (5, 'PLAIN_TEXT', 'provider.profile.error.account_not_active', 'Profile copy: error.account_not_active', 'Your account is not active, so your profile cannot be changed right now.'),
      (6, 'PLAIN_TEXT', 'provider.profile.error.stale_profile', 'Profile copy: error.stale_profile', 'Your profile changed since you opened it. Reload the page and try again.'),
      (7, 'PLAIN_TEXT', 'provider.profile.error.profile_incomplete', 'Profile copy: error.profile_incomplete', 'Your profile is missing something it needs before it can be public. See the checklist on this page.'),
      (8, 'PLAIN_TEXT', 'provider.profile.error.validation_failed', 'Profile copy: error.validation_failed', 'Some details could not be saved. Check the messages next to each field.'),
      (9, 'PLAIN_TEXT', 'provider.profile.error.conflict', 'Profile copy: error.conflict', 'That could not be done because something changed at the same time. Try again.'),
      (10, 'PLAIN_TEXT', 'provider.profile.error.unavailable', 'Profile copy: error.unavailable', 'Profiles are not available right now. Try again in a moment.'),
      (11, 'PLAIN_TEXT', 'provider.profile.error.media_not_found', 'Profile copy: error.media_not_found', 'We could not find that photo.'),
      (12, 'PLAIN_TEXT', 'provider.profile.error.media_refused', 'Profile copy: error.media_refused', 'That file cannot be used. Check its type and size and try another file.'),
      (13, 'PLAIN_TEXT', 'provider.profile.error.media_expired', 'Profile copy: error.media_expired', 'The upload window has closed. Start the upload again.'),
      (14, 'PLAIN_TEXT', 'provider.profile.error.media_scan_unavailable', 'Profile copy: error.media_scan_unavailable', 'We could not check the file just now. Try again in a moment.'),
      (15, 'PLAIN_TEXT', 'provider.profile.issue.display_name_too_long', 'Profile copy: issue.display_name_too_long', 'The display name is too long.'),
      (16, 'PLAIN_TEXT', 'provider.profile.issue.display_name_blank', 'Profile copy: issue.display_name_blank', 'Enter a display name, or leave it empty to use your first name and last initial.'),
      (17, 'PLAIN_TEXT', 'provider.profile.issue.display_name_forbidden_character', 'Profile copy: issue.display_name_forbidden_character', 'The display name contains a character that is not allowed.'),
      (18, 'PLAIN_TEXT', 'provider.profile.issue.display_name_html_not_allowed', 'Profile copy: issue.display_name_html_not_allowed', 'The display name cannot contain markup. Use plain text.'),
      (19, 'PLAIN_TEXT', 'provider.profile.issue.bio_too_long', 'Profile copy: issue.bio_too_long', 'The description is too long.'),
      (20, 'PLAIN_TEXT', 'provider.profile.issue.bio_blank', 'Profile copy: issue.bio_blank', 'Write a description, or leave it empty.'),
      (21, 'PLAIN_TEXT', 'provider.profile.issue.bio_forbidden_character', 'Profile copy: issue.bio_forbidden_character', 'The description contains a character that is not allowed.'),
      (22, 'PLAIN_TEXT', 'provider.profile.issue.bio_html_not_allowed', 'Profile copy: issue.bio_html_not_allowed', 'The description cannot contain markup. Use plain text.'),
      (23, 'PLAIN_TEXT', 'provider.profile.issue.bio_required', 'Profile copy: issue.bio_required', 'Add a short description of yourself and your work.'),
      (24, 'PLAIN_TEXT', 'provider.profile.issue.photo_required', 'Profile copy: issue.photo_required', 'Add a profile photo.'),
      (25, 'PLAIN_TEXT', 'provider.profile.issue.public_name_unavailable', 'Profile copy: issue.public_name_unavailable', 'We have no name to show yet. Add a display name.'),
      (26, 'UI_LABEL', 'provider.profile.badge.identity', 'Profile copy: badge.identity', 'Identity checked'),
      (27, 'UI_LABEL', 'provider.profile.badge.background_check', 'Profile copy: badge.background_check', 'Background check completed'),
      (28, 'UI_LABEL', 'provider.profile.badge.license', 'Profile copy: badge.license', 'License on file'),
      (29, 'UI_LABEL', 'provider.profile.badge.insurance', 'Profile copy: badge.insurance', 'Insurance on file'),
      (30, 'UI_LABEL', 'provider.profile.badge.certification', 'Profile copy: badge.certification', 'Certification on file'),
      (31, 'UI_LABEL', 'provider.profile.badge.business_registration', 'Profile copy: badge.business_registration', 'Business registration on file'),
      (32, 'UI_LABEL', 'provider.profile.badge.other_document', 'Profile copy: badge.other_document', 'Additional document on file'),
      (33, 'UI_LABEL', 'provider.profile.page.title', 'Profile copy: page.title', 'Public profile'),
      (34, 'PLAIN_TEXT', 'provider.profile.page.intro', 'Profile copy: page.intro', 'This is what customers see when you choose to show your profile. You decide what to share.'),
      (35, 'UI_LABEL', 'provider.profile.name.label', 'Profile copy: name.label', 'Display name'),
      (36, 'PLAIN_TEXT', 'provider.profile.name.hint', 'Profile copy: name.hint', 'Shown to customers. Leave it empty to use your first name and last initial.'),
      (37, 'PLAIN_TEXT', 'provider.profile.name.fallback_note', 'Profile copy: name.fallback_note', 'Without a display name, customers see your first name and the first letter of your last name.'),
      (38, 'UI_LABEL', 'provider.profile.bio.label', 'Profile copy: bio.label', 'About you'),
      (39, 'PLAIN_TEXT', 'provider.profile.bio.hint', 'Profile copy: bio.hint', 'Tell customers about yourself and your work. Plain text only. The limit is shown next to the box.'),
      (40, 'UI_LABEL', 'provider.profile.photo.heading', 'Profile copy: photo.heading', 'Profile photo'),
      (41, 'PLAIN_TEXT', 'provider.profile.photo.hint', 'Profile copy: photo.hint', 'Choose a clear photo of yourself or your work. Details such as where a photo was taken are removed before customers see it. The accepted types and the largest size are shown next to the form.'),
      (42, 'UI_LABEL', 'provider.profile.photo.upload', 'Profile copy: photo.upload', 'Upload photo'),
      (43, 'UI_LABEL', 'provider.profile.photo.remove', 'Profile copy: photo.remove', 'Remove photo'),
      (44, 'PLAIN_TEXT', 'provider.profile.photo.none', 'Profile copy: photo.none', 'No photo yet.'),
      (45, 'UI_LABEL', 'provider.profile.visibility.heading', 'Profile copy: visibility.heading', 'Visibility'),
      (46, 'PLAIN_TEXT', 'provider.profile.visibility.private_note', 'Profile copy: visibility.private_note', 'Your profile is private. Only you can see it.'),
      (47, 'PLAIN_TEXT', 'provider.profile.visibility.public_note', 'Profile copy: visibility.public_note', 'Your profile is public. Anyone with its link can see it.'),
      (48, 'UI_LABEL', 'provider.profile.visibility.make_public', 'Profile copy: visibility.make_public', 'Make profile public'),
      (49, 'UI_LABEL', 'provider.profile.visibility.make_private', 'Profile copy: visibility.make_private', 'Make profile private'),
      (50, 'PLAIN_TEXT', 'provider.profile.visibility.not_live_note', 'Profile copy: visibility.not_live_note', 'A public profile does not make you live or bookable.'),
      (51, 'UI_LABEL', 'provider.profile.readiness.heading', 'Profile copy: readiness.heading', 'Your checklist'),
      (52, 'UI_LABEL', 'provider.profile.readiness.name', 'Profile copy: readiness.name', 'A name customers can see'),
      (53, 'UI_LABEL', 'provider.profile.readiness.bio', 'Profile copy: readiness.bio', 'A short description'),
      (54, 'UI_LABEL', 'provider.profile.readiness.photo', 'Profile copy: readiness.photo', 'A profile photo'),
      (55, 'UI_LABEL', 'provider.profile.readiness.gig', 'Profile copy: readiness.gig', 'A published Gig'),
      (56, 'UI_LABEL', 'provider.profile.readiness.trust', 'Profile copy: readiness.trust', 'A verification badge'),
      (57, 'PLAIN_TEXT', 'provider.profile.readiness.complete', 'Profile copy: readiness.complete', 'Everything this profile needs is in place.'),
      (58, 'UI_LABEL', 'provider.profile.preview.heading', 'Profile copy: preview.heading', 'Preview'),
      (59, 'PLAIN_TEXT', 'provider.profile.preview.note', 'Profile copy: preview.note', 'This is how customers will see your profile. It is a preview only and is not live or bookable.'),
      (60, 'UI_LABEL', 'provider.profile.preview.back', 'Profile copy: preview.back', 'Back to your profile'),
      (61, 'UI_LABEL', 'provider.profile.public.gigs_heading', 'Profile copy: public.gigs_heading', 'Gigs'),
      (62, 'PLAIN_TEXT', 'provider.profile.public.no_gigs', 'Profile copy: public.no_gigs', 'No Gigs to show yet.'),
      (63, 'UI_LABEL', 'provider.profile.public.badges_heading', 'Profile copy: public.badges_heading', 'Verification'),
      (64, 'UI_LABEL', 'provider.profile.public.about_heading', 'Profile copy: public.about_heading', 'About'),
      (65, 'UI_LABEL', 'provider.profile.public.price_from', 'Profile copy: public.price_from', 'Base price'),
      (66, 'UI_LABEL', 'provider.profile.public.duration', 'Profile copy: public.duration', 'Duration'),
      (67, 'UI_LABEL', 'provider.profile.public.options', 'Profile copy: public.options', 'Options'),
      (68, 'UI_LABEL', 'provider.profile.public.photos', 'Profile copy: public.photos', 'Photos'),
      (69, 'UI_LABEL', 'provider.profile.save', 'Profile copy: save', 'Save'),
      (70, 'PLAIN_TEXT', 'provider.profile.notice.created', 'Profile copy: notice.created', 'Your profile was created.'),
      (71, 'PLAIN_TEXT', 'provider.profile.notice.saved', 'Profile copy: notice.saved', 'Your profile was saved.'),
      (72, 'PLAIN_TEXT', 'provider.profile.notice.published', 'Profile copy: notice.published', 'Your profile is now public.'),
      (73, 'PLAIN_TEXT', 'provider.profile.notice.unpublished', 'Profile copy: notice.unpublished', 'Your profile is now private.'),
      (74, 'PLAIN_TEXT', 'provider.profile.notice.photo_added', 'Profile copy: notice.photo_added', 'Your photo was added.'),
      (75, 'PLAIN_TEXT', 'provider.profile.notice.photo_removed', 'Profile copy: notice.photo_removed', 'Your photo was removed.'),
      (76, 'PLAIN_TEXT', 'provider.profile.public.no_badges', 'Profile copy: public.no_badges', 'No verification badges to show yet.'),
      (77, 'PLAIN_TEXT', 'provider.profile.public.no_bio', 'Profile copy: public.no_bio', 'This provider has not added a description yet.'),
      (78, 'PLAIN_TEXT', 'provider.profile.public.not_found', 'Profile copy: public.not_found', 'We could not find that provider.')
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
