import { test, expect } from '@playwright/test';

// ─── Helpers ────────────────────────────────────────────────────────

const TOKENS_URL = '/dashboard/upstream-tokens';
const KEYS_URL = '/dashboard/keys';
const ADMIN_KEY = 'test-admin-secret-key-12345';

/** Set admin key in localStorage and reload onto the given page. */
async function setupAuth(page: import('@playwright/test').Page, url: string) {
	await page.goto(url);
	await page.evaluate((key) => localStorage.setItem('adminKey', key), ADMIN_KEY);
	await page.goto(url);
}

/** Create an upstream token of the given scope via the admin API (validation skipped). */
async function createToken(
	request: import('@playwright/test').APIRequestContext,
	opts: { name: string; scope_type: 'zone' | 'account' | 'supabase' | 'supabase_metrics'; zone_ids?: string[] },
) {
	const headers = { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY };
	const isMetrics = opts.scope_type === 'supabase_metrics';
	const res = await request.post('/admin/upstream-tokens', {
		headers,
		data: {
			name: opts.name,
			token: 'fake_credential_1234567890abcdef',
			scope_type: opts.scope_type,
			zone_ids: opts.zone_ids ?? ['*'],
			validate: false,
			...(isMetrics && { auth_type: 'basic', username: 'service_role' }),
		},
	});
	expect(res.ok()).toBeTruthy();
	const data = (await res.json()) as any;
	expect(data.success).toBeTruthy();
	return data.result.id as string;
}

/** Create an API key bound to a Supabase upstream token and return its key id. */
async function createSupabaseKey(request: import('@playwright/test').APIRequestContext, upstreamTokenId: string, name: string) {
	const headers = { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY };
	const res = await request.post('/admin/keys', {
		headers,
		data: {
			name,
			upstream_token_id: upstreamTokenId,
			policy: {
				version: '2025-01-01',
				statements: [
					{
						effect: 'allow',
						actions: ['supabase:projects:read'],
						resources: ['supabase:account'],
					},
				],
			},
		},
	});
	expect(res.ok()).toBeTruthy();
	const data = (await res.json()) as any;
	expect(data.success).toBeTruthy();
	return data.result.key.id as string;
}

/** Poll Supabase analytics until an event for the given key id is visible. */
async function waitForSupabaseEvent(request: import('@playwright/test').APIRequestContext, keyId: string) {
	const headers = { 'X-Admin-Key': ADMIN_KEY };
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const res = await request.get(`/admin/supabase/analytics/events?key_id=${encodeURIComponent(keyId)}&limit=5`, { headers });
		if (!res.ok()) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			continue;
		}
		const data = (await res.json()) as any;
		if (!data?.success) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			continue;
		}
		// key_id values are intentionally redacted in analytics responses.
		// The filtered endpoint returning any row is sufficient evidence that the
		// event has been written for this key.
		if (Array.isArray(data.result) && data.result.length > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Timed out waiting for Supabase analytics event for key ${keyId}`);
}

/** Open the Create Key dialog and select a named upstream token, revealing the policy builder. */
async function openPolicyBuilderForToken(page: import('@playwright/test').Page, tokenName: string) {
	const createBtn = page.locator('button:has-text("Create Key")');
	await expect(createBtn).toBeVisible({ timeout: 10000 });
	await createBtn.click();
	await expect(page.getByRole('heading', { name: 'Create API Key' })).toBeVisible({ timeout: 10000 });

	await page.locator('button[role="combobox"]:has-text("Select upstream token")').click();
	await page.locator(`[role="option"]:has-text("${tokenName}")`).first().click();

	// Policy builder renders after token selection.
	await expect(page.locator('text=Statement 1')).toBeVisible({ timeout: 5000 });
}

/** Open the Register Upstream Token dialog and return the scope-type combobox locator. */
async function openRegisterDialog(page: import('@playwright/test').Page) {
	const registerBtn = page.getByRole('button', { name: 'Register Token' });
	await expect(registerBtn).toBeVisible({ timeout: 10000 });
	const dialog = page.locator('[role="dialog"]');
	for (let attempt = 0; attempt < 3; attempt += 1) {
		if (await dialog.isVisible()) break;
		await registerBtn.click({ force: true });
		await page.waitForTimeout(120);
	}
	await expect(dialog).toBeVisible({ timeout: 10000 });
	await expect(dialog.getByRole('button', { name: 'Register' })).toBeVisible({ timeout: 10000 });
}

/** Select a scope-type option in the (only) combobox of the register dialog. */
async function selectScope(page: import('@playwright/test').Page, optionText: string) {
	await page.locator('[role="dialog"] [role="combobox"]').click();
	const option = page.locator(`[role="option"]:has-text("${optionText}")`);
	await expect(option).toBeVisible();
	await option.click();
	// Wait for the radix listbox to close so the selection has applied before we act on it.
	await expect(page.locator('[role="listbox"]')).toBeHidden();
}

// ─── Upstream Tokens: Supabase scope types ──────────────────────────

test.describe('Upstream Tokens — Supabase scope types', () => {
	test.beforeEach(async ({ page }) => {
		await setupAuth(page, TOKENS_URL);
	});

	test('scope select offers Supabase and Supabase Metrics options', async ({ page }) => {
		await openRegisterDialog(page);
		await page.locator('[role="dialog"] [role="combobox"]').click();

		await expect(page.locator('[role="option"]:has-text("Supabase (Management API PAT)")')).toBeVisible();
		await expect(page.locator('[role="option"]:has-text("Supabase Metrics (secret)")')).toBeVisible();
	});

	test('selecting Supabase scope changes the credential label to PAT', async ({ page }) => {
		await openRegisterDialog(page);

		// Default (zone) shows the Cloudflare credential label (the field <label>, not the descriptions).
		await expect(page.getByText('Cloudflare API Token', { exact: true })).toBeVisible();

		await selectScope(page, 'Supabase (Management API PAT)');

		await expect(page.getByText('Personal Access Token (PAT)', { exact: true })).toBeVisible();
		// The scope-ids field re-labels to Project Refs.
		await expect(page.getByText('Project Refs', { exact: true })).toBeVisible();
	});

	test('selecting Supabase Metrics scope reveals the Metrics Username field', async ({ page }) => {
		await openRegisterDialog(page);

		// Username field is hidden for non-metrics scopes.
		await expect(page.getByText('Metrics Username', { exact: true })).toBeHidden();

		await selectScope(page, 'Supabase Metrics (secret)');

		await expect(page.getByText('Metrics Username', { exact: true })).toBeVisible();
		await expect(page.locator('input[placeholder="service_role"]')).toBeVisible();
		await expect(page.getByText('Metrics Secret', { exact: true })).toBeVisible();
	});

	test('invalid project ref is rejected with a validation error', async ({ page }) => {
		await openRegisterDialog(page);
		await selectScope(page, 'Supabase (Management API PAT)');
		// Confirm the Supabase scope is active (re-labelled field) before filling.
		await expect(page.getByText('Project Refs', { exact: true })).toBeVisible();

		await page.locator('input[placeholder="e.g. production-purge, staging-token"]').fill('e2e-bad-ref');
		await page.locator('input[type="password"]').fill('sbp_fake_pat_value');
		// Project Refs input — replace the default '*' with an invalid ref.
		const refInput = page.locator('input[placeholder*="project refs"]');
		await refInput.fill('not-a-valid-ref');

		await page.locator('[role="dialog"] button:has-text("Register")').click();

		await expect(page.locator('text=/Invalid project ref/i')).toBeVisible();
		// Dialog stays open (creation was blocked).
		await expect(page.getByRole('heading', { name: 'Register Upstream Token' })).toBeVisible();
	});

	test('valid project ref (wildcard) passes client validation', async ({ page }) => {
		await openRegisterDialog(page);
		await selectScope(page, 'Supabase (Management API PAT)');

		await page.locator('input[placeholder="e.g. production-purge, staging-token"]').fill('e2e-sb-wildcard');
		await page.locator('input[type="password"]').fill('sbp_fake_pat_value');
		// Leave Project Refs at the default '*'. Skip server-side validation so the test stays
		// hermetic (a real PAT would otherwise be probed against the Supabase Management API).
		await page.locator('#skip-validation').check();

		await page.locator('[role="dialog"] button:has-text("Register")').click();

		// No validation error — dialog closes on success.
		await expect(page.locator('text=/Invalid project ref/i')).toBeHidden();
	});
});

// ─── Policy Builder: scope-gated action groups ──────────────────────

test.describe('Policy Builder — Supabase scope gating', () => {
	test.beforeEach(async ({ request }) => {
		await createToken(request, { name: 'e2e-sb-mgmt', scope_type: 'supabase' });
		await createToken(request, { name: 'e2e-sb-metrics', scope_type: 'supabase_metrics' });
		await createToken(request, { name: 'e2e-zone-cf', scope_type: 'zone' });
	});

	test('Supabase-scoped token shows only the Supabase action group', async ({ page }) => {
		await setupAuth(page, KEYS_URL);
		await openPolicyBuilderForToken(page, 'e2e-sb-mgmt');

		await expect(page.locator('button:has-text("supabase:*")')).toBeVisible();
		// Cloudflare zone groups must NOT appear for a Supabase token.
		await expect(page.locator('button:has-text("purge:*")')).toHaveCount(0);
		await expect(page.locator('button:has-text("dns:*")')).toHaveCount(0);
	});

	test('Supabase Metrics token shows only the metrics action group', async ({ page }) => {
		await setupAuth(page, KEYS_URL);
		await openPolicyBuilderForToken(page, 'e2e-sb-metrics');

		await expect(page.locator('button:has-text("supabase:*")')).toBeVisible();
		await expect(page.locator('button:has-text("purge:*")')).toHaveCount(0);
	});

	test('Zone-scoped token shows Cloudflare groups, not Supabase', async ({ page }) => {
		await setupAuth(page, KEYS_URL);
		await openPolicyBuilderForToken(page, 'e2e-zone-cf');

		await expect(page.locator('button:has-text("purge:*")')).toBeVisible();
		await expect(page.locator('button:has-text("dns:*")')).toBeVisible();
		await expect(page.locator('button:has-text("supabase:*")')).toHaveCount(0);
	});
});

// ─── Analytics: Supabase source visibility ─────────────────────────

test.describe('Analytics — Supabase source visibility', () => {
	test('Supabase source tab is visible when Supabase events exist', async ({ page, request }) => {
		const runId = Date.now();
		const upstreamTokenId = await createToken(request, {
			name: `e2e-sb-analytics-token-${runId}`,
			scope_type: 'supabase',
			zone_ids: ['*'],
		});
		const keyId = await createSupabaseKey(request, upstreamTokenId, `e2e-sb-analytics-key-${runId}`);

		// Fake credential is intentional — we only need a proxied request that reaches analytics logging.
		await request.get('/supabase/v1/projects', {
			headers: { Authorization: `Bearer ${keyId}` },
		});
		await waitForSupabaseEvent(request, keyId);

		await setupAuth(page, '/dashboard/analytics');
		await expect(page.getByRole('button', { name: /Supabase \(\d+\)/ })).toBeVisible();
	});
});
