-- Phase 9: background exports (PROD §15.2), the realtime event that says one changed, and the
-- retention job's access (SEC §16.5). Owner decisions 2026-11-02 (docs/DECISIONS.md, Phase 9).

-- ── Exports ──────────────────────────────────────────────────────────────────────────────────

create table export_jobs (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  requested_by uuid not null references users (id),
  kind text not null check (kind in (
    'ATTENDANCE', 'PATROLS', 'INCIDENTS', 'SITE_ACTIVITY', 'LOCATION_REPORT', 'LOCATION_HISTORY',
    'GUARD_DATA')),
  -- The request as validated (exportRequestSchema), without the reason (that is in the audit log).
  params jsonb not null,
  title text not null check (char_length(title) between 1 and 300),
  -- Location history inside: reading the file is location-history access (SEC §16.4).
  contains_location boolean not null,
  status text not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED')),
  row_count int check (row_count >= 0),
  size_bytes bigint check (size_bytes >= 0),
  object_key text check (char_length(object_key) <= 300),
  content_type text check (char_length(content_type) <= 100),
  file_name text check (char_length(file_name) <= 200),
  error_code text check (char_length(error_code) <= 60),
  attempts int not null default 0 check (attempts >= 0),
  created_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  -- The file is deleted then (7 days after it was ready).
  expires_at timestamptz,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (status <> 'READY' or (object_key is not null and expires_at is not null))
);
-- One export at a time per person (PROD §15.2).
create unique index export_jobs_one_running on export_jobs (organization_id, requested_by)
  where status in ('QUEUED', 'RUNNING');
create index export_jobs_org_created on export_jobs (organization_id, created_at desc);
alter table export_jobs enable row level security;
create policy export_jobs_tenant on export_jobs
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on export_jobs to app_runtime;

-- The export runner and the file cleaner find organizations with work as system_worker.
create policy export_jobs_system_sweep on export_jobs
  for select to system_worker
  using (status in ('QUEUED', 'RUNNING', 'READY'));
grant select (organization_id, status, created_at, started_at, expires_at) on export_jobs to system_worker;

alter table outbox drop constraint outbox_topic_check;
alter table outbox add constraint outbox_topic_check check (topic in (
  'guard.state', 'alert.opened', 'alert.updated', 'shift.updated', 'coverage.updated', 'sos.activated',
  'sos.updated', 'incident.created', 'incident.updated', 'export.updated'));
alter table realtime_events drop constraint realtime_events_type_check;
alter table realtime_events add constraint realtime_events_type_check check (type in (
  'guard.state', 'alert.opened', 'alert.updated', 'shift.updated', 'coverage.updated', 'sos.activated',
  'sos.updated', 'incident.created', 'incident.updated', 'export.updated'));

-- ── Retention (SEC §16.5) ────────────────────────────────────────────────────────────────────

-- The daily run starts at 03:00 in each organization's time zone (ARCH §16): the scheduler lists
-- organizations and their zones as system_worker, and nothing else about them.
create policy organizations_system_sweep on organizations
  for select to system_worker
  using (true);
grant select (id, timezone) on organizations to system_worker;

-- retention_worker works on one organization at a time: every policy below sees only the
-- organization its transaction names (app.current_org_id()), so a retention bug can't cross tenants.
-- It reads and deletes; it may clear only the position columns named below (owner decision 2:
-- positions on records follow the location period); the schema linter enforces both (ADV-X01).
do $$
declare
  t text;
begin
  foreach t in array array[
    'location_points', 'device_status_events', 'quarantined_items', 'shifts', 'shift_events',
    'shift_live_state', 'patrol_runs', 'checkpoint_visits', 'alerts', 'alert_events',
    'notification_deliveries', 'incidents', 'incident_events', 'incident_attachments', 'sos_events',
    'sos_presses', 'sos_drills', 'sos_drill_guards', 'sos_drill_members', 'export_jobs', 'audit_logs'
  ] loop
    execute format(
      'create policy %I on %I for all to retention_worker '
      'using (organization_id = app.current_org_id()) with check (organization_id = app.current_org_id())',
      t || '_retention', t);
    execute format('grant select, delete on %I to retention_worker', t);
  end loop;
end
$$;

-- The run's own record: one RETENTION_RUN row with counts only (SEC §16.5).
grant insert on audit_logs to retention_worker;

-- Its settings, read-only.
create policy organization_settings_retention on organization_settings
  for select to retention_worker
  using (organization_id = app.current_org_id());
grant select on organization_settings to retention_worker;

-- Positions on records, cleared after the location period; the records stay (owner decision 2).
grant update (start_latitude, start_longitude, end_latitude, end_longitude) on shifts to retention_worker;
grant update (last_fix_latitude, last_fix_longitude) on shift_live_state to retention_worker;
grant update (latitude, longitude) on checkpoint_visits to retention_worker;
