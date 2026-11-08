// Helpers shared by the browser tests: what the stack seeded, signing in through the real sign-in
// page, and the guard's phone doing what the guard app does (it talks to the API, not the browser).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { expect, type Page } from '@playwright/test';

import { type E2eState, STATE_FILE } from './constants.ts';

export const state = (): E2eState => JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2eState;

/** Development sign-in, as a person would: the e-mail field and the button. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
}

/** The guard presses SOS on the phone (POST /sos, signed in as the phone's own session). */
export async function pressSos(s: E2eState): Promise<string> {
  const res = await fetch(`${s.apiOrigin}/sos`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${s.phone.accessToken}`,
      'x-device-id': s.phone.deviceId,
      'x-app-version': '0.1.0',
    },
    body: JSON.stringify({
      clientEventId: randomUUID(),
      recordedAt: new Date().toISOString(),
      monoMs: 120_000,
      bootId: 'e2e-boot',
      fix: null,
      sentMonoMs: 120_050,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { sosEventId: string }).sosEventId;
}
