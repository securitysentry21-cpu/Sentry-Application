-- 0003_guards_sites.sql
-- Phase 2: guards, their devices and mobile sessions (D-30, D-31), tracking consents, sites with a
-- circle or polygon boundary (D-38) and checkpoints with QR tokens (ARCH §11.1).

-- ── Guards ──────────────────────────────────────────────────────────────────────────────────
create table guards (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  user_id uuid references users (id),
  employee_number text not null check (char_length(employee_number) between 1 and 40),
  display_name text not null check (char_length(display_name) between 1 and 120),
  phone text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'TERMINATED')),
  preferred_locale text not null default 'en' check (preferred_locale in ('en', 'ur')),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_user_id uuid references users (id),
  updated_by_user_id uuid references users (id),
  unique (organization_id, id),
  unique (organization_id, employee_number)
);
-- A-04: a guard user belongs to one organization at a time.
create unique index guards_one_organization_per_user on guards (user_id)
  where user_id is not null and status <> 'TERMINATED';
-- One current guard per phone number within an organization (enrollment is bound to the number).
create unique index guards_phone_per_organization on guards (organization_id, phone)
  where status <> 'TERMINATED';
alter table guards enable row level security;
create policy guards_tenant on guards
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on guards to app_runtime;

-- Enrollment and new-phone codes point at their guard (Phase 1 left the column unconstrained).
alter table invitations
  add constraint invitations_guard_fk foreign key (organization_id, guard_id)
  references guards (organization_id, id);
alter table invitations
  add constraint invitations_guard_purpose check (
    purpose = 'MEMBER' or (guard_id is not null and phone is not null and code_hash is not null)
  );

-- Redeeming a code happens before any session exists: find the code's organization by its hash.
create function app.enrollment_by_code(p_code_hash bytea)
  returns table (id uuid, organization_id uuid)
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  as $$
    select i.id, i.organization_id from invitations i
     where i.code_hash = p_code_hash and i.purpose in ('GUARD_ENROLLMENT', 'NEW_DEVICE')
  $$;
revoke execute on function app.enrollment_by_code(bytea) from public;
grant execute on function app.enrollment_by_code(bytea) to app_runtime;

-- ── Devices (D-05, D-31) ────────────────────────────────────────────────────────────────────
create table guard_devices (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  guard_id uuid not null,
  installation_id uuid not null,
  public_key bytea not null check (octet_length(public_key) between 64 and 200),
  key_algorithm text not null check (key_algorithm = 'ECDSA_P256_SHA256'),
  platform text not null check (platform in ('IOS', 'ANDROID')),
  manufacturer text check (char_length(manufacturer) <= 120),
  model text check (char_length(model) <= 120),
  os_version text check (char_length(os_version) <= 40),
  app_version text check (char_length(app_version) <= 40),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED')),
  revoked_reason text check (revoked_reason in ('REPLACED', 'LOST', 'COMPROMISED', 'ADMIN')),
  revoked_at timestamptz,
  revoked_by_user_id uuid references users (id),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, installation_id),
  foreign key (organization_id, guard_id) references guards (organization_id, id),
  check ((status = 'ACTIVE') = (revoked_at is null))
);
-- D-05: one ACTIVE device per guard.
create unique index guard_devices_one_active on guard_devices (guard_id) where status = 'ACTIVE';
alter table guard_devices enable row level security;
create policy guard_devices_tenant on guard_devices
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on guard_devices to app_runtime;

-- ── Mobile sessions (D-30, ARCH §5.3) ───────────────────────────────────────────────────────
-- One row per rotation. Presenting a refresh token whose row was already rotated revokes the whole
-- family. Only SHA-256 hashes of the tokens are stored.
create table mobile_sessions (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  guard_id uuid not null,
  device_id uuid not null,
  family_id uuid not null,
  access_token_hash bytea not null unique,
  access_expires_at timestamptz not null,
  refresh_token_hash bytea not null unique,
  expires_at timestamptz not null,
  issued_at timestamptz not null,
  last_used_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason in ('ROTATION_REUSE', 'DEVICE_REVOKED', 'GUARD_DISABLED', 'SIGNED_OUT')),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, guard_id) references guards (organization_id, id),
  foreign key (organization_id, device_id) references guard_devices (organization_id, id)
);
create index mobile_sessions_family on mobile_sessions (family_id);
create index mobile_sessions_device on mobile_sessions (device_id) where revoked_at is null;
alter table mobile_sessions enable row level security;
create policy mobile_sessions_tenant on mobile_sessions
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on mobile_sessions to app_runtime;

-- A bearer token identifies its session before any organization context exists; these return the
-- organization of the one row matching a 256-bit token's hash, and nothing else.
create function app.mobile_session_by_access(p_hash bytea)
  returns table (id uuid, organization_id uuid)
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  as $$ select s.id, s.organization_id from mobile_sessions s where s.access_token_hash = p_hash $$;
create function app.mobile_session_by_refresh(p_hash bytea)
  returns table (id uuid, organization_id uuid)
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  as $$ select s.id, s.organization_id from mobile_sessions s where s.refresh_token_hash = p_hash $$;
revoke execute on function app.mobile_session_by_access(bytea) from public;
revoke execute on function app.mobile_session_by_refresh(bytea) from public;
grant execute on function app.mobile_session_by_access(bytea) to app_runtime;
grant execute on function app.mobile_session_by_refresh(bytea) to app_runtime;

-- ── Tracking consents (append-only, SEC §16.3) ──────────────────────────────────────────────
create table tracking_consents (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  guard_id uuid not null,
  user_id uuid references users (id),
  device_id uuid not null,
  disclosure_version text not null check (char_length(disclosure_version) between 1 and 40),
  locale text not null check (locale in ('en', 'ur')),
  accepted_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, guard_id) references guards (organization_id, id),
  foreign key (organization_id, device_id) references guard_devices (organization_id, id)
);
alter table tracking_consents enable row level security;
create policy tracking_consents_tenant on tracking_consents
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert on tracking_consents to app_runtime;

-- ── Sites (D-38: circle or polygon) ─────────────────────────────────────────────────────────
create table sites (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  name text not null check (char_length(name) between 1 and 120),
  client_name text check (char_length(client_name) <= 120),
  address_line_1 text check (char_length(address_line_1) <= 200),
  address_line_2 text check (char_length(address_line_2) <= 200),
  city text check (char_length(city) <= 120),
  country text not null default 'PK' check (country ~ '^[A-Z]{2}$'),
  timezone text not null check (char_length(timezone) between 1 and 64),
  boundary_kind text not null check (boundary_kind in ('CIRCLE', 'POLYGON')),
  -- The circle's centre, or the polygon's centroid (the map pin).
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  geofence_radius_meters int check (geofence_radius_meters between 50 and 5000),
  -- [{"lat": …, "lng": …}, …], validated by packages/domain/geo before it is written.
  polygon jsonb,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  notes text check (char_length(notes) <= 4000),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_user_id uuid references users (id),
  updated_by_user_id uuid references users (id),
  unique (organization_id, id),
  check (
    (boundary_kind = 'CIRCLE' and geofence_radius_meters is not null and polygon is null)
    or (boundary_kind = 'POLYGON' and polygon is not null and jsonb_typeof(polygon) = 'array'
        and jsonb_array_length(polygon) between 3 and 200)
  )
);
alter table sites enable row level security;
create policy sites_tenant on sites
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on sites to app_runtime;

-- ── Checkpoints (ARCH §11.1) ────────────────────────────────────────────────────────────────
create table checkpoints (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  site_id uuid not null,
  name text not null check (char_length(name) between 1 and 120),
  description text check (char_length(description) <= 4000),
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  verification_radius_meters int not null default 30 check (verification_radius_meters between 10 and 500),
  -- SHA-256 of the derived token; the token itself is never stored.
  qr_token_hash bytea not null unique,
  qr_token_version int not null default 1 check (qr_token_version >= 1),
  qr_rotated_at timestamptz,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_user_id uuid references users (id),
  updated_by_user_id uuid references users (id),
  unique (organization_id, id),
  unique (organization_id, site_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  check ((latitude is null) = (longitude is null))
);
alter table checkpoints enable row level security;
create policy checkpoints_tenant on checkpoints
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on checkpoints to app_runtime;

-- A scanned token identifies its checkpoint; a token from another organization must answer exactly
-- like an unknown one (ADV-T08), so the scan path looks it up by hash first, then checks the tenant.
create function app.checkpoint_by_token(p_hash bytea)
  returns table (id uuid, organization_id uuid)
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  as $$ select c.id, c.organization_id from checkpoints c where c.qr_token_hash = p_hash $$;
revoke execute on function app.checkpoint_by_token(bytea) from public;
grant execute on function app.checkpoint_by_token(bytea) to app_runtime;
