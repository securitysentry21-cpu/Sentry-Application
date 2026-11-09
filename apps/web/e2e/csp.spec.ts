// SEC §10, review L-01: the dashboard works under its strict Content-Security-Policy. A signed-in
// person opens the dashboard and the live map (MapLibre, its worker and the tile host) and the browser
// refuses nothing. The stack runs `next dev`, whose policy differs from production's only by
// 'unsafe-eval' (lib/csp.ts); a production build is checked by hand in the review report.
import { expect, test } from '@playwright/test';

import { signIn, state } from './support.ts';

test('the dashboard and the live map run under the Content-Security-Policy with nothing refused', async ({
  page,
}) => {
  const refused: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP refused ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page.on('console', (message) => {
    if (/CSP refused|Content Security Policy/i.test(message.text())) refused.push(message.text());
  });

  await signIn(page, state().ownerEmail);
  const dashboard = await page.goto('/dashboard');
  const policy = dashboard?.headers()['content-security-policy'] ?? '';
  expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("frame-ancestors 'none'");

  await page.goto('/live');
  await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
  // Let the worker start and the style and tiles load (or fail for want of network, which is not a refusal).
  await page.waitForTimeout(3_000);
  expect(refused).toEqual([]);
});
