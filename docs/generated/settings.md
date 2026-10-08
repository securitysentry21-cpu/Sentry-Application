<!-- Generated from packages/contracts/src/settings.ts by scripts/generate-docs.ts. Do not edit; run `pnpm docs:generate`. -->

# Settings

Defaults and scope of every organization setting (PROD Appendix B). "Dashboard" marks the settings an organization can edit itself in V1 (review P-06).

| Key | Default | Scope | Dashboard | Bounds / note |
|---|---|---|---|---|
| `shift.earliest_start_minutes` | `30` | organization | no | 0–120 |
| `shift.late_alert_after_minutes` | `10` | organization | yes | 1–120 |
| `shift.missed_after_minutes` | `120` | organization | yes | ≥ late_alert_after |
| `shift.auto_end_after_minutes` | `60` | organization | no | 15–240 |
| `shift.overrun_alert_after_minutes` | `15` | organization | no | < auto_end_after |
| `shift.start_max_fix_age_seconds` | `120` | organization | no | 30–600 |
| `shift.start_required_accuracy_m` | `100` | organization | no | flag only |
| `shift.require_background_permission` | `"BLOCK"` | organization | no | BLOCK · WARN |
| `shift.start_outside_geofence` | `"ALLOW_AND_FLAG"` | organization | no | ALLOW_AND_FLAG · BLOCK (D-15) |
| `shift.reminder_minutes_before` | `30` | organization | no | 0 = off |
| `tracking.moving_distance_filter_m` | `20` | organization | no | 10–100 |
| `tracking.min_interval_s` | `15` | organization | no | 5–60 |
| `tracking.max_interval_s` | `60` | organization | no | 30–300 |
| `tracking.stationary_fix_interval_s` | `300` | organization | no | 60–900 |
| `tracking.sos_interval_s` | `10` | organization | no | 5–30 |
| `tracking.sos_max_hours` | `4` | organization | no | 1–12 |
| `sync.upload_interval_s` | `60` | organization | no | 15–300 |
| `sync.heartbeat_interval_s` | `60` | organization | no | 30–300; provisional, Phase 0B sets the default |
| `sync.max_offline_age_hours` | `168` | system | no | older data rejected |
| `freshness.health_live_max_s` | `90` | organization | no | ≥ heartbeat interval + 30 |
| `freshness.offline_after_s` | `300` | organization | no | ≥ 3 × heartbeat interval |
| `freshness.location_current_max_s` | `150` | organization | no | ≥ tracking.max_interval_s + upload interval + 30 |
| `freshness.location_stale_after_s` | `420` | organization | no | ≥ stationary fix interval + upload interval + 60 |
| `alerts.device_offline_after_s` | `600` | organization | no | ≥ freshness.offline_after_s |
| `geofence.radius_m` | `100` | organization | yes | system bounds 50–5,000 |
| `geofence.max_usable_accuracy_m` | `100` | organization | no | 20–500 |
| `geofence.outside_buffer_m` | `25` | organization | no | 0–200 |
| `geofence.departure_persistence_s` | `300` | organization | no | 60–1,800 |
| `geofence.departure_min_points` | `3` | organization | no | 2–10 |
| `geofence.return_accuracy_m` | `50` | organization | no |  |
| `checkpoint.radius_m` | `30` | organization | no | system bounds 10–500 |
| `checkpoint.max_fix_age_s` | `30` | organization | no | 5–120 |
| `checkpoint.max_usable_accuracy_m` | `50` | organization | no | 10–200 |
| `checkpoint.duplicate_window_s` | `300` | organization | no | 0–3,600 |
| `checkpoint.max_plausible_speed_mps` | `15` | organization | no | 2–50 |
| `patrol.count_unconfirmed_as_completed` | `true` | organization | no | D-17 |
| `patrol.treat_mock_as_unconfirmed` | `true` | organization | no |  |
| `alerts.reopen_suppression_s` | `120` | organization | no | 0–1,800 |
| `alerts.incident_high_enabled` | `true` | organization | no |  |
| `alerts.routing` | `{"CRITICAL":{"roles":["SUPERVISOR","DISPATCHER","ADMIN"],"channels":["DASHBOARD","WEB_PUSH"],"escalate":true},"HIGH":{"roles":["SUPERVISOR"],"channels":["DASHBOARD","WEB_PUSH"],"escalate":false},"MEDIUM":{"roles":[],"channels":["DASHBOARD"],"escalate":false},"LOW":{"roles":[],"channels":["DASHBOARD"],"escalate":false}}` | organization | yes | see PROD §12.5 |
| `sos.hold_duration_ms` | `3000` | system | no |  |
| `sos.escalation` | `{"steps":[{"atSeconds":0,"dashboardAlarm":true,"webPushTo":["SUPERVISOR","DISPATCHER","ADMIN"],"smsTo":["SUPERVISOR"],"smsEmergencyContacts":false},{"atSeconds":60,"dashboardAlarm":true,"webPushTo":["SUPERVISOR","DISPATCHER","ADMIN"],"smsTo":["ADMIN"],"smsEmergencyContacts":false},{"atSeconds":180,"dashboardAlarm":true,"webPushTo":["OWNER"],"smsTo":["OWNER"],"smsEmergencyContacts":true}],"repeatEverySeconds":120}` | organization | yes | PROD §11.4 |
| `sos.sms_include_coordinates` | `false` | organization | yes |  |
| `sos.emergency_contacts` | `[]` | organization | yes | phone numbers |
| `sos.emergency_call_number` | `null` | organization | yes | used by "Call supervisor" |
| `battery.low_alert_pct` | `15` | organization | no | 5–50 |
| `privacy.require_history_access_reason` | `false` | organization | yes | D-21 |
| `retention.location_days` | `90` | organization | yes | legal review |
| `retention.device_status_days` | `30` | organization | no |  |
| `retention.operational_months` | `12` | organization | no |  |
| `retention.audit_months` | `24` | organization | no | ≥ 12 |
| `retention.incident_evidence_window_minutes` | `30` | organization | no | location kept around incidents/SOS |
| `notifications.non_sos_sms_monthly_cap` | `3000` | organization | no | SOS never capped |
| `exports.max_range_days` | `92` | system | no |  |
