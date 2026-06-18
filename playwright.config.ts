import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './e2e',
	timeout: 30000,
	// 2 retries in CI: the webServer-booted wrangler dev has a cold-start window where the
	// first specs can race DO/D1 warmup. 1 locally where a warm server is usually reused.
	retries: process.env.CI ? 2 : 1,
	use: {
		baseURL: 'http://localhost:8787',
		headless: true,
	},
	projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
	// Auto-start wrangler dev. Locally this reuses a server you already have running
	// (per the README workflow); in CI it boots a fresh one. The dashboard must be built
	// first (assets.directory → dashboard/dist) and ADMIN_KEY is injected to match the
	// value the specs use (.dev.vars is gitignored, so CI has no secrets file).
	webServer: {
		command: 'npx wrangler dev --port 8787 --var ADMIN_KEY:test-admin-secret-key-12345',
		url: 'http://localhost:8787/health',
		timeout: 120_000,
		reuseExistingServer: !process.env.CI,
		stdout: 'pipe',
		stderr: 'pipe',
	},
});
