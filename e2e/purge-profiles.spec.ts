import { test, expect } from '@playwright/test';

// ─── Helpers ────────────────────────────────────────────────────────

const PURGE_URL = '/dashboard/purge';
const STORAGE_KEY = 'gk_purge_profiles';
const LAST_PROFILE_KEY = 'gk_purge_last_profile';

/** Clear profile localStorage before each test. */
async function clearProfiles(page: import('@playwright/test').Page) {
	await page.evaluate(
		([sk, lk]) => {
			localStorage.removeItem(sk);
			localStorage.removeItem(lk);
		},
		[STORAGE_KEY, LAST_PROFILE_KEY],
	);
}

/** Read profiles from localStorage. */
async function getStoredProfiles(page: import('@playwright/test').Page) {
	return page.evaluate((sk) => {
		const raw = localStorage.getItem(sk);
		return raw ? JSON.parse(raw) : [];
	}, STORAGE_KEY);
}

/** Wait for the React purge page to hydrate. */
async function waitForPurgePage(page: import('@playwright/test').Page) {
	await page.goto(PURGE_URL);
	await expect(page.locator('text=Select a profile...')).toBeVisible({ timeout: 10000 });
}

/** Type a zone ID into the pill input and commit it with Enter. */
async function addZoneId(page: import('@playwright/test').Page, zoneId: string) {
	const input = page.locator('input[aria-label="Zone ID"]');
	await input.fill(zoneId);
	await input.press('Enter');
}

/** Type a purge value into the pill input and commit it with Enter. */
async function addPurgeValue(page: import('@playwright/test').Page, value: string) {
	const input = page.locator('input[aria-label="Purge values"]');
	await input.fill(value);
	await input.press('Enter');
}

// ─── Tests ──────────────────────────────────────────────────────────

test.describe('Purge Profiles', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(PURGE_URL);
		await clearProfiles(page);
	});

	test('page loads with empty profile selector', async ({ page }) => {
		await waitForPurgePage(page);

		await expect(page.locator('text=Select a profile...')).toBeVisible();

		// Save As button should be disabled (no zone ID pill)
		const saveAsBtn = page.locator('button[title="Save as new profile"]');
		await expect(saveAsBtn).toBeDisabled();
	});

	test('save a profile and verify it appears in dropdown', async ({ page }) => {
		await waitForPurgePage(page);

		// Add zone ID pill
		await addZoneId(page, 'aabbccdd11223344aabbccdd11223344');

		// Pill should appear
		await expect(page.locator('text=aabbccdd11223344aabbccdd11223344')).toBeVisible();

		// Save As button should now be enabled
		const saveAsBtn = page.locator('button[title="Save as new profile"]');
		await expect(saveAsBtn).toBeEnabled();

		// Click Save As -> dialog appears
		await saveAsBtn.click();
		await expect(page.getByRole('heading', { name: 'Save Profile' })).toBeVisible();

		// Enter profile name and save
		await page.getByPlaceholder('e.g. Production CDN').fill('My Test Zone');
		await page.getByRole('button', { name: 'Save Profile' }).click();

		// Profile selector should show the new profile name
		await expect(page.locator('button:has-text("My Test Zone")')).toBeVisible();

		// Verify localStorage
		const profiles = await getStoredProfiles(page);
		expect(profiles).toHaveLength(1);
		expect(profiles[0].name).toBe('My Test Zone');
		expect(profiles[0].zoneId).toBe('aabbccdd11223344aabbccdd11223344');
		expect(profiles[0].purgeType).toBe('urls');
	});

	test('select a profile from dropdown and verify form fills', async ({ page }) => {
		// Pre-seed a profile
		await page.evaluate(
			([sk]) => {
				localStorage.setItem(
					sk,
					JSON.stringify([{ id: 'test-1', name: 'Staging CDN', zoneId: '11112222333344445555666677778888', purgeType: 'tags' }]),
				);
			},
			[STORAGE_KEY],
		);
		await waitForPurgePage(page);

		// Open dropdown and click profile
		await page.locator('text=Select a profile...').click();
		await page.locator('text=Staging CDN').click();

		// Verify zone ID pill appears
		await expect(page.locator('text=11112222333344445555666677778888')).toBeVisible();

		// Verify purge type
		await expect(page.locator('select')).toHaveValue('tags');
	});

	test('update a profile after changing purge type', async ({ page }) => {
		await page.evaluate(
			([sk, lk]) => {
				localStorage.setItem(
					sk,
					JSON.stringify([{ id: 'test-1', name: 'My Zone', zoneId: 'aabbccdd11223344aabbccdd11223344', purgeType: 'urls' }]),
				);
				localStorage.setItem(lk, 'test-1');
			},
			[STORAGE_KEY, LAST_PROFILE_KEY],
		);
		await waitForPurgePage(page);

		// Profile should be auto-selected
		await expect(page.locator('button:has-text("My Zone")')).toBeVisible();

		// Change purge type to hosts
		await page.locator('select').selectOption('hosts');

		// Update button should appear
		const updateBtn = page.locator('button[title="Update this profile"]');
		await expect(updateBtn).toBeVisible();
		await updateBtn.click();

		// Verify localStorage was updated
		const profiles = await getStoredProfiles(page);
		expect(profiles[0].purgeType).toBe('hosts');
	});

	test('delete a profile with confirmation', async ({ page }) => {
		await page.evaluate(
			([sk]) => {
				localStorage.setItem(
					sk,
					JSON.stringify([
						{ id: 'keep', name: 'Keep This', zoneId: 'aaaa1111bbbb2222cccc3333dddd4444', purgeType: 'urls' },
						{ id: 'delete-me', name: 'Delete Me', zoneId: '11112222333344445555666677778888', purgeType: 'hosts' },
					]),
				);
			},
			[STORAGE_KEY],
		);
		await waitForPurgePage(page);

		// Open dropdown, hover to reveal trash, click it
		await page.locator('text=Select a profile...').click();
		const deleteRow = page.locator('.group:has-text("Delete Me")');
		await deleteRow.hover();
		await deleteRow.locator('button[title="Delete profile"]').click();

		// Confirmation dialog
		await expect(page.locator('text=Are you sure you want to delete')).toBeVisible();
		await expect(page.locator('text=Delete Me')).toBeVisible();
		await page.getByRole('button', { name: 'Delete' }).filter({ hasNotText: 'profile' }).click();

		// Verify only one profile remains
		const profiles = await getStoredProfiles(page);
		expect(profiles).toHaveLength(1);
		expect(profiles[0].name).toBe('Keep This');
	});

	test('clear selection resets the form', async ({ page }) => {
		await page.evaluate(
			([sk, lk]) => {
				localStorage.setItem(
					sk,
					JSON.stringify([{ id: 'test-1', name: 'Active Profile', zoneId: 'aabbccdd11223344aabbccdd11223344', purgeType: 'tags' }]),
				);
				localStorage.setItem(lk, 'test-1');
			},
			[STORAGE_KEY, LAST_PROFILE_KEY],
		);
		await waitForPurgePage(page);

		await expect(page.locator('button:has-text("Active Profile")')).toBeVisible();

		// Open dropdown and click clear
		await page.locator('button:has-text("Active Profile")').click();
		await page.locator('text=Clear selection').click();

		// Zone ID pill should be gone, placeholder should be back
		await expect(page.locator('text=aabbccdd11223344aabbccdd11223344')).not.toBeVisible();
		await expect(page.locator('text=Select a profile...')).toBeVisible();
	});

	test('last used profile is restored on page reload', async ({ page }) => {
		await page.evaluate(
			([sk, lk]) => {
				localStorage.setItem(
					sk,
					JSON.stringify([{ id: 'persist-1', name: 'Persistent Zone', zoneId: 'aabbccdd11223344aabbccdd11223344', purgeType: 'prefixes' }]),
				);
				localStorage.setItem(lk, 'persist-1');
			},
			[STORAGE_KEY, LAST_PROFILE_KEY],
		);

		await waitForPurgePage(page);

		await expect(page.locator('button:has-text("Persistent Zone")')).toBeVisible();
		await expect(page.locator('text=aabbccdd11223344aabbccdd11223344')).toBeVisible();
		await expect(page.locator('select')).toHaveValue('prefixes');
	});

	test('save dialog can be dismissed with Cancel', async ({ page }) => {
		await waitForPurgePage(page);

		await addZoneId(page, 'aabbccdd11223344aabbccdd11223344');

		await page.locator('button[title="Save as new profile"]').click();
		await expect(page.getByRole('heading', { name: 'Save Profile' })).toBeVisible();

		await page.getByRole('button', { name: 'Cancel' }).click();
		await expect(page.getByRole('heading', { name: 'Save Profile' })).not.toBeVisible();

		const profiles = await getStoredProfiles(page);
		expect(profiles).toHaveLength(0);
	});

	test('save dialog requires a name', async ({ page }) => {
		await waitForPurgePage(page);

		await addZoneId(page, 'aabbccdd11223344aabbccdd11223344');
		await page.locator('button[title="Save as new profile"]').click();

		const saveBtn = page.getByRole('button', { name: 'Save Profile' });
		await expect(saveBtn).toBeDisabled();

		await page.getByPlaceholder('e.g. Production CDN').fill('Test');
		await expect(saveBtn).toBeEnabled();
	});

	test('multiple profiles can be saved and selected independently', async ({ page }) => {
		await waitForPurgePage(page);

		// Save first profile
		await addZoneId(page, 'aaaa1111bbbb2222cccc3333dddd4444');
		await page.locator('button[title="Save as new profile"]').click();
		await page.getByPlaceholder('e.g. Production CDN').fill('Zone A');
		await page.getByRole('button', { name: 'Save Profile' }).click();

		// Remove the zone pill, add a new one, change purge type, save second profile
		await page.locator('[aria-label="Remove aaaa1111bbbb2222cccc3333dddd4444"]').click();
		await addZoneId(page, '11112222333344445555666677778888');
		await page.locator('select').selectOption('hosts');
		await page.locator('button[title="Save as new profile"]').click();
		await page.getByPlaceholder('e.g. Production CDN').fill('Zone B');
		await page.getByRole('button', { name: 'Save Profile' }).click();

		const profiles = await getStoredProfiles(page);
		expect(profiles).toHaveLength(2);

		// Select Zone A
		await page.locator('button:has-text("Zone B")').click();
		await page.locator('.group button:has-text("Zone A")').click();

		await expect(page.locator('text=aaaa1111bbbb2222cccc3333dddd4444')).toBeVisible();
		await expect(page.locator('select')).toHaveValue('urls');
	});
});

test.describe('Purge Form', () => {
	test('zone ID validation shows error for invalid format', async ({ page }) => {
		await page.goto(PURGE_URL);
		await expect(page.locator('text=Select a profile...')).toBeVisible({ timeout: 10000 });

		// Type invalid zone ID and press Enter
		const zoneInput = page.locator('input[aria-label="Zone ID"]');
		await zoneInput.fill('not-valid');
		await zoneInput.press('Enter');

		await expect(page.locator('text=Zone ID must be a 32-character hex string')).toBeVisible();
	});

	test('submit button is disabled without zone ID and API key', async ({ page }) => {
		await page.goto(PURGE_URL);
		await expect(page.locator('text=Select a profile...')).toBeVisible({ timeout: 10000 });

		const submitBtn = page.locator('button:has-text("Send Purge Request")');
		await expect(submitBtn).toBeDisabled();

		// Add zone ID pill -- still disabled (no API key)
		await addZoneId(page, 'aabbccdd11223344aabbccdd11223344');
		await expect(submitBtn).toBeDisabled();

		// Fill API key -- now enabled
		await page.locator('input[placeholder*="Bearer"]').fill('some-key');
		await expect(submitBtn).toBeEnabled();
	});

	test('purge everything shows warning banner', async ({ page }) => {
		await waitForPurgePage(page);

		await page.locator('select').selectOption('everything');
		await expect(page.locator('text=This will purge all cached content for the zone')).toBeVisible();

		// Values pill input should be hidden
		await expect(page.locator('input[aria-label="Purge values"]')).not.toBeVisible();
	});

	test('pill input: add multiple values via comma-separated paste', async ({ page }) => {
		await page.goto(PURGE_URL);
		await expect(page.locator('text=Select a profile...')).toBeVisible({ timeout: 10000 });

		// Paste comma-separated URLs
		const valuesInput = page.locator('input[aria-label="Purge values"]');
		await valuesInput.focus();
		await page.evaluate(() => {
			const input = document.querySelector('input[aria-label="Purge values"]') as HTMLInputElement;
			const dt = new DataTransfer();
			dt.setData('text/plain', 'https://a.com/1,https://b.com/2,https://c.com/3');
			input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
		});

		// Three pills should appear
		await expect(page.locator('text=https://a.com/1')).toBeVisible();
		await expect(page.locator('text=https://b.com/2')).toBeVisible();
		await expect(page.locator('text=https://c.com/3')).toBeVisible();
	});

	test('pill input: remove a value by clicking X', async ({ page }) => {
		await page.goto(PURGE_URL);
		await expect(page.locator('text=Select a profile...')).toBeVisible({ timeout: 10000 });

		await addPurgeValue(page, 'tag-one');
		await addPurgeValue(page, 'tag-two');
		await expect(page.locator('text=tag-one')).toBeVisible();
		await expect(page.locator('text=tag-two')).toBeVisible();

		// Remove first pill
		await page.locator('[aria-label="Remove tag-one"]').click();
		await expect(page.locator('text=tag-one')).not.toBeVisible();
		await expect(page.locator('text=tag-two')).toBeVisible();
	});

	test('pill input: backspace removes last pill when input is empty', async ({ page }) => {
		await page.goto(PURGE_URL);
		await expect(page.locator('text=Select a profile...')).toBeVisible({ timeout: 10000 });

		await addPurgeValue(page, 'first');
		await addPurgeValue(page, 'second');

		const valuesInput = page.locator('input[aria-label="Purge values"]');
		await valuesInput.press('Backspace');

		await expect(page.locator('text=first')).toBeVisible();
		await expect(page.locator('text=second')).not.toBeVisible();
	});

	test('pill input: duplicates are ignored', async ({ page }) => {
		await page.goto(PURGE_URL);
		await expect(page.locator('text=Select a profile...')).toBeVisible({ timeout: 10000 });

		await addPurgeValue(page, 'same-tag');
		await addPurgeValue(page, 'same-tag');

		// Only one pill should exist
		const pills = page.locator('text=same-tag');
		await expect(pills).toHaveCount(1);
	});

	test('zone ID max=1: input hides after one pill', async ({ page }) => {
		await page.goto(PURGE_URL);
		await expect(page.locator('text=Select a profile...')).toBeVisible({ timeout: 10000 });

		await addZoneId(page, 'aabbccdd11223344aabbccdd11223344');

		// Zone ID input should be hidden (max=1 reached)
		await expect(page.locator('input[aria-label="Zone ID"]')).not.toBeVisible();

		// Remove the pill -- input reappears
		await page.locator('[aria-label="Remove aabbccdd11223344aabbccdd11223344"]').click();
		await expect(page.locator('input[aria-label="Zone ID"]')).toBeVisible();
	});

	test('changing purge type clears values', async ({ page }) => {
		await page.goto(PURGE_URL);
		await expect(page.locator('text=Select a profile...')).toBeVisible({ timeout: 10000 });

		await addPurgeValue(page, 'https://example.com/page');
		await expect(page.locator('text=https://example.com/page')).toBeVisible();

		// Switch type
		await page.locator('select').selectOption('tags');

		// Old values should be cleared
		await expect(page.locator('text=https://example.com/page')).not.toBeVisible();
	});
});
