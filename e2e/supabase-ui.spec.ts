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
	await request.post('/admin/upstream-tokens', {
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
	const registerBtn = page.locator('button:has-text("Register Token")');
	await expect(registerBtn).toBeVisible({ timeout: 10000 });
	await registerBtn.click();
	await expect(page.getByRole('heading', { name: 'Register Upstream Token' })).toBeVisible({ timeout: 10000 });
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
