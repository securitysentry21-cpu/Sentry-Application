// The phone tells the server its Firebase token (D-26), so "SOS acknowledged" and shift notices can
// reach it: once after enrollment, again when the token changes, the phone is enrolled again, or a
// day has passed; quietly retried when it fails; and never a reason for anything else to fail.
import { describe, expect, it } from 'vitest';

import { REREGISTER_AFTER_MS, tokenHash } from '../src/core/push/registrar.ts';
import { META_KEYS } from '../src/core/storage/meta.ts';
import { FakePush, fixAt } from './support/fakes.ts';
import { GUARD_A, SHIFT_1 } from './support/fake-server.ts';
import { makeApp, PHONE, readyGuard, settle, tempDbPath } from './support/harness.ts';
import { fileDatabase } from './support/sqlite.ts';

const PUSH_PATH = '/api/v1/me/push-token';
const TOKEN_A = `fcm-${'a'.repeat(40)}`;
const TOKEN_B = `fcm-${'b'.repeat(40)}`;

describe('registering the push token', () => {
  it('after enrollment the server has this phone’s token, under this phone’s own device', async () => {
    const h = await makeApp();
    await readyGuard(h);
    await settle();
    const deviceId = h.app.snapshot().identity?.deviceId;
    expect(deviceId).toBeTruthy();
    expect(h.server.pushTokens).toEqual([{ deviceId, token: TOKEN_A }]);
  });

  it('does not send it again while nothing changed, and sends it again after a day', async () => {
    const h = await makeApp();
    await readyGuard(h);
    await settle();
    await h.app.onForeground();
    await h.app.onForeground();
    expect(h.server.pushTokens).toHaveLength(1);

    h.clocks.advance(REREGISTER_AFTER_MS + 1_000);
    await h.app.onForeground();
    expect(h.server.pushTokens).toHaveLength(2);
  });

  it('a new token from the system is registered at once', async () => {
    const h = await makeApp();
    await readyGuard(h);
    await settle();
    h.push.refresh(TOKEN_B);
    await settle();
    expect(h.server.pushTokens.map((p) => p.token)).toEqual([TOKEN_A, TOKEN_B]);
  });

  it('a phone enrolled again is a new device on the server and registers again, even with the same token', async () => {
    const h = await makeApp();
    await readyGuard(h);
    await settle();
    h.server.addEnrollment('SECOND-CODE1', PHONE, GUARD_A);
    const again = await h.app.enroll({ code: 'SECOND-CODE1', phone: PHONE, confirmDataLoss: true });
    expect(again.kind).toBe('OK');
    await settle();
    const devices = h.server.pushTokens.map((p) => p.deviceId);
    expect(devices).toHaveLength(2);
    expect(new Set(devices).size).toBe(2);
  });

  it('without a token (no Firebase file in this build, or no Google services) nothing is sent and nothing breaks', async () => {
    const push = new FakePush();
    push.token = null;
    const h = await makeApp({ push });
    await readyGuard(h);
    await settle();
    await h.app.onForeground();
    expect(h.server.requests.some((r) => r.path === PUSH_PATH)).toBe(false);
    // A shift still starts and tracks.
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await h.app.onLocations([fixAt(h.clocks.wall.nowMs())]);
    await settle();
    await h.app.flush({ urgent: true });
    expect([...h.server.stored.values()].some((i) => i.type === 'LOCATION')).toBe(true);
  });

  it('a failure is retried the next time the app is in front, and never thrown at the screens', async () => {
    const h = await makeApp();
    h.server.pathModes.set(PUSH_PATH, { kind: 'offline' });
    await readyGuard(h);
    await settle();
    expect(h.server.pushTokens).toHaveLength(0);

    h.server.pathModes.set(PUSH_PATH, { kind: 'status', status: 503, code: 'NOT_READY' });
    await h.app.onForeground();
    expect(h.server.pushTokens).toHaveLength(0);

    h.server.pathModes.delete(PUSH_PATH);
    await h.app.onForeground();
    expect(h.server.pushTokens).toHaveLength(1);
  });

  it('keeps only a hash of the token on the phone, never the token', async () => {
    const path = tempDbPath();
    const h = await makeApp({ dbPath: path });
    await readyGuard(h);
    await settle();
    await h.app.close();
    const db = fileDatabase(path);
    const row = await db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
      META_KEYS.pushRegistered,
    ]);
    await db.close();
    expect(row?.value).toContain(tokenHash(TOKEN_A));
    expect(row?.value).not.toContain(TOKEN_A);
    expect(h.lines.map((l) => JSON.stringify(l)).join('')).not.toContain(TOKEN_A);
  });
});
