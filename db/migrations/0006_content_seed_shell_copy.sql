-- checkpoint: CFG-002
-- purpose: seed the representative product-shell copy (brand, sign-in/out actions, session status, home confirmation, sign-in error) as managed content entries with one PUBLISHED en-US version each
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. Published versions and audit rows are immutable, so a wording change is a NEW version published through the content lifecycle, never an edit of this file
-- backfill: none; this migration creates the first content rows and nothing existing is changed
-- risk: low; deterministic shell copy only (labels and one confirmation/error sentence), not business values: no price, fee, policy, legal text, marketing claim or marketplace copy is seeded. Rows go through the real lifecycle (guard triggers, audit, exclusion constraint all apply; no trigger is disabled and no PUBLISHED row is inserted directly)
-- events: seeded versions emit NO outbox events (version-published / legal-document-published). The seed runs before any consumer exists and consumers read the
--   current state (resolution), never a replay of history; every version published AFTER this migration goes through the service, which writes the events.
-- audit: each entry gets the same trail the service writes for an immediate publication of a policy-NONE version (ENTRY_CREATED, VERSION_DRAFTED, VERSION_APPROVED,
--   VERSION_PUBLISHED, VERSION_ACTIVATED), stamped with clock_timestamp() so occurred_at orders the rows causally (now() would give all rows one instant).

DO $seed$
DECLARE
  -- computed once so every seeded version shares one start instant (published rows of different entries never interact anyway)
  v_from       timestamptz := now();
  v_actor      constant text := 'system:migration';
  v_correlation constant text := 'seed-0006';
  v_reason     constant text := 'Initial product shell copy (migration 0006)';
  v_entry_id   uuid;
  v_version_id uuid;
  v_seed       record;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1, 'brand.name',                 'UI_LABEL',   'Product wordmark shown in the application shell',                'BananaGig'),
      (2, 'brand.tagline',              'UI_LABEL',   'Short product tagline shown beside the wordmark',                'Local help. Done fast.'),
      (3, 'common.action.sign_in',      'UI_LABEL',   'Label of the sign-in action',                                    'Sign in'),
      (4, 'common.action.sign_out',     'UI_LABEL',   'Label of the sign-out action',                                   'Sign out'),
      (5, 'system.home.initialized',    'PLAIN_TEXT', 'Home page confirmation that platform initialization succeeded',  'Platform initialization successful.'),
      (6, 'session.status.signed_in',   'UI_LABEL',   'Session status shown while a user is signed in',                 'Signed in'),
      (7, 'session.status.signed_out',  'UI_LABEL',   'Session status shown while nobody is signed in',                 'Not signed in'),
      (8, 'session.error.login_failed', 'PLAIN_TEXT', 'Message shown when a sign-in attempt could not be completed',    'Sign-in could not be completed. Please try again.')
    ) AS t (ord, key, content_type, description, body)
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

    -- effective_from stays equal to the proposal (it may only be raised at publication, and the start is "now")
    UPDATE content.versions SET status = 'PUBLISHED', updated_at = now() WHERE version_id = v_version_id AND status = 'APPROVED';
    INSERT INTO content.audit_events (occurred_at, actor, action, entry_id, version_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'VERSION_PUBLISHED', v_entry_id, v_version_id, v_reason, v_correlation);
    -- the start is "now" (already reached), so the version is in force at once: the activation is recorded right after publication, like the service does
    INSERT INTO content.audit_events (occurred_at, actor, action, entry_id, version_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'VERSION_ACTIVATED', v_entry_id, v_version_id, v_reason, v_correlation);
  END LOOP;
END
$seed$;
