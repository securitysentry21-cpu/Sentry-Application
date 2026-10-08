// A whole guard app (src/core/app.ts) wired to fakes: an in-memory or on-disk SQLite, a memory
// secure store, a fake location source and device, and the fake API server.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GuardApp } from '../../src/core/app.ts';
import type { Scheduler } from '../../src/core/sos/lane.ts';
import type { SqlDatabase } from '../../src/core/storage/sql.ts';
import { ManualClocks } from '../../src/core/time.ts';
import { capturingLogger, cryptoRandom, FakeDevice, FakeLocation, fixAt, MemoryKV } from './fakes.ts';
import { FakeServer, GUARD_A, SHIFT_1, testShift } from './fake-server.ts';
import { fileDatabase, memoryDatabase } from './sqlite.ts';

export const T0 = Date.parse('2026-10-08T15:00:00.000Z');
export const PHONE = '+923001234567';

/** SOS retry timers are collected instead of firing, so tests decide when time passes. */
export class ManualScheduler {
  tasks: { task: () => void; delayMs: number }[] = [];
  readonly schedule: Scheduler = (task, delayMs) => {
    const entry = { task, delayMs };
    this.tasks.push(entry);
    return () => {
      this.tasks = this.tasks.filter((t) => t !== entry);
    };
  };
}

export type Harness = {
  app: GuardApp;
  server: FakeServer;
  clocks: ManualClocks;
  kv: MemoryKV;
  location: FakeLocation;
  device: FakeDevice;
  scheduler: ManualScheduler;
  lines: ReturnType<typeof capturingLogger>['lines'];
  dbPath: string | null;
};

export type HarnessOptions = {
  clocks?: ManualClocks;
  server?: FakeServer;
  kv?: MemoryKV;
  location?: FakeLocation;
  device?: FakeDevice;
  /** Use an on-disk database (to simulate the app being killed and reopened). */
  dbPath?: string | null;
};

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'sentry-app-')), 'outbox.db');
}

export async function makeApp(options: HarnessOptions = {}): Promise<Harness> {
  const clocks = options.clocks ?? new ManualClocks(T0, 'run-1', 10_000);
  const server = options.server ?? new FakeServer(() => clocks.realMs());
  const kv = options.kv ?? new MemoryKV();
  const location = options.location ?? new FakeLocation();
  const device = options.device ?? new FakeDevice();
  const scheduler = new ManualScheduler();
  const { logger, lines } = capturingLogger();
  const dbPath = options.dbPath ?? null;
  const app = new GuardApp({
    openDatabase: (): Promise<SqlDatabase> =>
      Promise.resolve(dbPath ? fileDatabase(dbPath) : memoryDatabase()),
    secure: kv,
    transport: server.transport,
    location,
    device,
    runtime: { variant: 'development', apiBaseUrl: 'http://10.0.2.2:4000' },
    appVersion: '0.1.0',
    clocks,
    random: cryptoRandom,
    random01: () => 0.5,
    logger,
    schedule: scheduler.schedule,
  });
  await app.start();
  return { app, server, clocks, kv, location, device, scheduler, lines, dbPath };
}

/** Language chosen, phone enrolled, disclosure accepted, today's shift known: ready to start. */
export async function readyGuard(
  h: Harness,
  options: { guardId?: string; code?: string } = {},
): Promise<void> {
  const code = options.code ?? 'K7Q4-M9XP';
  h.server.addEnrollment(code, PHONE, options.guardId ?? GUARD_A);
  if (h.server.shifts.length === 0) h.server.shifts = [testShift(SHIFT_1, h.clocks.realMs() - 5 * 60_000)];
  await h.app.setLocale('en');
  const result = await h.app.enroll({ code, phone: '0300 1234567', confirmDataLoss: true });
  if (result.kind !== 'OK') throw new Error(`enrollment failed: ${JSON.stringify(result)}`);
  await h.app.refresh();
  await h.app.acceptDisclosure();
  h.location.nextFix = fixAt(h.clocks.wall.nowMs());
}

/** Lets queued promise callbacks run (the app starts some uploads without awaiting them). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}
