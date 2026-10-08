import { describe, expect, it } from 'vitest';

import { hasPermission, PERMISSIONS, ROLE_PERMISSIONS, ROLES, type Permission } from '../src/permissions.ts';

describe('role → permission map (PROD §3.2)', () => {
  it('grants only known permissions', () => {
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toHaveProperty([permission]);
    }
  });

  it('keeps the owner-only capabilities with the owner', () => {
    const ownerOnly: Permission[] = ['owners.manage', 'audit.read', 'org.settings.write'];
    for (const permission of ownerOnly) {
      expect(ROLES.filter((role) => hasPermission(role, permission))).toEqual(['OWNER']);
    }
  });

  it('never lets dispatchers read location history or resolve alerts', () => {
    expect(hasPermission('DISPATCHER', 'location.history.read')).toBe(false);
    expect(hasPermission('DISPATCHER', 'alerts.resolve')).toBe(false);
  });

  it('gives guards only their own records, never organization-wide reads', () => {
    for (const permission of ROLE_PERMISSIONS.GUARD) {
      expect(['guards.read', 'live.read', 'incidents.read', 'alerts.read', 'shifts.read']).not.toContain(
        permission,
      );
    }
  });

  it('lets only guards start their own shift and activate SOS', () => {
    for (const permission of ['shifts.self', 'sos.activate'] as const) {
      expect(ROLES.filter((role) => hasPermission(role, permission))).toEqual(['GUARD']);
    }
  });
});
