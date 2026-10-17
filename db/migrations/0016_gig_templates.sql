-- checkpoint: CAT-002
-- purpose: add the PLATFORM-OWNED Gig Templates to the catalog schema: a template belongs to exactly one service type (Full Detail for Car Detailing), has a stable identity and a status, and carries immutable VERSIONS that freeze the structure a provider later builds a Gig from (typed fields with fixed / configurable / required behaviour, duration guidance, allowed pricing and service-area models, requirement hooks for the trust checkpoints) plus its availability per market. The audit trail of CAT-001 is extended, not duplicated. A Gig (price, floor price, chosen duration, radius, area, pitch, photos, capacity, variants, add-ons, booking mode) belongs to a provider and arrives with CAT-003: no table here carries provider data, and CAT-003 will reference gig_template_versions.gig_template_version_id exactly.
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. No template, version, field, option, requirement or availability row is ever deleted or truncated once it is part of history: a DRAFT version is edited in place (its child rows may be replaced while it is a DRAFT), a published version is frozen, a discarded or withdrawn version is RETIRED, a template is RETIRED, availability is switched off with enabled = false. The seeded copy is changed through the content workflow, never by editing this file
-- backfill: none; every table is new, the audit table gets two nullable columns and two wider CHECK constraints (the existing six rows satisfy both), and nothing references the new tables yet. The seed is deterministic reference data (two DRAFT templates without versions: nothing is offered until an administrator builds, publishes, activates and enables one)
-- risk: low. All tables are new and small. Readers: the template reads (one indexed read of a market's rows, cached by the catalogue generation counter) and the management operations. The only change to an existing object is audit_events (ADD COLUMN x2 with no default, CHECK constraints replaced by wider ones), which takes a short exclusive lock on a tiny table
-- destructive: none (constraints are widened, never narrowed)
-- events: the seeds emit no outbox events (they run before any consumer exists, like 0006 to 0015); every status, publication or availability change after this migration goes through GigTemplateService, which writes the event in the same transaction
-- audit: the content seed writes the content audit trail exactly as the real workflow does; the template seed writes one GIG_TEMPLATE_CREATED row per template (actor system:migration)
-- DECISIONS: (1) identity and version are SEPARATE: the template (code, service type, copy keys, status) never changes its meaning across versions, the version (fields, bounds, models, hooks) is what a Gig is built from, so a Gig can keep the exact structure it was created from while the template moves on; (2) name, description and instructions are IDENTITY data (a rename is a content change, not a new structure) and every content key is DERIVED from the template code and the field key and SHARED by all versions: a version freezes the structure, the wording is content with its own immutable effective-dated history (CFG-002); a field whose meaning changes gets a new field key; (3) statuses: DRAFT -> ACTIVE (publish) | RETIRED (discard); ACTIVE -> SUPERSEDED (automatic, when the next version is published) | RETIRED (withdraw); SUPERSEDED and RETIRED are terminal. There is no IN_REVIEW: no reviewer role or workflow exists, so it would be a status nothing can reach (adding it later is a CHECK change); (4) at most ONE draft and ONE active version per template (partial unique indexes) and contiguous version numbers, so the history reads 1, 2, 3 without gaps or reuse; (5) a published version and ALL its child rows are frozen by guards (not by convention); (6) typed columns for field metadata instead of a JSON document: every bound has a type, a CHECK and an owner, and a column that does not belong to the field type must be NULL; (7) pricing and area models are closed sets stored as flags with a CHECK that at least one base model and one area mode are allowed (FIXED is the base price every Gig has; FIXED_WITH_VARIANTS adds variants); (8) requirement rows are HOOKS: a type (skill, equipment, licence, insurance, background check) with an optional opaque reference code that TRUST-001 will give a catalogue; this checkpoint validates nothing about the code; (9) the hierarchy is enforced downwards at write time (a template is ACTIVE only under an ACTIVE service type; a version is published only under an ACTIVE template and service type) and checked upwards at read time (the public view re-checks the service type, its category and the market rows); CAT-001 guards are NOT changed, so pausing a service type never has to cascade into templates; (10) availability per market is a plain row per (market, template) with an order unique per market: the public view requires the market row, the template, an active version and the whole chain above it

-- =====================================================================================================================
-- 1. helpers
-- =====================================================================================================================
-- DRAFT -> ACTIVE | RETIRED; ACTIVE -> SUPERSEDED | RETIRED; SUPERSEDED and RETIRED are terminal; DRAFT is the initial status only
CREATE FUNCTION catalog.assert_version_transition(p_old text, p_new text) RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_new = p_old THEN RETURN; END IF;
  IF p_new = 'DRAFT' THEN
    RAISE EXCEPTION 'DRAFT is the initial status and cannot be set again' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:DRAFT_IS_INITIAL';
  END IF;
  IF NOT ((p_old = 'DRAFT' AND p_new IN ('ACTIVE', 'RETIRED')) OR (p_old = 'ACTIVE' AND p_new IN ('SUPERSEDED', 'RETIRED'))) THEN
    RAISE EXCEPTION 'the status transition is not allowed' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:STATUS_TRANSITION';
  END IF;
END;
$$;
COMMENT ON FUNCTION catalog.assert_version_transition(text, text) IS 'The status machine of a Gig Template version: DRAFT -> ACTIVE | RETIRED, ACTIVE -> SUPERSEDED | RETIRED, SUPERSEDED and RETIRED terminal, DRAFT never written back (DRAFT_IS_INITIAL, STATUS_TRANSITION).';

-- whether a content key resolves today in the platform default locale: an active entry with a published version (SCHEDULED, PUBLISHED or SUPERSEDED, the statuses the content resolver reads) of platform scope inside its
-- effective window, which is the rule the content registry applies to its last-resort locale
CREATE FUNCTION catalog.content_is_published(p_key text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM content.entries e
      JOIN content.versions v ON v.entry_id = e.entry_id
     WHERE e.key = p_key
       AND e.is_active
       AND v.status IN ('SCHEDULED', 'PUBLISHED', 'SUPERSEDED')
       AND v.scope_type = 'PLATFORM'
       AND v.locale = (SELECT l.locale FROM content.locales l WHERE l.is_platform_default)
       AND v.effective_from <= now()
       AND (v.effective_to IS NULL OR v.effective_to > now()));
$$;
COMMENT ON FUNCTION catalog.content_is_published(text) IS 'True when the content key belongs to an ACTIVE entry and has a published (SCHEDULED, PUBLISHED or SUPERSEDED, as the content resolver reads them) platform-scope version in force now in the platform default locale. Used by the publication guard so a version never goes live with copy a customer cannot read.';

-- =====================================================================================================================
-- 2. gig_templates (identity)
-- =====================================================================================================================
CREATE TABLE catalog.gig_templates (
  gig_template_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  service_type_id          uuid        NOT NULL,
  code                     text        NOT NULL,
  name_content_key         text        GENERATED ALWAYS AS ('catalog.gig_template.' || code || '.name') STORED NOT NULL,
  description_content_key  text,
  instructions_content_key text,
  status                   text        NOT NULL DEFAULT 'DRAFT',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_gig_templates PRIMARY KEY (gig_template_id),
  CONSTRAINT uq_gig_templates__code UNIQUE (code),
  CONSTRAINT fk_gig_templates__service_type_id FOREIGN KEY (service_type_id) REFERENCES catalog.service_types (service_type_id) ON DELETE RESTRICT,
  CONSTRAINT fk_gig_templates__name_content_key FOREIGN KEY (name_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT fk_gig_templates__description_content_key FOREIGN KEY (description_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT fk_gig_templates__instructions_content_key FOREIGN KEY (instructions_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT ck_gig_templates__code CHECK (code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND length(code) BETWEEN 2 AND 48),
  CONSTRAINT ck_gig_templates__description_content_key CHECK (description_content_key IS NULL OR description_content_key = 'catalog.gig_template.' || code || '.description'),
  CONSTRAINT ck_gig_templates__instructions_content_key CHECK (instructions_content_key IS NULL OR instructions_content_key = 'catalog.gig_template.' || code || '.instructions'),
  CONSTRAINT ck_gig_templates__status CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'RETIRED'))
);
CREATE INDEX idx_gig_templates__service_type ON catalog.gig_templates (service_type_id);
COMMENT ON TABLE catalog.gig_templates IS 'The identity of a platform-owned Gig Template: the reusable structure providers will build a Gig from, attached to exactly ONE service type (Full Detail for Car Detailing). Only identity lives here (code, service type, copy keys, status); the structure is in gig_template_versions so a Gig can keep the exact version it was built from. The code is immutable and never reused, the name, description and instructions are managed content (CFG-002) found through keys derived from the code, the status uses the catalogue machine (DRAFT, ACTIVE, INACTIVE, RETIRED). Rows are never deleted or truncated. No provider-specific field, no display text, no personal data.';
COMMENT ON COLUMN catalog.gig_templates.service_type_id IS 'The one service type of the template. Immutable: a Gig built from the template keeps its meaning, so moving to another service type is a new template. A template is ACTIVE only while its service type is ACTIVE (guard SERVICE_TYPE_NOT_ACTIVE) and none is created under a RETIRED service type.';
COMMENT ON COLUMN catalog.gig_templates.code IS 'Immutable lower-case snake_case identity (2 to 48 characters), unique across ALL templates, never reused: the API path and the stem of every content key of the template and its fields.';
COMMENT ON COLUMN catalog.gig_templates.name_content_key IS 'GENERATED from the code (catalog.gig_template.<code>.name) and a foreign key to content.entries: the name must exist as content. Not writable.';
COMMENT ON COLUMN catalog.gig_templates.description_content_key IS 'NULL = no description; when set exactly catalog.gig_template.<code>.description (a link, not a free choice).';
COMMENT ON COLUMN catalog.gig_templates.instructions_content_key IS 'NULL = no instructions; when set exactly catalog.gig_template.<code>.instructions: the platform guidance on how a provider fills the template.';
COMMENT ON COLUMN catalog.gig_templates.status IS 'DRAFT (initial only), ACTIVE (versions can be published and Gigs created), INACTIVE (a pause), RETIRED (terminal: closes the ACTIVE version and blocks every new use; the row, the code and all versions stay). Retiring needs no open DRAFT version.';

-- =====================================================================================================================
-- 3. gig_template_versions (the frozen structure)
-- =====================================================================================================================
CREATE TABLE catalog.gig_template_versions (
  gig_template_version_id     uuid        NOT NULL DEFAULT gen_random_uuid(),
  gig_template_id             uuid        NOT NULL,
  version_number              integer     NOT NULL,
  status                      text        NOT NULL DEFAULT 'DRAFT',
  revision                    integer     NOT NULL DEFAULT 1,
  min_duration_minutes        integer,
  max_duration_minutes        integer,
  suggested_duration_minutes  integer,
  pricing_fixed               boolean     NOT NULL DEFAULT true,
  pricing_fixed_with_variants boolean     NOT NULL DEFAULT false,
  pricing_bundle_eligible     boolean     NOT NULL DEFAULT false,
  pricing_drop_eligible       boolean     NOT NULL DEFAULT false,
  area_radius                 boolean     NOT NULL DEFAULT true,
  area_postal_codes           boolean     NOT NULL DEFAULT false,
  area_polygon                boolean     NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  published_at                timestamptz,
  closed_at                   timestamptz,
  CONSTRAINT pk_gig_template_versions PRIMARY KEY (gig_template_version_id),
  CONSTRAINT uq_gig_template_versions__number UNIQUE (gig_template_id, version_number),
  CONSTRAINT fk_gig_template_versions__gig_template_id FOREIGN KEY (gig_template_id) REFERENCES catalog.gig_templates (gig_template_id) ON DELETE RESTRICT,
  CONSTRAINT ck_gig_template_versions__number CHECK (version_number >= 1),
  CONSTRAINT ck_gig_template_versions__revision CHECK (revision >= 1),
  CONSTRAINT ck_gig_template_versions__status CHECK (status IN ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETIRED')),
  CONSTRAINT ck_gig_template_versions__duration CHECK (
    (min_duration_minutes IS NULL OR min_duration_minutes >= 1)
    AND (max_duration_minutes IS NULL OR max_duration_minutes >= 1)
    AND (min_duration_minutes IS NULL OR max_duration_minutes IS NULL OR min_duration_minutes <= max_duration_minutes)
    AND (suggested_duration_minutes IS NULL OR (suggested_duration_minutes >= 1
         AND (min_duration_minutes IS NULL OR suggested_duration_minutes >= min_duration_minutes)
         AND (max_duration_minutes IS NULL OR suggested_duration_minutes <= max_duration_minutes)))),
  CONSTRAINT ck_gig_template_versions__pricing CHECK (pricing_fixed OR pricing_fixed_with_variants),
  CONSTRAINT ck_gig_template_versions__area CHECK (area_radius OR area_postal_codes OR area_polygon),
  CONSTRAINT ck_gig_template_versions__lifecycle CHECK (
    (status = 'DRAFT' AND published_at IS NULL AND closed_at IS NULL)
    OR (status = 'ACTIVE' AND published_at IS NOT NULL AND closed_at IS NULL)
    OR (status = 'SUPERSEDED' AND published_at IS NOT NULL AND closed_at IS NOT NULL)
    OR (status = 'RETIRED' AND closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_gig_template_versions__active ON catalog.gig_template_versions (gig_template_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX uq_gig_template_versions__draft ON catalog.gig_template_versions (gig_template_id) WHERE status = 'DRAFT';
COMMENT ON TABLE catalog.gig_template_versions IS 'One version of a Gig Template: the STRUCTURE a Gig is built from (duration guidance, allowed pricing models, allowed service-area modes, plus the fields and requirement hooks in the child tables). A DRAFT is editable; once published (ACTIVE) the version and all its child rows are frozen by guards, a newer publication supersedes it automatically, and it is never deleted. CAT-003 will reference gig_template_version_id so a Gig keeps the exact structure it was created from. At most one DRAFT and one ACTIVE version per template; version numbers are contiguous. No provider value (price, chosen duration, radius, area) is stored here.';
COMMENT ON COLUMN catalog.gig_template_versions.version_number IS 'Contiguous per template (1, 2, 3): enforced by the guard, so a number is never skipped or reused.';
COMMENT ON COLUMN catalog.gig_template_versions.status IS 'DRAFT (editable, initial only), ACTIVE (published, frozen; at most one per template), SUPERSEDED (replaced by a newer publication; set only by the publication of that version), RETIRED (a discarded draft, a withdrawn version, or the ACTIVE version closed by the retirement of its template). SUPERSEDED and RETIRED are terminal.';
COMMENT ON COLUMN catalog.gig_template_versions.revision IS 'Concurrency token of a DRAFT: the management service bumps it on every change of the draft and a publication names the revision the administrator reviewed (a stale draft is refused). Frozen once the version leaves DRAFT.';
COMMENT ON COLUMN catalog.gig_template_versions.min_duration_minutes IS 'Guidance for the duration a Gig built from this version may declare (all three NULL = no rule). Platform bounds only: the duration a provider chooses is provider data (CAT-003), validated against these bounds.';
COMMENT ON COLUMN catalog.gig_template_versions.pricing_fixed IS 'Allowed pricing models. FIXED is the base price every Gig has (PR-03.04); FIXED_WITH_VARIANTS lets the Gig add variants; BUNDLE_ELIGIBLE and DROP_ELIGIBLE say the Gig may join a bundle or a BananaDrop. At least one of fixed / fixed_with_variants. Metadata only: no price is stored or computed here.';
COMMENT ON COLUMN catalog.gig_template_versions.area_radius IS 'Allowed service-area modes of a Gig (radius, postal-code list, polygon: PR-03.04); at least one. Metadata only: a provider''s actual area is provider data.';
COMMENT ON COLUMN catalog.gig_template_versions.published_at IS 'When the version became ACTIVE (set by the guard; NULL for a DRAFT and for a discarded draft).';
COMMENT ON COLUMN catalog.gig_template_versions.closed_at IS 'When the version stopped being current (SUPERSEDED or RETIRED), set by the guard.';

-- =====================================================================================================================
-- 4. gig_template_fields (typed field definitions of a version)
-- =====================================================================================================================
CREATE TABLE catalog.gig_template_fields (
  gig_template_field_id   uuid        NOT NULL DEFAULT gen_random_uuid(),
  gig_template_version_id uuid        NOT NULL,
  field_key               text        NOT NULL,
  field_type              text        NOT NULL,
  section                 text        NOT NULL DEFAULT 'DETAILS',
  behavior                text        NOT NULL,
  customer_visible        boolean     NOT NULL DEFAULT true,
  display_order           integer     NOT NULL,
  label_content_key       text        NOT NULL,
  help_content_key        text,
  default_content_key     text,
  min_length              integer,
  max_length              integer,
  min_number              numeric(18, 4),
  max_number              numeric(18, 4),
  default_number          numeric(18, 4),
  default_boolean         boolean,
  min_items               integer,
  max_items               integer,
  CONSTRAINT pk_gig_template_fields PRIMARY KEY (gig_template_field_id),
  CONSTRAINT uq_gig_template_fields__key UNIQUE (gig_template_version_id, field_key),
  CONSTRAINT uq_gig_template_fields__order UNIQUE (gig_template_version_id, display_order),
  CONSTRAINT fk_gig_template_fields__version_id FOREIGN KEY (gig_template_version_id) REFERENCES catalog.gig_template_versions (gig_template_version_id) ON DELETE RESTRICT,
  CONSTRAINT fk_gig_template_fields__label_content_key FOREIGN KEY (label_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT fk_gig_template_fields__help_content_key FOREIGN KEY (help_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT fk_gig_template_fields__default_content_key FOREIGN KEY (default_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT ck_gig_template_fields__key CHECK (field_key ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND length(field_key) BETWEEN 2 AND 32),
  CONSTRAINT ck_gig_template_fields__type CHECK (field_type IN ('TEXT', 'LONG_TEXT', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'ENUM', 'DURATION', 'MONEY', 'MEDIA', 'EQUIPMENT_REFERENCE', 'SKILL_REFERENCE')),
  CONSTRAINT ck_gig_template_fields__section CHECK (section IN ('SCOPE', 'INCLUSIONS', 'EXCLUSIONS', 'PREPARATION', 'DETAILS')),
  CONSTRAINT ck_gig_template_fields__behavior CHECK (behavior IN ('PLATFORM_FIXED', 'PROVIDER_CONFIGURABLE', 'PROVIDER_REQUIRED')),
  CONSTRAINT ck_gig_template_fields__display_order CHECK (display_order BETWEEN 1 AND 999),
  -- a metadata column that does not belong to the field type is NULL
  CONSTRAINT ck_gig_template_fields__text_meta CHECK (field_type IN ('TEXT', 'LONG_TEXT') OR (min_length IS NULL AND max_length IS NULL AND default_content_key IS NULL)),
  CONSTRAINT ck_gig_template_fields__number_meta CHECK (field_type IN ('INTEGER', 'DECIMAL', 'DURATION') OR (min_number IS NULL AND max_number IS NULL AND default_number IS NULL)),
  CONSTRAINT ck_gig_template_fields__boolean_meta CHECK (field_type = 'BOOLEAN' OR default_boolean IS NULL),
  CONSTRAINT ck_gig_template_fields__items_meta CHECK (field_type IN ('MEDIA', 'EQUIPMENT_REFERENCE', 'SKILL_REFERENCE') OR (min_items IS NULL AND max_items IS NULL)),
  CONSTRAINT ck_gig_template_fields__length CHECK ((min_length IS NULL OR min_length >= 1) AND (max_length IS NULL OR max_length >= 1) AND (min_length IS NULL OR max_length IS NULL OR min_length <= max_length)),
  CONSTRAINT ck_gig_template_fields__number_order CHECK (
    (min_number IS NULL OR max_number IS NULL OR min_number <= max_number)
    AND (default_number IS NULL OR min_number IS NULL OR default_number >= min_number)
    AND (default_number IS NULL OR max_number IS NULL OR default_number <= max_number)),
  CONSTRAINT ck_gig_template_fields__number_shape CHECK (
    field_type NOT IN ('INTEGER', 'DURATION')
    OR ((min_number IS NULL OR min_number = trunc(min_number)) AND (max_number IS NULL OR max_number = trunc(max_number)) AND (default_number IS NULL OR default_number = trunc(default_number)))),
  CONSTRAINT ck_gig_template_fields__duration_positive CHECK (
    field_type <> 'DURATION' OR ((min_number IS NULL OR min_number >= 1) AND (max_number IS NULL OR max_number >= 1) AND (default_number IS NULL OR default_number >= 1))),
  CONSTRAINT ck_gig_template_fields__items CHECK (
    (min_items IS NULL OR min_items >= 0) AND (max_items IS NULL OR max_items >= 0) AND (min_items IS NULL OR max_items IS NULL OR min_items <= max_items)
    AND (field_type NOT IN ('EQUIPMENT_REFERENCE', 'SKILL_REFERENCE') OR max_items IS NULL OR max_items >= 1)),
  -- a PLATFORM_FIXED field has a value: only types with a default can be fixed, and the default must be set (an ENUM default is an option, checked at publication)
  CONSTRAINT ck_gig_template_fields__fixed CHECK (
    behavior <> 'PLATFORM_FIXED'
    OR (field_type IN ('TEXT', 'LONG_TEXT', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'ENUM', 'DURATION')
        AND CASE
              WHEN field_type IN ('TEXT', 'LONG_TEXT') THEN default_content_key IS NOT NULL
              WHEN field_type IN ('INTEGER', 'DECIMAL', 'DURATION') THEN default_number IS NOT NULL
              WHEN field_type = 'BOOLEAN' THEN default_boolean IS NOT NULL
              ELSE true
            END)),
  -- required media: at least one photo, and not a "no photos" field
  CONSTRAINT ck_gig_template_fields__media_required CHECK (NOT (field_type = 'MEDIA' AND behavior = 'PROVIDER_REQUIRED') OR (COALESCE(min_items, 0) >= 1 AND max_items IS DISTINCT FROM 0))
);
COMMENT ON TABLE catalog.gig_template_fields IS 'A typed field of a template version: what a provider fills (or what the platform fixes) when building a Gig. Behaviour: PLATFORM_FIXED (the platform''s value, not editable), PROVIDER_CONFIGURABLE (optional), PROVIDER_REQUIRED. Typed metadata columns instead of a JSON document (a column that does not belong to the type is NULL); labels, help and fixed texts are content keys derived from the template code and the field key (verified by the guard, shared by all versions). The rows of a published version are frozen. No provider value is stored.';
COMMENT ON COLUMN catalog.gig_template_fields.field_key IS 'Stable lower-case snake_case key of the field inside the template (2 to 32 characters), unique per version. The same key in two versions is the same concept: a field whose meaning changes gets a new key.';
COMMENT ON COLUMN catalog.gig_template_fields.section IS 'Where the builder groups the field: SCOPE, INCLUSIONS, EXCLUSIONS, PREPARATION (the scope group of PR-03.04) or DETAILS.';
COMMENT ON COLUMN catalog.gig_template_fields.behavior IS 'PLATFORM_FIXED | PROVIDER_CONFIGURABLE | PROVIDER_REQUIRED. "Editable" and "required" are derived from this one column, never stored twice.';
COMMENT ON COLUMN catalog.gig_template_fields.customer_visible IS 'Whether the value is shown to customers on the Gig (false = a builder-only input).';
COMMENT ON COLUMN catalog.gig_template_fields.label_content_key IS 'catalog.gig_template.<code>.field.<field_key>.label, a foreign key to content.entries. Written by the service and VERIFIED by the guard (CONTENT_KEY_MISMATCH).';
COMMENT ON COLUMN catalog.gig_template_fields.default_content_key IS 'TEXT and LONG_TEXT only: catalog.gig_template.<code>.field.<field_key>.default, the platform-written default (the fixed value of a PLATFORM_FIXED field).';
COMMENT ON COLUMN catalog.gig_template_fields.min_number IS 'INTEGER, DECIMAL and DURATION (minutes) bounds and default. MONEY fields carry no numeric metadata: amount limits are configuration (CFG-001), never template data.';
COMMENT ON COLUMN catalog.gig_template_fields.max_items IS 'MEDIA: the number of photos (0 = no photos are allowed); EQUIPMENT_REFERENCE and SKILL_REFERENCE: the number of selections. Whether photos are OPTIONAL, REQUIRED or PROHIBITED is derived: behaviour PROVIDER_REQUIRED with min_items >= 1, max_items = 0, otherwise optional.';

CREATE TABLE catalog.gig_template_field_options (
  gig_template_field_id uuid    NOT NULL,
  option_code           text    NOT NULL,
  label_content_key     text    NOT NULL,
  is_default            boolean NOT NULL DEFAULT false,
  display_order         integer NOT NULL,
  CONSTRAINT pk_gig_template_field_options PRIMARY KEY (gig_template_field_id, option_code),
  CONSTRAINT uq_gig_template_field_options__order UNIQUE (gig_template_field_id, display_order),
  CONSTRAINT fk_gig_template_field_options__field_id FOREIGN KEY (gig_template_field_id) REFERENCES catalog.gig_template_fields (gig_template_field_id) ON DELETE RESTRICT,
  CONSTRAINT fk_gig_template_field_options__label_content_key FOREIGN KEY (label_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT ck_gig_template_field_options__code CHECK (option_code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND length(option_code) BETWEEN 2 AND 32),
  CONSTRAINT ck_gig_template_field_options__display_order CHECK (display_order BETWEEN 1 AND 99)
);
CREATE UNIQUE INDEX uq_gig_template_field_options__default ON catalog.gig_template_field_options (gig_template_field_id) WHERE is_default;
COMMENT ON TABLE catalog.gig_template_field_options IS 'The options of an ENUM field (vehicle finish: wax, sealant, ceramic): a code, a content label derived from the template code, the field key and the option code, one optional default, an order. Frozen with the version.';
COMMENT ON COLUMN catalog.gig_template_field_options.label_content_key IS 'catalog.gig_template.<code>.field.<field_key>.option.<option_code>.label, a foreign key to content.entries; verified by the guard.';

-- =====================================================================================================================
-- 5. gig_template_requirements (hooks for the trust checkpoints)
-- =====================================================================================================================
CREATE TABLE catalog.gig_template_requirements (
  gig_template_requirement_id uuid NOT NULL DEFAULT gen_random_uuid(),
  gig_template_version_id     uuid NOT NULL,
  requirement_type            text NOT NULL,
  reference_code              text,
  CONSTRAINT pk_gig_template_requirements PRIMARY KEY (gig_template_requirement_id),
  CONSTRAINT uq_gig_template_requirements__requirement UNIQUE NULLS NOT DISTINCT (gig_template_version_id, requirement_type, reference_code),
  CONSTRAINT fk_gig_template_requirements__version_id FOREIGN KEY (gig_template_version_id) REFERENCES catalog.gig_template_versions (gig_template_version_id) ON DELETE RESTRICT,
  CONSTRAINT ck_gig_template_requirements__type CHECK (requirement_type IN ('SKILL', 'EQUIPMENT', 'LICENSE', 'INSURANCE', 'BACKGROUND_CHECK')),
  CONSTRAINT ck_gig_template_requirements__reference CHECK (reference_code IS NULL OR (reference_code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND length(reference_code) BETWEEN 2 AND 48))
);
COMMENT ON TABLE catalog.gig_template_requirements IS 'A requirement HOOK of a template version: the Gig built from it needs a skill, equipment, a licence, insurance or a background check (SV-09.01 sets the verification policy by category and market; this row says what THIS structure additionally needs). The optional reference_code is an opaque stable code of the catalogue entry that TRUST-001 will own; nothing validates it yet and no verification logic lives here. Frozen with the version.';
COMMENT ON COLUMN catalog.gig_template_requirements.reference_code IS 'NULL = the requirement type in general. Otherwise an opaque lower-case snake_case code (a specific skill or piece of equipment) whose catalogue does not exist yet (DEBT-0084).';

-- =====================================================================================================================
-- 6. market availability of a template
-- =====================================================================================================================
CREATE TABLE catalog.market_gig_templates (
  market_id       uuid        NOT NULL,
  gig_template_id uuid        NOT NULL,
  enabled         boolean     NOT NULL DEFAULT false,
  display_order   integer     NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_market_gig_templates PRIMARY KEY (market_id, gig_template_id),
  CONSTRAINT uq_market_gig_templates__market_order UNIQUE (market_id, display_order),
  CONSTRAINT fk_market_gig_templates__market_id FOREIGN KEY (market_id) REFERENCES geography.markets (market_id) ON DELETE RESTRICT,
  CONSTRAINT fk_market_gig_templates__gig_template_id FOREIGN KEY (gig_template_id) REFERENCES catalog.gig_templates (gig_template_id) ON DELETE RESTRICT,
  CONSTRAINT ck_market_gig_templates__display_order CHECK (display_order BETWEEN 1 AND 9999)
);
COMMENT ON TABLE catalog.market_gig_templates IS 'Whether a template is offered in a market (GEO-001 markets) and its position among the templates of that market. A row can be prepared before launch (enabled = false, or a template that is not ACTIVE yet), but a template is PUBLIC only while the market is ACTIVE and in effect, the service type is ACTIVE and public in that market, the template is ACTIVE with an ACTIVE version and this row is enabled. Rows are never deleted or truncated. No personal data.';
COMMENT ON COLUMN catalog.market_gig_templates.display_order IS 'Position among the templates of the market (ascending), unique per market over ALL rows; gaps of 10 by convention.';

-- Index justification (DATA_MODEL_GUARDRAILS rule 11). Besides the primary keys and unique constraints (each a lookup path or a foreign key target):
--   uq_gig_templates__code: the identity lookup of every read and of the API path.
--   idx_gig_templates__service_type (service_type_id): the templates of ONE service type (the list by service type, the foreign key).
--   uq_gig_template_versions__number (template, number): the versions of a template and the contiguity rule; uq_gig_template_versions__active: THE active-version lookup and the rule that there is one;
--     uq_gig_template_versions__draft: the one-draft rule.
--   uq_gig_template_fields__key / __order (version, field_key | display_order): the fields of a version in order and the uniqueness rules (the leading column serves the foreign key).
--   pk_gig_template_field_options (field, code), uq_gig_template_field_options__order and __default: the options of a field in order, one default.
--   uq_gig_template_requirements__requirement (version, type, reference): the requirements of a version and their uniqueness.
--   uq_market_gig_templates__market_order (market, order): THE access path of a market's templates in order and the order rule; pk_market_gig_templates: one row per pair and the market foreign key.
-- Foreign keys deliberately WITHOUT a supporting index (never-deleted targets, no filtered query on the referencing column, tables of tens or hundreds of rows):
--   market_gig_templates.gig_template_id, the content key columns, and the new audit_events subject columns.

-- =====================================================================================================================
-- 7. audit trail: the CAT-001 table gets the template subjects (nullable; the subject CHECK allows exactly one kind of subject)
-- =====================================================================================================================
ALTER TABLE catalog.audit_events
  ADD COLUMN gig_template_id uuid,
  ADD COLUMN gig_template_version_id uuid,
  ADD CONSTRAINT fk_audit_events__gig_template_id FOREIGN KEY (gig_template_id) REFERENCES catalog.gig_templates (gig_template_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_audit_events__gig_template_version_id FOREIGN KEY (gig_template_version_id) REFERENCES catalog.gig_template_versions (gig_template_version_id) ON DELETE RESTRICT;
COMMENT ON COLUMN catalog.audit_events.gig_template_id IS 'The Gig Template of a GIG_TEMPLATE_* or MARKET_GIG_TEMPLATE_* action.';
COMMENT ON COLUMN catalog.audit_events.gig_template_version_id IS 'The template version of a GIG_TEMPLATE_VERSION_* action. The changes diff holds identifiers, keys and counts, never copy.';

ALTER TABLE catalog.audit_events DROP CONSTRAINT ck_audit_events__action, DROP CONSTRAINT ck_audit_events__subject;
ALTER TABLE catalog.audit_events
  ADD CONSTRAINT ck_audit_events__action CHECK (action IN (
    'CATEGORY_CREATED', 'CATEGORY_UPDATED', 'CATEGORY_STATUS_CHANGED',
    'SERVICE_TYPE_CREATED', 'SERVICE_TYPE_UPDATED', 'SERVICE_TYPE_STATUS_CHANGED',
    'PROHIBITED_SERVICE_CREATED', 'PROHIBITED_SERVICE_STATUS_CHANGED',
    'MARKET_CATALOG_AVAILABILITY_CHANGED',
    'GIG_TEMPLATE_CREATED', 'GIG_TEMPLATE_UPDATED', 'GIG_TEMPLATE_STATUS_CHANGED',
    'GIG_TEMPLATE_VERSION_CREATED', 'GIG_TEMPLATE_VERSION_CHANGED', 'GIG_TEMPLATE_VERSION_PUBLISHED', 'GIG_TEMPLATE_VERSION_RETIRED',
    'MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED')),
  ADD CONSTRAINT ck_audit_events__subject CHECK (
    (action LIKE 'CATEGORY\_%' AND category_id IS NOT NULL AND service_type_id IS NULL AND prohibited_service_id IS NULL AND market_id IS NULL
       AND gig_template_id IS NULL AND gig_template_version_id IS NULL)
    OR (action LIKE 'SERVICE\_TYPE\_%' AND service_type_id IS NOT NULL AND category_id IS NULL AND prohibited_service_id IS NULL AND market_id IS NULL
       AND gig_template_id IS NULL AND gig_template_version_id IS NULL)
    OR (action LIKE 'PROHIBITED\_SERVICE\_%' AND prohibited_service_id IS NOT NULL AND category_id IS NULL AND service_type_id IS NULL AND market_id IS NULL
       AND gig_template_id IS NULL AND gig_template_version_id IS NULL)
    OR (action = 'MARKET_CATALOG_AVAILABILITY_CHANGED' AND market_id IS NOT NULL AND prohibited_service_id IS NULL AND ((category_id IS NULL) <> (service_type_id IS NULL))
       AND gig_template_id IS NULL AND gig_template_version_id IS NULL)
    OR (action IN ('GIG_TEMPLATE_CREATED', 'GIG_TEMPLATE_UPDATED', 'GIG_TEMPLATE_STATUS_CHANGED')
       AND gig_template_id IS NOT NULL AND gig_template_version_id IS NULL AND category_id IS NULL AND service_type_id IS NULL AND prohibited_service_id IS NULL AND market_id IS NULL)
    OR (action IN ('GIG_TEMPLATE_VERSION_CREATED', 'GIG_TEMPLATE_VERSION_CHANGED', 'GIG_TEMPLATE_VERSION_PUBLISHED', 'GIG_TEMPLATE_VERSION_RETIRED')
       AND gig_template_id IS NOT NULL AND gig_template_version_id IS NOT NULL AND category_id IS NULL AND service_type_id IS NULL AND prohibited_service_id IS NULL AND market_id IS NULL)
    OR (action = 'MARKET_GIG_TEMPLATE_AVAILABILITY_CHANGED'
       AND market_id IS NOT NULL AND gig_template_id IS NOT NULL AND gig_template_version_id IS NULL AND category_id IS NULL AND service_type_id IS NULL AND prohibited_service_id IS NULL)
  );

-- =====================================================================================================================
-- 8. guards (all failures are SQLSTATE 23000 with DETAIL catalog_rule:<KEY>)
--    Lock order: category, service type, TEMPLATE, VERSION, field rows, market rows. The management service takes the template row FOR UPDATE first in every version operation; a child takes
--    its parent FOR SHARE inside its guard. A raw statement that locks a version before its template can deadlock with the service: the loser gets a retryable conflict.
-- =====================================================================================================================
CREATE FUNCTION catalog.guard_gig_templates() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a Gig Template is never deleted: retire it with status RETIRED' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'a Gig Template is created as DRAFT' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:MUST_START_AS_DRAFT';
    END IF;
    SELECT status INTO st_status FROM catalog.service_types WHERE service_type_id = NEW.service_type_id FOR SHARE;
    IF st_status = 'RETIRED' THEN
      RAISE EXCEPTION 'no Gig Template can be created under a RETIRED service type' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:SERVICE_TYPE_RETIRED';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.gig_template_id, NEW.service_type_id, NEW.code) IS DISTINCT FROM (OLD.gig_template_id, OLD.service_type_id, OLD.code) THEN
    RAISE EXCEPTION 'the id, the service type and the code of a Gig Template are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:IMMUTABLE_IDENTITY';
  END IF;
  PERFORM catalog.assert_status_transition(OLD.status, NEW.status);
  IF NEW.status = 'ACTIVE' AND OLD.status <> 'ACTIVE' THEN
    SELECT status INTO st_status FROM catalog.service_types WHERE service_type_id = NEW.service_type_id FOR SHARE;
    IF st_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'a Gig Template can be ACTIVE only while its service type is ACTIVE' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:SERVICE_TYPE_NOT_ACTIVE';
    END IF;
  END IF;
  IF NEW.status = 'RETIRED' AND OLD.status <> 'RETIRED' THEN
    IF EXISTS (SELECT 1 FROM catalog.gig_template_versions WHERE gig_template_id = OLD.gig_template_id AND status = 'DRAFT') THEN
      RAISE EXCEPTION 'a Gig Template cannot be retired while it has a DRAFT version: discard the draft first' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:GIG_TEMPLATE_HAS_OPEN_DRAFT';
    END IF;
    -- retirement closes the current version (history is kept): an ACTIVE version never sits under a RETIRED template
    UPDATE catalog.gig_template_versions SET status = 'RETIRED' WHERE gig_template_id = OLD.gig_template_id AND status = 'ACTIVE';
  END IF;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_gig_templates__guard BEFORE INSERT OR UPDATE OR DELETE ON catalog.gig_templates FOR EACH ROW EXECUTE FUNCTION catalog.guard_gig_templates();
CREATE TRIGGER trg_gig_templates__no_truncate BEFORE TRUNCATE ON catalog.gig_templates FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation();
COMMENT ON FUNCTION catalog.guard_gig_templates() IS 'Gig Template guard: created as DRAFT and not under a RETIRED service type, never deleted, id/service type/code immutable, the catalogue status machine, ACTIVE only under an ACTIVE service type (read FOR SHARE), no retirement with an open DRAFT version, retirement closes the ACTIVE version, created_at kept (NOT_DELETABLE, MUST_START_AS_DRAFT, SERVICE_TYPE_RETIRED, IMMUTABLE_IDENTITY, DRAFT_IS_INITIAL, STATUS_TRANSITION, SERVICE_TYPE_NOT_ACTIVE, GIG_TEMPLATE_HAS_OPEN_DRAFT).';

-- the checks a DRAFT must pass to be published (everything that needs the child rows or the content registry)
CREATE FUNCTION catalog.assert_version_publishable(p_version_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalog.gig_template_fields WHERE gig_template_version_id = p_version_id) THEN
    RAISE EXCEPTION 'a version without fields cannot be published' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:GIG_TEMPLATE_HAS_NO_FIELDS';
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
COMMENT ON FUNCTION catalog.assert_version_publishable(uuid) IS 'Publication checks that need the child rows or the content registry: at least one field, every ENUM field has options (and a PLATFORM_FIXED one a default), every content key of the template, its fields and options is PUBLISHED in the platform default locale (GIG_TEMPLATE_HAS_NO_FIELDS, ENUM_FIELD_WITHOUT_OPTIONS, FIXED_ENUM_WITHOUT_DEFAULT, CONTENT_NOT_PUBLISHED). Bounds, models and uniqueness are table constraints.';

CREATE FUNCTION catalog.guard_gig_template_versions() RETURNS trigger LANGUAGE plpgsql AS $$
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
       NEW.pricing_fixed, NEW.pricing_fixed_with_variants, NEW.pricing_bundle_eligible, NEW.pricing_drop_eligible,
       NEW.area_radius, NEW.area_postal_codes, NEW.area_polygon, NEW.created_at, NEW.published_at)
     IS DISTINCT FROM (
       OLD.revision, OLD.min_duration_minutes, OLD.max_duration_minutes, OLD.suggested_duration_minutes,
       OLD.pricing_fixed, OLD.pricing_fixed_with_variants, OLD.pricing_bundle_eligible, OLD.pricing_drop_eligible,
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
        NEW.pricing_drop_eligible, NEW.area_radius, NEW.area_postal_codes, NEW.area_polygon)
       IS DISTINCT FROM
       (OLD.revision, OLD.min_duration_minutes, OLD.max_duration_minutes, OLD.suggested_duration_minutes, OLD.pricing_fixed, OLD.pricing_fixed_with_variants, OLD.pricing_bundle_eligible,
        OLD.pricing_drop_eligible, OLD.area_radius, OLD.area_postal_codes, OLD.area_polygon) THEN
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
CREATE TRIGGER trg_gig_template_versions__guard BEFORE INSERT OR UPDATE OR DELETE ON catalog.gig_template_versions FOR EACH ROW EXECUTE FUNCTION catalog.guard_gig_template_versions();
CREATE TRIGGER trg_gig_template_versions__no_truncate BEFORE TRUNCATE ON catalog.gig_template_versions FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation();
COMMENT ON FUNCTION catalog.guard_gig_template_versions() IS 'Version guard: created as a fresh DRAFT with the next contiguous number and not for a RETIRED template, never deleted, id/template/number immutable, frozen structure once the version left DRAFT, the version status machine, publication needs an ACTIVE template and service type and passes assert_version_publishable and supersedes the previous ACTIVE version, SUPERSEDED only as a consequence of that publication, published_at / closed_at / created_at maintained (NOT_DELETABLE, MUST_START_AS_DRAFT, GIG_TEMPLATE_RETIRED, VERSION_NUMBER_SEQUENCE, IMMUTABLE_IDENTITY, VERSION_FROZEN, DRAFT_IS_INITIAL, STATUS_TRANSITION, GIG_TEMPLATE_NOT_ACTIVE, SERVICE_TYPE_NOT_ACTIVE, SUPERSEDED_IS_AUTOMATIC plus the publication rules).';

-- fields: only while the version is a DRAFT; the content keys are verified against the derivation
CREATE FUNCTION catalog.guard_gig_template_fields() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER trg_gig_template_fields__guard BEFORE INSERT OR UPDATE OR DELETE ON catalog.gig_template_fields FOR EACH ROW EXECUTE FUNCTION catalog.guard_gig_template_fields();
CREATE TRIGGER trg_gig_template_fields__no_truncate BEFORE TRUNCATE ON catalog.gig_template_fields FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation();
COMMENT ON FUNCTION catalog.guard_gig_template_fields() IS 'Field guard: ids immutable, rows change only while the version is a DRAFT (read FOR SHARE so a concurrent publication serializes), the label, help and default content keys equal the derivation from the template code and the field key (IMMUTABLE_IDENTITY, VERSION_NOT_DRAFT, CONTENT_KEY_MISMATCH).';

CREATE FUNCTION catalog.guard_gig_template_field_options() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  f_id     uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.gig_template_field_id ELSE NEW.gig_template_field_id END;
  v_id     uuid;
  v_status text;
  f_type   text;
  f_key    text;
  t_code   text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.gig_template_field_id IS DISTINCT FROM OLD.gig_template_field_id THEN
    RAISE EXCEPTION 'the field of an option is immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:IMMUTABLE_IDENTITY';
  END IF;
  SELECT gig_template_version_id, field_type, field_key INTO v_id, f_type, f_key FROM catalog.gig_template_fields WHERE gig_template_field_id = f_id;
  SELECT status INTO v_status FROM catalog.gig_template_versions WHERE gig_template_version_id = v_id FOR SHARE;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'the options of a field can change only while its version is a DRAFT' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:VERSION_NOT_DRAFT';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF f_type <> 'ENUM' THEN
    RAISE EXCEPTION 'only an ENUM field has options' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:OPTIONS_ONLY_FOR_ENUM';
  END IF;
  SELECT t.code INTO t_code FROM catalog.gig_template_versions v JOIN catalog.gig_templates t ON t.gig_template_id = v.gig_template_id WHERE v.gig_template_version_id = v_id;
  IF NEW.label_content_key <> 'catalog.gig_template.' || t_code || '.field.' || f_key || '.option.' || NEW.option_code || '.label' THEN
    RAISE EXCEPTION 'the content key of an option is derived from the template code, the field key and the option code' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:CONTENT_KEY_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_gig_template_field_options__guard BEFORE INSERT OR UPDATE OR DELETE ON catalog.gig_template_field_options FOR EACH ROW EXECUTE FUNCTION catalog.guard_gig_template_field_options();
CREATE TRIGGER trg_gig_template_field_options__no_truncate BEFORE TRUNCATE ON catalog.gig_template_field_options FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation();
COMMENT ON FUNCTION catalog.guard_gig_template_field_options() IS 'Option guard: the field is immutable, rows change only while the version is a DRAFT, only ENUM fields have options, the label key equals the derivation (IMMUTABLE_IDENTITY, VERSION_NOT_DRAFT, OPTIONS_ONLY_FOR_ENUM, CONTENT_KEY_MISMATCH).';

CREATE FUNCTION catalog.guard_gig_template_requirements() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_id     uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.gig_template_version_id ELSE NEW.gig_template_version_id END;
  v_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.gig_template_requirement_id, NEW.gig_template_version_id) IS DISTINCT FROM (OLD.gig_template_requirement_id, OLD.gig_template_version_id) THEN
    RAISE EXCEPTION 'the id and the version of a requirement are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:IMMUTABLE_IDENTITY';
  END IF;
  SELECT status INTO v_status FROM catalog.gig_template_versions WHERE gig_template_version_id = v_id FOR SHARE;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'the requirements of a version can change only while it is a DRAFT' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:VERSION_NOT_DRAFT';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_gig_template_requirements__guard BEFORE INSERT OR UPDATE OR DELETE ON catalog.gig_template_requirements FOR EACH ROW EXECUTE FUNCTION catalog.guard_gig_template_requirements();
CREATE TRIGGER trg_gig_template_requirements__no_truncate BEFORE TRUNCATE ON catalog.gig_template_requirements FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation();
COMMENT ON FUNCTION catalog.guard_gig_template_requirements() IS 'Requirement guard: ids immutable, rows change only while the version is a DRAFT (IMMUTABLE_IDENTITY, VERSION_NOT_DRAFT).';

CREATE FUNCTION catalog.guard_market_gig_templates() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t_status        text;
  becomes_enabled boolean := NEW.enabled;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a market availability row is never deleted: switch it off with enabled = false' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.market_id, NEW.gig_template_id) IS DISTINCT FROM (OLD.market_id, OLD.gig_template_id) THEN
      RAISE EXCEPTION 'the market and the Gig Template of an availability row are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:IMMUTABLE_IDENTITY';
    END IF;
    becomes_enabled := NEW.enabled AND NOT OLD.enabled;
  END IF;
  IF becomes_enabled THEN
    SELECT status INTO t_status FROM catalog.gig_templates WHERE gig_template_id = NEW.gig_template_id FOR SHARE;
    IF t_status = 'RETIRED' THEN
      RAISE EXCEPTION 'a RETIRED Gig Template cannot be enabled in a market' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:ITEM_RETIRED';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.created_at := OLD.created_at; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_market_gig_templates__guard BEFORE INSERT OR UPDATE OR DELETE ON catalog.market_gig_templates FOR EACH ROW EXECUTE FUNCTION catalog.guard_market_gig_templates();
CREATE TRIGGER trg_market_gig_templates__no_truncate BEFORE TRUNCATE ON catalog.market_gig_templates FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation();
COMMENT ON FUNCTION catalog.guard_market_gig_templates() IS 'Market Gig Template guard: never deleted, key immutable, a RETIRED template is never enabled (read FOR SHARE), created_at kept (NOT_DELETABLE, IMMUTABLE_IDENTITY, ITEM_RETIRED).';

-- =====================================================================================================================
-- 9. seed: the managed copy of two example templates (CFG-002), through the real content lifecycle (en-US only)
--    A deliberately minimal set to prove the model: the PRD's own example (Full Detail) and one home-cleaning template. Both stay DRAFT without versions. No variables, no personal data.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0016';
  v_reason      constant text := 'Initial Gig Template copy (migration 0016)';
  v_seed        record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1, 'UI_LABEL',   'catalog.gig_template.full_detail.name', 'Name of the Gig Template Full Detail', 'Full Detail'),
      (2, 'PLAIN_TEXT', 'catalog.gig_template.full_detail.description', 'One-line description of the Gig Template Full Detail', 'A complete interior and exterior detail of one vehicle.'),
      (3, 'PLAIN_TEXT', 'catalog.gig_template.full_detail.instructions', 'Provider instructions of the Gig Template Full Detail', 'Describe what your detail includes, the products you use and what the customer needs to prepare. Customers see what you list here, so be specific.'),
      (4, 'UI_LABEL',   'catalog.gig_template.standard_clean.name', 'Name of the Gig Template Standard Clean', 'Standard Clean'),
      (5, 'PLAIN_TEXT', 'catalog.gig_template.standard_clean.description', 'One-line description of the Gig Template Standard Clean', 'A routine clean of a home, room by room.'),
      (6, 'PLAIN_TEXT', 'catalog.gig_template.standard_clean.instructions', 'Provider instructions of the Gig Template Standard Clean', 'List the rooms and tasks included, what you bring and what you need from the customer before you arrive.')
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

-- =====================================================================================================================
-- 10. seed: the template identities (DRAFT, no versions: nothing is offered until an administrator builds, publishes, activates and enables one)
-- =====================================================================================================================
INSERT INTO catalog.gig_templates (service_type_id, code, description_content_key, instructions_content_key, status)
SELECT st.service_type_id, s.code, 'catalog.gig_template.' || s.code || '.description', 'catalog.gig_template.' || s.code || '.instructions', 'DRAFT'
FROM (VALUES ('car_detailing', 'full_detail'), ('regular_cleaning', 'standard_clean')) AS s (service_type_code, code)
JOIN catalog.service_types st ON st.code = s.service_type_code;

INSERT INTO catalog.audit_events (actor, action, gig_template_id, changes, reason, correlation_id)
SELECT 'system:migration', 'GIG_TEMPLATE_CREATED', gig_template_id, jsonb_build_object('status', jsonb_build_array(NULL, 'DRAFT')), 'Initial Gig Templates (migration 0016)', 'seed-0016'
FROM catalog.gig_templates;
