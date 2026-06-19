#!/usr/bin/env node
/**
 * Focused Supabase live-smoke entry point.
 *
 * Runs ONLY the Supabase proxy section (synthetic + opt-in live tiers) against a
 * deployment — no CF/zone/purge setup, so it needs no CF_API_TOKEN. Designed to run
 * post-deploy against staging in CI (the synthetic tier always runs; the live tier
 * runs when SUPABASE_SMOKE_PAT or SUPABASE_SMOKE_TOKEN_ID is set).
 *
 * Usage:
 *   GATEKEEPER_URL=https://gatekeeper-staging.anugrah.workers.dev \
 *   GATEKEEPER_ADMIN_KEY=<staging admin key> \
 *   SUPABASE_SMOKE_PAT=<real sbp_... token> \
 *     bunx tsx cli/smoke-supabase.ts
 *
 *   # or locally (autoloads .env):
 *   bun run smoke:supabase
 */

import { BASE, IS_REMOTE, ADMIN_KEY, bold, green, red, section, state, req, admin } from './smoke/helpers.js';
import { run as runSupabase } from './smoke/supabase.js';

if (!ADMIN_KEY) {
	console.error('ERROR: Admin key not found. Set GATEKEEPER_ADMIN_KEY (remote) or check .env / .dev.vars');
	process.exit(1);
}

async function main(): Promise<void> {
	console.log('');
	console.log(bold('Gatekeeper — Supabase Live Smoke'));
	console.log(`Base: ${BASE}`);
	console.log(`Remote: ${IS_REMOTE}`);

	try {
		const health = await req('GET', '/health');
		if (health.status !== 200) throw new Error(`HTTP ${health.status}`);
	} catch (e: any) {
		console.error(`ERROR: Server not responding at ${BASE}/health — ${e.message}`);
		process.exit(1);
	}

	try {
		await runSupabase();
	} finally {
		// ─── Cleanup ────────────────────────────────────────────────────
		section('Cleanup');
		for (const kid of state.createdKeys) {
			try {
				await admin('DELETE', `/admin/keys/${kid}?permanent=true`);
			} catch {
				/* ignore */
			}
		}
		console.log(`  Deleted ${state.createdKeys.length} keys`);

		for (const uid of state.createdUpstreamTokens) {
			try {
				await admin('DELETE', `/admin/upstream-tokens/${uid}`);
			} catch {
				/* ignore */
			}
		}
		console.log(`  Deleted ${state.createdUpstreamTokens.length} upstream tokens`);
	}

	console.log('');
	console.log(bold('═══════════════════════════════════════'));
	const total = state.pass + state.fail;
	if (state.fail === 0) {
		console.log(bold(green(`  ALL ${total} TESTS PASSED`)));
	} else {
		console.log(bold(red(`  ${state.fail}/${total} FAILED`)));
		console.log('');
		for (const err of state.errors) console.log(`  ${red('•')} ${err}`);
	}
	console.log(bold('═══════════════════════════════════════'));

	process.exit(state.fail > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error('FATAL:', e);
	process.exit(1);
});
