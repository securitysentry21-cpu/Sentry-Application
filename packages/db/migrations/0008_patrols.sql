-- 0008_patrols.sql
-- Phase 7: patrol routes, the runs a shift must walk (D-16: per shift), and checkpoint visits
-- (PROD §9, ARCH §6.3, §11).

-- An ordered set of checkpoints at one site: on demand, or every interval_minutes with a completion
-- window no longer than the interval, so a route's runs never overlap (PROD §9.2).
create table patrol_routes (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  site_id uuid not null,
  name text not null check (char_length(name) between 1 and 120),
  description text check (char_length(description) <= 4000),
  enforce_order boolean not null default false,
  -- null: on demand; scans are recorded and nothing is ever missed.
  interval_minutes int check (interval_minutes between 10 and 720),
  first_run_offset_minutes int not null default 0 check (first_run_offset_minutes between 0 and 720),
  completion_window_minutes int check (completion_window_minutes between 5 and 720),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_user_id uuid references users (id),
  updated_by_user_id uuid references users (id),
  unique (organization_id, id),
  unique (organization_id, site_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  check ((interval_minutes is null) = (completion_window_minutes is null)),
  check (completion_window_minutes is null or completion_window_minutes <= interval_minutes)
);
create index patrol_routes_site on patrol_routes (organization_id, site_id);
alter table patrol_routes enable row level security;
create policy patrol_routes_tenant on patrol_routes
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on patrol_routes to app_runtime;

-- The route's checkpoints in order. Both keys carry the site, so the database refuses a route and
-- a checkpoint of different sites or organizations (INV-13, ADV-T04). The list is replaced as a
-- whole when the route is edited. A checkpoint in at most one scheduled route is a service rule.
create table patrol_route_checkpoints (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  site_id uuid not null,
  patrol_route_id uuid not null,
  checkpoint_id uuid not null,
  sequence int not null check (sequence between 1 and 200),
  required boolean not null default true,
  unique (organization_id, id),
  unique (patrol_route_id, sequence),
  unique (patrol_route_id, checkpoint_id),
  foreign key (organization_id, site_id, patrol_route_id)
    references patrol_routes (organization_id, site_id, id),
  foreign key (organization_id, site_id, checkpoint_id)
    references checkpoints (organization_id, site_id, id)
);
create index patrol_route_checkpoints_checkpoint on patrol_route_checkpoints (checkpoint_id);
alter table patrol_route_checkpoints enable row level security;
create policy patrol_route_checkpoints_tenant on patrol_route_checkpoints
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, delete on patrol_route_checkpoints to app_runtime;

-- One required round of a route inside a shift: due at actual start + offset + k·interval, closing
-- at due + window (PROD §9.2). Future runs are replaced when the shift is extended or the route
-- changes; a run that is due can't hold scans yet, so nothing recorded is lost.
create table patrol_runs (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  shift_id uuid not null,
  guard_id uuid not null,
  site_id uuid not null,
  patrol_route_id uuid not null,
  sequence_no int not null check (sequence_no >= 1),
  due_at timestamptz not null,
  window_ends_at timestamptz not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'INCOMPLETE', 'MISSED', 'CANCELLED')),
  started_at timestamptz,
  completed_at timestamptz,
  closed_at timestamptz,
  required_count int not null check (required_count >= 0),
  counted_count int not null default 0 check (counted_count >= 0),
  unconfirmed_count int not null default 0 check (unconfirmed_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (shift_id, patrol_route_id, sequence_no),
  foreign key (organization_id, shift_id) references shifts (organization_id, id),
  foreign key (organization_id, guard_id) references guards (organization_id, id),
  foreign key (organization_id, site_id, patrol_route_id)
    references patrol_routes (organization_id, site_id, id),
  check (window_ends_at > due_at),
  check (unconfirmed_count <= counted_count),
  check ((status = 'COMPLETED') = (completed_at is not null))
);
create index patrol_runs_shift on patrol_runs (shift_id, due_at);
create index patrol_runs_site_due on patrol_runs (organization_id, site_id, due_at);
create index patrol_runs_guard_due on patrol_runs (organization_id, guard_id, due_at);
create index patrol_runs_open on patrol_runs (window_ends_at) where status in ('PENDING', 'IN_PROGRESS');
alter table patrol_runs enable row level security;
create policy patrol_runs_tenant on patrol_runs
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update, delete on patrol_runs to app_runtime;

-- The run closer (ARCH §16.2) finds organizations with runs past their window as system_worker; it
-- closes each organization's runs as app_runtime, inside that organization's tenant context.
create policy patrol_runs_system_sweep on patrol_runs
  for select to system_worker
  using (status in ('PENDING', 'IN_PROGRESS'));
grant select (organization_id, status, window_ends_at) on patrol_runs to system_worker;

-- One scan and its result (ARCH §11.2). Append-only (INV-05). The scanned token is never stored.
create table checkpoint_visits (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  guard_id uuid not null,
  -- The shift whose window holds the scan; null when there is none (NO_ACTIVE_SHIFT).
  shift_id uuid,
  -- Null exactly when the label was not one of this organization's active checkpoints.
  checkpoint_id uuid,
  patrol_route_id uuid,
  patrol_run_id uuid,
  device_id uuid not null,
  client_event_id uuid not null,
  -- The phone's own clock, kept as evidence (INV-07); scanned_at is the server's estimate.
  scanned_at_recorded timestamptz not null,
  scanned_at timestamptz not null,
  received_at timestamptz not null,
  clock_status text not null check (clock_status in ('VERIFIED_MONOTONIC', 'DEVICE_CLOCK_ONLY', 'SKEWED')),
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  accuracy_m double precision check (accuracy_m > 0 and accuracy_m <= 50000),
  fix_age_s double precision check (fix_age_s >= 0),
  distance_m int check (distance_m >= 0),
  -- Outside a shift only a band is kept, never a distance or coordinates (SEC §16.1, INV-08).
  distance_band text check (distance_band in ('0-50', '50-100', '100-250', '250-500', '500-1000', '1000+')),
  is_mock boolean,
  verification_status text not null check (verification_status in (
    'VERIFIED', 'LOCATION_UNCONFIRMED', 'OUTSIDE_RADIUS', 'WRONG_SITE', 'INVALID_QR', 'NO_ACTIVE_SHIFT',
    'DUPLICATE')),
  verification_reason text check (char_length(verification_reason) <= 60),
  flags text[] not null default '{}',
  counted boolean not null default false,
  qr_token_version int check (qr_token_version >= 1),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, guard_id) references guards (organization_id, id),
  foreign key (organization_id, shift_id) references shifts (organization_id, id),
  foreign key (organization_id, checkpoint_id) references checkpoints (organization_id, id),
  foreign key (organization_id, patrol_route_id) references patrol_routes (organization_id, id),
  foreign key (organization_id, patrol_run_id) references patrol_runs (organization_id, id),
  foreign key (organization_id, device_id) references guard_devices (organization_id, id),
  check (scanned_at <= received_at),
  check ((latitude is null) = (longitude is null)),
  check ((checkpoint_id is null) = (verification_status = 'INVALID_QR')),
  -- INV-08: coordinates and distances only inside an active shift window.
  check (shift_id is not null or (latitude is null and distance_m is null)),
  check (verification_status <> 'NO_ACTIVE_SHIFT' or shift_id is null),
  check (shift_id is not null or verification_status in ('NO_ACTIVE_SHIFT', 'INVALID_QR')),
  check (not counted or verification_status in ('VERIFIED', 'LOCATION_UNCONFIRMED')),
  check (patrol_run_id is null or patrol_route_id is not null)
);
-- INV-06: a resubmitted scan never creates a second row.
create unique index checkpoint_visits_idempotency on checkpoint_visits (device_id, client_event_id);
create index checkpoint_visits_shift on checkpoint_visits (shift_id, scanned_at);
create index checkpoint_visits_run on checkpoint_visits (patrol_run_id) where patrol_run_id is not null;
create index checkpoint_visits_checkpoint on checkpoint_visits (checkpoint_id, scanned_at);
create index checkpoint_visits_guard_received on checkpoint_visits (organization_id, guard_id, received_at);
alter table checkpoint_visits enable row level security;
create policy checkpoint_visits_tenant on checkpoint_visits
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert on checkpoint_visits to app_runtime;
