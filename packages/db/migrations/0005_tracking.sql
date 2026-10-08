-- 0005_tracking.sql
-- Phase 4 core: location points and device status (append-only, idempotent per device and client
-- event), the live-state projection, and quarantined sync items (ARCH §6.3, §9).

create table location_points (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  guard_id uuid not null,
  shift_id uuid,
  device_id uuid not null,
  client_event_id uuid not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy_m double precision check (accuracy_m > 0 and accuracy_m <= 50000),
  altitude_m double precision check (altitude_m between -500 and 10000),
  speed_mps double precision check (speed_mps >= 0),
  heading_deg double precision check (heading_deg >= 0 and heading_deg < 360),
  -- The phone's own clock, kept as evidence and never overwritten (INV-07).
  recorded_at timestamptz not null,
  -- The server's estimate of when the fix was captured (ARCH §8.7); history is ordered by it.
  captured_at timestamptz not null,
  received_at timestamptz not null,
  clock_status text not null check (clock_status in ('VERIFIED_MONOTONIC', 'DEVICE_CLOCK_ONLY', 'SKEWED')),
  source text not null check (source in ('TRACKING', 'SHIFT_START', 'SHIFT_END', 'CHECKPOINT', 'INCIDENT', 'SOS')),
  provider text check (provider in ('GPS', 'NETWORK', 'FUSED', 'UNKNOWN')),
  is_mock boolean,
  flags text[] not null default '{}',
  app_version text check (char_length(app_version) <= 40),
  sync_batch_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, guard_id) references guards (organization_id, id),
  foreign key (organization_id, shift_id) references shifts (organization_id, id),
  foreign key (organization_id, device_id) references guard_devices (organization_id, id),
  check (captured_at <= received_at)
);
-- INV-06: a resubmitted event never creates a second row.
create unique index location_points_idempotency on location_points (device_id, client_event_id);
create index location_points_guard_time on location_points (organization_id, guard_id, captured_at);
create index location_points_shift_time on location_points (shift_id, captured_at);
alter table location_points enable row level security;
create policy location_points_tenant on location_points
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
-- Append-only (INV-05): only the retention worker deletes, through its own policy (Phase 9).
grant select, insert on location_points to app_runtime;

create table device_status_events (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  guard_id uuid not null,
  device_id uuid not null,
  shift_id uuid,
  client_event_id uuid not null,
  recorded_at timestamptz not null,
  received_at timestamptz not null,
  location_permission text not null
    check (location_permission in ('ALWAYS', 'WHEN_IN_USE', 'DENIED', 'RESTRICTED', 'NOT_DETERMINED')),
  precise_location boolean not null,
  location_services_enabled boolean not null,
  notifications_enabled boolean,
  battery_pct double precision check (battery_pct between 0 and 100),
  is_charging boolean,
  power_save_mode boolean,
  battery_optimization_exempt boolean,
  auto_time_enabled boolean,
  tracking_service_state text not null check (tracking_service_state in ('RUNNING', 'STOPPED', 'PERMISSION_PROBLEM', 'UNKNOWN')),
  app_version text check (char_length(app_version) <= 40),
  os_version text check (char_length(os_version) <= 40),
  pending_queue_count int check (pending_queue_count >= 0),
  oldest_pending_at timestamptz,
  last_successful_sync_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, guard_id) references guards (organization_id, id),
  foreign key (organization_id, device_id) references guard_devices (organization_id, id),
  foreign key (organization_id, shift_id) references shifts (organization_id, id)
);
create unique index device_status_events_idempotency on device_status_events (device_id, client_event_id);
alter table device_status_events enable row level security;
create policy device_status_events_tenant on device_status_events
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert on device_status_events to app_runtime;

-- A projection, never the source of truth: rebuildable from points, status and shift events.
-- `id` is the shift's id. Updates only ever move it forward in time (ARCH §9.4).
create table shift_live_state (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  guard_id uuid not null,
  site_id uuid not null,
  last_fix_latitude double precision check (last_fix_latitude between -90 and 90),
  last_fix_longitude double precision check (last_fix_longitude between -180 and 180),
  last_fix_accuracy_m double precision,
  last_fix_captured_at timestamptz,
  last_fix_point_id uuid,
  last_contact_at timestamptz,
  geofence_state text not null default 'UNKNOWN'
    check (geofence_state in ('INSIDE', 'UNCERTAIN', 'OUTSIDE_SUSPECTED', 'OUTSIDE_CONFIRMED', 'UNKNOWN')),
  tracking_service_state text not null default 'UNKNOWN'
    check (tracking_service_state in ('RUNNING', 'STOPPED', 'PERMISSION_PROBLEM', 'UNKNOWN')),
  location_permission text,
  battery_pct double precision,
  is_charging boolean,
  app_version text,
  pending_queue_count int,
  oldest_pending_at timestamptz,
  device_report_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, id) references shifts (organization_id, id),
  foreign key (organization_id, guard_id) references guards (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id)
);
create index shift_live_state_org on shift_live_state (organization_id);
alter table shift_live_state enable row level security;
create policy shift_live_state_tenant on shift_live_state
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on shift_live_state to app_runtime;

-- A sync item that hit an unexpected server error is kept for operator replay instead of failing
-- the whole batch (ARCH §9.3, ADV-O09). Short retention.
create table quarantined_items (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  device_id uuid not null,
  batch_id uuid not null,
  client_event_id text not null check (char_length(client_event_id) <= 64),
  item jsonb not null,
  error_code text not null check (char_length(error_code) <= 64),
  created_at timestamptz not null default now(),
  replayed_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, device_id) references guard_devices (organization_id, id)
);
create index quarantined_items_open on quarantined_items (created_at) where replayed_at is null;
alter table quarantined_items enable row level security;
create policy quarantined_items_tenant on quarantined_items
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert on quarantined_items to app_runtime;
