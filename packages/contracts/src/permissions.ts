// Role → permission map: the one implementation of the matrix in PROD §3.2 (SEC §6 rule 6).
// Code checks permission strings, never role names.

export const ROLES = ['OWNER', 'ADMIN', 'SUPERVISOR', 'DISPATCHER', 'GUARD'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  'org.settings.read': 'View organization profile and settings',
  'org.settings.write': 'Edit organization profile and settings',
  'owners.manage': 'Manage owners and administrators',
  'members.manage': 'Invite, disable and change the role of supervisors, dispatchers and guards',
  'guards.read': 'View guard profiles',
  'guards.write': 'Create, edit, disable and terminate guards; bulk import',
  'guards.read.own': 'View own guard profile',
  'devices.read': 'View devices',
  'devices.revoke': 'Revoke devices',
  'devices.enroll': 'Issue new-phone enrollment codes (D-31)',
  'devices.read.own': 'View own devices',
  'sites.read': 'View sites, geofences and checkpoints',
  'sites.write': 'Create and edit sites and geofences',
  'sites.read.assigned': 'View assigned sites (no QR data)',
  'checkpoints.write': 'Create and edit checkpoints; rotate QR codes',
  'checkpoints.qr.print': 'Print QR label sheets',
  'patrols.read': 'View patrol routes and schedules',
  'patrols.write': 'Create and edit patrol routes and schedules',
  'patrols.read.assigned': 'View assigned patrol routes',
  'shifts.read': 'View shifts',
  'shifts.write': 'Create, edit and cancel shifts',
  'shifts.supervise': 'Manual start, force-end, extend and reopen shifts',
  'shifts.read.own': 'View own shifts',
  'shifts.self': 'Start and end own shift',
  'live.read': 'Live map and live locations',
  'location.history.read': 'Location history and location exports (audited)',
  'location.history.read.own': 'Own location trail for own shifts (D-22)',
  'incidents.create': 'Create incidents',
  'incidents.read': 'View incidents',
  'incidents.read.own': 'View own incidents',
  'incidents.manage': 'Change incident status, severity and type',
  'incidents.acknowledge': 'Acknowledge incidents',
  'incidents.notes': 'Add notes to incidents',
  'incidents.notes.own': 'Add notes to own incidents',
  'alerts.read': 'View alerts',
  'alerts.acknowledge': 'Acknowledge alerts',
  'alerts.resolve': 'Resolve and dismiss alerts',
  'sos.activate': 'Activate SOS',
  'sos.read': 'View SOS events',
  'sos.read.own': 'View own SOS status',
  'sos.ack': 'Acknowledge SOS',
  'sos.resolve': 'Resolve SOS',
  'sos.drill': 'Start and stop SOS drills',
  'reports.read': 'Reports',
  'exports.create': 'CSV exports',
  'audit.read': 'Audit log',
} as const;

export type Permission = keyof typeof PERMISSIONS;

const GUARD: readonly Permission[] = [
  'guards.read.own',
  'devices.read.own',
  'sites.read.assigned',
  'patrols.read.assigned',
  'shifts.read.own',
  'shifts.self',
  'location.history.read.own',
  'incidents.create',
  'incidents.read.own',
  'incidents.notes.own',
  'sos.activate',
  'sos.read.own',
];

const DISPATCHER: readonly Permission[] = [
  'guards.read',
  'sites.read',
  'patrols.read',
  'shifts.read',
  'live.read',
  'incidents.read',
  'incidents.acknowledge',
  'incidents.notes',
  'alerts.read',
  'alerts.acknowledge',
  'sos.read',
  'sos.ack',
];

const SUPERVISOR: readonly Permission[] = [
  ...DISPATCHER,
  'devices.read',
  'devices.enroll',
  'shifts.write',
  'shifts.supervise',
  'location.history.read',
  'incidents.create',
  'incidents.manage',
  'alerts.resolve',
  'sos.resolve',
  'reports.read',
  'exports.create',
];

const ADMIN: readonly Permission[] = [
  ...SUPERVISOR,
  'org.settings.read',
  'members.manage',
  'guards.write',
  'devices.revoke',
  'sites.write',
  'checkpoints.write',
  'checkpoints.qr.print',
  'patrols.write',
  'sos.drill',
];

const OWNER: readonly Permission[] = [...ADMIN, 'org.settings.write', 'owners.manage', 'audit.read'];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  OWNER: new Set(OWNER),
  ADMIN: new Set(ADMIN),
  SUPERVISOR: new Set(SUPERVISOR),
  DISPATCHER: new Set(DISPATCHER),
  GUARD: new Set(GUARD),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
