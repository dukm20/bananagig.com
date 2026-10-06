# Entity Relationship Diagram

Application-owned tables only. Update this file in any checkpoint that adds, removes or changes a table or foreign key (`pnpm data-model:check` additionally requires it when a foreign key in the schema snapshot changes).

```mermaid
erDiagram
  SCHEMA_MIGRATIONS {
    integer version PK
    text filename UK
    text checksum
    timestamptz applied_at
    integer duration_ms
  }
  OUTBOX_EVENTS {
    uuid outbox_event_id PK
    text aggregate_type
    text aggregate_id
    text event_type
    integer event_version
    text actor_type
    text actor_id
    jsonb payload_json
    text correlation_id
    text causation_id
    timestamptz created_at
    timestamptz next_attempt_at
    timestamptz published_at
    integer publish_attempts
    text last_error
  }
```

Neither table has relationships. `public.schema_migrations` is migration infrastructure. `integration.outbox_events` is intentionally domain-agnostic: `aggregate_type` and `aggregate_id` point at future domain tables by value, never by foreign key, so the outbox can serve every domain without coupling to them. Third-party schemas (`pgboss`, PostGIS) are omitted. Planned domain schemas appear here as their tables are created.
