import { test, expect } from '@playwright/test';

// ─── Helpers ────────────────────────────────────────────────────────

const METERING_URL = '/dashboard/metering';
const ADMIN_KEY = 'test-admin-secret-key-12345';

/** Set admin key in localStorage and reload onto the given page. */
async function setupAuth(page: import('@playwright/test').Page, url: string) {
	await page.goto(url);
	await page.evaluate((key) => localStorage.setItem('adminKey', key), ADMIN_KEY);
	await page.goto(url);
}

// ─── Metering API smoke (real wrangler-dev asset layer + worker) ────

test.describe('Metering — admin API smoke', () => {
	test('GET /admin/metering returns a cross-surface result array', async ({ request }) => {
		const res = await request.get('/admin/metering', { headers: { 'X-Admin-Key': ADMIN_KEY } });
		expect(res.ok()).toBeTruthy();
		const data = (await res.json()) as any;
		expect(data.success).toBeTruthy();
		expect(Array.isArray(data.result)).toBeTruthy();
	});

	test('GET /admin/supabase/analytics/metering?group_by=project returns a per-surface result array', async ({ request }) => {
		const res = await request.get('/admin/supabase/analytics/metering?group_by=project', {
			headers: { 'X-Admin-Key': ADMIN_KEY },
		});
		expect(res.ok()).toBeTruthy();
		const data = (await res.json()) as any;
		expect(data.success).toBeTruthy();
		expect(Array.isArray(data.result)).toBeTruthy();
	});
});

// ─── Metering UI: standalone page mounts the panel ──────────────────

test.describe('Metering - dashboard page', () => {
	test('the /dashboard/metering page mounts the MeteringPanel', async ({ page }) => {
		await setupAuth(page, METERING_URL);

		// MeteringPanel always renders its surface selector, regardless of data:
		// the first surface button is "All (cross-surface)".
		await expect(page.getByRole('button', { name: 'All (cross-surface)' })).toBeVisible();
	});
});
