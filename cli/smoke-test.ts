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

import { readFileSync } from 'node:fs';
import { AwsClient } from 'aws4fetch';

// ─── ANSI helpers ──────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY ?? false;
const noColor = !!process.env['NO_COLOR'];
const color = isTTY && !noColor;

const green = (s: string) => (color ? `\x1b[32m${s}\x1b[39m` : s);
const red = (s: string) => (color ? `\x1b[31m${s}\x1b[39m` : s);
const yellow = (s: string) => (color ? `\x1b[33m${s}\x1b[39m` : s);
const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[22m` : s);
const magenta = (s: string) => (color ? `\x1b[35m${s}\x1b[39m` : s);
const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[22m` : s);

// ─── Config ────────────────────────────────────────────────────────────────

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

/** Read a key=value from a file (no quotes handling — matches the .env/.dev.vars format). */
function readVar(file: string, key: string): string | undefined {
	try {
		const content = readFileSync(file, 'utf-8');
		const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
		return match?.[1]?.trim();
	} catch {
		return undefined;
	}
}

const BASE = (process.env['GATEKEEPER_URL'] ?? 'http://localhost:8787').replace(/\/+$/, '');
const IS_REMOTE = BASE.startsWith('https://');

const ADMIN_KEY = IS_REMOTE
	? (process.env['GATEKEEPER_ADMIN_KEY'] ?? readVar('.env', 'GATEKEEPER_ADMIN_KEY'))
	: readVar('.dev.vars', 'ADMIN_KEY');

if (!ADMIN_KEY) {
	console.error('ERROR: Admin key not found. Set GATEKEEPER_ADMIN_KEY or check .env / .dev.vars');
	process.exit(1);
}

const CF_API_TOKEN = process.env['CF_API_TOKEN'] ?? readVar('.env', 'UPSTREAM_PURGE_KEY');
if (!CF_API_TOKEN) {
	console.error('ERROR: CF API token not found. Set CF_API_TOKEN or UPSTREAM_PURGE_KEY in .env');
	process.exit(1);
}

const R2_ACCESS_KEY = process.env['R2_ACCESS_KEY'] ?? readVar('.env', 'R2_TEST_ACCESS_KEY');
const R2_SECRET_KEY = process.env['R2_SECRET_KEY'] ?? readVar('.env', 'R2_TEST_SECRET_KEY');
const R2_ENDPOINT = process.env['R2_ENDPOINT'] ?? readVar('.env', 'R2_TEST_ENDPOINT');
const S3_TEST_BUCKET = process.env['S3_TEST_BUCKET'] ?? 'vault';
const SKIP_S3 = !R2_ACCESS_KEY || !R2_SECRET_KEY || !R2_ENDPOINT;

// ─── Test state ────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const errors: string[] = [];
const createdKeys: string[] = [];
const createdS3Creds: string[] = [];

// ─── HTTP helpers ──────────────────────────────────────────────────────────

interface Resp {
	status: number;
	body: any;
	headers: Headers;
	raw: string;
}

async function req(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<Resp> {
	const headers: Record<string, string> = { ...extraHeaders };
	if (body && typeof body !== 'string') {
		headers['Content-Type'] = 'application/json';
	}
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
	});
	const raw = await res.text();
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = null;
	}
	return { status: res.status, body: parsed, headers: res.headers, raw };
}

function admin(method: string, path: string, body?: unknown): Promise<Resp> {
	return req(method, path, body, { 'X-Admin-Key': ADMIN_KEY! });
}

function purge(keyId: string, path: string, body: unknown): Promise<Resp> {
	return req('POST', path, body, { Authorization: `Bearer ${keyId}` });
}

// ─── Assertion helpers ─────────────────────────────────────────────────────

function assertStatus(name: string, r: Resp, expected: number): void {
	if (r.status === expected) {
		pass++;
		console.log(`  ${green('PASS')}  ${name} ${dim(`(HTTP ${r.status})`)}`);
	} else {
		fail++;
		errors.push(`${name}: expected HTTP ${expected}, got HTTP ${r.status}`);
		console.log(`  ${red('FAIL')}  ${name} ${dim(`(expected ${expected}, got ${r.status})`)}`);
	}
	if (VERBOSE) console.log(JSON.stringify(r.body, null, 2));
}

function assertJson(name: string, value: unknown, expected: unknown): void {
	const ok = JSON.stringify(value) === JSON.stringify(expected);
	if (ok) {
		pass++;
		console.log(`  ${green('PASS')}  ${name} ${dim(`(${JSON.stringify(value)})`)}`);
	} else {
		fail++;
		errors.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
		console.log(`  ${red('FAIL')}  ${name} ${dim(`(expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)})`)}`);
	}
}

function assertMatch(name: string, value: string, pattern: RegExp): void {
	if (pattern.test(value)) {
		pass++;
		console.log(`  ${green('PASS')}  ${name}`);
	} else {
		fail++;
		errors.push(`${name}: '${value}' did not match ${pattern}`);
		console.log(`  ${red('FAIL')}  ${name} ${dim(`('${value}' !~ ${pattern})`)}`);
	}
}

function assertTruthy(name: string, value: unknown): void {
	if (value) {
		pass++;
		console.log(`  ${green('PASS')}  ${name}`);
	} else {
		fail++;
		errors.push(`${name}: expected truthy, got ${JSON.stringify(value)}`);
		console.log(`  ${red('FAIL')}  ${name} ${dim(`(falsy: ${JSON.stringify(value)})`)}`);
	}
}

function section(name: string): void {
	console.log('');
	console.log(`${bold(magenta(`─── ${name} ───`))}`);
}

// ─── Key creation helper ───────────────────────────────────────────────────

async function createKey(name: string, zone: string, policy: object, extra?: object): Promise<{ r: Resp; keyId: string }> {
	const r = await admin('POST', '/admin/keys', { name, zone_id: zone, policy, ...extra });
	const keyId = r.body?.result?.key?.id ?? '';
	if (keyId) createdKeys.push(keyId);
	return { r, keyId };
}

// ─── S3 client helper ──────────────────────────────────────────────────────

function s3client(accessKeyId: string, secretAccessKey: string): AwsClient {
	return new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
}

async function s3req(client: AwsClient, method: string, path: string, body?: string | ReadableStream): Promise<Resp> {
	const url = `${BASE}/s3${path}`;
	const headers: Record<string, string> = { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };
	if (body && typeof body === 'string') headers['content-length'] = String(Buffer.byteLength(body));
	const signed = await client.sign(url, { method, headers, body });
	const res = await fetch(signed);
	const raw = await res.text();
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = null;
	}
	return { status: res.status, body: parsed, headers: res.headers, raw };
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

	// Track S3 upstream ID for cleanup
	let s3UpstreamId: string | undefined;

	try {
		// ─── 1. Health ──────────────────────────────────────────────────

		section('Health');
		const hr = await req('GET', '/health');
		assertStatus('GET /health -> 200', hr, 200);
		assertJson('health body has ok:true', hr.body?.ok, true);

		// ─── 2. Admin Authentication ────────────────────────────────────

		section('Admin Authentication');

		const noKey = await req('GET', `/admin/keys?zone_id=${ZONE}`);
		assertStatus('no admin key -> 401', noKey, 401);

		const wrongKey = await req('GET', `/admin/keys?zone_id=${ZONE}`, undefined, { 'X-Admin-Key': 'wrong-key-entirely' });
		assertStatus('wrong admin key -> 401', wrongKey, 401);

		const rightKey = await admin('GET', `/admin/keys?zone_id=${ZONE}`);
		assertStatus('correct admin key -> 200', rightKey, 200);

		// ─── 3. Key Creation — happy path ───────────────────────────────

		section('Key Creation');

		const { r: wcr, keyId: WILDCARD_ID } = await createKey('smoke-wildcard', ZONE, WILDCARD_POLICY);
		assertStatus('create wildcard key -> 200', wcr, 200);
		assertTruthy('key has gw_ prefix', wcr.body?.result?.key?.id?.startsWith('gw_'));
		assertJson('key name matches', wcr.body?.result?.key?.name, 'smoke-wildcard');
		assertJson('key zone matches', wcr.body?.result?.key?.zone_id, ZONE);
		assertJson('key not revoked', wcr.body?.result?.key?.revoked, 0);

		const hostPolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['purge:host'],
					resources: [`zone:${ZONE}`],
					conditions: [{ field: 'host', operator: 'eq', value: 'erfi.io' }],
				},
			],
		};
		const { r: hr2, keyId: HOST_ID } = await createKey('smoke-host-scoped', ZONE, hostPolicy);
		assertStatus('create host-scoped key -> 200', hr2, 200);

		const tagPolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['purge:tag'],
					resources: [`zone:${ZONE}`],
					conditions: [{ field: 'tag', operator: 'starts_with', value: 'static-' }],
				},
			],
		};
		const { r: tr, keyId: TAG_ID } = await createKey('smoke-tag-scoped', ZONE, tagPolicy);
		assertStatus('create tag-scoped key -> 200', tr, 200);

		const prefixPolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['purge:prefix'],
					resources: [`zone:${ZONE}`],
					conditions: [{ field: 'prefix', operator: 'wildcard', value: 'erfi.io/assets/*' }],
				},
			],
		};
		const { r: pr, keyId: PREFIX_ID } = await createKey('smoke-prefix-scoped', ZONE, prefixPolicy);
		assertStatus('create prefix-scoped key -> 200', pr, 200);

		const urlPolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['purge:url'],
					resources: [`zone:${ZONE}`],
					conditions: [{ field: 'host', operator: 'eq', value: 'erfi.io' }],
				},
			],
		};
		const { r: ur, keyId: URL_ID } = await createKey('smoke-url-scoped', ZONE, urlPolicy);
		assertStatus('create url-scoped key -> 200', ur, 200);

		const multiPolicy = {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: ['purge:host', 'purge:tag'], resources: [`zone:${ZONE}`] }],
		};
		const { r: mr, keyId: MULTI_ID } = await createKey('smoke-multi-action', ZONE, multiPolicy);
		assertStatus('create multi-action key -> 200', mr, 200);

		const { r: rr, keyId: REVOKE_ID } = await createKey('smoke-revoke-target', ZONE, WILDCARD_POLICY);
		assertStatus('create key for revoke -> 200', rr, 200);

		const { r: rr2, keyId: REVOKE_ID_2 } = await createKey('smoke-revoke-target-2', ZONE, WILDCARD_POLICY);
		assertStatus('create second revoke target -> 200', rr2, 200);

		const rlr = await admin('POST', '/admin/keys', {
			name: 'smoke-with-ratelimit',
			zone_id: ZONE,
			policy: WILDCARD_POLICY,
			rate_limit: { bulk_rate: 10, bulk_bucket: 100 },
		});
		const RATELIMIT_ID = rlr.body?.result?.key?.id;
		if (RATELIMIT_ID) createdKeys.push(RATELIMIT_ID);
		assertStatus('create key with per-key rate limit -> 200', rlr, 200);
		assertJson('per-key bulk_rate stored', rlr.body?.result?.key?.bulk_rate, 10);
		assertJson('per-key bulk_bucket stored', rlr.body?.result?.key?.bulk_bucket, 100);

		// ─── 4. Key Creation — validation errors ────────────────────────

		section('Key Creation Validation');

		const noName = await admin('POST', '/admin/keys', { zone_id: ZONE, policy: WILDCARD_POLICY });
		assertStatus('missing name -> 400', noName, 400);

		const noZone = await admin('POST', '/admin/keys', { name: 'smoke-no-zone', policy: WILDCARD_POLICY });
		assertStatus('missing zone_id -> 200 (zone_id is optional)', noZone, 200);
		const noZoneKeyId = noZone.body?.result?.key?.id;
		if (noZoneKeyId) createdKeys.push(noZoneKeyId);

		const noPol = await admin('POST', '/admin/keys', { name: 'x', zone_id: ZONE });
		assertStatus('missing policy -> 400', noPol, 400);

		const badVer = await admin('POST', '/admin/keys', {
			name: 'x',
			zone_id: ZONE,
			policy: { version: 'wrong', statements: [] },
		});
		assertStatus('invalid policy version -> 400', badVer, 400);

		const emptyStmt = await admin('POST', '/admin/keys', {
			name: 'x',
			zone_id: ZONE,
			policy: { version: '2025-01-01', statements: [] },
		});
		assertStatus('empty statements -> 400', emptyStmt, 400);

		const badRegex = await admin('POST', '/admin/keys', {
			name: 'x',
			zone_id: ZONE,
			policy: {
				version: '2025-01-01',
				statements: [
					{
						effect: 'allow',
						actions: ['purge:*'],
						resources: [`zone:${ZONE}`],
						conditions: [{ field: 'x', operator: 'matches', value: '(a+)+$' }],
					},
				],
			},
		});
		assertStatus('dangerous regex -> 400', badRegex, 400);
		assertMatch('error mentions backtracking', badRegex.body?.errors?.[0]?.message ?? '', /backtracking/i);

		const denyEffect = await admin('POST', '/admin/keys', {
			name: 'x',
			zone_id: ZONE,
			policy: {
				version: '2025-01-01',
				statements: [{ effect: 'deny', actions: ['purge:*'], resources: [`zone:${ZONE}`] }],
			},
		});
		assertStatus('effect=deny -> 400', denyEffect, 400);

		const badJson = await req('POST', '/admin/keys', 'not json at all', {
			'X-Admin-Key': ADMIN_KEY!,
			'Content-Type': 'application/json',
		});
		assertStatus('invalid JSON body -> 400', badJson, 400);

		const bigRate = await admin('POST', '/admin/keys', {
			name: 'x',
			zone_id: ZONE,
			policy: WILDCARD_POLICY,
			rate_limit: { bulk_rate: 99999 },
		});
		assertStatus('rate_limit exceeds account default -> 400', bigRate, 400);

		// ─── 5. List Keys ───────────────────────────────────────────────

		section('List Keys');

		const listByZone = await admin('GET', `/admin/keys?zone_id=${ZONE}`);
		assertStatus('list keys by zone -> 200', listByZone, 200);
		const keyCount = listByZone.body?.result?.length ?? 0;
		assertTruthy(`key count >= 8 (got ${keyCount})`, keyCount >= 8);

		const listActive = await admin('GET', `/admin/keys?zone_id=${ZONE}&status=active`);
		assertStatus('list active keys -> 200', listActive, 200);

		const listAll = await admin('GET', '/admin/keys');
		assertStatus('list without zone_id -> 200 (returns all)', listAll, 200);

		const listEmpty = await admin('GET', '/admin/keys?zone_id=aaaa1111bbbb2222cccc3333dddd4444');
		assertStatus('list for unknown zone -> 200 (empty)', listEmpty, 200);
		assertJson('unknown zone returns empty', listEmpty.body?.result?.length, 0);

		// ─── 6. Get Key ─────────────────────────────────────────────────

		section('Get Key');

		const getKey = await admin('GET', `/admin/keys/${WILDCARD_ID}?zone_id=${ZONE}`);
		assertStatus('get existing key -> 200', getKey, 200);
		assertJson('get key returns correct id', getKey.body?.result?.key?.id, WILDCARD_ID);
		const parsedPol = JSON.parse(getKey.body?.result?.key?.policy ?? '{}');
		assertJson('get key has policy version', parsedPol?.version, '2025-01-01');

		const getNone = await admin('GET', `/admin/keys/gw_00000000000000000000000000000000?zone_id=${ZONE}`);
		assertStatus('get nonexistent key -> 404', getNone, 404);

		const getWrongZone = await admin('GET', `/admin/keys/${WILDCARD_ID}?zone_id=aaaa1111bbbb2222cccc3333dddd4444`);
		assertStatus('get key with wrong zone -> 404', getWrongZone, 404);

		const getNoZone = await admin('GET', `/admin/keys/${WILDCARD_ID}`);
		assertStatus('get key without zone_id -> 200', getNoZone, 200);

		// ─── 7. Purge Authentication ────────────────────────────────────

		section('Purge Authentication');

		const noAuth = await req('POST', PURGE_URL, { hosts: ['erfi.io'] });
		assertStatus('no auth header -> 401', noAuth, 401);
		assertJson('401 message', noAuth.body?.errors?.[0]?.message, 'Missing Authorization: Bearer <key>');

		const badKey = await purge('gw_00000000000000000000000000000000', PURGE_URL, { hosts: ['erfi.io'] });
		assertStatus('nonexistent key -> 401', badKey, 401);
		assertJson('401 invalid key', badKey.body?.errors?.[0]?.message, 'Invalid API key');

		const preRevoke = await purge(REVOKE_ID, PURGE_URL, { hosts: ['erfi.io'] });
		assertStatus('revoked key (not yet revoked) -> 200', preRevoke, 200);

		const wrongZone = await purge(WILDCARD_ID, '/v1/zones/aaaa1111bbbb2222cccc3333dddd4444/purge_cache', {
			hosts: ['erfi.io'],
		});
		assertStatus('wrong zone (no upstream token) -> 502', wrongZone, 502);

		// ─── 8. Purge Validation ────────────────────────────────────────

		section('Purge Validation');

		const badZoneFmt = await purge(WILDCARD_ID, '/v1/zones/not-a-hex-zone/purge_cache', { hosts: ['erfi.io'] });
		assertStatus('invalid zone ID format -> 400', badZoneFmt, 400);

		const badPurgeJson = await req('POST', PURGE_URL, 'broken json {{', {
			Authorization: `Bearer ${WILDCARD_ID}`,
			'Content-Type': 'application/json',
		});
		assertStatus('invalid JSON -> 400', badPurgeJson, 400);

		const emptyBody = await purge(WILDCARD_ID, PURGE_URL, {});
		assertStatus('empty body -> 400', emptyBody, 400);
		assertJson(
			'empty body message',
			emptyBody.body?.errors?.[0]?.message,
			'Request body must contain one of: files, hosts, tags, prefixes, or purge_everything',
		);

		const peFalse = await purge(WILDCARD_ID, PURGE_URL, { purge_everything: false });
		assertStatus('purge_everything=false -> 400', peFalse, 400);

		const files501 = Array.from({ length: 501 }, (_, i) => `https://erfi.io/${i}`);
		const oversize = await purge(WILDCARD_ID, PURGE_URL, { files: files501 });
		assertStatus('oversized files array (501) -> 400', oversize, 400);

		// ─── 9. Purge Happy Path — all 5 types ──────────────────────────

		section('Purge Happy Path (wildcard key)');

		const pHost = await purge(WILDCARD_ID, PURGE_URL, { hosts: ['erfi.io'] });
		assertStatus('host purge -> 200', pHost, 200);
		assertJson('host purge success', pHost.body?.success, true);

		const pTag = await purge(WILDCARD_ID, PURGE_URL, { tags: ['static-v1'] });
		assertStatus('tag purge -> 200', pTag, 200);

		const pPrefix = await purge(WILDCARD_ID, PURGE_URL, { prefixes: ['erfi.io/css/'] });
		assertStatus('prefix purge -> 200', pPrefix, 200);

		const pFile = await purge(WILDCARD_ID, PURGE_URL, { files: ['https://erfi.io/smoke-test.txt'] });
		assertStatus('single-file purge -> 200', pFile, 200);

		const pAll = await purge(WILDCARD_ID, PURGE_URL, { purge_everything: true });
		assertStatus('purge_everything -> 200', pAll, 200);

		const pMultiFile = await purge(WILDCARD_ID, PURGE_URL, {
			files: ['https://erfi.io/a.js', 'https://erfi.io/b.js', 'https://erfi.io/c.css'],
		});
		assertStatus('multi-file purge -> 200', pMultiFile, 200);

		const pMultiHost = await purge(WILDCARD_ID, PURGE_URL, { hosts: ['erfi.io', 'www.erfi.io'] });
		assertStatus('multi-host purge -> 200', pMultiHost, 200);

		const pMultiTag = await purge(WILDCARD_ID, PURGE_URL, { tags: ['v1', 'v2', 'v3'] });
		assertStatus('multi-tag purge -> 200', pMultiTag, 200);

		// ─── 10. Rate Limit Headers ─────────────────────────────────────

		section('Rate Limit Headers');

		const rlReq = await purge(WILDCARD_ID, PURGE_URL, { hosts: ['erfi.io'] });
		assertTruthy('Ratelimit header present', rlReq.headers.has('ratelimit'));
		assertTruthy('Ratelimit-Policy header present', rlReq.headers.has('ratelimit-policy'));
		assertMatch('Content-Type is JSON', rlReq.headers.get('content-type') ?? '', /application\/json/);

		// ─── 11. Scoped Key Authorization ───────────────────────────────

		section('Scoped Key Authorization');

		// Host-scoped
		const hostOk = await purge(HOST_ID, PURGE_URL, { hosts: ['erfi.io'] });
		assertStatus('host key: allowed host -> 200', hostOk, 200);

		const hostBad = await purge(HOST_ID, PURGE_URL, { hosts: ['evil.com'] });
		assertStatus('host key: disallowed host -> 403', hostBad, 403);
		assertJson('denied list present', hostBad.body?.denied?.[0], 'host:evil.com');

		const hostWrongAction = await purge(HOST_ID, PURGE_URL, { tags: ['foo'] });
		assertStatus('host key: tag purge (wrong action) -> 403', hostWrongAction, 403);

		const hostPE = await purge(HOST_ID, PURGE_URL, { purge_everything: true });
		assertStatus('host key: purge_everything (wrong action) -> 403', hostPE, 403);

		// Tag-scoped
		const tagOk = await purge(TAG_ID, PURGE_URL, { tags: ['static-v2'] });
		assertStatus('tag key: matching tag -> 200', tagOk, 200);

		const tagBad = await purge(TAG_ID, PURGE_URL, { tags: ['dynamic-v1'] });
		assertStatus('tag key: non-matching tag -> 403', tagBad, 403);

		const tagWrongAction = await purge(TAG_ID, PURGE_URL, { hosts: ['erfi.io'] });
		assertStatus('tag key: host purge (wrong action) -> 403', tagWrongAction, 403);

		// Prefix-scoped
		const prefixOk = await purge(PREFIX_ID, PURGE_URL, { prefixes: ['erfi.io/assets/css/'] });
		assertStatus('prefix key: matching prefix -> 200', prefixOk, 200);

		const prefixBad = await purge(PREFIX_ID, PURGE_URL, { prefixes: ['erfi.io/api/'] });
		assertStatus('prefix key: non-matching prefix -> 403', prefixBad, 403);

		// URL-scoped
		const urlOk = await purge(URL_ID, PURGE_URL, { files: ['https://erfi.io/page.html'] });
		assertStatus('url key: matching file host -> 200', urlOk, 200);

		const urlBad = await purge(URL_ID, PURGE_URL, { files: ['https://evil.com/page.html'] });
		assertStatus('url key: non-matching file host -> 403', urlBad, 403);

		// Multi-action
		const multiHost = await purge(MULTI_ID, PURGE_URL, { hosts: ['erfi.io'] });
		assertStatus('multi-action key: host purge -> 200', multiHost, 200);

		const multiTag = await purge(MULTI_ID, PURGE_URL, { tags: ['any-tag'] });
		assertStatus('multi-action key: tag purge -> 200', multiTag, 200);

		const multiPrefix = await purge(MULTI_ID, PURGE_URL, { prefixes: ['erfi.io/'] });
		assertStatus('multi-action key: prefix (not in actions) -> 403', multiPrefix, 403);

		const multiPE = await purge(MULTI_ID, PURGE_URL, { purge_everything: true });
		assertStatus('multi-action key: purge_everything (not in actions) -> 403', multiPE, 403);

		// Partial match
		const partial = await purge(HOST_ID, PURGE_URL, { hosts: ['erfi.io', 'evil.com'] });
		assertStatus('host key: partial match (1 ok, 1 denied) -> 403', partial, 403);
		assertJson('denied list has evil.com', partial.body?.denied?.[0], 'host:evil.com');

		// ─── 12. Revoke Key ─────────────────────────────────────────────

		section('Revoke Key');

		const revokeOk = await admin('DELETE', `/admin/keys/${REVOKE_ID}`);
		assertStatus('revoke key -> 200', revokeOk, 200);
		assertJson('revoke result', revokeOk.body?.result?.revoked, true);

		const revokeDup = await admin('DELETE', `/admin/keys/${REVOKE_ID}`);
		assertStatus('revoke already-revoked -> 404', revokeDup, 404);

		const listRevoked = await admin('GET', `/admin/keys?zone_id=${ZONE}&status=revoked`);
		assertStatus('list revoked keys -> 200', listRevoked, 200);
		const revokedInList = (listRevoked.body?.result ?? []).some((k: any) => k.id === REVOKE_ID);
		assertTruthy('revoked key appears in revoked filter', revokedInList);

		const revokeNone = await admin('DELETE', '/admin/keys/gw_00000000000000000000000000000000');
		assertStatus('revoke nonexistent key -> 404', revokeNone, 404);

		const revokeNoZone = await admin('DELETE', `/admin/keys/${REVOKE_ID_2}`);
		assertStatus('revoke without zone_id -> 200', revokeNoZone, 200);

		const purgeRevoked = await purge(REVOKE_ID, PURGE_URL, { hosts: ['erfi.io'] });
		assertStatus('purge with revoked key -> 403', purgeRevoked, 403);
		assertJson('403 revoked msg', purgeRevoked.body?.errors?.[0]?.message, 'API key has been revoked');

		// ─── 13. Analytics ──────────────────────────────────────────────

		section('Analytics');

		// Small delay for fire-and-forget D1 writes
		await sleep(1000);

		const events = await admin('GET', `/admin/analytics/events?zone_id=${ZONE}`);
		assertStatus('events -> 200', events, 200);
		const eventCount = events.body?.result?.length ?? 0;
		assertTruthy(`events count > 0 (got ${eventCount})`, eventCount > 0);

		const ev0 = events.body?.result?.[0];
		assertTruthy('event has key_id', ev0?.key_id?.startsWith('gw_'));
		assertJson('event has zone_id', ev0?.zone_id, ZONE);
		assertTruthy('event has purge_type', ev0?.purge_type?.length > 0);
		assertTruthy('event has status', ev0?.status > 0);

		const okEvent = (events.body?.result ?? []).find((e: any) => e.status === 200);
		assertTruthy('200-status event has response_detail', okEvent?.response_detail);

		const limited = await admin('GET', `/admin/analytics/events?zone_id=${ZONE}&limit=2`);
		assertStatus('events with limit -> 200', limited, 200);
		assertTruthy(`limit=2 respected (got ${limited.body?.result?.length})`, (limited.body?.result?.length ?? 99) <= 2);

		const byKey = await admin('GET', `/admin/analytics/events?zone_id=${ZONE}&key_id=${WILDCARD_ID}`);
		assertStatus('events filtered by key_id -> 200', byKey, 200);

		const summary = await admin('GET', `/admin/analytics/summary?zone_id=${ZONE}`);
		assertStatus('summary -> 200', summary, 200);
		assertTruthy('summary has total_requests', summary.body?.result?.total_requests > 0);
		assertTruthy('summary has by_status', Object.keys(summary.body?.result?.by_status ?? {}).length > 0);
		assertTruthy('summary has by_purge_type', Object.keys(summary.body?.result?.by_purge_type ?? {}).length > 0);

		const eventsNoZone = await admin('GET', '/admin/analytics/events');
		assertStatus('events without zone_id -> 200 (returns all)', eventsNoZone, 200);

		const summaryNoZone = await admin('GET', '/admin/analytics/summary');
		assertStatus('summary without zone_id -> 200 (returns all)', summaryNoZone, 200);

		// ─── 14. Dashboard Static Assets ────────────────────────────────

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
				fail++;
				errors.push('No JS asset found in dashboard HTML');
				console.log(`  ${red('FAIL')}  No JS asset found in dashboard HTML`);
			}
		}

		const rootIndex = await req('GET', '/');
		assertStatus('GET / -> 200 (root index)', rootIndex, 200);

		// ─── 15–19. S3 Proxy Tests ──────────────────────────────────────

		if (SKIP_S3) {
			section('S3 Proxy Tests (skipped — no R2 credentials)');
			console.log(`  ${yellow('SKIP')}  Set R2_TEST_ACCESS_KEY, R2_TEST_SECRET_KEY, R2_TEST_ENDPOINT in .env`);
		} else {
			// ─── 15. S3 Credential CRUD ─────────────────────────────────

			section('S3 Credential CRUD');

			// Register upstream R2 endpoint
			const r2Reg = await admin('POST', '/admin/upstream-r2', {
				name: 'smoke-r2',
				endpoint: R2_ENDPOINT,
				access_key_id: R2_ACCESS_KEY,
				secret_access_key: R2_SECRET_KEY,
				bucket_names: [S3_TEST_BUCKET],
			});
			s3UpstreamId = r2Reg.body?.result?.id;
			if (r2Reg.body?.success) {
				pass++;
				console.log(`  ${green('PASS')}  register upstream R2 -> success (${s3UpstreamId})`);
			} else {
				fail++;
				errors.push(`register upstream R2 failed: ${r2Reg.body?.errors?.[0]?.message ?? 'unknown'}`);
				console.log(`  ${red('FAIL')}  register upstream R2`);
			}

			// Full-access S3 credential
			const FULL_S3_POLICY = {
				version: '2025-01-01',
				statements: [{ effect: 'allow', actions: ['s3:*'], resources: ['*'] }],
			};
			const fullCred = await admin('POST', '/admin/s3/credentials', { name: 'smoke-s3-full', policy: FULL_S3_POLICY });
			assertStatus('create full-access S3 credential -> 200', fullCred, 200);
			const S3_FULL_AK = fullCred.body?.result?.credential?.access_key_id;
			const S3_FULL_SK = fullCred.body?.result?.credential?.secret_access_key;
			assertTruthy('S3 cred has GK prefix', S3_FULL_AK?.startsWith('GK'));
			if (S3_FULL_AK) createdS3Creds.push(S3_FULL_AK);

			// Read-only credential
			const READONLY_S3_POLICY = {
				version: '2025-01-01',
				statements: [
					{
						effect: 'allow',
						actions: ['s3:GetObject', 's3:HeadObject', 's3:ListBucket', 's3:ListAllMyBuckets'],
						resources: ['*'],
					},
				],
			};
			const roCred = await admin('POST', '/admin/s3/credentials', { name: 'smoke-s3-readonly', policy: READONLY_S3_POLICY });
			assertStatus('create read-only S3 credential -> 200', roCred, 200);
			const S3_RO_AK = roCred.body?.result?.credential?.access_key_id;
			const S3_RO_SK = roCred.body?.result?.credential?.secret_access_key;
			if (S3_RO_AK) createdS3Creds.push(S3_RO_AK);

			// List credentials
			const listCreds = await admin('GET', '/admin/s3/credentials');
			assertStatus('list S3 credentials -> 200', listCreds, 200);
			const smokeCredCount = (listCreds.body?.result ?? []).filter(
				(c: any) => c.access_key_id === S3_FULL_AK || c.access_key_id === S3_RO_AK,
			).length;
			assertTruthy(`both smoke creds in list (found ${smokeCredCount})`, smokeCredCount >= 2);

			// Get single credential
			const getCred = await admin('GET', `/admin/s3/credentials/${S3_FULL_AK}`);
			assertStatus('get S3 credential -> 200', getCred, 200);
			assertJson('get cred returns correct id', getCred.body?.result?.credential?.access_key_id, S3_FULL_AK);

			// Validation
			const noCredName = await admin('POST', '/admin/s3/credentials', { policy: FULL_S3_POLICY });
			assertStatus('S3 cred missing name -> 400', noCredName, 400);

			const noCredPol = await admin('POST', '/admin/s3/credentials', { name: 'x' });
			assertStatus('S3 cred missing policy -> 400', noCredPol, 400);

			// ─── 16. S3 Operations (full-access) ────────────────────────

			section('S3 Operations (full-access)');

			const fullClient = s3client(S3_FULL_AK, S3_FULL_SK);

			// ListBuckets
			const lb = await s3req(fullClient, 'GET', '/');
			if (lb.status === 200 && lb.raw.includes('<Bucket>')) {
				pass++;
				const bucketMatches = lb.raw.match(/<Name>/g);
				console.log(`  ${green('PASS')}  ListBuckets -> success (${bucketMatches?.length ?? 0} buckets)`);
			} else {
				fail++;
				errors.push(`ListBuckets failed: HTTP ${lb.status}`);
				console.log(`  ${red('FAIL')}  ListBuckets (HTTP ${lb.status})`);
			}

			// PutObject
			const smokeKey = `smoke-test-${Date.now()}.txt`;
			const putUrl = `${BASE}/s3/${S3_TEST_BUCKET}/${smokeKey}`;
			const putSigned = await fullClient.sign(putUrl, {
				method: 'PUT',
				headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
				body: 'smoke test content',
			});
			const putRes = await fetch(putSigned);
			if (putRes.ok) {
				pass++;
				console.log(`  ${green('PASS')}  PutObject -> success (key: ${smokeKey})`);
			} else {
				fail++;
				errors.push(`PutObject failed: HTTP ${putRes.status}`);
				console.log(`  ${red('FAIL')}  PutObject (HTTP ${putRes.status})`);
			}

			// HeadObject
			const headUrl = `${BASE}/s3/${S3_TEST_BUCKET}/${smokeKey}`;
			const headSigned = await fullClient.sign(headUrl, {
				method: 'HEAD',
				headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			});
			const headRes = await fetch(headSigned);
			if (headRes.ok) {
				pass++;
				console.log(`  ${green('PASS')}  HeadObject -> success`);
			} else {
				fail++;
				errors.push(`HeadObject failed: HTTP ${headRes.status}`);
				console.log(`  ${red('FAIL')}  HeadObject (HTTP ${headRes.status})`);
			}

			// GetObject
			const getUrl = `${BASE}/s3/${S3_TEST_BUCKET}/${smokeKey}`;
			const getSigned = await fullClient.sign(getUrl, {
				method: 'GET',
				headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			});
			const getRes = await fetch(getSigned);
			const getBody = await getRes.text();
			if (getBody.includes('smoke test content')) {
				pass++;
				console.log(`  ${green('PASS')}  GetObject -> correct content`);
			} else {
				fail++;
				errors.push(`GetObject content mismatch: got '${getBody.slice(0, 100)}'`);
				console.log(`  ${red('FAIL')}  GetObject content mismatch`);
			}

			// ListObjectsV2
			const listUrl = `${BASE}/s3/${S3_TEST_BUCKET}?list-type=2&prefix=smoke-test-&max-keys=10`;
			const listSigned = await fullClient.sign(listUrl, {
				method: 'GET',
				headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			});
			const listRes = await fetch(listSigned);
			const listBody = await listRes.text();
			if (listBody.includes('<Key>')) {
				const objMatches = listBody.match(/<Key>/g);
				pass++;
				console.log(`  ${green('PASS')}  ListObjectsV2 -> ${objMatches?.length ?? 0} objects with prefix`);
			} else {
				fail++;
				errors.push(`ListObjectsV2 failed: HTTP ${listRes.status}`);
				console.log(`  ${red('FAIL')}  ListObjectsV2`);
			}

			// DeleteObject
			const delUrl = `${BASE}/s3/${S3_TEST_BUCKET}/${smokeKey}`;
			const delSigned = await fullClient.sign(delUrl, {
				method: 'DELETE',
				headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			});
			await fetch(delSigned);
			// Verify with HEAD — should be 404
			const verifyHead = await fullClient.sign(headUrl, {
				method: 'HEAD',
				headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			});
			const verifyRes = await fetch(verifyHead);
			if (verifyRes.status === 404) {
				pass++;
				console.log(`  ${green('PASS')}  DeleteObject -> object removed`);
			} else {
				fail++;
				errors.push(`DeleteObject: object still exists (HEAD returned ${verifyRes.status})`);
				console.log(`  ${red('FAIL')}  DeleteObject (object still exists)`);
			}

			// ─── 17. S3 IAM Enforcement (read-only) ─────────────────────

			section('S3 IAM Enforcement (read-only)');

			const roClient = s3client(S3_RO_AK, S3_RO_SK);

			// ListBuckets — should work
			const roLb = await s3req(roClient, 'GET', '/');
			if (roLb.status === 200 && roLb.raw.includes('<Bucket>')) {
				pass++;
				console.log(`  ${green('PASS')}  read-only: ListBuckets -> allowed`);
			} else {
				fail++;
				errors.push(`read-only ListBuckets should succeed: HTTP ${roLb.status}`);
				console.log(`  ${red('FAIL')}  read-only: ListBuckets`);
			}

			// PutObject — should be denied
			const roPutUrl = `${BASE}/s3/${S3_TEST_BUCKET}/smoke-denied.txt`;
			const roPutSigned = await roClient.sign(roPutUrl, {
				method: 'PUT',
				headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-type': 'text/plain' },
				body: 'denied content',
			});
			const roPutRes = await fetch(roPutSigned);
			if (roPutRes.status === 403) {
				pass++;
				console.log(`  ${green('PASS')}  read-only: PutObject -> denied (403)`);
			} else {
				fail++;
				errors.push(`read-only PutObject should be denied: HTTP ${roPutRes.status}`);
				console.log(`  ${red('FAIL')}  read-only: PutObject should be denied (got ${roPutRes.status})`);
			}

			// DeleteObject — should be denied
			const roDelUrl = `${BASE}/s3/${S3_TEST_BUCKET}/nonexistent.txt`;
			const roDelSigned = await roClient.sign(roDelUrl, {
				method: 'DELETE',
				headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			});
			const roDelRes = await fetch(roDelSigned);
			if (roDelRes.status === 403) {
				pass++;
				console.log(`  ${green('PASS')}  read-only: DeleteObject -> denied (403)`);
			} else {
				fail++;
				errors.push(`read-only DeleteObject should be denied: HTTP ${roDelRes.status}`);
				console.log(`  ${red('FAIL')}  read-only: DeleteObject should be denied (got ${roDelRes.status})`);
			}

			// Invalid credential — should fail
			const badClient = s3client('GK_INVALID_KEY', 'invalid_secret');
			const badLb = await s3req(badClient, 'GET', '/');
			if (badLb.status === 403) {
				pass++;
				console.log(`  ${green('PASS')}  invalid credential -> rejected (403)`);
			} else {
				fail++;
				errors.push(`invalid credential should be rejected: HTTP ${badLb.status}`);
				console.log(`  ${red('FAIL')}  invalid credential should be rejected (got ${badLb.status})`);
			}

			// ─── 18. S3 Credential Revocation ───────────────────────────

			section('S3 Credential Revocation');

			const revCred = await admin('POST', '/admin/s3/credentials', { name: 'smoke-s3-revoke', policy: FULL_S3_POLICY });
			assertStatus('create credential for revoke -> 200', revCred, 200);
			const S3_REVOKE_AK = revCred.body?.result?.credential?.access_key_id;
			const S3_REVOKE_SK = revCred.body?.result?.credential?.secret_access_key;
			if (S3_REVOKE_AK) createdS3Creds.push(S3_REVOKE_AK);

			// Verify it works before revocation
			const revClient = s3client(S3_REVOKE_AK, S3_REVOKE_SK);
			const preRevLb = await s3req(revClient, 'GET', '/');
			if (preRevLb.status === 200) {
				pass++;
				console.log(`  ${green('PASS')}  pre-revoke: ListBuckets works`);
			} else {
				fail++;
				errors.push(`pre-revoke ListBuckets should work: HTTP ${preRevLb.status}`);
				console.log(`  ${red('FAIL')}  pre-revoke: ListBuckets`);
			}

			// Revoke
			const revokeCred = await admin('DELETE', `/admin/s3/credentials/${S3_REVOKE_AK}`);
			assertStatus('revoke S3 credential -> 200', revokeCred, 200);

			// Verify denied after revocation
			const postRevLb = await s3req(revClient, 'GET', '/');
			if (postRevLb.status === 403) {
				pass++;
				console.log(`  ${green('PASS')}  post-revoke: ListBuckets -> rejected (403)`);
			} else {
				fail++;
				errors.push(`post-revoke ListBuckets should be rejected: HTTP ${postRevLb.status}`);
				console.log(`  ${red('FAIL')}  post-revoke: ListBuckets should be rejected (got ${postRevLb.status})`);
			}

			// ─── 19. S3 Analytics ───────────────────────────────────────

			section('S3 Analytics');

			await sleep(1000);

			const s3Events = await admin('GET', '/admin/s3/analytics/events');
			assertStatus('S3 events -> 200', s3Events, 200);
			const s3EventCount = s3Events.body?.result?.length ?? 0;
			assertTruthy(`S3 event count > 0 (got ${s3EventCount})`, s3EventCount > 0);

			const s3Summary = await admin('GET', '/admin/s3/analytics/summary');
			assertStatus('S3 summary -> 200', s3Summary, 200);
			assertTruthy('S3 summary has total_requests', s3Summary.body?.result?.total_requests > 0);
		}

		// ─── 20. API Route 404s ─────────────────────────────────────────

		section('API 404s');

		const unknown1 = await req('GET', '/v1/unknown');
		assertStatus('unknown /v1/ route -> 404', unknown1, 404);

		const unknown2 = await req('POST', `/v1/zones/${ZONE}/unknown`);
		assertStatus('unknown zone sub-route -> 404', unknown2, 404);

		const unknown3 = await admin('GET', '/admin/nonexistent');
		assertStatus('unknown /admin/ route -> 404', unknown3, 404);
	} finally {
		// ─── Cleanup ────────────────────────────────────────────────────

		section('Cleanup');

		// Revoke all created keys
		for (const kid of createdKeys) {
			try {
				await admin('DELETE', `/admin/keys/${kid}`);
			} catch {
				/* ignore */
			}
		}
		console.log(`  Revoked ${createdKeys.length} smoke-test keys`);

		// Revoke all created S3 credentials
		for (const cid of createdS3Creds) {
			try {
				await admin('DELETE', `/admin/s3/credentials/${cid}`);
			} catch {
				/* ignore */
			}
		}
		console.log(`  Revoked ${createdS3Creds.length} S3 credentials`);

		// Revoke upstream token
		try {
			await admin('DELETE', `/admin/upstream-tokens/${UPSTREAM_TOKEN_ID}`);
		} catch {
			/* ignore */
		}
		console.log(`  Revoked upstream token ${UPSTREAM_TOKEN_ID}`);

		// Revoke upstream R2 endpoint
		if (s3UpstreamId) {
			try {
				await admin('DELETE', `/admin/upstream-r2/${s3UpstreamId}`);
			} catch {
				/* ignore */
			}
			console.log(`  Revoked upstream R2 ${s3UpstreamId}`);
		}
	}

	// ─── Summary ────────────────────────────────────────────────────────

	console.log('');
	console.log(bold('═══════════════════════════════════════'));
	const total = pass + fail;
	if (fail === 0) {
		console.log(bold(green(`  ALL ${total} TESTS PASSED`)));
	} else {
		console.log(bold(red(`  ${fail}/${total} FAILED`)));
		console.log('');
		for (const err of errors) {
			console.log(`  ${red('•')} ${err}`);
		}
	}
	console.log(bold('═══════════════════════════════════════'));

	process.exit(fail);
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Run ───────────────────────────────────────────────────────────────────

main().catch((e) => {
	console.error('FATAL:', e);
	process.exit(1);
});
