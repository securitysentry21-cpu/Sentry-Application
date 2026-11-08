// Signing in (D-01; development sign-in, which the stack enables): a member of the company gets in and
// sees their company; a person who belongs to no company gets in to nothing, and never sees another
// company's guards. (Production signs in through the identity provider; this is the same app behind it.)
import { expect, test } from '@playwright/test';

import { signIn, state } from './support.ts';

test('a member of the company signs in and lands on the dashboard of their company', async ({ page }) => {
  const s = state();
  await signIn(page, s.ownerEmail);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText(s.orgName).first()).toBeVisible();
});

test('someone who belongs to no company is signed in to nothing and sees none of its data', async ({
  page,
}) => {
  const s = state();
  await signIn(page, 'stranger@nowhere.test');
  await expect(page.getByRole('heading', { name: 'No organization yet' })).toBeVisible();
  await expect(page.getByText(s.orgName)).toHaveCount(0);
  // Asking for the company's guards by address does not show them either.
  await page.goto('/guards');
  await expect(page.getByText(s.guard.name)).toHaveCount(0);
  await expect(page.getByText(s.orgName)).toHaveCount(0);
});
