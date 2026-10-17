-- checkpoint: CAT-001
-- purpose: create the catalog schema, the PLATFORM-OWNED taxonomy of what can be sold: categories (Auto Services), service types (Car Detailing; each belongs to exactly one category), their availability and display order per market, the platform-level prohibited-service list, and an immutable audit trail; seed a deliberately minimal DRAFT taxonomy (2 categories, 4 service types) with its managed copy. A Gig (Full Detail) belongs to a provider and arrives later: no table here carries a price, duration, radius, capacity or any other provider-specific field.
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. No catalog row is ever deleted or truncated (a category, service type or prohibited service is retired with status RETIRED and keeps its code), market availability rows are switched off with enabled = false, audit rows are immutable; the seeded copy is changed through the content workflow, never by editing this file
-- backfill: none; every table is new and nothing references the catalog yet. The seed is deterministic reference data (DRAFT: nothing is offered until an administrator activates it)
-- risk: low. All objects are new. Seven small tables read through unique keys; the only runtime readers are the catalog reads (one indexed read of a market's rows, cached by a generation counter) and the management operations. No existing table is altered
-- destructive: none
-- events: the seeds emit no outbox events (they run before any consumer exists, like 0006 to 0014); every status or availability change after this migration goes through CatalogService, which writes the event in the same transaction
-- audit: the content seed writes the content audit trail (ENTRY_CREATED ... VERSION_ACTIVATED) exactly as the real workflow does; the taxonomy seed writes one CATEGORY_CREATED / SERVICE_TYPE_CREATED row per row (actor system:migration)
-- DECISIONS: (1) the taxonomy is REFERENCE DATA, not configuration: CFG-001 holds values scoped by platform/country/market/category/..., and a category is the thing a scope names, not a parameter value; (2) one category per service type (a tree, as the PRD reads: collapsible categories each with its service types); the category of a service type is immutable; (3) the code is the identity: immutable lower-case snake_case, never reused; names and descriptions are content keys DERIVED from the code by a generated column that has a foreign key to content.entries, so no display text and no second copy of the key is stored; (4) no version tables: stable ids + immutable codes + a status machine + the audit trail give a future Gig everything it needs to reference and to keep history (renaming is a content change, retiring keeps the row); (5) display order is MARKET data (market_categories, market_service_types), not a global column; (6) availability does not require the item to be ACTIVE (a market can be prepared before launch) but nothing is public unless the market is ACTIVE and in effect, the category ACTIVE and enabled in it and, for a service type, the service type ACTIVE and enabled in it; (7) verification, skill and equipment requirements per category and market are NOT modelled here: SV-09 / TRUST-001 owns their shape and keys them by these stable ids; (8) prohibited services are a flat platform-level list (no moderation workflow, no consumer yet); (9) no effective dates on availability: a market's own window already gates exposure and a date column nothing reads would be speculative

-- =====================================================================================================================
-- 1. schema
-- =====================================================================================================================
CREATE SCHEMA catalog;
COMMENT ON SCHEMA catalog IS 'Application-owned catalogue taxonomy (CAT-001): platform-owned categories and service types, their availability and order per market, the prohibited-service list and the audit trail. Providers later create Gigs (variants, add-ons, prices, radius, capacity) from the service types; none of that is modelled here. Names and descriptions are managed content (CFG-002).';

-- =====================================================================================================================
-- 2. status machine helper and the immutable audit trail
-- =====================================================================================================================
CREATE FUNCTION catalog.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (% is not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:ROW_IMMUTABLE';
END;
$$;
COMMENT ON FUNCTION catalog.forbid_mutation() IS 'Refuses UPDATE, DELETE and TRUNCATE of the audit trail and TRUNCATE of every reference table (ROW_IMMUTABLE).';

-- DRAFT -> ACTIVE | RETIRED; ACTIVE <-> INACTIVE; ACTIVE | INACTIVE -> RETIRED; RETIRED is terminal; DRAFT is the initial status only
CREATE FUNCTION catalog.assert_status_transition(p_old text, p_new text) RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_new = p_old THEN RETURN; END IF;
  IF p_new = 'DRAFT' THEN
    RAISE EXCEPTION 'DRAFT is the initial status and cannot be set again' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:DRAFT_IS_INITIAL';
  END IF;
  IF NOT ((p_old = 'DRAFT' AND p_new IN ('ACTIVE', 'RETIRED'))
       OR (p_old = 'ACTIVE' AND p_new IN ('INACTIVE', 'RETIRED'))
       OR (p_old = 'INACTIVE' AND p_new IN ('ACTIVE', 'RETIRED'))) THEN
    RAISE EXCEPTION 'the status transition is not allowed' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:STATUS_TRANSITION';
  END IF;
END;
$$;
COMMENT ON FUNCTION catalog.assert_status_transition(text, text) IS 'The ONE status machine of the catalogue (categories, service types, prohibited services): DRAFT -> ACTIVE | RETIRED, ACTIVE <-> INACTIVE, ACTIVE | INACTIVE -> RETIRED, RETIRED terminal, DRAFT never written back (DRAFT_IS_INITIAL, STATUS_TRANSITION).';

-- =====================================================================================================================
-- 3. categories
-- =====================================================================================================================
CREATE TABLE catalog.categories (
  category_id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  code                    text        NOT NULL,
  name_content_key        text        GENERATED ALWAYS AS ('catalog.category.' || code || '.name') STORED NOT NULL,
  description_content_key text,
  icon_key                text,
  status                  text        NOT NULL DEFAULT 'DRAFT',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_categories PRIMARY KEY (category_id),
  CONSTRAINT uq_categories__code UNIQUE (code),
  CONSTRAINT fk_categories__name_content_key FOREIGN KEY (name_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT fk_categories__description_content_key FOREIGN KEY (description_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT ck_categories__code CHECK (code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND length(code) BETWEEN 2 AND 48),
  CONSTRAINT ck_categories__description_content_key CHECK (description_content_key IS NULL OR description_content_key = 'catalog.category.' || code || '.description'),
  CONSTRAINT ck_categories__icon_key CHECK (icon_key IS NULL OR (icon_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(icon_key) <= 48)),
  CONSTRAINT ck_categories__status CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'RETIRED'))
);
COMMENT ON TABLE catalog.categories IS 'A category of the platform-owned taxonomy (Auto Services): a group of service types. Reference data: the code is the immutable identity, the name and description are managed content (CFG-002) found through content keys derived from the code, the status is a machine (DRAFT, ACTIVE, INACTIVE, RETIRED) and nothing is public unless an administrator activated it. Rows are never deleted or truncated. No provider-specific field, no display text, no personal data.';
COMMENT ON COLUMN catalog.categories.code IS 'Immutable lower-case snake_case identity (2 to 48 characters), never reused: the API path, the CATEGORY configuration scope reference and the stem of the content keys. A retired category keeps its code.';
COMMENT ON COLUMN catalog.categories.name_content_key IS 'GENERATED from the code (catalog.category.<code>.name) and a foreign key to content.entries: the name must exist as content, and renaming it in the content registry changes no identity. Not writable.';
COMMENT ON COLUMN catalog.categories.description_content_key IS 'NULL = no description. When set it is exactly catalog.category.<code>.description (a foreign key to content.entries); the stem never varies, so the key is a link, not a free choice.';
COMMENT ON COLUMN catalog.categories.icon_key IS 'A design-system icon NAME (lower-case kebab), not a URL and not media: the media pipeline is a later checkpoint.';
COMMENT ON COLUMN catalog.categories.status IS 'DRAFT (initial only, never written back), ACTIVE, INACTIVE (a pause) or RETIRED (terminal: blocks new use, keeps the row, the code and the history). A category cannot leave ACTIVE while one of its service types is ACTIVE, and cannot be retired while one of its service types is not RETIRED.';

-- =====================================================================================================================
-- 4. service types (exactly one category each)
-- =====================================================================================================================
CREATE TABLE catalog.service_types (
  service_type_id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  category_id             uuid        NOT NULL,
  code                    text        NOT NULL,
  name_content_key        text        GENERATED ALWAYS AS ('catalog.service_type.' || code || '.name') STORED NOT NULL,
  description_content_key text,
  status                  text        NOT NULL DEFAULT 'DRAFT',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_service_types PRIMARY KEY (service_type_id),
  CONSTRAINT uq_service_types__code UNIQUE (code),
  CONSTRAINT fk_service_types__category_id FOREIGN KEY (category_id) REFERENCES catalog.categories (category_id) ON DELETE RESTRICT,
  CONSTRAINT fk_service_types__name_content_key FOREIGN KEY (name_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT fk_service_types__description_content_key FOREIGN KEY (description_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT ck_service_types__code CHECK (code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND length(code) BETWEEN 2 AND 48),
  CONSTRAINT ck_service_types__description_content_key CHECK (description_content_key IS NULL OR description_content_key = 'catalog.service_type.' || code || '.description'),
  CONSTRAINT ck_service_types__status CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'RETIRED'))
);
CREATE INDEX idx_service_types__category ON catalog.service_types (category_id);
COMMENT ON TABLE catalog.service_types IS 'A service type of the platform-owned taxonomy (Car Detailing): what a provider can offer, belonging to exactly ONE category. A Gig (Full Detail) is a provider object that arrives later and will reference service_type_id; nothing provider-specific (price, duration, radius, capacity, availability) is stored here. Same identity, content and status rules as categories. Rows are never deleted or truncated.';
COMMENT ON COLUMN catalog.service_types.category_id IS 'The one category of the service type. Immutable: a Gig that references the service type must keep its meaning, so moving to another category is a new service type.';
COMMENT ON COLUMN catalog.service_types.code IS 'Immutable lower-case snake_case identity, unique across ALL service types (not only inside a category), never reused.';
COMMENT ON COLUMN catalog.service_types.status IS 'The same machine as categories. A service type can be ACTIVE only while its category is ACTIVE (guard CATEGORY_NOT_ACTIVE), and none can be created under a RETIRED category.';

-- =====================================================================================================================
-- 5. prohibited services (flat, platform level)
-- =====================================================================================================================
CREATE TABLE catalog.prohibited_services (
  prohibited_service_id   uuid        NOT NULL DEFAULT gen_random_uuid(),
  category_id             uuid,
  code                    text        NOT NULL,
  name_content_key        text        GENERATED ALWAYS AS ('catalog.prohibited_service.' || code || '.name') STORED NOT NULL,
  description_content_key text,
  status                  text        NOT NULL DEFAULT 'DRAFT',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_prohibited_services PRIMARY KEY (prohibited_service_id),
  CONSTRAINT uq_prohibited_services__code UNIQUE (code),
  CONSTRAINT fk_prohibited_services__category_id FOREIGN KEY (category_id) REFERENCES catalog.categories (category_id) ON DELETE RESTRICT,
  CONSTRAINT fk_prohibited_services__name_content_key FOREIGN KEY (name_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT fk_prohibited_services__description_content_key FOREIGN KEY (description_content_key) REFERENCES content.entries (key) ON DELETE RESTRICT,
  CONSTRAINT ck_prohibited_services__code CHECK (code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND length(code) BETWEEN 2 AND 48),
  CONSTRAINT ck_prohibited_services__description_content_key CHECK (description_content_key IS NULL OR description_content_key = 'catalog.prohibited_service.' || code || '.description'),
  CONSTRAINT ck_prohibited_services__status CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'RETIRED'))
);
COMMENT ON TABLE catalog.prohibited_services IS 'A service the platform does not allow (AD-01.03), as flat platform-level reference data: an immutable code, managed name and description, an optional category it belongs to for administration, and the status machine (a rule counts only while ACTIVE). There is no moderation workflow and no consumer yet: the Gig moderation and search checkpoints read it. It is never exposed on the public catalogue API.';
COMMENT ON COLUMN catalog.prohibited_services.category_id IS 'Optional grouping for administration, immutable. NULL = not tied to a category.';

-- =====================================================================================================================
-- 6. market availability and order (data per market)
-- =====================================================================================================================
CREATE TABLE catalog.market_categories (
  market_id     uuid        NOT NULL,
  category_id   uuid        NOT NULL,
  enabled       boolean     NOT NULL DEFAULT false,
  display_order integer     NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_market_categories PRIMARY KEY (market_id, category_id),
  CONSTRAINT uq_market_categories__market_order UNIQUE (market_id, display_order),
  CONSTRAINT fk_market_categories__market_id FOREIGN KEY (market_id) REFERENCES geography.markets (market_id) ON DELETE RESTRICT,
  CONSTRAINT fk_market_categories__category_id FOREIGN KEY (category_id) REFERENCES catalog.categories (category_id) ON DELETE RESTRICT,
  CONSTRAINT ck_market_categories__display_order CHECK (display_order BETWEEN 1 AND 9999)
);
COMMENT ON TABLE catalog.market_categories IS 'Whether a category is offered in a market (GEO-001 markets) and where it sits in that market''s menu. A row can be prepared (enabled = false, or enabled for a category that is not ACTIVE yet), but a category is PUBLIC only while the market is ACTIVE and in effect, the category is ACTIVE and this row is enabled. Rows are never deleted or truncated. No personal data.';
COMMENT ON COLUMN catalog.market_categories.display_order IS 'Position in the menu of the market (ascending), unique per market over ALL rows (so an order is never ambiguous); the seed convention is gaps of 10. The unique key is not deferrable: swapping two orders takes three statements.';
CREATE TABLE catalog.market_service_types (
  market_id       uuid        NOT NULL,
  service_type_id uuid        NOT NULL,
  enabled         boolean     NOT NULL DEFAULT false,
  display_order   integer     NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_market_service_types PRIMARY KEY (market_id, service_type_id),
  CONSTRAINT uq_market_service_types__market_order UNIQUE (market_id, display_order),
  CONSTRAINT fk_market_service_types__market_id FOREIGN KEY (market_id) REFERENCES geography.markets (market_id) ON DELETE RESTRICT,
  CONSTRAINT fk_market_service_types__service_type_id FOREIGN KEY (service_type_id) REFERENCES catalog.service_types (service_type_id) ON DELETE RESTRICT,
  CONSTRAINT ck_market_service_types__display_order CHECK (display_order BETWEEN 1 AND 9999)
);
COMMENT ON TABLE catalog.market_service_types IS 'Whether a service type is offered in a market and its position among the market''s service types (the order is per market over all service types; the menu groups them by category). It can be ENABLED only while its category is enabled in the same market (guard CATEGORY_NOT_ENABLED_IN_MARKET) and while it is not RETIRED. Public only under the same conditions as categories plus an ACTIVE service type.';
COMMENT ON COLUMN catalog.market_service_types.display_order IS 'Position among the service types of the market, unique per market over ALL rows; gaps of 10 by convention.';

-- =====================================================================================================================
-- 7. audit trail
-- =====================================================================================================================
CREATE TABLE catalog.audit_events (
  audit_event_id        uuid        NOT NULL DEFAULT gen_random_uuid(),
  occurred_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor                 text        NOT NULL,
  action                text        NOT NULL,
  category_id           uuid,
  service_type_id       uuid,
  prohibited_service_id uuid,
  market_id             uuid,
  changes               jsonb,
  reason                text        NOT NULL,
  correlation_id        text        NOT NULL,
  CONSTRAINT pk_audit_events PRIMARY KEY (audit_event_id),
  CONSTRAINT fk_audit_events__category_id FOREIGN KEY (category_id) REFERENCES catalog.categories (category_id) ON DELETE RESTRICT,
  CONSTRAINT fk_audit_events__service_type_id FOREIGN KEY (service_type_id) REFERENCES catalog.service_types (service_type_id) ON DELETE RESTRICT,
  CONSTRAINT fk_audit_events__prohibited_service_id FOREIGN KEY (prohibited_service_id) REFERENCES catalog.prohibited_services (prohibited_service_id) ON DELETE RESTRICT,
  CONSTRAINT fk_audit_events__market_id FOREIGN KEY (market_id) REFERENCES geography.markets (market_id) ON DELETE RESTRICT,
  CONSTRAINT ck_audit_events__action CHECK (action IN (
    'CATEGORY_CREATED', 'CATEGORY_UPDATED', 'CATEGORY_STATUS_CHANGED',
    'SERVICE_TYPE_CREATED', 'SERVICE_TYPE_UPDATED', 'SERVICE_TYPE_STATUS_CHANGED',
    'PROHIBITED_SERVICE_CREATED', 'PROHIBITED_SERVICE_STATUS_CHANGED',
    'MARKET_CATALOG_AVAILABILITY_CHANGED')),
  CONSTRAINT ck_audit_events__subject CHECK (
    (action LIKE 'CATEGORY\_%' AND category_id IS NOT NULL AND service_type_id IS NULL AND prohibited_service_id IS NULL AND market_id IS NULL)
    OR (action LIKE 'SERVICE\_TYPE\_%' AND service_type_id IS NOT NULL AND category_id IS NULL AND prohibited_service_id IS NULL AND market_id IS NULL)
    OR (action LIKE 'PROHIBITED\_SERVICE\_%' AND prohibited_service_id IS NOT NULL AND category_id IS NULL AND service_type_id IS NULL AND market_id IS NULL)
    OR (action = 'MARKET_CATALOG_AVAILABILITY_CHANGED' AND market_id IS NOT NULL AND prohibited_service_id IS NULL AND ((category_id IS NULL) <> (service_type_id IS NULL)))
  ),
  CONSTRAINT ck_audit_events__changes_object CHECK (changes IS NULL OR jsonb_typeof(changes) = 'object'),
  CONSTRAINT ck_audit_events__reason CHECK (length(btrim(reason)) > 0 AND length(reason) <= 1000),
  CONSTRAINT ck_audit_events__actor CHECK (length(btrim(actor)) > 0 AND length(actor) <= 200)
);
COMMENT ON TABLE catalog.audit_events IS 'Append-only audit trail of every catalogue management mutation: actor, the ONE subject (a category, a service type, a prohibited service, or a market together with a category or a service type), action, field-level diff (a JSON object {field: [old, new]}), the mandatory reason, time and correlation id. Reads are never audited. Rows are immutable and never truncated. It holds identifiers and codes only.';

-- Index justification (DATA_MODEL_GUARDRAILS rule 11). Besides the primary keys and unique constraints (each a lookup path or a foreign key target):
--   uq_categories__code, uq_service_types__code, uq_prohibited_services__code: the identity lookup of every read and of the API path.
--   idx_service_types__category (category_id): the service types of ONE category (listing by category, the guards that look at a category's children).
--   uq_market_categories__market_order / uq_market_service_types__market_order (market_id, display_order): THE access path of a market's menu in order, and the rule that an order is unique per market (the unique key IS the index, so there is no second one).
--   pk_market_categories / pk_market_service_types (market_id, ...): one row per pair and the foreign key to the market.
-- Foreign keys deliberately WITHOUT a supporting index (never-deleted reference targets, no filtered query on the referencing column, tables of tens of rows):
--   market_categories.category_id, market_service_types.service_type_id, prohibited_services.category_id, the content key columns, and every audit_events subject column
--   (the audit trail is read by the management API only by time, which is not offered yet; add an index through its own review when a query path appears).

-- =====================================================================================================================
-- 8. guards (all failures are SQLSTATE 23000 with DETAIL catalog_rule:<KEY>)
--    Lock order: category row, then service type row, then the market rows (a child takes its parent FOR SHARE; a parent's status change takes its own row lock and reads the children).
-- =====================================================================================================================
CREATE FUNCTION catalog.guard_categories() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a category is never deleted: retire it with status RETIRED' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'a category is created as DRAFT' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:MUST_START_AS_DRAFT';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.category_id, NEW.code) IS DISTINCT FROM (OLD.category_id, OLD.code) THEN
    RAISE EXCEPTION 'the id and the code of a category are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:IMMUTABLE_IDENTITY';
  END IF;
  PERFORM catalog.assert_status_transition(OLD.status, NEW.status);
  IF OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE'
     AND EXISTS (SELECT 1 FROM catalog.service_types WHERE category_id = OLD.category_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'a category with ACTIVE service types cannot leave ACTIVE: deactivate them first' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:CATEGORY_HAS_ACTIVE_SERVICE_TYPES';
  END IF;
  IF NEW.status = 'RETIRED' AND OLD.status <> 'RETIRED'
     AND EXISTS (SELECT 1 FROM catalog.service_types WHERE category_id = OLD.category_id AND status <> 'RETIRED') THEN
    RAISE EXCEPTION 'a category cannot be retired while one of its service types is not RETIRED' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:CATEGORY_HAS_OPEN_SERVICE_TYPES';
  END IF;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_categories__guard BEFORE INSERT OR UPDATE OR DELETE ON catalog.categories FOR EACH ROW EXECUTE FUNCTION catalog.guard_categories();
CREATE TRIGGER trg_categories__no_truncate BEFORE TRUNCATE ON catalog.categories FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation();
COMMENT ON FUNCTION catalog.guard_categories() IS 'Category guard: created as DRAFT, never deleted, id and code immutable, the status machine, no leaving ACTIVE while a service type is ACTIVE, no retirement while a service type is not RETIRED, created_at kept (NOT_DELETABLE, MUST_START_AS_DRAFT, IMMUTABLE_IDENTITY, DRAFT_IS_INITIAL, STATUS_TRANSITION, CATEGORY_HAS_ACTIVE_SERVICE_TYPES, CATEGORY_HAS_OPEN_SERVICE_TYPES).';

CREATE FUNCTION catalog.guard_service_types() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a service type is never deleted: retire it with status RETIRED' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'a service type is created as DRAFT' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:MUST_START_AS_DRAFT';
    END IF;
    SELECT status INTO c_status FROM catalog.categories WHERE category_id = NEW.category_id FOR SHARE;
    IF c_status = 'RETIRED' THEN
      RAISE EXCEPTION 'no service type can be created under a RETIRED category' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:CATEGORY_RETIRED';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.service_type_id, NEW.category_id, NEW.code) IS DISTINCT FROM (OLD.service_type_id, OLD.category_id, OLD.code) THEN
    RAISE EXCEPTION 'the id, the category and the code of a service type are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:IMMUTABLE_IDENTITY';
  END IF;
  PERFORM catalog.assert_status_transition(OLD.status, NEW.status);
  IF NEW.status = 'ACTIVE' AND OLD.status <> 'ACTIVE' THEN
    SELECT status INTO c_status FROM catalog.categories WHERE category_id = NEW.category_id FOR SHARE;
    IF c_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'a service type can be ACTIVE only while its category is ACTIVE' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:CATEGORY_NOT_ACTIVE';
    END IF;
  END IF;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_service_types__guard BEFORE INSERT OR UPDATE OR DELETE ON catalog.service_types FOR EACH ROW EXECUTE FUNCTION catalog.guard_service_types();
CREATE TRIGGER trg_service_types__no_truncate BEFORE TRUNCATE ON catalog.service_types FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation();
COMMENT ON FUNCTION catalog.guard_service_types() IS 'Service type guard: created as DRAFT and not under a RETIRED category, never deleted, id/category/code immutable, the status machine, ACTIVE only while the category is ACTIVE (read FOR SHARE so a concurrent category change serializes), created_at kept (NOT_DELETABLE, MUST_START_AS_DRAFT, CATEGORY_RETIRED, IMMUTABLE_IDENTITY, DRAFT_IS_INITIAL, STATUS_TRANSITION, CATEGORY_NOT_ACTIVE).';

CREATE FUNCTION catalog.guard_prohibited_services() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a prohibited service is never deleted: retire it with status RETIRED' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'a prohibited service is created as DRAFT' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:MUST_START_AS_DRAFT';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.prohibited_service_id, NEW.code) IS DISTINCT FROM (OLD.prohibited_service_id, OLD.code) OR NEW.category_id IS DISTINCT FROM OLD.category_id THEN
    RAISE EXCEPTION 'the id, the code and the category of a prohibited service are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:IMMUTABLE_IDENTITY';
  END IF;
  PERFORM catalog.assert_status_transition(OLD.status, NEW.status);
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_prohibited_services__guard BEFORE INSERT OR UPDATE OR DELETE ON catalog.prohibited_services FOR EACH ROW EXECUTE FUNCTION catalog.guard_prohibited_services();
CREATE TRIGGER trg_prohibited_services__no_truncate BEFORE TRUNCATE ON catalog.prohibited_services FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation();
COMMENT ON FUNCTION catalog.guard_prohibited_services() IS 'Prohibited service guard: created as DRAFT, never deleted, id/code/category immutable, the status machine, created_at kept.';

CREATE FUNCTION catalog.guard_market_categories() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c_status        text;
  becomes_enabled boolean := NEW.enabled;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a market availability row is never deleted: switch it off with enabled = false' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.market_id, NEW.category_id) IS DISTINCT FROM (OLD.market_id, OLD.category_id) THEN
      RAISE EXCEPTION 'the market and the category of an availability row are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:IMMUTABLE_IDENTITY';
    END IF;
    becomes_enabled := NEW.enabled AND NOT OLD.enabled;
  END IF;
  IF becomes_enabled THEN
    SELECT status INTO c_status FROM catalog.categories WHERE category_id = NEW.category_id FOR SHARE;
    IF c_status = 'RETIRED' THEN
      RAISE EXCEPTION 'a RETIRED category cannot be enabled in a market' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:ITEM_RETIRED';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.enabled AND NOT NEW.enabled
     AND EXISTS (SELECT 1 FROM catalog.market_service_types mst JOIN catalog.service_types st ON st.service_type_id = mst.service_type_id
                  WHERE mst.market_id = OLD.market_id AND st.category_id = OLD.category_id AND mst.enabled) THEN
    RAISE EXCEPTION 'a category cannot be switched off in a market while one of its service types is enabled there' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES';
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.created_at := OLD.created_at; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_market_categories__guard BEFORE INSERT OR UPDATE OR DELETE ON catalog.market_categories FOR EACH ROW EXECUTE FUNCTION catalog.guard_market_categories();
CREATE TRIGGER trg_market_categories__no_truncate BEFORE TRUNCATE ON catalog.market_categories FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation();
COMMENT ON FUNCTION catalog.guard_market_categories() IS 'Market category guard: never deleted, key immutable, a RETIRED category is never enabled, a category is not switched off in a market while a service type of it is enabled there, created_at kept (NOT_DELETABLE, IMMUTABLE_IDENTITY, ITEM_RETIRED, CATEGORY_MARKET_HAS_ENABLED_SERVICE_TYPES).';

CREATE FUNCTION catalog.guard_market_service_types() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st_status       text;
  st_category     uuid;
  c_enabled       boolean;
  becomes_enabled boolean := NEW.enabled;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a market availability row is never deleted: switch it off with enabled = false' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:NOT_DELETABLE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.market_id, NEW.service_type_id) IS DISTINCT FROM (OLD.market_id, OLD.service_type_id) THEN
      RAISE EXCEPTION 'the market and the service type of an availability row are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:IMMUTABLE_IDENTITY';
    END IF;
    becomes_enabled := NEW.enabled AND NOT OLD.enabled;
  END IF;
  IF becomes_enabled THEN
    SELECT status, category_id INTO st_status, st_category FROM catalog.service_types WHERE service_type_id = NEW.service_type_id FOR SHARE;
    IF st_status = 'RETIRED' THEN
      RAISE EXCEPTION 'a RETIRED service type cannot be enabled in a market' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:ITEM_RETIRED';
    END IF;
    SELECT enabled INTO c_enabled FROM catalog.market_categories WHERE market_id = NEW.market_id AND category_id = st_category FOR SHARE;
    IF c_enabled IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'a service type can be enabled in a market only while its category is enabled there' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'catalog_rule:CATEGORY_NOT_ENABLED_IN_MARKET';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.created_at := OLD.created_at; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_market_service_types__guard BEFORE INSERT OR UPDATE OR DELETE ON catalog.market_service_types FOR EACH ROW EXECUTE FUNCTION catalog.guard_market_service_types();
CREATE TRIGGER trg_market_service_types__no_truncate BEFORE TRUNCATE ON catalog.market_service_types FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation();
COMMENT ON FUNCTION catalog.guard_market_service_types() IS 'Market service type guard: never deleted, key immutable, a RETIRED service type is never enabled, enabling needs the category enabled in the same market (read FOR SHARE so a concurrent switch-off serializes), created_at kept (NOT_DELETABLE, IMMUTABLE_IDENTITY, ITEM_RETIRED, CATEGORY_NOT_ENABLED_IN_MARKET).';

CREATE TRIGGER trg_audit_events__immutable BEFORE UPDATE OR DELETE ON catalog.audit_events FOR EACH ROW EXECUTE FUNCTION catalog.forbid_mutation();
CREATE TRIGGER trg_audit_events__no_truncate BEFORE TRUNCATE ON catalog.audit_events FOR EACH STATEMENT EXECUTE FUNCTION catalog.forbid_mutation();

-- =====================================================================================================================
-- 9. seed: the managed copy of the launch-candidate taxonomy (CFG-002), through the real content lifecycle (en-US only)
--    A deliberately minimal taxonomy to prove the model (PRD 5.1 example plus the first candidate category); the final launch list depends on PRD question Q5.
--    No variables, no personal data.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0015';
  v_reason      constant text := 'Initial catalogue taxonomy copy (migration 0015)';
  v_seed        record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1,  'UI_LABEL',   'catalog.category.home_cleaning.name', 'Name of the category Home Cleaning', 'Home Cleaning'),
      (2,  'PLAIN_TEXT', 'catalog.category.home_cleaning.description', 'One-line description of the category Home Cleaning', 'Cleaning for homes and apartments.'),
      (3,  'UI_LABEL',   'catalog.category.auto_services.name', 'Name of the category Auto Services', 'Auto Services'),
      (4,  'PLAIN_TEXT', 'catalog.category.auto_services.description', 'One-line description of the category Auto Services', 'Car care, from a wash to a full detail.'),
      (5,  'UI_LABEL',   'catalog.service_type.regular_cleaning.name', 'Name of the service type Regular Cleaning', 'Regular Cleaning'),
      (6,  'PLAIN_TEXT', 'catalog.service_type.regular_cleaning.description', 'One-line description of the service type Regular Cleaning', 'A routine clean to keep a home tidy.'),
      (7,  'UI_LABEL',   'catalog.service_type.deep_cleaning.name', 'Name of the service type Deep Cleaning', 'Deep Cleaning'),
      (8,  'PLAIN_TEXT', 'catalog.service_type.deep_cleaning.description', 'One-line description of the service type Deep Cleaning', 'A thorough top-to-bottom clean, including the places a regular clean skips.'),
      (9,  'UI_LABEL',   'catalog.service_type.car_detailing.name', 'Name of the service type Car Detailing', 'Car Detailing'),
      (10, 'PLAIN_TEXT', 'catalog.service_type.car_detailing.description', 'One-line description of the service type Car Detailing', 'Interior and exterior detailing that restores the finish of a vehicle.'),
      (11, 'UI_LABEL',   'catalog.service_type.mobile_car_wash.name', 'Name of the service type Mobile Car Wash', 'Mobile Car Wash'),
      (12, 'PLAIN_TEXT', 'catalog.service_type.mobile_car_wash.description', 'One-line description of the service type Mobile Car Wash', 'A car wash that comes to your location.')
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
-- 10. seed: the taxonomy rows (DRAFT: nothing is offered until an administrator activates it and enables it in a market)
-- =====================================================================================================================
INSERT INTO catalog.categories (code, description_content_key, status) VALUES
  ('home_cleaning', 'catalog.category.home_cleaning.description', 'DRAFT'),
  ('auto_services', 'catalog.category.auto_services.description', 'DRAFT');

INSERT INTO catalog.service_types (category_id, code, description_content_key, status)
SELECT c.category_id, s.code, 'catalog.service_type.' || s.code || '.description', 'DRAFT'
FROM (VALUES
  ('home_cleaning', 'regular_cleaning'),
  ('home_cleaning', 'deep_cleaning'),
  ('auto_services', 'car_detailing'),
  ('auto_services', 'mobile_car_wash')
) AS s (category_code, code)
JOIN catalog.categories c ON c.code = s.category_code;

INSERT INTO catalog.audit_events (actor, action, category_id, changes, reason, correlation_id)
SELECT 'system:migration', 'CATEGORY_CREATED', category_id, jsonb_build_object('status', jsonb_build_array(NULL, 'DRAFT')), 'Initial catalogue taxonomy (migration 0015)', 'seed-0015'
FROM catalog.categories;
INSERT INTO catalog.audit_events (actor, action, service_type_id, changes, reason, correlation_id)
SELECT 'system:migration', 'SERVICE_TYPE_CREATED', service_type_id, jsonb_build_object('status', jsonb_build_array(NULL, 'DRAFT')), 'Initial catalogue taxonomy (migration 0015)', 'seed-0015'
FROM catalog.service_types;
