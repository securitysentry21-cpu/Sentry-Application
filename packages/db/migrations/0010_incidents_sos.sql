-- 0010_incidents_sos.sql
-- Phase 8: incidents and their photos (PROD §10, ARCH §12), SOS and drills (PROD §11, ARCH §13.1),
-- notification deliveries and Web Push subscriptions (ARCH §13.4), and what they need elsewhere.

-- ── Organizations and members ────────────────────────────────────────────────────────────────
-- Demo and canary organizations treat every SOS as a drill, so a store reviewer or the synthetic
-- canary never pages a real person (PROD §17, ARCH §18.4, ADV-S10). Set by the operator.
alter table organizations
  add column kind text not null default 'CUSTOMER' check (kind in ('CUSTOMER', 'DEMO', 'CANARY'));

-- Where a member's SOS texts go (owner decision 2026-11-02). Entered by an Owner or Administrator
-- and audited; kept on the membership, not the user, so one organization can never redirect another
-- organization's texts to a person who belongs to both.
alter table organization_members
  add column alert_phone text check (alert_phone ~ '^\+[1-9][0-9]{6,14}$');

-- The guard phone's Firebase token (D-26). One per device; replaced when the phone reports a new one.
alter table guard_devices
  add column push_token text check (char_length(push_token) between 20 and 4096),
  add column push_token_updated_at timestamptz;

-- An SOS signed with the device key arrives without a session (INV-15, ADV-S11): find the device's
-- organization and public key by its id, and nothing else.
create function app.device_for_signature(p_device_id uuid)
  returns table (
    organization_id uuid,
    guard_id uuid,
    public_key bytea,
    key_algorithm text,
    status text,
    revoked_reason text,
    revoked_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  as $$
    select d.organization_id, d.guard_id, d.public_key, d.key_algorithm, d.status, d.revoked_reason,
           d.revoked_at
      from guard_devices d
     where d.id = p_device_id
  $$;
revoke execute on function app.device_for_signature(uuid) from public;
grant execute on function app.device_for_signature(uuid) to app_runtime;

-- ── Drills (PROD §11.10) ─────────────────────────────────────────────────────────────────────
-- A drill window names the guards whose SOS is a drill and the members it may reach (ADV-S10).
-- Any other guard's SOS during the window is real.
create table sos_drills (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  started_by_user_id uuid not null references users (id),
  started_at timestamptz not null,
  ends_at timestamptz not null,
  ended_by_user_id uuid references users (id),
  ended_at timestamptz,
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (ends_at > started_at and ends_at <= started_at + interval '4 hours'),
  check (ended_at is null or ended_at >= started_at)
);
create index sos_drills_recent on sos_drills (organization_id, started_at desc);
alter table sos_drills enable row level security;
create policy sos_drills_tenant on sos_drills
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on sos_drills to app_runtime;

create table sos_drill_guards (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  drill_id uuid not null,
  guard_id uuid not null,
  unique (organization_id, id),
  unique (drill_id, guard_id),
  foreign key (organization_id, drill_id) references sos_drills (organization_id, id),
  foreign key (organization_id, guard_id) references guards (organization_id, id)
);
create index sos_drill_guards_guard on sos_drill_guards (guard_id);
alter table sos_drill_guards enable row level security;
create policy sos_drill_guards_tenant on sos_drill_guards
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert on sos_drill_guards to app_runtime;

create table sos_drill_members (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  drill_id uuid not null,
  member_id uuid not null,
  unique (organization_id, id),
  unique (drill_id, member_id),
  foreign key (organization_id, drill_id) references sos_drills (organization_id, id),
  foreign key (organization_id, member_id) references organization_members (organization_id, id)
);
alter table sos_drill_members enable row level security;
create policy sos_drill_members_tenant on sos_drill_members
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert on sos_drill_members to app_runtime;

-- ── SOS (ARCH §6.3, §13.1) ───────────────────────────────────────────────────────────────────
create table sos_events (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  guard_id uuid not null,
  -- The shift whose window holds the first press; null for an off-shift SOS (PROD §11.1).
  shift_id uuid,
  site_id uuid,
  device_id uuid not null,
  client_event_id uuid not null,
  -- The phone's own clock, kept as evidence (INV-07); activated_at is the server's estimate.
  activated_at_recorded timestamptz not null,
  activated_at timestamptz not null,
  received_at timestamptz not null,
  clock_status text not null check (clock_status in ('VERIFIED_MONOTONIC', 'DEVICE_CLOCK_ONLY', 'SKEWED')),
  -- The newest SOS position; the trail is in location_points.
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  accuracy_m double precision check (accuracy_m > 0 and accuracy_m <= 50000),
  location_captured_at timestamptz,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED')),
  trigger_count int not null default 1 check (trigger_count >= 1),
  last_triggered_at timestamptz not null,
  -- "I'm safe / false alarm" annotates; it never resolves the SOS or stops escalation (PROD §11.8).
  guard_cancel_requested_at timestamptz,
  -- INV-10: a provider accepted a push or SMS (ALERT_SENT); a person's device showed it (NOTIFIED).
  alert_sent_at timestamptz,
  notified_at timestamptz,
  acknowledged_by uuid references users (id),
  acknowledged_at timestamptz,
  resolved_by uuid references users (id),
  resolved_at timestamptz,
  resolution text check (resolution in ('GENUINE', 'FALSE_ALARM', 'ACCIDENTAL', 'DRILL', 'OTHER')),
  resolution_note text check (char_length(resolution_note) between 1 and 1000),
  is_drill boolean not null default false,
  drill_id uuid,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, guard_id) references guards (organization_id, id),
  foreign key (organization_id, shift_id) references shifts (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, device_id) references guard_devices (organization_id, id),
  foreign key (organization_id, drill_id) references sos_drills (organization_id, id),
  check (activated_at <= received_at),
  check ((latitude is null) = (longitude is null)),
  check ((latitude is null) = (location_captured_at is null)),
  check ((status = 'RESOLVED') = (resolved_at is not null and resolution is not null and resolution_note is not null)),
  check (status <> 'ACKNOWLEDGED' or acknowledged_at is not null),
  check (drill_id is null or is_drill)
);
-- One open SOS per guard (PROD §11.9); pressing again re-triggers it.
create unique index sos_events_one_open on sos_events (guard_id) where status in ('ACTIVE', 'ACKNOWLEDGED');
create unique index sos_events_idempotency on sos_events (device_id, client_event_id);
create index sos_events_org_received on sos_events (organization_id, received_at desc);
alter table sos_events enable row level security;
create policy sos_events_tenant on sos_events
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on sos_events to app_runtime;

-- The operator's "SOS unacknowledged for 10 minutes" check (ARCH §18.4) runs across organizations.
create policy sos_events_system_sweep on sos_events
  for select to system_worker
  using (status = 'ACTIVE');
grant select (organization_id, status, received_at, is_drill) on sos_events to system_worker;

-- Every press, the first and each one after (INV-06): a retried request never counts twice.
create table sos_presses (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  sos_event_id uuid not null,
  guard_id uuid not null,
  device_id uuid not null,
  client_event_id uuid not null,
  pressed_at_recorded timestamptz not null,
  pressed_at timestamptz not null,
  received_at timestamptz not null,
  auth text not null check (auth in ('SESSION', 'DEVICE_SIGNATURE')),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, sos_event_id) references sos_events (organization_id, id),
  foreign key (organization_id, guard_id) references guards (organization_id, id),
  foreign key (organization_id, device_id) references guard_devices (organization_id, id),
  check (pressed_at <= received_at)
);
create unique index sos_presses_idempotency on sos_presses (device_id, client_event_id);
create index sos_presses_sos on sos_presses (sos_event_id, received_at);
alter table sos_presses enable row level security;
create policy sos_presses_tenant on sos_presses
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert on sos_presses to app_runtime;

-- SOS tracking (PROD §11.2): points of an open SOS carry it, with or without a shift. INV-08: a
-- point belongs to a shift window or to an open SOS, nothing else.
alter table location_points
  add column sos_event_id uuid,
  add constraint location_points_sos_fk foreign key (organization_id, sos_event_id)
    references sos_events (organization_id, id),
  add constraint location_points_shift_or_sos check (shift_id is not null or sos_event_id is not null);
create index location_points_sos_time on location_points (sos_event_id, captured_at) where sos_event_id is not null;

-- ── Incidents (PROD §10, ARCH §6.3) ──────────────────────────────────────────────────────────
-- Reference numbers per organization (INC-000123), one row per organization, taken under its lock.
create table incident_counters (
  id uuid primary key,
  organization_id uuid not null unique references organizations (id),
  next_value int not null default 1 check (next_value >= 1),
  unique (organization_id, id)
);
alter table incident_counters enable row level security;
create policy incident_counters_tenant on incident_counters
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on incident_counters to app_runtime;

create table incidents (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  reference_number int not null check (reference_number >= 1),
  -- Exactly one reporter: a guard through the app, or a dashboard user.
  guard_id uuid,
  reported_by_user_id uuid references users (id),
  -- Derived by the server from the guard's shift or open SOS, never trusted from the phone (PROD §10.1).
  shift_id uuid,
  sos_event_id uuid,
  site_id uuid,
  checkpoint_id uuid,
  type text not null check (type in (
    'THEFT', 'INTRUSION', 'FIRE', 'MEDICAL', 'PROPERTY_DAMAGE', 'ALTERCATION', 'SUSPICIOUS_ACTIVITY', 'OTHER')),
  severity text not null check (severity in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 4000),
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  accuracy_m double precision check (accuracy_m > 0 and accuracy_m <= 50000),
  fix_age_s double precision check (fix_age_s >= 0),
  is_mock boolean,
  occurred_at timestamptz not null,
  -- When it was filed: the server's estimate (INV-07), and the phone's own clock as evidence.
  reported_at timestamptz not null,
  reported_at_recorded timestamptz,
  received_at timestamptz not null,
  status text not null default 'OPEN' check (status in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  acknowledged_by uuid references users (id),
  acknowledged_at timestamptz,
  resolved_by uuid references users (id),
  resolved_at timestamptz,
  resolution_note text check (char_length(resolution_note) between 1 and 4000),
  is_drill boolean not null default false,
  device_id uuid,
  client_event_id uuid,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, reference_number),
  foreign key (organization_id, guard_id) references guards (organization_id, id),
  foreign key (organization_id, shift_id) references shifts (organization_id, id),
  foreign key (organization_id, sos_event_id) references sos_events (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, checkpoint_id) references checkpoints (organization_id, id),
  foreign key (organization_id, device_id) references guard_devices (organization_id, id),
  check ((guard_id is null) <> (reported_by_user_id is null)),
  -- INV-08: guards file incidents only during a shift or an open SOS, and coordinates exist only then.
  check (guard_id is null or shift_id is not null or sos_event_id is not null),
  check (latitude is null or shift_id is not null or sos_event_id is not null),
  check ((latitude is null) = (longitude is null)),
  check (received_at >= reported_at),
  -- Set back at most 24 hours, never after it was filed (PROD §10.1).
  check (occurred_at <= reported_at and occurred_at >= reported_at - interval '24 hours'),
  check ((status = 'RESOLVED') = (resolved_at is not null and resolution_note is not null)),
  check (status = 'OPEN' or acknowledged_at is not null),
  check ((device_id is null) = (client_event_id is null))
);
create unique index incidents_idempotency on incidents (device_id, client_event_id) where client_event_id is not null;
create index incidents_org_created on incidents (organization_id, created_at desc);
create index incidents_org_status on incidents (organization_id, status);
create index incidents_guard on incidents (organization_id, guard_id, created_at desc) where guard_id is not null;
alter table incidents enable row level security;
create policy incidents_tenant on incidents
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
-- INV-05, PROD §10.2: the submission itself (title, description, times, location, reporter) can never
-- be rewritten. Supervisors change only status, severity and type; each change is an incident event
-- with the old and new values.
grant select, insert on incidents to app_runtime;
grant update (type, severity, status, acknowledged_by, acknowledged_at, resolved_by, resolved_at,
  resolution_note, version, updated_at) on incidents to app_runtime;

-- The incident's history: creation (with the original submission), notes, status, severity and type
-- changes, photos. Append-only (INV-05).
create table incident_events (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  incident_id uuid not null,
  type text not null check (type in (
    'CREATED', 'NOTE_ADDED', 'STATUS_CHANGED', 'SEVERITY_CHANGED', 'TYPE_CHANGED', 'ATTACHMENT_ADDED',
    'ATTACHMENT_REJECTED')),
  actor_type text not null check (actor_type in ('GUARD', 'USER', 'SYSTEM')),
  actor_user_id uuid references users (id),
  actor_guard_id uuid,
  body text check (char_length(body) between 1 and 4000),
  from_value text check (char_length(from_value) <= 40),
  to_value text check (char_length(to_value) <= 40),
  payload jsonb not null default '{}',
  -- A guard's note from the phone is idempotent like every offline item (INV-06).
  device_id uuid,
  client_event_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, incident_id) references incidents (organization_id, id),
  foreign key (organization_id, actor_guard_id) references guards (organization_id, id),
  foreign key (organization_id, device_id) references guard_devices (organization_id, id),
  check (actor_type <> 'USER' or actor_user_id is not null),
  check (actor_type <> 'GUARD' or actor_guard_id is not null),
  check ((device_id is null) = (client_event_id is null))
);
create unique index incident_events_idempotency on incident_events (device_id, client_event_id)
  where client_event_id is not null;
create index incident_events_incident on incident_events (incident_id, created_at);
alter table incident_events enable row level security;
create policy incident_events_tenant on incident_events
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert on incident_events to app_runtime;

-- Photos (ARCH §12, SEC §12). Objects live in private storage under org/{orgId}/incidents/…; the
-- original is kept as evidence and the view copy is re-encoded without metadata.
create table incident_attachments (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  incident_id uuid not null,
  client_event_id uuid not null,
  guard_id uuid,
  device_id uuid,
  capture_source text not null check (capture_source in ('IN_APP_CAMERA', 'GALLERY')),
  declared_type text not null check (declared_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic')),
  declared_size int not null check (declared_size between 1 and 15728640),
  original_key text not null check (char_length(original_key) between 1 and 300),
  view_key text not null check (char_length(view_key) between 1 and 300),
  status text not null default 'PENDING_UPLOAD'
    check (status in ('PENDING_UPLOAD', 'PROCESSING', 'AVAILABLE', 'REJECTED')),
  -- What the phone says it uploaded; the worker checks the object against it.
  sha256 bytea check (octet_length(sha256) = 32),
  -- What the worker found, from the bytes (never from the name or the declared type).
  detected_type text check (detected_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic')),
  size_bytes int check (size_bytes >= 0),
  width int check (width > 0),
  height int check (height > 0),
  exif_captured_at timestamptz,
  -- INV-08: kept only when the photo's own capture time lies inside the incident's shift or SOS.
  exif_latitude double precision check (exif_latitude between -90 and 90),
  exif_longitude double precision check (exif_longitude between -180 and 180),
  rejection_reason text check (rejection_reason in (
    'NOT_UPLOADED', 'SIZE_MISMATCH', 'TYPE_NOT_ALLOWED', 'TOO_MANY_PIXELS', 'HASH_MISMATCH', 'UNREADABLE')),
  upload_expires_at timestamptz not null,
  completed_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (incident_id, client_event_id),
  foreign key (organization_id, incident_id) references incidents (organization_id, id),
  foreign key (organization_id, guard_id) references guards (organization_id, id),
  foreign key (organization_id, device_id) references guard_devices (organization_id, id),
  check ((exif_latitude is null) = (exif_longitude is null)),
  check ((status = 'REJECTED') = (rejection_reason is not null)),
  check (status in ('PENDING_UPLOAD', 'REJECTED') or completed_at is not null)
);
create index incident_attachments_incident on incident_attachments (incident_id, created_at);
alter table incident_attachments enable row level security;
create policy incident_attachments_tenant on incident_attachments
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on incident_attachments to app_runtime;

-- The attachment processor (ARCH §16.2) finds organizations with photos to check as system_worker.
create policy incident_attachments_system_sweep on incident_attachments
  for select to system_worker
  using (status = 'PROCESSING');
grant select (organization_id, status) on incident_attachments to system_worker;

-- ── Realtime: the SOS and incident events of ARCH §14 ────────────────────────────────────────
alter table outbox drop constraint outbox_topic_check;
alter table outbox add constraint outbox_topic_check check (topic in (
  'guard.state', 'alert.opened', 'alert.updated', 'shift.updated', 'coverage.updated', 'sos.activated',
  'sos.updated', 'incident.created', 'incident.updated'));
alter table realtime_events drop constraint realtime_events_type_check;
alter table realtime_events add constraint realtime_events_type_check check (type in (
  'guard.state', 'alert.opened', 'alert.updated', 'shift.updated', 'coverage.updated', 'sos.activated',
  'sos.updated', 'incident.created', 'incident.updated'));

-- ── Alerts gain their subjects ───────────────────────────────────────────────────────────────
alter table alerts
  add column incident_id uuid,
  add column sos_event_id uuid,
  add column is_drill boolean not null default false,
  -- The ladder's steps are timed from here (PROD §11.4), so a late job run never shifts later steps.
  -- Opening sets it; an SOS pressed again after acknowledgement restarts it (owner decision 2026-11-02).
  add column escalation_started_at timestamptz,
  add constraint alerts_incident_fk foreign key (organization_id, incident_id)
    references incidents (organization_id, id),
  add constraint alerts_sos_fk foreign key (organization_id, sos_event_id)
    references sos_events (organization_id, id);
create index alerts_sos on alerts (sos_event_id) where sos_event_id is not null;
create index alerts_escalation_due on alerts (next_escalation_at) where status = 'OPEN';

-- The escalation job (ARCH §13.3) finds organizations with alerts due a step as system_worker.
create policy alerts_system_sweep on alerts
  for select to system_worker
  using (status = 'OPEN' and next_escalation_at is not null);
grant select (organization_id, status, next_escalation_at) on alerts to system_worker;

-- ── Notifications (ARCH §13.4) ───────────────────────────────────────────────────────────────
-- A dashboard member's browser or installed dashboard (D-04). Endpoints are limited to known push
-- services by the API, so the sender never calls an address a user chose.
create table web_push_subscriptions (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  member_id uuid not null,
  user_id uuid not null references users (id),
  endpoint text not null check (char_length(endpoint) between 10 and 1000 and endpoint like 'https://%'),
  p256dh text not null check (char_length(p256dh) between 80 and 100),
  auth text not null check (char_length(auth) between 16 and 30),
  client text not null check (client in ('DESKTOP', 'PHONE')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'INVALID')),
  failure_count int not null default 0 check (failure_count >= 0),
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, endpoint),
  foreign key (organization_id, member_id) references organization_members (organization_id, id)
);
alter table web_push_subscriptions enable row level security;
create policy web_push_subscriptions_tenant on web_push_subscriptions
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update, delete on web_push_subscriptions to app_runtime;

-- One message to one recipient on one channel. Status changes as the worker sends it and receipts
-- arrive; rows are never deleted except by retention.
create table notification_deliveries (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  topic text not null check (topic in ('ALERT', 'SOS', 'SOS_GUARD', 'SHIFT', 'TEST')),
  alert_id uuid,
  sos_event_id uuid,
  channel text not null check (channel in ('WEB_PUSH', 'PUSH', 'SMS')),
  recipient_member_id uuid,
  recipient_guard_id uuid,
  subscription_id uuid,
  recipient_device_id uuid,
  -- The number a text goes to: a member's SOS number or an emergency contact (PROD App. B).
  recipient_phone text check (recipient_phone ~ '^\+[1-9][0-9]{6,14}$'),
  escalation_level int not null default 0 check (escalation_level >= 0),
  is_drill boolean not null default false,
  status text not null default 'QUEUED' check (status in ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED')),
  -- {alert}:{recipient}:{channel}:{level} (ARCH §13.4): a retried job never double-sends.
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 300),
  attempt int not null default 0 check (attempt >= 0),
  max_attempts int not null check (max_attempts between 1 and 10),
  next_attempt_at timestamptz not null,
  locked_until timestamptz,
  -- Lock-screen-safe text written by the server (PROD §13): no coordinates, no incident text.
  title text not null check (char_length(title) between 1 and 200),
  body text not null check (char_length(body) between 1 and 500),
  link_path text check (char_length(link_path) <= 300),
  provider text check (char_length(provider) <= 40),
  provider_message_id text check (char_length(provider_message_id) <= 300),
  error_code text check (char_length(error_code) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  unique (organization_id, id),
  unique (organization_id, dedupe_key),
  foreign key (organization_id, alert_id) references alerts (organization_id, id),
  foreign key (organization_id, sos_event_id) references sos_events (organization_id, id),
  foreign key (organization_id, recipient_member_id) references organization_members (organization_id, id),
  foreign key (organization_id, recipient_guard_id) references guards (organization_id, id),
  foreign key (organization_id, subscription_id) references web_push_subscriptions (organization_id, id),
  foreign key (organization_id, recipient_device_id) references guard_devices (organization_id, id),
  check (channel <> 'WEB_PUSH' or subscription_id is not null),
  check (channel <> 'PUSH' or recipient_device_id is not null),
  check (channel <> 'SMS' or recipient_phone is not null)
);
create index notification_deliveries_due on notification_deliveries (next_attempt_at) where status = 'QUEUED';
create index notification_deliveries_alert on notification_deliveries (alert_id) where alert_id is not null;
create index notification_deliveries_sos on notification_deliveries (sos_event_id) where sos_event_id is not null;
create index notification_deliveries_sms_month on notification_deliveries (organization_id, created_at)
  where channel = 'SMS';
alter table notification_deliveries enable row level security;
create policy notification_deliveries_tenant on notification_deliveries
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
grant select, insert, update on notification_deliveries to app_runtime;

-- The sender (ARCH §16.2) finds organizations with messages due as system_worker.
create policy notification_deliveries_system_sweep on notification_deliveries
  for select to system_worker
  using (status = 'QUEUED');
grant select (organization_id, status, next_attempt_at) on notification_deliveries to system_worker;
