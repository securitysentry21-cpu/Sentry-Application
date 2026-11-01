-- 0007_realtime.sql
-- Phase 6: the transactional outbox (ARCH §16.1), the realtime replay buffer (ARCH §14) and the
-- open dashboard streams that monitoring coverage counts (PROD §11.5).

-- Side effects written in the same transaction as the change that causes them. Payloads hold IDs
-- only: no coordinates, names or text.
create table outbox (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  -- Insertion order: changes made in the same millisecond keep the order they were made in.
  position bigint generated always as identity,
  topic text not null check (topic in (
    'guard.state', 'alert.opened', 'alert.updated', 'shift.updated', 'coverage.updated')),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts int not null default 0 check (attempts >= 0),
  unique (organization_id, id)
);
create index outbox_pending on outbox (organization_id, position) where processed_at is null;
create index outbox_processed on outbox (organization_id, processed_at) where processed_at is not null;
alter table outbox enable row level security;
create policy outbox_tenant on outbox
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update, delete on outbox to app_runtime;

-- The dispatcher (ARCH §16.2) finds organizations with pending rows as system_worker; it moves
-- each organization's rows as app_runtime, inside that organization's tenant context.
create policy outbox_system_sweep on outbox
  for select to system_worker
  using (processed_at is null);
grant select (organization_id, processed_at) on outbox to system_worker;

-- The replay buffer. The sequence is assigned after commit, by the dispatcher, under a lock per
-- organization (ARCH §14). Pruned to 5 minutes or 10,000 events per organization, always keeping
-- the newest, so the sequence never restarts.
create table realtime_events (
  id uuid not null,
  organization_id uuid not null references organizations (id),
  seq bigint not null check (seq > 0),
  type text not null check (type in (
    'guard.state', 'alert.opened', 'alert.updated', 'shift.updated', 'coverage.updated')),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  primary key (organization_id, seq),
  unique (organization_id, id)
);
create index realtime_events_created on realtime_events (organization_id, created_at);
alter table realtime_events enable row level security;
create policy realtime_events_tenant on realtime_events
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, delete on realtime_events to app_runtime;

-- One row per open dashboard stream (PROD §11.5: how many dashboards are watching, on desktops and
-- phones). Each API instance touches its rows every 30 s; a row not seen for 90 s belongs to an
-- instance that stopped and no longer counts.
create table stream_connections (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  user_id uuid not null references users (id),
  client text not null check (client in ('DESKTOP', 'PHONE')),
  instance_id text not null check (char_length(instance_id) between 1 and 100),
  connected_at timestamptz not null,
  last_seen_at timestamptz not null,
  unique (organization_id, id)
);
create index stream_connections_org on stream_connections (organization_id, last_seen_at);
alter table stream_connections enable row level security;
create policy stream_connections_tenant on stream_connections
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update, delete on stream_connections to app_runtime;

-- The dispatcher also finds rows left by a stopped instance, then removes them per organization.
create policy stream_connections_system_sweep on stream_connections
  for select to system_worker
  using (true);
grant select (organization_id, last_seen_at) on stream_connections to system_worker;
