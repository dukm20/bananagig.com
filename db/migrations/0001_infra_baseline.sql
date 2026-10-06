-- INF-001 baseline: infrastructure only, no business tables.
-- PostGIS is also enabled at container init; this keeps non-container environments consistent.
CREATE EXTENSION IF NOT EXISTS postgis;
-- pg-boss owns and creates the `pgboss` schema itself when the worker starts.
