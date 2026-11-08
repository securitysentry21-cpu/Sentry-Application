// An SOS end to end (PROD §11, INV-10): the guard presses it on the phone; every open dashboard shows
// the full-screen alarm; someone acknowledges it; the SOS page shows what the server can confirm;
// someone resolves it with a reason and a note, and the dashboard goes quiet again.
import { expect, test } from '@playwright/test';

import { pressSos, signIn, state } from './support.ts';

test('an SOS arrives with its alarm, is acknowledged, and is resolved', async ({ page }) => {
  const s = state();
  await signIn(page, s.adminEmail);

  // The guard presses SOS on the phone while the dashboard is open.
  const sosEventId = await pressSos(s);

  const alarm = page.getByRole('alertdialog');
  await expect(alarm).toBeVisible();
  await expect(alarm).toContainText('SOS alarm');
  await expect(alarm).toContainText(s.guard.name);
  await expect(alarm).toContainText(s.site.name);

  // Acknowledging stops the alarm and the escalation.
  await alarm.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(alarm).toBeHidden();

  // The SOS page: acknowledged by someone, then resolved with a reason and a note.
  await page.goto(`/sos/${sosEventId}`);
  await expect(page.getByRole('heading', { name: /SOS/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Acknowledge SOS' })).toHaveCount(0);
  await page.getByLabel('What it was').selectOption({ label: 'Genuine emergency' });
  await page.getByLabel('Note (required)').fill('Guard reached by phone; a supervisor attended.');
  await page.getByRole('button', { name: 'Resolve SOS' }).click();
  await expect(page.getByText('Genuine emergency').first()).toBeVisible();
  await expect(page.getByText('Guard reached by phone; a supervisor attended.')).toBeVisible();

  // Back on the dashboard nothing is sounding.
  await page.goto('/dashboard');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
