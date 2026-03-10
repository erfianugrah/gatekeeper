/**
 * Smoke tests — CF API Proxy: D1, KV, Workers, Queues, Vectorize, Hyperdrive.
 *
 * Tests auth enforcement, CRUD operations through the proxy, IAM policy scoping,
 * and analytics recording.
 */

import { execSync } from 'node:child_process';
import type { SmokeContext } from './helpers.js';
import {
	req,
	admin,
	section,
	assertStatus,
	assertJson,
	assertMatch,
	assertTruthy,
	state,
	sleep,
	green,
	red,
	dim,
	yellow,
	BASE,
} from './helpers.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const CF_PROXY_TOKEN = process.env['CF_PROXY_TOKEN'] ?? process.env['UPSTREAM_CF_TOKEN'];
const ACCOUNT_ID = process.env['CF_ACCOUNT_ID'] ?? '25f21f141824546aa72c74451a11b419';

export const SKIP_CF_PROXY = !CF_PROXY_TOKEN;

// ─── Helpers ────────────────────────────────────────────────────────────────

function cf(keyId: string, method: string, path: string, body?: unknown): Promise<import('./helpers.js').Resp> {
	const headers: Record<string, string> = { Authorization: `Bearer ${keyId}` };
	if (body) headers['Content-Type'] = 'application/json';
	return req(method, `/cf${path}`, body, headers);
}

/** Create a CF proxy key (no zone_id) with given policy. */
async function createCfKey(
	name: string,
	policy: object,
	upstreamTokenId?: string,
): Promise<{ r: import('./helpers.js').Resp; keyId: string }> {
	const r = await admin('POST', '/admin/keys', { name, policy, upstream_token_id: upstreamTokenId });
	const keyId = r.body?.result?.key?.id ?? '';
	if (keyId) state.createdKeys.push(keyId);
	return { r, keyId };
}

export async function run(ctx: SmokeContext): Promise<void> {
	if (SKIP_CF_PROXY) {
		section('CF Proxy Tests (skipped — no CF_PROXY_TOKEN / UPSTREAM_CF_TOKEN)');
		console.log(`  Set CF_PROXY_TOKEN or UPSTREAM_CF_TOKEN in .env`);
		return;
	}

	const CF_BASE = `/accounts/${ACCOUNT_ID}`;

	// ─── Upstream Account Token Setup ──────────────────────────────

	section('CF Proxy Upstream Token Setup');

	const upstreamReg = await admin('POST', '/admin/upstream-tokens', {
		name: 'smoke-cf-proxy-token',
		token: CF_PROXY_TOKEN,
		scope_type: 'account',
		zone_ids: [ACCOUNT_ID],
	});
	const cfUpstreamId = upstreamReg.body?.result?.id;
	assertStatus('register CF proxy upstream token -> 200', upstreamReg, 200);
	assertTruthy('CF proxy upstream token has id', cfUpstreamId);
	ctx.cfProxyUpstreamId = cfUpstreamId;

	// ─── Key Setup ─────────────────────────────────────────────────

	section('CF Proxy Key Setup');

	const WILDCARD_POLICY = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['d1:*', 'kv:*', 'workers:*', 'queues:*', 'vectorize:*', 'hyperdrive:*'],
				resources: [`account:${ACCOUNT_ID}`],
			},
		],
	};

	const { r: wcCreate, keyId: CF_KEY } = await createCfKey('smoke-cf-wildcard', WILDCARD_POLICY, ctx.cfProxyUpstreamId);
	assertStatus('create CF proxy wildcard key -> 200', wcCreate, 200);
	assertTruthy('CF key starts with gw_', CF_KEY.startsWith('gw_'));

	// Read-only D1 key
	const D1_RO_POLICY = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['d1:list', 'd1:get', 'd1:query'],
				resources: [`account:${ACCOUNT_ID}`],
			},
		],
	};
	const { r: roCreate, keyId: D1_RO_KEY } = await createCfKey('smoke-cf-d1-readonly', D1_RO_POLICY, ctx.cfProxyUpstreamId);
	assertStatus('create D1 read-only key -> 200', roCreate, 200);

	// ─── Token Binding Validation (account-scoped) ────────────────

	section('CF Proxy Token Binding Validation');

	// T3: Account-scoped token with zone-scoped action (purge:host)
	const tbZoneAction = await admin('POST', '/admin/keys', {
		name: 'x',
		upstream_token_id: cfUpstreamId,
		policy: { version: '2025-01-01', statements: [{ effect: 'allow', actions: ['purge:host'], resources: [`account:${ACCOUNT_ID}`] }] },
	});
	assertStatus('account token + zone action (purge:host) -> 400', tbZoneAction, 400);
	assertMatch('error mentions account-scoped', tbZoneAction.body?.errors?.[0]?.message ?? '', /account-scoped/i);

	// T3b: Account-scoped token with dns action
	const tbDnsAction = await admin('POST', '/admin/keys', {
		name: 'x',
		upstream_token_id: cfUpstreamId,
		policy: { version: '2025-01-01', statements: [{ effect: 'allow', actions: ['dns:read'], resources: [`account:${ACCOUNT_ID}`] }] },
	});
	assertStatus('account token + dns action -> 400', tbDnsAction, 400);

	// T8: Account-scoped token with zone-prefixed resource
	const tbZoneResource = await admin('POST', '/admin/keys', {
		name: 'x',
		upstream_token_id: cfUpstreamId,
		policy: {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: ['d1:*'], resources: ['zone:some-zone-id'] }],
		},
	});
	assertStatus('account token + zone resource -> 400', tbZoneResource, 400);
	assertMatch('error mentions account: prefix', tbZoneResource.body?.errors?.[0]?.message ?? '', /account:/i);

	// T9: Account-scoped token with account:* (token has specific account)
	const tbAccountWildcard = await admin('POST', '/admin/keys', {
		name: 'x',
		upstream_token_id: cfUpstreamId,
		policy: {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: ['d1:*'], resources: ['account:*'] }],
		},
	});
	assertStatus('account:* on non-wildcard account token -> 400', tbAccountWildcard, 400);
	assertMatch('error mentions account:*', tbAccountWildcard.body?.errors?.[0]?.message ?? '', /account:\*/i);

	// T10: Account-scoped token with wrong account ID
	const tbWrongAccount = await admin('POST', '/admin/keys', {
		name: 'x',
		upstream_token_id: cfUpstreamId,
		policy: {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: ['d1:*'], resources: ['account:wrong_account_id_here'] }],
		},
	});
	assertStatus('wrong account ID in resource -> 400', tbWrongAccount, 400);
	assertMatch('error mentions account mismatch', tbWrongAccount.body?.errors?.[0]?.message ?? '', /does not match/i);

	// T10b: Hierarchical resource with wrong account ID
	const tbWrongAccountHier = await admin('POST', '/admin/keys', {
		name: 'x',
		upstream_token_id: cfUpstreamId,
		policy: {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: ['d1:*'], resources: ['account:wrong_id/d1/some-db'] }],
		},
	});
	assertStatus('hierarchical resource wrong account -> 400', tbWrongAccountHier, 400);

	// Happy path: correct account ID in hierarchical resource
	const tbCorrectHier = await admin('POST', '/admin/keys', {
		name: 'smoke-cf-binding-ok',
		upstream_token_id: cfUpstreamId,
		policy: {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: ['d1:query'], resources: [`account:${ACCOUNT_ID}/d1/some-db`] }],
		},
	});
	assertStatus('correct hierarchical resource -> 200', tbCorrectHier, 200);
	const tbCorrectHierKeyId = tbCorrectHier.body?.result?.key?.id;
	if (tbCorrectHierKeyId) state.createdKeys.push(tbCorrectHierKeyId);

	// ─── Authentication ────────────────────────────────────────────

	section('CF Proxy Authentication');

	const noAuth = await req('GET', `/cf${CF_BASE}/d1/database`);
	assertStatus('no auth header -> 401', noAuth, 401);

	const badKey = await cf('gw_00000000000000000000000000000000', 'GET', `${CF_BASE}/d1/database`);
	assertStatus('nonexistent key -> 401', badKey, 401);

	const badAccount = await cf(CF_KEY, 'GET', '/accounts/not-a-hex-account/d1/database');
	assertStatus('invalid account ID format -> 400', badAccount, 400);

	// Auth ordering: unauthenticated request to a valid account should get 401 (not 502)
	// This verifies upstream token resolution happens AFTER auth
	const authOrdering = await cf('gw_00000000000000000000000000000000', 'GET', `${CF_BASE}/d1/database`);
	assertStatus('bad key + valid account -> 401 (not 502, proves auth-first)', authOrdering, 401);

	// ─── D1: List ──────────────────────────────────────────────────

	section('CF Proxy — D1');

	const d1List = await cf(CF_KEY, 'GET', `${CF_BASE}/d1/database`);
	assertStatus('D1 list databases -> 200', d1List, 200);
	assertTruthy('D1 list returns result array', Array.isArray(d1List.body?.result));

	// ─── D1: Create / Query / Delete ───────────────────────────────

	const dbName = `gk-smoke-${Date.now()}`;
	const d1Create = await cf(CF_KEY, 'POST', `${CF_BASE}/d1/database`, { name: dbName });
	assertStatus('D1 create database -> 200', d1Create, 200);
	const dbId = d1Create.body?.result?.uuid;
	assertTruthy('D1 created database has uuid', dbId);
	if (dbId) state.createdD1Databases.push({ accountId: ACCOUNT_ID, dbId });

	if (dbId) {
		// Get
		const d1Get = await cf(CF_KEY, 'GET', `${CF_BASE}/d1/database/${dbId}`);
		assertStatus('D1 get database -> 200', d1Get, 200);
		assertJson('D1 get returns correct name', d1Get.body?.result?.name, dbName);

		// Query
		const d1Query = await cf(CF_KEY, 'POST', `${CF_BASE}/d1/database/${dbId}/query`, {
			sql: 'SELECT 1 as num',
		});
		assertStatus('D1 query -> 200', d1Query, 200);

		// Delete
		const d1Delete = await cf(CF_KEY, 'DELETE', `${CF_BASE}/d1/database/${dbId}`);
		assertStatus('D1 delete database -> 200', d1Delete, 200);
		state.createdD1Databases = state.createdD1Databases.filter((d) => d.dbId !== dbId);
	}

	// ─── D1: Policy enforcement ────────────────────────────────────

	section('CF Proxy — D1 IAM');

	const roList = await cf(D1_RO_KEY, 'GET', `${CF_BASE}/d1/database`);
	assertStatus('D1 read-only key: list -> 200', roList, 200);

	const roDenied = await cf(D1_RO_KEY, 'POST', `${CF_BASE}/d1/database`, { name: 'should-fail' });
	assertStatus('D1 read-only key: create -> 403', roDenied, 403);

	// ─── KV: CRUD ──────────────────────────────────────────────────

	section('CF Proxy — KV');

	const kvList = await cf(CF_KEY, 'GET', `${CF_BASE}/storage/kv/namespaces`);
	assertStatus('KV list namespaces -> 200', kvList, 200);
	assertTruthy('KV list returns result array', Array.isArray(kvList.body?.result));

	// Create namespace
	const nsTitle = `gk-smoke-${Date.now()}`;
	const kvCreate = await cf(CF_KEY, 'POST', `${CF_BASE}/storage/kv/namespaces`, { title: nsTitle });
	assertStatus('KV create namespace -> 200', kvCreate, 200);
	const nsId = kvCreate.body?.result?.id;
	assertTruthy('KV created namespace has id', nsId);
	if (nsId) state.createdKvNamespaces.push({ accountId: ACCOUNT_ID, nsId });

	if (nsId) {
		// Put value
		const kvPut = await req('PUT', `/cf${CF_BASE}/storage/kv/namespaces/${nsId}/values/smoke-key`, 'smoke-value', {
			Authorization: `Bearer ${CF_KEY}`,
			'Content-Type': 'multipart/form-data; boundary=----FormBoundary',
		});
		// KV put via multipart — use raw body for simplicity
		// Actually, let's use the JSON bulk write instead for simplicity
		const kvBulkWrite = await cf(CF_KEY, 'PUT', `${CF_BASE}/storage/kv/namespaces/${nsId}/bulk`, [
			{ key: 'smoke-key', value: 'smoke-value' },
		]);
		assertStatus('KV bulk write -> 200', kvBulkWrite, 200);

		// List keys
		const kvKeys = await cf(CF_KEY, 'GET', `${CF_BASE}/storage/kv/namespaces/${nsId}/keys`);
		assertStatus('KV list keys -> 200', kvKeys, 200);
		assertTruthy('KV list keys returns result', Array.isArray(kvKeys.body?.result));

		// Get value (binary passthrough)
		const kvGet = await req('GET', `/cf${CF_BASE}/storage/kv/namespaces/${nsId}/values/smoke-key`, undefined, {
			Authorization: `Bearer ${CF_KEY}`,
		});
		assertStatus('KV get value -> 200', kvGet, 200);
		assertJson('KV get value content', kvGet.raw, 'smoke-value');

		// Delete value
		const kvDel = await cf(CF_KEY, 'DELETE', `${CF_BASE}/storage/kv/namespaces/${nsId}/values/smoke-key`);
		assertStatus('KV delete value -> 200', kvDel, 200);

		// Delete namespace
		const kvNsDel = await cf(CF_KEY, 'DELETE', `${CF_BASE}/storage/kv/namespaces/${nsId}`);
		assertStatus('KV delete namespace -> 200', kvNsDel, 200);
		state.createdKvNamespaces = state.createdKvNamespaces.filter((n) => n.nsId !== nsId);
	}

	// ─── Workers: List ─────────────────────────────────────────────

	section('CF Proxy — Workers');

	const wList = await cf(CF_KEY, 'GET', `${CF_BASE}/workers/scripts`);
	assertStatus('Workers list scripts -> 200', wList, 200);
	assertTruthy('Workers list returns result array', Array.isArray(wList.body?.result));

	// Workers subdomain
	const wSubdomain = await cf(CF_KEY, 'GET', `${CF_BASE}/workers/subdomain`);
	assertStatus('Workers get subdomain -> 200', wSubdomain, 200);

	// ─── Queues: List ──────────────────────────────────────────────

	section('CF Proxy — Queues');

	const qList = await cf(CF_KEY, 'GET', `${CF_BASE}/queues`);
	assertStatus('Queues list -> 200', qList, 200);
	assertTruthy('Queues list returns result array', Array.isArray(qList.body?.result));

	// ─── Vectorize: List ───────────────────────────────────────────

	section('CF Proxy — Vectorize');

	const vList = await cf(CF_KEY, 'GET', `${CF_BASE}/vectorize/v2/indexes`);
	assertStatus('Vectorize list indexes -> 200', vList, 200);
	assertTruthy('Vectorize list returns result array', Array.isArray(vList.body?.result));

	// ─── Hyperdrive: List ──────────────────────────────────────────

	section('CF Proxy — Hyperdrive');

	const hList = await cf(CF_KEY, 'GET', `${CF_BASE}/hyperdrive/configs`);
	assertStatus('Hyperdrive list configs -> 200', hList, 200);
	assertTruthy('Hyperdrive list returns result array', Array.isArray(hList.body?.result));

	// ─── Wrangler CLI Integration ──────────────────────────────────

	section('CF Proxy — Wrangler CLI');

	// Wrangler uses CLOUDFLARE_API_BASE_URL + CLOUDFLARE_API_TOKEN.
	// CLOUDFLARE_API_KEY / CLOUDFLARE_EMAIL must NOT be set (they take precedence).
	const wranglerEnv: Record<string, string> = {
		CLOUDFLARE_API_BASE_URL: `${BASE}/cf`,
		CLOUDFLARE_API_TOKEN: CF_KEY,
		CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
		PATH: process.env['PATH'] ?? '',
		HOME: process.env['HOME'] ?? '',
		NODE_ENV: 'production',
	};

	/** Run a wrangler command through the proxy and return stdout or an error string. */
	function wrangler(args: string): { ok: boolean; out: string } {
		try {
			const out = execSync(`npx wrangler ${args}`, {
				env: wranglerEnv,
				timeout: 15_000,
				stdio: ['pipe', 'pipe', 'pipe'],
				encoding: 'utf-8',
			});
			return { ok: true, out: out.trim() };
		} catch (e: any) {
			const stderr = e.stderr?.toString()?.trim() ?? '';
			const stdout = e.stdout?.toString()?.trim() ?? '';
			return { ok: false, out: stderr || stdout || e.message };
		}
	}

	// wrangler d1 list
	const wD1 = wrangler('d1 list --json');
	if (wD1.ok) {
		state.pass++;
		const parsed = JSON.parse(wD1.out);
		console.log(`  ${green('PASS')}  wrangler d1 list ${dim(`(${parsed.length} databases)`)}`);
	} else {
		state.fail++;
		state.errors.push(`wrangler d1 list: ${wD1.out.slice(0, 120)}`);
		console.log(`  ${red('FAIL')}  wrangler d1 list ${dim(`(${wD1.out.slice(0, 120)})`)}`);
	}

	// wrangler kv namespace list
	const wKV = wrangler('kv namespace list');
	if (wKV.ok) {
		state.pass++;
		const count = (wKV.out.match(/"title"/g) ?? []).length;
		console.log(`  ${green('PASS')}  wrangler kv namespace list ${dim(`(${count} namespaces)`)}`);
	} else {
		state.fail++;
		state.errors.push(`wrangler kv namespace list: ${wKV.out.slice(0, 120)}`);
		console.log(`  ${red('FAIL')}  wrangler kv namespace list ${dim(`(${wKV.out.slice(0, 120)})`)}`);
	}

	// wrangler queues list
	const wQ = wrangler('queues list');
	if (wQ.ok) {
		state.pass++;
		console.log(`  ${green('PASS')}  wrangler queues list`);
	} else {
		state.fail++;
		state.errors.push(`wrangler queues list: ${wQ.out.slice(0, 120)}`);
		console.log(`  ${red('FAIL')}  wrangler queues list ${dim(`(${wQ.out.slice(0, 120)})`)}`);
	}

	// wrangler with insufficient policy -> should fail
	const wDenied = (() => {
		try {
			execSync('npx wrangler d1 list --json', {
				env: { ...wranglerEnv, CLOUDFLARE_API_TOKEN: D1_RO_KEY },
				timeout: 15_000,
				stdio: ['pipe', 'pipe', 'pipe'],
				encoding: 'utf-8',
			});
			return { ok: true, out: '' };
		} catch (e: any) {
			return { ok: false, out: e.stderr?.toString() ?? '' };
		}
	})();
	// d1:list IS allowed for the readonly key, so this should succeed
	if (wDenied.ok) {
		state.pass++;
		console.log(`  ${green('PASS')}  wrangler d1 list with read-only key -> allowed`);
	} else {
		state.fail++;
		state.errors.push('wrangler d1 list with read-only key should succeed (d1:list is allowed)');
		console.log(`  ${red('FAIL')}  wrangler d1 list with read-only key -> unexpected error`);
	}

	// ─── D1: Resource-Scoped Key Enforcement ──────────────────────

	section('CF Proxy — D1 Resource Scoping');

	// 1a. Key scoped to a specific D1 database — wrong database should be 403
	// Create two databases: one the key is scoped to, one it isn't
	const scopeDbName1 = `gk-scope-allow-${Date.now()}`;
	const scopeDb1 = await cf(CF_KEY, 'POST', `${CF_BASE}/d1/database`, { name: scopeDbName1 });
	assertStatus('D1 scope: create db-allow -> 200', scopeDb1, 200);
	const scopeDbId1 = scopeDb1.body?.result?.uuid;
	if (scopeDbId1) state.createdD1Databases.push({ accountId: ACCOUNT_ID, dbId: scopeDbId1 });

	const scopeDbName2 = `gk-scope-deny-${Date.now()}`;
	const scopeDb2 = await cf(CF_KEY, 'POST', `${CF_BASE}/d1/database`, { name: scopeDbName2 });
	assertStatus('D1 scope: create db-deny -> 200', scopeDb2, 200);
	const scopeDbId2 = scopeDb2.body?.result?.uuid;
	if (scopeDbId2) state.createdD1Databases.push({ accountId: ACCOUNT_ID, dbId: scopeDbId2 });

	if (scopeDbId1 && scopeDbId2) {
		// Create key scoped to db1 only
		const d1ScopedPolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['d1:query', 'd1:get'],
					resources: [`account:${ACCOUNT_ID}/d1/${scopeDbId1}`],
				},
			],
		};
		const { r: d1sCr, keyId: D1_SCOPED_KEY } = await createCfKey('smoke-d1-db-scoped', d1ScopedPolicy, ctx.cfProxyUpstreamId);
		assertStatus('D1 db-scoped key created -> 200', d1sCr, 200);

		// Query the correct database -> 200
		const d1sOk = await cf(D1_SCOPED_KEY, 'POST', `${CF_BASE}/d1/database/${scopeDbId1}/query`, { sql: 'SELECT 1 as n' });
		assertStatus('db-scoped key: query correct db -> 200', d1sOk, 200);

		// Query the wrong database -> 403
		const d1sBad = await cf(D1_SCOPED_KEY, 'POST', `${CF_BASE}/d1/database/${scopeDbId2}/query`, { sql: 'SELECT 1 as n' });
		assertStatus('db-scoped key: query wrong db -> 403', d1sBad, 403);

		// List databases (account-level resource) -> 403 (resource is account:X, not account:X/d1/...)
		const d1sList = await cf(D1_SCOPED_KEY, 'GET', `${CF_BASE}/d1/database`);
		assertStatus('db-scoped key: list databases (account-level) -> 403', d1sList, 403);

		// Get the correct database -> 200
		const d1sGet = await cf(D1_SCOPED_KEY, 'GET', `${CF_BASE}/d1/database/${scopeDbId1}`);
		assertStatus('db-scoped key: get correct db -> 200', d1sGet, 200);

		// Get the wrong database -> 403
		const d1sGetBad = await cf(D1_SCOPED_KEY, 'GET', `${CF_BASE}/d1/database/${scopeDbId2}`);
		assertStatus('db-scoped key: get wrong db -> 403', d1sGetBad, 403);
	}

	// ─── KV: Resource-Scoped Key Enforcement ──────────────────────

	section('CF Proxy — KV Resource Scoping');

	// 1b. Key scoped to a specific KV namespace — wrong namespace should be 403
	// Create a dedicated namespace for scoping tests (the CRUD namespace is already deleted)
	const scopeNsTitle = `gk-scope-${Date.now()}`;
	const scopeNsCreate = await cf(CF_KEY, 'POST', `${CF_BASE}/storage/kv/namespaces`, { title: scopeNsTitle });
	assertStatus('KV scope: create namespace -> 200', scopeNsCreate, 200);
	const scopeNsId = scopeNsCreate.body?.result?.id;
	if (scopeNsId) state.createdKvNamespaces.push({ accountId: ACCOUNT_ID, nsId: scopeNsId });

	if (scopeNsId) {
		const kvScopedPolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['kv:list_keys', 'kv:get_value', 'kv:put_value'],
					resources: [`account:${ACCOUNT_ID}/kv/${scopeNsId}`],
				},
			],
		};
		const { r: kvsCr, keyId: KV_SCOPED_KEY } = await createCfKey('smoke-kv-ns-scoped', kvScopedPolicy, ctx.cfProxyUpstreamId);
		assertStatus('KV ns-scoped key created -> 200', kvsCr, 200);

		// List keys in correct namespace -> 200
		const kvsOk = await cf(KV_SCOPED_KEY, 'GET', `${CF_BASE}/storage/kv/namespaces/${scopeNsId}/keys`);
		assertStatus('ns-scoped key: list keys in correct ns -> 200', kvsOk, 200);

		// List keys in wrong namespace -> 403
		const fakeNs = 'aaaa1111bbbb2222cccc3333dddd4444';
		const kvsBad = await cf(KV_SCOPED_KEY, 'GET', `${CF_BASE}/storage/kv/namespaces/${fakeNs}/keys`);
		assertStatus('ns-scoped key: list keys in wrong ns -> 403', kvsBad, 403);

		// List namespaces (account-level) -> 403
		const kvsList = await cf(KV_SCOPED_KEY, 'GET', `${CF_BASE}/storage/kv/namespaces`);
		assertStatus('ns-scoped key: list namespaces (account-level) -> 403', kvsList, 403);

		// Clean up scope namespace
		await cf(CF_KEY, 'DELETE', `${CF_BASE}/storage/kv/namespaces/${scopeNsId}`);
		state.createdKvNamespaces = state.createdKvNamespaces.filter((n) => n.nsId !== scopeNsId);
	}

	// ─── D1: Deny on Specific Sub-Resource ────────────────────────

	section('CF Proxy — D1 Sub-Resource Deny');

	// 4a. Allow d1:* on account, deny d1:query on a specific database
	if (scopeDbId1 && scopeDbId2) {
		const denySubPolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['d1:*'],
					resources: [`account:${ACCOUNT_ID}`],
				},
				{
					effect: 'deny',
					actions: ['d1:query'],
					resources: [`account:${ACCOUNT_ID}/d1/${scopeDbId2}`],
				},
			],
		};
		const { r: dsCr, keyId: DENY_SUB_KEY } = await createCfKey('smoke-d1-deny-sub', denySubPolicy, ctx.cfProxyUpstreamId);
		assertStatus('D1 deny-sub key created -> 200', dsCr, 200);

		// List databases (account-level) -> 200 (deny resource doesn't match account:X)
		const dsList = await cf(DENY_SUB_KEY, 'GET', `${CF_BASE}/d1/database`);
		assertStatus('deny-sub key: list databases -> 200', dsList, 200);

		// Query db1 (allowed db) -> 200
		const dsQueryOk = await cf(DENY_SUB_KEY, 'POST', `${CF_BASE}/d1/database/${scopeDbId1}/query`, { sql: 'SELECT 1' });
		assertStatus('deny-sub key: query allowed db -> 200', dsQueryOk, 200);

		// Query db2 (denied db) -> 403
		const dsQueryBad = await cf(DENY_SUB_KEY, 'POST', `${CF_BASE}/d1/database/${scopeDbId2}/query`, { sql: 'SELECT 1' });
		assertStatus('deny-sub key: query denied db -> 403', dsQueryBad, 403);

		// Get db2 (d1:get, not d1:query) -> 200 (deny only covers d1:query)
		const dsGetOk = await cf(DENY_SUB_KEY, 'GET', `${CF_BASE}/d1/database/${scopeDbId2}`);
		assertStatus('deny-sub key: get denied db (d1:get not denied) -> 200', dsGetOk, 200);

		// Clean up scope databases
		await cf(CF_KEY, 'DELETE', `${CF_BASE}/d1/database/${scopeDbId1}`);
		state.createdD1Databases = state.createdD1Databases.filter((d) => d.dbId !== scopeDbId1);
		await cf(CF_KEY, 'DELETE', `${CF_BASE}/d1/database/${scopeDbId2}`);
		state.createdD1Databases = state.createdD1Databases.filter((d) => d.dbId !== scopeDbId2);
	}

	// ─── Workers: Script-Scoped Key Enforcement ──────────────────

	section('CF Proxy — Workers Script Scoping');

	// Need at least two scripts to test scoping. Use the Workers list to find real scripts.
	const wScripts = wList.body?.result ?? [];
	const scriptA = wScripts[0]?.id;
	const scriptB = wScripts[1]?.id;

	if (scriptA) {
		// Key scoped to a specific worker script
		const workerScopedPolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['workers:get_script', 'workers:get_settings', 'workers:list_versions'],
					resources: [`account:${ACCOUNT_ID}/workers/${scriptA}`],
				},
			],
		};
		const { r: wsCr, keyId: WS_KEY } = await createCfKey('smoke-worker-scoped', workerScopedPolicy, ctx.cfProxyUpstreamId);
		assertStatus('worker-scoped key created -> 200', wsCr, 200);

		// Get the correct script -> not 403 (CF API may return 200 or 204)
		const wsGetOk = await cf(WS_KEY, 'GET', `${CF_BASE}/workers/scripts/${scriptA}`);
		assertTruthy('worker-scoped: get correct script -> not 403', wsGetOk.status !== 403);

		// Get a different script (or fake name) -> 403
		const wrongScript = scriptB ?? 'nonexistent-script-12345';
		const wsGetBad = await cf(WS_KEY, 'GET', `${CF_BASE}/workers/scripts/${wrongScript}`);
		assertStatus('worker-scoped: get wrong script -> 403', wsGetBad, 403);

		// List scripts (account-level) -> 403 (resource is account:X, not account:X/workers/...)
		const wsList = await cf(WS_KEY, 'GET', `${CF_BASE}/workers/scripts`);
		assertStatus('worker-scoped: list scripts (account-level) -> 403', wsList, 403);

		// Get settings on correct script -> 200
		const wsSettingsOk = await cf(WS_KEY, 'GET', `${CF_BASE}/workers/scripts/${scriptA}/settings`);
		assertStatus('worker-scoped: get settings on correct script -> 200', wsSettingsOk, 200);

		// Get settings on wrong script -> 403
		const wsSettingsBad = await cf(WS_KEY, 'GET', `${CF_BASE}/workers/scripts/${wrongScript}/settings`);
		assertStatus('worker-scoped: get settings on wrong script -> 403', wsSettingsBad, 403);
	} else {
		console.log(`  ${yellow('SKIP')}  Workers Script Scoping (no scripts found in account)`);
	}

	// ─── Workers: Deny Specific Script Operation ─────────────────

	section('CF Proxy — Workers Deny Script Operation');

	if (scriptA) {
		// Allow all workers:* on account, deny workers:delete_script on specific script
		const workerDenyPolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['workers:*'],
					resources: [`account:${ACCOUNT_ID}`],
				},
				{
					effect: 'deny',
					actions: ['workers:delete_script'],
					resources: [`account:${ACCOUNT_ID}/workers/${scriptA}`],
				},
			],
		};
		const { r: wdCr, keyId: WD_KEY } = await createCfKey('smoke-worker-deny-delete', workerDenyPolicy, ctx.cfProxyUpstreamId);
		assertStatus('worker-deny-delete key created -> 200', wdCr, 200);

		// List scripts -> 200 (account-level, allow workers:*)
		const wdList = await cf(WD_KEY, 'GET', `${CF_BASE}/workers/scripts`);
		assertStatus('worker-deny: list scripts -> 200', wdList, 200);

		// Get the denied script -> not 403 (deny only on delete; CF API may return 200 or 204)
		const wdGetOk = await cf(WD_KEY, 'GET', `${CF_BASE}/workers/scripts/${scriptA}`);
		assertTruthy('worker-deny: get denied script -> not 403 (only delete denied)', wdGetOk.status !== 403);

		// Delete the denied script -> 403
		const wdDelBad = await cf(WD_KEY, 'DELETE', `${CF_BASE}/workers/scripts/${scriptA}`);
		assertStatus('worker-deny: delete denied script -> 403', wdDelBad, 403);

		// If there's a second script, delete on it should be allowed (deny only on scriptA)
		if (scriptB) {
			// Get second script should work (CF API may return 200 or 204)
			const wdGetB = await cf(WD_KEY, 'GET', `${CF_BASE}/workers/scripts/${scriptB}`);
			assertTruthy('worker-deny: get other script -> not 403', wdGetB.status !== 403);
		}
	} else {
		console.log(`  ${yellow('SKIP')}  Workers Deny Script Operation (no scripts found)`);
	}

	// ─── Workers: script_name Condition ───────────────────────────

	section('CF Proxy — Workers Condition Fields');

	if (scriptA) {
		// Allow workers:get_script with condition on workers.script_name
		const workerCondPolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['workers:get_script', 'workers:get_settings'],
					resources: [`account:${ACCOUNT_ID}`],
					conditions: [{ field: 'workers.script_name', operator: 'eq', value: scriptA }],
				},
			],
		};
		const { r: wcondCr, keyId: WCOND_KEY } = await createCfKey('smoke-worker-cond', workerCondPolicy, ctx.cfProxyUpstreamId);
		assertStatus('worker-cond key created -> 200', wcondCr, 200);

		const wcondOk = await cf(WCOND_KEY, 'GET', `${CF_BASE}/workers/scripts/${scriptA}`);
		assertTruthy('worker-cond: get correct script (field match) -> not 403', wcondOk.status !== 403);

		const wrongScript = scriptB ?? 'nonexistent-script-xyz';
		const wcondBad = await cf(WCOND_KEY, 'GET', `${CF_BASE}/workers/scripts/${wrongScript}`);
		assertStatus('worker-cond: get wrong script (field mismatch) -> 403', wcondBad, 403);
	} else {
		console.log(`  ${yellow('SKIP')}  Workers Condition Fields (no scripts found)`);
	}

	// ─── D1: sql_command Condition ────────────────────────────────

	section('CF Proxy — D1 sql_command Condition');

	// Create a temp database for condition testing
	const condDbName = `gk-cond-${Date.now()}`;
	const condDb = await cf(CF_KEY, 'POST', `${CF_BASE}/d1/database`, { name: condDbName });
	assertStatus('D1 cond: create test db -> 200', condDb, 200);
	const condDbId = condDb.body?.result?.uuid;
	if (condDbId) state.createdD1Databases.push({ accountId: ACCOUNT_ID, dbId: condDbId });

	if (condDbId) {
		// Key that only allows SELECT queries (d1.sql_command == "select")
		const d1SelectOnlyPolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['d1:query'],
					resources: [`account:${ACCOUNT_ID}/d1/${condDbId}`],
					conditions: [{ field: 'd1.sql_command', operator: 'eq', value: 'select' }],
				},
			],
		};
		const { r: dscCr, keyId: D1_SELECT_KEY } = await createCfKey('smoke-d1-select-only', d1SelectOnlyPolicy, ctx.cfProxyUpstreamId);
		assertStatus('D1 select-only key created -> 200', dscCr, 200);

		// SELECT query -> 200
		const dscOk = await cf(D1_SELECT_KEY, 'POST', `${CF_BASE}/d1/database/${condDbId}/query`, { sql: 'SELECT 1 as n' });
		assertStatus('d1-select-only: SELECT -> 200', dscOk, 200);

		// INSERT query -> 403 (sql_command = "insert", not "select")
		const dscBad = await cf(D1_SELECT_KEY, 'POST', `${CF_BASE}/d1/database/${condDbId}/query`, {
			sql: 'CREATE TABLE IF NOT EXISTS test_cond (id INTEGER PRIMARY KEY)',
		});
		assertStatus('d1-select-only: CREATE -> 403', dscBad, 403);

		// Allow d1:query + deny when sql_command is "drop" or "delete"
		const d1DenyDangerousPolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['d1:query', 'd1:get', 'd1:list'],
					resources: [`account:${ACCOUNT_ID}`],
				},
				{
					effect: 'deny',
					actions: ['d1:query'],
					resources: [`account:${ACCOUNT_ID}`],
					conditions: [{ field: 'd1.sql_command', operator: 'in', value: ['drop', 'delete', 'alter'] }],
				},
			],
		};
		const { r: ddgCr, keyId: D1_SAFE_KEY } = await createCfKey('smoke-d1-deny-dangerous', d1DenyDangerousPolicy, ctx.cfProxyUpstreamId);
		assertStatus('D1 deny-dangerous key created -> 200', ddgCr, 200);

		// SELECT -> 200
		const ddgSelect = await cf(D1_SAFE_KEY, 'POST', `${CF_BASE}/d1/database/${condDbId}/query`, { sql: 'SELECT 1' });
		assertStatus('d1-deny-dangerous: SELECT -> 200', ddgSelect, 200);

		// Create table -> 200 (sql_command = "create", not in deny list)
		const ddgCreate = await cf(D1_SAFE_KEY, 'POST', `${CF_BASE}/d1/database/${condDbId}/query`, {
			sql: 'CREATE TABLE IF NOT EXISTS safe_test (id INTEGER PRIMARY KEY)',
		});
		assertStatus('d1-deny-dangerous: CREATE TABLE -> 200 (not denied)', ddgCreate, 200);

		// DROP TABLE -> 403
		const ddgDrop = await cf(D1_SAFE_KEY, 'POST', `${CF_BASE}/d1/database/${condDbId}/query`, {
			sql: 'DROP TABLE IF EXISTS safe_test',
		});
		assertStatus('d1-deny-dangerous: DROP TABLE -> 403', ddgDrop, 403);

		// List databases -> 200 (deny only on d1:query)
		const ddgList = await cf(D1_SAFE_KEY, 'GET', `${CF_BASE}/d1/database`);
		assertStatus('d1-deny-dangerous: list databases -> 200', ddgList, 200);
	}

	// ─── KV: key_name Condition ──────────────────────────────────

	section('CF Proxy — KV key_name Condition');

	// Create a namespace for condition testing
	const condNsTitle = `gk-kv-cond-${Date.now()}`;
	const condNs = await cf(CF_KEY, 'POST', `${CF_BASE}/storage/kv/namespaces`, { title: condNsTitle });
	assertStatus('KV cond: create test namespace -> 200', condNs, 200);
	const condNsId = condNs.body?.result?.id;
	if (condNsId) state.createdKvNamespaces.push({ accountId: ACCOUNT_ID, nsId: condNsId });

	if (condNsId) {
		// Write some test keys first (using the wildcard key)
		await cf(CF_KEY, 'PUT', `${CF_BASE}/storage/kv/namespaces/${condNsId}/bulk`, [
			{ key: 'config/app', value: 'app-settings' },
			{ key: 'config/db', value: 'db-settings' },
			{ key: 'secrets/api-key', value: 'sensitive' },
			{ key: 'public/readme', value: 'hello' },
		]);

		// Key that only allows reading keys with "config/" prefix
		const kvPrefixPolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['kv:get_value'],
					resources: [`account:${ACCOUNT_ID}/kv/${condNsId}`],
					conditions: [{ field: 'kv.key_name', operator: 'starts_with', value: 'config/' }],
				},
			],
		};
		const { r: kvpCr, keyId: KV_PREFIX_KEY } = await createCfKey('smoke-kv-key-prefix', kvPrefixPolicy, ctx.cfProxyUpstreamId);
		assertStatus('KV key-prefix key created -> 200', kvpCr, 200);

		// Get config/app -> not 403 (KV bulk write is eventually consistent, may return 404)
		const kvpOk = await req('GET', `/cf${CF_BASE}/storage/kv/namespaces/${condNsId}/values/config/app`, undefined, {
			Authorization: `Bearer ${KV_PREFIX_KEY}`,
		});
		assertTruthy('kv-prefix: get config/app -> not 403 (IAM allows)', kvpOk.status !== 403);

		// Get secrets/api-key -> 403 (key_name doesn't start with config/)
		const kvpBad = await req('GET', `/cf${CF_BASE}/storage/kv/namespaces/${condNsId}/values/secrets/api-key`, undefined, {
			Authorization: `Bearer ${KV_PREFIX_KEY}`,
		});
		assertStatus('kv-prefix: get secrets/api-key -> 403', kvpBad, 403);

		// Allow kv:* but deny writing to keys matching "secrets/*"
		const kvDenySecretsPolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['kv:get_value', 'kv:put_value', 'kv:list_keys'],
					resources: [`account:${ACCOUNT_ID}/kv/${condNsId}`],
				},
				{
					effect: 'deny',
					actions: ['kv:put_value'],
					resources: [`account:${ACCOUNT_ID}/kv/${condNsId}`],
					conditions: [{ field: 'kv.key_name', operator: 'starts_with', value: 'secrets/' }],
				},
			],
		};
		const { r: kvdsCr, keyId: KV_DENY_SEC_KEY } = await createCfKey('smoke-kv-deny-secrets', kvDenySecretsPolicy, ctx.cfProxyUpstreamId);
		assertStatus('KV deny-secrets key created -> 200', kvdsCr, 200);

		// Read secrets key -> not 403 (deny only on put_value; KV bulk write may not have propagated)
		const kvdsReadOk = await req('GET', `/cf${CF_BASE}/storage/kv/namespaces/${condNsId}/values/secrets/api-key`, undefined, {
			Authorization: `Bearer ${KV_DENY_SEC_KEY}`,
		});
		assertTruthy('kv-deny-secrets: read secrets/ -> not 403 (deny on put only)', kvdsReadOk.status !== 403);

		// List keys -> 200
		const kvdsListOk = await cf(KV_DENY_SEC_KEY, 'GET', `${CF_BASE}/storage/kv/namespaces/${condNsId}/keys`);
		assertStatus('kv-deny-secrets: list keys -> 200', kvdsListOk, 200);

		// Clean up condition namespace
		await cf(CF_KEY, 'DELETE', `${CF_BASE}/storage/kv/namespaces/${condNsId}`);
		state.createdKvNamespaces = state.createdKvNamespaces.filter((n) => n.nsId !== condNsId);
	}

	// ─── Cross-Service Scoping ───────────────────────────────────

	section('CF Proxy — Cross-Service Scoping');

	// Key with D1 + KV scoped to specific resources, but not Workers
	// This tests that a key can span services but only with the right resources
	if (condDbId) {
		const crossServicePolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['d1:query', 'd1:get'],
					resources: [`account:${ACCOUNT_ID}/d1/${condDbId}`],
				},
				{
					effect: 'allow',
					actions: ['kv:list_namespaces'],
					resources: [`account:${ACCOUNT_ID}`],
				},
			],
		};
		const { r: csCr, keyId: CS_KEY } = await createCfKey('smoke-cross-service', crossServicePolicy, ctx.cfProxyUpstreamId);
		assertStatus('cross-service key created -> 200', csCr, 200);

		// D1 query on allowed db -> 200
		const csD1Ok = await cf(CS_KEY, 'POST', `${CF_BASE}/d1/database/${condDbId}/query`, { sql: 'SELECT 1' });
		assertStatus('cross-service: D1 query allowed db -> 200', csD1Ok, 200);

		// KV list namespaces -> 200
		const csKvOk = await cf(CS_KEY, 'GET', `${CF_BASE}/storage/kv/namespaces`);
		assertStatus('cross-service: KV list namespaces -> 200', csKvOk, 200);

		// Workers list -> 403 (no workers actions in policy)
		const csWorkersBad = await cf(CS_KEY, 'GET', `${CF_BASE}/workers/scripts`);
		assertStatus('cross-service: workers list -> 403 (no workers actions)', csWorkersBad, 403);

		// D1 list databases -> 403 (only d1:query and d1:get, which need db-specific resource)
		const csD1ListBad = await cf(CS_KEY, 'GET', `${CF_BASE}/d1/database`);
		assertStatus('cross-service: D1 list (account-level) -> 403', csD1ListBad, 403);

		// D1 create -> 403 (no d1:create action)
		const csD1CreateBad = await cf(CS_KEY, 'POST', `${CF_BASE}/d1/database`, { name: 'should-fail' });
		assertStatus('cross-service: D1 create -> 403 (no action)', csD1CreateBad, 403);

		// Clean up the condition test database
		await cf(CF_KEY, 'DELETE', `${CF_BASE}/d1/database/${condDbId}`);
		state.createdD1Databases = state.createdD1Databases.filter((d) => d.dbId !== condDbId);
	}

	// ─── Multi-Service Allow + Deny ──────────────────────────────

	section('CF Proxy — Multi-Service Allow + Deny');

	// Allow all D1 + KV + Workers, deny d1:delete and kv:delete_namespace
	const multiDenyPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['d1:*', 'kv:*', 'workers:*'],
				resources: [`account:${ACCOUNT_ID}`],
			},
			{
				effect: 'deny',
				actions: ['d1:delete', 'kv:delete_namespace', 'workers:delete_script'],
				resources: [`account:${ACCOUNT_ID}`],
			},
		],
	};
	const { r: mdCr, keyId: MD_KEY } = await createCfKey('smoke-multi-deny', multiDenyPolicy, ctx.cfProxyUpstreamId);
	assertStatus('multi-service deny key created -> 200', mdCr, 200);

	// D1 list -> 200
	const mdD1List = await cf(MD_KEY, 'GET', `${CF_BASE}/d1/database`);
	assertStatus('multi-deny: D1 list -> 200', mdD1List, 200);

	// KV list namespaces -> 200
	const mdKvList = await cf(MD_KEY, 'GET', `${CF_BASE}/storage/kv/namespaces`);
	assertStatus('multi-deny: KV list -> 200', mdKvList, 200);

	// Workers list -> 200
	const mdWorkersList = await cf(MD_KEY, 'GET', `${CF_BASE}/workers/scripts`);
	assertStatus('multi-deny: Workers list -> 200', mdWorkersList, 200);

	// D1 delete on a fake db -> 403 (denied even though action would match d1:*)
	const mdD1Del = await cf(MD_KEY, 'DELETE', `${CF_BASE}/d1/database/fake-db-id-12345`);
	assertStatus('multi-deny: D1 delete -> 403 (denied)', mdD1Del, 403);

	// Workers delete on any script -> 403
	if (scriptA) {
		const mdWDel = await cf(MD_KEY, 'DELETE', `${CF_BASE}/workers/scripts/${scriptA}`);
		assertStatus('multi-deny: Workers delete script -> 403 (denied)', mdWDel, 403);
	}

	// ─── CF Proxy Analytics ────────────────────────────────────────

	section('CF Proxy Analytics');

	// Wait for fire-and-forget D1 writes
	await sleep(1500);

	const events = await admin('GET', `/admin/cf/analytics/events?account_id=${ACCOUNT_ID}`);
	assertStatus('CF proxy events -> 200', events, 200);
	const eventCount = events.body?.result?.length ?? 0;
	assertTruthy(`CF proxy event count > 0 (got ${eventCount})`, eventCount > 0);

	const ev0 = events.body?.result?.[0];
	assertTruthy('CF proxy event has key_id', ev0?.key_id?.startsWith('gw_'));
	assertJson('CF proxy event has account_id', ev0?.account_id, ACCOUNT_ID);
	assertTruthy('CF proxy event has service', typeof ev0?.service === 'string');
	assertTruthy('CF proxy event has action', typeof ev0?.action === 'string');

	const summary = await admin('GET', `/admin/cf/analytics/summary?account_id=${ACCOUNT_ID}`);
	assertStatus('CF proxy summary -> 200', summary, 200);
	assertTruthy('CF proxy summary has total_requests', summary.body?.result?.total_requests > 0);

	// ─── Cleanup upstream token ────────────────────────────────────
	// Cleanup happens in the orchestrator's finally block via ctx.cfProxyUpstreamId
}
