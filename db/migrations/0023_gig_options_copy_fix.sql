-- checkpoint: CAT-004
-- purpose: correct seeded copy of 0021 through the REAL content lifecycle and add the copy for the reasons a photo can be refused. (1) `provider.gig.options.variants.intro` said "A customer picks one. Your Gig price is the base, so the base is the cheapest option." That is not an enforced invariant: the base is the price with no variant selected, a variant adds a non-negative difference (which may be zero), and whether a booking must pick a variant is a booking rule. A corrected version 2 of the entry is created (DRAFT, APPROVED, closed version 1 at its start, PUBLISHED, version 1 SUPERSEDED), exactly the sequence ContentService.publish performs, with the same audit rows; version 1 keeps its body (content versions are immutable history). Every other body of 0021 was reviewed for "cheapest", "lowest", "from" and similar claims and none other makes one. (2) Thirteen new entries `provider.gig.media.refused.<reason lower>`, one per reason of a refused photo upload (MIME_NOT_ALLOWED, FILE_TOO_LARGE, SIZE_MISMATCH, CONTENT_TYPE_MISMATCH, SIGNATURE_MISMATCH, HASH_MISMATCH, OBJECT_MISSING, OBJECT_CHANGED, IMAGE_INVALID, IMAGE_TOO_SMALL, IMAGE_TOO_LARGE, SCAN_INFECTED, UPLOAD_EXPIRED): calm, actionable plain English, no numbers, no variables, no provider text. No table, column or constraint changes.
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. Content versions are immutable history: a further correction is a version 3, never an edit of this file or of a version
-- backfill: none. The one corrected entry gets a second version; its first version stays SUPERSEDED with its effective period closed at the start of the second
-- risk: low. Data only. The content guards, the no-overlap exclusion constraint (version 1 is closed at the instant version 2 starts, [from, to) ranges that touch do not overlap) and the audit trail apply exactly as for the service. A deployed cache of the entry is stale until it expires or is invalidated (the migration cannot reach the cache): `provider.gig.options.variants.intro` and the thirteen new keys are read through the content resolver
-- destructive: none
-- events: none (seeds run before any consumer exists, as in every earlier seed); the content resolver reads the tables
-- audit: content.audit_events rows with correlation seed-0023, the same actions the service writes (VERSION_DRAFTED, VERSION_APPROVED, VERSION_PUBLISHED, VERSION_ACTIVATED, VERSION_SUPERSEDED, ENTRY_CREATED)
-- DECISIONS: (1) the pattern is the content service's own publish sequence for an approval policy NONE entry, in SQL: lock the entry, find the head version of (entry, en-US, PLATFORM), insert version head+1 as DRAFT with effective_from = the instant of the migration step, APPROVED, close the head at that same instant (the guard only allows closing at or after the transaction start), PUBLISHED, then the head SUPERSEDED; (2) the new key pattern is `provider.gig.media.refused.<reason lower>` where <reason> is the code of a refused upload; the web maps a reason code to this key and omits the line if the key is missing

DO $seed$
DECLARE
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0023';
  v_reason      constant text := 'Copy correction (migration 0023): the base price is the price with no variant selected, not a promise that it is the cheapest option';
  v_fix         record;
  v_entry       uuid;
  v_head        record;
  v_start       timestamptz;
  v_new         uuid;
BEGIN
  FOR v_fix IN
    SELECT * FROM (VALUES
      ('provider.gig.options.variants.intro', 'Variants are alternatives the customer chooses between. The price of a variant is your Gig price plus the difference you set; leave the difference at 0 for the option that costs the base price.')
    ) AS t (key, body)
  LOOP
    SELECT entry_id INTO v_entry FROM content.entries WHERE key = v_fix.key FOR UPDATE;
    IF v_entry IS NULL THEN
      RAISE EXCEPTION 'content entry % does not exist', v_fix.key;
    END IF;
    SELECT version_id, version, status, effective_from, effective_to INTO v_head
      FROM content.versions
     WHERE entry_id = v_entry AND locale = 'en-US' AND scope_type = 'PLATFORM' AND scope_ref IS NULL AND status IN ('SCHEDULED', 'PUBLISHED', 'SUPERSEDED')
     ORDER BY version DESC LIMIT 1 FOR UPDATE;
    IF v_head.version_id IS NULL OR v_head.status <> 'PUBLISHED' OR v_head.effective_to IS NOT NULL THEN
      RAISE EXCEPTION 'content entry % has no open PUBLISHED head version to correct', v_fix.key;
    END IF;
    v_start := clock_timestamp();
    INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, status, approval_policy, effective_from, reason, created_by)
    VALUES (v_entry, 'en-US', 'PLATFORM', NULL, v_head.version + 1, v_fix.body, 'DRAFT', 'NONE', v_start, v_reason, v_actor)
    RETURNING version_id INTO v_new;
    INSERT INTO content.audit_events (occurred_at, actor, action, entry_id, version_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'VERSION_DRAFTED', v_entry, v_new, v_reason, v_correlation);
    UPDATE content.versions SET status = 'APPROVED', updated_at = now() WHERE version_id = v_new AND status = 'DRAFT';
    INSERT INTO content.audit_events (occurred_at, actor, action, entry_id, version_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'VERSION_APPROVED', v_entry, v_new, v_reason, v_correlation);
    UPDATE content.versions SET effective_to = v_start, updated_at = now() WHERE version_id = v_head.version_id;
    UPDATE content.versions SET status = 'PUBLISHED', updated_at = now() WHERE version_id = v_new AND status = 'APPROVED';
    INSERT INTO content.audit_events (occurred_at, actor, action, entry_id, version_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'VERSION_PUBLISHED', v_entry, v_new, v_reason, v_correlation);
    INSERT INTO content.audit_events (occurred_at, actor, action, entry_id, version_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'VERSION_ACTIVATED', v_entry, v_new, v_reason, v_correlation);
    UPDATE content.versions SET status = 'SUPERSEDED', updated_at = now() WHERE version_id = v_head.version_id AND status = 'PUBLISHED';
    INSERT INTO content.audit_events (occurred_at, actor, action, entry_id, version_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'VERSION_SUPERSEDED', v_entry, v_head.version_id, 'superseded by version ' || (v_head.version + 1), v_correlation);
  END LOOP;
END
$seed$;

-- the copy for the reasons a photo upload is refused (en-US, no variables, no numbers), through the real content lifecycle
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0023';
  v_reason      constant text := 'Initial photo refusal copy (migration 0023)';
  v_seed        record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1, 'PLAIN_TEXT', 'provider.gig.media.refused.mime_not_allowed', 'Gig copy: media.refused.mime_not_allowed', 'This kind of file is not accepted. Use a JPEG, PNG or WebP photo.'),
      (2, 'PLAIN_TEXT', 'provider.gig.media.refused.file_too_large', 'Gig copy: media.refused.file_too_large', 'This file is too large. Choose a smaller photo or reduce its size.'),
      (3, 'PLAIN_TEXT', 'provider.gig.media.refused.size_mismatch', 'Gig copy: media.refused.size_mismatch', 'The file we received is not the file you chose. Try uploading it again.'),
      (4, 'PLAIN_TEXT', 'provider.gig.media.refused.content_type_mismatch', 'Gig copy: media.refused.content_type_mismatch', 'The type of the file does not match what you chose. Try uploading it again.'),
      (5, 'PLAIN_TEXT', 'provider.gig.media.refused.signature_mismatch', 'Gig copy: media.refused.signature_mismatch', 'This file does not look like a real photo of the type it claims to be. Choose a JPEG, PNG or WebP photo.'),
      (6, 'PLAIN_TEXT', 'provider.gig.media.refused.hash_mismatch', 'Gig copy: media.refused.hash_mismatch', 'The file changed while it was uploading. Try uploading it again.'),
      (7, 'PLAIN_TEXT', 'provider.gig.media.refused.object_missing', 'Gig copy: media.refused.object_missing', 'We did not receive your file. Try uploading it again, or remove this photo.'),
      (8, 'PLAIN_TEXT', 'provider.gig.media.refused.object_changed', 'Gig copy: media.refused.object_changed', 'The file changed after it was uploaded, so we did not keep it. Try uploading it again.'),
      (9, 'PLAIN_TEXT', 'provider.gig.media.refused.image_invalid', 'Gig copy: media.refused.image_invalid', 'We could not read this image. Choose a different photo.'),
      (10, 'PLAIN_TEXT', 'provider.gig.media.refused.image_too_small', 'Gig copy: media.refused.image_too_small', 'This photo is too small. Choose a larger photo.'),
      (11, 'PLAIN_TEXT', 'provider.gig.media.refused.image_too_large', 'Gig copy: media.refused.image_too_large', 'This photo has too many pixels. Choose a smaller photo or reduce its dimensions.'),
      (12, 'PLAIN_TEXT', 'provider.gig.media.refused.scan_infected', 'Gig copy: media.refused.scan_infected', 'This file did not pass our safety check, so we did not keep it. Choose a different file.'),
      (13, 'PLAIN_TEXT', 'provider.gig.media.refused.upload_expired', 'Gig copy: media.refused.upload_expired', 'The upload took too long and has expired. Start the upload again.')
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
