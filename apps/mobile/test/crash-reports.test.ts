// Crash reports from the guard app (ARCH §18.6; owner decision 2026-11-02: our own server only;
// SEC §11, §15: no location, tokens, incident text or personal data in crash reports).
import { appErrorReportSchema, MAX_APP_ERROR_FRAMES } from '@sentryops/contracts';
import { describe, expect, it } from 'vitest';

import { buildAppErrorReport, errorName, parseStack } from '../src/core/diagnostics/crash-report.ts';
import { MAX_QUEUED_REPORTS } from '../src/core/diagnostics/crash-reporter.ts';
import { fixAt } from './support/fakes.ts';
import { SHIFT_1 } from './support/fake-server.ts';
import { makeApp, readyGuard, settle, tempDbPath, T0 } from './support/harness.ts';

const input = (error: unknown, overrides: Record<string, unknown> = {}) => ({
  kind: 'UNHANDLED_ERROR' as const,
  fatal: false,
  error,
  occurredAtMs: T0,
  appVersion: '0.1.0',
  platform: 'ANDROID' as const,
  osVersion: '14',
  ...overrides,
});

describe('building a report (no message, no free text)', () => {
  it("keeps the error's class name and never its message", () => {
    const error = new TypeError('Cannot find guard Ahmed Khan at 24.8607, 67.0011 (+923001234567)');
    const report = buildAppErrorReport(input(error));
    expect(report).not.toBeNull();
    expect(report?.errorName).toBe('TypeError');
    const text = JSON.stringify(report);
    for (const secret of ['Ahmed', 'Khan', '24.8607', '67.0011', '923001234567', 'Cannot find']) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('names whatever was thrown without reading it: strings, objects, null', () => {
    expect(errorName('Secret words in a thrown string')).toBe('ThrownValue');
    expect(errorName({ message: 'Secret', lat: 24.86 })).toBe('ThrownObject');
    expect(errorName(null)).toBe('ThrownObject');
    expect(errorName(undefined)).toBe('ThrownValue');
    const odd = new Error('x');
    odd.name = 'back gate 3 was open';
    expect(errorName(odd)).toBe('back_gate_3_was_open');
    odd.name = '9lives';
    expect(errorName(odd)).toBe('E9lives');
  });

  it('reads Hermes, V8 and JavaScriptCore frames, keeping the function, the file base name and the position', () => {
    const stack = [
      'TypeError: Secret message that must not survive',
      '    at syncOnce (address at index.android.bundle:1:48213)',
      '    at async flush (http://10.0.2.2:8081/index.bundle?platform=android&dev=true:230:15)',
      '    at new SyncEngine (/data/user/0/pk.sentryops.guard/files/Ahmed Khan/engine.js:12:7)',
      '    at anonymous (index.android.bundle:1:99)',
      '    at index.android.bundle:1:5',
      'loop@file:///app/src/core/loop.js:3:9',
      '@file:///app/src/core/lonely.js:4:2',
      'not a frame at all',
    ].join('\n');
    expect(parseStack(stack)).toEqual([
      { fn: 'syncOnce', file: 'index.android.bundle', line: 1, column: 48213 },
      { fn: 'flush', file: 'index.bundle', line: 230, column: 15 },
      { fn: 'SyncEngine', file: 'engine.js', line: 12, column: 7 },
      { fn: 'anonymous', file: 'index.android.bundle', line: 1, column: 99 },
      { fn: 'anonymous', file: 'index.android.bundle', line: 1, column: 5 },
      { fn: 'loop', file: 'loop.js', line: 3, column: 9 },
      { fn: 'anonymous', file: 'lonely.js', line: 4, column: 2 },
    ]);
    expect(JSON.stringify(parseStack(stack))).not.toContain('Secret');
    expect(JSON.stringify(parseStack(stack))).not.toContain('Ahmed');
  });

  it('turns every character outside the allow-list into "_" and cuts to the limits, whatever the stack says', () => {
    const hostile = [
      `    at Guard "Ahmed Khan" saw {intruder} (/x/y/Secret File ; rm -rf.js:7:7)`,
      `    at ${'a'.repeat(300)} (${'b'.repeat(300)}.js:1:1)`,
      ...Array.from({ length: 40 }, (_, i) => `    at f${i} (a.js:${i}:1)`),
    ].join('\n');
    const frames = parseStack(hostile);
    expect(frames).toHaveLength(MAX_APP_ERROR_FRAMES);
    expect(frames[0]).toEqual({
      fn: 'Guard__Ahmed_Khan__saw__intruder_',
      file: 'Secret_File___rm_-rf.js',
      line: 7,
      column: 7,
    });
    expect(frames[1]?.fn).toHaveLength(80);
    expect(frames[1]?.file).toHaveLength(80);
    const error = new Error('m');
    error.stack = hostile;
    const report = buildAppErrorReport(input(error));
    // Whatever the stack held, what comes out fits the contract the server enforces.
    expect(appErrorReportSchema.safeParse(report).success).toBe(true);
  });

  it('is null rather than invalid: a version or time that cannot fit sends nothing', () => {
    expect(buildAppErrorReport(input(new Error('x'), { occurredAtMs: Number.NaN }))).toBeNull();
  });

  it('an unexpected close carries no error and no frames', () => {
    const report = buildAppErrorReport(
      input(new Error('ignored'), { kind: 'UNEXPECTED_CLOSE', fatal: true }),
    );
    expect(report).toMatchObject({
      kind: 'UNEXPECTED_CLOSE',
      errorName: 'UnexpectedClose',
      frames: [],
      fatal: true,
    });
  });
});

describe('the app reporting its own errors', () => {
  it('sends a report to our own server, scrubbed, with the session; development builds send nothing', async () => {
    const dev = await makeApp();
    await readyGuard(dev);
    await dev.app.reportError('UNHANDLED_ERROR', new Error('Secret'), false);
    expect(dev.server.appErrors).toHaveLength(0);
    expect(dev.server.requests.some((r) => r.path.includes('diagnostics'))).toBe(false);

    const h = await makeApp({ crashReports: true });
    await readyGuard(h);
    const error = new RangeError('Secret message with 24.8607');
    error.stack =
      'RangeError: Secret message with 24.8607\n    at upload (address at index.android.bundle:1:777)';
    await h.app.reportError('UNHANDLED_ERROR', error, true);
    expect(h.server.appErrors).toEqual([
      {
        kind: 'UNHANDLED_ERROR',
        fatal: true,
        occurredAt: new Date(h.clocks.wall.nowMs()).toISOString(),
        errorName: 'RangeError',
        frames: [{ fn: 'upload', file: 'index.android.bundle', line: 1, column: 777 }],
        appVersion: '0.1.0',
        platform: 'ANDROID',
        osVersion: h.device.info.osVersion,
      },
    ]);
    expect(JSON.stringify(h.server.requests)).not.toContain('Secret');
    expect(h.lines.map((l) => JSON.stringify(l)).join('')).not.toContain('Secret');
  });

  it('keeps the report until the server can be reached, then sends it once', async () => {
    const h = await makeApp({ crashReports: true });
    await readyGuard(h);
    h.server.pathModes.set('/api/v1/diagnostics/app-errors', { kind: 'offline' });
    await h.app.reportError('RENDER_ERROR', new Error('x'), false);
    expect(h.server.appErrors).toHaveLength(0);
    h.server.pathModes.delete('/api/v1/diagnostics/app-errors');
    await h.app.onForeground();
    expect(h.server.appErrors.map((r) => r.kind)).toEqual(['RENDER_ERROR']);
    await h.app.onForeground();
    expect(h.server.appErrors).toHaveLength(1);
  });

  it('drops a report the server refuses, because the same report would be refused again', async () => {
    const h = await makeApp({ crashReports: true });
    await readyGuard(h);
    h.server.pathModes.set('/api/v1/diagnostics/app-errors', {
      kind: 'status',
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    await h.app.reportError('RENDER_ERROR', new Error('x'), false);
    h.server.pathModes.delete('/api/v1/diagnostics/app-errors');
    await h.app.onForeground();
    expect(h.server.appErrors).toHaveLength(0);
    const calls = h.server.requests.filter((r) => r.path === '/api/v1/diagnostics/app-errors');
    expect(calls).toHaveLength(1);
  });

  it('a crash loop is one report a minute, and a long outage keeps only the newest reports', async () => {
    const h = await makeApp({ crashReports: true });
    await readyGuard(h);
    h.server.pathModes.set('/api/v1/diagnostics/app-errors', { kind: 'offline' });
    for (let i = 0; i < 50; i++) await h.app.reportError('UNHANDLED_ERROR', new Error('same'), false);
    h.clocks.advance(61_000);
    await h.app.reportError('UNHANDLED_ERROR', new Error('same'), false);
    h.server.pathModes.delete('/api/v1/diagnostics/app-errors');
    await h.app.onForeground();
    expect(h.server.appErrors).toHaveLength(2);

    // Different errors each time, offline for long: the queue is bounded.
    h.server.pathModes.set('/api/v1/diagnostics/app-errors', { kind: 'offline' });
    for (let i = 0; i < MAX_QUEUED_REPORTS + 10; i++) {
      const error = new Error('x');
      error.name = `Error${i}`;
      await h.app.reportError('UNHANDLED_ERROR', error, false);
    }
    h.server.pathModes.delete('/api/v1/diagnostics/app-errors');
    h.server.appErrors.length = 0;
    await h.app.onForeground();
    expect(h.server.appErrors).toHaveLength(MAX_QUEUED_REPORTS);
    expect(h.server.appErrors.at(-1)?.errorName).toBe(`Error${MAX_QUEUED_REPORTS + 9}`);
  });
});

describe('noticing a run that ended unexpectedly', () => {
  it('the next run reports that the last one stopped while the app was in front', async () => {
    const path = tempDbPath();
    const first = await makeApp({ crashReports: true, dbPath: path });
    await readyGuard(first);
    first.clocks.advance(5 * 60_000);
    await first.app.onForeground();
    const lastSeen = first.clocks.wall.nowMs();
    await settle();
    await first.app.close(); // the process dies: no clean close

    const second = await makeApp({
      crashReports: true,
      dbPath: path,
      kv: first.kv,
      server: first.server,
      clocks: first.clocks,
    });
    await second.app.onForeground();
    expect(first.server.appErrors).toEqual([
      expect.objectContaining({
        kind: 'UNEXPECTED_CLOSE',
        fatal: true,
        errorName: 'UnexpectedClose',
        frames: [],
        occurredAt: new Date(lastSeen).toISOString(),
      }),
    ]);
  });

  it('going to the background, or a clean close, is not a crash; neither is the very first run', async () => {
    const path = tempDbPath();
    const first = await makeApp({ crashReports: true, dbPath: path });
    await readyGuard(first);
    await first.app.onBackground();
    await settle();
    await first.app.close();
    const second = await makeApp({
      crashReports: true,
      dbPath: path,
      kv: first.kv,
      server: first.server,
      clocks: first.clocks,
    });
    await second.app.onForeground();
    expect(first.server.appErrors).toHaveLength(0);

    // Back in front, then killed: now it is a crash.
    await settle();
    await second.app.close();
    const third = await makeApp({
      crashReports: true,
      dbPath: path,
      kv: first.kv,
      server: first.server,
      clocks: first.clocks,
    });
    await third.app.onForeground();
    expect(first.server.appErrors.map((r) => r.kind)).toEqual(['UNEXPECTED_CLOSE']);
  });

  it('reporting does not disturb a shift: a whole shift with an error in the middle still uploads its points', async () => {
    const h = await makeApp({ crashReports: true });
    await readyGuard(h);
    expect((await h.app.startShift(SHIFT_1)).kind).toBe('OK');
    await h.app.onLocations([fixAt(h.clocks.wall.nowMs())]);
    await h.app.reportError('RENDER_ERROR', new Error('x'), false);
    await settle();
    await h.app.flush({ urgent: true });
    expect([...h.server.stored.values()].some((i) => i.type === 'LOCATION')).toBe(true);
    expect(h.server.appErrors).toHaveLength(1);
  });
});
