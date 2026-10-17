-- checkpoint: ACC-001
-- purpose: add the registry of the shared ACCOUNT AREA to the identity schema: account_sections (one row per section of the account area: stable code, its own URL, the managed label and description, a lifecycle status) and account_section_roles (which application role sees which section, whether it is enabled and in which order), plus the seeded section matrix for the two active roles and the managed copy of the account area (CFG-002). Nothing else changes: the profile, the contacts, the sessions and the consents stay where they are and the account area only COMPOSES them.
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. The registry rows are reference data: never deleted (a section is retired with status INACTIVE, a row of the matrix is switched off with enabled = false), the seeded copy is changed through the content workflow, never by editing this file
-- backfill: none; both tables are new and the seed is deterministic reference data. No existing row is rewritten and no existing table is altered
-- risk: low. Two new small tables (8 and 16 rows), three guard functions with their triggers (one of them a new BEFORE UPDATE OF status trigger on identity.roles that only reads the new matrix), 64 content entries seeded through the real content lifecycle. The only runtime reader is the account-navigation query (one indexed read per request); nothing else depends on these tables
-- destructive: none
-- events: the seeds emit no outbox events (they run before any consumer exists, like 0006 to 0013); the registry has no runtime writer, so it has no events and no audit trail of its own (a change is a reviewed migration)
-- audit: the content seed writes the content audit trail (ENTRY_CREATED ... VERSION_ACTIVATED), exactly as the real workflow does
-- DECISIONS: (1) two tables, not one: the route, label, description and status depend on the SECTION alone while enabled and display_order depend on the (section, role) pair, so one flat table would repeat the section columns per role (2NF); (2) no per-account section preference table: nothing in the account area is a persisted per-person choice, the active role is request context (ADR-0026); (3) the role is a foreign key to identity.roles, so a future persona (business owner, staff) is a row of the roles table plus rows of the matrix, never a new column or table; (4) no effective dates: a section becomes available when its capability ships, which is a migration of this registry in the same release, and a date column nothing reads would be speculative; (5) the invariant "an enabled row needs an ACTIVE section and an ACTIVE role" is kept in BOTH directions by guards: enabling needs both ACTIVE (matrix guard), and neither a section nor a role can leave ACTIVE while a row is enabled for it (section guard and a new trigger on identity.roles, which gets no new column or constraint); (6) only sections whose capability EXISTS are enabled: NOTIFICATIONS and CLOSE_ACCOUNT are registered as PLANNED and switched off for both roles, the sections of later checkpoints (addresses, payment methods, payouts, public profile ...) are added by the checkpoint that builds them

-- =====================================================================================================================
-- 1. account_sections: what the account area can contain (reference data, one row per section)
-- =====================================================================================================================
CREATE TABLE identity.account_sections (
  section_code           text        NOT NULL,
  route_path             text        NOT NULL,
  label_content_key      text        NOT NULL,
  description_content_key text,
  status                 text        NOT NULL DEFAULT 'PLANNED',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_account_sections PRIMARY KEY (section_code),
  CONSTRAINT uq_account_sections__route_path UNIQUE (route_path),
  CONSTRAINT fk_account_sections__label_content_key FOREIGN KEY (label_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT fk_account_sections__description_content_key FOREIGN KEY (description_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT ck_account_sections__section_code_format CHECK (section_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  CONSTRAINT ck_account_sections__route_path_format CHECK (route_path ~ '^/account/[a-z][a-z0-9-]{1,39}$'),
  CONSTRAINT ck_account_sections__label_content_key_format CHECK (label_content_key ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$'),
  CONSTRAINT ck_account_sections__description_content_key_format CHECK (description_content_key IS NULL OR description_content_key ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$'),
  CONSTRAINT ck_account_sections__status CHECK (status IN ('ACTIVE', 'PLANNED', 'INACTIVE'))
);
COMMENT ON TABLE identity.account_sections IS 'The sections of the shared account area as reference data: a stable code, the section''s OWN URL (one page per section), the managed label and description (content keys, CFG-002: no visible account text lives in code) and a lifecycle status. ACTIVE = the capability behind the section exists and it can be shown; PLANNED = registered for a later checkpoint, never shown; INACTIVE = retired. Which role sees a section, in which order, is identity.account_section_roles. Rows are never deleted. No personal data.';
COMMENT ON COLUMN identity.account_sections.section_code IS 'Stable upper-case code (PROFILE, CONTACT_VERIFICATION, SECURITY, NOTIFICATIONS, LANGUAGE_REGION, PRIVACY_DATA, ROLES, CLOSE_ACCOUNT ...). Immutable: the web, the API guards and the tests name sections by this code.';
COMMENT ON COLUMN identity.account_sections.route_path IS 'The web path of the section page: /account/<slug>, unique. The registry stores the path so the menu is data; the page itself is a web route that must exist before the section is ACTIVE.';
COMMENT ON COLUMN identity.account_sections.label_content_key IS 'Content key (content.entries.key) of the section name shown in the menu and as the page heading. Visible text is resolved through the content registry, never hardcoded.';
COMMENT ON COLUMN identity.account_sections.description_content_key IS 'Content key of the one-line description of the section, or NULL when it has none.';
COMMENT ON COLUMN identity.account_sections.status IS 'ACTIVE, PLANNED or INACTIVE (see the table comment). A section can be enabled for a role only while it is ACTIVE (guard SECTION_NOT_ACTIVE) and cannot leave ACTIVE while a role still has it enabled (guard SECTION_IN_USE).';

-- =====================================================================================================================
-- 2. account_section_roles: which application role sees which section, and in which order
-- =====================================================================================================================
CREATE TABLE identity.account_section_roles (
  section_code  text        NOT NULL,
  role_id       uuid        NOT NULL,
  enabled       boolean     NOT NULL DEFAULT false,
  display_order integer     NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_account_section_roles PRIMARY KEY (section_code, role_id),
  CONSTRAINT uq_account_section_roles__role_order UNIQUE (role_id, display_order),
  CONSTRAINT fk_account_section_roles__section_code FOREIGN KEY (section_code) REFERENCES identity.account_sections (section_code) ON DELETE RESTRICT,
  CONSTRAINT fk_account_section_roles__role_id FOREIGN KEY (role_id) REFERENCES identity.roles (role_id) ON DELETE RESTRICT,
  CONSTRAINT ck_account_section_roles__display_order CHECK (display_order BETWEEN 1 AND 9999)
);
COMMENT ON TABLE identity.account_section_roles IS 'The section matrix of the account area: for an application role (identity.roles), whether a section is enabled and where it sits in the menu. The account area shows exactly the enabled rows of the ACTIVE role of the request whose section is ACTIVE, and every section-owned endpoint refuses (404) a section that is not in that set: hiding is never only a front-end matter. A row exists for every (section, role) pair that was ever planned, enabled = false keeps it out of the menu. Rows are never deleted. No personal data.';
COMMENT ON COLUMN identity.account_section_roles.enabled IS 'True = the role sees the section. Needs an ACTIVE section and an ACTIVE role (guards SECTION_NOT_ACTIVE and ROLE_NOT_ACTIVE) and keeps both ACTIVE while true (guards SECTION_IN_USE and ROLE_HAS_SECTIONS).';
COMMENT ON COLUMN identity.account_section_roles.display_order IS 'Position in the menu of the role (ascending). Unique per role over ALL rows, enabled or not, so an order is never ambiguous; the seed leaves gaps of 10 so a later section fits between two others without renumbering. The key is not deferrable: swapping the orders of two rows takes three statements (park one row on a free value first).';

-- Index justification (DATA_MODEL_GUARDRAILS rule 11). The only query is the account navigation: the enabled sections of ONE role in menu order.
--   pk_account_section_roles (section_code, role_id): the foreign key to the section and the lookup of one pair.
--   uq_account_section_roles__role_order (role_id, display_order): the role's menu in order, and the rule that an order is unique per role (the unique key IS the access path, so there is no second index).
--   uq_account_sections__route_path: one page per section and the lookup from a path.
-- Foreign keys deliberately WITHOUT a supporting index: account_sections.label_content_key and .description_content_key (never-deleted reference targets, no filtered query),
--   account_section_roles.role_id is the leading column of uq_account_section_roles__role_order.

-- =====================================================================================================================
-- 3. guards (all failures are SQLSTATE 23000 with DETAIL identity_rule:<KEY>, the convention of the identity schema)
--    Lock order: section row (FOR SHARE from the matrix guard), then role row (FOR SHARE). The retirement guards read the matrix without locking it.
-- =====================================================================================================================
CREATE FUNCTION identity.guard_account_sections() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an account section is never deleted: retire it with status INACTIVE' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:SECTION_NOT_DELETABLE';
  END IF;
  IF NEW.section_code IS DISTINCT FROM OLD.section_code THEN
    RAISE EXCEPTION 'the code of an account section is immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:SECTION_CODE_IMMUTABLE';
  END IF;
  IF NEW.status <> 'ACTIVE' AND OLD.status = 'ACTIVE'
     AND EXISTS (SELECT 1 FROM identity.account_section_roles WHERE section_code = OLD.section_code AND enabled) THEN
    RAISE EXCEPTION 'a section that a role still shows cannot leave ACTIVE: switch it off for every role first' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:SECTION_IN_USE';
  END IF;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_account_sections__guard BEFORE UPDATE OR DELETE ON identity.account_sections FOR EACH ROW EXECUTE FUNCTION identity.guard_account_sections();
COMMENT ON FUNCTION identity.guard_account_sections() IS 'Reference-data guard: a section is never deleted, its code never changes, it cannot leave ACTIVE while a role has it enabled (SECTION_NOT_DELETABLE, SECTION_CODE_IMMUTABLE, SECTION_IN_USE) and created_at is kept.';

CREATE FUNCTION identity.guard_account_section_roles() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s_status text;
  r_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a row of the section matrix is never deleted: switch it off with enabled = false' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:SECTION_ROLE_NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.section_code IS DISTINCT FROM OLD.section_code OR NEW.role_id IS DISTINCT FROM OLD.role_id) THEN
    RAISE EXCEPTION 'the section and the role of a matrix row are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:SECTION_ROLE_KEY_IMMUTABLE';
  END IF;
  IF NEW.enabled THEN
    SELECT status INTO s_status FROM identity.account_sections WHERE section_code = NEW.section_code FOR SHARE;
    IF s_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'a section can be enabled for a role only while it is ACTIVE (its capability must exist)' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:SECTION_NOT_ACTIVE';
    END IF;
    SELECT status INTO r_status FROM identity.roles WHERE role_id = NEW.role_id FOR SHARE;
    IF r_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'a section can be enabled only for an ACTIVE role' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ROLE_NOT_ACTIVE';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_account_section_roles__guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_section_roles FOR EACH ROW EXECUTE FUNCTION identity.guard_account_section_roles();
COMMENT ON FUNCTION identity.guard_account_section_roles() IS 'Matrix guard: rows are never deleted, their key never changes, and enabled = true needs an ACTIVE section and an ACTIVE role (read under FOR SHARE so a concurrent retirement serializes with it): SECTION_ROLE_NOT_DELETABLE, SECTION_ROLE_KEY_IMMUTABLE, SECTION_NOT_ACTIVE, ROLE_NOT_ACTIVE.';

-- a role cannot leave ACTIVE while a matrix row is enabled for it: the other half of the invariant. identity.roles keeps its columns and constraints; the guard of 0009 (which
-- only looks at memberships) is untouched and this is a second, independent trigger. A concurrent enable holds the role row FOR SHARE, so the two serialize.
CREATE FUNCTION identity.guard_roles_account_sections() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE'
     AND EXISTS (SELECT 1 FROM identity.account_section_roles WHERE role_id = OLD.role_id AND enabled) THEN
    RAISE EXCEPTION 'a role that still has account sections enabled cannot leave ACTIVE: switch them off first' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'identity_rule:ROLE_HAS_SECTIONS';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_roles__account_sections BEFORE UPDATE OF status ON identity.roles FOR EACH ROW EXECUTE FUNCTION identity.guard_roles_account_sections();
COMMENT ON FUNCTION identity.guard_roles_account_sections() IS 'Refuses retiring a role (status away from ACTIVE) while a row of identity.account_section_roles is enabled for it (ROLE_HAS_SECTIONS): the account area would otherwise hold enabled rows of an inactive role.';

-- reference data is never emptied: TRUNCATE (also by CASCADE from the sections) is refused like DELETE, with the same function and rule key as the append-only tables
CREATE TRIGGER trg_account_sections__no_truncate BEFORE TRUNCATE ON identity.account_sections FOR EACH STATEMENT EXECUTE FUNCTION identity.forbid_mutation();
CREATE TRIGGER trg_account_section_roles__no_truncate BEFORE TRUNCATE ON identity.account_section_roles FOR EACH STATEMENT EXECUTE FUNCTION identity.forbid_mutation();

-- =====================================================================================================================
-- 4. seed: the managed copy of the account area (CFG-002), through the real content lifecycle (en-US only)
--    Labels, descriptions, page copy and notices only. No copy carries personal data: the typed variables are a role name, a count and nothing else.
--    The registry rows in section 5 reference these keys, so the entries are created first.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0014';
  v_reason      constant text := 'Initial account area copy (migration 0014)';
  v_seed        record;
  v_var         record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1,  'UI_LABEL',   'account.area.title', 'Heading of the account area', 'Your account', '[]'::jsonb),
      (2,  'UI_LABEL',   'account.area.nav.label', 'Accessible name of the account sections menu', 'Account sections', '[]'::jsonb),
      (3,  'UI_LABEL',   'account.area.nav.back', 'Link back to the list of account sections on a small screen', 'All account sections', '[]'::jsonb),
      (4,  'UI_LABEL',   'account.area.skip_link', 'Skip link that jumps over the account menu to the page content', 'Skip to the account content', '[]'::jsonb),
      (5,  'PLAIN_TEXT', 'account.area.overview.intro', 'Introduction on the account overview page', 'Choose a section to manage your account.', '[]'::jsonb),
      (6,  'PLAIN_TEXT', 'account.area.overview.empty', 'Message when no section is available for the current role', 'No account sections are available for your current role.', '[]'::jsonb),
      (7,  'PLAIN_TEXT', 'account.area.active_role', 'Shows the role the person is acting as', 'Current role: {role}',
            '[{"name": "role", "type": "STRING", "description": "The display name of the current role, from the role content entry", "example": "Customer", "pii": "NONE"}]'::jsonb),
      (8,  'PLAIN_TEXT', 'account.area.unavailable', 'Message when the account could not be loaded', 'Your account could not be loaded right now. Please try again.', '[]'::jsonb),
      (9,  'PLAIN_TEXT', 'account.area.section_unavailable', 'Message when a section page is not available for the current role', 'This page is not available for your current role.', '[]'::jsonb),
      (10, 'PLAIN_TEXT', 'account.area.notice.saved', 'Notice after a successful save', 'Your changes were saved.', '[]'::jsonb),
      (11, 'PLAIN_TEXT', 'account.area.notice.unchanged', 'Notice when a save changed nothing', 'Nothing was changed.', '[]'::jsonb),
      (12, 'PLAIN_TEXT', 'account.area.error.save_failed', 'Error when a save failed for a reason the person cannot fix', 'Your changes could not be saved. Please try again.', '[]'::jsonb),
      (13, 'PLAIN_TEXT', 'account.area.error.invalid_choice', 'Error when a chosen value is not one of the available choices', 'That choice is not available. Please pick one from the list.', '[]'::jsonb),
      (14, 'UI_LABEL',   'account.area.action.save', 'Button that saves the changes of a form', 'Save changes', '[]'::jsonb),
      (15, 'UI_LABEL',   'account.area.default_option', 'Choice that clears an optional preference and follows the default of the area', 'Use the default for my area', '[]'::jsonb),

      (16, 'UI_LABEL',   'account.area.section.profile.label', 'Account section: profile (menu and heading)', 'Profile', '[]'::jsonb),
      (17, 'PLAIN_TEXT', 'account.area.section.profile.description', 'Account section: profile (description)', 'Your name and how other people see you.', '[]'::jsonb),
      (18, 'UI_LABEL',   'account.area.section.contact_verification.label', 'Account section: contact details and verification (menu and heading)', 'Contact details', '[]'::jsonb),
      (19, 'PLAIN_TEXT', 'account.area.section.contact_verification.description', 'Account section: contact details and verification (description)', 'Your email and phone, and whether they are verified.', '[]'::jsonb),
      (20, 'UI_LABEL',   'account.area.section.security.label', 'Account section: security (menu and heading)', 'Security', '[]'::jsonb),
      (21, 'PLAIN_TEXT', 'account.area.section.security.description', 'Account section: security (description)', 'Two-step verification, signed-in sessions and trusted browsers.', '[]'::jsonb),
      (22, 'UI_LABEL',   'account.area.section.notifications.label', 'Account section: notifications (menu and heading; not available yet)', 'Notifications', '[]'::jsonb),
      (23, 'PLAIN_TEXT', 'account.area.section.notifications.description', 'Account section: notifications (description; not available yet)', 'Choose which messages you receive and how.', '[]'::jsonb),
      (24, 'UI_LABEL',   'account.area.section.language_region.label', 'Account section: language and region (menu and heading)', 'Language and region', '[]'::jsonb),
      (25, 'PLAIN_TEXT', 'account.area.section.language_region.description', 'Account section: language and region (description)', 'Your language and your time zone.', '[]'::jsonb),
      (26, 'UI_LABEL',   'account.area.section.privacy_data.label', 'Account section: privacy and data (menu and heading)', 'Privacy and data', '[]'::jsonb),
      (27, 'PLAIN_TEXT', 'account.area.section.privacy_data.description', 'Account section: privacy and data (description)', 'The agreements that apply to your account and your data.', '[]'::jsonb),
      (28, 'UI_LABEL',   'account.area.section.roles.label', 'Account section: roles (menu and heading)', 'Roles', '[]'::jsonb),
      (29, 'PLAIN_TEXT', 'account.area.section.roles.description', 'Account section: roles (description)', 'The roles you hold and the one you are using now.', '[]'::jsonb),
      (30, 'UI_LABEL',   'account.area.section.close_account.label', 'Account section: close account (menu and heading; not available yet)', 'Close account', '[]'::jsonb),
      (31, 'PLAIN_TEXT', 'account.area.section.close_account.description', 'Account section: close account (description; not available yet)', 'Pause or close your account.', '[]'::jsonb),

      (32, 'UI_LABEL',   'account.area.profile.first_name', 'Label of the first name field', 'First name', '[]'::jsonb),
      (33, 'UI_LABEL',   'account.area.profile.last_name', 'Label of the last name field', 'Last name', '[]'::jsonb),
      (34, 'UI_LABEL',   'account.area.profile.public_label', 'Label of the name other people see', 'Shown to other people as', '[]'::jsonb),
      (35, 'PLAIN_TEXT', 'account.area.profile.public_hint', 'Explains what other people see of the name', 'Other people see your first name and the first letter of your last name. Your full name is visible only to you.', '[]'::jsonb),
      (36, 'PLAIN_TEXT', 'account.area.profile.empty', 'Prompt when the person has not given a name yet', 'Add your name to complete your profile.', '[]'::jsonb),

      (37, 'UI_LABEL',   'account.area.contact.email', 'Label of the email contact', 'Email', '[]'::jsonb),
      (38, 'UI_LABEL',   'account.area.contact.phone', 'Label of the phone contact', 'Phone', '[]'::jsonb),
      (39, 'PLAIN_TEXT', 'account.area.contact.not_added', 'A contact that has not been added', 'Not added yet', '[]'::jsonb),
      (40, 'PLAIN_TEXT', 'account.area.contact.pending_note', 'Label before a new address or number that is waiting for verification', 'Waiting for verification', '[]'::jsonb),
      (41, 'PLAIN_TEXT', 'account.area.contact.all_verified', 'Summary when email and phone are both verified', 'Your email and phone are verified.', '[]'::jsonb),
      (42, 'PLAIN_TEXT', 'account.area.contact.not_all_verified', 'Summary when a contact is not verified yet', 'Some of your contact details are not verified yet.', '[]'::jsonb),
      (43, 'UI_LABEL',   'account.area.contact.verify_email', 'Link to the email verification page', 'Verify your email', '[]'::jsonb),

      (44, 'UI_LABEL',   'account.area.security.mfa', 'Label of the two-step verification state', 'Two-step verification', '[]'::jsonb),
      (45, 'UI_LABEL',   'account.area.security.mfa_on', 'Two-step verification is set up', 'On', '[]'::jsonb),
      (46, 'UI_LABEL',   'account.area.security.mfa_off', 'Two-step verification is not set up', 'Off', '[]'::jsonb),
      (47, 'PLAIN_TEXT', 'account.area.security.mfa_unknown', 'The two-step verification state could not be checked', 'This could not be checked right now.', '[]'::jsonb),
      (48, 'UI_LABEL',   'account.area.security.sessions', 'Label of the number of signed-in sessions', 'Signed-in sessions', '[]'::jsonb),
      (49, 'UI_LABEL',   'account.area.security.browser', 'Label of the trust state of the current browser', 'This browser', '[]'::jsonb),
      (50, 'UI_LABEL',   'account.area.security.browser_trusted', 'The current browser is trusted', 'Trusted', '[]'::jsonb),
      (51, 'UI_LABEL',   'account.area.security.browser_not_trusted', 'The current browser is not trusted', 'Not trusted', '[]'::jsonb),
      (52, 'UI_LABEL',   'account.area.security.open', 'Link to the security centre', 'Open the security centre', '[]'::jsonb),

      (53, 'UI_LABEL',   'account.area.language.locale', 'Label of the language choice', 'Language', '[]'::jsonb),
      (54, 'UI_LABEL',   'account.area.language.time_zone', 'Label of the time zone choice', 'Time zone', '[]'::jsonb),

      (55, 'UI_LABEL',   'account.area.privacy.consents', 'Heading of the agreements summary', 'Terms and consents', '[]'::jsonb),
      (56, 'PLAIN_TEXT', 'account.area.privacy.outstanding', 'Number of agreements that need the attention of the person', '{count, plural, one {# agreement needs your attention.} other {# agreements need your attention.}}',
            '[{"name": "count", "type": "COUNT", "description": "How many required agreements are not accepted", "example": 2, "pii": "NONE"}]'::jsonb),
      (57, 'UI_LABEL',   'account.area.privacy.open_consents', 'Link to the consents page', 'Review your agreements', '[]'::jsonb),
      (58, 'UI_LABEL',   'account.area.privacy.download', 'Heading of the data download area', 'Download your data', '[]'::jsonb),
      (59, 'PLAIN_TEXT', 'account.area.privacy.download_unavailable', 'The data download is not available yet', 'Downloading your data is not available yet.', '[]'::jsonb),

      (60, 'UI_LABEL',   'account.area.roles.held', 'Heading of the list of roles the person holds', 'Your roles', '[]'::jsonb),
      (61, 'UI_LABEL',   'account.area.roles.current', 'Marks the role the person is acting as', 'Current role', '[]'::jsonb),
      (62, 'PLAIN_TEXT', 'account.area.roles.switch', 'Button that switches to another role', 'Switch to {role}',
            '[{"name": "role", "type": "STRING", "description": "The display name of the role to switch to, from the role content entry", "example": "Provider", "pii": "NONE"}]'::jsonb),
      (63, 'PLAIN_TEXT', 'account.area.roles.single', 'Message when the person holds one role only', 'You have one role, so there is nothing to switch.', '[]'::jsonb),
      (64, 'PLAIN_TEXT', 'account.area.roles.switch_failed', 'Error when the role could not be changed', 'The role could not be changed. Please try again.', '[]'::jsonb)
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

-- =====================================================================================================================
-- 5. seed: the registry and the section matrix
--    ACTIVE = the capability exists today (the profile API, the email/phone contact state, the security overview, the language and time zone choice, the consent
--    summary, the role list). PLANNED = registered, switched off: NOTIFICATIONS (NOTIF-001) and CLOSE_ACCOUNT (the closure rules, DEBT-0045).
--    CUSTOMER and PROVIDER see the same six shared sections today: no provider-only or customer-only capability exists yet. The matrix is per role so that
--    a role-specific section is one more row of this table when its checkpoint ships.
-- =====================================================================================================================
INSERT INTO identity.account_sections (section_code, route_path, label_content_key, description_content_key, status) VALUES
  ('PROFILE',              '/account/profile',         'account.area.section.profile.label',              'account.area.section.profile.description',              'ACTIVE'),
  ('CONTACT_VERIFICATION', '/account/contact',         'account.area.section.contact_verification.label', 'account.area.section.contact_verification.description', 'ACTIVE'),
  ('SECURITY',             '/account/security',        'account.area.section.security.label',             'account.area.section.security.description',             'ACTIVE'),
  ('LANGUAGE_REGION',      '/account/language-region', 'account.area.section.language_region.label',      'account.area.section.language_region.description',      'ACTIVE'),
  ('PRIVACY_DATA',         '/account/privacy',         'account.area.section.privacy_data.label',         'account.area.section.privacy_data.description',         'ACTIVE'),
  ('ROLES',                '/account/roles',           'account.area.section.roles.label',                'account.area.section.roles.description',                'ACTIVE'),
  ('NOTIFICATIONS',        '/account/notifications',   'account.area.section.notifications.label',        'account.area.section.notifications.description',        'PLANNED'),
  ('CLOSE_ACCOUNT',        '/account/close',           'account.area.section.close_account.label',        'account.area.section.close_account.description',        'PLANNED');

INSERT INTO identity.account_section_roles (section_code, role_id, enabled, display_order)
SELECT m.section_code, r.role_id, m.enabled, m.display_order
FROM (VALUES
  ('PROFILE',              true,  10),
  ('CONTACT_VERIFICATION', true,  20),
  ('SECURITY',             true,  30),
  ('LANGUAGE_REGION',      true,  40),
  ('PRIVACY_DATA',         true,  50),
  ('ROLES',                true,  60),
  ('NOTIFICATIONS',        false, 70),
  ('CLOSE_ACCOUNT',        false, 80)
) AS m (section_code, enabled, display_order)
CROSS JOIN identity.roles r
WHERE r.code IN ('CUSTOMER', 'PROVIDER');
