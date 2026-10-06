-- checkpoint: CFG-001
-- purpose: create the configuration schema: typed parameter definitions, scoped effective-dated immutable values, change requests with approvals, immutable snapshots and an audit trail
-- rollback strategy: forward-fix only; the schema holds no data until parameters are created, so locally `pnpm stack:reset` is sufficient
-- backfill: none (new objects); scope_levels is structural reference data seeded here (the canonical scope hierarchy), not business values
-- risk: low; new schema and tables only. Enables the btree_gist extension (extension-owned) which the no-overlap exclusion constraint needs

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA configuration;
COMMENT ON SCHEMA configuration IS 'Application-owned: product configuration registry (typed parameters, scoped effective-dated values, change workflow, snapshots). Not runtime/infrastructure config (env) and not feature flags (flagd).';

-- ------------------------------------------------------------------ scope hierarchy (reference data)
CREATE TABLE configuration.scope_levels (
  scope_type text     NOT NULL,
  rank       smallint NOT NULL,
  CONSTRAINT pk_scope_levels PRIMARY KEY (scope_type),
  CONSTRAINT uq_scope_levels__rank UNIQUE (rank),
  CONSTRAINT ck_scope_levels__scope_type_format CHECK (scope_type ~ '^[A-Z][A-Z_]*$'),
  CONSTRAINT ck_scope_levels__rank_nonnegative CHECK (rank >= 0)
);
COMMENT ON TABLE configuration.scope_levels IS 'Canonical scope hierarchy; a higher rank is more specific and wins at resolution. Structural reference data, changed only by migration.';
INSERT INTO configuration.scope_levels (scope_type, rank) VALUES
  ('PLATFORM', 0), ('COUNTRY', 1), ('MARKET', 2), ('CATEGORY', 3), ('PLAN', 4), ('PROVIDER', 5), ('GIG', 6), ('DROP', 7);

-- ------------------------------------------------------------------ parameter definitions
CREATE TABLE configuration.parameters (
  parameter_id     uuid        NOT NULL DEFAULT gen_random_uuid(),
  key              text        NOT NULL,
  data_type        text        NOT NULL,
  unit             text,
  description      text        NOT NULL,
  owner_role       text        NOT NULL,
  validation_rules jsonb       NOT NULL DEFAULT '{}'::jsonb,
  sensitivity      text        NOT NULL DEFAULT 'INTERNAL',
  approval_policy  text        NOT NULL,
  criticality      text        NOT NULL DEFAULT 'STANDARD',
  is_required      boolean     NOT NULL DEFAULT true,
  is_active        boolean     NOT NULL DEFAULT true,
  created_by       text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_parameters PRIMARY KEY (parameter_id),
  CONSTRAINT uq_parameters__key UNIQUE (key),
  CONSTRAINT ck_parameters__key_format CHECK (key ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*)+$' AND length(key) <= 120),
  CONSTRAINT ck_parameters__data_type CHECK (data_type IN ('STRING', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'ENUM', 'DURATION', 'MONEY', 'JSON')),
  CONSTRAINT ck_parameters__sensitivity CHECK (sensitivity IN ('PUBLIC', 'INTERNAL', 'SENSITIVE')),
  CONSTRAINT ck_parameters__approval_policy CHECK (approval_policy IN ('NONE', 'OWNER_APPROVAL', 'SECOND_APPROVER')),
  CONSTRAINT ck_parameters__criticality CHECK (criticality IN ('STANDARD', 'CRITICAL')),
  CONSTRAINT ck_parameters__validation_rules_object CHECK (jsonb_typeof(validation_rules) = 'object'),
  CONSTRAINT ck_parameters__description_not_blank CHECK (length(btrim(description)) > 0),
  CONSTRAINT ck_parameters__owner_role_format CHECK (owner_role ~ '^[a-z][a-z0-9_-]*$')
);
COMMENT ON TABLE configuration.parameters IS 'Typed definition of one configuration parameter. There is deliberately no default_value column: the PLATFORM-scope value is the default, so a second default would be duplicated data.';
COMMENT ON COLUMN configuration.parameters.validation_rules IS 'Type-specific validation metadata (min/max, enum values, pattern, currencies, JSON schema). Interpreted and enforced by the service; kept as one JSON object because its shape depends on data_type.';
COMMENT ON COLUMN configuration.parameters.criticality IS 'CRITICAL parameters are never served from stale or last-known-good data; STANDARD parameters may fall back to last-known-good when the database is unreachable.';

CREATE TABLE configuration.parameter_scopes (
  parameter_id uuid NOT NULL,
  scope_type   text NOT NULL,
  CONSTRAINT pk_parameter_scopes PRIMARY KEY (parameter_id, scope_type),
  CONSTRAINT fk_parameter_scopes__parameter_id FOREIGN KEY (parameter_id) REFERENCES configuration.parameters (parameter_id) ON DELETE RESTRICT,
  CONSTRAINT fk_parameter_scopes__scope_type FOREIGN KEY (scope_type) REFERENCES configuration.scope_levels (scope_type) ON DELETE RESTRICT
);
COMMENT ON TABLE configuration.parameter_scopes IS 'Scope levels at which a parameter may hold a value (allowed overrides). PLATFORM is always present, inserted with the parameter by the service.';

-- ------------------------------------------------------------------ scoped value holders and immutable versions
CREATE TABLE configuration.parameter_values (
  parameter_value_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  parameter_id       uuid        NOT NULL,
  scope_type         text        NOT NULL,
  scope_ref          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_parameter_values PRIMARY KEY (parameter_value_id),
  CONSTRAINT fk_parameter_values__parameter_scope FOREIGN KEY (parameter_id, scope_type) REFERENCES configuration.parameter_scopes (parameter_id, scope_type) ON DELETE RESTRICT,
  CONSTRAINT uq_parameter_values__parameter_scope_ref UNIQUE NULLS NOT DISTINCT (parameter_id, scope_type, scope_ref),
  CONSTRAINT ck_parameter_values__platform_has_no_ref CHECK ((scope_type = 'PLATFORM') = (scope_ref IS NULL)),
  CONSTRAINT ck_parameter_values__scope_ref_format CHECK (scope_ref IS NULL OR scope_ref ~ '^[A-Za-z0-9._:-]{1,200}$')
);
COMMENT ON TABLE configuration.parameter_values IS 'One holder per (parameter, scope level, scope reference). scope_ref is an opaque domain reference (uuid or code) with NO foreign key: domain tables do not exist yet and the registry must not depend on them. The composite foreign key enforces that the scope level is allowed for the parameter.';

CREATE TABLE configuration.value_versions (
  version_id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  parameter_value_id uuid        NOT NULL,
  version            integer     NOT NULL,
  value              jsonb       NOT NULL,
  effective_from     timestamptz NOT NULL,
  effective_to       timestamptz,
  reason             text        NOT NULL,
  created_by         text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_value_versions PRIMARY KEY (version_id),
  CONSTRAINT fk_value_versions__parameter_value_id FOREIGN KEY (parameter_value_id) REFERENCES configuration.parameter_values (parameter_value_id) ON DELETE RESTRICT,
  CONSTRAINT uq_value_versions__parameter_value_version UNIQUE (parameter_value_id, version),
  CONSTRAINT ck_value_versions__version_positive CHECK (version > 0),
  CONSTRAINT ck_value_versions__effective_range CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT ck_value_versions__reason_not_blank CHECK (length(btrim(reason)) > 0),
  CONSTRAINT ex_value_versions__no_overlap EXCLUDE USING gist (parameter_value_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&)
);
COMMENT ON TABLE configuration.value_versions IS 'Immutable published values. Half-open validity [effective_from, effective_to). The only permitted change to a row is closing an open-ended version once (effective_to NULL -> value) when its successor is published; the exclusion constraint makes overlapping periods impossible per holder.';
COMMENT ON COLUMN configuration.value_versions.value IS 'Canonical JSON encoding of the typed value (see docs/engineering/CONFIGURATION.md). Validated against the parameter definition by the service before insert.';

-- Resolution: candidate versions of a holder by time.
CREATE INDEX idx_value_versions__holder_effective ON configuration.value_versions (parameter_value_id, effective_from DESC);

-- ------------------------------------------------------------------ change workflow
CREATE TABLE configuration.change_requests (
  change_request_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  parameter_id      uuid        NOT NULL,
  scope_type        text        NOT NULL,
  scope_ref         text,
  proposed_value    jsonb       NOT NULL,
  effective_from    timestamptz NOT NULL,
  effective_to      timestamptz,
  reason            text        NOT NULL,
  requested_by      text        NOT NULL,
  approval_policy   text        NOT NULL,
  state             text        NOT NULL DEFAULT 'DRAFT',
  value_version_id  uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_change_requests PRIMARY KEY (change_request_id),
  CONSTRAINT fk_change_requests__parameter_scope FOREIGN KEY (parameter_id, scope_type) REFERENCES configuration.parameter_scopes (parameter_id, scope_type) ON DELETE RESTRICT,
  CONSTRAINT fk_change_requests__value_version_id FOREIGN KEY (value_version_id) REFERENCES configuration.value_versions (version_id) ON DELETE RESTRICT,
  CONSTRAINT uq_change_requests__value_version_id UNIQUE (value_version_id),
  CONSTRAINT ck_change_requests__state CHECK (state IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'ACTIVE', 'REJECTED', 'SUPERSEDED', 'CANCELLED')),
  CONSTRAINT ck_change_requests__approval_policy CHECK (approval_policy IN ('NONE', 'OWNER_APPROVAL', 'SECOND_APPROVER')),
  CONSTRAINT ck_change_requests__effective_range CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT ck_change_requests__platform_has_no_ref CHECK ((scope_type = 'PLATFORM') = (scope_ref IS NULL)),
  CONSTRAINT ck_change_requests__scope_ref_format CHECK (scope_ref IS NULL OR scope_ref ~ '^[A-Za-z0-9._:-]{1,200}$'),
  CONSTRAINT ck_change_requests__reason_not_blank CHECK (length(btrim(reason)) > 0),
  CONSTRAINT ck_change_requests__published_has_version CHECK ((state IN ('SCHEDULED', 'ACTIVE', 'SUPERSEDED')) = (value_version_id IS NOT NULL))
);
COMMENT ON TABLE configuration.change_requests IS 'A proposed change to one (parameter, scope). approval_policy is a deliberate copy of the parameter policy at request time (the policy that governed THIS request must not change retroactively). Content is frozen once the request leaves DRAFT.';

CREATE INDEX idx_change_requests__pending ON configuration.change_requests (created_at) WHERE state = 'PENDING_APPROVAL';
CREATE INDEX idx_change_requests__scheduled ON configuration.change_requests (effective_from) WHERE state = 'SCHEDULED';
CREATE INDEX idx_change_requests__parameter ON configuration.change_requests (parameter_id, created_at DESC);

CREATE TABLE configuration.change_approvals (
  approval_id       uuid        NOT NULL DEFAULT gen_random_uuid(),
  change_request_id uuid        NOT NULL,
  approver          text        NOT NULL,
  decision          text        NOT NULL,
  comment           text,
  decided_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_change_approvals PRIMARY KEY (approval_id),
  CONSTRAINT fk_change_approvals__change_request_id FOREIGN KEY (change_request_id) REFERENCES configuration.change_requests (change_request_id) ON DELETE RESTRICT,
  CONSTRAINT uq_change_approvals__request_approver UNIQUE (change_request_id, approver),
  CONSTRAINT ck_change_approvals__decision CHECK (decision IN ('APPROVE', 'REJECT'))
);
COMMENT ON TABLE configuration.change_approvals IS 'Immutable approval decisions. One decision per approver per request. A trigger forbids the requester from approving their own request when the SECOND_APPROVER policy applies.';

-- ------------------------------------------------------------------ snapshots
CREATE TABLE configuration.snapshots (
  snapshot_id  uuid        NOT NULL DEFAULT gen_random_uuid(),
  evaluated_at timestamptz NOT NULL,
  context      jsonb       NOT NULL,
  purpose      text        NOT NULL,
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_snapshots PRIMARY KEY (snapshot_id),
  CONSTRAINT ck_snapshots__context_object CHECK (jsonb_typeof(context) = 'object'),
  CONSTRAINT ck_snapshots__purpose_not_blank CHECK (length(btrim(purpose)) > 0)
);
COMMENT ON TABLE configuration.snapshots IS 'Immutable record of a resolution: the context and evaluation time used. context is a copy of an input kept as one JSON object because it is only ever read back whole.';

CREATE TABLE configuration.snapshot_items (
  snapshot_id  uuid NOT NULL,
  parameter_id uuid NOT NULL,
  version_id   uuid NOT NULL,
  CONSTRAINT pk_snapshot_items PRIMARY KEY (snapshot_id, parameter_id),
  CONSTRAINT fk_snapshot_items__snapshot_id FOREIGN KEY (snapshot_id) REFERENCES configuration.snapshots (snapshot_id) ON DELETE RESTRICT,
  CONSTRAINT fk_snapshot_items__parameter_id FOREIGN KEY (parameter_id) REFERENCES configuration.parameters (parameter_id) ON DELETE RESTRICT,
  CONSTRAINT fk_snapshot_items__version_id FOREIGN KEY (version_id) REFERENCES configuration.value_versions (version_id) ON DELETE RESTRICT
);
COMMENT ON TABLE configuration.snapshot_items IS 'The exact version of each resolved parameter. version_id points at an IMMUTABLE row that can never be deleted or rewritten, so value, scope, version and effective_from are fixed; the pointer is therefore equivalent to a stored copy without duplicating data. Not a pointer to "current" configuration.';

-- ------------------------------------------------------------------ audit
CREATE TABLE configuration.audit_events (
  audit_event_id    uuid        NOT NULL DEFAULT gen_random_uuid(),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  actor             text        NOT NULL,
  action            text        NOT NULL,
  parameter_id      uuid        NOT NULL,
  change_request_id uuid,
  old_version_id    uuid,
  new_version_id    uuid,
  reason            text,
  correlation_id    text        NOT NULL,
  CONSTRAINT pk_audit_events PRIMARY KEY (audit_event_id),
  CONSTRAINT fk_audit_events__parameter_id FOREIGN KEY (parameter_id) REFERENCES configuration.parameters (parameter_id) ON DELETE RESTRICT,
  CONSTRAINT fk_audit_events__change_request_id FOREIGN KEY (change_request_id) REFERENCES configuration.change_requests (change_request_id) ON DELETE RESTRICT,
  CONSTRAINT fk_audit_events__old_version_id FOREIGN KEY (old_version_id) REFERENCES configuration.value_versions (version_id) ON DELETE RESTRICT,
  CONSTRAINT fk_audit_events__new_version_id FOREIGN KEY (new_version_id) REFERENCES configuration.value_versions (version_id) ON DELETE RESTRICT,
  CONSTRAINT ck_audit_events__action CHECK (action IN ('PARAMETER_CREATED', 'CHANGE_DRAFTED', 'CHANGE_SUBMITTED', 'CHANGE_APPROVED', 'CHANGE_REJECTED', 'CHANGE_CANCELLED', 'CHANGE_PUBLISHED', 'CHANGE_ACTIVATED', 'CHANGE_SUPERSEDED'))
);
COMMENT ON TABLE configuration.audit_events IS 'Append-only audit trail of every configuration mutation. Scope and values are reached through change_request_id and the version ids, so sensitive values are never copied here.';

CREATE INDEX idx_audit_events__parameter ON configuration.audit_events (parameter_id, occurred_at DESC);
CREATE INDEX idx_audit_events__change_request ON configuration.audit_events (change_request_id) WHERE change_request_id IS NOT NULL;

-- ------------------------------------------------------------------ guards (defense in depth: the database enforces immutability itself)
CREATE FUNCTION configuration.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (% is not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER trg_change_approvals__immutable BEFORE UPDATE OR DELETE ON configuration.change_approvals FOR EACH ROW EXECUTE FUNCTION configuration.forbid_mutation();
CREATE TRIGGER trg_snapshots__immutable BEFORE UPDATE OR DELETE ON configuration.snapshots FOR EACH ROW EXECUTE FUNCTION configuration.forbid_mutation();
CREATE TRIGGER trg_snapshot_items__immutable BEFORE UPDATE OR DELETE ON configuration.snapshot_items FOR EACH ROW EXECUTE FUNCTION configuration.forbid_mutation();
CREATE TRIGGER trg_audit_events__immutable BEFORE UPDATE OR DELETE ON configuration.audit_events FOR EACH ROW EXECUTE FUNCTION configuration.forbid_mutation();

CREATE FUNCTION configuration.guard_value_versions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'value_versions rows are immutable and cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- The single permitted change: close an open-ended version exactly once.
  IF OLD.effective_to IS NULL AND NEW.effective_to IS NOT NULL
     AND NEW.version_id = OLD.version_id AND NEW.parameter_value_id = OLD.parameter_value_id AND NEW.version = OLD.version
     AND NEW.value = OLD.value AND NEW.effective_from = OLD.effective_from AND NEW.reason = OLD.reason
     AND NEW.created_by = OLD.created_by AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'value_versions rows are immutable; corrections create a new version' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER trg_value_versions__guard BEFORE UPDATE OR DELETE ON configuration.value_versions FOR EACH ROW EXECUTE FUNCTION configuration.guard_value_versions();

CREATE FUNCTION configuration.guard_parameters() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'parameters cannot be deleted; deactivate them instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.parameter_id <> OLD.parameter_id OR NEW.key <> OLD.key OR NEW.data_type <> OLD.data_type OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'parameter identity (id, key, data_type) is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_parameters__guard BEFORE UPDATE OR DELETE ON configuration.parameters FOR EACH ROW EXECUTE FUNCTION configuration.guard_parameters();

CREATE FUNCTION configuration.guard_change_requests() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'change_requests cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state <> 'DRAFT' AND (NEW.parameter_id, NEW.scope_type, NEW.scope_ref, NEW.proposed_value, NEW.effective_from, NEW.effective_to, NEW.reason, NEW.requested_by, NEW.approval_policy)
     IS DISTINCT FROM (OLD.parameter_id, OLD.scope_type, OLD.scope_ref, OLD.proposed_value, OLD.effective_from, OLD.effective_to, OLD.reason, OLD.requested_by, OLD.approval_policy) THEN
    RAISE EXCEPTION 'change request content is frozen once it leaves DRAFT' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'DRAFT'            AND NEW.state IN ('PENDING_APPROVAL', 'APPROVED', 'CANCELLED'))
    OR (OLD.state = 'PENDING_APPROVAL' AND NEW.state IN ('APPROVED', 'REJECTED', 'CANCELLED'))
    OR (OLD.state = 'APPROVED'         AND NEW.state IN ('SCHEDULED', 'ACTIVE', 'CANCELLED'))
    OR (OLD.state = 'SCHEDULED'        AND NEW.state IN ('ACTIVE', 'SUPERSEDED'))
    OR (OLD.state = 'ACTIVE'           AND NEW.state = 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'illegal change request transition % -> %', OLD.state, NEW.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_change_requests__guard BEFORE UPDATE OR DELETE ON configuration.change_requests FOR EACH ROW EXECUTE FUNCTION configuration.guard_change_requests();

CREATE FUNCTION configuration.guard_change_approvals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  req configuration.change_requests%ROWTYPE;
BEGIN
  SELECT * INTO req FROM configuration.change_requests WHERE change_request_id = NEW.change_request_id;
  IF req.approval_policy = 'SECOND_APPROVER' AND NEW.decision = 'APPROVE' AND NEW.approver = req.requested_by THEN
    RAISE EXCEPTION 'the requester cannot approve their own change when a second approver is required' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_change_approvals__no_self_approval BEFORE INSERT ON configuration.change_approvals FOR EACH ROW EXECUTE FUNCTION configuration.guard_change_approvals();
