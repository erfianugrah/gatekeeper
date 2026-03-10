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

import {
	BASE,
	IS_REMOTE,
	ADMIN_KEY,
	CF_API_TOKEN,
	DNS_TEST_TOKEN,
	bold,
	green,
	red,
	section,
	state,
	req,
	admin,
	setSmokeUpstreamTokenId,
} from './smoke/helpers.js';
import type { SmokeContext } from './smoke/helpers.js';

import { run as runAdmin } from './smoke/admin.js';
import { run as runPurge } from './smoke/purge.js';
import { run as runRevoke } from './smoke/revoke.js';
import { run as runBulk } from './smoke/bulk.js';
import { run as runAnalytics } from './smoke/analytics.js';
import { run as runDashboard } from './smoke/dashboard.js';
import { run as runS3 } from './smoke/s3.js';
import { run as runDns } from './smoke/dns.js';
import { run as runRoutes } from './smoke/routes.js';
import { run as runConfig } from './smoke/config.js';
import { run as runCfProxy } from './smoke/cf-proxy.js';

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
	setSmokeUpstreamTokenId(UPSTREAM_TOKEN_ID);
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
		await runAnalytics(ctx);
		await runDashboard();
		await runS3(ctx);
		await runBulk(ctx);
		await runDns(ctx);
		await runCfProxy(ctx);
		await runConfig(ctx);
		await runRoutes(ctx);
	} finally {
		// ─── Cleanup ────────────────────────────────────────────────────
		// All resources tracked in `state` are cleaned up here, even on crash.

		section('Cleanup');

		// Permanently delete all created keys
		for (const kid of state.createdKeys) {
			try {
				await admin('DELETE', `/admin/keys/${kid}?permanent=true`);
			} catch {
				/* ignore */
			}
		}
		console.log(`  Deleted ${state.createdKeys.length} smoke-test keys`);

		// Permanently delete all created S3 credentials
		for (const cid of state.createdS3Creds) {
			try {
				await admin('DELETE', `/admin/s3/credentials/${cid}?permanent=true`);
			} catch {
				/* ignore */
			}
		}
		console.log(`  Deleted ${state.createdS3Creds.length} S3 credentials`);

		// Delete upstream token (the main purge token)
		try {
			await admin('DELETE', `/admin/upstream-tokens/${UPSTREAM_TOKEN_ID}`);
		} catch {
			/* ignore */
		}
		console.log(`  Deleted upstream token ${UPSTREAM_TOKEN_ID}`);

		// Delete CF proxy upstream token
		if (ctx.cfProxyUpstreamId) {
			try {
				await admin('DELETE', `/admin/upstream-tokens/${ctx.cfProxyUpstreamId}`);
			} catch {
				/* ignore */
			}
			console.log(`  Deleted CF proxy upstream token ${ctx.cfProxyUpstreamId}`);
		}

		// Delete upstream R2 endpoint
		if (ctx.s3UpstreamId) {
			try {
				await admin('DELETE', `/admin/upstream-r2/${ctx.s3UpstreamId}`);
			} catch {
				/* ignore */
			}
			console.log(`  Deleted upstream R2 ${ctx.s3UpstreamId}`);
		}

		// Delete any remaining upstream tokens (DNS, bulk test leftovers)
		for (const uid of state.createdUpstreamTokens) {
			try {
				await admin('DELETE', `/admin/upstream-tokens/${uid}`);
			} catch {
				/* ignore */
			}
		}
		if (state.createdUpstreamTokens.length > 0) {
			console.log(`  Deleted ${state.createdUpstreamTokens.length} tracked upstream tokens`);
		}

		// Delete any remaining upstream R2 (bulk test leftovers)
		for (const rid of state.createdUpstreamR2) {
			try {
				await admin('DELETE', `/admin/upstream-r2/${rid}`);
			} catch {
				/* ignore */
			}
		}
		if (state.createdUpstreamR2.length > 0) {
			console.log(`  Deleted ${state.createdUpstreamR2.length} tracked upstream R2`);
		}

		// Delete leaked DNS records directly via CF API (gatekeeper keys may be gone)
		if (DNS_TEST_TOKEN && state.createdDnsRecords.length > 0) {
			for (const { zoneId, recordId } of state.createdDnsRecords) {
				try {
					await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`, {
						method: 'DELETE',
						headers: { Authorization: `Bearer ${DNS_TEST_TOKEN}` },
					});
				} catch {
					/* ignore */
				}
			}
			console.log(`  Deleted ${state.createdDnsRecords.length} leaked DNS records via CF API`);
		}

		// Delete leaked D1 databases directly via CF API
		if (CF_API_TOKEN && state.createdD1Databases.length > 0) {
			const cfToken = process.env['CF_PROXY_TOKEN'] ?? process.env['UPSTREAM_CF_TOKEN'] ?? CF_API_TOKEN;
			for (const { accountId, dbId } of state.createdD1Databases) {
				try {
					await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}`, {
						method: 'DELETE',
						headers: { Authorization: `Bearer ${cfToken}` },
					});
				} catch {
					/* ignore */
				}
			}
			console.log(`  Deleted ${state.createdD1Databases.length} leaked D1 databases via CF API`);
		}

		// Delete leaked KV namespaces directly via CF API
		if (CF_API_TOKEN && state.createdKvNamespaces.length > 0) {
			const cfToken = process.env['CF_PROXY_TOKEN'] ?? process.env['UPSTREAM_CF_TOKEN'] ?? CF_API_TOKEN;
			for (const { accountId, nsId } of state.createdKvNamespaces) {
				try {
					await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${nsId}`, {
						method: 'DELETE',
						headers: { Authorization: `Bearer ${cfToken}` },
					});
				} catch {
					/* ignore */
				}
			}
			console.log(`  Deleted ${state.createdKvNamespaces.length} leaked KV namespaces via CF API`);
		}

		// Reset any leaked config overrides
		for (const key of state.configOverrides) {
			try {
				await admin('DELETE', `/admin/config/${key}`);
			} catch {
				/* ignore */
			}
		}
		if (state.configOverrides.length > 0) {
			console.log(`  Reset ${state.configOverrides.length} config overrides`);
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

	process.exit(state.fail > 0 ? 1 : 0);
}

// ─── Run ───────────────────────────────────────────────────────────────────

main().catch((e) => {
	console.error('FATAL:', e);
	process.exit(1);
});
