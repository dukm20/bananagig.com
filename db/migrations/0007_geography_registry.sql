-- checkpoint: GEO-001
-- purpose: create the geography schema (currencies, time zones, countries, markets and their locale/time-zone links, audit) as data-driven reference data, and extend content.locales (the single locale authority) with a display name and derived language/script/region
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. Reference rows are never deleted (deactivate instead), so there is nothing to restore
-- backfill: content.locales.display_name is back-filled for the one existing row (en-US); language, script and region are generated columns. No other existing data is touched
-- risk: low; one table gains columns (a small table rewrite for the generated columns, 1 row), everything else is new. Seeds are deterministic launch reference data: US, USD, four US time zones, the US display-name content entry and the planned market la-oc. No business values, tax or payment data

-- =====================================================================================================================
-- 1. content.locales stays the ONE locale authority; GEO-001 only extends it (expand step, nothing is renamed or removed)
-- =====================================================================================================================
ALTER TABLE content.locales
  ADD COLUMN display_name text,
  ADD COLUMN language text GENERATED ALWAYS AS (split_part(locale, '-', 1)) STORED,
  ADD COLUMN script   text GENERATED ALWAYS AS (substring(locale from '^[a-z]{2,3}-([A-Z][a-z]{3})')) STORED,
  ADD COLUMN region   text GENERATED ALWAYS AS (substring(locale from '-([A-Z]{2}|[0-9]{3})$')) STORED;
UPDATE content.locales SET display_name = 'English (United States)' WHERE locale = 'en-US';
UPDATE content.locales SET display_name = locale WHERE display_name IS NULL;
ALTER TABLE content.locales ALTER COLUMN display_name SET NOT NULL;
ALTER TABLE content.locales ADD CONSTRAINT ck_locales__display_name_not_blank CHECK (length(btrim(display_name)) > 0);
COMMENT ON COLUMN content.locales.display_name IS 'Human-readable name of the locale (for example English (United States)). When a row is inserted without one, the tag itself is stored; the service derives a proper name with Intl.DisplayNames.';
COMMENT ON COLUMN content.locales.language IS 'Derived from the tag (generated column, cannot drift): the language subtag.';
COMMENT ON COLUMN content.locales.script IS 'Derived from the tag (generated column): the ISO 15924 script subtag, NULL when the tag has none.';
COMMENT ON COLUMN content.locales.region IS 'Derived from the tag (generated column): the region subtag (ISO 3166-1 alpha-2 or UN M.49 numeric), NULL when the tag has none.';

CREATE FUNCTION content.default_locale_display_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.display_name IS NULL OR btrim(NEW.display_name) = '' THEN
    NEW.display_name := NEW.locale;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_locales__default_display_name BEFORE INSERT ON content.locales FOR EACH ROW EXECUTE FUNCTION content.default_locale_display_name();

-- =====================================================================================================================
-- 2. geography schema
-- =====================================================================================================================
CREATE SCHEMA geography;
COMMENT ON SCHEMA geography IS 'Application-owned: country, currency, time zone and market reference data (data-driven defaults and activation). References content.locales for locales (the single locale authority). No address data, tax or payment configuration.';

-- ------------------------------------------------------------------ currencies (ISO 4217)
CREATE TABLE geography.currencies (
  currency_code     char(3)     NOT NULL,
  numeric_code      char(3)     NOT NULL,
  minor_unit_digits smallint    NOT NULL,
  display_name      text        NOT NULL,
  symbol            text,
  status            text        NOT NULL DEFAULT 'PLANNED',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_currencies PRIMARY KEY (currency_code),
  CONSTRAINT uq_currencies__numeric_code UNIQUE (numeric_code),
  CONSTRAINT ck_currencies__currency_code_format CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_currencies__numeric_code_format CHECK (numeric_code ~ '^[0-9]{3}$'),
  CONSTRAINT ck_currencies__minor_unit_digits CHECK (minor_unit_digits BETWEEN 0 AND 4),
  CONSTRAINT ck_currencies__display_name_not_blank CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT ck_currencies__symbol_length CHECK (symbol IS NULL OR length(symbol) BETWEEN 1 AND 8),
  CONSTRAINT ck_currencies__status CHECK (status IN ('PLANNED', 'ACTIVE', 'INACTIVE'))
);
COMMENT ON TABLE geography.currencies IS 'ISO 4217 currencies. minor_unit_digits is data (not every currency has 2): money elsewhere is amount_minor bigint plus this currency code. Code, numeric code and minor_unit_digits are immutable because stored amounts depend on them.';

-- ------------------------------------------------------------------ time zones (IANA)
CREATE TABLE geography.time_zones (
  time_zone_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  iana_name    text        NOT NULL,
  status       text        NOT NULL DEFAULT 'PLANNED',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_time_zones PRIMARY KEY (time_zone_id),
  CONSTRAINT uq_time_zones__iana_name UNIQUE (iana_name),
  CONSTRAINT ck_time_zones__iana_name_format CHECK (iana_name ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$' AND length(iana_name) <= 64),
  CONSTRAINT ck_time_zones__status CHECK (status IN ('PLANNED', 'ACTIVE', 'INACTIVE'))
);
COMMENT ON TABLE geography.time_zones IS 'IANA time zone identities (for example America/Los_Angeles). A NEW name must be listed in the database server''s tz database (pg_timezone_names), the posix/ and right/ alias trees are refused (trigger, checked on INSERT only: it reflects the server''s tzdata at that moment and is not re-validated when tzdata is updated); UTC offsets are never the identity because offsets change with daylight saving time. Deactivating a zone locks the ACTIVE countries that use it, so an ACTIVE country always keeps one ACTIVE zone.';

-- ------------------------------------------------------------------ countries
CREATE TABLE geography.countries (
  country_id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  iso_alpha2               char(2)     NOT NULL,
  iso_alpha3               char(3)     NOT NULL,
  iso_numeric              char(3)     NOT NULL,
  display_name_content_key text        NOT NULL,
  status                   text        NOT NULL DEFAULT 'PLANNED',
  dialing_code             text        NOT NULL,
  default_currency_code    char(3)     NOT NULL,
  default_locale           text        NOT NULL,
  distance_unit            text        NOT NULL,
  first_day_of_week        text        NOT NULL,
  date_format_code         text        NOT NULL,
  time_format_code         text        NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_countries PRIMARY KEY (country_id),
  CONSTRAINT uq_countries__iso_alpha2 UNIQUE (iso_alpha2),
  CONSTRAINT uq_countries__iso_alpha3 UNIQUE (iso_alpha3),
  CONSTRAINT uq_countries__iso_numeric UNIQUE (iso_numeric),
  CONSTRAINT fk_countries__display_name_content_key FOREIGN KEY (display_name_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT fk_countries__default_currency_code FOREIGN KEY (default_currency_code) REFERENCES geography.currencies (currency_code) ON DELETE RESTRICT,
  CONSTRAINT ck_countries__iso_alpha2_format CHECK (iso_alpha2 ~ '^[A-Z]{2}$'),
  CONSTRAINT ck_countries__iso_alpha3_format CHECK (iso_alpha3 ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_countries__iso_numeric_format CHECK (iso_numeric ~ '^[0-9]{3}$'),
  CONSTRAINT ck_countries__content_key_format CHECK (display_name_content_key ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$'),
  CONSTRAINT ck_countries__status CHECK (status IN ('PLANNED', 'ACTIVE', 'INACTIVE')),
  CONSTRAINT ck_countries__dialing_code_format CHECK (dialing_code ~ '^[+][0-9]{1,4}$'),
  CONSTRAINT ck_countries__distance_unit CHECK (distance_unit IN ('MILES', 'KILOMETERS')),
  CONSTRAINT ck_countries__first_day_of_week CHECK (first_day_of_week IN ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY')),
  CONSTRAINT ck_countries__date_format_code CHECK (date_format_code IN ('MDY', 'DMY', 'YMD')),
  CONSTRAINT ck_countries__time_format_code CHECK (time_format_code IN ('12_HOUR', '24_HOUR'))
);
COMMENT ON TABLE geography.countries IS 'One row per country (ISO 3166-1) with its data-driven display defaults. The display name is managed content (display_name_content_key points at a content entry). Format settings are normalized codes, not format strings; rendering uses Intl. Created as PLANNED; ACTIVE requires an ACTIVE default currency, an ACTIVE default locale and at least one ACTIVE time zone (trigger).';
COMMENT ON COLUMN geography.countries.default_locale IS 'Must be one of the country''s supported locales: the deferred composite foreign key to geography.country_locales (country_id, locale) enforces it. Locale validity and activity come from content.locales, the single locale authority.';

CREATE TABLE geography.country_locales (
  country_id uuid        NOT NULL,
  locale     text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_country_locales PRIMARY KEY (country_id, locale),
  CONSTRAINT fk_country_locales__country_id FOREIGN KEY (country_id) REFERENCES geography.countries (country_id) ON DELETE RESTRICT,
  CONSTRAINT fk_country_locales__locale FOREIGN KEY (locale) REFERENCES content.locales (locale) ON DELETE RESTRICT
);
COMMENT ON TABLE geography.country_locales IS 'Locales supported in a country (many-to-many). Its primary key is also the target of the countries default-locale foreign key.';

ALTER TABLE geography.countries
  ADD CONSTRAINT fk_countries__default_locale FOREIGN KEY (country_id, default_locale) REFERENCES geography.country_locales (country_id, locale) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE geography.country_time_zones (
  country_id   uuid        NOT NULL,
  time_zone_id uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_country_time_zones PRIMARY KEY (country_id, time_zone_id),
  CONSTRAINT fk_country_time_zones__country_id FOREIGN KEY (country_id) REFERENCES geography.countries (country_id) ON DELETE RESTRICT,
  CONSTRAINT fk_country_time_zones__time_zone_id FOREIGN KEY (time_zone_id) REFERENCES geography.time_zones (time_zone_id) ON DELETE RESTRICT
);
COMMENT ON TABLE geography.country_time_zones IS 'Time zones used in a country (many-to-many). A market default time zone must be one of its country''s zones (composite foreign key from markets).';

-- ------------------------------------------------------------------ markets
CREATE TABLE geography.markets (
  market_id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  code                 text        NOT NULL,
  name                 text        NOT NULL,
  country_id           uuid        NOT NULL,
  status               text        NOT NULL DEFAULT 'PLANNED',
  default_locale       text        NOT NULL,
  currency_code        char(3)     NOT NULL,
  default_time_zone_id uuid        NOT NULL,
  effective_from       timestamptz NOT NULL,
  effective_to         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_markets PRIMARY KEY (market_id),
  CONSTRAINT uq_markets__code UNIQUE (code),
  CONSTRAINT uq_markets__market_country UNIQUE (market_id, country_id),
  CONSTRAINT fk_markets__country_id FOREIGN KEY (country_id) REFERENCES geography.countries (country_id) ON DELETE RESTRICT,
  CONSTRAINT fk_markets__currency_code FOREIGN KEY (currency_code) REFERENCES geography.currencies (currency_code) ON DELETE RESTRICT,
  CONSTRAINT fk_markets__country_time_zone FOREIGN KEY (country_id, default_time_zone_id) REFERENCES geography.country_time_zones (country_id, time_zone_id) ON DELETE RESTRICT,
  CONSTRAINT ck_markets__code_format CHECK (code ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(code) <= 60),
  CONSTRAINT ck_markets__name_not_blank CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
  CONSTRAINT ck_markets__status CHECK (status IN ('PLANNED', 'ACTIVE', 'INACTIVE')),
  CONSTRAINT ck_markets__effective_range CHECK (effective_to IS NULL OR effective_to > effective_from)
);
COMMENT ON TABLE geography.markets IS 'A market: a first-class operating area inside one country, with its own default locale, currency and operational time zone. The distance unit and date/time defaults come from the country (single source, no copies). A market is in effect when ACTIVE and the half-open window [effective_from, effective_to) contains the evaluation time; the window is derived at read time, never stored as a flag. ACTIVE requires an ACTIVE country, currency, time zone and locale (trigger).';
COMMENT ON COLUMN geography.markets.default_locale IS 'Must be one of the market''s supported locales (deferred composite foreign key to market_locales), which in turn must be supported by the country.';

CREATE TABLE geography.market_locales (
  market_id  uuid        NOT NULL,
  country_id uuid        NOT NULL,
  locale     text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_market_locales PRIMARY KEY (market_id, locale),
  CONSTRAINT fk_market_locales__market_country FOREIGN KEY (market_id, country_id) REFERENCES geography.markets (market_id, country_id) ON DELETE RESTRICT,
  CONSTRAINT fk_market_locales__country_locale FOREIGN KEY (country_id, locale) REFERENCES geography.country_locales (country_id, locale) ON DELETE RESTRICT
);
COMMENT ON TABLE geography.market_locales IS 'Locales a market supports (many-to-many). country_id repeats markets.country_id only so that the composite foreign key can force every market locale to be supported by the market''s country; the foreign key makes drift impossible. Locale validity comes through country_locales to content.locales.';

ALTER TABLE geography.markets
  ADD CONSTRAINT fk_markets__default_locale FOREIGN KEY (market_id, default_locale) REFERENCES geography.market_locales (market_id, locale) DEFERRABLE INITIALLY DEFERRED;

-- Index justification (DATA_MODEL_GUARDRAILS rule 11). Besides the primary keys and unique constraints (each is a lookup path or a foreign key target):
--   idx_countries__active: the public active-country list (partial: anonymous callers never see other statuses, so the index stays tiny and ordered by code).
--   idx_markets__active:   the public active markets of a country, and the country deactivation guard (EXISTS ... WHERE country_id = ? AND status = 'ACTIVE').
CREATE INDEX idx_countries__active ON geography.countries (iso_alpha2) WHERE status = 'ACTIVE';
CREATE INDEX idx_markets__active ON geography.markets (country_id, code) WHERE status = 'ACTIVE';

-- ------------------------------------------------------------------ audit
CREATE TABLE geography.audit_events (
  audit_event_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor          text        NOT NULL,
  action         text        NOT NULL,
  country_id     uuid,
  market_id      uuid,
  changes        jsonb,
  reason         text,
  correlation_id text        NOT NULL,
  CONSTRAINT pk_audit_events PRIMARY KEY (audit_event_id),
  CONSTRAINT fk_audit_events__country_id FOREIGN KEY (country_id) REFERENCES geography.countries (country_id) ON DELETE RESTRICT,
  CONSTRAINT fk_audit_events__market_id FOREIGN KEY (market_id) REFERENCES geography.markets (market_id) ON DELETE RESTRICT,
  CONSTRAINT ck_audit_events__action CHECK (action IN ('COUNTRY_CREATED', 'COUNTRY_UPDATED', 'COUNTRY_ACTIVATED', 'COUNTRY_DEACTIVATED', 'MARKET_CREATED', 'MARKET_UPDATED', 'MARKET_ACTIVATED', 'MARKET_DEACTIVATED')),
  CONSTRAINT ck_audit_events__subject CHECK (
    (action LIKE 'COUNTRY\_%' AND country_id IS NOT NULL AND market_id IS NULL)
    OR (action LIKE 'MARKET\_%' AND market_id IS NOT NULL AND country_id IS NULL)
  ),
  CONSTRAINT ck_audit_events__changes_object CHECK (changes IS NULL OR jsonb_typeof(changes) = 'object')
);
COMMENT ON TABLE geography.audit_events IS 'Append-only audit trail of every geography management mutation: actor, subject (exactly one of country or market), action, field-level diff, reason, time and correlation id. changes is a JSON object {field: [old, new]} because its shape depends on the subject; reference values are public, so unlike configuration the values are recorded.';
-- Audit trail of ONE subject, newest first. Partial because exactly one of country_id / market_id is set per row (ck_audit_events__subject), so each index
-- holds only its own half; they also serve the foreign key checks of the two subject columns.
CREATE INDEX idx_audit_events__country ON geography.audit_events (country_id, occurred_at DESC) WHERE country_id IS NOT NULL;
CREATE INDEX idx_audit_events__market ON geography.audit_events (market_id, occurred_at DESC) WHERE market_id IS NOT NULL;

-- Foreign keys deliberately WITHOUT a supporting index (DATA_MODEL_GUARDRAILS rule 11; same list and reasons as NORMALIZATION_LOG.md, GEO-001). These are tiny
-- reference tables (tens of rows), rows are never deleted or re-keyed, and no query filters by these columns alone; the guard queries that start from them scan the
-- tables:
--   countries.display_name_content_key, countries.default_currency_code, markets.currency_code: targets (content.entries, geography.currencies) are never deleted;
--     the currency deactivation guard scans countries and markets, which hold tens of rows.
--   markets.country_id: the one hot path (active markets of a country) is the partial idx_markets__active; the management list by country scans a tiny table.
--   markets (country_id, default_time_zone_id), market_locales (country_id, locale): composite links whose targets are never deleted or updated while referenced.
--   markets.default_time_zone_id, country_time_zones.time_zone_id, country_locales.locale: the second column of a composite key or a never-deleted target; the
--     guards that start from a zone or a locale (zone deactivation, locale deactivation) scan tiny tables.
--   countries.default_locale, markets.default_locale: covered through the composite default-locale keys, whose referencing columns are not indexed separately.
-- If a table ever grows to thousands of rows, an index is added through its own data model review; there are no speculative indexes.

-- =====================================================================================================================
-- 3. guards: the database enforces the activation rules and immutability itself (defense in depth under the service)
--    Dependency rows are locked FOR SHARE while an activation is validated, so a concurrent deactivation (which needs the
--    row lock) serializes with it: exactly one of the two wins and the other sees the committed result. A rule that reads SIBLING
--    rows (the last ACTIVE zone of an ACTIVE country) first locks the row that owns the invariant (the country), because a plain
--    read of siblings is blind to a concurrent, uncommitted change of another sibling (write skew). Lock order used by the service
--    and the triggers: markets of a country (market_id order), then the country, then currency, time zone and locale rows. The one
--    inversion is inherent: a time zone row is locked by the UPDATE itself before its trigger can lock the country, so a raw SQL zone
--    deactivation racing a market activation can deadlock; PostgreSQL aborts one side (40P01) and the service maps it to a retryable error.
--    Every RAISE carries a machine-readable key in DETAIL (exactly 'geography_rule:<KEY>'); the service classifies guard errors by that
--    key, never by message text (messages contain user-chosen codes).
-- =====================================================================================================================
CREATE FUNCTION geography.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (% is not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:ROW_IMMUTABLE';
END;
$$;
CREATE TRIGGER trg_audit_events__immutable BEFORE UPDATE OR DELETE ON geography.audit_events FOR EACH ROW EXECUTE FUNCTION geography.forbid_mutation();

CREATE FUNCTION geography.guard_currencies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'currencies cannot be deleted; deactivate them instead' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:NOT_DELETABLE';
  END IF;
  IF (NEW.currency_code, NEW.numeric_code, NEW.minor_unit_digits, NEW.created_at) IS DISTINCT FROM (OLD.currency_code, OLD.numeric_code, OLD.minor_unit_digits, OLD.created_at) THEN
    RAISE EXCEPTION 'currency code, numeric code and minor unit digits are immutable (stored amounts depend on them)' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:IMMUTABLE_IDENTITY';
  END IF;
  IF NEW.status = 'PLANNED' AND OLD.status <> 'PLANNED' THEN
    RAISE EXCEPTION 'PLANNED is the initial status and cannot be set again (currency %)', OLD.currency_code USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:PLANNED_IS_INITIAL';
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE' THEN
    IF EXISTS (SELECT 1 FROM geography.countries WHERE default_currency_code = OLD.currency_code AND status = 'ACTIVE')
       OR EXISTS (SELECT 1 FROM geography.markets WHERE currency_code = OLD.currency_code AND status = 'ACTIVE') THEN
      RAISE EXCEPTION 'currency % is used by an ACTIVE country or market and cannot be deactivated', OLD.currency_code USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:CURRENCY_IN_USE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_currencies__guard BEFORE UPDATE OR DELETE ON geography.currencies FOR EACH ROW EXECUTE FUNCTION geography.guard_currencies();

CREATE FUNCTION geography.guard_time_zones() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'time zones cannot be deleted; deactivate them instead' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- posix/ and right/ are alias trees that PostgreSQL lists in pg_timezone_names; they are never time zone identities here
    IF NEW.iana_name ~ '^(posix|right)/' THEN
      RAISE EXCEPTION '% is not an IANA time zone known to the database', NEW.iana_name USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:NOT_IANA';
    END IF;
    -- an already registered name conflicts on the unique index (or is skipped by ON CONFLICT DO NOTHING): do not pay for the tz scan (about 20 ms) again
    IF EXISTS (SELECT 1 FROM geography.time_zones WHERE iana_name = NEW.iana_name) THEN
      RETURN NEW;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.iana_name) THEN
      RAISE EXCEPTION '% is not an IANA time zone known to the database', NEW.iana_name USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:NOT_IANA';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.time_zone_id <> OLD.time_zone_id OR NEW.iana_name <> OLD.iana_name OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'time zone identity is immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:IMMUTABLE_IDENTITY';
  END IF;
  IF NEW.status = 'PLANNED' AND OLD.status <> 'PLANNED' THEN
    RAISE EXCEPTION 'PLANNED is the initial status and cannot be set again (time zone %)', OLD.iana_name USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:PLANNED_IS_INITIAL';
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE' THEN
    IF EXISTS (SELECT 1 FROM geography.markets WHERE default_time_zone_id = OLD.time_zone_id AND status = 'ACTIVE') THEN
      RAISE EXCEPTION 'time zone % is needed by an ACTIVE market and cannot be deactivated', OLD.iana_name USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:TIME_ZONE_IN_USE';
    END IF;
    -- "an ACTIVE country keeps at least one ACTIVE zone" reads SIBLING zones. Two deactivations of two different zones of the same country
    -- would each see the other still ACTIVE (neither change is committed) and both pass. So every ACTIVE country that uses this zone is locked
    -- FIRST (country_id order, so two deactivations cannot deadlock on the countries); the second deactivation then waits, and its sibling
    -- check below (a new statement, hence a new snapshot) sees the first one committed.
    PERFORM 1 FROM geography.countries c
      WHERE c.status = 'ACTIVE' AND c.country_id IN (SELECT cz.country_id FROM geography.country_time_zones cz WHERE cz.time_zone_id = OLD.time_zone_id)
      ORDER BY c.country_id FOR UPDATE OF c;
    IF EXISTS (
         SELECT 1
           FROM geography.country_time_zones cz
           JOIN geography.countries c ON c.country_id = cz.country_id AND c.status = 'ACTIVE'
          WHERE cz.time_zone_id = OLD.time_zone_id
            AND NOT EXISTS (
              SELECT 1 FROM geography.country_time_zones cz2 JOIN geography.time_zones t2 ON t2.time_zone_id = cz2.time_zone_id
               WHERE cz2.country_id = cz.country_id AND t2.time_zone_id <> OLD.time_zone_id AND t2.status = 'ACTIVE')) THEN
      RAISE EXCEPTION 'time zone % is the only ACTIVE zone of an ACTIVE country and cannot be deactivated', OLD.iana_name USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:TIME_ZONE_IN_USE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_time_zones__guard BEFORE INSERT OR UPDATE OR DELETE ON geography.time_zones FOR EACH ROW EXECUTE FUNCTION geography.guard_time_zones();

CREATE FUNCTION geography.guard_countries() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cur_status text;
  loc_active boolean;
  must_validate boolean := false;
  activating boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'countries cannot be deleted; deactivate them instead' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:NOT_DELETABLE';
  END IF;
  -- OLD does not exist for INSERT, so INSERT and UPDATE are handled in separate branches
  IF TG_OP = 'INSERT' THEN
    activating := NEW.status = 'ACTIVE';
    must_validate := activating;
  ELSE
    IF (NEW.country_id, NEW.iso_alpha2, NEW.iso_alpha3, NEW.iso_numeric, NEW.created_at) IS DISTINCT FROM (OLD.country_id, OLD.iso_alpha2, OLD.iso_alpha3, OLD.iso_numeric, OLD.created_at) THEN
      RAISE EXCEPTION 'country identity (id and ISO codes) is immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:IMMUTABLE_IDENTITY';
    END IF;
    IF NEW.status = 'PLANNED' AND OLD.status <> 'PLANNED' THEN
      RAISE EXCEPTION 'PLANNED is the initial status and cannot be set again (country %)', OLD.iso_alpha2 USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:PLANNED_IS_INITIAL';
    END IF;
    activating := NEW.status = 'ACTIVE' AND OLD.status <> 'ACTIVE';
    must_validate := NEW.status = 'ACTIVE' AND (OLD.status <> 'ACTIVE' OR NEW.default_currency_code <> OLD.default_currency_code OR NEW.default_locale <> OLD.default_locale);
  END IF;

  IF must_validate THEN
    SELECT status INTO cur_status FROM geography.currencies WHERE currency_code = NEW.default_currency_code FOR SHARE;
    IF cur_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'country % cannot be ACTIVE: its default currency % is not ACTIVE', NEW.iso_alpha2, NEW.default_currency_code USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:CURRENCY_NOT_ACTIVE';
    END IF;
    SELECT is_active INTO loc_active FROM content.locales WHERE locale = NEW.default_locale FOR SHARE;
    IF loc_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'country % cannot be ACTIVE: its default locale % is not an ACTIVE locale', NEW.iso_alpha2, NEW.default_locale USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:LOCALE_NOT_ACTIVE';
    END IF;
  END IF;
  IF activating THEN
    -- Only an activation needs the zone check: for an ACTIVE country the zone rule is kept by the time zone guard (it locks the country) and the
    -- links are frozen. The ACTIVE zones relied on are locked FOR SHARE, so a concurrent deactivation of the last one serializes with this activation
    -- (and a concurrent removal of the last link serializes through the share lock guard_country_links takes on this country row).
    PERFORM 1 FROM geography.country_time_zones cz JOIN geography.time_zones t ON t.time_zone_id = cz.time_zone_id
      WHERE cz.country_id = NEW.country_id AND t.status = 'ACTIVE' FOR SHARE OF t;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'country % cannot be ACTIVE: it has no ACTIVE time zone (create it as PLANNED, link its time zones, then activate)', NEW.iso_alpha2 USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:NO_ACTIVE_TIME_ZONE';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE' THEN
      IF EXISTS (SELECT 1 FROM geography.markets WHERE country_id = OLD.country_id AND status = 'ACTIVE') THEN
        RAISE EXCEPTION 'country % has ACTIVE markets and cannot be deactivated; deactivate its markets first', OLD.iso_alpha2 USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:COUNTRY_HAS_ACTIVE_MARKETS';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_countries__guard BEFORE INSERT OR UPDATE OR DELETE ON geography.countries FOR EACH ROW EXECUTE FUNCTION geography.guard_countries();

CREATE FUNCTION geography.guard_markets() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ctry_status text;
  cur_status text;
  tz_status text;
  loc_active boolean;
  must_validate boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'markets cannot be deleted; deactivate them instead' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:NOT_DELETABLE';
  END IF;
  -- OLD does not exist for INSERT, so INSERT and UPDATE are handled in separate branches
  IF TG_OP = 'INSERT' THEN
    must_validate := NEW.status = 'ACTIVE';
  ELSE
    IF (NEW.market_id, NEW.code, NEW.country_id, NEW.created_at) IS DISTINCT FROM (OLD.market_id, OLD.code, OLD.country_id, OLD.created_at) THEN
      RAISE EXCEPTION 'market identity (id, code and country) is immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:IMMUTABLE_IDENTITY';
    END IF;
    IF NEW.status = 'PLANNED' AND OLD.status <> 'PLANNED' THEN
      RAISE EXCEPTION 'PLANNED is the initial status and cannot be set again (market %)', OLD.code USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:PLANNED_IS_INITIAL';
    END IF;
    must_validate := NEW.status = 'ACTIVE' AND (OLD.status <> 'ACTIVE' OR NEW.currency_code <> OLD.currency_code OR NEW.default_locale <> OLD.default_locale OR NEW.default_time_zone_id <> OLD.default_time_zone_id);
  END IF;

  IF must_validate THEN
    SELECT status INTO ctry_status FROM geography.countries WHERE country_id = NEW.country_id FOR SHARE;
    IF ctry_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'market % cannot be ACTIVE: its country is not ACTIVE', NEW.code USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:COUNTRY_NOT_ACTIVE';
    END IF;
    SELECT status INTO cur_status FROM geography.currencies WHERE currency_code = NEW.currency_code FOR SHARE;
    IF cur_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'market % cannot be ACTIVE: its currency % is not ACTIVE', NEW.code, NEW.currency_code USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:CURRENCY_NOT_ACTIVE';
    END IF;
    SELECT status INTO tz_status FROM geography.time_zones WHERE time_zone_id = NEW.default_time_zone_id FOR SHARE;
    IF tz_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'market % cannot be ACTIVE: its default time zone is not ACTIVE', NEW.code USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:TIME_ZONE_NOT_ACTIVE';
    END IF;
    SELECT is_active INTO loc_active FROM content.locales WHERE locale = NEW.default_locale FOR SHARE;
    IF loc_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'market % cannot be ACTIVE: its default locale % is not an ACTIVE locale', NEW.code, NEW.default_locale USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:LOCALE_NOT_ACTIVE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_markets__guard BEFORE INSERT OR UPDATE OR DELETE ON geography.markets FOR EACH ROW EXECUTE FUNCTION geography.guard_markets();

-- links of an ACTIVE country cannot be REMOVED (deactivate the country first); link rows are never rewritten, only added or removed.
-- The country row is share-locked BEFORE its status is read: a concurrent activation (an UPDATE of the country row, which conflicts with the share lock)
-- therefore serializes with this removal, so a country can never become ACTIVE while the link it relies on is being deleted.
CREATE FUNCTION geography.guard_country_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cur_status text;
BEGIN
  SELECT status INTO cur_status FROM geography.countries WHERE country_id = OLD.country_id FOR SHARE;
  IF cur_status = 'ACTIVE' THEN
    RAISE EXCEPTION 'the % of an ACTIVE country cannot be removed; deactivate the country first', replace(TG_TABLE_NAME, '_', ' ') USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:LINKS_PROTECTED';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER trg_country_locales__immutable BEFORE UPDATE ON geography.country_locales FOR EACH ROW EXECUTE FUNCTION geography.forbid_mutation();
CREATE TRIGGER trg_country_time_zones__immutable BEFORE UPDATE ON geography.country_time_zones FOR EACH ROW EXECUTE FUNCTION geography.forbid_mutation();
CREATE TRIGGER trg_market_locales__immutable BEFORE UPDATE ON geography.market_locales FOR EACH ROW EXECUTE FUNCTION geography.forbid_mutation();
CREATE TRIGGER trg_country_locales__guard BEFORE DELETE ON geography.country_locales FOR EACH ROW EXECUTE FUNCTION geography.guard_country_links();
CREATE TRIGGER trg_country_time_zones__guard BEFORE DELETE ON geography.country_time_zones FOR EACH ROW EXECUTE FUNCTION geography.guard_country_links();

-- content.locales stays owned by content; this guard (owned by geography) stops deactivating a locale an ACTIVE country or market uses as its default
CREATE FUNCTION geography.guard_locale_deactivation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    IF EXISTS (SELECT 1 FROM geography.countries WHERE default_locale = OLD.locale AND status = 'ACTIVE')
       OR EXISTS (SELECT 1 FROM geography.markets WHERE default_locale = OLD.locale AND status = 'ACTIVE') THEN
      RAISE EXCEPTION 'locale % is the default of an ACTIVE country or market and cannot be deactivated', OLD.locale USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'geography_rule:LOCALE_IS_ACTIVE_DEFAULT';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_locales__geography_guard BEFORE UPDATE ON content.locales FOR EACH ROW EXECUTE FUNCTION geography.guard_locale_deactivation();

-- =====================================================================================================================
-- 4. launch reference data (deterministic; no business values, no tax or payment data, no address data)
-- =====================================================================================================================
INSERT INTO geography.currencies (currency_code, numeric_code, minor_unit_digits, display_name, symbol, status) VALUES ('USD', '840', 2, 'US Dollar', '$', 'ACTIVE');

INSERT INTO geography.time_zones (iana_name, status) VALUES
  ('America/New_York', 'ACTIVE'), ('America/Chicago', 'ACTIVE'), ('America/Denver', 'ACTIVE'), ('America/Los_Angeles', 'ACTIVE');

-- The United States display name is managed content: one entry taken through the real lifecycle (no trigger is disabled), exactly like migration 0006.
DO $seed$
DECLARE
  v_from       timestamptz := now();
  v_actor      constant text := 'system:migration';
  v_correlation constant text := 'seed-0007';
  v_reason     constant text := 'Initial geography reference copy (migration 0007)';
  v_entry_id   uuid;
  v_version_id uuid;
BEGIN
  INSERT INTO content.entries (key, content_type, owner_role, description, sensitivity, criticality, approval_policy, fallback_policy, max_scope_type, created_by)
  VALUES ('geography.country.us.name', 'UI_LABEL', 'CONTENT', 'Display name of the United States', 'PUBLIC', 'STANDARD', 'NONE', 'CHAIN', 'PLATFORM', v_actor)
  RETURNING entry_id INTO v_entry_id;
  INSERT INTO content.audit_events (actor, action, entry_id, reason, correlation_id, occurred_at) VALUES (v_actor, 'ENTRY_CREATED', v_entry_id, v_reason, v_correlation, clock_timestamp());
  INSERT INTO content.versions (entry_id, locale, scope_type, scope_ref, version, body, status, approval_policy, effective_from, reason, created_by)
  VALUES (v_entry_id, 'en-US', 'PLATFORM', NULL, 1, 'United States', 'DRAFT', 'NONE', v_from, v_reason, v_actor)
  RETURNING version_id INTO v_version_id;
  INSERT INTO content.audit_events (actor, action, entry_id, version_id, reason, correlation_id, occurred_at) VALUES (v_actor, 'VERSION_DRAFTED', v_entry_id, v_version_id, v_reason, v_correlation, clock_timestamp());
  UPDATE content.versions SET status = 'APPROVED', updated_at = now() WHERE version_id = v_version_id AND status = 'DRAFT';
  INSERT INTO content.audit_events (actor, action, entry_id, version_id, reason, correlation_id, occurred_at) VALUES (v_actor, 'VERSION_APPROVED', v_entry_id, v_version_id, v_reason, v_correlation, clock_timestamp());
  UPDATE content.versions SET status = 'PUBLISHED', updated_at = now() WHERE version_id = v_version_id AND status = 'APPROVED';
  INSERT INTO content.audit_events (actor, action, entry_id, version_id, reason, correlation_id, occurred_at) VALUES (v_actor, 'VERSION_PUBLISHED', v_entry_id, v_version_id, v_reason, v_correlation, clock_timestamp());
  INSERT INTO content.audit_events (actor, action, entry_id, version_id, reason, correlation_id, occurred_at) VALUES (v_actor, 'VERSION_ACTIVATED', v_entry_id, v_version_id, v_reason, v_correlation, clock_timestamp());
END
$seed$;

DO $seed$
DECLARE
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0007';
  v_country_id  uuid;
  v_market_id   uuid;
  v_la_tz       uuid;
BEGIN
  -- the country starts PLANNED; links are added; then it is activated (the guard validates currency, locale and time zones)
  INSERT INTO geography.countries (iso_alpha2, iso_alpha3, iso_numeric, display_name_content_key, status, dialing_code, default_currency_code, default_locale, distance_unit, first_day_of_week, date_format_code, time_format_code)
  VALUES ('US', 'USA', '840', 'geography.country.us.name', 'PLANNED', '+1', 'USD', 'en-US', 'MILES', 'SUNDAY', 'MDY', '12_HOUR')
  RETURNING country_id INTO v_country_id;
  INSERT INTO geography.audit_events (actor, action, country_id, reason, correlation_id) VALUES (v_actor, 'COUNTRY_CREATED', v_country_id, 'Launch reference data (migration 0007)', v_correlation);
  INSERT INTO geography.country_locales (country_id, locale) VALUES (v_country_id, 'en-US');
  INSERT INTO geography.country_time_zones (country_id, time_zone_id) SELECT v_country_id, time_zone_id FROM geography.time_zones;
  UPDATE geography.countries SET status = 'ACTIVE', updated_at = now() WHERE country_id = v_country_id;
  INSERT INTO geography.audit_events (actor, action, country_id, changes, reason, correlation_id)
  VALUES (v_actor, 'COUNTRY_ACTIVATED', v_country_id, '{"status": ["PLANNED", "ACTIVE"]}'::jsonb, 'Launch reference data (migration 0007)', v_correlation);

  -- the launch market is seeded PLANNED only: it is never ACTIVE until the owner activates it through the management API
  SELECT time_zone_id INTO v_la_tz FROM geography.time_zones WHERE iana_name = 'America/Los_Angeles';
  INSERT INTO geography.markets (code, name, country_id, status, default_locale, currency_code, default_time_zone_id, effective_from)
  VALUES ('la-oc', 'LA & OC', v_country_id, 'PLANNED', 'en-US', 'USD', v_la_tz, now())
  RETURNING market_id INTO v_market_id;
  INSERT INTO geography.market_locales (market_id, country_id, locale) VALUES (v_market_id, v_country_id, 'en-US');
  INSERT INTO geography.audit_events (actor, action, market_id, reason, correlation_id) VALUES (v_actor, 'MARKET_CREATED', v_market_id, 'Launch market record, PLANNED until activated (migration 0007)', v_correlation);
END
$seed$;
