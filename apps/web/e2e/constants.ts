// Shared by the stack script (stack.ts, which runs as its own process) and the tests.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const WEB_PORT = 3100;
export const API_PORT = 4100;
export const CONTROL_PORT = 4199;
/** Where the stack writes what it seeded: the company, the people, the guard's phone session. */
export const STATE_FILE = join(tmpdir(), 'sentryops-e2e-state.json');

export type E2eState = {
  webOrigin: string;
  apiOrigin: string;
  orgId: string;
  orgName: string;
  ownerEmail: string;
  adminEmail: string;
  guard: { id: string; name: string };
  site: { id: string; name: string };
  shiftId: string;
  phone: { deviceId: string; accessToken: string; refreshToken: string };
};
