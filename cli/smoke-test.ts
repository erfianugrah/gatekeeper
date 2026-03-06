#!/usr/bin/env node
/**
 * Smoke test suite for gatekeeper — TypeScript version.
 *
 * Requires: Node.js 22+, aws4fetch (already in deps)
 *
 * Usage:
 *   npm run dev &                                    # start wrangler dev
 *   npm run smoke                                    # run all tests (local)
 *   GATEKEEPER_URL=https://gate.erfi.io npm run smoke  # run against live
 *   npm run smoke -- --verbose                       # print response bodies
 */

import { BASE, IS_REMOTE, ADMIN_KEY, CF_API_TOKEN, bold, green, red, section, state, req, admin } from './smoke/helpers.js';
import type { SmokeContext } from './smoke/helpers.js';

import { run as runAdmin } from './smoke/admin.js';
import { run as runPurge } from './smoke/purge.js';
import { run as runRevoke } from './smoke/revoke.js';
import { run as runBulk } from './smoke/bulk.js';
import { run as runAnalytics } from './smoke/analytics.js';
import { run as runDashboard } from './smoke/dashboard.js';
import { run as runS3 } from './smoke/s3.js';
import { run as runRoutes } from './smoke/routes.js';

// ─── Preflight checks ─────────────────────────────────────────────────────

if (!ADMIN_KEY) {
	console.error('ERROR: Admin key not found. Set GATEKEEPER_ADMIN_KEY or check .env / .dev.vars');
	process.exit(1);
}

if (!CF_API_TOKEN) {
	console.error('ERROR: CF API token not found. Set CF_API_TOKEN or UPSTREAM_PURGE_KEY in .env');
	process.exit(1);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log('');
	console.log(bold('Gatekeeper — Smoke Tests'));
	console.log(`Base: ${BASE}`);
	console.log(`Remote: ${IS_REMOTE}`);

	// --- Preflight: check server is up ---
	try {
		const health = await req('GET', '/health');
		if (health.status !== 200) throw new Error(`HTTP ${health.status}`);
	} catch (e: any) {
		console.error(`ERROR: Server not responding at ${BASE}/health — ${e.message}`);
		process.exit(1);
	}

	// --- Discover zone ID ---
	const zoneRes = await fetch('https://api.cloudflare.com/client/v4/zones?name=erfi.io', {
		headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
	});
	const zoneData = (await zoneRes.json()) as any;
	const ZONE: string = zoneData?.result?.[0]?.id;
	if (!ZONE) {
		console.error('ERROR: Could not resolve zone ID for erfi.io');
		process.exit(1);
	}
	console.log(`Zone: ${ZONE} (erfi.io)`);

	// --- Register upstream token ---
	console.log('Registering upstream token...');
	const upstreamReg = await admin('POST', '/admin/upstream-tokens', {
		name: 'smoke-test-token',
		token: CF_API_TOKEN,
		zone_ids: [ZONE],
	});
	if (!upstreamReg.body?.success) {
		console.error(`ERROR: Failed to register upstream token: ${upstreamReg.body?.errors?.[0]?.message ?? 'unknown'}`);
		process.exit(1);
	}
	const UPSTREAM_TOKEN_ID: string = upstreamReg.body.result.id;
	console.log(`Upstream token: ${UPSTREAM_TOKEN_ID}`);

	const PURGE_URL = `/v1/zones/${ZONE}/purge_cache`;
	const WILDCARD_POLICY = {
		version: '2025-01-01',
		statements: [{ effect: 'allow', actions: ['purge:*'], resources: [`zone:${ZONE}`] }],
	};

	const ctx: SmokeContext = {
		ZONE,
		PURGE_URL,
		WILDCARD_POLICY,
		UPSTREAM_TOKEN_ID,
		WILDCARD_ID: '',
		HOST_ID: '',
		TAG_ID: '',
		PREFIX_ID: '',
		URL_ID: '',
		MULTI_ID: '',
		REVOKE_ID: '',
		REVOKE_ID_2: '',
		RATELIMIT_ID: '',
	};

	try {
		await runAdmin(ctx);
		await runPurge(ctx);
		await runRevoke(ctx);
		await runBulk(ctx);
		await runAnalytics(ctx);
		await runDashboard();
		await runS3(ctx);
		await runRoutes(ctx);
	} finally {
		// ─── Cleanup ────────────────────────────────────────────────────

		section('Cleanup');

		// Revoke all created keys
		for (const kid of state.createdKeys) {
			try {
				await admin('DELETE', `/admin/keys/${kid}`);
			} catch {
				/* ignore */
			}
		}
		console.log(`  Revoked ${state.createdKeys.length} smoke-test keys`);

		// Revoke all created S3 credentials
		for (const cid of state.createdS3Creds) {
			try {
				await admin('DELETE', `/admin/s3/credentials/${cid}`);
			} catch {
				/* ignore */
			}
		}
		console.log(`  Revoked ${state.createdS3Creds.length} S3 credentials`);

		// Revoke upstream token
		try {
			await admin('DELETE', `/admin/upstream-tokens/${UPSTREAM_TOKEN_ID}`);
		} catch {
			/* ignore */
		}
		console.log(`  Revoked upstream token ${UPSTREAM_TOKEN_ID}`);

		// Revoke upstream R2 endpoint
		if (ctx.s3UpstreamId) {
			try {
				await admin('DELETE', `/admin/upstream-r2/${ctx.s3UpstreamId}`);
			} catch {
				/* ignore */
			}
			console.log(`  Revoked upstream R2 ${ctx.s3UpstreamId}`);
		}
	}

	// ─── Summary ────────────────────────────────────────────────────────

	console.log('');
	console.log(bold('═══════════════════════════════════════'));
	const total = state.pass + state.fail;
	if (state.fail === 0) {
		console.log(bold(green(`  ALL ${total} TESTS PASSED`)));
	} else {
		console.log(bold(red(`  ${state.fail}/${total} FAILED`)));
		console.log('');
		for (const err of state.errors) {
			console.log(`  ${red('•')} ${err}`);
		}
	}
	console.log(bold('═══════════════════════════════════════'));

	process.exit(state.fail);
}

// ─── Run ───────────────────────────────────────────────────────────────────

main().catch((e) => {
	console.error('FATAL:', e);
	process.exit(1);
});
