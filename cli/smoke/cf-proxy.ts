/**
 * Smoke tests — CF API Proxy: D1, KV, Workers, Queues, Vectorize, Hyperdrive.
 *
 * Tests auth enforcement, CRUD operations through the proxy, IAM policy scoping,
 * and analytics recording.
 */

import { execSync } from 'node:child_process';
import type { SmokeContext } from './helpers.js';
import { req, admin, section, assertStatus, assertJson, assertTruthy, state, sleep, green, red, dim, yellow, BASE } from './helpers.js';

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
