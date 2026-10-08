# Entity-relationship diagram

Generated from the migrated schema by `packages/db/src/erd.ts`; do not edit by hand.
Regenerate with `UPDATE_GENERATED=1 pnpm test --project db`.

```mermaid
erDiagram
  audit_logs {
    uuid id PK
    uuid organization_id
    text actor_type
    uuid actor_user_id
    text action
    text resource_type
    uuid resource_id
    text reason
    text request_id
    inet ip_address
    text user_agent
    jsonb metadata
    timestamp_with_time_zone created_at
  }
  auth_states {
    uuid id PK
    bytea state_hash
    text nonce
    text code_verifier
    text return_to
    timestamp_with_time_zone expires_at
    timestamp_with_time_zone used_at
    timestamp_with_time_zone created_at
  }
  checkpoints {
    uuid id PK
    uuid organization_id
    uuid site_id
    text name
    text description
    double_precision latitude
    double_precision longitude
    integer verification_radius_meters
    bytea qr_token_hash
    integer qr_token_version
    timestamp_with_time_zone qr_rotated_at
    text status
    integer version
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid created_by_user_id
    uuid updated_by_user_id
  }
  dashboard_sessions {
    uuid id PK
    uuid user_id
    bytea token_hash
    timestamp_with_time_zone created_at
    timestamp_with_time_zone last_seen_at
    timestamp_with_time_zone idle_expires_at
    timestamp_with_time_zone absolute_expires_at
    timestamp_with_time_zone revoked_at
    text revoked_reason
    inet ip_address
    text user_agent
  }
  guard_devices {
    uuid id PK
    uuid organization_id
    uuid guard_id
    uuid installation_id
    bytea public_key
    text key_algorithm
    text platform
    text manufacturer
    text model
    text os_version
    text app_version
    text status
    text revoked_reason
    timestamp_with_time_zone revoked_at
    uuid revoked_by_user_id
    timestamp_with_time_zone last_seen_at
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  guards {
    uuid id PK
    uuid organization_id
    uuid user_id
    text employee_number
    text display_name
    text phone
    text status
    text preferred_locale
    integer version
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid created_by_user_id
    uuid updated_by_user_id
  }
  invitations {
    uuid id PK
    uuid organization_id
    text purpose
    text role
    citext email
    text phone
    uuid guard_id
    bytea token_hash
    bytea code_hash
    integer attempts
    timestamp_with_time_zone expires_at
    timestamp_with_time_zone accepted_at
    uuid accepted_by_user_id
    timestamp_with_time_zone revoked_at
    uuid revoked_by_user_id
    uuid created_by_user_id
    timestamp_with_time_zone created_at
  }
  mobile_sessions {
    uuid id PK
    uuid organization_id
    uuid guard_id
    uuid device_id
    uuid family_id
    bytea access_token_hash
    timestamp_with_time_zone access_expires_at
    bytea refresh_token_hash
    timestamp_with_time_zone expires_at
    timestamp_with_time_zone issued_at
    timestamp_with_time_zone last_used_at
    timestamp_with_time_zone rotated_at
    timestamp_with_time_zone revoked_at
    text revoked_reason
    timestamp_with_time_zone created_at
  }
  organization_members {
    uuid id PK
    uuid organization_id
    uuid user_id
    text role
    text status
    integer version
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  organization_settings {
    uuid id PK
    uuid organization_id
    jsonb overrides
    integer schema_version
    integer version
    uuid updated_by_user_id
    timestamp_with_time_zone updated_at
  }
  organizations {
    uuid id PK
    text name
    text legal_name
    text status
    text timezone
    text default_locale
    text data_region
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  schema_migrations {
    text version PK
    text checksum
    timestamp_with_time_zone applied_at
  }
  shift_events {
    uuid id PK
    uuid organization_id
    uuid shift_id
    text type
    text actor_type
    uuid actor_user_id
    uuid device_id
    uuid client_event_id
    timestamp_with_time_zone occurred_at
    timestamp_with_time_zone client_recorded_at
    jsonb payload
    timestamp_with_time_zone created_at
  }
  shifts {
    uuid id PK
    uuid organization_id
    uuid guard_id
    uuid site_id
    timestamp_with_time_zone starts_at
    timestamp_with_time_zone ends_at
    timestamp_with_time_zone start_deadline_at
    text status
    timestamp_with_time_zone actual_started_at
    timestamp_with_time_zone actual_ended_at
    text start_source
    double_precision start_latitude
    double_precision start_longitude
    double_precision start_accuracy_m
    double_precision start_distance_m
    text start_geofence_class
    uuid start_device_id
    text__ start_flags
    text end_reason
    double_precision end_latitude
    double_precision end_longitude
    double_precision end_accuracy_m
    text cancelled_reason
    text notes
    integer version
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid created_by_user_id
    uuid updated_by_user_id
  }
  sites {
    uuid id PK
    uuid organization_id
    text name
    text client_name
    text address_line_1
    text address_line_2
    text city
    text country
    text timezone
    text boundary_kind
    double_precision latitude
    double_precision longitude
    integer geofence_radius_meters
    jsonb polygon
    text status
    text notes
    integer version
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid created_by_user_id
    uuid updated_by_user_id
  }
  tracking_consents {
    uuid id PK
    uuid organization_id
    uuid guard_id
    uuid user_id
    uuid device_id
    text disclosure_version
    text locale
    timestamp_with_time_zone accepted_at
    timestamp_with_time_zone created_at
  }
  users {
    uuid id PK
    text auth_provider_user_id
    citext email
    text phone
    text name
    text status
    text locale
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  users ||--o{ audit_logs : "audit_logs_actor_user_id_fkey"
  organizations ||--o{ audit_logs : "audit_logs_organization_id_fkey"
  users ||--o{ checkpoints : "checkpoints_created_by_user_id_fkey"
  organizations ||--o{ checkpoints : "checkpoints_organization_id_fkey"
  sites ||--o{ checkpoints : "checkpoints_organization_id_site_id_fkey"
  users ||--o{ checkpoints : "checkpoints_updated_by_user_id_fkey"
  users ||--o{ dashboard_sessions : "dashboard_sessions_user_id_fkey"
  organizations ||--o{ guard_devices : "guard_devices_organization_id_fkey"
  guards ||--o{ guard_devices : "guard_devices_organization_id_guard_id_fkey"
  users ||--o{ guard_devices : "guard_devices_revoked_by_user_id_fkey"
  users ||--o{ guards : "guards_created_by_user_id_fkey"
  organizations ||--o{ guards : "guards_organization_id_fkey"
  users ||--o{ guards : "guards_updated_by_user_id_fkey"
  users ||--o{ guards : "guards_user_id_fkey"
  users ||--o{ invitations : "invitations_accepted_by_user_id_fkey"
  users ||--o{ invitations : "invitations_created_by_user_id_fkey"
  guards ||--o{ invitations : "invitations_guard_fk"
  organizations ||--o{ invitations : "invitations_organization_id_fkey"
  users ||--o{ invitations : "invitations_revoked_by_user_id_fkey"
  guard_devices ||--o{ mobile_sessions : "mobile_sessions_organization_id_device_id_fkey"
  organizations ||--o{ mobile_sessions : "mobile_sessions_organization_id_fkey"
  guards ||--o{ mobile_sessions : "mobile_sessions_organization_id_guard_id_fkey"
  organizations ||--o{ organization_members : "organization_members_organization_id_fkey"
  users ||--o{ organization_members : "organization_members_user_id_fkey"
  organizations ||--o{ organization_settings : "organization_settings_organization_id_fkey"
  users ||--o{ organization_settings : "organization_settings_updated_by_user_id_fkey"
  users ||--o{ shift_events : "shift_events_actor_user_id_fkey"
  guard_devices ||--o{ shift_events : "shift_events_organization_id_device_id_fkey"
  organizations ||--o{ shift_events : "shift_events_organization_id_fkey"
  shifts ||--o{ shift_events : "shift_events_organization_id_shift_id_fkey"
  users ||--o{ shifts : "shifts_created_by_user_id_fkey"
  organizations ||--o{ shifts : "shifts_organization_id_fkey"
  guards ||--o{ shifts : "shifts_organization_id_guard_id_fkey"
  sites ||--o{ shifts : "shifts_organization_id_site_id_fkey"
  guard_devices ||--o{ shifts : "shifts_organization_id_start_device_id_fkey"
  users ||--o{ shifts : "shifts_updated_by_user_id_fkey"
  users ||--o{ sites : "sites_created_by_user_id_fkey"
  organizations ||--o{ sites : "sites_organization_id_fkey"
  users ||--o{ sites : "sites_updated_by_user_id_fkey"
  guard_devices ||--o{ tracking_consents : "tracking_consents_organization_id_device_id_fkey"
  organizations ||--o{ tracking_consents : "tracking_consents_organization_id_fkey"
  guards ||--o{ tracking_consents : "tracking_consents_organization_id_guard_id_fkey"
  users ||--o{ tracking_consents : "tracking_consents_user_id_fkey"
```
