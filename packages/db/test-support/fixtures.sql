-- Test-only fixture tables for the RLS proof of concept (Phase 0). They follow the exact pattern
-- every real tenant table must follow: organization_id NOT NULL, UNIQUE (organization_id, id),
-- composite foreign keys, RLS enabled with policies reading app.current_org_id(), and grants.

create table fixture_sites (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  name text not null,
  unique (organization_id, id)
);
alter table fixture_sites enable row level security;
create policy fixture_sites_tenant on fixture_sites for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on fixture_sites to app_runtime;

-- A child table: the composite key makes the database reject a note in organization A that
-- points at a site in organization B (INV-13, ADV-T04).
create table fixture_site_notes (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  site_id uuid not null,
  body text not null,
  unique (organization_id, id),
  foreign key (organization_id, site_id) references fixture_sites (organization_id, id)
);
alter table fixture_site_notes enable row level security;
create policy fixture_site_notes_tenant on fixture_site_notes for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on fixture_site_notes to app_runtime;

-- An append-only table: the runtime role can insert and read, never update or delete (INV-05).
create table fixture_events (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  site_id uuid not null,
  kind text not null,
  unique (organization_id, id),
  foreign key (organization_id, site_id) references fixture_sites (organization_id, id)
);
alter table fixture_events enable row level security;
create policy fixture_events_read on fixture_events for select to app_runtime
  using (organization_id = app.current_org_id());
create policy fixture_events_insert on fixture_events for insert to app_runtime
  with check (organization_id = app.current_org_id());
grant select, insert on fixture_events to app_runtime;
