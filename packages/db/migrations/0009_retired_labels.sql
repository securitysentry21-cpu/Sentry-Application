-- 0009_retired_labels.sql
-- Q-22 (owner, 2026-11-02): a guard who scans a checkpoint's old label is told "Old QR code —
-- report to supervisor" (PROD §5.4). Rotating a label keeps the hash of the one it replaces, so a
-- later scan of it is recognised as one of this organization's old labels. The lookup runs inside
-- the scanning organization's tenant context, so another organization's labels, old or current,
-- still answer exactly like unknown ones (ADV-T08). The label itself is never stored.
create table checkpoint_retired_labels (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  checkpoint_id uuid not null,
  qr_token_hash bytea not null unique,
  qr_token_version int not null check (qr_token_version >= 1),
  retired_at timestamptz not null,
  unique (organization_id, id),
  foreign key (organization_id, checkpoint_id) references checkpoints (organization_id, id)
);
create index checkpoint_retired_labels_checkpoint on checkpoint_retired_labels (checkpoint_id);
alter table checkpoint_retired_labels enable row level security;
create policy checkpoint_retired_labels_tenant on checkpoint_retired_labels
  for all to app_runtime
  using (organization_id = app.current_org_id())
  with check (organization_id = app.current_org_id());
-- Append-only (INV-05): a retired label stays retired.
grant select, insert on checkpoint_retired_labels to app_runtime;
