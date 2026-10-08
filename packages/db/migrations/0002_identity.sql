-- 0002_identity.sql
-- Phase 1: users, memberships, invitations, settings, the audit log and dashboard sessions.

-- ── Organizations ──────────────────────────────────────────────────────────────────────────
-- The operator CLI creates an organization as app_runtime inside that organization's own context
-- (D-19), so creation goes through RLS like everything else.
create policy organizations_runtime_insert on organizations
  for insert to app_runtime
  with check (id = app.current_org_id());
create policy organizations_runtime_update on organizations
  for update to app_runtime
  using (id = app.current_org_id())
  with check (id = app.current_org_id());
grant insert, update on organizations to app_runtime;

-- ── Users ───────────────────────────────────────────────────────────────────────────────────
-- Global within a cell (ARCH §6.3): one person may belong to several organizations. No RLS
-- (DECISIONS: Phase 1); reached only through services by ID, email or provider subject, never
-- listed globally (SEC §4.5).
create table users (
  id uuid primary key,
  auth_provider_user_id text unique check (char_length(auth_provider_user_id) between 1 and 255),
  email citext unique check (char_length(email) between 3 and 254),
  phone text unique check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  name text not null check (char_length(name) between 1 and 120),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
  locale text not null default 'en' check (locale in ('en', 'ur')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email is not null or phone is not null)
);
grant select, insert, update on users to app_runtime;

-- ── Memberships ─────────────────────────────────────────────────────────────────────────────
create table organization_members (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  user_id uuid not null references users (id),
  role text not null check (role in ('OWNER', 'ADMIN', 'SUPERVISOR', 'DISPATCHER', 'GUARD')),
  status text not null check (status in ('INVITED', 'ACTIVE', 'DISABLED', 'REMOVED')),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, user_id)
);
create index organization_members_user on organization_members (user_id);
alter table organization_members enable row level security;
create policy organization_members_tenant on organization_members
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on organization_members to app_runtime;

-- Before an organization is chosen, the request context needs the signed-in user's ACTIVE
-- memberships across organizations (ARCH §4.1). This narrow lookup returns only that user's rows;
-- it cannot list anyone else's. Owned by migrator, so it reads past RLS by design.
create function app.user_memberships(p_user_id uuid)
  returns table (
    organization_id uuid,
    organization_name text,
    organization_status text,
    organization_timezone text,
    member_id uuid,
    role text
  )
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  as $$
    select m.organization_id, o.name, o.status, o.timezone, m.id, m.role
      from organization_members m
      join organizations o on o.id = m.organization_id
     where m.user_id = p_user_id
       and m.status = 'ACTIVE'
     order by o.name, m.organization_id
  $$;
revoke execute on function app.user_memberships(uuid) from public;
grant execute on function app.user_memberships(uuid) to app_runtime;

-- ── Invitations (member invitations now; guard enrollment and new-phone codes in Phase 2) ──
create table invitations (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  purpose text not null check (purpose in ('MEMBER', 'GUARD_ENROLLMENT', 'NEW_DEVICE')),
  role text check (role in ('OWNER', 'ADMIN', 'SUPERVISOR', 'DISPATCHER', 'GUARD')),
  email citext check (char_length(email) between 3 and 254),
  phone text check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  guard_id uuid,
  -- SHA-256 of the ≥128-bit link token; the token itself is shown once and never stored (SEC §5).
  token_hash bytea not null unique,
  -- SHA-256 of the short typed code, for guard enrollment; rate-limited by `attempts` (SEC §9).
  code_hash bytea unique,
  attempts int not null default 0 check (attempts >= 0),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by_user_id uuid references users (id),
  revoked_at timestamptz,
  revoked_by_user_id uuid references users (id),
  created_by_user_id uuid references users (id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  check (purpose <> 'MEMBER' or (email is not null and role is not null and role <> 'GUARD'))
);
alter table invitations enable row level security;
create policy invitations_tenant on invitations
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on invitations to app_runtime;

-- Accepting an invitation happens before the user belongs to the organization. The link token is
-- the authorization, so this lookup finds the invitation's organization from the token's hash and
-- nothing else; without a 128-bit token there is nothing to find.
create function app.invitation_by_token(p_token_hash bytea)
  returns table (id uuid, organization_id uuid)
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  as $$ select i.id, i.organization_id from invitations i where i.token_hash = p_token_hash $$;
revoke execute on function app.invitation_by_token(bytea) from public;
grant execute on function app.invitation_by_token(bytea) to app_runtime;

-- ── Settings ────────────────────────────────────────────────────────────────────────────────
-- Holds the organization's overrides only; defaults come from packages/contracts, so changing a
-- default needs no migration. The merged result is validated on every write (PROD §8.3).
create table organization_settings (
  id uuid primary key,
  organization_id uuid not null unique references organizations (id),
  overrides jsonb not null default '{}',
  schema_version int not null default 1,
  version int not null default 1,
  updated_by_user_id uuid references users (id),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
alter table organization_settings enable row level security;
create policy organization_settings_tenant on organization_settings
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on organization_settings to app_runtime;

-- ── Audit log (append-only, SEC §17) ────────────────────────────────────────────────────────
create table audit_logs (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  actor_type text not null check (actor_type in ('USER', 'SYSTEM', 'PLATFORM_OPERATOR')),
  actor_user_id uuid references users (id),
  action text not null check (action ~ '^[A-Z][A-Z_]{2,63}$'),
  resource_type text not null check (resource_type ~ '^[a-z][a-z_]{1,63}$'),
  resource_id uuid,
  reason text check (char_length(reason) <= 500),
  request_id text check (char_length(request_id) <= 64),
  ip_address inet,
  user_agent text check (char_length(user_agent) <= 500),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);
create index audit_logs_org_created on audit_logs (organization_id, created_at desc, id desc);
create index audit_logs_org_resource on audit_logs (organization_id, resource_type, resource_id);
alter table audit_logs enable row level security;
create policy audit_logs_tenant on audit_logs
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
-- INSERT and SELECT only: audit records are never rewritten (INV-05).
grant select, insert on audit_logs to app_runtime;

-- ── Dashboard sessions (ARCH §5.2) ──────────────────────────────────────────────────────────
-- Our own server-side session, issued after the identity provider signs the user in. The cookie
-- carries a random token; only its SHA-256 is stored.
create table dashboard_sessions (
  id uuid primary key,
  user_id uuid not null references users (id),
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason in ('SIGNED_OUT', 'USER_DISABLED', 'ADMIN')),
  ip_address inet,
  user_agent text check (char_length(user_agent) <= 500)
);
create index dashboard_sessions_user on dashboard_sessions (user_id) where revoked_at is null;
grant select, insert, update on dashboard_sessions to app_runtime;

-- OIDC sign-in state (state, nonce, PKCE verifier) between the redirect and the callback.
create table auth_states (
  id uuid primary key,
  state_hash bytea not null unique,
  nonce text not null check (char_length(nonce) between 16 and 128),
  code_verifier text not null check (char_length(code_verifier) between 43 and 128),
  -- Local paths only: never an open redirect.
  return_to text not null check (return_to ~ '^/([^/\\].*)?$' and char_length(return_to) <= 512),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on auth_states to app_runtime;
