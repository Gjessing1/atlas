import { expect, test } from '@playwright/test';
import { waitForMap } from './helpers';

// Account + sync journey against the backend's in-memory stores
// (DATABASE_URL=memory, see serve.sh). Skips when sync is not configured.
test('register, sync status, sign out', async ({ page, baseURL }) => {
  const health = (await (await fetch(`${baseURL}/api/health`)).json()) as { sync?: boolean };
  test.skip(!health.sync, 'sync not configured on this server');

  await page.goto('/');
  await waitForMap(page);
  await page.getByRole('button', { name: 'Settings' }).click();

  const create = page.getByRole('button', { name: 'Create account' });
  // Map readiness precedes OPFS/SQLite readiness on a cold browser. Wait for
  // the account adapter instead of racing a deliberately disabled submit.
  await expect(create).toBeEnabled();
  const email = `e2e-${Date.now()}@example.com`;
  await page.getByPlaceholder('email').fill(email);
  await page.getByPlaceholder('password').fill('secret-password');
  await create.click();

  await expect(page.locator('.account-line strong')).toHaveText(email);
  await expect(page.locator('.account-panel')).toContainText(/Synced|Signed in|Syncing/);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
});
