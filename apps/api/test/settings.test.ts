import { defaultSettings } from '@sentryops/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { call, errorCode, seedOrganization, signIn, startTestApp, type TestApp } from './support.ts';

let t: TestApp;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let owner: string;
let admin: string;

beforeAll(async () => {
  t = await startTestApp();
  org = await seedOrganization(t.db, 'Settings Co', [
    { email: 'owner@set.test', role: 'OWNER' },
    { email: 'admin@set.test', role: 'ADMIN' },
  ]);
  owner = await signIn(t.app, 'owner@set.test');
  admin = await signIn(t.app, 'admin@set.test');
});

afterAll(async () => {
  await t?.close();
});

type SettingsBody = { settings: Record<string, unknown>; editableKeys: string[]; version: number };
const get = async (cookie: string) =>
  (await call(t.app, { method: 'GET', url: '/api/v1/settings', cookie, org: org.id })).json<SettingsBody>();
const patch = (cookie: string, changes: Record<string, unknown>, version: number) =>
  call(t.app, { method: 'PATCH', url: '/api/v1/settings', cookie, org: org.id, body: { changes, version } });

describe('organization settings (PROD §8.3, Appendix B)', () => {
  it('reads the defaults, and only owners may edit', async () => {
    const asAdmin = await get(admin);
    expect(asAdmin.settings).toEqual(defaultSettings());
    expect(asAdmin.editableKeys).toEqual([]);
    expect((await patch(admin, { 'geofence.radius_m': 150 }, asAdmin.version)).statusCode).toBe(403);
    expect((await get(owner)).editableKeys).toContain('geofence.radius_m');
  });

  it('a valid change is saved, versioned and audited; a stale version conflicts', async () => {
    const before = await get(owner);
    const res = await patch(owner, { 'geofence.radius_m': 150 }, before.version);
    expect(res.statusCode).toBe(200);
    expect((await get(owner)).settings['geofence.radius_m']).toBe(150);
    expect(errorCode(await patch(owner, { 'geofence.radius_m': 160 }, before.version))).toBe(
      'VERSION_CONFLICT',
    );
    const audit = await call(t.app, { method: 'GET', url: '/api/v1/audit-logs', cookie: owner, org: org.id });
    const entry = audit
      .json<{ entries: { action: string; metadata: Record<string, unknown> }[] }>()
      .entries.find((e) => e.action === 'SETTINGS_CHANGED');
    expect(entry?.metadata).toEqual({ changes: { 'geofence.radius_m': { from: 100, to: 150 } } });
  });

  it('out-of-range values, non-editable keys and broken cross-field rules are refused', async () => {
    const { version } = await get(owner);
    expect(errorCode(await patch(owner, { 'geofence.radius_m': 10 }, version))).toBe('VALIDATION_FAILED');
    expect(errorCode(await patch(owner, { 'sync.heartbeat_interval_s': 30 }, version))).toBe(
      'VALIDATION_FAILED',
    );
    // missed_after must stay ≥ late_alert_after (PROD §8.3).
    expect(
      errorCode(
        await patch(
          owner,
          { 'shift.late_alert_after_minutes': 120, 'shift.missed_after_minutes': 60 },
          version,
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    expect((await get(owner)).version).toBe(version);
  });

  it('phone-number settings are audited as changed, never by value (SEC §17.2)', async () => {
    const { version } = await get(owner);
    const res = await patch(owner, { 'sos.emergency_contacts': ['+923001234567'] }, version);
    expect(res.statusCode).toBe(200);
    const audit = await call(t.app, { method: 'GET', url: '/api/v1/audit-logs', cookie: owner, org: org.id });
    expect(audit.body).not.toContain('+923001234567');
  });
});
