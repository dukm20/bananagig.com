-- checkpoint: CAT-002
-- purpose: harden the Gig Template model after the independent review of 0016 (forward fix; 0016 was already applied to the development database): (1) a field's type or key can no longer change while it has options, and the publication re-verifies that only ENUM fields have options and that every option label key follows the derivation, so a frozen version cannot carry an inconsistent option row; (2) the audit trail can no longer pair a template with a version of ANOTHER template (composite foreign key); (3) the stale comments of the schema, the audit table and the shared status machine now name the Gig Template subjects and consumers
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. Nothing is deleted or rewritten: two functions are replaced (bodies only), one helper function is added, one foreign key is replaced by a composite one over the same columns (every existing audit row already satisfies it), one unique constraint is added
-- backfill: none. Existing rows already satisfy the new unique constraint (the id is already the primary key) and the composite foreign key (the audit rows are written by the service with the template of the version)
-- risk: low. The replaced functions are the field guard (one extra condition on UPDATE of a field) and the publishability check (two extra conditions, run once per publication). The foreign key swap takes a short exclusive lock on the audit table and the versions table, both tiny
-- destructive: none
-- events: none
-- audit: none
-- DECISIONS: (1) the database, not only the service, keeps a frozen version consistent: a field with options is not retyped or renamed under them, and a publication backstops the option rules; (2) the audit trail is evidence and immutable, so it must not be able to name a version under the wrong template: a composite key (version id, template id) is the cheapest declarative guarantee; (3) the machine still allows ACTIVE -> RETIRED, which is how the retirement of a template closes its ACTIVE version; the service offers no direct withdraw of an ACTIVE version (pause or retire the template instead), and the documentation says so

-- =====================================================================================================================
-- 1. a field keeps its type and key while it has options
-- =====================================================================================================================
CREATE OR REPLACE FUNCTION catalog.guard_gig_template_fields() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_id     uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.gig_template_version_id ELSE NEW.gig_template_version_id END;
  v_status text;
  t_code   text;
  stem     text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.gig_template_field_id, NEW.gig_template_version_id) IS DISTINCT FROM (OLD.gig_template_field_id, OLD.gig_template_version_id) THEN
    RAISE EXCEPTION 'the id and the version of a field are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:IMMUTABLE_IDENTITY';
  END IF;
  SELECT status INTO v_status FROM catalog.gig_template_versions WHERE gig_template_version_id = v_id FOR SHARE;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'the fields of a version can change only while it is a DRAFT' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:VERSION_NOT_DRAFT';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  -- the options of this field were verified against the field's type and key when they were written: neither may change underneath them
  IF TG_OP = 'UPDATE' AND (NEW.field_type <> OLD.field_type OR NEW.field_key <> OLD.field_key)
     AND EXISTS (SELECT 1 FROM catalog.gig_template_field_options WHERE gig_template_field_id = OLD.gig_template_field_id) THEN
    RAISE EXCEPTION 'the type and the key of a field cannot change while it has options: remove the options first' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:FIELD_HAS_OPTIONS';
  END IF;
  SELECT t.code INTO t_code FROM catalog.gig_template_versions v JOIN catalog.gig_templates t ON t.gig_template_id = v.gig_template_id WHERE v.gig_template_version_id = v_id;
  stem := 'catalog.gig_template.' || t_code || '.field.' || NEW.field_key;
  IF NEW.label_content_key <> stem || '.label'
     OR COALESCE(NEW.help_content_key, stem || '.help') <> stem || '.help'
     OR COALESCE(NEW.default_content_key, stem || '.default') <> stem || '.default' THEN
    RAISE EXCEPTION 'the content keys of a field are derived from the template code and the field key' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:CONTENT_KEY_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION catalog.guard_gig_template_fields() IS 'Field guard: ids immutable, rows change only while the version is a DRAFT (read FOR SHARE so a concurrent publication serializes), the type and the key of a field with options cannot change, content keys equal the derivation (IMMUTABLE_IDENTITY, VERSION_NOT_DRAFT, FIELD_HAS_OPTIONS, CONTENT_KEY_MISMATCH).';

-- =====================================================================================================================
-- 2. the publication re-verifies the option rules
-- =====================================================================================================================
-- the options of a version with the label key the derivation expects (template code, field key, option code): the publication re-verifies what the option guard checked at write time
CREATE FUNCTION catalog.gig_template_options_of_version(p_version_id uuid)
RETURNS TABLE (label_content_key text, expected_key text) LANGUAGE sql STABLE AS $$
  SELECT o.label_content_key, 'catalog.gig_template.' || t.code || '.field.' || f.field_key || '.option.' || o.option_code || '.label'
    FROM catalog.gig_template_field_options o
    JOIN catalog.gig_template_fields f ON f.gig_template_field_id = o.gig_template_field_id
    JOIN catalog.gig_template_versions v ON v.gig_template_version_id = f.gig_template_version_id
    JOIN catalog.gig_templates t ON t.gig_template_id = v.gig_template_id
   WHERE v.gig_template_version_id = p_version_id;
$$;
COMMENT ON FUNCTION catalog.gig_template_options_of_version(uuid) IS 'The options of a template version with their stored label key and the key the derivation expects; used by the publication check as a backstop for the option guard.';

CREATE OR REPLACE FUNCTION catalog.assert_version_publishable(p_version_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalog.gig_template_fields WHERE gig_template_version_id = p_version_id) THEN
    RAISE EXCEPTION 'a version without fields cannot be published' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:GIG_TEMPLATE_HAS_NO_FIELDS';
  END IF;
  IF EXISTS (SELECT 1 FROM catalog.gig_template_fields f WHERE f.gig_template_version_id = p_version_id AND f.field_type <> 'ENUM'
              AND EXISTS (SELECT 1 FROM catalog.gig_template_field_options o WHERE o.gig_template_field_id = f.gig_template_field_id)) THEN
    RAISE EXCEPTION 'a field that is not an ENUM has options' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:OPTIONS_ONLY_FOR_ENUM';
  END IF;
  IF EXISTS (SELECT 1
               FROM catalog.gig_template_options_of_version(p_version_id) o
              WHERE o.label_content_key <> o.expected_key) THEN
    RAISE EXCEPTION 'the content key of an option does not follow the derivation' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:CONTENT_KEY_MISMATCH';
  END IF;
  IF EXISTS (SELECT 1 FROM catalog.gig_template_fields f WHERE f.gig_template_version_id = p_version_id AND f.field_type = 'ENUM'
              AND NOT EXISTS (SELECT 1 FROM catalog.gig_template_field_options o WHERE o.gig_template_field_id = f.gig_template_field_id)) THEN
    RAISE EXCEPTION 'an ENUM field has no options' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:ENUM_FIELD_WITHOUT_OPTIONS';
  END IF;
  IF EXISTS (SELECT 1 FROM catalog.gig_template_fields f WHERE f.gig_template_version_id = p_version_id AND f.field_type = 'ENUM' AND f.behavior = 'PLATFORM_FIXED'
              AND NOT EXISTS (SELECT 1 FROM catalog.gig_template_field_options o WHERE o.gig_template_field_id = f.gig_template_field_id AND o.is_default)) THEN
    RAISE EXCEPTION 'a PLATFORM_FIXED ENUM field has no default option' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:FIXED_ENUM_WITHOUT_DEFAULT';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM (
        SELECT t.name_content_key AS k FROM catalog.gig_template_versions v JOIN catalog.gig_templates t ON t.gig_template_id = v.gig_template_id WHERE v.gig_template_version_id = p_version_id
        UNION SELECT t.description_content_key FROM catalog.gig_template_versions v JOIN catalog.gig_templates t ON t.gig_template_id = v.gig_template_id WHERE v.gig_template_version_id = p_version_id
        UNION SELECT t.instructions_content_key FROM catalog.gig_template_versions v JOIN catalog.gig_templates t ON t.gig_template_id = v.gig_template_id WHERE v.gig_template_version_id = p_version_id
        UNION SELECT f.label_content_key FROM catalog.gig_template_fields f WHERE f.gig_template_version_id = p_version_id
        UNION SELECT f.help_content_key FROM catalog.gig_template_fields f WHERE f.gig_template_version_id = p_version_id
        UNION SELECT f.default_content_key FROM catalog.gig_template_fields f WHERE f.gig_template_version_id = p_version_id
        UNION SELECT o.label_content_key FROM catalog.gig_template_field_options o JOIN catalog.gig_template_fields f ON f.gig_template_field_id = o.gig_template_field_id
               WHERE f.gig_template_version_id = p_version_id
      ) keys
     WHERE k IS NOT NULL AND NOT catalog.content_is_published(k)) THEN
    RAISE EXCEPTION 'the copy of the template is not published in the platform default locale' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:CONTENT_NOT_PUBLISHED';
  END IF;
END;
$$;
COMMENT ON FUNCTION catalog.assert_version_publishable(uuid) IS 'Publication checks that need the child rows or the content registry: at least one field, only ENUM fields have options and every option label key follows the derivation, every ENUM field has options (and a PLATFORM_FIXED one a default), every content key of the template, its fields and options is published as the content resolver reads it (GIG_TEMPLATE_HAS_NO_FIELDS, OPTIONS_ONLY_FOR_ENUM, CONTENT_KEY_MISMATCH, ENUM_FIELD_WITHOUT_OPTIONS, FIXED_ENUM_WITHOUT_DEFAULT, CONTENT_NOT_PUBLISHED). Bounds, models and uniqueness are table constraints.';

-- =====================================================================================================================
-- 3. the audit trail names a version only together with ITS template
-- =====================================================================================================================
ALTER TABLE catalog.gig_template_versions ADD CONSTRAINT uq_gig_template_versions__id_template UNIQUE (gig_template_version_id, gig_template_id);
ALTER TABLE catalog.audit_events DROP CONSTRAINT fk_audit_events__gig_template_version_id;
ALTER TABLE catalog.audit_events ADD CONSTRAINT fk_audit_events__gig_template_version FOREIGN KEY (gig_template_version_id, gig_template_id)
  REFERENCES catalog.gig_template_versions (gig_template_version_id, gig_template_id) ON DELETE RESTRICT;
COMMENT ON COLUMN catalog.audit_events.gig_template_version_id IS 'The template version of a GIG_TEMPLATE_VERSION_* action. Together with gig_template_id it is a composite foreign key to the version, so an audit row cannot name a version under another template (MATCH SIMPLE: a NULL version id is not checked). The changes diff holds identifiers, keys and counts, never copy.';

-- =====================================================================================================================
-- 4. comments that CAT-002 made stale
-- =====================================================================================================================
COMMENT ON SCHEMA catalog IS 'Application-owned catalogue (CAT-001, CAT-002): the platform-owned taxonomy (categories and service types), the versioned Gig Templates a provider builds a Gig from, their availability and order per market, the prohibited-service list and the audit trail. Providers later create Gigs (variants, add-ons, prices, radius, capacity) from a template version; none of that is modelled here. Names, labels and descriptions are managed content (CFG-002).';
COMMENT ON TABLE catalog.audit_events IS 'Append-only audit trail of every catalogue management mutation: actor, action, the ONE kind of subject (a category, a service type, a prohibited service, a market together with a category or a service type, a Gig Template, a Gig Template version together with its template, or a market together with a Gig Template), field-level diff (a JSON object {field: [old, new]}), the mandatory reason, time and correlation id. Reads are never audited. Rows are immutable and never truncated. It holds identifiers, codes and keys only.';
COMMENT ON FUNCTION catalog.assert_status_transition(text, text) IS 'The ONE status machine of the catalogue (categories, service types, prohibited services and Gig Template identities): DRAFT -> ACTIVE | RETIRED, ACTIVE <-> INACTIVE, ACTIVE | INACTIVE -> RETIRED, RETIRED terminal, DRAFT never written back (DRAFT_IS_INITIAL, STATUS_TRANSITION).';
