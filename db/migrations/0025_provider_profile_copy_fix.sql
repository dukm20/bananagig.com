-- checkpoint: PRO-002
-- purpose: forward content-only addition after the independent reviews of 0024 (0024 is applied and never edited): seven new en-US PLATFORM copy entries for the provider public profile pages, written through the REAL content lifecycle (the sequence ContentService.publish performs for an approval policy NONE entry: ENTRY_CREATED, DRAFT, APPROVED, PUBLISHED, ACTIVATED, with the same audit rows as 0024). They say (1) that a public profile is not a booking page and that the prices shown are base prices (`provider.profile.public.not_bookable_note`), (2) the link to the owner's public page (`provider.profile.visibility.view_public`), (3) that published Gigs and verification badges also appear on the public profile (`provider.profile.visibility.also_shown_note`), (4) the two checklist headings that separate what is NEEDED to make the profile public from what is only SHOWN when it exists (`provider.profile.readiness.required_heading`, `provider.profile.readiness.shown_heading`), (5) that unsaved text is lost when the owner uploads a photo or changes visibility (`provider.profile.visibility.save_first_note`) and (6) the message of the page when the provider registration is not finished (`provider.profile.error.page_unavailable_registration`). No existing entry is changed or deleted; no table, column, constraint, index, function or trigger changes
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. Content versions are immutable history: a correction of any of these texts is a version 2 of the entry, never an edit of this file or of a version
-- backfill: none. The seven entries are new
-- risk: low. Data only. The content guards and the audit trail apply exactly as for the service. A deployed cache that already negative-cached a missing key is stale until it expires or is invalidated (the migration cannot reach the cache); the web omits a line whose key is missing
-- destructive: none
-- events: none (seeds run before any consumer exists, as in every earlier seed); the content resolver reads the tables
-- audit: content.audit_events rows with correlation seed-0025, the same actions the service writes (ENTRY_CREATED, VERSION_DRAFTED, VERSION_APPROVED, VERSION_PUBLISHED, VERSION_ACTIVATED)
-- DECISIONS: (1) wording rule of 0024 kept: say what the platform does and no more; the prices of a Gig are base prices (the price with no variant selected) and Booking is stated as not open, so the public page never promises a bookable price; (2) the registration message repeats the wording of `provider.profile.error.provider_not_eligible` on purpose under its own key: the page copy is chosen by the page, the error copy by the error code, and either can be reworded alone; (3) no variables, no numbers, no markup, no personal data

DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0025';
  v_reason      constant text := 'Provider public profile copy added after review (migration 0025)';
  v_seed        record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1, 'PLAIN_TEXT', 'provider.profile.public.not_bookable_note', 'Profile copy: public.not_bookable_note', 'Booking is not open yet. The prices shown are base prices and can change.'),
      (2, 'UI_LABEL', 'provider.profile.visibility.view_public', 'Profile copy: visibility.view_public', 'View your public page'),
      (3, 'PLAIN_TEXT', 'provider.profile.visibility.also_shown_note', 'Profile copy: visibility.also_shown_note', 'Your published Gigs and verification badges also appear on your public profile.'),
      (4, 'UI_LABEL', 'provider.profile.readiness.required_heading', 'Profile copy: readiness.required_heading', 'Needed to make your profile public'),
      (5, 'UI_LABEL', 'provider.profile.readiness.shown_heading', 'Profile copy: readiness.shown_heading', 'Shown on your profile when you have them'),
      (6, 'PLAIN_TEXT', 'provider.profile.visibility.save_first_note', 'Profile copy: visibility.save_first_note', 'Save your name and bio before you upload a photo or change who can see your profile. Unsaved text is not kept.'),
      (7, 'PLAIN_TEXT', 'provider.profile.error.page_unavailable_registration', 'Profile copy: error.page_unavailable_registration', 'Finish your provider registration before you set up a public profile.')
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
