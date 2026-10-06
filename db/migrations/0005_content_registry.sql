-- checkpoint: CFG-002
-- purpose: create the content schema: locale registry, content entries with typed template variables, effective-dated immutable localized versions with approval workflow, immutable snapshots and an audit trail
-- rollback strategy: forward-fix only; the schema holds only the seeded launch locale until entries are created, so locally `pnpm stack:reset` is sufficient
-- backfill: none (new objects); content.locales is structural reference data seeded here with the approved launch locale (en-US), not product copy
-- risk: low; new schema and tables only. Reuses configuration.scope_levels (read-only foreign key) so there is a single scope hierarchy; btree_gist already exists (0004)

CREATE SCHEMA content;
COMMENT ON SCHEMA content IS 'Application-owned: managed product copy (UI text, message templates, help and legal documents) as stable keys with localized, effective-dated, immutable versions. Not configuration values (schema configuration), not runtime config (env) and not feature flags (flagd).';

-- ------------------------------------------------------------------ locales (reference data; activation is data, not code)
CREATE TABLE content.locales (
  locale              text        NOT NULL,
  is_active           boolean     NOT NULL DEFAULT false,
  is_platform_default boolean     NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_locales PRIMARY KEY (locale),
  -- canonical BCP 47 subset: language[-Script][-REGION]; no variants or extensions yet
  CONSTRAINT ck_locales__bcp47_format CHECK (locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$'),
  CONSTRAINT ck_locales__default_is_active CHECK (NOT is_platform_default OR is_active)
);
COMMENT ON TABLE content.locales IS 'Registered locales. is_active controls which locales may be served; is_platform_default marks the single last-resort locale of every fallback chain. Rows are never deleted. The launch seed is en-US only; no translations are invented. Exactly one default exists: the partial unique index allows at most one, the seed inserts it, and guard_locales refuses any UPDATE that unsets it (the default is moved only by a migration that disables the guard trigger inside one transaction and sets the new default in the same transaction).';
CREATE UNIQUE INDEX uq_locales__platform_default ON content.locales (is_platform_default) WHERE is_platform_default;
INSERT INTO content.locales (locale, is_active, is_platform_default) VALUES ('en-US', true, true);

-- ------------------------------------------------------------------ entries (stable semantic identity of a piece of content)
CREATE TABLE content.entries (
  entry_id        uuid        NOT NULL DEFAULT gen_random_uuid(),
  key             text        NOT NULL,
  content_type    text        NOT NULL,
  owner_role      text        NOT NULL,
  description     text        NOT NULL,
  sensitivity     text        NOT NULL DEFAULT 'PUBLIC',
  criticality     text        NOT NULL DEFAULT 'STANDARD',
  approval_policy text        NOT NULL,
  fallback_policy text        NOT NULL DEFAULT 'CHAIN',
  max_scope_type  text        NOT NULL DEFAULT 'PLATFORM',
  is_active       boolean     NOT NULL DEFAULT true,
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_entries PRIMARY KEY (entry_id),
  CONSTRAINT uq_entries__key UNIQUE (key),
  CONSTRAINT fk_entries__max_scope_type FOREIGN KEY (max_scope_type) REFERENCES configuration.scope_levels (scope_type) ON DELETE RESTRICT,
  CONSTRAINT ck_entries__key_format CHECK (key ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$' AND length(key) <= 160),
  CONSTRAINT ck_entries__content_type CHECK (content_type IN ('PLAIN_TEXT', 'RICH_TEXT', 'MARKDOWN', 'EMAIL_SUBJECT', 'EMAIL_BODY', 'PUSH_TITLE', 'PUSH_BODY', 'LEGAL', 'HELP_ARTICLE', 'UI_LABEL')),
  CONSTRAINT ck_entries__owner_role CHECK (owner_role IN ('CONTENT', 'LEGAL', 'SUPPORT', 'MARKETING')),
  CONSTRAINT ck_entries__sensitivity CHECK (sensitivity IN ('PUBLIC', 'INTERNAL')),
  CONSTRAINT ck_entries__criticality CHECK (criticality IN ('STANDARD', 'CRITICAL')),
  CONSTRAINT ck_entries__approval_policy CHECK (approval_policy IN ('NONE', 'OWNER_APPROVAL', 'SECOND_APPROVER')),
  CONSTRAINT ck_entries__fallback_policy CHECK (fallback_policy IN ('CHAIN', 'LANGUAGE_ONLY', 'EXACT')),
  CONSTRAINT ck_entries__max_scope_type CHECK (max_scope_type IN ('PLATFORM', 'COUNTRY', 'MARKET')),
  CONSTRAINT ck_entries__description_not_blank CHECK (length(btrim(description)) > 0),
  -- legal documents: stricter by construction (owned by LEGAL, second approver, never stale, never a silently different language)
  CONSTRAINT ck_entries__legal_policy CHECK (content_type <> 'LEGAL' OR (owner_role = 'LEGAL' AND approval_policy = 'SECOND_APPROVER' AND criticality = 'CRITICAL' AND fallback_policy = 'EXACT'))
);
COMMENT ON TABLE content.entries IS 'Stable identity of one piece of managed content (key, type, ownership, governance policy). The key never encodes a locale or the displayed text. Everything except is_active and updated_at is immutable; a different policy is a different entry.';
COMMENT ON COLUMN content.entries.fallback_policy IS 'CHAIN: requested locale, its language, the caller-supplied market default, then the platform default. LANGUAGE_ONLY: requested locale and its language. EXACT: the requested locale only (legal copy never silently falls back).';
COMMENT ON COLUMN content.entries.max_scope_type IS 'Most specific scope at which this entry may be overridden (PLATFORM, COUNTRY or MARKET). Content is centrally managed copy; gig, provider and category text is domain data, not content.';
COMMENT ON COLUMN content.entries.criticality IS 'CRITICAL entries are never cached and never served from last-known-good (legal and disclosed copy).';
COMMENT ON COLUMN content.entries.sensitivity IS 'PUBLIC entries may be resolved anonymously; INTERNAL entries only by authorized management callers and trusted services.';

-- ------------------------------------------------------------------ template variables (the contract shared by every locale and version of an entry)
CREATE TABLE content.entry_variables (
  entry_id      uuid        NOT NULL,
  name          text        NOT NULL,
  var_type      text        NOT NULL,
  is_required   boolean     NOT NULL DEFAULT true,
  description   text        NOT NULL,
  example_value jsonb       NOT NULL,
  pii_class     text        NOT NULL DEFAULT 'NONE',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_entry_variables PRIMARY KEY (entry_id, name),
  CONSTRAINT fk_entry_variables__entry_id FOREIGN KEY (entry_id) REFERENCES content.entries (entry_id) ON DELETE RESTRICT,
  CONSTRAINT ck_entry_variables__name_format CHECK (name ~ '^[a-z][a-z0-9_]*$' AND length(name) <= 60),
  CONSTRAINT ck_entry_variables__var_type CHECK (var_type IN ('STRING', 'NUMBER', 'MONEY', 'DATE', 'TIME', 'DATETIME', 'URL', 'PERSON_DISPLAY_NAME', 'COUNT')),
  CONSTRAINT ck_entry_variables__pii_class CHECK (pii_class IN ('NONE', 'PERSONAL', 'SENSITIVE_PERSONAL')),
  CONSTRAINT ck_entry_variables__person_name_is_pii CHECK (var_type <> 'PERSON_DISPLAY_NAME' OR pii_class <> 'NONE'),
  CONSTRAINT ck_entry_variables__description_not_blank CHECK (length(btrim(description)) > 0)
);
COMMENT ON TABLE content.entry_variables IS 'Approved placeholders of an entry. Belongs to the entry, not to a locale: every translation uses the same variable contract. Immutable; a required variable cannot be added once the entry has versions.';
COMMENT ON COLUMN content.entry_variables.example_value IS 'Example/test value in the canonical encoding of var_type (a JSON scalar, or {amount_minor, currency} for MONEY). Used to dry-render drafts; kept as JSON because its shape depends on var_type.';

-- ------------------------------------------------------------------ versions: one row per (entry, locale, scope, version), carrying its own lifecycle
CREATE TABLE content.versions (
  version_id      uuid        NOT NULL DEFAULT gen_random_uuid(),
  entry_id        uuid        NOT NULL,
  locale          text        NOT NULL,
  scope_type      text        NOT NULL DEFAULT 'PLATFORM',
  scope_ref       text,
  version         integer     NOT NULL,
  body            text        NOT NULL,
  body_sha256     text        NOT NULL DEFAULT '',
  status          text        NOT NULL DEFAULT 'DRAFT',
  approval_policy text        NOT NULL,
  effective_from  timestamptz NOT NULL,
  effective_to    timestamptz,
  reason          text        NOT NULL,
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_versions PRIMARY KEY (version_id),
  CONSTRAINT uq_versions__version_entry UNIQUE (version_id, entry_id),
  CONSTRAINT uq_versions__holder_version UNIQUE NULLS NOT DISTINCT (entry_id, locale, scope_type, scope_ref, version),
  CONSTRAINT fk_versions__entry_id FOREIGN KEY (entry_id) REFERENCES content.entries (entry_id) ON DELETE RESTRICT,
  CONSTRAINT fk_versions__locale FOREIGN KEY (locale) REFERENCES content.locales (locale) ON DELETE RESTRICT,
  CONSTRAINT fk_versions__scope_type FOREIGN KEY (scope_type) REFERENCES configuration.scope_levels (scope_type) ON DELETE RESTRICT,
  CONSTRAINT ck_versions__scope_type CHECK (scope_type IN ('PLATFORM', 'COUNTRY', 'MARKET')),
  CONSTRAINT ck_versions__platform_has_no_ref CHECK ((scope_type = 'PLATFORM') = (scope_ref IS NULL)),
  CONSTRAINT ck_versions__scope_ref_format CHECK (scope_ref IS NULL OR scope_ref ~ '^[A-Za-z0-9._:-]{1,200}$'),
  CONSTRAINT ck_versions__version_positive CHECK (version > 0),
  CONSTRAINT ck_versions__body_length CHECK (length(body) BETWEEN 1 AND 200000),
  CONSTRAINT ck_versions__status CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'SUPERSEDED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT ck_versions__approval_policy CHECK (approval_policy IN ('NONE', 'OWNER_APPROVAL', 'SECOND_APPROVER')),
  CONSTRAINT ck_versions__effective_range CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT ck_versions__reason_not_blank CHECK (length(btrim(reason)) > 0),
  -- published = SCHEDULED, PUBLISHED or SUPERSEDED. Only published versions can ever resolve, and they never overlap per (entry, locale, scope).
  CONSTRAINT ex_versions__no_overlap EXCLUDE USING gist (
    entry_id WITH =, locale WITH =, scope_type WITH =, (coalesce(scope_ref, '')) WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (status IN ('SCHEDULED', 'PUBLISHED', 'SUPERSEDED'))
);
COMMENT ON TABLE content.versions IS 'Localized, scoped, versioned body of an entry with its own lifecycle (DRAFT, IN_REVIEW, APPROVED, SCHEDULED, PUBLISHED, SUPERSEDED, REJECTED, CANCELLED). The body is immutable from creation; published rows (SCHEDULED/PUBLISHED/SUPERSEDED) are the only ones that resolve and the database forbids overlapping periods per holder. Effective period is half-open [effective_from, effective_to). SCHEDULED/PUBLISHED/SUPERSEDED are workflow markers: which published version applies is always derived from the timestamps.';
COMMENT ON COLUMN content.versions.approval_policy IS 'Deliberate copy of the entry policy at creation (the policy that governed THIS version must never change retroactively); the guard trigger enforces equality with the entry at insert and immutability afterwards.';
COMMENT ON COLUMN content.versions.body IS 'Template source in the restricted template syntax (see docs/engineering/CONTENT.md). Never executable; validated by the service against the entry variables and the content-type rendering policy before insert.';
COMMENT ON COLUMN content.versions.body_sha256 IS 'SHA-256 (hex) of the UTF-8 body, computed by the insert trigger (never trusted from the caller). Lets later consent and audit records bind to the exact text.';
COMMENT ON COLUMN content.versions.effective_from IS 'Proposed start while unpublished; at publication raised to the publication instant when the proposal has already passed. Immutable afterwards.';

-- Serves the effective_from branch of the resolver's next-boundary query (index-only scan over entry, locale, scope and a future effective_from).
-- It does NOT serve the candidate query: that one reads the published rows of the requested entries through idx_versions__entry or the gist exclusion index
-- ex_versions__no_overlap (equality on entry, locale and scope) and filters them by time, so its cost grows with the history length of the holder
-- (every published row of one holder is read; EXPLAIN on 3000 entries x 2 locales x 5 versions, 20 keys: 200 rows read, 40 returned, under 1 ms).
-- The effective_to branch of the boundary query reads the same history. Per-holder history is short and bounded by editorial practice.
CREATE INDEX idx_versions__resolution ON content.versions (entry_id, locale, scope_type, effective_from DESC) WHERE status IN ('SCHEDULED', 'PUBLISHED', 'SUPERSEDED');
-- Review queue.
CREATE INDEX idx_versions__in_review ON content.versions (created_at) WHERE status = 'IN_REVIEW';
-- Scheduled-publication job.
CREATE INDEX idx_versions__scheduled ON content.versions (effective_from) WHERE status = 'SCHEDULED';
-- Management view of one entry's history.
CREATE INDEX idx_versions__entry ON content.versions (entry_id, created_at DESC);

CREATE TABLE content.version_approvals (
  approval_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  version_id  uuid        NOT NULL,
  approver    text        NOT NULL,
  decision    text        NOT NULL,
  comment     text,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_version_approvals PRIMARY KEY (approval_id),
  CONSTRAINT fk_version_approvals__version_id FOREIGN KEY (version_id) REFERENCES content.versions (version_id) ON DELETE RESTRICT,
  CONSTRAINT uq_version_approvals__version_approver UNIQUE (version_id, approver),
  CONSTRAINT ck_version_approvals__decision CHECK (decision IN ('APPROVE', 'REJECT'))
);
COMMENT ON TABLE content.version_approvals IS 'Immutable review decisions, one per approver per version. A trigger forbids the author from approving their own version under SECOND_APPROVER (always the case for legal documents) and requires the version to be IN_REVIEW.';

-- ------------------------------------------------------------------ snapshots (only where historical reproduction matters)
CREATE TABLE content.snapshots (
  snapshot_id      uuid        NOT NULL DEFAULT gen_random_uuid(),
  evaluated_at     timestamptz NOT NULL,
  requested_locale text        NOT NULL,
  context          jsonb       NOT NULL,
  purpose          text        NOT NULL,
  created_by       text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_snapshots PRIMARY KEY (snapshot_id),
  CONSTRAINT ck_snapshots__context_object CHECK (jsonb_typeof(context) = 'object'),
  CONSTRAINT ck_snapshots__purpose_not_blank CHECK (length(btrim(purpose)) > 0),
  CONSTRAINT ck_snapshots__locale_format CHECK (requested_locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$')
);
COMMENT ON TABLE content.snapshots IS 'Immutable record of a resolution: requested locale, context and evaluation time. Created only for copy that must be reproducible later (accepted legal text, disclosed booking or financial copy, transactional messages); routine UI labels are never snapshotted. context is an input copy read back whole.';

CREATE TABLE content.snapshot_items (
  snapshot_id uuid NOT NULL,
  entry_id    uuid NOT NULL,
  version_id  uuid NOT NULL,
  CONSTRAINT pk_snapshot_items PRIMARY KEY (snapshot_id, entry_id),
  CONSTRAINT fk_snapshot_items__snapshot_id FOREIGN KEY (snapshot_id) REFERENCES content.snapshots (snapshot_id) ON DELETE RESTRICT,
  CONSTRAINT fk_snapshot_items__entry_version FOREIGN KEY (version_id, entry_id) REFERENCES content.versions (version_id, entry_id) ON DELETE RESTRICT
);
COMMENT ON TABLE content.snapshot_items IS 'The exact version of each resolved entry. version_id points at an IMMUTABLE row: the body, locale, scope and effective_from-at-publication can never change and the row can never be deleted (the only later change is closing an open effective_to once), so the text that applied at evaluated_at is fixed and the pointer is equivalent to a stored copy. entry_id repeats versions.entry_id only so that one snapshot holds one version per entry; the composite foreign key makes drift impossible.';

-- ------------------------------------------------------------------ audit
CREATE TABLE content.audit_events (
  audit_event_id      uuid        NOT NULL DEFAULT gen_random_uuid(),
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  actor               text        NOT NULL,
  action              text        NOT NULL,
  entry_id            uuid,
  locale              text,
  version_id          uuid,
  previous_version_id uuid,
  reason              text,
  correlation_id      text        NOT NULL,
  CONSTRAINT pk_audit_events PRIMARY KEY (audit_event_id),
  CONSTRAINT fk_audit_events__entry_id FOREIGN KEY (entry_id) REFERENCES content.entries (entry_id) ON DELETE RESTRICT,
  -- Composite foreign keys (MATCH SIMPLE: skipped while a column is NULL): a version named by an audit row must belong to the entry named by the same row.
  CONSTRAINT fk_audit_events__version_entry FOREIGN KEY (version_id, entry_id) REFERENCES content.versions (version_id, entry_id) ON DELETE RESTRICT,
  CONSTRAINT fk_audit_events__previous_version_entry FOREIGN KEY (previous_version_id, entry_id) REFERENCES content.versions (version_id, entry_id) ON DELETE RESTRICT,
  CONSTRAINT ck_audit_events__action CHECK (action IN (
    'ENTRY_CREATED', 'ENTRY_ACTIVATED', 'ENTRY_DEACTIVATED', 'LOCALE_REGISTERED', 'LOCALE_ACTIVATED', 'LOCALE_DEACTIVATED',
    'VERSION_DRAFTED', 'VERSION_SUBMITTED', 'VERSION_APPROVED', 'VERSION_REJECTED', 'VERSION_CANCELLED', 'VERSION_PUBLISHED', 'VERSION_ACTIVATED', 'VERSION_SUPERSEDED'
  )),
  -- locale actions name a locale and nothing else; entry actions name an entry only; version actions name an entry and one of its versions
  -- (and optionally the version it replaced). The locale of a version event is never repeated here: it is reached through the immutable version row.
  CONSTRAINT ck_audit_events__subject CHECK (
    (action LIKE 'LOCALE\_%' AND locale IS NOT NULL AND entry_id IS NULL AND version_id IS NULL AND previous_version_id IS NULL)
    OR (action LIKE 'ENTRY\_%' AND locale IS NULL AND entry_id IS NOT NULL AND version_id IS NULL AND previous_version_id IS NULL)
    OR (action LIKE 'VERSION\_%' AND locale IS NULL AND entry_id IS NOT NULL AND version_id IS NOT NULL)
  )
);
COMMENT ON TABLE content.audit_events IS 'Append-only audit trail of every content mutation: actor, content key (entry), locale (stored only for locale actions; for version actions it is reached through the immutable version, and the composite foreign keys tie the version to the entry of the same row), previous and new version, reason, time and correlation id. Bodies are never copied here.';
CREATE INDEX idx_audit_events__entry ON content.audit_events (entry_id, occurred_at DESC) WHERE entry_id IS NOT NULL;
CREATE INDEX idx_audit_events__version ON content.audit_events (version_id) WHERE version_id IS NOT NULL;

-- ------------------------------------------------------------------ guards (defense in depth: the database enforces immutability and the lifecycle itself)
CREATE FUNCTION content.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (% is not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER trg_entry_variables__immutable BEFORE UPDATE OR DELETE ON content.entry_variables FOR EACH ROW EXECUTE FUNCTION content.forbid_mutation();
CREATE TRIGGER trg_version_approvals__immutable BEFORE UPDATE OR DELETE ON content.version_approvals FOR EACH ROW EXECUTE FUNCTION content.forbid_mutation();
CREATE TRIGGER trg_snapshots__immutable BEFORE UPDATE OR DELETE ON content.snapshots FOR EACH ROW EXECUTE FUNCTION content.forbid_mutation();
CREATE TRIGGER trg_snapshot_items__immutable BEFORE UPDATE OR DELETE ON content.snapshot_items FOR EACH ROW EXECUTE FUNCTION content.forbid_mutation();
CREATE TRIGGER trg_audit_events__immutable BEFORE UPDATE OR DELETE ON content.audit_events FOR EACH ROW EXECUTE FUNCTION content.forbid_mutation();

CREATE FUNCTION content.guard_locales() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'locales cannot be deleted; deactivate them instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.locale <> OLD.locale OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'locale identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- exactly one platform default: the unique index forbids two, this forbids none. A migration that moves the default disables this trigger for its transaction.
  IF OLD.is_platform_default AND NOT NEW.is_platform_default THEN
    RAISE EXCEPTION 'the platform default locale cannot be unset' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_locales__guard BEFORE UPDATE OR DELETE ON content.locales FOR EACH ROW EXECUTE FUNCTION content.guard_locales();

CREATE FUNCTION content.guard_entries() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'entries cannot be deleted; deactivate them instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.entry_id, NEW.key, NEW.content_type, NEW.owner_role, NEW.description, NEW.sensitivity, NEW.criticality, NEW.approval_policy, NEW.fallback_policy, NEW.max_scope_type, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.entry_id, OLD.key, OLD.content_type, OLD.owner_role, OLD.description, OLD.sensitivity, OLD.criticality, OLD.approval_policy, OLD.fallback_policy, OLD.max_scope_type, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'entry identity and governance policy are immutable; only is_active can change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_entries__guard BEFORE UPDATE OR DELETE ON content.entries FOR EACH ROW EXECUTE FUNCTION content.guard_entries();

CREATE FUNCTION content.guard_entry_variables() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_required AND EXISTS (SELECT 1 FROM content.versions WHERE entry_id = NEW.entry_id) THEN
    RAISE EXCEPTION 'a required variable cannot be added once the entry has versions (existing copy would stop rendering)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_entry_variables__no_late_required BEFORE INSERT ON content.entry_variables FOR EACH ROW EXECUTE FUNCTION content.guard_entry_variables();

CREATE FUNCTION content.guard_versions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry content.entries%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'versions are immutable and cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO entry FROM content.entries WHERE entry_id = NEW.entry_id;
    IF NOT entry.is_active THEN
      RAISE EXCEPTION 'cannot add a version to an inactive entry' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'a version starts as DRAFT' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.approval_policy <> entry.approval_policy THEN
      RAISE EXCEPTION 'version approval policy must equal the entry policy at creation' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (SELECT rank FROM configuration.scope_levels WHERE scope_type = NEW.scope_type) > (SELECT rank FROM configuration.scope_levels WHERE scope_type = entry.max_scope_type) THEN
      RAISE EXCEPTION 'scope % is more specific than the entry allows (%)', NEW.scope_type, entry.max_scope_type USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.body_sha256 := encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex');
    RETURN NEW;
  END IF;

  -- UPDATE: identity and text never change
  IF (NEW.version_id, NEW.entry_id, NEW.locale, NEW.scope_type, NEW.scope_ref, NEW.version, NEW.body, NEW.body_sha256, NEW.approval_policy, NEW.reason, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.version_id, OLD.entry_id, OLD.locale, OLD.scope_type, OLD.scope_ref, OLD.version, OLD.body, OLD.body_sha256, OLD.approval_policy, OLD.reason, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'version content is immutable; corrections create a new version' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- lifecycle state machine
  IF NEW.status <> OLD.status THEN
    IF NOT (
         (OLD.status = 'DRAFT'     AND NEW.status IN ('IN_REVIEW', 'APPROVED', 'CANCELLED'))
      OR (OLD.status = 'IN_REVIEW' AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED'))
      OR (OLD.status = 'APPROVED'  AND NEW.status IN ('SCHEDULED', 'PUBLISHED', 'CANCELLED'))
      OR (OLD.status = 'SCHEDULED' AND NEW.status IN ('PUBLISHED', 'SUPERSEDED'))
      OR (OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED')) THEN
      RAISE EXCEPTION 'illegal version transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' AND NEW.approval_policy <> 'NONE' THEN
      RAISE EXCEPTION 'only versions whose policy is NONE skip review' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status = 'IN_REVIEW' AND NEW.status = 'APPROVED'
       AND NOT EXISTS (SELECT 1 FROM content.version_approvals WHERE version_id = NEW.version_id AND decision = 'APPROVE') THEN
      RAISE EXCEPTION 'approval requires a recorded APPROVE decision' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status = 'IN_REVIEW' AND NEW.status = 'REJECTED'
       AND NOT EXISTS (SELECT 1 FROM content.version_approvals WHERE version_id = NEW.version_id AND decision = 'REJECT') THEN
      RAISE EXCEPTION 'rejection requires a recorded REJECT decision' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  -- period: the start can only be raised, once, at publication; the end can only be closed, once, on a published version
  IF NEW.effective_from IS DISTINCT FROM OLD.effective_from
     AND NOT (OLD.status = 'APPROVED' AND NEW.status IN ('SCHEDULED', 'PUBLISHED') AND NEW.effective_from > OLD.effective_from) THEN
    RAISE EXCEPTION 'effective_from is immutable (it can only be raised when the version is published)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.effective_to IS DISTINCT FROM OLD.effective_to
     AND NOT (OLD.effective_to IS NULL AND NEW.effective_to IS NOT NULL AND OLD.status IN ('SCHEDULED', 'PUBLISHED')) THEN
    RAISE EXCEPTION 'effective_to can only be closed once, on a published version' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- history is never rewritten: an end can only be set at or after the start of the closing transaction (the service closes at the successor's start,
  -- which is never earlier). Truncated to milliseconds because the service computes instants with millisecond precision.
  IF NEW.effective_to IS DISTINCT FROM OLD.effective_to AND NEW.effective_to < date_trunc('milliseconds', now()) THEN
    RAISE EXCEPTION 'effective_to cannot be closed in the past; history is not rewritten' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_versions__guard BEFORE INSERT OR UPDATE OR DELETE ON content.versions FOR EACH ROW EXECUTE FUNCTION content.guard_versions();

CREATE FUNCTION content.guard_version_approvals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ver content.versions%ROWTYPE;
BEGIN
  SELECT * INTO ver FROM content.versions WHERE version_id = NEW.version_id;
  IF ver.status <> 'IN_REVIEW' THEN
    RAISE EXCEPTION 'decisions can only be recorded while the version is IN_REVIEW' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF ver.approval_policy = 'SECOND_APPROVER' AND NEW.decision = 'APPROVE' AND NEW.approver = ver.created_by THEN
    RAISE EXCEPTION 'the author cannot approve their own version when a second approver is required' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_version_approvals__guard BEFORE INSERT ON content.version_approvals FOR EACH ROW EXECUTE FUNCTION content.guard_version_approvals();
