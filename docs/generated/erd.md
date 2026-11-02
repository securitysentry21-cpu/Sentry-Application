# Entity-relationship diagram

Generated from the migrated schema by `packages/db/src/erd.ts`; do not edit by hand.
Regenerate with `UPDATE_GENERATED=1 pnpm test --project db`.

```mermaid
erDiagram
  alert_events {
    uuid id PK
    uuid organization_id
    uuid alert_id
    text type
    text actor_type
    uuid actor_user_id
    text note
    jsonb payload
    timestamp_with_time_zone created_at
  }
  alerts {
    uuid id PK
    uuid organization_id
    text type
    text severity
    text status
    text dedupe_key
    text summary
    uuid guard_id
    uuid site_id
    uuid shift_id
    jsonb details
    timestamp_with_time_zone opened_at
    timestamp_with_time_zone last_triggered_at
    integer trigger_count
    uuid acknowledged_by
    timestamp_with_time_zone acknowledged_at
    uuid resolved_by
    timestamp_with_time_zone resolved_at
    text resolution_type
    text resolution_note
    uuid dismissed_by
    timestamp_with_time_zone dismissed_at
    text dismiss_reason
    integer escalation_level
    timestamp_with_time_zone next_escalation_at
    boolean detected_late
    integer version
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid incident_id
    uuid sos_event_id
    boolean is_drill
    timestamp_with_time_zone escalation_started_at
  }
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
  checkpoint_retired_labels {
    uuid id PK
    uuid organization_id
    uuid checkpoint_id
    bytea qr_token_hash
    integer qr_token_version
    timestamp_with_time_zone retired_at
  }
  checkpoint_visits {
    uuid id PK
    uuid organization_id
    uuid guard_id
    uuid shift_id
    uuid checkpoint_id
    uuid patrol_route_id
    uuid patrol_run_id
    uuid device_id
    uuid client_event_id
    timestamp_with_time_zone scanned_at_recorded
    timestamp_with_time_zone scanned_at
    timestamp_with_time_zone received_at
    text clock_status
    double_precision latitude
    double_precision longitude
    double_precision accuracy_m
    double_precision fix_age_s
    integer distance_m
    text distance_band
    boolean is_mock
    text verification_status
    text verification_reason
    text__ flags
    boolean counted
    integer qr_token_version
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
  device_status_events {
    uuid id PK
    uuid organization_id
    uuid guard_id
    uuid device_id
    uuid shift_id
    uuid client_event_id
    timestamp_with_time_zone recorded_at
    timestamp_with_time_zone received_at
    text location_permission
    boolean precise_location
    boolean location_services_enabled
    boolean notifications_enabled
    double_precision battery_pct
    boolean is_charging
    boolean power_save_mode
    boolean battery_optimization_exempt
    boolean auto_time_enabled
    text tracking_service_state
    text app_version
    text os_version
    integer pending_queue_count
    timestamp_with_time_zone oldest_pending_at
    timestamp_with_time_zone last_successful_sync_at
    timestamp_with_time_zone created_at
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
    text push_token
    timestamp_with_time_zone push_token_updated_at
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
  incident_attachments {
    uuid id PK
    uuid organization_id
    uuid incident_id
    uuid client_event_id
    uuid guard_id
    uuid device_id
    text capture_source
    text declared_type
    integer declared_size
    text original_key
    text view_key
    text status
    bytea sha256
    text detected_type
    integer size_bytes
    integer width
    integer height
    timestamp_with_time_zone exif_captured_at
    double_precision exif_latitude
    double_precision exif_longitude
    text rejection_reason
    timestamp_with_time_zone upload_expires_at
    timestamp_with_time_zone completed_at
    timestamp_with_time_zone processed_at
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  incident_counters {
    uuid id PK
    uuid organization_id
    integer next_value
  }
  incident_events {
    uuid id PK
    uuid organization_id
    uuid incident_id
    text type
    text actor_type
    uuid actor_user_id
    uuid actor_guard_id
    text body
    text from_value
    text to_value
    jsonb payload
    uuid device_id
    uuid client_event_id
    timestamp_with_time_zone created_at
  }
  incidents {
    uuid id PK
    uuid organization_id
    integer reference_number
    uuid guard_id
    uuid reported_by_user_id
    uuid shift_id
    uuid sos_event_id
    uuid site_id
    uuid checkpoint_id
    text type
    text severity
    text title
    text description
    double_precision latitude
    double_precision longitude
    double_precision accuracy_m
    double_precision fix_age_s
    boolean is_mock
    timestamp_with_time_zone occurred_at
    timestamp_with_time_zone reported_at
    timestamp_with_time_zone reported_at_recorded
    timestamp_with_time_zone received_at
    text status
    uuid acknowledged_by
    timestamp_with_time_zone acknowledged_at
    uuid resolved_by
    timestamp_with_time_zone resolved_at
    text resolution_note
    boolean is_drill
    uuid device_id
    uuid client_event_id
    integer version
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
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
  location_points {
    uuid id PK
    uuid organization_id
    uuid guard_id
    uuid shift_id
    uuid device_id
    uuid client_event_id
    double_precision latitude
    double_precision longitude
    double_precision accuracy_m
    double_precision altitude_m
    double_precision speed_mps
    double_precision heading_deg
    timestamp_with_time_zone recorded_at
    timestamp_with_time_zone captured_at
    timestamp_with_time_zone received_at
    text clock_status
    text source
    text provider
    boolean is_mock
    text__ flags
    text app_version
    uuid sync_batch_id
    timestamp_with_time_zone created_at
    uuid sos_event_id
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
  notification_deliveries {
    uuid id PK
    uuid organization_id
    text topic
    uuid alert_id
    uuid sos_event_id
    text channel
    uuid recipient_member_id
    uuid recipient_guard_id
    uuid subscription_id
    uuid recipient_device_id
    text recipient_phone
    integer escalation_level
    boolean is_drill
    text status
    text dedupe_key
    integer attempt
    integer max_attempts
    timestamp_with_time_zone next_attempt_at
    timestamp_with_time_zone locked_until
    text title
    text body
    text link_path
    text provider
    text provider_message_id
    text error_code
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    timestamp_with_time_zone sent_at
    timestamp_with_time_zone delivered_at
    timestamp_with_time_zone failed_at
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
    text alert_phone
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
    text kind
  }
  outbox {
    uuid id PK
    uuid organization_id
    bigint position
    text topic
    jsonb payload
    timestamp_with_time_zone created_at
    timestamp_with_time_zone processed_at
    integer attempts
  }
  patrol_route_checkpoints {
    uuid id PK
    uuid organization_id
    uuid site_id
    uuid patrol_route_id
    uuid checkpoint_id
    integer sequence
    boolean required
  }
  patrol_routes {
    uuid id PK
    uuid organization_id
    uuid site_id
    text name
    text description
    boolean enforce_order
    integer interval_minutes
    integer first_run_offset_minutes
    integer completion_window_minutes
    text status
    integer version
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
    uuid created_by_user_id
    uuid updated_by_user_id
  }
  patrol_runs {
    uuid id PK
    uuid organization_id
    uuid shift_id
    uuid guard_id
    uuid site_id
    uuid patrol_route_id
    integer sequence_no
    timestamp_with_time_zone due_at
    timestamp_with_time_zone window_ends_at
    text status
    timestamp_with_time_zone started_at
    timestamp_with_time_zone completed_at
    timestamp_with_time_zone closed_at
    integer required_count
    integer counted_count
    integer unconfirmed_count
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  quarantined_items {
    uuid id PK
    uuid organization_id
    uuid device_id
    uuid batch_id
    text client_event_id
    jsonb item
    text error_code
    timestamp_with_time_zone created_at
    timestamp_with_time_zone replayed_at
  }
  realtime_events {
    uuid id
    uuid organization_id PK
    bigint seq PK
    text type
    jsonb payload
    timestamp_with_time_zone created_at
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
  shift_live_state {
    uuid id PK
    uuid organization_id
    uuid guard_id
    uuid site_id
    double_precision last_fix_latitude
    double_precision last_fix_longitude
    double_precision last_fix_accuracy_m
    timestamp_with_time_zone last_fix_captured_at
    uuid last_fix_point_id
    timestamp_with_time_zone last_contact_at
    text geofence_state
    text tracking_service_state
    text location_permission
    double_precision battery_pct
    boolean is_charging
    text app_version
    integer pending_queue_count
    timestamp_with_time_zone oldest_pending_at
    timestamp_with_time_zone device_report_at
    timestamp_with_time_zone updated_at
    timestamp_with_time_zone geofence_outside_since
    integer geofence_outside_points
    integer geofence_inside_streak
    timestamp_with_time_zone geofence_watermark_at
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
  sos_drill_guards {
    uuid id PK
    uuid organization_id
    uuid drill_id
    uuid guard_id
  }
  sos_drill_members {
    uuid id PK
    uuid organization_id
    uuid drill_id
    uuid member_id
  }
  sos_drills {
    uuid id PK
    uuid organization_id
    uuid started_by_user_id
    timestamp_with_time_zone started_at
    timestamp_with_time_zone ends_at
    uuid ended_by_user_id
    timestamp_with_time_zone ended_at
    text note
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  sos_events {
    uuid id PK
    uuid organization_id
    uuid guard_id
    uuid shift_id
    uuid site_id
    uuid device_id
    uuid client_event_id
    timestamp_with_time_zone activated_at_recorded
    timestamp_with_time_zone activated_at
    timestamp_with_time_zone received_at
    text clock_status
    double_precision latitude
    double_precision longitude
    double_precision accuracy_m
    timestamp_with_time_zone location_captured_at
    text status
    integer trigger_count
    timestamp_with_time_zone last_triggered_at
    timestamp_with_time_zone guard_cancel_requested_at
    timestamp_with_time_zone alert_sent_at
    timestamp_with_time_zone notified_at
    uuid acknowledged_by
    timestamp_with_time_zone acknowledged_at
    uuid resolved_by
    timestamp_with_time_zone resolved_at
    text resolution
    text resolution_note
    boolean is_drill
    uuid drill_id
    integer version
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  sos_presses {
    uuid id PK
    uuid organization_id
    uuid sos_event_id
    uuid guard_id
    uuid device_id
    uuid client_event_id
    timestamp_with_time_zone pressed_at_recorded
    timestamp_with_time_zone pressed_at
    timestamp_with_time_zone received_at
    text auth
    timestamp_with_time_zone created_at
  }
  stream_connections {
    uuid id PK
    uuid organization_id
    uuid user_id
    text client
    text instance_id
    timestamp_with_time_zone connected_at
    timestamp_with_time_zone last_seen_at
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
  web_push_subscriptions {
    uuid id PK
    uuid organization_id
    uuid member_id
    uuid user_id
    text endpoint
    text p256dh
    text auth
    text client
    text status
    integer failure_count
    timestamp_with_time_zone last_success_at
    timestamp_with_time_zone created_at
    timestamp_with_time_zone updated_at
  }
  users ||--o{ alert_events : "alert_events_actor_user_id_fkey"
  alerts ||--o{ alert_events : "alert_events_organization_id_alert_id_fkey"
  organizations ||--o{ alert_events : "alert_events_organization_id_fkey"
  users ||--o{ alerts : "alerts_acknowledged_by_fkey"
  users ||--o{ alerts : "alerts_dismissed_by_fkey"
  incidents ||--o{ alerts : "alerts_incident_fk"
  organizations ||--o{ alerts : "alerts_organization_id_fkey"
  guards ||--o{ alerts : "alerts_organization_id_guard_id_fkey"
  shifts ||--o{ alerts : "alerts_organization_id_shift_id_fkey"
  sites ||--o{ alerts : "alerts_organization_id_site_id_fkey"
  users ||--o{ alerts : "alerts_resolved_by_fkey"
  sos_events ||--o{ alerts : "alerts_sos_fk"
  users ||--o{ audit_logs : "audit_logs_actor_user_id_fkey"
  organizations ||--o{ audit_logs : "audit_logs_organization_id_fkey"
  checkpoints ||--o{ checkpoint_retired_labels : "checkpoint_retired_labels_organization_id_checkpoint_id_fkey"
  organizations ||--o{ checkpoint_retired_labels : "checkpoint_retired_labels_organization_id_fkey"
  checkpoints ||--o{ checkpoint_visits : "checkpoint_visits_organization_id_checkpoint_id_fkey"
  guard_devices ||--o{ checkpoint_visits : "checkpoint_visits_organization_id_device_id_fkey"
  organizations ||--o{ checkpoint_visits : "checkpoint_visits_organization_id_fkey"
  guards ||--o{ checkpoint_visits : "checkpoint_visits_organization_id_guard_id_fkey"
  patrol_routes ||--o{ checkpoint_visits : "checkpoint_visits_organization_id_patrol_route_id_fkey"
  patrol_runs ||--o{ checkpoint_visits : "checkpoint_visits_organization_id_patrol_run_id_fkey"
  shifts ||--o{ checkpoint_visits : "checkpoint_visits_organization_id_shift_id_fkey"
  users ||--o{ checkpoints : "checkpoints_created_by_user_id_fkey"
  organizations ||--o{ checkpoints : "checkpoints_organization_id_fkey"
  sites ||--o{ checkpoints : "checkpoints_organization_id_site_id_fkey"
  users ||--o{ checkpoints : "checkpoints_updated_by_user_id_fkey"
  users ||--o{ dashboard_sessions : "dashboard_sessions_user_id_fkey"
  guard_devices ||--o{ device_status_events : "device_status_events_organization_id_device_id_fkey"
  organizations ||--o{ device_status_events : "device_status_events_organization_id_fkey"
  guards ||--o{ device_status_events : "device_status_events_organization_id_guard_id_fkey"
  shifts ||--o{ device_status_events : "device_status_events_organization_id_shift_id_fkey"
  organizations ||--o{ guard_devices : "guard_devices_organization_id_fkey"
  guards ||--o{ guard_devices : "guard_devices_organization_id_guard_id_fkey"
  users ||--o{ guard_devices : "guard_devices_revoked_by_user_id_fkey"
  users ||--o{ guards : "guards_created_by_user_id_fkey"
  organizations ||--o{ guards : "guards_organization_id_fkey"
  users ||--o{ guards : "guards_updated_by_user_id_fkey"
  users ||--o{ guards : "guards_user_id_fkey"
  guard_devices ||--o{ incident_attachments : "incident_attachments_organization_id_device_id_fkey"
  organizations ||--o{ incident_attachments : "incident_attachments_organization_id_fkey"
  guards ||--o{ incident_attachments : "incident_attachments_organization_id_guard_id_fkey"
  incidents ||--o{ incident_attachments : "incident_attachments_organization_id_incident_id_fkey"
  organizations ||--o{ incident_counters : "incident_counters_organization_id_fkey"
  users ||--o{ incident_events : "incident_events_actor_user_id_fkey"
  guards ||--o{ incident_events : "incident_events_organization_id_actor_guard_id_fkey"
  guard_devices ||--o{ incident_events : "incident_events_organization_id_device_id_fkey"
  organizations ||--o{ incident_events : "incident_events_organization_id_fkey"
  incidents ||--o{ incident_events : "incident_events_organization_id_incident_id_fkey"
  users ||--o{ incidents : "incidents_acknowledged_by_fkey"
  checkpoints ||--o{ incidents : "incidents_organization_id_checkpoint_id_fkey"
  guard_devices ||--o{ incidents : "incidents_organization_id_device_id_fkey"
  organizations ||--o{ incidents : "incidents_organization_id_fkey"
  guards ||--o{ incidents : "incidents_organization_id_guard_id_fkey"
  shifts ||--o{ incidents : "incidents_organization_id_shift_id_fkey"
  sites ||--o{ incidents : "incidents_organization_id_site_id_fkey"
  sos_events ||--o{ incidents : "incidents_organization_id_sos_event_id_fkey"
  users ||--o{ incidents : "incidents_reported_by_user_id_fkey"
  users ||--o{ incidents : "incidents_resolved_by_fkey"
  users ||--o{ invitations : "invitations_accepted_by_user_id_fkey"
  users ||--o{ invitations : "invitations_created_by_user_id_fkey"
  guards ||--o{ invitations : "invitations_guard_fk"
  organizations ||--o{ invitations : "invitations_organization_id_fkey"
  users ||--o{ invitations : "invitations_revoked_by_user_id_fkey"
  guard_devices ||--o{ location_points : "location_points_organization_id_device_id_fkey"
  organizations ||--o{ location_points : "location_points_organization_id_fkey"
  guards ||--o{ location_points : "location_points_organization_id_guard_id_fkey"
  shifts ||--o{ location_points : "location_points_organization_id_shift_id_fkey"
  sos_events ||--o{ location_points : "location_points_sos_fk"
  guard_devices ||--o{ mobile_sessions : "mobile_sessions_organization_id_device_id_fkey"
  organizations ||--o{ mobile_sessions : "mobile_sessions_organization_id_fkey"
  guards ||--o{ mobile_sessions : "mobile_sessions_organization_id_guard_id_fkey"
  alerts ||--o{ notification_deliveries : "notification_deliveries_organization_id_alert_id_fkey"
  organizations ||--o{ notification_deliveries : "notification_deliveries_organization_id_fkey"
  guard_devices ||--o{ notification_deliveries : "notification_deliveries_organization_id_recipient_device_i_fkey"
  guards ||--o{ notification_deliveries : "notification_deliveries_organization_id_recipient_guard_id_fkey"
  organization_members ||--o{ notification_deliveries : "notification_deliveries_organization_id_recipient_member_i_fkey"
  sos_events ||--o{ notification_deliveries : "notification_deliveries_organization_id_sos_event_id_fkey"
  web_push_subscriptions ||--o{ notification_deliveries : "notification_deliveries_organization_id_subscription_id_fkey"
  organizations ||--o{ organization_members : "organization_members_organization_id_fkey"
  users ||--o{ organization_members : "organization_members_user_id_fkey"
  organizations ||--o{ organization_settings : "organization_settings_organization_id_fkey"
  users ||--o{ organization_settings : "organization_settings_updated_by_user_id_fkey"
  organizations ||--o{ outbox : "outbox_organization_id_fkey"
  organizations ||--o{ patrol_route_checkpoints : "patrol_route_checkpoints_organization_id_fkey"
  checkpoints ||--o{ patrol_route_checkpoints : "patrol_route_checkpoints_organization_id_site_id_checkpoin_fkey"
  patrol_routes ||--o{ patrol_route_checkpoints : "patrol_route_checkpoints_organization_id_site_id_patrol_ro_fkey"
  users ||--o{ patrol_routes : "patrol_routes_created_by_user_id_fkey"
  organizations ||--o{ patrol_routes : "patrol_routes_organization_id_fkey"
  sites ||--o{ patrol_routes : "patrol_routes_organization_id_site_id_fkey"
  users ||--o{ patrol_routes : "patrol_routes_updated_by_user_id_fkey"
  organizations ||--o{ patrol_runs : "patrol_runs_organization_id_fkey"
  guards ||--o{ patrol_runs : "patrol_runs_organization_id_guard_id_fkey"
  shifts ||--o{ patrol_runs : "patrol_runs_organization_id_shift_id_fkey"
  patrol_routes ||--o{ patrol_runs : "patrol_runs_organization_id_site_id_patrol_route_id_fkey"
  guard_devices ||--o{ quarantined_items : "quarantined_items_organization_id_device_id_fkey"
  organizations ||--o{ quarantined_items : "quarantined_items_organization_id_fkey"
  organizations ||--o{ realtime_events : "realtime_events_organization_id_fkey"
  users ||--o{ shift_events : "shift_events_actor_user_id_fkey"
  guard_devices ||--o{ shift_events : "shift_events_organization_id_device_id_fkey"
  organizations ||--o{ shift_events : "shift_events_organization_id_fkey"
  shifts ||--o{ shift_events : "shift_events_organization_id_shift_id_fkey"
  organizations ||--o{ shift_live_state : "shift_live_state_organization_id_fkey"
  guards ||--o{ shift_live_state : "shift_live_state_organization_id_guard_id_fkey"
  shifts ||--o{ shift_live_state : "shift_live_state_organization_id_id_fkey"
  sites ||--o{ shift_live_state : "shift_live_state_organization_id_site_id_fkey"
  users ||--o{ shifts : "shifts_created_by_user_id_fkey"
  organizations ||--o{ shifts : "shifts_organization_id_fkey"
  guards ||--o{ shifts : "shifts_organization_id_guard_id_fkey"
  sites ||--o{ shifts : "shifts_organization_id_site_id_fkey"
  guard_devices ||--o{ shifts : "shifts_organization_id_start_device_id_fkey"
  users ||--o{ shifts : "shifts_updated_by_user_id_fkey"
  users ||--o{ sites : "sites_created_by_user_id_fkey"
  organizations ||--o{ sites : "sites_organization_id_fkey"
  users ||--o{ sites : "sites_updated_by_user_id_fkey"
  sos_drills ||--o{ sos_drill_guards : "sos_drill_guards_organization_id_drill_id_fkey"
  organizations ||--o{ sos_drill_guards : "sos_drill_guards_organization_id_fkey"
  guards ||--o{ sos_drill_guards : "sos_drill_guards_organization_id_guard_id_fkey"
  sos_drills ||--o{ sos_drill_members : "sos_drill_members_organization_id_drill_id_fkey"
  organizations ||--o{ sos_drill_members : "sos_drill_members_organization_id_fkey"
  organization_members ||--o{ sos_drill_members : "sos_drill_members_organization_id_member_id_fkey"
  users ||--o{ sos_drills : "sos_drills_ended_by_user_id_fkey"
  organizations ||--o{ sos_drills : "sos_drills_organization_id_fkey"
  users ||--o{ sos_drills : "sos_drills_started_by_user_id_fkey"
  users ||--o{ sos_events : "sos_events_acknowledged_by_fkey"
  guard_devices ||--o{ sos_events : "sos_events_organization_id_device_id_fkey"
  sos_drills ||--o{ sos_events : "sos_events_organization_id_drill_id_fkey"
  organizations ||--o{ sos_events : "sos_events_organization_id_fkey"
  guards ||--o{ sos_events : "sos_events_organization_id_guard_id_fkey"
  shifts ||--o{ sos_events : "sos_events_organization_id_shift_id_fkey"
  sites ||--o{ sos_events : "sos_events_organization_id_site_id_fkey"
  users ||--o{ sos_events : "sos_events_resolved_by_fkey"
  guard_devices ||--o{ sos_presses : "sos_presses_organization_id_device_id_fkey"
  organizations ||--o{ sos_presses : "sos_presses_organization_id_fkey"
  guards ||--o{ sos_presses : "sos_presses_organization_id_guard_id_fkey"
  sos_events ||--o{ sos_presses : "sos_presses_organization_id_sos_event_id_fkey"
  organizations ||--o{ stream_connections : "stream_connections_organization_id_fkey"
  users ||--o{ stream_connections : "stream_connections_user_id_fkey"
  guard_devices ||--o{ tracking_consents : "tracking_consents_organization_id_device_id_fkey"
  organizations ||--o{ tracking_consents : "tracking_consents_organization_id_fkey"
  guards ||--o{ tracking_consents : "tracking_consents_organization_id_guard_id_fkey"
  users ||--o{ tracking_consents : "tracking_consents_user_id_fkey"
  organizations ||--o{ web_push_subscriptions : "web_push_subscriptions_organization_id_fkey"
  organization_members ||--o{ web_push_subscriptions : "web_push_subscriptions_organization_id_member_id_fkey"
  users ||--o{ web_push_subscriptions : "web_push_subscriptions_user_id_fkey"
```
