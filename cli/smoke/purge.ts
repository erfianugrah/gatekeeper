/**
 * Smoke tests — sections 7-11d: Purge Auth, Validation, Happy Path, Rate Limits,
 * Scoped Auth, Action Mutations, Deny Statements, Numeric Operators.
 */

import type { SmokeContext } from './helpers.js';
import { req, admin, purge, section, createKey, assertStatus, assertJson, assertMatch, assertTruthy, state } from './helpers.js';

export async function run(ctx: SmokeContext): Promise<void> {
	const { ZONE, PURGE_URL, WILDCARD_ID, HOST_ID, TAG_ID, PREFIX_ID, URL_ID, MULTI_ID, REVOKE_ID } = ctx;

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
	// Key's policy is scoped to the real zone — wrong zone gets 403 from policy engine before reaching upstream
	assertStatus('wrong zone -> 403 (policy denies)', wrongZone, 403);

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
	assertTruthy(
		'empty body message mentions purge type',
		emptyBody.body?.errors?.[0]?.message?.includes('purge type') || emptyBody.body?.errors?.[0]?.message?.includes('must contain'),
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

	// ─── 11b. Purge Action Mutation Coverage ────────────────────────

	section('Purge Action Mutation Coverage');

	const actionTests: { action: string; name: string; okBody: object; failBody: object; failLabel: string }[] = [
		{
			action: 'purge:host',
			name: 'smoke-action-host',
			okBody: { hosts: ['erfi.io'] },
			failBody: { tags: ['t1'] },
			failLabel: 'tag purge',
		},
		{
			action: 'purge:tag',
			name: 'smoke-action-tag',
			okBody: { tags: ['static-v1'] },
			failBody: { hosts: ['erfi.io'] },
			failLabel: 'host purge',
		},
		{
			action: 'purge:prefix',
			name: 'smoke-action-prefix',
			okBody: { prefixes: ['erfi.io/css/'] },
			failBody: { purge_everything: true },
			failLabel: 'purge_everything',
		},
		{
			action: 'purge:url',
			name: 'smoke-action-url',
			okBody: { files: ['https://erfi.io/test.txt'] },
			failBody: { hosts: ['erfi.io'] },
			failLabel: 'host purge',
		},
		{
			action: 'purge:everything',
			name: 'smoke-action-everything',
			okBody: { purge_everything: true },
			failBody: { tags: ['t1'] },
			failLabel: 'tag purge',
		},
	];

	for (const at of actionTests) {
		const policy = {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: [at.action], resources: [`zone:${ZONE}`] }],
		};
		const { r: cr, keyId } = await createKey(at.name, ZONE, policy);
		assertStatus(`${at.action} key created -> 200`, cr, 200);

		const ok = await purge(keyId, PURGE_URL, at.okBody);
		assertStatus(`${at.action} key: allowed action -> 200`, ok, 200);

		const denied = await purge(keyId, PURGE_URL, at.failBody);
		assertStatus(`${at.action} key: ${at.failLabel} (wrong action) -> 403`, denied, 403);
	}

	// ─── 11c. Deny Statement Authorization ──────────────────────────

	section('Deny Statement Authorization');

	// Deny overrides allow: allow purge:* + deny purge:everything
	const denyPePolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['purge:*'], resources: [`zone:${ZONE}`] },
			{ effect: 'deny', actions: ['purge:everything'], resources: [`zone:${ZONE}`] },
		],
	};
	const { r: dpe, keyId: DENY_PE_ID } = await createKey('smoke-deny-purge-everything', ZONE, denyPePolicy);
	assertStatus('create deny-purge_everything key -> 200', dpe, 200);

	const dpHost = await purge(DENY_PE_ID, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('deny-PE key: host purge -> 200 (allowed)', dpHost, 200);

	const dpTag = await purge(DENY_PE_ID, PURGE_URL, { tags: ['v1'] });
	assertStatus('deny-PE key: tag purge -> 200 (allowed)', dpTag, 200);

	const dpPrefix = await purge(DENY_PE_ID, PURGE_URL, { prefixes: ['erfi.io/assets/'] });
	assertStatus('deny-PE key: prefix purge -> 200 (allowed)', dpPrefix, 200);

	const dpUrl = await purge(DENY_PE_ID, PURGE_URL, { files: ['https://erfi.io/foo.txt'] });
	assertStatus('deny-PE key: URL purge -> 200 (allowed)', dpUrl, 200);

	const dpPe = await purge(DENY_PE_ID, PURGE_URL, { purge_everything: true });
	assertStatus('deny-PE key: purge_everything -> 403 (denied)', dpPe, 403);

	// Conditional deny: allow purge:* + deny purge:host where host=internal.example.com
	const denyCondPolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['purge:*'], resources: [`zone:${ZONE}`] },
			{
				effect: 'deny',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'eq', value: 'internal.example.com' }],
			},
		],
	};
	const { r: dcr, keyId: DENY_COND_ID } = await createKey('smoke-deny-conditional', ZONE, denyCondPolicy);
	assertStatus('create conditional deny key -> 200', dcr, 200);

	const dcOk = await purge(DENY_COND_ID, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('cond-deny key: host=erfi.io -> 200 (allowed)', dcOk, 200);

	const dcDenied = await purge(DENY_COND_ID, PURGE_URL, { hosts: ['internal.example.com'] });
	assertStatus('cond-deny key: host=internal.example.com -> 403 (denied)', dcDenied, 403);

	const dcTag = await purge(DENY_COND_ID, PURGE_URL, { tags: ['ok'] });
	assertStatus('cond-deny key: tag purge -> 200 (unrelated action)', dcTag, 200);

	// Deny with numeric condition: always-deny purge:everything (time.hour >= 0 matches always)
	const denyNumPolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['purge:*'], resources: [`zone:${ZONE}`] },
			{
				effect: 'deny',
				actions: ['purge:everything'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'time.hour', operator: 'gte', value: '0' }],
			},
		],
	};
	const { r: dnr, keyId: DENY_NUM_ID } = await createKey('smoke-deny-numeric', ZONE, denyNumPolicy);
	assertStatus('create numeric deny key -> 200', dnr, 200);

	const dnHost = await purge(DENY_NUM_ID, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('num-deny key: host purge -> 200 (allowed)', dnHost, 200);

	const dnPe = await purge(DENY_NUM_ID, PURGE_URL, { purge_everything: true });
	assertStatus('num-deny key: purge_everything -> 403 (always-denied via gte 0)', dnPe, 403);

	// Deny-only policy: deny without any allow → everything implicitly denied
	const denyOnlyPolicy = {
		version: '2025-01-01',
		statements: [{ effect: 'deny', actions: ['purge:*'], resources: [`zone:${ZONE}`] }],
	};
	const { r: dor, keyId: DENY_ONLY_ID } = await createKey('smoke-deny-only', ZONE, denyOnlyPolicy);
	assertStatus('create deny-only key -> 200', dor, 200);

	const doHost = await purge(DENY_ONLY_ID, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('deny-only key: host purge -> 403 (no allow)', doHost, 403);

	const doTag = await purge(DENY_ONLY_ID, PURGE_URL, { tags: ['v1'] });
	assertStatus('deny-only key: tag purge -> 403 (no allow)', doTag, 403);

	// Multi-action deny: allow purge:host,purge:tag + deny purge:tag
	const denyMultiPolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['purge:host', 'purge:tag'], resources: [`zone:${ZONE}`] },
			{ effect: 'deny', actions: ['purge:tag'], resources: [`zone:${ZONE}`] },
		],
	};
	const { r: dmr, keyId: DENY_MULTI_ID } = await createKey('smoke-deny-multi', ZONE, denyMultiPolicy);
	assertStatus('create deny-multi key -> 200', dmr, 200);

	const dmHost = await purge(DENY_MULTI_ID, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('deny-multi key: host purge -> 200 (allowed)', dmHost, 200);

	const dmTag = await purge(DENY_MULTI_ID, PURGE_URL, { tags: ['v1'] });
	assertStatus('deny-multi key: tag purge -> 403 (denied)', dmTag, 403);

	// ─── 11d. Numeric Operator Validation ───────────────────────────

	section('Numeric Operator Validation');

	// Valid numeric condition
	const numValidPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:*'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'time.hour', operator: 'lt', value: '18' }],
			},
		],
	};
	const numValid = await admin('POST', '/admin/keys', {
		name: 'smoke-num-valid',
		zone_id: ZONE,
		policy: numValidPolicy,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
	});
	assertStatus('numeric lt with valid value -> 200', numValid, 200);
	const numValidId = numValid.body?.result?.key?.id;
	if (numValidId) state.createdKeys.push(numValidId);

	// Invalid: non-numeric value for numeric operator
	const numInvalidPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:*'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'time.hour', operator: 'gt', value: 'midnight' }],
			},
		],
	};
	const numInvalid = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ZONE,
		policy: numInvalidPolicy,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
	});
	assertStatus('numeric gt with non-numeric value -> 400', numInvalid, 400);

	// All four numeric operators with valid values
	for (const op of ['lt', 'gt', 'lte', 'gte']) {
		const opPolicy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['purge:*'],
					resources: [`zone:${ZONE}`],
					conditions: [{ field: 'time.hour', operator: op, value: '12' }],
				},
			],
		};
		const opRes = await admin('POST', '/admin/keys', {
			name: `smoke-num-${op}`,
			zone_id: ZONE,
			policy: opPolicy,
			upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
		});
		assertStatus(`numeric ${op} with valid value -> 200`, opRes, 200);
		const opId = opRes.body?.result?.key?.id;
		if (opId) state.createdKeys.push(opId);
	}
}
