-- checkpoint: CAT-004
-- purpose: forward hardening of 0021 after the independent reviews (0021 was already applied to the development database and is never edited): (1) two one-way removal markers on provider.media_assets, objects_removed_at (the final and the upload objects of a TERMINAL asset were deleted from the store) and upload_key_removed_at (the separate `<final key>.upload` object of a READY or terminal asset was deleted after the PUT authorization expired), so the clean-up can find exactly what is left to remove and a crashed removal is retried; (2) the sweep indexes follow: two new partial indexes for those two sweeps, the unused partial index on ready_at is dropped and the account index is corrected to what it really serves; (3) a repair path for rows already stuck: an UPLOAD_PENDING asset whose only attachments belong to RETIRED versions (a Gig retired with an unfinished upload in its draft) may be ABANDONED, the attachment rows stay as history; (4) the object key is derived: CHECK (object_key = 'provider/gig-media/' || media_asset_id), so the key can never name another asset's bytes; (5) variants and add-ons are replaced as a whole set (delete and insert) and never updated: the guard refuses every UPDATE; (6) comments corrected where 0021 over-claimed ("the base is the cheapest configuration" is not a database rule) and the consumer rule recorded.
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. Two nullable columns and three CHECKs are added, two functions are replaced (bodies only), three indexes are created and two dropped; no row is changed, deleted or truncated
-- backfill: none. The new columns are NULL for every existing row (existing ABANDONED rows therefore appear in the objects-to-remove sweep once, which deletes idempotently and then marks them). The key derivation is PRE-CHECKED by a DO block that raises (and so rolls the whole migration back) if any existing row violates it
-- risk: low. media_assets and the option tables are small and new. ADD COLUMN with no default is metadata only; the three CHECKs scan the table once; the index changes take short locks. The replaced guards behave exactly as before for every statement that was legal, except the three deliberate changes: UPDATE of an option row is now refused (NO_UPDATE), a terminal asset accepts the two removal markers, and an UPLOAD_PENDING asset whose attachments are all on RETIRED versions may be ABANDONED
-- destructive: DROP INDEX idx_media_assets__ready_at (unused: the orphan sweep filters on NOT EXISTS over the attachments and the planner never chose it; the sweep reads the READY assets directly, recorded as debt) and DROP INDEX idx_media_assets__account_status (replaced by idx_media_assets__account on account_id alone: the status column served no query). Both are derived structures; no data is lost
-- events: none
-- audit: none
-- DECISIONS: (1) removal is recorded on the asset, not guessed: objects_removed_at is set once the service has deleted the final object AND the upload object of an ABANDONED or DELETED asset; upload_key_removed_at is set once the upload object of a READY asset was deleted after its PUT authorization expired (nothing reads the final bytes from the upload key, so deleting it is safe only after a still-valid presigned PUT can no longer rewrite it). Both markers are one-way (NULL to a timestamp, never cleared, never moved) and are the only columns a terminal row accepts; (2) the markers are settable on rows that are otherwise frozen, so the sweep can finish its work without unfreezing the facts; (3) a stuck pending asset: a retired Gig retires its DRAFT version together with that draft's attachments of unfinished uploads; the asset could then be neither finished (the version is frozen) nor abandoned (it was referenced). Abandoning it is correct and the attachment rows stay as history of the retired version; an attachment on any version that is not RETIRED still blocks both ABANDONED and DELETED (ASSET_REFERENCED), and the bytes of an asset referenced by a version of any status are never DELETED; (4) the key is derived from the id by the service and now by the database, so no row can point at another asset's object; (5) the options are written by delete and insert in one transaction, so an UPDATE is never legitimate and is refused outright (NO_UPDATE), which also makes the immutable-identity rule of the options unreachable (removed); (6) the display-order unique constraint of the attachments stays DEFERRABLE INITIALLY IMMEDIATE for ONE real reason: a deferrable constraint is checked at the END of the statement, so the service can swap or renumber all positions in a single UPDATE (display_order = 3 - display_order) without false conflicts in the middle of the statement, which a non-deferrable unique constraint (checked row by row) cannot do. The price is that the constraint cannot be the arbiter of INSERT ... ON CONFLICT; nothing uses it that way; (7) CONSUMER RULE for later checkpoints (booking, BananaDrop, bundles): reference a variant or an add-on by (gig_version_id, item_key), never by variant_id or add_on_id, because the next draft receives COPIES with new row ids and the same keys; the children carry no currency (it is the currency of the parent version); (8) honest index notes: idx_media_assets__ready_at never served the orphan sweep and is dropped; the orphan sweep scans the READY assets of the table (filtered by age and NOT EXISTS over the attachments) and is bounded by its batch limit: if READY assets grow large enough to matter, a measured index is added by its own review

-- =====================================================================================================================
-- 1. the removal markers
-- =====================================================================================================================
DO $pre$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*)::integer INTO v_bad FROM provider.media_assets WHERE object_key IS DISTINCT FROM 'provider/gig-media/' || media_asset_id::text;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% media asset row(s) have an object key that is not provider/gig-media/<asset id>; repair them before this migration', v_bad;
  END IF;
END
$pre$;

ALTER TABLE provider.media_assets ADD COLUMN objects_removed_at timestamptz;
ALTER TABLE provider.media_assets ADD COLUMN upload_key_removed_at timestamptz;
ALTER TABLE provider.media_assets ADD CONSTRAINT ck_media_assets__objects_removed CHECK (objects_removed_at IS NULL OR status IN ('ABANDONED', 'DELETED'));
ALTER TABLE provider.media_assets ADD CONSTRAINT ck_media_assets__upload_key_removed CHECK (upload_key_removed_at IS NULL OR status IN ('READY', 'ABANDONED', 'DELETED'));
ALTER TABLE provider.media_assets ADD CONSTRAINT ck_media_assets__object_key_derived CHECK (object_key = 'provider/gig-media/' || media_asset_id::text);
COMMENT ON COLUMN provider.media_assets.objects_removed_at IS 'When the service deleted the final object AND the upload object of this TERMINAL asset (ABANDONED or DELETED) from the private store; NULL until then and always NULL for a pending or READY asset (ck_media_assets__objects_removed). One-way: NULL to a timestamp, never cleared or moved (MARKER_ONE_WAY). The only column, with upload_key_removed_at, that a terminal row still accepts. The clean-up deletes idempotently and then sets it, so a crash between the two is retried.';
COMMENT ON COLUMN provider.media_assets.upload_key_removed_at IS 'When the service deleted the separate upload object (`<final key>.upload`) of a READY or terminal asset after its PUT authorization had expired, so a still-valid presigned PUT could no longer rewrite it; NULL until then and always NULL for a pending asset (ck_media_assets__upload_key_removed). One-way (MARKER_ONE_WAY). Settable on a READY row without touching the bytes facts. Nothing ever reads the final bytes from the upload key, so a late replay can never change a verified asset.';
COMMENT ON COLUMN provider.media_assets.object_key IS 'The FINAL private object-store key of the verified bytes, always exactly provider/gig-media/<media_asset_id> (ck_media_assets__object_key_derived, since 0022), so no row can point at another asset''s object. Unique. Immutable. A secret of the store: never in a default payload, audit row, event, log or error detail. The separate key a browser uploads to (the final key plus the suffix .upload) is derived and not stored; its removal is recorded in upload_key_removed_at and objects_removed_at.';
COMMENT ON COLUMN provider.media_assets.scan_status IS 'PENDING (not scanned), CLEAN, INFECTED (only with ABANDONED) or ERROR (the scanner could not decide). The lifecycle CHECK allows PENDING or ERROR on an UPLOAD_PENDING asset (a scanner error keeps it pending and repeatable), CLEAN or ERROR on a READY or DELETED asset (ERROR only when the configuration does not require a clean scan, provider.gig.media.require_clean_scan; the service decides) and ANY value on an ABANDONED asset. The reason an asset was abandoned is audited as a code, never stored here.';

-- =====================================================================================================================
-- 2. indexes
-- =====================================================================================================================
DROP INDEX provider.idx_media_assets__ready_at;
DROP INDEX provider.idx_media_assets__account_status;
CREATE INDEX idx_media_assets__account ON provider.media_assets (account_id);
CREATE INDEX idx_media_assets__objects_to_remove ON provider.media_assets (updated_at) WHERE status IN ('ABANDONED', 'DELETED') AND objects_removed_at IS NULL;
CREATE INDEX idx_media_assets__upload_key_sweep ON provider.media_assets (upload_expires_at) WHERE status = 'READY' AND upload_key_removed_at IS NULL;
-- Index justification (DATA_MODEL_GUARDRAILS rule 11):
--   idx_media_assets__account (account_id): the support of the foreign key to the account and the per-account read of the upload flow (an account has few unfinished uploads, so the status filter is applied to a handful of rows; the earlier (account_id, status) pair served no query that account_id alone does not).
--   idx_media_assets__objects_to_remove (updated_at) WHERE status IN ('ABANDONED', 'DELETED') AND objects_removed_at IS NULL: the clean-up of the store (terminal assets whose objects are still there, oldest first). Partial and self-emptying: a row leaves it when the marker is set, so it holds only the work that is left.
--   idx_media_assets__upload_key_sweep (upload_expires_at) WHERE status = 'READY' AND upload_key_removed_at IS NULL: the sweep of upload objects of READY assets whose PUT authorization has expired. Partial and self-emptying for the same reason.
--   idx_media_assets__pending_expiry (upload_expires_at) WHERE status = 'UPLOAD_PENDING' (0021, kept): the expiry sweep of unfinished uploads.
--   idx_media_assets__ready_at (0021) is DROPPED: the orphan sweep (READY, older than the grace period, NOT EXISTS over the attachments) was never served by it; the planner chose a scan of the READY rows in every measured plan. Debt: a measured index if READY assets ever make that scan matter.

-- =====================================================================================================================
-- 3. the asset guard: markers, the stuck-pending repair path
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
  IF (NEW.media_asset_id, NEW.account_id, NEW.object_key, NEW.mime_type, NEW.size_bytes, NEW.upload_expires_at, NEW.created_at)
     IS DISTINCT FROM (OLD.media_asset_id, OLD.account_id, OLD.object_key, OLD.mime_type, OLD.size_bytes, OLD.upload_expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'the id, the owner, the key, the type, the size, the authorization window and the creation time of an asset are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:IMMUTABLE_IDENTITY';
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
  -- this statement holds the row lock of the asset (the row is locked before a BEFORE UPDATE trigger runs), and an attacher holds it FOR SHARE until it commits, so the checks below see every committed attachment
  IF NEW.status = 'DELETED' AND EXISTS (SELECT 1 FROM provider.gig_version_media WHERE media_asset_id = OLD.media_asset_id) THEN
    RAISE EXCEPTION 'an asset that an attachment references is never deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ASSET_REFERENCED';
  END IF;
  -- an unfinished upload can be abandoned when every attachment that references it belongs to a RETIRED version (the Gig was retired with the draft); a version in any other status still holds it
  IF NEW.status = 'ABANDONED' AND EXISTS (
       SELECT 1 FROM provider.gig_version_media m JOIN provider.gig_versions v ON v.gig_version_id = m.gig_version_id
        WHERE m.media_asset_id = OLD.media_asset_id AND v.status <> 'RETIRED') THEN
    RAISE EXCEPTION 'an asset that an attachment of a version that is not RETIRED references is not abandoned' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ASSET_REFERENCED';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION provider.guard_media_assets() IS 'Asset guard: created UPLOAD_PENDING for an ACTIVE account (read FOR SHARE); never deleted; id, owner, key, type, size, authorization window and creation time immutable; UPLOAD_PENDING -> READY | ABANDONED and READY -> DELETED only; ABANDONED and DELETED frozen except for the two one-way removal markers objects_removed_at and upload_key_removed_at (set once, never cleared or moved); the bytes facts of a READY asset immutable; DELETED is refused while ANY attachment references the asset and ABANDONED while an attachment of a version that is not RETIRED does (NO_DELETE, MUST_START_PENDING, ACCOUNT_NOT_ACTIVE, IMMUTABLE_IDENTITY, MARKER_ONE_WAY, ASSET_FROZEN, BYTES_IMMUTABLE, STATUS_TRANSITION, ASSET_REFERENCED). The attachment guard takes the asset row FOR SHARE and the UPDATE here holds its row lock, so an attach and a sweep cannot race.';
COMMENT ON TABLE provider.media_assets IS 'The BYTES of one provider photo (CAT-004), owned by an account and independent of any Gig: one row per authorized upload. Lifecycle: UPLOAD_PENDING (a presigned upload was authorized, nothing verified) -> READY (the service read the object, checked size, type, signature, header dimensions and hash, scanned it and promoted it to its final key) or ABANDONED (refused, infected, expired or detached before it was finished); READY -> DELETED (its bytes were removed by the reference-aware clean-up, only when no attachment references it). ABANDONED and DELETED are terminal and frozen except for the one-way removal markers (objects_removed_at: the objects of a terminal asset are gone; upload_key_removed_at: the separate upload object was removed after its PUT authorization expired). A READY asset is immutable. The same READY asset can be attached to several versions of the owner''s Gigs (provider.gig_version_media): there is no binary copy and no deduplication across uploads or accounts. The object key is always provider/gig-media/<asset id>; it, the hash and any URL are secrets of the store and appear in no default payload, audit row, event, log or error detail. Never deleted or truncated.';

-- =====================================================================================================================
-- 4. variants and add-ons are replaced as a whole set: UPDATE is refused
-- =====================================================================================================================
CREATE OR REPLACE FUNCTION provider.guard_gig_version_options() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_version  uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.gig_version_id ELSE NEW.gig_version_id END;
  v_status   text;
  v_tv       uuid;
  v_allowed  boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'variants and add-ons are replaced as a whole set (delete and insert), never updated' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:NO_UPDATE';
  END IF;
  SELECT status, gig_template_version_id INTO v_status, v_tv FROM provider.gig_versions WHERE gig_version_id = v_version FOR SHARE;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    IF v_status IS NULL AND TG_OP = 'INSERT' THEN
      RETURN NEW; -- the foreign key reports the missing version
    END IF;
    RAISE EXCEPTION 'the variants and add-ons of a Gig version change only while it is a DRAFT' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:VERSION_FROZEN';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  -- the permission is a frozen flag of the bound template version (read without a lock, see the lock order of 0021)
  IF TG_TABLE_NAME = 'gig_version_variants' THEN
    SELECT pricing_fixed_with_variants INTO v_allowed FROM catalog.gig_template_versions WHERE gig_template_version_id = v_tv;
    IF v_allowed IS NOT TRUE THEN
      RAISE EXCEPTION 'the bound template version does not allow variants' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:VARIANTS_NOT_PERMITTED';
    END IF;
  ELSE
    SELECT pricing_add_ons INTO v_allowed FROM catalog.gig_template_versions WHERE gig_template_version_id = v_tv;
    IF v_allowed IS NOT TRUE THEN
      RAISE EXCEPTION 'the bound template version does not allow add-ons' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ADD_ONS_NOT_PERMITTED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION provider.guard_gig_version_options() IS 'Guard of the variant and add-on tables: UPDATE is refused outright (NO_UPDATE: the set is replaced by delete and insert, so a row id is regenerated per version); insert and delete only while the parent version is a DRAFT (read FOR SHARE so a concurrent publication serializes) (VERSION_FROZEN); a variant needs a bound template version that permits FIXED_WITH_VARIANTS and an add-on one that has pricing_add_ons (the frozen flags are read without a lock) (VARIANTS_NOT_PERMITTED, ADD_ONS_NOT_PERMITTED). Counts, names and bounds of the configured policy are validated by the service.';

COMMENT ON TABLE provider.gig_version_variants IS 'A VARIANT of a Gig version (CAT-004): one of several mutually exclusive alternatives of the same service (for example a size). Owned by the VERSION: rows are inserted and deleted only while the version is a DRAFT (a save replaces the whole set; UPDATE is refused, NO_UPDATE) and are frozen history afterwards. Priced as a non-negative DELTA on the base price of the version plus a non-negative duration delta, in minor units of the version''s own currency (the market currency): there is NO currency column and NO absolute price. The base price is the price with no variant selected (delta zero); that every booking must pick exactly one variant when any exist is a booking rule, not a database rule. CONSUMER RULE: a later checkpoint (booking, BananaDrop, bundle) references a variant by (gig_version_id, item_key), NEVER by variant_id, because the next draft receives copies with new row ids and the same keys. Allowed only when the bound template version permits FIXED_WITH_VARIANTS (guard). Optional: zero variants is valid and there is no default variant. The name and description are provider plain text and never appear in audit, events, logs or error details. Never truncated.';
COMMENT ON COLUMN provider.gig_version_variants.price_delta_minor IS 'What this variant adds to the base price, in MINOR units of the currency of the version (never a float, never negative): 0 to 10^12. The base price is the price with no variant selected; final sums are a booking concern.';
COMMENT ON TABLE provider.gig_version_add_ons IS 'An ADD-ON of a Gig version (CAT-004): an independent optional extra (no quantity: the PRD does not justify one yet), priced exactly like a variant as a non-negative delta on the base price plus a non-negative duration delta, with no currency column. Owned by the VERSION: rows are inserted and deleted only while it is a DRAFT (a save replaces the whole set; UPDATE is refused, NO_UPDATE) and frozen afterwards. CONSUMER RULE: a later checkpoint references an add-on by (gig_version_id, item_key), NEVER by add_on_id (copies get new row ids and keep the key). Allowed only when the bound template version has the explicit permission pricing_add_ons (guard). Neither variants nor add-ons are a platform taxonomy. The name and description are provider plain text and never appear in audit, events, logs or error details. Never truncated.';

-- =====================================================================================================================
-- 5. the real reason for the deferrable order constraint
-- =====================================================================================================================
COMMENT ON COLUMN provider.gig_version_media.display_order IS 'Position among the photos of the version, 1 or more, unique per version (gaps are allowed after a removal). The unique constraint is DEFERRABLE INITIALLY IMMEDIATE so that it is checked at the END of a statement: the service reorders all photos with ONE UPDATE (display_order = 3 - display_order style swaps) without false conflicts in the middle of the statement, which a plain unique constraint (checked row by row) would report. The constraint cannot be the arbiter of INSERT ... ON CONFLICT; nothing uses it that way.';
