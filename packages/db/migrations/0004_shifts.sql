-- 0004_shifts.sql
-- Phase 3: shifts and their append-only event log (PROD §6, ARCH §7).

create table shifts (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  guard_id uuid not null,
  site_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  start_deadline_at timestamptz not null,
  status text not null default 'SCHEDULED'
    check (status in ('SCHEDULED', 'ACTIVE', 'COMPLETED', 'MISSED', 'CANCELLED')),
  actual_started_at timestamptz,
  actual_ended_at timestamptz,
  start_source text check (start_source in ('APP_ONLINE', 'APP_OFFLINE_SYNCED', 'SUPERVISOR_MANUAL')),
  -- The start fix is inside the shift window by definition, so storing it is allowed (INV-08).
  start_latitude double precision check (start_latitude between -90 and 90),
  start_longitude double precision check (start_longitude between -180 and 180),
  start_accuracy_m double precision check (start_accuracy_m > 0),
  start_distance_m double precision,
  start_geofence_class text check (start_geofence_class in ('INSIDE', 'OUTSIDE', 'UNCERTAIN', 'NO_FIX')),
  start_device_id uuid,
  start_flags text[] not null default '{}',
  end_reason text check (end_reason in ('GUARD', 'GUARD_OFFLINE_SYNCED', 'SUPERVISOR_FORCE_END', 'AUTO_TIMEOUT', 'GUARD_DISABLED')),
  end_latitude double precision check (end_latitude between -90 and 90),
  end_longitude double precision check (end_longitude between -180 and 180),
  end_accuracy_m double precision check (end_accuracy_m > 0),
  cancelled_reason text check (char_length(cancelled_reason) <= 500),
  notes text check (char_length(notes) <= 4000),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_user_id uuid references users (id),
  updated_by_user_id uuid references users (id),
  unique (organization_id, id),
  foreign key (organization_id, guard_id) references guards (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, start_device_id) references guard_devices (organization_id, id),
  check (ends_at > starts_at and ends_at - starts_at <= interval '24 hours'),
  -- PROD §6.1: no overlapping shifts for one guard, cancelled ones excepted.
  exclude using gist (guard_id with =, tstzrange(starts_at, ends_at) with &&) where (status <> 'CANCELLED')
);
create index shifts_org_starts on shifts (organization_id, starts_at);
create index shifts_guard_starts on shifts (guard_id, starts_at);
create index shifts_open on shifts (organization_id, status, starts_at) where status in ('SCHEDULED', 'ACTIVE');
alter table shifts enable row level security;
create policy shifts_tenant on shifts
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on shifts to app_runtime;

-- Detectors (ARCH §4.5, §16.2): the cross-organization sweep only enumerates due work. It reads
-- IDs and times as system_worker; every change is then made per organization as app_runtime.
create policy shifts_system_sweep on shifts
  for select to system_worker
  using (status in ('SCHEDULED', 'ACTIVE'));
grant select (id, organization_id, status, starts_at, ends_at, start_deadline_at) on shifts to system_worker;

create table shift_events (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  shift_id uuid not null,
  type text not null check (type in (
    'CREATED', 'UPDATED', 'REASSIGNED', 'CANCELLED', 'STARTED', 'START_REJECTED', 'ENDED', 'AUTO_ENDED',
    'FORCE_ENDED', 'EXTENDED', 'MARKED_MISSED', 'REOPENED', 'ENTERED_SITE', 'LEFT_SITE',
    'TRACKING_DEGRADED', 'TRACKING_RESTORED')),
  actor_type text not null check (actor_type in ('GUARD', 'USER', 'SYSTEM')),
  actor_user_id uuid references users (id),
  device_id uuid,
  client_event_id uuid,
  occurred_at timestamptz not null,
  client_recorded_at timestamptz,
  -- START_REJECTED payloads hold no coordinates (INV-08).
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, shift_id) references shifts (organization_id, id),
  foreign key (organization_id, device_id) references guard_devices (organization_id, id)
);
create unique index shift_events_idempotency on shift_events (shift_id, client_event_id)
  where client_event_id is not null;
create index shift_events_shift on shift_events (shift_id, occurred_at);
alter table shift_events enable row level security;
create policy shift_events_tenant on shift_events
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert on shift_events to app_runtime;
