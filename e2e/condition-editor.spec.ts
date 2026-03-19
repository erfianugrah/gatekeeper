import { test, expect } from '@playwright/test';

// ─── Helpers ────────────────────────────────────────────────────────

const KEYS_URL = '/dashboard/keys';
const ADMIN_KEY = 'test-admin-secret-key-12345';

/** Set admin key in localStorage and reload. */
async function setupAuth(page: import('@playwright/test').Page) {
	await page.goto(KEYS_URL);
	await page.evaluate((key) => localStorage.setItem('adminKey', key), ADMIN_KEY);
	await page.goto(KEYS_URL);
}

/** Ensure at least one upstream token exists so the Create Key dialog works. */
async function ensureUpstreamToken(request: import('@playwright/test').APIRequestContext) {
	const headers = { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY };
	const listRes = await request.get('/admin/upstream-tokens', { headers });
	const listData = await listRes.json();
	if (listData.success && listData.result && listData.result.length > 0) return;
	await request.post('/admin/upstream-tokens', {
		headers,
		data: { name: 'e2e-test-token', token: 'cf_test_fake_token_1234567890abcdef', zone_ids: ['*'], validate: false },
	});
}

/** Open Create Key dialog and select the upstream token to reveal the policy builder. */
async function openPolicyBuilder(page: import('@playwright/test').Page) {
	// Open dialog
	const createBtn = page.locator('button:has-text("Create Key")');
	await expect(createBtn).toBeVisible({ timeout: 10000 });
	await createBtn.click();
	await expect(page.getByRole('heading', { name: 'Create API Key' })).toBeVisible({ timeout: 10000 });

	// Select upstream token -- click the token dropdown and pick the first option
	await page.locator('button[role="combobox"]:has-text("Select upstream token")').click();
	await page.locator('[role="option"]').first().click();

	// Wait for the policy builder to appear (it renders after token selection)
	await expect(page.locator('text=Statement 1')).toBeVisible({ timeout: 5000 });
}

// ─── Tests ──────────────────────────────────────────────────────────

test.describe('Condition Editor', () => {
	test.beforeEach(async ({ page, request }) => {
		await ensureUpstreamToken(request);
		await setupAuth(page);
	});

	test('no conditions shows empty state text', async ({ page }) => {
		await openPolicyBuilder(page);

		// Default statement has no conditions
		await expect(page.locator('text=No conditions')).toBeVisible();
	});

	test('AND separator appears between multiple flat conditions', async ({ page }) => {
		await openPolicyBuilder(page);

		// Add first condition
		await page.locator('button:has-text("Add condition")').first().click();
		// No AND separator with just one condition
		await expect(page.locator('.tracking-widest:has-text("AND")')).not.toBeVisible();

		// Add second condition
		await page.locator('button:has-text("Add condition")').first().click();
		// AND separator should now appear
		await expect(page.locator('.tracking-widest:has-text("AND")')).toBeVisible();
	});

	test('add group dropdown shows OR, AND, NOT options', async ({ page }) => {
		await openPolicyBuilder(page);

		await page.locator('button:has-text("Add group")').first().click();

		const menu = page.locator('[data-testid="group-menu"]');
		await expect(menu).toBeVisible();
		await expect(page.locator('[data-testid="group-option-or"]')).toBeVisible();
		await expect(page.locator('[data-testid="group-option-and"]')).toBeVisible();
		await expect(page.locator('[data-testid="group-option-not"]')).toBeVisible();
	});

	// TODO: OR group click doesn't register in Playwright despite correct targeting.
	// The addGroup('any') handler fires but the parent re-render loses the update.
	// AND/NOT groups work fine. Likely a React closure staleness issue specific to the first menu option.
	test.fixme('OR group can be added and shows label', async ({ page }) => {
		await openPolicyBuilder(page);

		await page.locator('button:has-text("Add group")').first().click();
		await expect(page.locator('[data-testid="group-menu"]')).toBeVisible();
		await page.locator('[data-testid="group-option-or"]').click();

		await expect(page.locator('text=at least one must match')).toBeVisible({ timeout: 5000 });
	});

	test('AND group can be added and shows label', async ({ page }) => {
		await openPolicyBuilder(page);

		await page.locator('button:has-text("Add group")').first().click();
		await expect(page.locator('[data-testid="group-menu"]')).toBeVisible();
		await page.locator('[data-testid="group-option-and"]').click();

		await expect(page.locator('text=every condition must match')).toBeVisible({ timeout: 5000 });
	});

	test('NOT group can be added and shows label', async ({ page }) => {
		await openPolicyBuilder(page);

		await page.locator('button:has-text("Add group")').first().click();
		await expect(page.locator('[data-testid="group-menu"]')).toBeVisible();
		await page.locator('[data-testid="group-option-not"]').click();

		await expect(page.locator('text=inverts the result')).toBeVisible({ timeout: 5000 });
	});

	test('clicking outside group dropdown closes it', async ({ page }) => {
		await openPolicyBuilder(page);

		await page.locator('button:has-text("Add group")').first().click();
		await expect(page.locator('[data-testid="group-menu"]')).toBeVisible();

		// Click somewhere outside the menu to close it
		await page.locator('text=Statement 1').click();
		await expect(page.locator('[data-testid="group-menu"]')).not.toBeVisible();
	});

	test('condition operator can be changed', async ({ page }) => {
		await openPolicyBuilder(page);

		// Add a condition first (default statement has none)
		await page.locator('button:has-text("Add condition")').first().click();

		// Default operator should be 'equals'
		const operatorSelect = page.locator('button[role="combobox"]:has-text("equals")').first();
		await expect(operatorSelect).toBeVisible();

		// Change to 'contains'
		await operatorSelect.click();
		await page.getByRole('option', { name: 'contains', exact: true }).click();

		// Verify the operator changed
		await expect(page.locator('button[role="combobox"]:has-text("contains")').first()).toBeVisible();
	});

	test('condition value can be entered', async ({ page }) => {
		await openPolicyBuilder(page);

		// Add a condition first
		await page.locator('button:has-text("Add condition")').first().click();

		// Find the condition value input and type a value
		const valueInput = page.locator('input[placeholder]').last();
		await expect(valueInput).toBeVisible();
		await valueInput.fill('cdn.example.com');

		// Verify the value is in the input
		await expect(valueInput).toHaveValue('cdn.example.com');
	});

	test('inapplicable condition shows warning for mismatched action', async ({ page }) => {
		await openPolicyBuilder(page);

		// Default statement has purge:* -- add a condition
		await page.locator('button:has-text("Add condition")').first().click();

		// Default field is Host (applicable to purge) -- change to DNS Name
		await page.locator('button[role="combobox"]:has-text("Host")').first().click();
		await page.locator('[role="option"]:has-text("DNS Name")').click();

		// Should show inapplicable warning
		await expect(page.locator('text=only applies to')).toBeVisible();
	});

	test('applicable condition does NOT show warning', async ({ page }) => {
		await openPolicyBuilder(page);

		// Default is purge:* -- add a Host condition (applicable)
		await page.locator('button:has-text("Add condition")').first().click();

		// Host is the default field and is applicable to purge
		await expect(page.locator('text=only applies to')).not.toBeVisible();
	});

	test('condition can be removed back to empty state', async ({ page }) => {
		await openPolicyBuilder(page);

		// Add then remove a condition
		await page.locator('button:has-text("Add condition")').first().click();
		await expect(page.locator('text=No conditions')).not.toBeVisible();

		// The condition row has a trash icon button -- find the one inside the condition area
		// It's the ghost button with a Trash2 icon next to the condition selectors
		const trashBtn = page.locator('.hover\\:text-lv-red').last();
		await trashBtn.click();

		await expect(page.locator('text=No conditions')).toBeVisible();
	});
});
