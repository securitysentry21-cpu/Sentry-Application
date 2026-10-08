-- 0006_alerts.sql
-- Phase 5: alerts and their history (ARCH §6.3, §13.2), and the geofence evaluator's memory on the
-- live state (ARCH §10).

create table alerts (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  type text not null check (type in (
    'SOS_ACTIVATED', 'INCIDENT_CRITICAL', 'INCIDENT_HIGH', 'GUARD_LEFT_SITE', 'TRACKING_DISABLED',
    'DEVICE_OFFLINE', 'LOCATION_STALE', 'SHIFT_NOT_STARTED', 'SHIFT_MISSED', 'CHECKPOINT_MISSED',
    'SUSPICIOUS_LOCATION', 'STARTED_OFF_SITE', 'SHIFT_OVERRUN', 'LOW_BATTERY', 'DEVICE_CHANGED')),
  severity text not null check (severity in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  status text not null default 'OPEN' check (status in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED')),
  -- One open alert per condition and subject, e.g. left_site:{shiftId} (ARCH §13.2).
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  -- Server-generated plain text; never incident text, phone numbers or coordinates.
  summary text not null check (char_length(summary) between 1 and 300),
  guard_id uuid,
  site_id uuid,
  shift_id uuid,
  details jsonb not null default '{}',
  opened_at timestamptz not null,
  last_triggered_at timestamptz not null,
  trigger_count int not null default 1 check (trigger_count >= 1),
  acknowledged_by uuid references users (id),
  acknowledged_at timestamptz,
  resolved_by uuid references users (id), -- null when the system resolved it
  resolved_at timestamptz,
  resolution_type text check (resolution_type in ('MANUAL', 'CONDITION_CLEARED', 'SHIFT_ENDED', 'SUPERSEDED')),
  resolution_note text check (char_length(resolution_note) <= 1000),
  dismissed_by uuid references users (id),
  dismissed_at timestamptz,
  dismiss_reason text check (char_length(dismiss_reason) <= 1000),
  escalation_level int not null default 0,
  next_escalation_at timestamptz,
  detected_late boolean not null default false,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, guard_id) references guards (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, shift_id) references shifts (organization_id, id),
  check ((status = 'RESOLVED') = (resolved_at is not null and resolution_type is not null)),
  check ((status = 'DISMISSED') = (dismissed_at is not null and dismiss_reason is not null)),
  check (status <> 'ACKNOWLEDGED' or acknowledged_at is not null),
  -- PROD §12.2: SOS and critical incidents are resolved by a person, never dismissed.
  check (not (type in ('SOS_ACTIVATED', 'INCIDENT_CRITICAL') and status = 'DISMISSED'))
);
create unique index alerts_open_dedupe on alerts (organization_id, dedupe_key)
  where status in ('OPEN', 'ACKNOWLEDGED');
create index alerts_org_status on alerts (organization_id, status, opened_at desc);
create index alerts_recent_by_key on alerts (organization_id, dedupe_key, resolved_at desc);
create index alerts_shift on alerts (shift_id) where shift_id is not null;
alter table alerts enable row level security;
create policy alerts_tenant on alerts
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on alerts to app_runtime;

create table alert_events (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  alert_id uuid not null,
  type text not null check (type in (
    'OPENED', 'RETRIGGERED', 'REOPENED', 'ACKNOWLEDGED', 'ESCALATED', 'NOTIFIED', 'SEEN', 'RESOLVED',
    'AUTO_RESOLVED', 'DISMISSED', 'NOTE')),
  actor_type text not null check (actor_type in ('USER', 'SYSTEM')),
  actor_user_id uuid references users (id),
  note text check (char_length(note) <= 1000),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, alert_id) references alerts (organization_id, id)
);
create index alert_events_alert on alert_events (alert_id, created_at);
alter table alert_events enable row level security;
create policy alert_events_tenant on alert_events
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
-- Append-only (INV-05).
grant select, insert on alert_events to app_runtime;

-- Device reports per shift, newest first (condition episodes for TRACKING_DISABLED and LOW_BATTERY).
create index device_status_events_shift on device_status_events (shift_id, recorded_at);

-- The geofence evaluator's memory (packages/domain geofence.ts). It reads the shift's points in
-- capture order after the watermark; a point captured before the watermark arrived late and is
-- shown in history but never re-evaluated.
alter table shift_live_state
  add column geofence_outside_since timestamptz,
  add column geofence_outside_points int not null default 0,
  add column geofence_inside_streak int not null default 0,
  add column geofence_watermark_at timestamptz;
