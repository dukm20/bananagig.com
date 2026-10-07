-- checkpoint: GEO-002
-- purpose: add the data-driven address model to the geography schema: administrative areas, versioned effective-dated address formats with ordered field definitions (label keys, requirement, length, input type, pattern, normalization), and ONE canonical, immutable structured address (single PostGIS point, validation status and source, raw input); seed the US format, the 50 states and DC, and the address field label copy
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. Formats, fields and addresses are never updated after publication/insert (a change is a new version or a new address row), so there is nothing to restore; reference rows are never deleted
-- backfill: none; every table is new. The only existing table touched is geography.audit_events, which gains one nullable column and two wider CHECK constraints (every existing row still satisfies them)
-- risk: low; new tables plus one additive change to geography.audit_events. Seeds are deterministic reference data (US address format, 50 states and DC, address field label and validation message copy entries with US-scoped wording); no business values, no personal data, no tax or payment data
-- destructive: the two CHECK constraints of geography.audit_events are dropped and re-created WIDER (added actions and one added subject column) in the same transaction; this is a pure widening, no row is changed, and the append-only trigger of the table is not involved (expand step of expand/migrate/contract, nothing is removed)
-- events: the seeded format is published without an outbox event (the seed runs before any consumer exists, exactly like 0006 and 0007); every format published after this migration goes through the service, which writes the event
-- audit: the seed writes the same audit trail the service writes (ADDRESS_FORMAT_DRAFTED, ADDRESS_FORMAT_PUBLISHED) for the US format, and the content audit trail for each label entry

-- =====================================================================================================================
-- 1. administrative areas (states, provinces, regions; hierarchical, country scoped)
-- =====================================================================================================================
CREATE TABLE geography.administrative_areas (
  administrative_area_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  country_id             uuid        NOT NULL,
  code                   text        NOT NULL,
  name                   text        NOT NULL,
  area_type              text        NOT NULL,
  status                 text        NOT NULL DEFAULT 'ACTIVE',
  parent_area_id         uuid,
  display_order          integer,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_administrative_areas PRIMARY KEY (administrative_area_id),
  CONSTRAINT uq_administrative_areas__country_code UNIQUE (country_id, code),
  CONSTRAINT uq_administrative_areas__area_country UNIQUE (administrative_area_id, country_id),
  CONSTRAINT uq_administrative_areas__area_country_code UNIQUE (administrative_area_id, country_id, code),
  CONSTRAINT fk_administrative_areas__country_id FOREIGN KEY (country_id) REFERENCES geography.countries (country_id) ON DELETE RESTRICT,
  CONSTRAINT fk_administrative_areas__parent FOREIGN KEY (parent_area_id, country_id) REFERENCES geography.administrative_areas (administrative_area_id, country_id) ON DELETE RESTRICT,
  CONSTRAINT ck_administrative_areas__code_format CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,9}$'),
  CONSTRAINT ck_administrative_areas__name_not_blank CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
  CONSTRAINT ck_administrative_areas__area_type CHECK (area_type IN ('STATE', 'PROVINCE', 'TERRITORY', 'DISTRICT', 'REGION', 'COUNTY', 'OTHER')),
  CONSTRAINT ck_administrative_areas__status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT ck_administrative_areas__display_order CHECK (display_order IS NULL OR display_order >= 0),
  CONSTRAINT ck_administrative_areas__not_own_parent CHECK (parent_area_id IS NULL OR parent_area_id <> administrative_area_id)
);
COMMENT ON TABLE geography.administrative_areas IS 'Canonical administrative areas of a country (states, provinces, regions), hierarchical through parent_area_id. code is the canonical code within the country without the country prefix (CA for California, the ISO 3166-2 subdivision part where one exists); name is the official proper name, not translated UI copy. Used by address formats whose ADMINISTRATIVE_AREA field has input_type LOOKUP. Only ACTIVE and INACTIVE (no PLANNED stage: a row has no activation prerequisites); rows are never deleted, identity (country, code, parent) is immutable, so a parent chain can never form a cycle. Only the areas a country format needs are loaded (no counties or cities).';
COMMENT ON COLUMN geography.administrative_areas.parent_area_id IS 'Parent area of the SAME country (composite foreign key with country_id), NULL for top-level areas. Immutable, and the parent must exist before the child, so cycles are impossible.';
COMMENT ON COLUMN geography.administrative_areas.display_order IS 'Optional explicit order for pickers; NULL means alphabetical by name.';

CREATE FUNCTION geography.guard_administrative_areas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'administrative areas cannot be deleted; deactivate them instead' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:NOT_DELETABLE';
  END IF;
  IF (NEW.administrative_area_id, NEW.country_id, NEW.code, NEW.parent_area_id, NEW.created_at) IS DISTINCT FROM (OLD.administrative_area_id, OLD.country_id, OLD.code, OLD.parent_area_id, OLD.created_at) THEN
    RAISE EXCEPTION 'administrative area identity (id, country, code and parent) is immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:IMMUTABLE_IDENTITY';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_administrative_areas__guard BEFORE UPDATE OR DELETE ON geography.administrative_areas FOR EACH ROW EXECUTE FUNCTION geography.guard_administrative_areas();

-- =====================================================================================================================
-- 2. address formats (one row per country version) and their ordered field definitions
-- =====================================================================================================================
CREATE TABLE geography.address_formats (
  address_format_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  country_id        uuid        NOT NULL,
  version           integer     NOT NULL,
  status            text        NOT NULL DEFAULT 'DRAFT',
  display_template  text        NOT NULL,
  effective_from    timestamptz NOT NULL,
  effective_to      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_address_formats PRIMARY KEY (address_format_id),
  CONSTRAINT uq_address_formats__country_version UNIQUE (country_id, version),
  CONSTRAINT uq_address_formats__format_country UNIQUE (address_format_id, country_id),
  CONSTRAINT fk_address_formats__country_id FOREIGN KEY (country_id) REFERENCES geography.countries (country_id) ON DELETE RESTRICT,
  CONSTRAINT ck_address_formats__version CHECK (version >= 1),
  CONSTRAINT ck_address_formats__status CHECK (status IN ('DRAFT', 'PUBLISHED')),
  CONSTRAINT ck_address_formats__template CHECK (length(display_template) BETWEEN 1 AND 500 AND display_template !~ '[\u0001-\u0009\u000B-\u001F\u007F]'),
  CONSTRAINT ck_address_formats__effective_range CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT ck_address_formats__draft_is_open CHECK (status <> 'DRAFT' OR effective_to IS NULL),
  CONSTRAINT ex_address_formats__no_overlap EXCLUDE USING gist (country_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&) WHERE (status = 'PUBLISHED')
);
COMMENT ON TABLE geography.address_formats IS 'One versioned address format per country. A format is created as DRAFT and published once; a published format is immutable except that its open end (effective_to) is closed exactly once when its successor starts. The exclusion constraint forbids two PUBLISHED formats of a country whose half-open periods [effective_from, effective_to) overlap, so exactly one format is in force at any time. A stored address references the exact version it was validated with (addresses.address_format_id), so an old address is never re-interpreted by a newer format. display_template renders the formatted address: lines separated by a newline, field tokens written {FIELD_TYPE}.';
COMMENT ON COLUMN geography.address_formats.display_template IS 'Ordered lines of the formatted address; each {FIELD_TYPE} token is replaced by the field value (tokens, lines and separators are dropped when the field is empty). At publication every field of the format must appear in the template and every token must be a field of the format.';
COMMENT ON COLUMN geography.address_formats.effective_from IS 'Proposed start while DRAFT; raised once (never lowered) to the actual start at publication; immutable afterwards.';

CREATE TABLE geography.address_format_fields (
  address_format_id uuid        NOT NULL,
  field_type        text        NOT NULL,
  display_order     smallint    NOT NULL,
  content_label_key text        NOT NULL,
  required          boolean     NOT NULL,
  max_length        smallint    NOT NULL,
  input_type        text        NOT NULL DEFAULT 'TEXT',
  validation_pattern text,
  example_value     text,
  autocomplete_hint text,
  normalization_rule text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_address_format_fields PRIMARY KEY (address_format_id, field_type),
  CONSTRAINT uq_address_format_fields__format_order UNIQUE (address_format_id, display_order),
  CONSTRAINT fk_address_format_fields__format FOREIGN KEY (address_format_id) REFERENCES geography.address_formats (address_format_id) ON DELETE RESTRICT,
  CONSTRAINT fk_address_format_fields__label_key FOREIGN KEY (content_label_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT ck_address_format_fields__field_type CHECK (field_type IN ('ORGANIZATION', 'ADDRESS_LINE_1', 'ADDRESS_LINE_2', 'DEPENDENT_LOCALITY', 'LOCALITY', 'ADMINISTRATIVE_AREA', 'POSTAL_CODE', 'SORTING_CODE')),
  CONSTRAINT ck_address_format_fields__display_order CHECK (display_order BETWEEN 1 AND 20),
  CONSTRAINT ck_address_format_fields__label_key_format CHECK (content_label_key ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$'),
  CONSTRAINT ck_address_format_fields__max_length CHECK (max_length BETWEEN 1 AND 200),
  CONSTRAINT ck_address_format_fields__input_type CHECK (input_type IN ('TEXT', 'LOOKUP')),
  CONSTRAINT ck_address_format_fields__lookup_only_for_area CHECK (input_type = 'TEXT' OR field_type = 'ADMINISTRATIVE_AREA'),
  CONSTRAINT ck_address_format_fields__lookup_has_no_pattern CHECK (input_type = 'TEXT' OR (validation_pattern IS NULL AND normalization_rule IS NULL)),
  CONSTRAINT ck_address_format_fields__pattern_length CHECK (validation_pattern IS NULL OR length(validation_pattern) BETWEEN 1 AND 200),
  CONSTRAINT ck_address_format_fields__example CHECK (example_value IS NULL OR (length(btrim(example_value)) > 0 AND length(example_value) <= 100 AND example_value !~ '[\u0000-\u001F\u007F]')),
  CONSTRAINT ck_address_format_fields__autocomplete_hint CHECK (autocomplete_hint IS NULL OR autocomplete_hint ~ '^[a-z][a-z0-9-]{0,39}$'),
  CONSTRAINT ck_address_format_fields__normalization_rule CHECK (normalization_rule IS NULL OR normalization_rule IN ('UPPERCASE', 'REMOVE_SPACES', 'UPPERCASE_REMOVE_SPACES'))
);
COMMENT ON TABLE geography.address_format_fields IS 'Ordered field definitions of one address format version. Field order, requirement, length, input type, pattern, example and normalization are data, and both the server validator and every client form read them from here (through the address-format read model), so no regex or field order is duplicated in code. Labels are content keys (managed copy), never text. Rows are inserted with their format while it is DRAFT and are immutable afterwards.';
COMMENT ON COLUMN geography.address_format_fields.input_type IS 'TEXT: free text validated by the optional pattern. LOOKUP (ADMINISTRATIVE_AREA only): the value must be a code or name of an ACTIVE administrative area of the country; the stored address then references the area row.';
COMMENT ON COLUMN geography.address_format_fields.validation_pattern IS 'Optional JavaScript regular expression the NORMALIZED value must fully match (vetted by the service: bounded length, no backreferences or nested quantifiers). Input length is capped by max_length before it runs.';
COMMENT ON COLUMN geography.address_format_fields.normalization_rule IS 'Optional normalization applied after the universal one (Unicode NFC, trim, collapse whitespace): UPPERCASE, REMOVE_SPACES or UPPERCASE_REMOVE_SPACES.';
COMMENT ON COLUMN geography.address_format_fields.autocomplete_hint IS 'HTML autocomplete token for the input (address-line1, address-level2, postal-code); advisory for clients.';

-- field rows may only be added while their format is DRAFT; they are never updated or deleted
CREATE FUNCTION geography.guard_address_format_fields() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  f_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'address format fields are immutable (% is not allowed)', TG_OP USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:ROW_IMMUTABLE';
  END IF;
  -- the format row is share-locked: a concurrent publication (an UPDATE of that row) serializes with this insert
  SELECT status INTO f_status FROM geography.address_formats WHERE address_format_id = NEW.address_format_id FOR SHARE;
  IF f_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'fields can only be added to a DRAFT address format' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:FORMAT_NOT_DRAFT';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_address_format_fields__guard BEFORE INSERT OR UPDATE OR DELETE ON geography.address_format_fields FOR EACH ROW EXECUTE FUNCTION geography.guard_address_format_fields();

CREATE FUNCTION geography.guard_address_formats() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n_fields integer;
  line1_required boolean;
  tok text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'address formats cannot be deleted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:NOT_DELETABLE';
  END IF;
  -- OLD does not exist for INSERT, so INSERT and UPDATE are handled in separate branches
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'an address format is created as DRAFT and published afterwards' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:FORMAT_MUST_START_AS_DRAFT';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.address_format_id, NEW.country_id, NEW.version, NEW.display_template, NEW.created_at) IS DISTINCT FROM (OLD.address_format_id, OLD.country_id, OLD.version, OLD.display_template, OLD.created_at) THEN
    RAISE EXCEPTION 'address format identity, version and template are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:FORMAT_IMMUTABLE';
  END IF;

  IF OLD.status = 'PUBLISHED' THEN
    IF NEW.status <> 'PUBLISHED' THEN
      RAISE EXCEPTION 'a published address format cannot go back to DRAFT' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:FORMAT_STATUS_TRANSITION';
    END IF;
    -- the only change a published format allows: its open end is closed ONCE
    IF NEW.effective_from <> OLD.effective_from OR (OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to) THEN
      RAISE EXCEPTION 'a published address format is immutable (only its open end can be closed, once)' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:FORMAT_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'DRAFT' THEN
    IF (NEW.effective_from, NEW.effective_to) IS DISTINCT FROM (OLD.effective_from, OLD.effective_to) THEN
      RAISE EXCEPTION 'a DRAFT address format cannot be edited; create a new version' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:FORMAT_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;

  -- DRAFT -> PUBLISHED
  IF NEW.effective_from < OLD.effective_from OR NEW.effective_to IS NOT NULL THEN
    RAISE EXCEPTION 'at publication the start may only be raised and the end stays open' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:FORMAT_IMMUTABLE';
  END IF;
  SELECT count(*), bool_or(field_type = 'ADDRESS_LINE_1' AND required) INTO n_fields, line1_required
    FROM geography.address_format_fields WHERE address_format_id = NEW.address_format_id;
  IF n_fields = 0 OR line1_required IS NOT TRUE THEN
    RAISE EXCEPTION 'an address format needs fields, including a required ADDRESS_LINE_1, to be published' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:FORMAT_INCOMPLETE';
  END IF;
  FOR tok IN SELECT (regexp_matches(NEW.display_template, '\{([A-Z0-9_]+)\}', 'g'))[1] LOOP
    IF NOT EXISTS (SELECT 1 FROM geography.address_format_fields WHERE address_format_id = NEW.address_format_id AND field_type = tok) THEN
      RAISE EXCEPTION 'the display template names a field the format does not define' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:FORMAT_TEMPLATE_MISMATCH';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM geography.address_format_fields f WHERE f.address_format_id = NEW.address_format_id AND position('{' || f.field_type || '}' IN NEW.display_template) = 0) THEN
    RAISE EXCEPTION 'every field of the format must appear in the display template' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:FORMAT_TEMPLATE_MISMATCH';
  END IF;
  IF EXISTS (SELECT 1 FROM geography.address_format_fields WHERE address_format_id = NEW.address_format_id AND input_type = 'LOOKUP')
     AND NOT EXISTS (SELECT 1 FROM geography.administrative_areas WHERE country_id = NEW.country_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'a LOOKUP field needs at least one ACTIVE administrative area in the country' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:LOOKUP_WITHOUT_AREAS';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_address_formats__guard BEFORE INSERT OR UPDATE OR DELETE ON geography.address_formats FOR EACH ROW EXECUTE FUNCTION geography.guard_address_formats();

-- =====================================================================================================================
-- 3. the canonical structured address (ONE model for customers, providers, bookings and businesses; ownership lives in the owning domain)
-- =====================================================================================================================
CREATE TABLE geography.addresses (
  address_id               uuid                  NOT NULL DEFAULT gen_random_uuid(),
  country_id               uuid                  NOT NULL,
  address_format_id        uuid                  NOT NULL,
  administrative_area_id   uuid,
  administrative_area_code text,
  administrative_area_name text,
  organization             text,
  address_line_1           text                  NOT NULL,
  address_line_2           text,
  dependent_locality       text,
  locality                 text,
  postal_code              text,
  sorting_code             text,
  location                 geography(Point,4326),
  time_zone_id             uuid,
  formatted_address        text                  NOT NULL,
  validation_status        text                  NOT NULL,
  validation_source        text                  NOT NULL,
  provider_code            text,
  provider_reference       text,
  raw_input                jsonb                 NOT NULL,
  created_at               timestamptz           NOT NULL DEFAULT now(),
  CONSTRAINT pk_addresses PRIMARY KEY (address_id),
  CONSTRAINT fk_addresses__country_id FOREIGN KEY (country_id) REFERENCES geography.countries (country_id) ON DELETE RESTRICT,
  CONSTRAINT fk_addresses__format_country FOREIGN KEY (address_format_id, country_id) REFERENCES geography.address_formats (address_format_id, country_id) ON DELETE RESTRICT,
  CONSTRAINT fk_addresses__area_country_code FOREIGN KEY (administrative_area_id, country_id, administrative_area_code) REFERENCES geography.administrative_areas (administrative_area_id, country_id, code) ON DELETE RESTRICT,
  CONSTRAINT fk_addresses__time_zone_id FOREIGN KEY (time_zone_id) REFERENCES geography.time_zones (time_zone_id) ON DELETE RESTRICT,
  CONSTRAINT ck_addresses__area_consistent CHECK ((administrative_area_id IS NULL) = (administrative_area_code IS NULL) AND (administrative_area_code IS NULL OR administrative_area_name IS NOT NULL)),
  CONSTRAINT ck_addresses__text_values CHECK (
    length(btrim(address_line_1)) > 0 AND length(address_line_1) <= 200
    AND (organization IS NULL OR (length(btrim(organization)) > 0 AND length(organization) <= 200))
    AND (address_line_2 IS NULL OR (length(btrim(address_line_2)) > 0 AND length(address_line_2) <= 200))
    AND (dependent_locality IS NULL OR (length(btrim(dependent_locality)) > 0 AND length(dependent_locality) <= 200))
    AND (locality IS NULL OR (length(btrim(locality)) > 0 AND length(locality) <= 200))
    AND (administrative_area_name IS NULL OR (length(btrim(administrative_area_name)) > 0 AND length(administrative_area_name) <= 200))
    AND (postal_code IS NULL OR (length(btrim(postal_code)) > 0 AND length(postal_code) <= 200))
    AND (sorting_code IS NULL OR (length(btrim(sorting_code)) > 0 AND length(sorting_code) <= 200))
  ),
  CONSTRAINT ck_addresses__formatted_address CHECK (length(btrim(formatted_address)) > 0 AND length(formatted_address) <= 1500),
  CONSTRAINT ck_addresses__validation_status CHECK (validation_status IN ('UNVERIFIED', 'FORMAT_VALID', 'GEOCODED', 'VERIFIED', 'INVALID')),
  CONSTRAINT ck_addresses__validation_source CHECK (validation_source IN ('MANUAL', 'AUTOCOMPLETE', 'GEOCODER', 'ADMIN', 'IMPORTED')),
  CONSTRAINT ck_addresses__located_status_has_location CHECK (validation_status NOT IN ('GEOCODED', 'VERIFIED') OR location IS NOT NULL),
  CONSTRAINT ck_addresses__manual_is_not_located CHECK (validation_source <> 'MANUAL' OR (location IS NULL AND validation_status IN ('UNVERIFIED', 'FORMAT_VALID', 'INVALID'))),
  CONSTRAINT ck_addresses__autocomplete_is_not_verified CHECK (validation_source <> 'AUTOCOMPLETE' OR validation_status IN ('UNVERIFIED', 'FORMAT_VALID', 'INVALID')),
  CONSTRAINT ck_addresses__verified_source CHECK (validation_status <> 'VERIFIED' OR validation_source IN ('GEOCODER', 'ADMIN')),
  CONSTRAINT ck_addresses__provider CHECK ((validation_source IN ('AUTOCOMPLETE', 'GEOCODER')) = (provider_code IS NOT NULL) OR validation_source = 'IMPORTED'),
  CONSTRAINT ck_addresses__provider_code_format CHECK (provider_code IS NULL OR provider_code ~ '^[a-z][a-z0-9_-]{1,39}$'),
  CONSTRAINT ck_addresses__provider_reference CHECK (provider_reference IS NULL OR (provider_code IS NOT NULL AND length(btrim(provider_reference)) > 0 AND length(provider_reference) <= 200 AND provider_reference !~ '[\u0000-\u001F\u007F]')),
  CONSTRAINT ck_addresses__raw_input CHECK (jsonb_typeof(raw_input) = 'object' AND length(raw_input::text) <= 4000)
);
COMMENT ON TABLE geography.addresses IS 'The ONE canonical structured address (no customer, provider, booking or business variants, no country-specific columns). Geography owns the structure; identity, provider and booking own who uses an address and reference address_id. Rows are IMMUTABLE once inserted (UPDATE is refused; enrichment such as a later geocode inserts a NEW row), so a confirmed booking that references address_id keeps the exact address accepted at booking time and no separate snapshot table is needed. PERSONAL DATA: never logged, never returned by a public API; a retention and erasure policy arrives with the first owning domain (DEBT-0036).';
COMMENT ON COLUMN geography.addresses.address_format_id IS 'The exact format VERSION the address was validated with (composite foreign key with country_id keeps it in the same country); a newer format never re-interprets this row. The service only inserts against a PUBLISHED format (trigger).';
COMMENT ON COLUMN geography.addresses.administrative_area_id IS 'Canonical area when the format field is a LOOKUP. The composite foreign key (id, country_id, code) keeps the area in the address country and the stored code equal to the area code, so an area of another country is impossible.';
COMMENT ON COLUMN geography.addresses.administrative_area_code IS 'Canonical area code (NULL exactly when administrative_area_id is NULL). Intentional denormalization of administrative_areas.code (immutable there), enforced by the composite foreign key; kept so the address preserves its normalized values.';
COMMENT ON COLUMN geography.addresses.administrative_area_name IS 'Area name: for a LOOKUP the canonical name AS OF insert (a snapshot: area names may be corrected later, the address keeps what it was accepted with); for formats whose ADMINISTRATIVE_AREA field is TEXT the normalized free text, with no id and no code.';
COMMENT ON COLUMN geography.addresses.location IS 'The single authoritative geospatial value: geography(Point,4326), built as ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography after the API boundary validated lat -90..90 and lng -180..180 (PostGIS silently coerces out-of-range input). Latitude and longitude are derived on read (ST_Y/ST_X of the geometry cast); there are no separate lat/lng columns, so they cannot drift. No spatial index until a spatial query exists.';
COMMENT ON COLUMN geography.addresses.time_zone_id IS 'Reference to geography.time_zones when a geocoder supplied a zone BananaGig has registered (never free text; an unknown zone is dropped). Later service scheduling uses the zone of the service address.';
COMMENT ON COLUMN geography.addresses.formatted_address IS 'Intentional, immutable denormalization: the display text (newline separated lines, country line excluded) generated by the central formatter from the format version used and the structured fields at insert time. Never produced by a client. It is never edited (the row is immutable), so it cannot drift; it can be recomputed from the row and its format version.';
COMMENT ON COLUMN geography.addresses.validation_status IS 'How far the address has been validated: UNVERIFIED (stored after format validation but not verified by any provider: the manual-entry fallback, marked for review, and imported rows), FORMAT_VALID (passed the country format AND a provider supplied or resolved it, without coordinates: an autocomplete selection), GEOCODED (a geocoder resolved coordinates), VERIFIED (confirmed by a verification provider or an administrator), INVALID (a verification provider rejected it). Autocomplete success is never verification.';
COMMENT ON COLUMN geography.addresses.validation_source IS 'Who supplied the structured data: MANUAL (typed by a person), AUTOCOMPLETE (a suggestion was selected), GEOCODER, ADMIN (an operator) or IMPORTED. MANUAL never carries coordinates; AUTOCOMPLETE is never GEOCODED or VERIFIED (a selection is not verification; geocoding it creates a GEOCODER row).';
COMMENT ON COLUMN geography.addresses.provider_code IS 'Provider-neutral adapter code (lower-case, for example mock) when a provider supplied the data; NULL for MANUAL and ADMIN. Required for AUTOCOMPLETE and GEOCODER.';
COMMENT ON COLUMN geography.addresses.raw_input IS 'What the person or provider submitted before normalization, as a JSON object keyed by field (its shape depends on the source: structured form fields, or a query plus the selected suggestion), at most 4000 characters. Read back whole, never queried relationally. PERSONAL DATA: never returned by ordinary responses or logs.';

-- Foreign keys deliberately WITHOUT a supporting index (DATA_MODEL_GUARDRAILS rule 11; same list and reasons as NORMALIZATION_LOG.md, GEO-002): the referenced
-- rows (countries, address formats, administrative areas, time zones) are never deleted or re-keyed, so no foreign key check ever scans addresses, and no query
-- filters addresses by country, format, area, time zone, postal code or location yet (lookup is by address_id). The spatial column gets a GiST index with the
-- first query that filters by location (service areas and search), through its own data model review. There are no speculative indexes.

CREATE FUNCTION geography.guard_addresses() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  f_status text;
  a_status text;
  z_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'addresses are immutable snapshots; insert a new address instead' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:ROW_IMMUTABLE';
  END IF;
  -- share locks: a concurrent publication, deactivation or format change serializes with this insert
  SELECT status INTO f_status FROM geography.address_formats WHERE address_format_id = NEW.address_format_id FOR SHARE;
  IF f_status IS DISTINCT FROM 'PUBLISHED' THEN
    RAISE EXCEPTION 'an address can only use a PUBLISHED address format' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:FORMAT_NOT_PUBLISHED';
  END IF;
  IF NEW.administrative_area_id IS NOT NULL THEN
    SELECT status INTO a_status FROM geography.administrative_areas WHERE administrative_area_id = NEW.administrative_area_id FOR SHARE;
    IF a_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'the administrative area is not ACTIVE' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:AREA_NOT_ACTIVE';
    END IF;
  END IF;
  IF NEW.time_zone_id IS NOT NULL THEN
    SELECT status INTO z_status FROM geography.time_zones WHERE time_zone_id = NEW.time_zone_id FOR SHARE;
    IF z_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'the time zone is not ACTIVE' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:TIME_ZONE_NOT_ACTIVE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_addresses__guard BEFORE INSERT OR UPDATE ON geography.addresses FOR EACH ROW EXECUTE FUNCTION geography.guard_addresses();

-- =====================================================================================================================
-- 4. audit: address format drafts and publications (expand step: wider constraints, one nullable subject column)
-- =====================================================================================================================
ALTER TABLE geography.audit_events ADD COLUMN address_format_id uuid;
ALTER TABLE geography.audit_events ADD CONSTRAINT fk_audit_events__address_format_id FOREIGN KEY (address_format_id) REFERENCES geography.address_formats (address_format_id) ON DELETE RESTRICT;
ALTER TABLE geography.audit_events DROP CONSTRAINT ck_audit_events__action;
ALTER TABLE geography.audit_events DROP CONSTRAINT ck_audit_events__subject;
ALTER TABLE geography.audit_events ADD CONSTRAINT ck_audit_events__action CHECK (action IN (
  'COUNTRY_CREATED', 'COUNTRY_UPDATED', 'COUNTRY_ACTIVATED', 'COUNTRY_DEACTIVATED', 'MARKET_CREATED', 'MARKET_UPDATED', 'MARKET_ACTIVATED', 'MARKET_DEACTIVATED',
  'COUNTRY_ADMINISTRATIVE_AREAS_UPDATED', 'ADDRESS_FORMAT_DRAFTED', 'ADDRESS_FORMAT_PUBLISHED'));
ALTER TABLE geography.audit_events ADD CONSTRAINT ck_audit_events__subject CHECK (
  (action LIKE 'COUNTRY\_%' AND country_id IS NOT NULL AND market_id IS NULL AND address_format_id IS NULL)
  OR (action LIKE 'MARKET\_%' AND market_id IS NOT NULL AND country_id IS NULL AND address_format_id IS NULL)
  OR (action LIKE 'ADDRESS\_FORMAT\_%' AND address_format_id IS NOT NULL AND country_id IS NULL AND market_id IS NULL)
);
COMMENT ON COLUMN geography.audit_events.address_format_id IS 'Subject of ADDRESS_FORMAT_* actions (the format row identifies its country and version); NULL for country and market actions.';
-- Audit trail of ONE address format, newest first; partial like the other two subject indexes (each row sets exactly one subject), also serves the foreign key.
CREATE INDEX idx_audit_events__address_format ON geography.audit_events (address_format_id, occurred_at DESC) WHERE address_format_id IS NOT NULL;

-- =====================================================================================================================
-- 5. seed: address field labels and validation messages as managed content (platform copy plus US-scoped wording), through the real content lifecycle
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0008';
  v_reason      constant text := 'Initial address field label copy (migration 0008)';
  v_seed        record;
  v_ver         record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1,  'UI_LABEL',   'address.field.line1',               'Label of the first street address line',                                       'Address line 1',                                          NULL::text),
      (2,  'UI_LABEL',   'address.field.line2',               'Label of the optional second address line (unit, suite, floor)',               'Address line 2',                                          NULL),
      (3,  'UI_LABEL',   'address.field.city',                'Label of the locality (city, town) address field',                             'City',                                                    NULL),
      (4,  'UI_LABEL',   'address.field.state',               'Label of the administrative-area address field (state, province, region)',     'State or region',                                         'State'),
      (5,  'UI_LABEL',   'address.field.postal_code',         'Label of the postal-code address field',                                       'Postal code',                                             'ZIP code'),
      (6,  'PLAIN_TEXT', 'address.error.required',            'Address validation message: a required field is empty',                        'This field is required.',                                 NULL),
      (7,  'PLAIN_TEXT', 'address.error.too_long',            'Address validation message: a value exceeds the maximum length of its field',  'This value is too long.',                                 NULL),
      (8,  'PLAIN_TEXT', 'address.error.invalid_format',      'Address validation message: a value does not match the country format',        'This value is not in the expected format.',               NULL),
      (9,  'PLAIN_TEXT', 'address.error.unknown_area',        'Address validation message: the area is not one of the listed areas',          'Choose one of the listed options.',                       NULL),
      (10, 'PLAIN_TEXT', 'address.error.unsupported_field',   'Address validation message: a field the country format does not use',          'This field is not used for this country.',                NULL),
      (11, 'PLAIN_TEXT', 'address.error.invalid_characters',  'Address validation message: a value contains characters that are not allowed', 'This value contains characters that are not allowed.',     NULL),
      (12, 'PLAIN_TEXT', 'address.error.lookup_unavailable',  'Address validation message: no areas are available to choose from',            'No options are available for this field.',                NULL)
    ) AS t (ord, content_type, key, description, platform_body, us_body)
    ORDER BY ord
  LOOP
    -- COUNTRY scope allowed: a country may word a label its own way (United States: State, ZIP code); every other country falls back to the platform copy
    INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
    VALUES (v_seed.key, v_seed.content_type, 'CONTENT', v_seed.description, 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'COUNTRY', v_actor)
    RETURNING entry_id INTO v_entry_id;
    INSERT INTO content.audit_events (occurred_at, actor, action, entry_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_actor, 'ENTRY_CREATED', v_entry_id, v_reason, v_correlation);

    FOR v_ver IN
      SELECT scope_type, scope_ref, body
      FROM (VALUES (1, 'PLATFORM', NULL::text, v_seed.platform_body), (2, 'COUNTRY', 'US', v_seed.us_body)) AS s (ord, scope_type, scope_ref, body)
      WHERE body IS NOT NULL
      ORDER BY ord
    LOOP
      INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, status, approval_policy, effective_from, reason, created_by)
      VALUES (v_entry_id, 'en-US', v_ver.scope_type, v_ver.scope_ref, 1, v_ver.body, 'DRAFT', 'NONE', v_from, v_reason, v_actor)
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
  END LOOP;
END
$seed$;

-- =====================================================================================================================
-- 6. seed: United States administrative areas (50 states and DC) and the US address format version 1
-- =====================================================================================================================
DO $seed$
DECLARE
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0008';
  v_country_id  uuid;
  v_format_id   uuid;
BEGIN
  SELECT country_id INTO STRICT v_country_id FROM geography.countries WHERE iso_alpha2 = 'US';

  INSERT INTO geography.administrative_areas (country_id, code, name, area_type)
  SELECT v_country_id, t.code, t.name, t.area_type
  FROM (VALUES
    ('AL', 'Alabama', 'STATE'), ('AK', 'Alaska', 'STATE'), ('AZ', 'Arizona', 'STATE'), ('AR', 'Arkansas', 'STATE'), ('CA', 'California', 'STATE'),
    ('CO', 'Colorado', 'STATE'), ('CT', 'Connecticut', 'STATE'), ('DE', 'Delaware', 'STATE'), ('DC', 'District of Columbia', 'DISTRICT'), ('FL', 'Florida', 'STATE'),
    ('GA', 'Georgia', 'STATE'), ('HI', 'Hawaii', 'STATE'), ('ID', 'Idaho', 'STATE'), ('IL', 'Illinois', 'STATE'), ('IN', 'Indiana', 'STATE'),
    ('IA', 'Iowa', 'STATE'), ('KS', 'Kansas', 'STATE'), ('KY', 'Kentucky', 'STATE'), ('LA', 'Louisiana', 'STATE'), ('ME', 'Maine', 'STATE'),
    ('MD', 'Maryland', 'STATE'), ('MA', 'Massachusetts', 'STATE'), ('MI', 'Michigan', 'STATE'), ('MN', 'Minnesota', 'STATE'), ('MS', 'Mississippi', 'STATE'),
    ('MO', 'Missouri', 'STATE'), ('MT', 'Montana', 'STATE'), ('NE', 'Nebraska', 'STATE'), ('NV', 'Nevada', 'STATE'), ('NH', 'New Hampshire', 'STATE'),
    ('NJ', 'New Jersey', 'STATE'), ('NM', 'New Mexico', 'STATE'), ('NY', 'New York', 'STATE'), ('NC', 'North Carolina', 'STATE'), ('ND', 'North Dakota', 'STATE'),
    ('OH', 'Ohio', 'STATE'), ('OK', 'Oklahoma', 'STATE'), ('OR', 'Oregon', 'STATE'), ('PA', 'Pennsylvania', 'STATE'), ('RI', 'Rhode Island', 'STATE'),
    ('SC', 'South Carolina', 'STATE'), ('SD', 'South Dakota', 'STATE'), ('TN', 'Tennessee', 'STATE'), ('TX', 'Texas', 'STATE'), ('UT', 'Utah', 'STATE'),
    ('VT', 'Vermont', 'STATE'), ('VA', 'Virginia', 'STATE'), ('WA', 'Washington', 'STATE'), ('WV', 'West Virginia', 'STATE'), ('WI', 'Wisconsin', 'STATE'),
    ('WY', 'Wyoming', 'STATE')
  ) AS t (code, name, area_type);

  -- created as DRAFT, fields added, then published (the guard validates completeness, the template and the LOOKUP prerequisite)
  INSERT INTO geography.address_formats (country_id, version, status, display_template, effective_from)
  VALUES (v_country_id, 1, 'DRAFT', E'{ADDRESS_LINE_1}\n{ADDRESS_LINE_2}\n{LOCALITY}, {ADMINISTRATIVE_AREA} {POSTAL_CODE}', now())
  RETURNING address_format_id INTO v_format_id;
  INSERT INTO geography.audit_events (actor, action, address_format_id, changes, reason, correlation_id)
  VALUES (v_actor, 'ADDRESS_FORMAT_DRAFTED', v_format_id, '{"version": [null, 1]}'::jsonb, 'US address format version 1 (migration 0008)', v_correlation);

  INSERT INTO geography.address_format_fields
    (address_format_id, field_type, display_order, content_label_key, required, max_length, input_type, validation_pattern, example_value, autocomplete_hint, normalization_rule)
  VALUES
    (v_format_id, 'ADDRESS_LINE_1',       1, 'address.field.line1',       true,  100, 'TEXT',   NULL,                          NULL,    'address-line1', NULL),
    (v_format_id, 'ADDRESS_LINE_2',       2, 'address.field.line2',       false, 100, 'TEXT',   NULL,                          NULL,    'address-line2', NULL),
    (v_format_id, 'LOCALITY',             3, 'address.field.city',        true,  60,  'TEXT',   NULL,                          NULL,    'address-level2', NULL),
    (v_format_id, 'ADMINISTRATIVE_AREA',  4, 'address.field.state',       true,  50,  'LOOKUP', NULL,                          NULL,    'address-level1', NULL),
    (v_format_id, 'POSTAL_CODE',          5, 'address.field.postal_code', true,  10,  'TEXT',   '^[0-9]{5}(-[0-9]{4})?$',      '12345', 'postal-code',   NULL);

  UPDATE geography.address_formats SET status = 'PUBLISHED', updated_at = now() WHERE address_format_id = v_format_id AND status = 'DRAFT';
  INSERT INTO geography.audit_events (actor, action, address_format_id, changes, reason, correlation_id)
  VALUES (v_actor, 'ADDRESS_FORMAT_PUBLISHED', v_format_id, '{"status": ["DRAFT", "PUBLISHED"]}'::jsonb, 'US address format version 1 (migration 0008)', v_correlation);
END
$seed$;
