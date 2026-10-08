<!-- Generated from packages/contracts/src/permissions.ts by scripts/generate-docs.ts. Do not edit; run `pnpm docs:generate`. -->

# Permissions

The role → permission map that implements PROD §3.2. Code checks these strings, never role names.

| Permission | OWNER | ADMIN | SUPERVISOR | DISPATCHER | GUARD | Meaning |
|---|---|---|---|---|---|---|
| `org.settings.read` | ✔ | ✔ | – | – | – | View organization profile and settings |
| `org.settings.write` | ✔ | – | – | – | – | Edit organization profile and settings |
| `owners.manage` | ✔ | – | – | – | – | Manage owners and administrators |
| `members.manage` | ✔ | ✔ | – | – | – | Invite, disable and change the role of supervisors, dispatchers and guards |
| `guards.read` | ✔ | ✔ | ✔ | ✔ | – | View guard profiles |
| `guards.write` | ✔ | ✔ | – | – | – | Create, edit, disable and terminate guards; bulk import |
| `guards.read.own` | – | – | – | – | ✔ | View own guard profile |
| `devices.read` | ✔ | ✔ | ✔ | – | – | View devices |
| `devices.revoke` | ✔ | ✔ | – | – | – | Revoke devices |
| `devices.enroll` | ✔ | ✔ | ✔ | – | – | Issue new-phone enrollment codes (D-31) |
| `devices.read.own` | – | – | – | – | ✔ | View own devices |
| `sites.read` | ✔ | ✔ | ✔ | ✔ | – | View sites, geofences and checkpoints |
| `sites.write` | ✔ | ✔ | – | – | – | Create and edit sites and geofences |
| `sites.read.assigned` | – | – | – | – | ✔ | View assigned sites (no QR data) |
| `checkpoints.write` | ✔ | ✔ | – | – | – | Create and edit checkpoints; rotate QR codes |
| `checkpoints.qr.print` | ✔ | ✔ | – | – | – | Print QR label sheets |
| `patrols.read` | ✔ | ✔ | ✔ | ✔ | – | View patrol routes and schedules |
| `patrols.write` | ✔ | ✔ | – | – | – | Create and edit patrol routes and schedules |
| `patrols.read.assigned` | – | – | – | – | ✔ | View assigned patrol routes |
| `shifts.read` | ✔ | ✔ | ✔ | ✔ | – | View shifts |
| `shifts.write` | ✔ | ✔ | ✔ | – | – | Create, edit and cancel shifts |
| `shifts.supervise` | ✔ | ✔ | ✔ | – | – | Manual start, force-end, extend and reopen shifts |
| `shifts.read.own` | – | – | – | – | ✔ | View own shifts |
| `shifts.self` | – | – | – | – | ✔ | Start and end own shift |
| `live.read` | ✔ | ✔ | ✔ | ✔ | – | Live map and live locations |
| `location.history.read` | ✔ | ✔ | ✔ | – | – | Location history and location exports (audited) |
| `location.history.read.own` | – | – | – | – | ✔ | Own location trail for own shifts (D-22) |
| `incidents.create` | ✔ | ✔ | ✔ | – | ✔ | Create incidents |
| `incidents.read` | ✔ | ✔ | ✔ | ✔ | – | View incidents |
| `incidents.read.own` | – | – | – | – | ✔ | View own incidents |
| `incidents.manage` | ✔ | ✔ | ✔ | – | – | Change incident status, severity and type |
| `incidents.acknowledge` | ✔ | ✔ | ✔ | ✔ | – | Acknowledge incidents |
| `incidents.notes` | ✔ | ✔ | ✔ | ✔ | – | Add notes to incidents |
| `incidents.notes.own` | – | – | – | – | ✔ | Add notes to own incidents |
| `alerts.read` | ✔ | ✔ | ✔ | ✔ | – | View alerts |
| `alerts.acknowledge` | ✔ | ✔ | ✔ | ✔ | – | Acknowledge alerts |
| `alerts.resolve` | ✔ | ✔ | ✔ | – | – | Resolve and dismiss alerts |
| `sos.activate` | – | – | – | – | ✔ | Activate SOS |
| `sos.read` | ✔ | ✔ | ✔ | ✔ | – | View SOS events |
| `sos.read.own` | – | – | – | – | ✔ | View own SOS status |
| `sos.ack` | ✔ | ✔ | ✔ | ✔ | – | Acknowledge SOS |
| `sos.resolve` | ✔ | ✔ | ✔ | – | – | Resolve SOS |
| `sos.drill` | ✔ | ✔ | – | – | – | Start and stop SOS drills |
| `reports.read` | ✔ | ✔ | ✔ | – | – | Reports |
| `exports.create` | ✔ | ✔ | ✔ | – | – | CSV exports |
| `audit.read` | ✔ | – | – | – | – | Audit log |
