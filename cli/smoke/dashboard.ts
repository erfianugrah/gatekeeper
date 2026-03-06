/**
 * Smoke tests — section 14: Dashboard Static Assets + root index.
 */

import { req, section, assertStatus, assertTruthy, IS_REMOTE, yellow, red, green, state } from './helpers.js';

export async function run(): Promise<void> {
	if (IS_REMOTE) {
		section('Dashboard Static Assets (skipped — CF Access SSO redirect)');
		console.log(`  ${yellow('SKIP')}  Dashboard tests skipped on remote (CF Access 302)`);
	} else {
		section('Dashboard Static Assets');

		const dashRoot = await req('GET', '/dashboard/');
		assertStatus('GET /dashboard/ -> 200', dashRoot, 200);
		assertTruthy("dashboard HTML contains 'gatekeeper'", dashRoot.raw.includes('gatekeeper'));

		const dashKeys = await req('GET', '/dashboard/keys/');
		assertStatus('GET /dashboard/keys/ -> 200', dashKeys, 200);

		const dashAnalytics = await req('GET', '/dashboard/analytics/');
		assertStatus('GET /dashboard/analytics/ -> 200', dashAnalytics, 200);

		const dashPurge = await req('GET', '/dashboard/purge/');
		assertStatus('GET /dashboard/purge/ -> 200', dashPurge, 200);

		const dashFavicon = await req('GET', '/dashboard/favicon.svg');
		assertStatus('GET /dashboard/favicon.svg -> 200', dashFavicon, 200);

		const dashFallback = await req('GET', '/dashboard/nonexistent/deep/route');
		assertStatus('SPA fallback for unknown route -> 200', dashFallback, 200);

		// Find a JS asset from the HTML
		const jsMatch = dashRoot.raw.match(/\/_astro\/[^"]+\.js/);
		if (jsMatch) {
			const jsRes = await req('GET', jsMatch[0]);
			assertStatus(`JS asset (${jsMatch[0]}) -> 200`, jsRes, 200);
		} else {
			state.fail++;
			state.errors.push('No JS asset found in dashboard HTML');
			console.log(`  ${red('FAIL')}  No JS asset found in dashboard HTML`);
		}
	}

	const rootIndex = await req('GET', '/');
	assertStatus('GET / -> 200 (root index)', rootIndex, 200);
}
