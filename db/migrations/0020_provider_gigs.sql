-- checkpoint: CAT-003
-- purpose: add the provider GIG in the existing `provider` schema: a Gig is an IDENTITY (provider.gigs: whose it is, which platform-owned Gig Template it is built from, where it is in its life) plus immutable VERSIONS (provider.gig_versions: provider-written plain-text copy, the base price in minor units with its currency, the Gig-level duration, each version bound to the EXACT catalog.gig_template_versions row it was built from), the normalised typed field values of the template fields (provider.gig_version_field_values: one row per version and field, exactly one typed column populated, no JSON blob) and an immutable audit trail (provider.gig_audit_events). A Gig is NOT live and NOT bookable: variants, add-ons, media, service areas, availability, search, booking, subscriptions, Go-Live (PRO-003) and moderation are later checkpoints and nothing here stores them. The service type is reached through the template and the market through the account's COMPLETED registration; neither is copied onto the Gig. Seeds: the five Gig policy parameters (configuration, CFG-001) and the copy of the minimal flow (content, CFG-002). No Gig is seeded.
-- rollback strategy: forward-fix only; locally `pnpm stack:reset` rebuilds from zero. No Gig, version, field value or audit row is ever deleted or truncated (a Gig is retired and keeps its history; a published version is superseded or retired, never changed; a draft's field values are replaced only while the version is a DRAFT), so there is nothing to restore; the seeded values and copy are changed through the configuration and content workflows, never by editing this file
-- backfill: none; every table is new and nothing references the new objects yet. Existing providers have no Gig until they create one
-- risk: low. All objects are new. The only existing objects touched are READ by the guards (identity.accounts, provider.registrations, provider.registration_service_types, geography.markets, catalog.service_types, catalog.gig_templates, catalog.gig_template_versions, catalog.gig_template_fields) with FOR SHARE locks where a concurrent retirement must serialize. The configuration and content seeds insert rows exactly as their real lifecycles do
-- destructive: none
-- events: the seeds emit no outbox events (they run before any consumer exists); every create, publication and retirement after this migration goes through ProviderGigService, which writes the event in the same transaction
-- audit: the configuration and content seeds write their own audit trails exactly as the real workflows do; the Gig audit trail starts empty
-- DECISIONS: (1) a Gig is identity (provider.gigs) + immutable versions (provider.gig_versions) + typed field values + audit; the current and the editable version are found through two partial unique indexes (at most one PUBLISHED and at most one DRAFT per Gig), not through a pointer column on the Gig that would be a second source of truth; (2) the Gig stores account_id and gig_template_id only: the service type is reached through the template (no copy) and the market is the market of the account's COMPLETED registration (no copy); the price currency is stored WITH the price because money is an amount plus its currency, derived by the server from that market and checked by a guard; (3) each version binds the EXACT template version: version 1 binds the template's ACTIVE version at creation and every later version binds the SAME template version as the one before (OWNER DECISION, ADR-0046: no automatic migration when a template gets a newer version or is retired; adopting a newer template version is a later checkpoint); (4) status: Gig DRAFT -> ACTIVE (first publication) -> RETIRED (terminal, no reactivation); version DRAFT -> PUBLISHED -> SUPERSEDED, DRAFT | PUBLISHED -> RETIRED only when the Gig is retired; nothing is hard-deleted and there is no INACTIVE state; (5) publishing version n+1 supersedes version n in the same transaction (the guard lets a version be superseded only while a newer draft exists, so the service supersedes first and then publishes, which the one-PUBLISHED unique index requires); (6) the service retires the Gig FIRST and its open versions second (a version is retired only with its Gig); the invariants that a RETIRED Gig keeps no DRAFT or PUBLISHED version, an ACTIVE Gig has a PUBLISHED version and a DRAFT Gig has none are a DEFERRED constraint trigger checked at COMMIT because the two directions cannot be checked row by row (the service publishes the version and then activates the Gig in one transaction); (7) provider-written copy is plain text on the version, not content (CFG-002), and never appears in audit, events, logs or error details; (8) per-field bounds (min/max length and number) of the bound template version are validated by the service, not the database; the database checks template membership, behaviour (PLATFORM_FIXED values are never copied), supported type, the matching typed column and the ENUM option (composite foreign key); (9) caps (provider.gig.max_active, provider.gig.max_drafts) and text length limits are configuration read by the service, counted under the account row lock; the database holds only structural ceilings (title 200, short pitch 2000, description 20000 code points); (10) the audit rows repeat account_id (the owner at the time of the event) so a trail can be read per account; a guard checks it agrees with the Gig; (11) the published-version content rule: title, short pitch and description present and a price, when there is one, above zero are CHECK constraints of PUBLISHED and SUPERSEDED rows; whether a price or a duration is REQUIRED at publication depends on the bound template version and is decided by the service; (12) lock order against the catalogue: the version guard locks Gig, template, service type and the template version LAST (FOR SHARE, and only on an insert and a publication) because the catalogue service locks a template FOR UPDATE and then its version FOR UPDATE; (13) a Gig is created together with its first version in one transaction, which a deferred constraint trigger enforces at COMMIT (a Gig row without a version can only come from direct SQL); (14) the price currency is stored with the price but geography.markets.currency_code is mutable, so the service re-derives it on every save and the PRICE_CURRENCY guard is the backstop at every write and at publication; (15) the foreign keys into the catalogue fields and options ARE exercised by deletes (a DRAFT template version rewrites its fields and options), so the values table has idx_gig_version_field_values__field_option; the foreign keys to templates and template versions have no index because those rows are never deleted and nothing queries them yet

-- =====================================================================================================================
-- 1. provider.gigs (the identity of a Gig)
-- =====================================================================================================================
CREATE TABLE provider.gigs (
  gig_id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  account_id        uuid        NOT NULL,
  gig_template_id   uuid        NOT NULL,
  status            text        NOT NULL DEFAULT 'DRAFT',
  client_request_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  retired_at        timestamptz,
  CONSTRAINT pk_gigs PRIMARY KEY (gig_id),
  CONSTRAINT fk_gigs__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_gigs__gig_template_id FOREIGN KEY (gig_template_id) REFERENCES catalog.gig_templates (gig_template_id) ON DELETE RESTRICT,
  CONSTRAINT ck_gigs__status CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  CONSTRAINT ck_gigs__lifecycle CHECK ((retired_at IS NOT NULL) = (status = 'RETIRED'))
);
CREATE UNIQUE INDEX uq_gigs__client_request ON provider.gigs (account_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX idx_gigs__account_status ON provider.gigs (account_id, status);
COMMENT ON TABLE provider.gigs IS 'The IDENTITY of a provider Gig (CAT-003): the offer one account builds from one platform-owned Gig Template (CAT-002). The content of the offer lives in immutable versions (provider.gig_versions); the Gig row only says whose it is, which template it came from and where it is in its life. The service type is reached through the template and is NOT stored here; the market is the market of the account''s COMPLETED registration and is NOT stored here. Status: DRAFT (no version published yet), ACTIVE (a version is published), RETIRED (terminal; no reactivation, a provider who wants the offer again creates a new Gig). A Gig is NOT live and NOT bookable (Go-Live is PRO-003). Never deleted or truncated.';
COMMENT ON COLUMN provider.gigs.account_id IS 'The owner: the identity account (foreign key, restrict), taken from the authenticated request, never from a client. Immutable. Every read and write filters by it.';
COMMENT ON COLUMN provider.gigs.gig_template_id IS 'The Gig Template (catalog.gig_templates, restrict) the Gig is built from. Immutable. The EXACT template version is bound per Gig version (provider.gig_versions.gig_template_version_id), so this column is identity only and the service type is read through it (never copied).';
COMMENT ON COLUMN provider.gigs.status IS 'DRAFT | ACTIVE | RETIRED. DRAFT -> ACTIVE needs a PUBLISHED version; DRAFT | ACTIVE -> RETIRED; RETIRED is terminal and frozen. A retired Gig keeps no DRAFT or PUBLISHED version (checked at commit).';
COMMENT ON COLUMN provider.gigs.client_request_id IS 'Optional idempotency token of the creating request: the same (account, token) returns the Gig it created instead of a second one (partial unique index). Immutable. Not a secret and not provider text.';
COMMENT ON COLUMN provider.gigs.retired_at IS 'Set by the guard when the Gig is retired; NULL otherwise (ck_gigs__lifecycle).';

-- =====================================================================================================================
-- 2. provider.gig_versions (the immutable versions)
-- =====================================================================================================================
CREATE TABLE provider.gig_versions (
  gig_version_id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  gig_id                  uuid        NOT NULL,
  version_number          integer     NOT NULL,
  gig_template_version_id uuid        NOT NULL,
  status                  text        NOT NULL DEFAULT 'DRAFT',
  revision                integer     NOT NULL DEFAULT 1,
  title                   text,
  short_pitch             text,
  description             text,
  price_amount_minor      bigint,
  price_currency          char(3),
  duration_minutes        integer,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  published_at            timestamptz,
  superseded_at           timestamptz,
  retired_at              timestamptz,
  CONSTRAINT pk_gig_versions PRIMARY KEY (gig_version_id),
  CONSTRAINT uq_gig_versions__number UNIQUE (gig_id, version_number),
  CONSTRAINT fk_gig_versions__gig_id FOREIGN KEY (gig_id) REFERENCES provider.gigs (gig_id) ON DELETE RESTRICT,
  CONSTRAINT fk_gig_versions__gig_template_version_id FOREIGN KEY (gig_template_version_id) REFERENCES catalog.gig_template_versions (gig_template_version_id) ON DELETE RESTRICT,
  CONSTRAINT fk_gig_versions__price_currency FOREIGN KEY (price_currency) REFERENCES geography.currencies (currency_code) ON DELETE RESTRICT,
  CONSTRAINT ck_gig_versions__number CHECK (version_number >= 1),
  CONSTRAINT ck_gig_versions__revision CHECK (revision >= 1),
  CONSTRAINT ck_gig_versions__status CHECK (status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'RETIRED')),
  CONSTRAINT ck_gig_versions__title CHECK (title IS NULL OR (length(btrim(title)) > 0 AND char_length(title) <= 200)),
  CONSTRAINT ck_gig_versions__short_pitch CHECK (short_pitch IS NULL OR (length(btrim(short_pitch)) > 0 AND char_length(short_pitch) <= 2000)),
  CONSTRAINT ck_gig_versions__description CHECK (description IS NULL OR (length(btrim(description)) > 0 AND char_length(description) <= 20000)),
  CONSTRAINT ck_gig_versions__price CHECK ((price_amount_minor IS NULL) = (price_currency IS NULL) AND (price_amount_minor IS NULL OR price_amount_minor >= 0)),
  CONSTRAINT ck_gig_versions__duration CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 100000),
  CONSTRAINT ck_gig_versions__lifecycle CHECK (
    (status = 'DRAFT' AND published_at IS NULL AND superseded_at IS NULL AND retired_at IS NULL)
    OR (status = 'PUBLISHED' AND published_at IS NOT NULL AND superseded_at IS NULL AND retired_at IS NULL)
    OR (status = 'SUPERSEDED' AND published_at IS NOT NULL AND superseded_at IS NOT NULL AND retired_at IS NULL)
    OR (status = 'RETIRED' AND retired_at IS NOT NULL AND superseded_at IS NULL)),
  CONSTRAINT ck_gig_versions__published_content CHECK (
    status NOT IN ('PUBLISHED', 'SUPERSEDED')
    OR (title IS NOT NULL AND short_pitch IS NOT NULL AND description IS NOT NULL AND (price_amount_minor IS NULL OR price_amount_minor > 0)))
);
CREATE UNIQUE INDEX uq_gig_versions__draft ON provider.gig_versions (gig_id) WHERE status = 'DRAFT';
CREATE UNIQUE INDEX uq_gig_versions__published ON provider.gig_versions (gig_id) WHERE status = 'PUBLISHED';
COMMENT ON TABLE provider.gig_versions IS 'One immutable VERSION of a Gig (CAT-003). A version binds the EXACT catalog.gig_template_versions row it was built from: version 1 binds the template''s ACTIVE version at creation, version n+1 binds the SAME template version as version n (no automatic migration when the template gets a newer version or is retired: owner decision, ADR-0046). A version is a DRAFT (editable, at most one per Gig), then PUBLISHED (frozen, at most one per Gig), then SUPERSEDED when the next version is published; DRAFT or PUBLISHED become RETIRED only when the Gig is retired. Provider-written copy (title, short pitch, description) is PLAIN TEXT and lives here, not in content (CFG-002); it never appears in audit, events, logs or error details. The price is a minor-unit amount plus its currency; the typed template field values are rows of provider.gig_version_field_values. Never deleted or truncated.';
COMMENT ON COLUMN provider.gig_versions.version_number IS '1, 2, 3 per Gig: contiguous (the guard accepts only the highest plus one), so the history reads without gaps.';
COMMENT ON COLUMN provider.gig_versions.gig_template_version_id IS 'The exact frozen template version (catalog, restrict) the content was built against: fields, options, bounds, duration guidance and pricing models are read from it, never copied. Immutable. A newer or retired template version does not move existing versions.';
COMMENT ON COLUMN provider.gig_versions.status IS 'DRAFT (editable, initial only), PUBLISHED (frozen), SUPERSEDED (replaced by a later publication, terminal), RETIRED (the Gig was retired, terminal).';
COMMENT ON COLUMN provider.gig_versions.revision IS 'Concurrency token of a DRAFT: every save raises it by exactly one (REVISION guard) and a publish names the revision the provider reviewed (a stale one is refused by the service). Frozen once the version leaves DRAFT.';
COMMENT ON COLUMN provider.gig_versions.title IS 'Provider-written plain text, at most 200 code points (the configured limit provider.gig.title.max_length is lower and is enforced by the service). NULL while a draft is incomplete; required once published.';
COMMENT ON COLUMN provider.gig_versions.short_pitch IS 'Provider-written plain text, at most 2000 code points (configured limit provider.gig.short_pitch.max_length is enforced by the service). NULL while a draft is incomplete; required once published.';
COMMENT ON COLUMN provider.gig_versions.description IS 'Provider-written plain text, at most 20000 code points (configured limit provider.gig.description.max_length is enforced by the service). NULL while a draft is incomplete; required once published.';
COMMENT ON COLUMN provider.gig_versions.price_amount_minor IS 'The base price in MINOR units of price_currency (never a float): 0 or more in a draft, more than 0 once published. Permitted only when the bound template version allows FIXED or FIXED_WITH_VARIANTS (PRICE_NOT_PERMITTED guard). No variants, add-ons, discounts or credits exist yet (CAT-004 and later).';
COMMENT ON COLUMN provider.gig_versions.price_currency IS 'The currency of the price, ALWAYS derived by the server from geography.markets.currency_code of the market of the account''s COMPLETED registration and checked by the PRICE_CURRENCY guard; never accepted from a client. NULL exactly when there is no price.';
COMMENT ON COLUMN provider.gig_versions.duration_minutes IS 'The Gig-level duration in minutes, 1 to 100000 (an integrity bound, not policy). Permitted only when the bound template version has duration guidance (min, max or suggested), and within min and max when those exist (DURATION_NOT_PERMITTED, DURATION_RANGE guards).';
COMMENT ON COLUMN provider.gig_versions.published_at IS 'Set by the guard at DRAFT -> PUBLISHED; kept afterwards. NULL for a draft and for a draft retired with its Gig.';
COMMENT ON COLUMN provider.gig_versions.superseded_at IS 'Set by the guard at PUBLISHED -> SUPERSEDED (the same transaction time as the published_at of the version that replaced it).';
COMMENT ON COLUMN provider.gig_versions.retired_at IS 'Set by the guard at DRAFT | PUBLISHED -> RETIRED (only when the Gig is retired).';

-- =====================================================================================================================
-- 3. provider.gig_version_field_values (the normalised typed values of the template fields)
-- =====================================================================================================================
CREATE TABLE provider.gig_version_field_values (
  gig_version_id        uuid        NOT NULL,
  gig_template_field_id uuid        NOT NULL,
  text_value            text,
  integer_value         bigint,
  decimal_value         numeric,
  boolean_value         boolean,
  option_code           text,
  duration_minutes      integer,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_gig_version_field_values PRIMARY KEY (gig_version_id, gig_template_field_id),
  CONSTRAINT fk_gig_version_field_values__version_id FOREIGN KEY (gig_version_id) REFERENCES provider.gig_versions (gig_version_id) ON DELETE RESTRICT,
  CONSTRAINT fk_gig_version_field_values__field_id FOREIGN KEY (gig_template_field_id) REFERENCES catalog.gig_template_fields (gig_template_field_id) ON DELETE RESTRICT,
  CONSTRAINT fk_gig_version_field_values__option FOREIGN KEY (gig_template_field_id, option_code) REFERENCES catalog.gig_template_field_options (gig_template_field_id, option_code) ON DELETE RESTRICT,
  CONSTRAINT ck_gig_version_field_values__one_value CHECK (num_nonnulls(text_value, integer_value, decimal_value, boolean_value, option_code, duration_minutes) = 1),
  CONSTRAINT ck_gig_version_field_values__text CHECK (text_value IS NULL OR (length(btrim(text_value)) > 0 AND char_length(text_value) <= 20000)),
  CONSTRAINT ck_gig_version_field_values__decimal CHECK (decimal_value IS NULL OR (decimal_value <> 'NaN' AND decimal_value <> 'Infinity' AND decimal_value <> '-Infinity')),
  CONSTRAINT ck_gig_version_field_values__duration CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 100000)
);
COMMENT ON TABLE provider.gig_version_field_values IS 'The provider''s value of ONE template field in ONE Gig version (CAT-003): one row per (version, field) with exactly one typed column populated (text, integer, decimal, boolean, option code or duration), so no JSON blob and no type guessing. The field must belong to the version''s bound template version and be provider-editable (PLATFORM_FIXED values are never copied: they are resolved from the template version) and of a supported type; an ENUM value is an option code of that exact field (composite foreign key). Numeric and length BOUNDS of the field are validated by the service against the exact template version and are not re-checked here. An absent row means unset. Rows change only while the version is a DRAFT (a save replaces them); afterwards they are frozen history. Never truncated.';
CREATE INDEX idx_gig_version_field_values__field_option ON provider.gig_version_field_values (gig_template_field_id, option_code);
COMMENT ON COLUMN provider.gig_version_field_values.gig_template_field_id IS 'The template field (catalog, restrict) the value answers. The field''s version must equal the Gig version''s bound template version (FIELD_NOT_IN_TEMPLATE_VERSION guard). Identity of the row, immutable.';
COMMENT ON COLUMN provider.gig_version_field_values.text_value IS 'TEXT and LONG_TEXT fields: provider plain text, non-blank, at most 20000 code points. Never audited or logged.';
COMMENT ON COLUMN provider.gig_version_field_values.integer_value IS 'INTEGER fields.';
COMMENT ON COLUMN provider.gig_version_field_values.decimal_value IS 'DECIMAL fields: an exact numeric (never a float), finite.';
COMMENT ON COLUMN provider.gig_version_field_values.boolean_value IS 'BOOLEAN fields.';
COMMENT ON COLUMN provider.gig_version_field_values.option_code IS 'ENUM fields: the option code, valid for this exact field through the composite foreign key to catalog.gig_template_field_options (MATCH SIMPLE: NULL for every other type).';
COMMENT ON COLUMN provider.gig_version_field_values.duration_minutes IS 'DURATION fields: whole minutes, 1 to 100000.';

-- =====================================================================================================================
-- 4. provider.gig_audit_events (immutable audit)
-- =====================================================================================================================
CREATE TABLE provider.gig_audit_events (
  audit_event_id  uuid        NOT NULL DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor           text        NOT NULL,
  account_id      uuid        NOT NULL,
  gig_id          uuid        NOT NULL,
  gig_version_id  uuid,
  action          text        NOT NULL,
  changes         jsonb,
  correlation_id  text        NOT NULL,
  CONSTRAINT pk_gig_audit_events PRIMARY KEY (audit_event_id),
  CONSTRAINT fk_gig_audit_events__account_id FOREIGN KEY (account_id) REFERENCES identity.accounts (account_id) ON DELETE RESTRICT,
  CONSTRAINT fk_gig_audit_events__gig_id FOREIGN KEY (gig_id) REFERENCES provider.gigs (gig_id) ON DELETE RESTRICT,
  CONSTRAINT fk_gig_audit_events__gig_version_id FOREIGN KEY (gig_version_id) REFERENCES provider.gig_versions (gig_version_id) ON DELETE RESTRICT,
  CONSTRAINT ck_gig_audit_events__action CHECK (action IN ('GIG_CREATED', 'GIG_DRAFT_CREATED', 'GIG_DRAFT_UPDATED', 'GIG_VERSION_PUBLISHED', 'GIG_VERSION_SUPERSEDED', 'GIG_RETIRED')),
  CONSTRAINT ck_gig_audit_events__changes_object CHECK (changes IS NULL OR jsonb_typeof(changes) = 'object'),
  CONSTRAINT ck_gig_audit_events__actor CHECK (length(btrim(actor)) > 0 AND length(actor) <= 200)
);
CREATE INDEX idx_gig_audit_events__gig ON provider.gig_audit_events (gig_id, occurred_at);
COMMENT ON TABLE provider.gig_audit_events IS 'Append-only audit trail of the Gigs (CAT-003): who (account:<id> or system:<name>, never a token), what, when, the owning account and Gig (and the version when one is concerned), the field-level diff (a JSON object of identifiers, changed field NAMES and counts, never provider text and never an amount) and the correlation id. Reads are never audited. Rows are immutable and never truncated. The account and Gig of a row must agree with each other (guard). The account column is the owner at the time of the event, kept so the trail can be read per account without a join through a Gig.';

-- Index justification (DATA_MODEL_GUARDRAILS rule 11). Besides the primary keys and unique constraints:
--   uq_gigs__client_request (account_id, client_request_id) WHERE client_request_id IS NOT NULL: the idempotent replay of a create and the rule that one token names one Gig. It is partial, so it does NOT serve the foreign key to the account.
--   idx_gigs__account_status (account_id, status): THE GigMenu read (the Gigs of ONE account, ordered/filtered by status), the cap counts (ACTIVE Gigs per account) and the support of the foreign key to the account (its leading column).
--   uq_gig_versions__number (gig_id, version_number): the versions of ONE Gig in order, the contiguity rule and the support of the foreign key to the Gig.
--   uq_gig_versions__draft (gig_id) WHERE status = 'DRAFT' and uq_gig_versions__published (gig_id) WHERE status = 'PUBLISHED': at most one of each per Gig AND the lookup of the editable draft and of the current version. They replace a "current version" pointer on the Gig (no second source of truth).
--   pk_gig_version_field_values (gig_version_id, gig_template_field_id): the values of ONE version, the uniqueness of a value per field and the support of the foreign key to the version.
--   idx_gig_version_field_values__field_option (gig_template_field_id, option_code): the support of BOTH foreign keys into the catalogue (the field by its leading column, the composite option key as a whole). These targets ARE deleted: replacing a DRAFT template version rewrites its fields and options (catalog writeCanon), and every such DELETE runs a referential check on the referencing table; without this index that check scans the whole values table (measured 38 ms per two fields at 400k rows, growing linearly).
--   idx_gig_audit_events__gig (gig_id, occurred_at): the history of ONE Gig in time order and the support of the foreign key to the Gig.
-- Foreign keys deliberately WITHOUT a supporting index: gigs.gig_template_id and gig_versions.gig_template_version_id (templates and template versions are never deleted, so the referential check never runs, and no query filters on them yet; a template-impact query ("which Gigs stand on this template or version", for a retirement review or the later adoption of a newer template version) gets its index through its own review when it exists),
--   gig_versions.price_currency (a tiny never-deleted reference table), gig_audit_events.account_id and gig_audit_events.gig_version_id (never-deleted targets; the trail is read per Gig).

-- =====================================================================================================================
-- 5. guards (all failures are SQLSTATE 23000 with DETAIL provider_rule:<KEY>)
--    Lock order: the ACCOUNT row (the service locks it FOR UPDATE first), then the Gig row, then the version row; catalog rows are read FOR SHARE so a concurrent retirement serializes, in the catalogue's own order: template, service type, template version LAST (the catalogue service locks a template FOR UPDATE and then its version FOR UPDATE), and only where the answer depends on them (a Gig or version insert, a publication); a field is read FOR SHARE after the provider version.
-- =====================================================================================================================

-- content rules of a version that depend on other tables (price currency and permission, duration permission and range), called by the version guard
CREATE FUNCTION provider.check_gig_version_content(p_gig_id uuid, p_template_version_id uuid, p_price bigint, p_currency char(3), p_duration integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_market_currency char(3);
  v_has_registration boolean;
  v_fixed boolean;
  v_variants boolean;
  v_min integer;
  v_max integer;
  v_suggested integer;
BEGIN
  IF p_price IS NULL AND p_duration IS NULL THEN
    RETURN;
  END IF;
  SELECT pricing_fixed, pricing_fixed_with_variants, min_duration_minutes, max_duration_minutes, suggested_duration_minutes
  INTO v_fixed, v_variants, v_min, v_max, v_suggested
  FROM catalog.gig_template_versions WHERE gig_template_version_id = p_template_version_id;
  IF p_price IS NOT NULL THEN
    IF NOT (COALESCE(v_fixed, false) OR COALESCE(v_variants, false)) THEN
      RAISE EXCEPTION 'the bound template version does not allow a price' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:PRICE_NOT_PERMITTED';
    END IF;
    SELECT true, m.currency_code INTO v_has_registration, v_market_currency
    FROM provider.gigs g
    JOIN provider.registrations r ON r.account_id = g.account_id AND r.status = 'COMPLETED'
    JOIN geography.markets m ON m.market_id = r.market_id
    WHERE g.gig_id = p_gig_id;
    IF v_has_registration IS NOT TRUE THEN
      RAISE EXCEPTION 'a price needs a COMPLETED provider registration with a market' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:REGISTRATION_NOT_COMPLETED';
    END IF;
    IF p_currency IS DISTINCT FROM v_market_currency THEN
      RAISE EXCEPTION 'the price currency must be the currency of the provider''s market' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:PRICE_CURRENCY';
    END IF;
  END IF;
  IF p_duration IS NOT NULL THEN
    IF v_min IS NULL AND v_max IS NULL AND v_suggested IS NULL THEN
      RAISE EXCEPTION 'the bound template version has no duration guidance, so a duration is not permitted' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:DURATION_NOT_PERMITTED';
    END IF;
    IF (v_min IS NOT NULL AND p_duration < v_min) OR (v_max IS NOT NULL AND p_duration > v_max) THEN
      RAISE EXCEPTION 'the duration is outside the range of the bound template version' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:DURATION_RANGE';
    END IF;
  END IF;
END;
$$;
COMMENT ON FUNCTION provider.check_gig_version_content(uuid, uuid, bigint, char, integer) IS 'Cross-table content rules of a Gig version: a price needs a template version that allows FIXED or FIXED_WITH_VARIANTS (PRICE_NOT_PERMITTED), a COMPLETED registration (REGISTRATION_NOT_COMPLETED) and the currency of that registration''s market (PRICE_CURRENCY); a duration needs duration guidance on the template version (DURATION_NOT_PERMITTED) and lies within its min and max when present (DURATION_RANGE). Called by the version guard on insert, on a content change and at publication.';

-- ----------------------------------------------------------------------------------------------------- gigs
CREATE FUNCTION provider.guard_gigs() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a_status   text;
  t_status   text;
  t_service  uuid;
  st_status  text;
  v_registration uuid;
  v_selected boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a Gig is never deleted: retire it' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:NO_DELETE';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'a Gig starts as DRAFT' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:MUST_START_DRAFT';
    END IF;
    SELECT status INTO a_status FROM identity.accounts WHERE account_id = NEW.account_id FOR SHARE;
    IF a_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'only an ACTIVE account can create a Gig' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ACCOUNT_NOT_ACTIVE';
    END IF;
    SELECT status, service_type_id INTO t_status, t_service FROM catalog.gig_templates WHERE gig_template_id = NEW.gig_template_id FOR SHARE;
    IF t_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'a Gig can be created only from an ACTIVE Gig Template' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:TEMPLATE_NOT_ACTIVE';
    END IF;
    SELECT status INTO st_status FROM catalog.service_types WHERE service_type_id = t_service FOR SHARE;
    IF st_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'a Gig can be created only under an ACTIVE service type' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:SERVICE_TYPE_NOT_ACTIVE';
    END IF;
    SELECT provider_registration_id INTO v_registration FROM provider.registrations WHERE account_id = NEW.account_id AND status = 'COMPLETED';
    IF v_registration IS NULL THEN
      RAISE EXCEPTION 'a Gig needs a COMPLETED provider registration' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:REGISTRATION_NOT_COMPLETED';
    END IF;
    SELECT EXISTS (SELECT 1 FROM provider.registration_service_types WHERE provider_registration_id = v_registration AND service_type_id = t_service) INTO v_selected;
    IF NOT v_selected THEN
      RAISE EXCEPTION 'the template''s service type is not among the service types of the registration' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:SERVICE_NOT_SELECTED';
    END IF;
    NEW.retired_at := NULL;
    RETURN NEW;
  END IF;
  IF (NEW.gig_id, NEW.account_id, NEW.gig_template_id, NEW.client_request_id, NEW.created_at) IS DISTINCT FROM (OLD.gig_id, OLD.account_id, OLD.gig_template_id, OLD.client_request_id, OLD.created_at) THEN
    RAISE EXCEPTION 'the id, the owner, the template and the request token of a Gig are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:IMMUTABLE_IDENTITY';
  END IF;
  IF OLD.status = 'RETIRED' THEN
    RAISE EXCEPTION 'a retired Gig is frozen' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:GIG_RETIRED';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('ACTIVE', 'RETIRED')) OR (OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED')) THEN
      RAISE EXCEPTION 'the Gig status transition is not allowed' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:STATUS_TRANSITION';
    END IF;
    IF NEW.status = 'ACTIVE' THEN
      IF NOT EXISTS (SELECT 1 FROM provider.gig_versions WHERE gig_id = NEW.gig_id AND status = 'PUBLISHED') THEN
        RAISE EXCEPTION 'a Gig becomes ACTIVE only with a PUBLISHED version' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:NO_PUBLISHED_VERSION';
      END IF;
      NEW.retired_at := NULL;
    ELSE
      NEW.retired_at := now();
    END IF;
  ELSE
    NEW.retired_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_gigs__guard BEFORE INSERT OR UPDATE OR DELETE ON provider.gigs FOR EACH ROW EXECUTE FUNCTION provider.guard_gigs();
CREATE TRIGGER trg_gigs__no_truncate BEFORE TRUNCATE ON provider.gigs FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation();
COMMENT ON FUNCTION provider.guard_gigs() IS 'Gig guard: created DRAFT for an ACTIVE account (read FOR SHARE) from an ACTIVE template under an ACTIVE service type (both FOR SHARE, so a concurrent retirement serializes) whose service type is among the service types of the account''s COMPLETED registration; never deleted; id, owner, template, request token and creation time immutable; DRAFT -> ACTIVE | RETIRED and ACTIVE -> RETIRED only (ACTIVE needs a PUBLISHED version); a retired Gig is frozen; retired_at and updated_at maintained (NO_DELETE, MUST_START_DRAFT, ACCOUNT_NOT_ACTIVE, TEMPLATE_NOT_ACTIVE, SERVICE_TYPE_NOT_ACTIVE, REGISTRATION_NOT_COMPLETED, SERVICE_NOT_SELECTED, IMMUTABLE_IDENTITY, GIG_RETIRED, STATUS_TRANSITION, NO_PUBLISHED_VERSION).';

-- ------------------------------------------------------------------------------------------------- gig versions
CREATE FUNCTION provider.guard_gig_versions() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER trg_gig_versions__guard BEFORE INSERT OR UPDATE OR DELETE ON provider.gig_versions FOR EACH ROW EXECUTE FUNCTION provider.guard_gig_versions();
CREATE TRIGGER trg_gig_versions__no_truncate BEFORE TRUNCATE ON provider.gig_versions FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation();
COMMENT ON FUNCTION provider.guard_gig_versions() IS 'Version guard. INSERT: a DRAFT at revision 1 with the next contiguous number on a Gig that is not RETIRED; the template version belongs to the Gig''s template; version 1 binds the ACTIVE template version of an ACTIVE template under an ACTIVE service type, a later version binds the SAME template version as the previous one and that version is not RETIRED. UPDATE: identity immutable; a DRAFT changes content with revision +1 (price/duration re-checked); DRAFT -> PUBLISHED needs a Gig that is not retired and a template version, template and service type that are not RETIRED (all FOR SHARE) and the content rules, and freezes the content; PUBLISHED -> SUPERSEDED only while a newer draft exists; DRAFT | PUBLISHED -> RETIRED only after the Gig is RETIRED; every other change is refused; timestamps maintained; never deleted (NO_DELETE, TEMPLATE_VERSION_MISMATCH, NEW_NOT_DRAFT, GIG_RETIRED, VERSION_NUMBER, TEMPLATE_VERSION_NOT_ACTIVE, TEMPLATE_NOT_ACTIVE, SERVICE_TYPE_NOT_ACTIVE, TEMPLATE_VERSION_RETIRED, IMMUTABLE_IDENTITY, VERSION_FROZEN, STATUS_TRANSITION, REVISION, TEMPLATE_RETIRED, SERVICE_TYPE_RETIRED, NO_NEWER_VERSION, GIG_NOT_RETIRED, plus the content rules of provider.check_gig_version_content). Catalogue rows are locked FOR SHARE only on an insert and a publication, in the order template, service type, template version (the catalogue service''s own order, which avoids a deadlock with it).';

-- The state of a Gig and of its versions agree, checked at COMMIT: a RETIRED Gig keeps no DRAFT or PUBLISHED version, an ACTIVE Gig has a PUBLISHED version, a DRAFT Gig has none. The service changes a version and its Gig in
-- one transaction (publish the version, then the Gig becomes ACTIVE; supersede, then publish; retire the Gig, then its versions), so the two directions cannot be checked row by row.
CREATE FUNCTION provider.assert_gig_state_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g_status text;
BEGIN
  SELECT status INTO g_status FROM provider.gigs WHERE gig_id = NEW.gig_id;
  IF g_status = 'RETIRED' AND EXISTS (SELECT 1 FROM provider.gig_versions WHERE gig_id = NEW.gig_id AND status IN ('DRAFT', 'PUBLISHED')) THEN
    RAISE EXCEPTION 'a retired Gig keeps no DRAFT or PUBLISHED version' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:RETIRED_GIG_OPEN_VERSION';
  END IF;
  IF g_status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM provider.gig_versions WHERE gig_id = NEW.gig_id AND status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'an ACTIVE Gig has a PUBLISHED version' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:ACTIVE_GIG_NO_PUBLISHED_VERSION';
  END IF;
  IF g_status = 'DRAFT' AND EXISTS (SELECT 1 FROM provider.gig_versions WHERE gig_id = NEW.gig_id AND status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'a Gig with a PUBLISHED version is ACTIVE' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:DRAFT_GIG_PUBLISHED_VERSION';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_gigs__state_consistent AFTER UPDATE OF status ON provider.gigs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION provider.assert_gig_state_consistent();
CREATE CONSTRAINT TRIGGER trg_gig_versions__state_consistent AFTER INSERT OR UPDATE OF status ON provider.gig_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION provider.assert_gig_state_consistent();
COMMENT ON FUNCTION provider.assert_gig_state_consistent() IS 'Deferred (commit-time) check that a Gig and its versions agree: a RETIRED Gig has no DRAFT or PUBLISHED version (RETIRED_GIG_OPEN_VERSION), an ACTIVE Gig has a PUBLISHED version (ACTIVE_GIG_NO_PUBLISHED_VERSION), a DRAFT Gig has none (DRAFT_GIG_PUBLISHED_VERSION). Fires for a Gig whose status changed and for every version inserted or whose status changed.';

-- A Gig is created together with its first version (the service inserts both in one transaction). A Gig row without any version can only come from direct SQL; it is refused at COMMIT.
CREATE FUNCTION provider.assert_gig_has_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM provider.gig_versions WHERE gig_id = NEW.gig_id) THEN
    RAISE EXCEPTION 'a Gig is created together with its first version' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:GIG_WITHOUT_VERSION';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_gigs__has_version AFTER INSERT ON provider.gigs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION provider.assert_gig_has_version();
COMMENT ON FUNCTION provider.assert_gig_has_version() IS 'Deferred (commit-time) check that a Gig has at least one version: the service creates the Gig and its first version in one transaction, so a Gig row without a version can only be created by direct SQL (GIG_WITHOUT_VERSION). Versions are never deleted, so the check needs to run on insert only.';

-- ----------------------------------------------------------------------------------------------- field values
CREATE FUNCTION provider.guard_gig_version_field_values() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_version  uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.gig_version_id ELSE NEW.gig_version_id END;
  v_status   text;
  v_tv       uuid;
  f_tv       uuid;
  f_type     text;
  f_behavior text;
  v_ok       boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.gig_version_id, NEW.gig_template_field_id, NEW.created_at) IS DISTINCT FROM (OLD.gig_version_id, OLD.gig_template_field_id, OLD.created_at) THEN
      RAISE EXCEPTION 'the version, the field and the creation time of a value are immutable' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:IMMUTABLE_IDENTITY';
    END IF;
  END IF;
  SELECT status, gig_template_version_id INTO v_status, v_tv FROM provider.gig_versions WHERE gig_version_id = v_version FOR SHARE;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    IF v_status IS NULL AND TG_OP = 'INSERT' THEN
      RETURN NEW; -- the foreign key reports the missing version
    END IF;
    RAISE EXCEPTION 'the values of a Gig version change only while it is a DRAFT' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:VERSION_FROZEN';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  SELECT gig_template_version_id, field_type, behavior INTO f_tv, f_type, f_behavior FROM catalog.gig_template_fields WHERE gig_template_field_id = NEW.gig_template_field_id FOR SHARE;
  IF f_tv IS NULL THEN
    RETURN NEW; -- the foreign key reports the missing field
  END IF;
  IF f_tv <> v_tv THEN
    RAISE EXCEPTION 'the field does not belong to the template version of the Gig version' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:FIELD_NOT_IN_TEMPLATE_VERSION';
  END IF;
  IF f_behavior = 'PLATFORM_FIXED' THEN
    RAISE EXCEPTION 'a PLATFORM_FIXED field takes no provider value' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:FIELD_FIXED';
  END IF;
  IF f_type NOT IN ('TEXT', 'LONG_TEXT', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'ENUM', 'DURATION') THEN
    RAISE EXCEPTION 'this field type cannot hold a value yet' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:FIELD_TYPE_UNSUPPORTED';
  END IF;
  v_ok := false;
  IF f_type IN ('TEXT', 'LONG_TEXT') THEN
    v_ok := NEW.text_value IS NOT NULL;
  ELSIF f_type = 'INTEGER' THEN
    v_ok := NEW.integer_value IS NOT NULL;
  ELSIF f_type = 'DECIMAL' THEN
    v_ok := NEW.decimal_value IS NOT NULL;
  ELSIF f_type = 'BOOLEAN' THEN
    v_ok := NEW.boolean_value IS NOT NULL;
  ELSIF f_type = 'ENUM' THEN
    v_ok := NEW.option_code IS NOT NULL;
  ELSIF f_type = 'DURATION' THEN
    v_ok := NEW.duration_minutes IS NOT NULL;
  END IF;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'the populated column does not match the type of the field' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:FIELD_TYPE_MISMATCH';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_gig_version_field_values__guard BEFORE INSERT OR UPDATE OR DELETE ON provider.gig_version_field_values FOR EACH ROW EXECUTE FUNCTION provider.guard_gig_version_field_values();
CREATE TRIGGER trg_gig_version_field_values__no_truncate BEFORE TRUNCATE ON provider.gig_version_field_values FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation();
COMMENT ON FUNCTION provider.guard_gig_version_field_values() IS 'Field value guard: rows change (insert, update, delete) only while the parent version is a DRAFT (read FOR SHARE so a concurrent publication serializes); version, field and creation time immutable; the field (read FOR SHARE) belongs to the version''s bound template version, is not PLATFORM_FIXED, has a supported type and exactly the matching typed column is populated (an ENUM option is validated by the composite foreign key) (VERSION_FROZEN, IMMUTABLE_IDENTITY, FIELD_NOT_IN_TEMPLATE_VERSION, FIELD_FIXED, FIELD_TYPE_UNSUPPORTED, FIELD_TYPE_MISMATCH). Length and numeric bounds of the field are validated by the service.';

-- ------------------------------------------------------------------------------------------------------- audit
CREATE FUNCTION provider.guard_gig_audit_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  g_account uuid;
  v_gig     uuid;
BEGIN
  SELECT account_id INTO g_account FROM provider.gigs WHERE gig_id = NEW.gig_id;
  IF g_account IS NOT NULL AND g_account <> NEW.account_id THEN
    RAISE EXCEPTION 'the audit row names an account that does not own the Gig' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:AUDIT_MISMATCH';
  END IF;
  IF NEW.gig_version_id IS NOT NULL THEN
    SELECT gig_id INTO v_gig FROM provider.gig_versions WHERE gig_version_id = NEW.gig_version_id;
    IF v_gig IS NOT NULL AND v_gig <> NEW.gig_id THEN
      RAISE EXCEPTION 'the audit row names a version of another Gig' USING ERRCODE = 'integrity_constraint_violation', DETAIL = 'provider_rule:AUDIT_MISMATCH';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_gig_audit_events__guard BEFORE INSERT ON provider.gig_audit_events FOR EACH ROW EXECUTE FUNCTION provider.guard_gig_audit_events();
CREATE TRIGGER trg_gig_audit_events__immutable BEFORE UPDATE OR DELETE ON provider.gig_audit_events FOR EACH ROW EXECUTE FUNCTION provider.forbid_mutation();
CREATE TRIGGER trg_gig_audit_events__no_truncate BEFORE TRUNCATE ON provider.gig_audit_events FOR EACH STATEMENT EXECUTE FUNCTION provider.forbid_mutation();
COMMENT ON FUNCTION provider.guard_gig_audit_events() IS 'Audit insert guard: the account of the row owns the Gig and the version (when given) belongs to the Gig (AUDIT_MISMATCH). UPDATE, DELETE and TRUNCATE are refused by provider.forbid_mutation (ROW_IMMUTABLE).';

-- =====================================================================================================================
-- 6. seed: the Gig policy (CFG-001), through the real configuration lifecycle
--    Typed integers at PLATFORM scope, read fresh by the service, no code default (a missing or invalid value fails closed). STANDARD criticality: operational policy, not a legal requirement.
--    The bounds of the definitions mirror the structural ceilings of the contract and of the CHECK constraints above (title 200, short pitch 2000, description 20000, counts 500).
--    4: PRD PR-03.06 names 1,000 characters for the short pitch. 1, 2, 3 and 5 are ENGINEERING ASSUMPTIONS (the PRD gives no caps or title and description lengths); they are product configuration, changed through the change-request workflow.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_approver    constant text := 'system:migration-review';
  v_correlation constant text := 'seed-0020';
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
      (1, 'provider.gig.max_active', 'INTEGER', 'Gigs', 'Maximum number of Gigs in ACTIVE status one provider account can hold (checked at the first publication of a Gig)', '{"min": 1, "max": 500}'::jsonb,
          '25'::jsonb, 'CAT-003 engineering assumption, not in the PRD (bounds the size of a GigMenu)'),
      (2, 'provider.gig.max_drafts', 'INTEGER', 'drafts', 'Maximum number of Gig versions in DRAFT status one provider account can hold at the same time (checked when a Gig or a next draft is created)', '{"min": 1, "max": 500}'::jsonb,
          '10'::jsonb, 'CAT-003 engineering assumption, not in the PRD (bounds unfinished work per account)'),
      (3, 'provider.gig.title.max_length', 'INTEGER', 'characters', 'Maximum length of a Gig title, in characters (Unicode code points)', '{"min": 1, "max": 200}'::jsonb,
          '100'::jsonb, 'CAT-003 engineering assumption, not in the PRD (structural ceiling 200)'),
      (4, 'provider.gig.short_pitch.max_length', 'INTEGER', 'characters', 'Maximum length of a Gig short pitch, in characters (Unicode code points)', '{"min": 1, "max": 2000}'::jsonb,
          '1000'::jsonb, 'PRD PR-03.06: a short pitch of up to 1,000 characters'),
      (5, 'provider.gig.description.max_length', 'INTEGER', 'characters', 'Maximum length of a Gig description, in characters (Unicode code points)', '{"min": 1, "max": 20000}'::jsonb,
          '5000'::jsonb, 'CAT-003 engineering assumption, not in the PRD (structural ceiling 20000)')
    ) AS t (ord, key, data_type, unit, description, rules, value, basis)
    ORDER BY ord
  LOOP
    v_reason := 'Initial value (migration 0020): ' || v_seed.basis;
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
    VALUES (v_request, v_approver, 'APPROVE', 'Initial value reviewed with the migration (CAT-003)');
    UPDATE configuration.change_requests SET state = 'APPROVED', updated_at = now() WHERE change_request_id = v_request AND state = 'PENDING_APPROVAL';
    INSERT INTO configuration.audit_events (occurred_at, actor, action, parameter_id, change_request_id, reason, correlation_id)
    VALUES (clock_timestamp(), v_approver, 'CHANGE_APPROVED', v_parameter, v_request, 'Initial value reviewed with the migration (CAT-003)', v_correlation);

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
-- 7. seed: the copy of the minimal Gig flow (CFG-002), through the real content lifecycle (en-US only)
--    Status, error and issue labels (one entry per contract enum value) and the labels, hints and notices of the TEMPORARY minimal GigMenu and editor; NO LEGAL TEXT and NO provider text.
--    No variables, no personal data.
-- =====================================================================================================================
DO $seed$
DECLARE
  v_from        timestamptz := now();
  v_actor       constant text := 'system:migration';
  v_correlation constant text := 'seed-0020';
  v_reason      constant text := 'Initial provider Gig copy (migration 0020)';
  v_seed        record;
  v_entry_id    uuid;
  v_version_id  uuid;
BEGIN
  FOR v_seed IN
    SELECT *
    FROM (VALUES
      (1, 'UI_LABEL', 'provider.gig.status.draft', 'Gig copy: status.draft', 'Draft'),
      (2, 'UI_LABEL', 'provider.gig.status.active', 'Gig copy: status.active', 'Active'),
      (3, 'UI_LABEL', 'provider.gig.status.retired', 'Gig copy: status.retired', 'Retired'),
      (4, 'UI_LABEL', 'provider.gig.version_status.draft', 'Gig copy: version_status.draft', 'Draft'),
      (5, 'UI_LABEL', 'provider.gig.version_status.published', 'Gig copy: version_status.published', 'Published'),
      (6, 'UI_LABEL', 'provider.gig.version_status.superseded', 'Gig copy: version_status.superseded', 'Replaced by a newer version'),
      (7, 'UI_LABEL', 'provider.gig.version_status.retired', 'Gig copy: version_status.retired', 'Retired'),
      (8, 'PLAIN_TEXT', 'provider.gig.error.gig_not_found', 'Gig copy: error.gig_not_found', 'We could not find that Gig.'),
      (9, 'PLAIN_TEXT', 'provider.gig.error.gig_version_not_found', 'Gig copy: error.gig_version_not_found', 'We could not find that version of the Gig.'),
      (10, 'PLAIN_TEXT', 'provider.gig.error.gig_template_not_found', 'Gig copy: error.gig_template_not_found', 'We could not find that template.'),
      (11, 'PLAIN_TEXT', 'provider.gig.error.gig_template_not_available', 'Gig copy: error.gig_template_not_available', 'That template is not available to you right now.'),
      (12, 'PLAIN_TEXT', 'provider.gig.error.provider_not_eligible', 'Gig copy: error.provider_not_eligible', 'Finish your provider registration, including your market and services, before you create Gigs.'),
      (13, 'PLAIN_TEXT', 'provider.gig.error.account_not_active', 'Gig copy: error.account_not_active', 'Your account is not active.'),
      (14, 'PLAIN_TEXT', 'provider.gig.error.gig_retired', 'Gig copy: error.gig_retired', 'This Gig is retired and can no longer be changed.'),
      (15, 'PLAIN_TEXT', 'provider.gig.error.draft_exists', 'Gig copy: error.draft_exists', 'This Gig already has a draft. Continue editing it.'),
      (16, 'PLAIN_TEXT', 'provider.gig.error.no_draft', 'Gig copy: error.no_draft', 'There is no draft to change or publish. Start a new draft first.'),
      (17, 'PLAIN_TEXT', 'provider.gig.error.stale_draft', 'Gig copy: error.stale_draft', 'This draft changed since you opened it. Reload the page and try again.'),
      (18, 'PLAIN_TEXT', 'provider.gig.error.publish_blocked', 'Gig copy: error.publish_blocked', 'This draft cannot be published yet. Check the items listed.'),
      (19, 'PLAIN_TEXT', 'provider.gig.error.limit_reached', 'Gig copy: error.limit_reached', 'You have reached the limit of Gigs or drafts on your account.'),
      (20, 'PLAIN_TEXT', 'provider.gig.error.validation_failed', 'Gig copy: error.validation_failed', 'Check the highlighted fields.'),
      (21, 'PLAIN_TEXT', 'provider.gig.error.conflict', 'Gig copy: error.conflict', 'Another change happened at the same time. Try again.'),
      (22, 'PLAIN_TEXT', 'provider.gig.error.unavailable', 'Gig copy: error.unavailable', 'Gigs are temporarily unavailable. Try again in a moment.'),
      (23, 'PLAIN_TEXT', 'provider.gig.issue.title_required', 'Gig copy: issue.title_required', 'Add a title.'),
      (24, 'PLAIN_TEXT', 'provider.gig.issue.title_too_long', 'Gig copy: issue.title_too_long', 'The title is too long.'),
      (25, 'PLAIN_TEXT', 'provider.gig.issue.short_pitch_required', 'Gig copy: issue.short_pitch_required', 'Add a short pitch.'),
      (26, 'PLAIN_TEXT', 'provider.gig.issue.short_pitch_too_long', 'Gig copy: issue.short_pitch_too_long', 'The short pitch is too long.'),
      (27, 'PLAIN_TEXT', 'provider.gig.issue.description_required', 'Gig copy: issue.description_required', 'Add a description.'),
      (28, 'PLAIN_TEXT', 'provider.gig.issue.description_too_long', 'Gig copy: issue.description_too_long', 'The description is too long.'),
      (29, 'PLAIN_TEXT', 'provider.gig.issue.forbidden_character', 'Gig copy: issue.forbidden_character', 'Remove the characters that are not allowed.'),
      (30, 'PLAIN_TEXT', 'provider.gig.issue.html_not_allowed', 'Gig copy: issue.html_not_allowed', 'Use plain text only. Remove any markup.'),
      (31, 'PLAIN_TEXT', 'provider.gig.issue.price_required', 'Gig copy: issue.price_required', 'Add a price.'),
      (32, 'PLAIN_TEXT', 'provider.gig.issue.price_not_permitted', 'Gig copy: issue.price_not_permitted', 'This template does not allow a price.'),
      (33, 'PLAIN_TEXT', 'provider.gig.issue.price_not_positive', 'Gig copy: issue.price_not_positive', 'The price must be greater than zero.'),
      (34, 'PLAIN_TEXT', 'provider.gig.issue.duration_required', 'Gig copy: issue.duration_required', 'Add a duration.'),
      (35, 'PLAIN_TEXT', 'provider.gig.issue.duration_not_permitted', 'Gig copy: issue.duration_not_permitted', 'This template does not allow a duration.'),
      (36, 'PLAIN_TEXT', 'provider.gig.issue.duration_out_of_range', 'Gig copy: issue.duration_out_of_range', 'The duration is outside the allowed range.'),
      (37, 'PLAIN_TEXT', 'provider.gig.issue.field_required', 'Gig copy: issue.field_required', 'Fill in this required field.'),
      (38, 'PLAIN_TEXT', 'provider.gig.issue.field_unknown', 'Gig copy: issue.field_unknown', 'This field is not part of the template.'),
      (39, 'PLAIN_TEXT', 'provider.gig.issue.field_not_provider_editable', 'Gig copy: issue.field_not_provider_editable', 'The platform sets this field. You cannot change it.'),
      (40, 'PLAIN_TEXT', 'provider.gig.issue.field_type_not_supported', 'Gig copy: issue.field_type_not_supported', 'This kind of field is not available yet.'),
      (41, 'PLAIN_TEXT', 'provider.gig.issue.field_value_invalid', 'Gig copy: issue.field_value_invalid', 'This value is not valid.'),
      (42, 'PLAIN_TEXT', 'provider.gig.issue.field_value_out_of_range', 'Gig copy: issue.field_value_out_of_range', 'This value is outside the allowed range.'),
      (43, 'PLAIN_TEXT', 'provider.gig.issue.field_option_unknown', 'Gig copy: issue.field_option_unknown', 'Choose one of the listed options.'),
      (44, 'PLAIN_TEXT', 'provider.gig.issue.field_too_short', 'Gig copy: issue.field_too_short', 'This text is too short.'),
      (45, 'PLAIN_TEXT', 'provider.gig.issue.field_too_long', 'Gig copy: issue.field_too_long', 'This text is too long.'),
      (46, 'PLAIN_TEXT', 'provider.gig.issue.template_version_retired', 'Gig copy: issue.template_version_retired', 'The template version this Gig is built on was withdrawn, so it cannot be published.'),
      (47, 'UI_LABEL', 'provider.gig.page.title', 'Gig copy: page.title', 'Your Gigs'),
      (48, 'PLAIN_TEXT', 'provider.gig.page.intro', 'Gig copy: page.intro', 'Build the services you offer from the platform templates. Save a draft as often as you like and publish it when it is ready.'),
      (49, 'UI_LABEL', 'provider.gig.menu.heading', 'Gig copy: menu.heading', 'Your Gigs'),
      (50, 'PLAIN_TEXT', 'provider.gig.menu.empty', 'Gig copy: menu.empty', 'You have no Gigs yet. Start one from a template below.'),
      (51, 'PLAIN_TEXT', 'provider.gig.menu.not_eligible', 'Gig copy: menu.not_eligible', 'Finish your provider registration, including your market and services, to create Gigs.'),
      (52, 'PLAIN_TEXT', 'provider.gig.menu.draft_limit', 'Gig copy: menu.draft_limit', 'You have reached the limit of drafts. Publish or finish an existing draft first.'),
      (53, 'PLAIN_TEXT', 'provider.gig.menu.not_live_note', 'Gig copy: menu.not_live_note', 'Publishing a Gig does not put you live or make it bookable. Going live is a separate step.'),
      (54, 'UI_LABEL', 'provider.gig.menu.limits_heading', 'Gig copy: menu.limits_heading', 'Your limits'),
      (55, 'UI_LABEL', 'provider.gig.menu.limit_active', 'Gig copy: menu.limit_active', 'Active Gigs'),
      (56, 'UI_LABEL', 'provider.gig.menu.limit_drafts', 'Gig copy: menu.limit_drafts', 'Drafts'),
      (57, 'UI_LABEL', 'provider.gig.menu.open', 'Gig copy: menu.open', 'Open'),
      (58, 'UI_LABEL', 'provider.gig.menu.current_version', 'Gig copy: menu.current_version', 'Published version'),
      (59, 'UI_LABEL', 'provider.gig.menu.draft_version', 'Gig copy: menu.draft_version', 'Draft'),
      (60, 'PLAIN_TEXT', 'provider.gig.menu.no_published', 'Gig copy: menu.no_published', 'Nothing published yet.'),
      (61, 'UI_LABEL', 'provider.gig.menu.price', 'Gig copy: menu.price', 'Price'),
      (62, 'UI_LABEL', 'provider.gig.menu.duration', 'Gig copy: menu.duration', 'Duration'),
      (63, 'UI_LABEL', 'provider.gig.create.heading', 'Gig copy: create.heading', 'Start a new Gig'),
      (64, 'UI_LABEL', 'provider.gig.create.template', 'Gig copy: create.template', 'Template'),
      (65, 'UI_LABEL', 'provider.gig.create.submit', 'Gig copy: create.submit', 'Create Gig'),
      (66, 'PLAIN_TEXT', 'provider.gig.create.none_available', 'Gig copy: create.none_available', 'No templates are available for your market and services yet.'),
      (67, 'UI_LABEL', 'provider.gig.editor.heading', 'Gig copy: editor.heading', 'Edit your Gig'),
      (68, 'UI_LABEL', 'provider.gig.editor.title', 'Gig copy: editor.title', 'Title'),
      (69, 'PLAIN_TEXT', 'provider.gig.editor.title_hint', 'Gig copy: editor.title_hint', 'A short name customers will see. Plain text only.'),
      (70, 'UI_LABEL', 'provider.gig.editor.short_pitch', 'Gig copy: editor.short_pitch', 'Short pitch'),
      (71, 'PLAIN_TEXT', 'provider.gig.editor.short_pitch_hint', 'Gig copy: editor.short_pitch_hint', 'One or two sentences that sell the service. Plain text only.'),
      (72, 'UI_LABEL', 'provider.gig.editor.description', 'Gig copy: editor.description', 'Description'),
      (73, 'PLAIN_TEXT', 'provider.gig.editor.description_hint', 'Gig copy: editor.description_hint', 'Explain what you do and what the customer can expect. Plain text only.'),
      (74, 'UI_LABEL', 'provider.gig.editor.price', 'Gig copy: editor.price', 'Price'),
      (75, 'PLAIN_TEXT', 'provider.gig.editor.price_hint', 'Gig copy: editor.price_hint', 'The base price in the smallest unit of your currency, for example cents.'),
      (76, 'UI_LABEL', 'provider.gig.editor.currency', 'Gig copy: editor.currency', 'Currency'),
      (77, 'UI_LABEL', 'provider.gig.editor.duration', 'Gig copy: editor.duration', 'Duration in minutes'),
      (78, 'PLAIN_TEXT', 'provider.gig.editor.duration_hint', 'Gig copy: editor.duration_hint', 'How long the service takes.'),
      (79, 'UI_LABEL', 'provider.gig.editor.fields_heading', 'Gig copy: editor.fields_heading', 'Service details'),
      (80, 'UI_LABEL', 'provider.gig.editor.fixed_heading', 'Gig copy: editor.fixed_heading', 'Set by the platform'),
      (81, 'PLAIN_TEXT', 'provider.gig.editor.fixed_note', 'Gig copy: editor.fixed_note', 'The platform sets these values. You cannot change them.'),
      (82, 'PLAIN_TEXT', 'provider.gig.editor.unsupported_note', 'Gig copy: editor.unsupported_note', 'Not available yet'),
      (83, 'UI_LABEL', 'provider.gig.editor.required', 'Gig copy: editor.required', 'Required'),
      (84, 'UI_LABEL', 'provider.gig.editor.optional', 'Gig copy: editor.optional', 'Optional'),
      (85, 'UI_LABEL', 'provider.gig.editor.save', 'Gig copy: editor.save', 'Save draft'),
      (86, 'UI_LABEL', 'provider.gig.editor.publish', 'Gig copy: editor.publish', 'Publish'),
      (87, 'UI_LABEL', 'provider.gig.editor.retire', 'Gig copy: editor.retire', 'Retire this Gig'),
      (88, 'PLAIN_TEXT', 'provider.gig.editor.retire_note', 'Gig copy: editor.retire_note', 'A retired Gig cannot be brought back. Its history stays available to you. To offer it again, create a new Gig.'),
      (89, 'UI_LABEL', 'provider.gig.editor.new_draft', 'Gig copy: editor.new_draft', 'Start a new draft'),
      (90, 'UI_LABEL', 'provider.gig.editor.back', 'Gig copy: editor.back', 'Back to your Gigs'),
      (91, 'UI_LABEL', 'provider.gig.editor.issues_heading', 'Gig copy: editor.issues_heading', 'To do before you can publish'),
      (92, 'UI_LABEL', 'provider.gig.editor.history_heading', 'Gig copy: editor.history_heading', 'Version history'),
      (93, 'UI_LABEL', 'provider.gig.editor.version', 'Gig copy: editor.version', 'Version'),
      (94, 'UI_LABEL', 'provider.gig.editor.template', 'Gig copy: editor.template', 'Template'),
      (95, 'UI_LABEL', 'provider.gig.editor.template_version', 'Gig copy: editor.template_version', 'Template version'),
      (96, 'UI_LABEL', 'provider.gig.editor.published_at', 'Gig copy: editor.published_at', 'Published'),
      (97, 'PLAIN_TEXT', 'provider.gig.editor.not_editable', 'Gig copy: editor.not_editable', 'This version cannot be edited. Start a new draft to make changes.'),
      (98, 'UI_LABEL', 'provider.gig.editor.draft_heading', 'Gig copy: editor.draft_heading', 'Draft'),
      (99, 'UI_LABEL', 'provider.gig.editor.current_heading', 'Gig copy: editor.current_heading', 'Published version'),
      (100, 'UI_LABEL', 'provider.gig.editor.yes', 'Gig copy: editor.yes', 'Yes'),
      (101, 'UI_LABEL', 'provider.gig.editor.no', 'Gig copy: editor.no', 'No'),
      (102, 'UI_LABEL', 'provider.gig.editor.select_empty', 'Gig copy: editor.select_empty', 'Choose an option'),
      (103, 'PLAIN_TEXT', 'provider.gig.notice.created', 'Gig copy: notice.created', 'Your Gig was created.'),
      (104, 'PLAIN_TEXT', 'provider.gig.notice.saved', 'Gig copy: notice.saved', 'Your draft was saved.'),
      (105, 'PLAIN_TEXT', 'provider.gig.notice.published', 'Gig copy: notice.published', 'Your Gig version was published.'),
      (106, 'PLAIN_TEXT', 'provider.gig.notice.draft_created', 'Gig copy: notice.draft_created', 'A new draft was started.'),
      (107, 'PLAIN_TEXT', 'provider.gig.notice.retired', 'Gig copy: notice.retired', 'Your Gig was retired.')
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
