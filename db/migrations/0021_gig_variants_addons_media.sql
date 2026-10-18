-- checkpoint: CAT-004
-- purpose: add the VARIANTS, ADD-ONS and PHOTOS of a provider Gig version in the existing `provider` schema. Variants (provider.gig_version_variants) are mutually exclusive alternatives and add-ons (provider.gig_version_add_ons) independent extras; both belong to a Gig VERSION (never the Gig identity), are priced as NON-NEGATIVE DELTAS on the base price of CAT-003 (minor units, same currency, no absolute prices) plus a non-negative duration delta, carry a stable server-minted item key and an explicit display order, and are replaced as a whole set while the version is a DRAFT. Photos are modelled as an ASSET (provider.media_assets: the account-owned bytes, one lifecycle UPLOAD_PENDING -> READY | ABANDONED, READY -> DELETED, immutable once READY) and an ATTACHMENT (provider.gig_version_media: a version, an asset, the template MEDIA field it satisfies, an order and an alt text), so a READY photo is re-attached to the next version without copying a binary. One additive column on the Gig Template version (catalog.gig_template_versions.pricing_add_ons, default false) is the explicit template permission for add-ons, protected by the frozen-structure guard. The Gig audit action list grows by eight actions. Guards enforce, in the database, that children change only while the version is a DRAFT, that variants and add-ons need the template permission, that a photo goes to a MEDIA field of the EXACT bound template version of an asset owned by the Gig's account, that a field is never over its maximum, that an asset is never deleted or abandoned while an attachment references it, and (at publication) that every photo is READY and every required MEDIA field has its minimum. Seeds: fifteen policy parameters (configuration, CFG-001) and the copy of the new flow (content, CFG-002). No variant, add-on, asset or attachment is seeded.
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. No child row is ever changed once its version leaves DRAFT, no asset is ever deleted (it is marked DELETED after its bytes are removed) and nothing is truncated, so there is nothing to restore; the seeded values and copy are changed through the configuration and content workflows, never by editing this file. The column pricing_add_ons keeps its default false for every existing template version
-- backfill: none; every table is new and the new column defaults to false for every existing template version (no existing Gig can have add-ons or photos)
-- risk: low. The only existing objects touched are (1) catalog.gig_template_versions: one nullable-free column with a constant default (a metadata-only change on PostgreSQL 11+, no table rewrite) and the frozen-structure guard replaced with one more compared column; (2) provider.guard_gig_versions replaced with one more call in the publication branch (a read of the children of the version being published, bounded by the configured caps); (3) the audit action CHECK of provider.gig_audit_events is dropped and re-added with the new list (a short ACCESS EXCLUSIVE lock on a small table; every existing row satisfies it). The new guards read catalogue rows WITHOUT locks (the structure of a bound template version is frozen), so the catalogue's lock order (template, service type, version) is untouched
-- destructive: DROP CONSTRAINT ck_gig_audit_events__action only, replaced in the same transaction by a superset list (the six existing actions plus eight new ones); no data is deleted or changed
-- events: the seeds emit no outbox events (they run before any consumer exists); every variant, add-on and photo change after this migration goes through ProviderGigService, which writes audit in the same transaction (the existing three events gain counts only)
-- audit: the configuration and content seeds write their own audit trails exactly as the real workflows do; the Gig audit trail gains eight actions and starts empty for them
-- ASSUMPTIONS (flagged as debt, product configuration, changed through the change-request workflow): the PRD gives 10 MB per file and 50 photos per Gig (PR-03.07, media.max_file_mb, media.max_photos_per_gig); every other media value is an ENGINEERING ASSUMPTION: min edge 200 px, max edge 12000 px, max 50,000,000 pixels (decompression-bomb bound), upload authorization 900 s, preview URL 60 s, orphan grace 86400 s, alt text 200 characters, clean scan required (production has no scanner yet, so nothing can be attached there until one exists: fail closed), variant cap 10, add-on cap 20, name 80 and description 500 characters. HEIC (the PRD default type) is NOT accepted until a verified reader exists; SVG never
-- DECISIONS: (1) variants, add-ons and photo attachments belong to a Gig VERSION: a published version is immutable history and the next draft receives copies (same keys, same order) and re-attachments of the same READY assets; (2) ONE pricing rule: the Gig price (CAT-003) is the BASE and the cheapest configuration; a child stores only a non-negative delta in minor units (bigint, at most 10^12) and a non-negative duration delta (at most 100000 minutes); there is NO absolute price, NO currency column on a child (it inherits the currency of the parent version, which is the market currency, so a currency cannot disagree) and NO negative delta (debt); sums are a booking concern; (3) the stable item_key is the identity of an item across versions (a name may change, a key does not), unique per version and kind; the display order is an explicit column, unique per version; names are not unique in the database (the service refuses duplicates after NFC and case folding because that comparison is locale-aware text processing); (4) whole-set replacement needs no updated_at and no JSON: the rows are deleted and re-inserted in one transaction; (5) the asset/attachment split: the BYTES (key, type, size, hash, dimensions, scan verdict, lifecycle) are a fact about the file, owned by an account, written once and immutable once READY; the ATTACHMENT is a fact about a version (which field, which order, which alt text); one asset can serve many versions without a binary copy; there is NO binary deduplication across accounts or across uploads (a second upload of the same bytes is a second asset: deduplicating by hash would leak that someone else already uploaded the same file, and the saving is not worth the privacy risk); (6) an asset is OWNED by an account and can only be attached to a Gig of that account (ASSET_OWNER); (7) the object key, the hash and any URL are secrets of the store and never leave the service in a default payload, an audit row or an event; (8) the attachment may reference only an UPLOAD_PENDING or READY asset, enforced from both sides: the attachment guard at insert, and the asset guard refuses ABANDONED or DELETED while an attachment references it (ASSET_REFERENCED), serialized by a row lock on the asset (FOR SHARE when attaching, the row lock of the UPDATE when deleting); (9) a MEDIA field is satisfied by attachments and never by a field value; the template says how many photos a field needs or allows (min_items, max_items, max_items = 0 prohibits) and the guards read that from the EXACT bound template version, never from a copy; (10) the media guard locks the parent version FOR NO KEY UPDATE so that the per-field maximum cannot be exceeded by two concurrent inserts, and the option guards lock it FOR SHARE (their caps are configuration, counted by the service); (11) lock order: account, Gig, version, then the asset; catalogue rows are read without locks because the structure of a bound (ACTIVE or SUPERSEDED) template version is frozen and its flags are protected by the same guard that now includes pricing_add_ons; (12) the display-order unique constraints of the attachments are DEFERRABLE INITIALLY IMMEDIATE so a whole-order reorder can swap positions in one transaction (SET CONSTRAINTS ... DEFERRED) while every other statement behaves as a plain unique constraint

-- =====================================================================================================================
-- 1. catalog.gig_template_versions.pricing_add_ons (the explicit template permission for add-ons) and its frozen-structure guard
-- =====================================================================================================================
ALTER TABLE catalog.gig_template_versions ADD COLUMN pricing_add_ons boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN catalog.gig_template_versions.pricing_add_ons IS 'CAT-004 permission: a Gig built from this version may offer add-ons (independent optional extras priced as non-negative deltas on the base price). Explicit and independent of FIXED / FIXED_WITH_VARIANTS (the base model is still required). Existing versions are false. Part of the frozen structure: it cannot change once the version leaves DRAFT.';
COMMENT ON COLUMN catalog.gig_template_versions.pricing_fixed IS 'Allowed pricing models. FIXED is the base price every Gig has (PR-03.04); FIXED_WITH_VARIANTS lets the Gig add variants (mutually exclusive alternatives, CAT-004); ADD_ONS (column pricing_add_ons, CAT-004) lets the Gig offer add-ons; BUNDLE_ELIGIBLE and DROP_ELIGIBLE say the Gig may join a bundle or a BananaDrop. At least one of fixed / fixed_with_variants. Metadata only: no price is stored or computed here.';

-- =====================================================================================================================
-- 1b. the frozen-structure guard of a template version now also freezes pricing_add_ons (the body of 0016 with one more compared column in the three tuples)
-- =====================================================================================================================
CREATE OR REPLACE FUNCTION catalog.guard_gig_template_versions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t_status  text;
  t_service uuid;
  st_status text;
  v_max     integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a Gig Template version is never deleted: retire it with status RETIRED' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.revision <> 1 OR NEW.published_at IS NOT NULL OR NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a Gig Template version is created as a fresh DRAFT' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:MUST_START_AS_DRAFT';
    END IF;
    SELECT status INTO t_status FROM catalog.gig_templates WHERE gig_template_id = NEW.gig_template_id FOR SHARE;
    IF t_status = 'RETIRED' THEN
      RAISE EXCEPTION 'no version can be created for a RETIRED Gig Template' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:GIG_TEMPLATE_RETIRED';
    END IF;
    SELECT COALESCE(max(version_number), 0) INTO v_max FROM catalog.gig_template_versions WHERE gig_template_id = NEW.gig_template_id;
    IF NEW.version_number <> v_max + 1 THEN
      RAISE EXCEPTION 'version numbers are contiguous: the next version is the highest plus one' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:VERSION_NUMBER_SEQUENCE';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.gig_template_version_id, NEW.gig_template_id, NEW.version_number) IS DISTINCT FROM (OLD.gig_template_version_id, OLD.gig_template_id, OLD.version_number) THEN
    RAISE EXCEPTION 'the id, the template and the number of a version are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:IMMUTABLE_IDENTITY';
  END IF;
  -- once the version has left DRAFT its structure is frozen: only the status and its closing timestamp may change
  IF OLD.status <> 'DRAFT' AND (
       NEW.revision, NEW.min_duration_minutes, NEW.max_duration_minutes, NEW.suggested_duration_minutes,
       NEW.pricing_fixed, NEW.pricing_fixed_with_variants, NEW.pricing_bundle_eligible, NEW.pricing_drop_eligible, NEW.pricing_add_ons,
       NEW.area_radius, NEW.area_postal_codes, NEW.area_polygon, NEW.created_at, NEW.published_at)
     IS DISTINCT FROM (
       OLD.revision, OLD.min_duration_minutes, OLD.max_duration_minutes, OLD.suggested_duration_minutes,
       OLD.pricing_fixed, OLD.pricing_fixed_with_variants, OLD.pricing_bundle_eligible, OLD.pricing_drop_eligible, OLD.pricing_add_ons,
       OLD.area_radius, OLD.area_postal_codes, OLD.area_polygon, OLD.created_at, OLD.published_at) THEN
    RAISE EXCEPTION 'a published Gig Template version is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:VERSION_FROZEN';
  END IF;
  IF OLD.status <> 'DRAFT' AND NEW.closed_at IS DISTINCT FROM OLD.closed_at AND OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a published Gig Template version is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:VERSION_FROZEN';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'the revision of a draft only grows' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:VERSION_FROZEN';
  END IF;
  PERFORM catalog.assert_version_transition(OLD.status, NEW.status);
  NEW.created_at := OLD.created_at;
  IF NEW.status = OLD.status THEN
    NEW.published_at := OLD.published_at;
    NEW.closed_at := OLD.closed_at;
  ELSIF NEW.status = 'ACTIVE' THEN
    -- publication: the content of the draft must not change in the same statement
    IF (NEW.revision, NEW.min_duration_minutes, NEW.max_duration_minutes, NEW.suggested_duration_minutes, NEW.pricing_fixed, NEW.pricing_fixed_with_variants, NEW.pricing_bundle_eligible,
        NEW.pricing_drop_eligible, NEW.pricing_add_ons, NEW.area_radius, NEW.area_postal_codes, NEW.area_polygon)
       IS DISTINCT FROM
       (OLD.revision, OLD.min_duration_minutes, OLD.max_duration_minutes, OLD.suggested_duration_minutes, OLD.pricing_fixed, OLD.pricing_fixed_with_variants, OLD.pricing_bundle_eligible,
        OLD.pricing_drop_eligible, OLD.pricing_add_ons, OLD.area_radius, OLD.area_postal_codes, OLD.area_polygon) THEN
      RAISE EXCEPTION 'a draft cannot change in the statement that publishes it' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:VERSION_FROZEN';
    END IF;
    SELECT status, service_type_id INTO t_status, t_service FROM catalog.gig_templates WHERE gig_template_id = NEW.gig_template_id FOR SHARE;
    IF t_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'a version can be published only while its Gig Template is ACTIVE' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:GIG_TEMPLATE_NOT_ACTIVE';
    END IF;
    SELECT status INTO st_status FROM catalog.service_types WHERE service_type_id = t_service FOR SHARE;
    IF st_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'a version can be published only while its service type is ACTIVE' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:SERVICE_TYPE_NOT_ACTIVE';
    END IF;
    PERFORM catalog.assert_version_publishable(OLD.gig_template_version_id);
    -- the previous ACTIVE version is superseded by THIS publication (nested trigger: pg_trigger_depth() = 2)
    UPDATE catalog.gig_template_versions SET status = 'SUPERSEDED'
     WHERE gig_template_id = NEW.gig_template_id AND status = 'ACTIVE' AND gig_template_version_id <> NEW.gig_template_version_id;
    NEW.published_at := now();
    NEW.closed_at := NULL;
  ELSE
    IF NEW.status = 'SUPERSEDED' AND pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'a version is superseded only by the publication of a newer version' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:SUPERSEDED_IS_AUTOMATIC';
    END IF;
    NEW.published_at := OLD.published_at;
    NEW.closed_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION catalog.guard_gig_template_versions() IS 'Version guard: created as a fresh DRAFT with the next contiguous number and not for a RETIRED template, never deleted, id/template/number immutable, frozen structure once the version left DRAFT (duration guidance, the pricing models INCLUDING pricing_add_ons since CAT-004, the area modes, revision and timestamps), the version status machine, publication needs an ACTIVE template and service type and passes assert_version_publishable and supersedes the previous ACTIVE version, SUPERSEDED only as a consequence of that publication, published_at / closed_at / created_at maintained (NOT_DELETABLE, MUST_START_AS_DRAFT, GIG_TEMPLATE_RETIRED, VERSION_NUMBER_SEQUENCE, IMMUTABLE_IDENTITY, VERSION_FROZEN, DRAFT_IS_INITIAL, STATUS_TRANSITION, GIG_TEMPLATE_NOT_ACTIVE, SERVICE_TYPE_NOT_ACTIVE, SUPERSEDED_IS_AUTOMATIC plus the publication rules).';

-- =====================================================================================================================
-- 2. provider.gig_version_variants and provider.gig_version_add_ons (same shape; delta pricing on the base)
-- =====================================================================================================================
CREATE TABLE provider.gig_version_variants (
  variant_id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  gig_version_id         uuid        NOT NULL,
  item_key               text        NOT NULL,
  name                   text        NOT NULL,
  description            text,
  price_delta_minor      bigint      NOT NULL,
  duration_delta_minutes integer     NOT NULL,
  display_order          integer     NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_gig_version_variants PRIMARY KEY (variant_id),
  CONSTRAINT uq_gig_version_variants__key UNIQUE (gig_version_id, item_key),
  CONSTRAINT uq_gig_version_variants__order UNIQUE (gig_version_id, display_order),
  CONSTRAINT fk_gig_version_variants__version_id FOREIGN KEY (gig_version_id) REFERENCES provider.gig_versions (gig_version_id) ON DELETE RESTRICT,
  CONSTRAINT ck_gig_version_variants__key CHECK (item_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT ck_gig_version_variants__name CHECK (length(btrim(name)) > 0 AND char_length(name) <= 200),
  CONSTRAINT ck_gig_version_variants__description CHECK (description IS NULL OR (length(btrim(description)) > 0 AND char_length(description) <= 2000)),
  CONSTRAINT ck_gig_version_variants__price_delta CHECK (price_delta_minor >= 0 AND price_delta_minor <= 1000000000000),
  CONSTRAINT ck_gig_version_variants__duration_delta CHECK (duration_delta_minutes >= 0 AND duration_delta_minutes <= 100000),
  CONSTRAINT ck_gig_version_variants__display_order CHECK (display_order >= 1)
);
COMMENT ON TABLE provider.gig_version_variants IS 'A VARIANT of a Gig version (CAT-004): one of several mutually exclusive alternatives of the same service (for example a size). Owned by the VERSION: rows change only while the version is a DRAFT (a save replaces the whole set) and are frozen history afterwards. Priced as a non-negative DELTA on the base price of the version (minor units of the version''s own currency, which is the market currency; there is no currency column and no absolute price) plus a non-negative duration delta; the base is the cheapest configuration. Allowed only when the bound template version permits FIXED_WITH_VARIANTS (guard). Optional: zero variants is valid and there is no default variant (a booking will pick exactly one when any exist: a booking rule). The name and description are provider plain text and never appear in audit, events, logs or error details. Never truncated.';
COMMENT ON COLUMN provider.gig_version_variants.item_key IS 'The stable key of the variant within its Gig (server-minted, for example opt_3f9a1c7b2d4e): the identity of the item across versions, copied into the next draft. Unique per version. Immutable.';
COMMENT ON COLUMN provider.gig_version_variants.name IS 'Provider plain text, single line, non-blank, at most 200 code points (the configured limit provider.gig.option.name.max_length is lower and is enforced by the service, which also refuses duplicate names after NFC and case folding).';
COMMENT ON COLUMN provider.gig_version_variants.description IS 'Provider plain text, optional, non-blank when present, at most 2000 code points (configured limit provider.gig.option.description.max_length is enforced by the service).';
COMMENT ON COLUMN provider.gig_version_variants.price_delta_minor IS 'What this variant adds to the base price, in MINOR units of the currency of the version (never a float, never negative): 0 to 10^12. The base price is the cheapest configuration; final sums are a booking concern.';
COMMENT ON COLUMN provider.gig_version_variants.duration_delta_minutes IS 'What this variant adds to the Gig duration, in minutes: 0 to 100000. Sums against the template duration bounds are a booking concern.';
COMMENT ON COLUMN provider.gig_version_variants.display_order IS 'Position in the list, 1..n, unique per version; the order the provider submitted.';

CREATE TABLE provider.gig_version_add_ons (
  add_on_id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  gig_version_id         uuid        NOT NULL,
  item_key               text        NOT NULL,
  name                   text        NOT NULL,
  description            text,
  price_delta_minor      bigint      NOT NULL,
  duration_delta_minutes integer     NOT NULL,
  display_order          integer     NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_gig_version_add_ons PRIMARY KEY (add_on_id),
  CONSTRAINT uq_gig_version_add_ons__key UNIQUE (gig_version_id, item_key),
  CONSTRAINT uq_gig_version_add_ons__order UNIQUE (gig_version_id, display_order),
  CONSTRAINT fk_gig_version_add_ons__version_id FOREIGN KEY (gig_version_id) REFERENCES provider.gig_versions (gig_version_id) ON DELETE RESTRICT,
  CONSTRAINT ck_gig_version_add_ons__key CHECK (item_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT ck_gig_version_add_ons__name CHECK (length(btrim(name)) > 0 AND char_length(name) <= 200),
  CONSTRAINT ck_gig_version_add_ons__description CHECK (description IS NULL OR (length(btrim(description)) > 0 AND char_length(description) <= 2000)),
  CONSTRAINT ck_gig_version_add_ons__price_delta CHECK (price_delta_minor >= 0 AND price_delta_minor <= 1000000000000),
  CONSTRAINT ck_gig_version_add_ons__duration_delta CHECK (duration_delta_minutes >= 0 AND duration_delta_minutes <= 100000),
  CONSTRAINT ck_gig_version_add_ons__display_order CHECK (display_order >= 1)
);
COMMENT ON TABLE provider.gig_version_add_ons IS 'An ADD-ON of a Gig version (CAT-004): an independent optional extra (no quantity: the PRD does not justify one yet), priced exactly like a variant as a non-negative delta on the base price plus a non-negative duration delta. Owned by the VERSION and frozen once it leaves DRAFT. Allowed only when the bound template version has the explicit permission pricing_add_ons (guard). Neither variants nor add-ons are a platform taxonomy: they are provider data of one version. The name and description are provider plain text and never appear in audit, events, logs or error details. Never truncated.';
COMMENT ON COLUMN provider.gig_version_add_ons.item_key IS 'The stable key of the add-on within its Gig (server-minted, for example opt_3f9a1c7b2d4e), copied into the next draft. Unique per version. Immutable.';
COMMENT ON COLUMN provider.gig_version_add_ons.name IS 'Provider plain text, single line, non-blank, at most 200 code points (the configured limit is lower and is enforced by the service).';
COMMENT ON COLUMN provider.gig_version_add_ons.description IS 'Provider plain text, optional, non-blank when present, at most 2000 code points.';
COMMENT ON COLUMN provider.gig_version_add_ons.price_delta_minor IS 'What this add-on adds to the base price, in MINOR units of the currency of the version (never a float, never negative): 0 to 10^12.';
COMMENT ON COLUMN provider.gig_version_add_ons.duration_delta_minutes IS 'What this add-on adds to the Gig duration, in minutes: 0 to 100000.';
COMMENT ON COLUMN provider.gig_version_add_ons.display_order IS 'Position in the list, 1..n, unique per version; the order the provider submitted.';

-- =====================================================================================================================
-- 3. provider.media_assets (the account-owned bytes of a photo)
-- =====================================================================================================================
CREATE TABLE provider.media_assets (
  media_asset_id    uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id        uuid        NOT NULL,
  status            text        NOT NULL DEFAULT 'UPLOAD_PENDING',
  object_key        text        NOT NULL,
  mime_type         text        NOT NULL,
  size_bytes        bigint      NOT NULL,
  sha256            char(64),
  width             integer,
  height            integer,
  scan_status       text        NOT NULL DEFAULT 'PENDING',
  upload_expires_at timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  ready_at          timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_media_assets PRIMARY KEY (media_asset_id),
  CONSTRAINT uq_media_assets__object_key UNIQUE (object_key),
  CONSTRAINT fk_media_assets__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT ck_media_assets__status CHECK (status IN ('UPLOAD_PENDING', 'READY', 'ABANDONED', 'DELETED')),
  CONSTRAINT ck_media_assets__object_key CHECK (length(object_key) BETWEEN 1 AND 500),
  CONSTRAINT ck_media_assets__mime_type CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT ck_media_assets__size CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  CONSTRAINT ck_media_assets__sha256 CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_media_assets__dimensions CHECK ((width IS NULL) = (height IS NULL) AND (width IS NULL OR (width BETWEEN 1 AND 30000 AND height BETWEEN 1 AND 30000))),
  CONSTRAINT ck_media_assets__scan_status CHECK (scan_status IN ('PENDING', 'CLEAN', 'INFECTED', 'ERROR')),
  CONSTRAINT ck_media_assets__expiry CHECK (upload_expires_at > created_at),
  CONSTRAINT ck_media_assets__infected CHECK (scan_status <> 'INFECTED' OR status = 'ABANDONED'),
  CONSTRAINT ck_media_assets__lifecycle CHECK (
    (status = 'UPLOAD_PENDING' AND sha256 IS NULL AND width IS NULL AND height IS NULL AND ready_at IS NULL AND scan_status IN ('PENDING', 'ERROR'))
    OR (status = 'READY' AND sha256 IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND ready_at IS NOT NULL AND scan_status IN ('CLEAN', 'ERROR'))
    OR (status = 'ABANDONED' AND ready_at IS NULL)
    OR (status = 'DELETED' AND sha256 IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND ready_at IS NOT NULL))
);
CREATE INDEX idx_media_assets__account_status ON provider.media_assets (account_id, status);
CREATE INDEX idx_media_assets__pending_expiry ON provider.media_assets (upload_expires_at) WHERE status = 'UPLOAD_PENDING';
CREATE INDEX idx_media_assets__ready_at ON provider.media_assets (ready_at) WHERE status = 'READY';
COMMENT ON TABLE provider.media_assets IS 'The BYTES of one provider photo (CAT-004), owned by an account and independent of any Gig: one row per authorized upload. Lifecycle: UPLOAD_PENDING (a presigned upload was authorized, nothing verified) -> READY (the service read the object, checked size, type, signature, header dimensions and hash, scanned it and promoted it to its final key) or ABANDONED (refused, infected, expired or detached before it was finished); READY -> DELETED (its bytes were removed by the reference-aware clean-up, only when no attachment references it). ABANDONED and DELETED are terminal. A READY asset is immutable. The same READY asset can be attached to several versions of the owner''s Gigs (provider.gig_version_media): there is no binary copy and no deduplication across uploads or accounts (a second upload of the same bytes is a second asset, so nobody can learn that someone else uploaded the same file). The object key, the hash and any URL are secrets of the store: they appear in no default payload, audit row, event, log or error detail. Never deleted or truncated.';
COMMENT ON COLUMN provider.media_assets.account_id IS 'The owner: the identity account (restrict) that authorized the upload. Immutable. The asset can be attached only to a Gig of the same account (ASSET_OWNER guard).';
COMMENT ON COLUMN provider.media_assets.status IS 'UPLOAD_PENDING -> READY | ABANDONED; READY -> DELETED; ABANDONED and DELETED are terminal. ABANDONED and DELETED are refused while an attachment references the asset.';
COMMENT ON COLUMN provider.media_assets.object_key IS 'The FINAL private object-store key of the verified bytes (provider/gig-media/<asset id>). Unique. Immutable. A secret of the store: never in a default payload, audit row, event, log or error detail. The separate key a browser uploads to (the final key plus a suffix) is derived and not stored: nothing reads the final bytes from it.';
COMMENT ON COLUMN provider.media_assets.mime_type IS 'The authorized and verified content type: image/jpeg, image/png or image/webp (the types this build can verify by signature and header). The allowed subset is configuration (provider.gig.media.allowed_mime_types). HEIC is deferred until a verified reader exists; SVG is never accepted. Immutable.';
COMMENT ON COLUMN provider.media_assets.size_bytes IS 'The authorized size in bytes, 1 to 26214400 (the structural ceiling; the configured maximum is provider.gig.media.max_file_size_bytes). The verified object must have exactly this size. Immutable.';
COMMENT ON COLUMN provider.media_assets.sha256 IS 'SHA-256 of the verified bytes (lower-case hex), set when the asset becomes READY and immutable afterwards. NULL while UPLOAD_PENDING. Never in a default payload.';
COMMENT ON COLUMN provider.media_assets.width IS 'Pixel width read from the image HEADER (the image is never decoded), 1 to 30000. Set with height when READY, immutable afterwards.';
COMMENT ON COLUMN provider.media_assets.height IS 'Pixel height read from the image HEADER, 1 to 30000. Set with width when READY, immutable afterwards.';
COMMENT ON COLUMN provider.media_assets.scan_status IS 'PENDING (not scanned), CLEAN, INFECTED (only with ABANDONED) or ERROR (the scanner could not decide: such an asset is READY only when the configuration does not require a clean scan, provider.gig.media.require_clean_scan). The reason an asset was abandoned is audited as a code, never stored here.';
COMMENT ON COLUMN provider.media_assets.upload_expires_at IS 'When the upload authorization ends (creation time plus provider.gig.media.upload_ttl_seconds). An UPLOAD_PENDING asset past it is closed by the clean-up job. Immutable.';
COMMENT ON COLUMN provider.media_assets.ready_at IS 'When the asset became READY (NULL until then); immutable afterwards; the orphan grace period is measured from it.';
-- Index justification (DATA_MODEL_GUARDRAILS rule 11):
--   uq_media_assets__object_key: one key per asset (the store key is the identity of the bytes) and the lookup by key.
--   idx_media_assets__account_status (account_id, status): the foreign key to the account (its leading column) AND the per-account read the upload flow makes (the account's UPLOAD_PENDING assets whose authorization expired, closed before a new authorization); a single-column index on account_id would not serve the status filter.
--   idx_media_assets__pending_expiry (upload_expires_at) WHERE status = 'UPLOAD_PENDING': the clean-up sweep (pending assets past their expiry, oldest first) without scanning READY assets, which are the vast majority; partial, so it stays tiny and is maintained only by the short pending phase.
--   idx_media_assets__ready_at (ready_at) WHERE status = 'READY': the orphan sweep (READY assets older than the grace period, then checked for attachments); partial for the same reason.

-- =====================================================================================================================
-- 4. provider.gig_version_media (the attachment of an asset to a version)
-- =====================================================================================================================
CREATE TABLE provider.gig_version_media (
  gig_version_media_id  uuid        NOT NULL DEFAULT gen_random_uuid(),
  gig_version_id        uuid        NOT NULL,
  media_asset_id        uuid        NOT NULL,
  gig_template_field_id uuid        NOT NULL,
  display_order         integer     NOT NULL,
  alt_text              text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_gig_version_media PRIMARY KEY (gig_version_media_id),
  CONSTRAINT uq_gig_version_media__order UNIQUE (gig_version_id, display_order) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT uq_gig_version_media__asset UNIQUE (gig_version_id, media_asset_id),
  CONSTRAINT fk_gig_version_media__version_id FOREIGN KEY (gig_version_id) REFERENCES provider.gig_versions (gig_version_id) ON DELETE RESTRICT,
  CONSTRAINT fk_gig_version_media__asset_id FOREIGN KEY (media_asset_id) REFERENCES provider.media_assets (media_asset_id) ON DELETE RESTRICT,
  CONSTRAINT fk_gig_version_media__field_id FOREIGN KEY (gig_template_field_id) REFERENCES catalog.gig_template_fields (gig_template_field_id) ON DELETE RESTRICT,
  CONSTRAINT ck_gig_version_media__display_order CHECK (display_order >= 1),
  CONSTRAINT ck_gig_version_media__alt_text CHECK (alt_text IS NULL OR (length(btrim(alt_text)) > 0 AND char_length(alt_text) <= 500))
);
CREATE INDEX idx_gig_version_media__asset ON provider.gig_version_media (media_asset_id);
CREATE INDEX idx_gig_version_media__field ON provider.gig_version_media (gig_template_field_id);
COMMENT ON TABLE provider.gig_version_media IS 'The ATTACHMENT of a photo to a Gig version (CAT-004): which asset, which MEDIA field of the EXACT bound template version it satisfies, in which order, with which alt text. Its id is the API media id; the asset id, the object key, the hash and any URL never appear in a default payload. Owned by the VERSION: rows change only while the version is a DRAFT; once it is published, superseded or retired the attachments are frozen history. The same READY asset is re-attached to the next draft without copying the binary. The field must be a MEDIA field of the version''s bound template version that does not prohibit photos (max_items = 0), the asset must belong to the Gig''s account and be UPLOAD_PENDING or READY, and the number of attachments of a field never exceeds its max_items (guard). The template rule (minimum, maximum, required) is read from the template version and never copied. Never truncated.';
COMMENT ON COLUMN provider.gig_version_media.media_asset_id IS 'The asset (restrict). A row referencing an asset keeps it from being abandoned or deleted. Immutable.';
COMMENT ON COLUMN provider.gig_version_media.gig_template_field_id IS 'The MEDIA field of the bound template version this photo satisfies (catalog, restrict). Immutable.';
COMMENT ON COLUMN provider.gig_version_media.display_order IS 'Position among the photos of the version, 1 or more, unique per version (gaps are allowed after a removal). Deferrable (initially immediate) so a whole-order change can swap positions in one transaction.';
COMMENT ON COLUMN provider.gig_version_media.alt_text IS 'Provider plain text description for people who cannot see the image: single line, non-blank when present, at most 500 code points (the configured limit provider.gig.media.alt_text.max_length is lower and is enforced by the service). Editable on a DRAFT only. Never audited or logged.';
-- Index justification (DATA_MODEL_GUARDRAILS rule 11):
--   uq_gig_version_media__order (gig_version_id, display_order): the photos of ONE version in order, the order rule, and the support of the foreign key to the version (leading column); uq_gig_version_media__asset (gig_version_id, media_asset_id): one attachment of an asset per version.
--   idx_gig_version_media__asset (media_asset_id): the support of the foreign key to the asset AND the reference-aware clean-up (is this asset attached anywhere?) and the abandon/delete guards of the asset: without it each such check scans every attachment.
--   idx_gig_version_media__field (gig_template_field_id): the support of the foreign key to the catalogue field. The target IS deleted (replacing a DRAFT template version rewrites its fields: the lesson of the 0020 review), and every such DELETE runs a referential check on this table.

-- =====================================================================================================================
-- 5. guards (all failures are SQLSTATE 23000 with DETAIL provider_rule:<KEY>)
--    Lock order: ACCOUNT (the service locks it FOR UPDATE first), then the Gig, then the VERSION, then the ASSET. Catalogue rows (the structure and the field of a bound template version) are read WITHOUT locks: a bound version is ACTIVE or SUPERSEDED and its structure is frozen by catalog.guard_gig_template_versions, so the catalogue's own order (template, service type, version) is never inverted by these guards (LRN-0059).
-- =====================================================================================================================

-- ------------------------------------------------------------------------------------------ variants and add-ons
CREATE FUNCTION provider.guard_gig_version_options() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_version  uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.gig_version_id ELSE NEW.gig_version_id END;
  v_status   text;
  v_tv       uuid;
  v_allowed  boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['name', 'description', 'price_delta_minor', 'duration_delta_minutes', 'display_order']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['name', 'description', 'price_delta_minor', 'duration_delta_minutes', 'display_order']) THEN
      RAISE EXCEPTION 'the id, the version, the key and the creation time of a variant or an add-on are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:IMMUTABLE_IDENTITY';
    END IF;
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
  -- the permission is a frozen flag of the bound template version (read without a lock, see the lock order above)
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
CREATE TRIGGER trg_gig_version_variants__guard BEFORE INSERT OR UPDATE OR DELETE ON provider.gig_version_variants FOR EACH ROW EXECUTE FUNCTION provider.guard_gig_version_options();
CREATE TRIGGER trg_gig_version_variants__no_truncate BEFORE TRUNCATE ON provider.gig_version_variants FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation();
CREATE TRIGGER trg_gig_version_add_ons__guard BEFORE INSERT OR UPDATE OR DELETE ON provider.gig_version_add_ons FOR EACH ROW EXECUTE FUNCTION provider.guard_gig_version_options();
CREATE TRIGGER trg_gig_version_add_ons__no_truncate BEFORE TRUNCATE ON provider.gig_version_add_ons FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation();
COMMENT ON FUNCTION provider.guard_gig_version_options() IS 'Guard of the variant and add-on tables: rows change (insert, update, delete) only while the parent version is a DRAFT (read FOR SHARE so a concurrent publication serializes); the id, version, key and creation time are immutable; a variant needs a bound template version that permits FIXED_WITH_VARIANTS and an add-on one that has pricing_add_ons (the frozen flags are read without a lock) (VERSION_FROZEN, IMMUTABLE_IDENTITY, VARIANTS_NOT_PERMITTED, ADD_ONS_NOT_PERMITTED). Counts, names and bounds of the configured policy are validated by the service.';

-- ---------------------------------------------------------------------------------------------- media assets
CREATE FUNCTION provider.guard_media_assets() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a_status text;
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
  IF OLD.status IN ('ABANDONED', 'DELETED') THEN
    RAISE EXCEPTION 'an abandoned or deleted asset is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ASSET_FROZEN';
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
  -- this statement holds the row lock of the asset (the row is locked before a BEFORE UPDATE trigger runs), and an attacher holds it FOR SHARE until it commits, so the check below sees every committed attachment
  IF NEW.status IN ('ABANDONED', 'DELETED') AND EXISTS (SELECT 1 FROM provider.gig_version_media WHERE media_asset_id = OLD.media_asset_id) THEN
    RAISE EXCEPTION 'an asset that an attachment references is neither abandoned nor deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ASSET_REFERENCED';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_media_assets__guard BEFORE INSERT OR UPDATE OR DELETE ON provider.media_assets FOR EACH ROW EXECUTE FUNCTION provider.guard_media_assets();
CREATE TRIGGER trg_media_assets__no_truncate BEFORE TRUNCATE ON provider.media_assets FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation();
COMMENT ON FUNCTION provider.guard_media_assets() IS 'Asset guard: created UPLOAD_PENDING for an ACTIVE account (read FOR SHARE); never deleted; id, owner, key, type, size, authorization window and creation time immutable; UPLOAD_PENDING -> READY | ABANDONED and READY -> DELETED only, ABANDONED and DELETED frozen; the bytes facts (hash, dimensions, scan verdict, ready time) of a READY asset immutable; ABANDONED and DELETED are refused while an attachment references the asset (NO_DELETE, MUST_START_PENDING, ACCOUNT_NOT_ACTIVE, IMMUTABLE_IDENTITY, ASSET_FROZEN, BYTES_IMMUTABLE, STATUS_TRANSITION, ASSET_REFERENCED). The attachment guard takes the asset row FOR SHARE and the UPDATE here holds its row lock, so an attach and a sweep cannot race.';

-- ------------------------------------------------------------------------------------------- media attachments
CREATE FUNCTION provider.guard_gig_version_media() RETURNS trigger LANGUAGE plpgsql AS $$
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
  -- the asset belongs to the account of the Gig and is still usable; FOR SHARE keeps the clean-up from deleting it before this transaction commits
  SELECT account_id INTO v_account FROM provider.gigs WHERE gig_id = v_gig;
  SELECT account_id, status INTO a_account, a_status FROM provider.media_assets WHERE media_asset_id = NEW.media_asset_id FOR SHARE;
  IF a_account IS NULL THEN
    RETURN NEW; -- the foreign key reports the missing asset
  END IF;
  IF a_account <> v_account THEN
    RAISE EXCEPTION 'the asset belongs to another account' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ASSET_OWNER';
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
CREATE TRIGGER trg_gig_version_media__guard BEFORE INSERT OR UPDATE OR DELETE ON provider.gig_version_media FOR EACH ROW EXECUTE FUNCTION provider.guard_gig_version_media();
CREATE TRIGGER trg_gig_version_media__no_truncate BEFORE TRUNCATE ON provider.gig_version_media FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation();
COMMENT ON FUNCTION provider.guard_gig_version_media() IS 'Attachment guard: rows change (insert, update, delete) only while the parent version is a DRAFT (the version row is taken FOR NO KEY UPDATE, so concurrent attachments of one version serialize and a concurrent publication waits); id, version, asset, field and creation time immutable; on insert the field belongs to the version''s bound template version, is a MEDIA field and does not prohibit photos, the asset (taken FOR SHARE) belongs to the Gig''s account and is UPLOAD_PENDING or READY, and the field is below its max_items (VERSION_FROZEN, IMMUTABLE_IDENTITY, FIELD_NOT_IN_TEMPLATE_VERSION, FIELD_TYPE_MISMATCH, MEDIA_PROHIBITED, ASSET_OWNER, ASSET_NOT_USABLE, MEDIA_FIELD_FULL). Catalogue facts are read without locks (frozen structure). Minimums are checked at publication.';

-- ------------------------------------------------------------------- publication: the children of the version
CREATE FUNCTION provider.check_gig_version_children(p_version_id uuid, p_template_version_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_variants boolean;
  v_add_ons  boolean;
  f          record;
BEGIN
  SELECT pricing_fixed_with_variants, pricing_add_ons INTO v_variants, v_add_ons FROM catalog.gig_template_versions WHERE gig_template_version_id = p_template_version_id;
  IF v_variants IS NOT TRUE AND EXISTS (SELECT 1 FROM provider.gig_version_variants WHERE gig_version_id = p_version_id) THEN
    RAISE EXCEPTION 'the bound template version does not allow variants' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:VARIANTS_NOT_PERMITTED';
  END IF;
  IF v_add_ons IS NOT TRUE AND EXISTS (SELECT 1 FROM provider.gig_version_add_ons WHERE gig_version_id = p_version_id) THEN
    RAISE EXCEPTION 'the bound template version does not allow add-ons' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ADD_ONS_NOT_PERMITTED';
  END IF;
  IF EXISTS (SELECT 1 FROM provider.gig_version_media m JOIN provider.media_assets a ON a.media_asset_id = m.media_asset_id WHERE m.gig_version_id = p_version_id AND a.status <> 'READY') THEN
    RAISE EXCEPTION 'a photo is not READY' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:MEDIA_NOT_READY';
  END IF;
  FOR f IN
    SELECT tf.behavior, tf.min_items, tf.max_items,
           (SELECT count(*)::integer FROM provider.gig_version_media m WHERE m.gig_version_id = p_version_id AND m.gig_template_field_id = tf.gig_template_field_id) AS n
      FROM catalog.gig_template_fields tf
     WHERE tf.gig_template_version_id = p_template_version_id AND tf.field_type = 'MEDIA'
  LOOP
    IF f.behavior = 'PROVIDER_REQUIRED' AND f.n < COALESCE(f.min_items, 1) THEN
      RAISE EXCEPTION 'a required MEDIA field has fewer photos than its minimum' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:MEDIA_REQUIRED';
    END IF;
    IF f.max_items IS NOT NULL AND f.n > f.max_items THEN
      RAISE EXCEPTION 'a MEDIA field has more photos than its maximum' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:MEDIA_FIELD_FULL';
    END IF;
  END LOOP;
END;
$$;
COMMENT ON FUNCTION provider.check_gig_version_children(uuid, uuid) IS 'Publication backstop for the children of a Gig version, called by the version guard at DRAFT -> PUBLISHED: variants need FIXED_WITH_VARIANTS and add-ons pricing_add_ons on the bound template version (VARIANTS_NOT_PERMITTED, ADD_ONS_NOT_PERMITTED), every attached asset is READY (MEDIA_NOT_READY), every PROVIDER_REQUIRED MEDIA field has at least its min_items photos (MEDIA_REQUIRED) and no MEDIA field exceeds its max_items (MEDIA_FIELD_FULL). Reads the children and the frozen catalogue structure without locks; the version row is already locked by the statement that publishes it, so attachments in flight have either committed or wait.';

-- =====================================================================================================================
-- 5b. the version guard (the body of 0020, final lock order unchanged) now calls the children check at DRAFT -> PUBLISHED
-- =====================================================================================================================
CREATE OR REPLACE FUNCTION provider.guard_gig_versions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g_status    text;
  g_template  uuid;
  v_max       integer;
  v_prev_tv   uuid;
  tv_template uuid;
  tv_status   text;
  t_status    text;
  t_service   uuid;
  st_status   text;
  v_content_changed boolean;
  v_catalog   boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a Gig version is never deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:NO_DELETE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.gig_version_id, NEW.gig_id, NEW.version_number, NEW.gig_template_version_id, NEW.created_at) IS DISTINCT FROM (OLD.gig_version_id, OLD.gig_id, OLD.version_number, OLD.gig_template_version_id, OLD.created_at) THEN
      RAISE EXCEPTION 'the id, the Gig, the number, the template version and the creation time of a version are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:IMMUTABLE_IDENTITY';
    END IF;
  END IF;
  SELECT status, gig_template_id INTO g_status, g_template FROM provider.gigs WHERE gig_id = NEW.gig_id FOR SHARE;
  IF g_status IS NULL THEN
    RETURN NEW; -- the foreign key reports the missing Gig
  END IF;
  -- Catalogue rows are locked only where the answer depends on them (an insert and a publication), in the catalogue's own order: template, service type, template version LAST. The catalogue
  -- service locks a template FOR UPDATE and then its version FOR UPDATE; taking the version first here deadlocked against it. A draft save, a supersession and a retirement need no catalogue lock.
  v_catalog := TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    v_catalog := NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'PUBLISHED';
  END IF;
  IF v_catalog THEN
    SELECT status, service_type_id INTO t_status, t_service FROM catalog.gig_templates WHERE gig_template_id = g_template FOR SHARE;
    SELECT status INTO st_status FROM catalog.service_types WHERE service_type_id = t_service FOR SHARE;
    SELECT gig_template_id, status INTO tv_template, tv_status FROM catalog.gig_template_versions WHERE gig_template_version_id = NEW.gig_template_version_id FOR SHARE;
    IF tv_template IS NULL THEN
      RETURN NEW; -- the foreign key reports the missing template version
    END IF;
    IF tv_template <> g_template THEN
      RAISE EXCEPTION 'the template version does not belong to the template of the Gig' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:TEMPLATE_VERSION_MISMATCH';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.revision <> 1 OR NEW.published_at IS NOT NULL OR NEW.superseded_at IS NOT NULL OR NEW.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'a Gig version starts as a DRAFT at revision 1' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:NEW_NOT_DRAFT';
    END IF;
    IF g_status = 'RETIRED' THEN
      RAISE EXCEPTION 'a retired Gig takes no new version' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:GIG_RETIRED';
    END IF;
    SELECT COALESCE(max(version_number), 0) INTO v_max FROM provider.gig_versions WHERE gig_id = NEW.gig_id;
    IF NEW.version_number <> v_max + 1 THEN
      RAISE EXCEPTION 'version numbers are contiguous: the next version is the highest plus one' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:VERSION_NUMBER';
    END IF;
    IF v_max = 0 THEN
      IF tv_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'the first version binds the ACTIVE template version' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:TEMPLATE_VERSION_NOT_ACTIVE';
      END IF;
      IF t_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'the first version needs an ACTIVE Gig Template' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:TEMPLATE_NOT_ACTIVE';
      END IF;
      IF st_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'the first version needs an ACTIVE service type' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:SERVICE_TYPE_NOT_ACTIVE';
      END IF;
    ELSE
      SELECT gig_template_version_id INTO v_prev_tv FROM provider.gig_versions WHERE gig_id = NEW.gig_id AND version_number = v_max;
      IF NEW.gig_template_version_id <> v_prev_tv THEN
        RAISE EXCEPTION 'a later version binds the same template version as the previous one (no automatic migration)' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:TEMPLATE_VERSION_MISMATCH';
      END IF;
      IF tv_status = 'RETIRED' THEN
        RAISE EXCEPTION 'the bound template version is RETIRED, so no new draft can be started from it' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:TEMPLATE_VERSION_RETIRED';
      END IF;
    END IF;
    PERFORM provider.check_gig_version_content(NEW.gig_id, NEW.gig_template_version_id, NEW.price_amount_minor, NEW.price_currency, NEW.duration_minutes);
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE
  v_content_changed := (NEW.title, NEW.short_pitch, NEW.description, NEW.price_amount_minor, NEW.price_currency, NEW.duration_minutes)
                       IS DISTINCT FROM (OLD.title, OLD.short_pitch, OLD.description, OLD.price_amount_minor, OLD.price_currency, OLD.duration_minutes);

  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'DRAFT' THEN
      IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
        RAISE EXCEPTION 'a published, superseded or retired version is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:VERSION_FROZEN';
      END IF;
      RETURN OLD;
    END IF;
    IF g_status = 'RETIRED' THEN
      RAISE EXCEPTION 'a retired Gig takes no draft change' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:GIG_RETIRED';
    END IF;
    IF (NEW.published_at, NEW.superseded_at, NEW.retired_at) IS DISTINCT FROM (OLD.published_at, OLD.superseded_at, OLD.retired_at) THEN
      RAISE EXCEPTION 'the lifecycle timestamps are maintained by the guard' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:STATUS_TRANSITION';
    END IF;
    IF v_content_changed THEN
      IF NEW.revision <> OLD.revision + 1 THEN
        RAISE EXCEPTION 'a change of the draft content raises the revision by exactly one' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:REVISION';
      END IF;
    ELSE
      IF NEW.revision < OLD.revision OR NEW.revision > OLD.revision + 1 THEN
        RAISE EXCEPTION 'the revision of a draft only grows, by one per save' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:REVISION';
      END IF;
    END IF;
    IF (NEW.price_amount_minor, NEW.price_currency, NEW.duration_minutes) IS DISTINCT FROM (OLD.price_amount_minor, OLD.price_currency, OLD.duration_minutes) THEN
      PERFORM provider.check_gig_version_content(NEW.gig_id, NEW.gig_template_version_id, NEW.price_amount_minor, NEW.price_currency, NEW.duration_minutes);
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- status transition: nothing else changes in the same statement
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('PUBLISHED', 'RETIRED')) OR (OLD.status = 'PUBLISHED' AND NEW.status IN ('SUPERSEDED', 'RETIRED'))) THEN
    RAISE EXCEPTION 'the version status transition is not allowed' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:STATUS_TRANSITION';
  END IF;
  IF v_content_changed OR NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION 'a version cannot change in the statement that publishes, supersedes or retires it' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:VERSION_FROZEN';
  END IF;
  IF NEW.status = 'PUBLISHED' THEN
    IF g_status = 'RETIRED' THEN
      RAISE EXCEPTION 'a retired Gig cannot publish' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:GIG_RETIRED';
    END IF;
    IF tv_status = 'RETIRED' THEN
      RAISE EXCEPTION 'the bound template version is RETIRED and cannot be published against' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:TEMPLATE_VERSION_RETIRED';
    END IF;
    IF t_status = 'RETIRED' THEN
      RAISE EXCEPTION 'the Gig Template is RETIRED and cannot be published against' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:TEMPLATE_RETIRED';
    END IF;
    IF st_status = 'RETIRED' THEN
      RAISE EXCEPTION 'the service type is RETIRED and cannot be published against' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:SERVICE_TYPE_RETIRED';
    END IF;
    PERFORM provider.check_gig_version_content(NEW.gig_id, NEW.gig_template_version_id, NEW.price_amount_minor, NEW.price_currency, NEW.duration_minutes);
    -- CAT-004: the variants, add-ons and photos of the version (permissions, every photo READY, every required MEDIA field at its minimum); the catalogue rows were locked above in the catalogue's order
    PERFORM provider.check_gig_version_children(NEW.gig_version_id, NEW.gig_template_version_id);
    NEW.published_at := now();
    NEW.superseded_at := NULL;
    NEW.retired_at := NULL;
  ELSIF NEW.status = 'SUPERSEDED' THEN
    IF NOT EXISTS (SELECT 1 FROM provider.gig_versions WHERE gig_id = NEW.gig_id AND version_number > OLD.version_number AND status = 'DRAFT') THEN
      RAISE EXCEPTION 'a version is superseded only by the publication of a newer draft' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:NO_NEWER_VERSION';
    END IF;
    NEW.superseded_at := now();
    NEW.retired_at := NULL;
  ELSE
    IF g_status <> 'RETIRED' THEN
      RAISE EXCEPTION 'a version is retired only together with its Gig' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:GIG_NOT_RETIRED';
    END IF;
    NEW.retired_at := now();
    NEW.superseded_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION provider.guard_gig_versions() IS 'Version guard. INSERT: a DRAFT at revision 1 with the next contiguous number on a Gig that is not RETIRED; the template version belongs to the Gig''s template; version 1 binds the ACTIVE template version of an ACTIVE template under an ACTIVE service type, a later version binds the SAME template version as the previous one and that version is not RETIRED. UPDATE: identity immutable; a DRAFT changes content with revision +1 (price/duration re-checked); DRAFT -> PUBLISHED needs a Gig that is not retired and a template version, template and service type that are not RETIRED (all FOR SHARE) and the content rules, and freezes the content; PUBLISHED -> SUPERSEDED only while a newer draft exists; DRAFT | PUBLISHED -> RETIRED only after the Gig is RETIRED; every other change is refused; timestamps maintained; never deleted (NO_DELETE, TEMPLATE_VERSION_MISMATCH, NEW_NOT_DRAFT, GIG_RETIRED, VERSION_NUMBER, TEMPLATE_VERSION_NOT_ACTIVE, TEMPLATE_NOT_ACTIVE, SERVICE_TYPE_NOT_ACTIVE, TEMPLATE_VERSION_RETIRED, IMMUTABLE_IDENTITY, VERSION_FROZEN, STATUS_TRANSITION, REVISION, TEMPLATE_RETIRED, SERVICE_TYPE_RETIRED, NO_NEWER_VERSION, GIG_NOT_RETIRED, plus the content rules of provider.check_gig_version_content and, since CAT-004, the rules of provider.check_gig_version_children at publication: VARIANTS_NOT_PERMITTED, ADD_ONS_NOT_PERMITTED, MEDIA_NOT_READY, MEDIA_REQUIRED, MEDIA_FIELD_FULL). Catalogue rows are locked FOR SHARE only on an insert and a publication, in the order template, service type, template version (the catalogue service''s own order, which avoids a deadlock with it).';

-- =====================================================================================================================
-- 6. audit: eight new actions (the immutability triggers are untouched)
-- =====================================================================================================================
ALTER TABLE provider.gig_audit_events DROP CONSTRAINT ck_gig_audit_events__action;
ALTER TABLE provider.gig_audit_events ADD CONSTRAINT ck_gig_audit_events__action CHECK (action IN (
  'GIG_CREATED', 'GIG_DRAFT_CREATED', 'GIG_DRAFT_UPDATED', 'GIG_VERSION_PUBLISHED', 'GIG_VERSION_SUPERSEDED', 'GIG_RETIRED',
  'GIG_VARIANTS_UPDATED', 'GIG_ADD_ONS_UPDATED', 'GIG_MEDIA_UPLOAD_AUTHORIZED', 'GIG_MEDIA_UPLOAD_REFUSED', 'GIG_MEDIA_ATTACHED', 'GIG_MEDIA_DETACHED', 'GIG_MEDIA_REORDERED', 'GIG_MEDIA_UPDATED'));
COMMENT ON TABLE provider.gig_audit_events IS 'Append-only audit trail of the Gigs (CAT-003, CAT-004): who (account:<id> or system:<name>, never a token), what, when, the owning account and Gig (and the version when one is concerned), the field-level diff (a JSON object of identifiers, changed field NAMES, counts and reason CODES, never provider text, never an amount, never an object key, a hash, a URL or an alt text) and the correlation id. CAT-004 adds GIG_VARIANTS_UPDATED, GIG_ADD_ONS_UPDATED, GIG_MEDIA_UPLOAD_AUTHORIZED, GIG_MEDIA_UPLOAD_REFUSED, GIG_MEDIA_ATTACHED, GIG_MEDIA_DETACHED, GIG_MEDIA_REORDERED and GIG_MEDIA_UPDATED. Reads are never audited. Rows are immutable and never truncated. The account and Gig of a row must agree with each other (guard). The account column is the owner at the time of the event, kept so the trail can be read per account without a join through a Gig.';

-- =====================================================================================================================
-- 7. seed: the variant, add-on and media policy (CFG-001), through the real configuration lifecycle
--    Typed values at PLATFORM scope, read fresh by the service, no code default (a missing or invalid value fails closed). STANDARD criticality: operational policy, not a legal requirement.
--    The bounds of the definitions mirror the structural ceilings of the contract and of the CHECK constraints above (100 items, name 200, description 2000, 26214400 bytes, 30000 pixels, 200 photos).
--    5 and 6: PRD PR-03.07 (10 MB per file, 50 photos per Gig). Every other value is a CAT-004 ENGINEERING ASSUMPTION (the PRD gives none); see the header.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_approver    constant text := 'system:migration-review';
  v_correlation constant text := 'seed-0021';
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
      (1, 'provider.gig.variant.max_count', 'INTEGER', 'variants', 'Maximum number of variants one Gig version can hold', '{"min": 0, "max": 100}'::jsonb,
          '10'::jsonb, 'CAT-004 engineering assumption, not in the PRD (bounds the size of a Gig; 0 switches variants off)'),
      (2, 'provider.gig.add_on.max_count', 'INTEGER', 'add-ons', 'Maximum number of add-ons one Gig version can hold', '{"min": 0, "max": 100}'::jsonb,
          '20'::jsonb, 'CAT-004 engineering assumption, not in the PRD (bounds the size of a Gig; 0 switches add-ons off)'),
      (3, 'provider.gig.option.name.max_length', 'INTEGER', 'characters', 'Maximum length of the name of a variant or an add-on, in characters (Unicode code points)', '{"min": 1, "max": 200}'::jsonb,
          '80'::jsonb, 'CAT-004 engineering assumption, not in the PRD (structural ceiling 200)'),
      (4, 'provider.gig.option.description.max_length', 'INTEGER', 'characters', 'Maximum length of the description of a variant or an add-on, in characters (Unicode code points)', '{"min": 1, "max": 2000}'::jsonb,
          '500'::jsonb, 'CAT-004 engineering assumption, not in the PRD (structural ceiling 2000)'),
      (5, 'provider.gig.media.max_file_size_bytes', 'INTEGER', 'bytes', 'Maximum size of one uploaded Gig photo, in bytes (the whole file is read into memory to be verified, so the ceiling is 25 MiB)', '{"min": 1, "max": 26214400}'::jsonb,
          '10485760'::jsonb, 'PRD PR-03.07: media.max_file_mb, 10 MB per photo'),
      (6, 'provider.gig.media.max_items', 'INTEGER', 'photos', 'Maximum number of photos one Gig version can hold in total, across all its MEDIA fields (a template field may allow fewer)', '{"min": 0, "max": 200}'::jsonb,
          '50'::jsonb, 'PRD PR-03.07: media.max_photos_per_gig, 50 photos per Gig'),
      (7, 'provider.gig.media.allowed_mime_types', 'JSON', NULL::text, 'Content types a Gig photo can have: a subset of image/jpeg, image/png and image/webp, the types the platform can verify by signature and header (HEIC is not accepted yet, SVG never)',
          '{"schema": {"type": "array", "items": {"type": "string", "enum": ["image/jpeg", "image/png", "image/webp"]}, "uniqueItems": true, "minItems": 1, "maxItems": 3}}'::jsonb,
          '["image/jpeg", "image/png", "image/webp"]'::jsonb, 'CAT-004: the PRD default also lists HEIC, which is deferred until a verified reader exists (owner decision, debt)'),
      (8, 'provider.gig.media.upload_ttl_seconds', 'INTEGER', 'seconds', 'How long an authorized photo upload stays valid before it is closed and its object removed', '{"min": 30, "max": 3600}'::jsonb,
          '900'::jsonb, 'CAT-004 engineering assumption, not in the PRD (same order of magnitude as the verification evidence upload)'),
      (9, 'provider.gig.media.require_clean_scan', 'BOOLEAN', NULL::text, 'Whether a photo is attached only after a malware scan returned CLEAN (true: a scanner error or the absence of a scanner keeps the photo pending)', '{}'::jsonb,
          'true'::jsonb, 'CAT-004 engineering assumption (fail closed: production has no scanner yet, so nothing can be attached there until one exists)'),
      (10, 'provider.gig.media.min_edge_pixels', 'INTEGER', 'pixels', 'Minimum length of the shorter side of a Gig photo, in pixels, read from the image header', '{"min": 1, "max": 30000}'::jsonb,
          '200'::jsonb, 'CAT-004 engineering assumption, not in the PRD (rejects thumbnails and tracking pixels)'),
      (11, 'provider.gig.media.max_edge_pixels', 'INTEGER', 'pixels', 'Maximum length of either side of a Gig photo, in pixels, read from the image header', '{"min": 1, "max": 30000}'::jsonb,
          '12000'::jsonb, 'CAT-004 engineering assumption, not in the PRD (decompression-bomb bound, structural ceiling 30000)'),
      (12, 'provider.gig.media.max_pixels', 'INTEGER', 'pixels', 'Maximum number of pixels (width times height) of a Gig photo, read from the image header', '{"min": 1, "max": 400000000}'::jsonb,
          '50000000'::jsonb, 'CAT-004 engineering assumption, not in the PRD (decompression-bomb bound; the image is never decoded by the platform)'),
      (13, 'provider.gig.media.download_ttl_seconds', 'INTEGER', 'seconds', 'How long the short-lived preview link of a photo, given only to its owner, stays valid', '{"min": 5, "max": 600}'::jsonb,
          '60'::jsonb, 'CAT-004 engineering assumption, not in the PRD'),
      (14, 'provider.gig.media.orphan_grace_seconds', 'INTEGER', 'seconds', 'How long a READY photo that no Gig version references is kept before its bytes are removed by the clean-up job (measured from the time it became READY)', '{"min": 60, "max": 2592000}'::jsonb,
          '86400'::jsonb, 'CAT-004 engineering assumption, not in the PRD'),
      (15, 'provider.gig.media.alt_text.max_length', 'INTEGER', 'characters', 'Maximum length of the alt text of a Gig photo, in characters (Unicode code points)', '{"min": 1, "max": 500}'::jsonb,
          '200'::jsonb, 'CAT-004 engineering assumption, not in the PRD (structural ceiling 500)')
    ) AS t (ord, key, data_type, unit, description, rules, value, basis)
    ORDER BY ord
  LOOP
    v_reason := 'Initial value (migration 0021): ' || v_seed.basis;
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
    VALUES (v_request, v_approver, 'APPROVE', 'Initial value reviewed with the migration (CAT-004)');
    UPDATE configuration.change_requests SET state = 'APPROVED', updated_at = now() WHERE change_request_id = v_request AND state = 'PENDING_APPROVAL';
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, change_request_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_approver, 'CHANGE_APPROVED', v_parameter, v_request, 'Initial value reviewed with the migration (CAT-004)', v_correlation);

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
-- 8. seed: the copy of the variants, add-ons and photos flow (CFG-002), through the real content lifecycle (en-US only)
--    One message per NEW issue reason (19) and per NEW error code (4) of the Gig contract, and the labels, hints, notices and menu words of the TEMPORARY minimal editor (49);
--    NO LEGAL TEXT and NO provider text. No variables (numbers and limits are rendered next to the words by the page), no personal data.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0021';
  v_reason      constant text := 'Initial provider Gig variants, add-ons and photos copy (migration 0021)';
  v_seed        record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1, 'PLAIN_TEXT', 'provider.gig.issue.options_not_permitted', 'Gig copy: issue.options_not_permitted', 'This template does not allow this kind of option.'),
      (2, 'PLAIN_TEXT', 'provider.gig.issue.options_count_exceeded', 'Gig copy: issue.options_count_exceeded', 'There are too many items in this list.'),
      (3, 'PLAIN_TEXT', 'provider.gig.issue.option_name_required', 'Gig copy: issue.option_name_required', 'Give every item a name.'),
      (4, 'PLAIN_TEXT', 'provider.gig.issue.option_name_too_long', 'Gig copy: issue.option_name_too_long', 'A name is too long.'),
      (5, 'PLAIN_TEXT', 'provider.gig.issue.option_name_duplicate', 'Gig copy: issue.option_name_duplicate', 'Two items have the same name. Give each item a different name.'),
      (6, 'PLAIN_TEXT', 'provider.gig.issue.option_description_too_long', 'Gig copy: issue.option_description_too_long', 'A description is too long.'),
      (7, 'PLAIN_TEXT', 'provider.gig.issue.option_price_delta_invalid', 'Gig copy: issue.option_price_delta_invalid', 'The extra price must be zero or more, in the smallest unit of your currency.'),
      (8, 'PLAIN_TEXT', 'provider.gig.issue.option_duration_delta_invalid', 'Gig copy: issue.option_duration_delta_invalid', 'The extra time must be zero or more minutes.'),
      (9, 'PLAIN_TEXT', 'provider.gig.issue.option_key_invalid', 'Gig copy: issue.option_key_invalid', 'One of the items is not recognised. Reload the page and try again.'),
      (10, 'PLAIN_TEXT', 'provider.gig.issue.option_key_duplicate', 'Gig copy: issue.option_key_duplicate', 'The same item appears twice. Reload the page and try again.'),
      (11, 'PLAIN_TEXT', 'provider.gig.issue.media_not_permitted', 'Gig copy: issue.media_not_permitted', 'This template does not allow photos here.'),
      (12, 'PLAIN_TEXT', 'provider.gig.issue.media_required', 'Gig copy: issue.media_required', 'Add the photos this template requires.'),
      (13, 'PLAIN_TEXT', 'provider.gig.issue.media_too_many', 'Gig copy: issue.media_too_many', 'There are more photos than this field allows.'),
      (14, 'PLAIN_TEXT', 'provider.gig.issue.media_total_exceeded', 'Gig copy: issue.media_total_exceeded', 'There are more photos than a Gig allows in total.'),
      (15, 'PLAIN_TEXT', 'provider.gig.issue.media_not_ready', 'Gig copy: issue.media_not_ready', 'A photo has not finished uploading. Finish or remove it.'),
      (16, 'PLAIN_TEXT', 'provider.gig.issue.media_field_unknown', 'Gig copy: issue.media_field_unknown', 'That photo field is not part of the template.'),
      (17, 'PLAIN_TEXT', 'provider.gig.issue.media_alt_too_long', 'Gig copy: issue.media_alt_too_long', 'The photo description is too long.'),
      (18, 'PLAIN_TEXT', 'provider.gig.issue.media_order_invalid', 'Gig copy: issue.media_order_invalid', 'The photo order is not valid. Reload the page and try again.'),
      (19, 'PLAIN_TEXT', 'provider.gig.issue.field_media_not_a_value', 'Gig copy: issue.field_media_not_a_value', 'Photos are added with the photo upload, not as a value.'),
      (20, 'PLAIN_TEXT', 'provider.gig.error.media_not_found', 'Gig copy: error.media_not_found', 'We could not find that photo.'),
      (21, 'PLAIN_TEXT', 'provider.gig.error.media_refused', 'Gig copy: error.media_refused', 'That file cannot be used. Check its type, size and dimensions and try another file.'),
      (22, 'PLAIN_TEXT', 'provider.gig.error.media_expired', 'Gig copy: error.media_expired', 'The upload window has closed. Start the upload again.'),
      (23, 'PLAIN_TEXT', 'provider.gig.error.media_scan_unavailable', 'Gig copy: error.media_scan_unavailable', 'We could not check the file just now. Try again in a moment.'),
      (24, 'UI_LABEL', 'provider.gig.options.variants.heading', 'Gig copy: options.variants.heading', 'Variants'),
      (25, 'PLAIN_TEXT', 'provider.gig.options.variants.intro', 'Gig copy: options.variants.intro', 'Variants are alternatives of the same service, such as a size. A customer picks one. Your Gig price is the base, so the base is the cheapest option.'),
      (26, 'UI_LABEL', 'provider.gig.options.add_ons.heading', 'Gig copy: options.add_ons.heading', 'Add-ons'),
      (27, 'PLAIN_TEXT', 'provider.gig.options.add_ons.intro', 'Gig copy: options.add_ons.intro', 'Add-ons are optional extras a customer can add to the service. Each one adds to the base price.'),
      (28, 'PLAIN_TEXT', 'provider.gig.options.empty', 'Gig copy: options.empty', 'Nothing added yet.'),
      (29, 'PLAIN_TEXT', 'provider.gig.options.not_permitted', 'Gig copy: options.not_permitted', 'This template does not allow this here.'),
      (30, 'UI_LABEL', 'provider.gig.options.name', 'Gig copy: options.name', 'Name'),
      (31, 'UI_LABEL', 'provider.gig.options.description', 'Gig copy: options.description', 'Description (optional)'),
      (32, 'UI_LABEL', 'provider.gig.options.price_delta', 'Gig copy: options.price_delta', 'Extra price'),
      (33, 'UI_LABEL', 'provider.gig.options.duration_delta', 'Gig copy: options.duration_delta', 'Extra minutes'),
      (34, 'UI_LABEL', 'provider.gig.options.add', 'Gig copy: options.add', 'Add another'),
      (35, 'UI_LABEL', 'provider.gig.options.remove', 'Gig copy: options.remove', 'Remove'),
      (36, 'UI_LABEL', 'provider.gig.options.move_up', 'Gig copy: options.move_up', 'Move up'),
      (37, 'UI_LABEL', 'provider.gig.options.move_down', 'Gig copy: options.move_down', 'Move down'),
      (38, 'UI_LABEL', 'provider.gig.options.save', 'Gig copy: options.save', 'Save'),
      (39, 'PLAIN_TEXT', 'provider.gig.options.limit_note', 'Gig copy: options.limit_note', 'You can add only so many items. The limit is shown next to this list.'),
      (40, 'PLAIN_TEXT', 'provider.gig.options.delta_note', 'Gig copy: options.delta_note', 'The extra price and the extra minutes are added to the base price and duration. Use the smallest unit of your currency, for example cents. Zero means no change.'),
      (41, 'UI_LABEL', 'provider.gig.media.heading', 'Gig copy: media.heading', 'Photos'),
      (42, 'PLAIN_TEXT', 'provider.gig.media.intro', 'Gig copy: media.intro', 'Add photos of your work. Only you can see a photo until the Gig is published, and a published version keeps the photos it had.'),
      (43, 'UI_LABEL', 'provider.gig.media.rule_required', 'Gig copy: media.rule_required', 'Required'),
      (44, 'UI_LABEL', 'provider.gig.media.rule_optional', 'Gig copy: media.rule_optional', 'Optional'),
      (45, 'PLAIN_TEXT', 'provider.gig.media.rule_prohibited', 'Gig copy: media.rule_prohibited', 'Photos are not available for this field.'),
      (46, 'PLAIN_TEXT', 'provider.gig.media.no_field', 'Gig copy: media.no_field', 'This template has no photo field, so photos are not available.'),
      (47, 'UI_LABEL', 'provider.gig.media.count', 'Gig copy: media.count', 'Photos added'),
      (48, 'UI_LABEL', 'provider.gig.media.status_uploading', 'Gig copy: media.status_uploading', 'Uploading'),
      (49, 'UI_LABEL', 'provider.gig.media.status_ready', 'Gig copy: media.status_ready', 'Ready'),
      (50, 'UI_LABEL', 'provider.gig.media.upload', 'Gig copy: media.upload', 'Upload photo'),
      (51, 'UI_LABEL', 'provider.gig.media.file', 'Gig copy: media.file', 'Photo file'),
      (52, 'UI_LABEL', 'provider.gig.media.alt_text', 'Gig copy: media.alt_text', 'Photo description'),
      (53, 'PLAIN_TEXT', 'provider.gig.media.alt_hint', 'Gig copy: media.alt_hint', 'Describe the photo for people who cannot see it. Plain text only.'),
      (54, 'UI_LABEL', 'provider.gig.media.save_alt', 'Gig copy: media.save_alt', 'Save description'),
      (55, 'UI_LABEL', 'provider.gig.media.remove', 'Gig copy: media.remove', 'Remove photo'),
      (56, 'UI_LABEL', 'provider.gig.media.move_up', 'Gig copy: media.move_up', 'Move photo up'),
      (57, 'UI_LABEL', 'provider.gig.media.move_down', 'Gig copy: media.move_down', 'Move photo down'),
      (58, 'UI_LABEL', 'provider.gig.media.finish', 'Gig copy: media.finish', 'Finish upload'),
      (59, 'UI_LABEL', 'provider.gig.media.preview', 'Gig copy: media.preview', 'Preview'),
      (60, 'PLAIN_TEXT', 'provider.gig.media.types_note', 'Gig copy: media.types_note', 'Accepted file types are shown next to the upload form. Other types are refused.'),
      (61, 'PLAIN_TEXT', 'provider.gig.media.size_note', 'Gig copy: media.size_note', 'The largest file size allowed is shown next to the upload form.'),
      (62, 'PLAIN_TEXT', 'provider.gig.media.unavailable', 'Gig copy: media.unavailable', 'Photo upload is not available right now. Try again later.'),
      (63, 'UI_LABEL', 'provider.gig.menu.variants', 'Gig copy: menu.variants', 'Variants'),
      (64, 'UI_LABEL', 'provider.gig.menu.add_ons', 'Gig copy: menu.add_ons', 'Add-ons'),
      (65, 'UI_LABEL', 'provider.gig.menu.photos', 'Gig copy: menu.photos', 'Photos'),
      (66, 'PLAIN_TEXT', 'provider.gig.menu.photos_missing', 'Gig copy: menu.photos_missing', 'Photos are still needed before this can be published.'),
      (67, 'PLAIN_TEXT', 'provider.gig.notice.variants_saved', 'Gig copy: notice.variants_saved', 'Your variants were saved.'),
      (68, 'PLAIN_TEXT', 'provider.gig.notice.add_ons_saved', 'Gig copy: notice.add_ons_saved', 'Your add-ons were saved.'),
      (69, 'PLAIN_TEXT', 'provider.gig.notice.photo_added', 'Gig copy: notice.photo_added', 'Your photo was added.'),
      (70, 'PLAIN_TEXT', 'provider.gig.notice.photo_removed', 'Gig copy: notice.photo_removed', 'Your photo was removed.'),
      (71, 'PLAIN_TEXT', 'provider.gig.notice.photo_order_saved', 'Gig copy: notice.photo_order_saved', 'The photo order was saved.'),
      (72, 'PLAIN_TEXT', 'provider.gig.notice.photo_saved', 'Gig copy: notice.photo_saved', 'Your photo description was saved.')
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

