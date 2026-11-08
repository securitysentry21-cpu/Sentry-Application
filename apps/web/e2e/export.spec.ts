// A CSV export end to end (PROD §15.2, ADV-W02): asked for on the Reports page, built in the
// background by the worker, listed on the Exports page, and downloaded through a short-lived link.
// The file opens correctly in a spreadsheet (UTF-8 with a byte order mark) and holds the guard.
import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { signIn, state } from './support.ts';

test('an attendance report is exported, built in the background, and downloads as a safe CSV', async ({
  page,
}) => {
  const s = state();
  await signIn(page, s.adminEmail);

  await page.goto('/reports');
  await expect(page.getByRole('cell', { name: new RegExp(s.guard.name) }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Export CSV' }).click();

  // The worker builds it; the Exports page shows it ready.
  await page.goto('/exports');
  const row = page.getByRole('row').filter({ hasText: 'Requested by' }).first();
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: 'Download' })).toBeVisible({ timeout: 60_000 });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    row.getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
  const bytes = readFileSync(await download.path());
  // UTF-8 byte order mark first, so a spreadsheet reads Urdu names correctly.
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(bytes.toString('utf8')).toContain(s.guard.name);
});
