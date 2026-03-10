/**
 * Smoke tests — sections 7-11d: Purge Auth, Validation, Happy Path, Rate Limits,
 * Scoped Auth, Action Mutations, Deny Statements, Numeric Operators,
 * Compound Conditions, Condition Operators, Expired Key, Security Headers.
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

	// ─── 12. Compound Conditions at Runtime ─────────────────────────

	section('Compound Conditions');

	// 2a. `not` — negation: allow host purge for any host EXCEPT internal.corp
	const notPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ not: { field: 'host', operator: 'eq', value: 'internal.corp' } }],
			},
		],
	};
	const { r: notCr, keyId: NOT_KEY } = await createKey('smoke-not-condition', ZONE, notPolicy);
	assertStatus('not-condition key created -> 200', notCr, 200);

	const notOk = await purge(NOT_KEY, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('not key: allowed host -> 200', notOk, 200);

	const notDenied = await purge(NOT_KEY, PURGE_URL, { hosts: ['internal.corp'] });
	assertStatus('not key: excluded host -> 403', notDenied, 403);

	// 2b. `any` — OR logic: allow host purge only for a.com OR b.com
	const anyPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [
					{
						any: [
							{ field: 'host', operator: 'eq', value: 'a.com' },
							{ field: 'host', operator: 'eq', value: 'b.com' },
						],
					},
				],
			},
		],
	};
	const { r: anyCr, keyId: ANY_KEY } = await createKey('smoke-any-condition', ZONE, anyPolicy);
	assertStatus('any-condition key created -> 200', anyCr, 200);

	const anyA = await purge(ANY_KEY, PURGE_URL, { hosts: ['a.com'] });
	assertStatus('any key: a.com -> 200', anyA, 200);

	const anyB = await purge(ANY_KEY, PURGE_URL, { hosts: ['b.com'] });
	assertStatus('any key: b.com -> 200', anyB, 200);

	const anyC = await purge(ANY_KEY, PURGE_URL, { hosts: ['c.com'] });
	assertStatus('any key: c.com -> 403', anyC, 403);

	// 2c. `all` — AND logic: allow host purge only when starts with "cdn" AND ends with ".com"
	const allPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [
					{
						all: [
							{ field: 'host', operator: 'starts_with', value: 'cdn' },
							{ field: 'host', operator: 'ends_with', value: '.com' },
						],
					},
				],
			},
		],
	};
	const { r: allCr, keyId: ALL_KEY } = await createKey('smoke-all-condition', ZONE, allPolicy);
	assertStatus('all-condition key created -> 200', allCr, 200);

	const allOk = await purge(ALL_KEY, PURGE_URL, { hosts: ['cdn.example.com'] });
	assertStatus('all key: cdn.example.com -> 200', allOk, 200);

	const allBadSuffix = await purge(ALL_KEY, PURGE_URL, { hosts: ['cdn.example.org'] });
	assertStatus('all key: cdn.example.org -> 403 (fails ends_with .com)', allBadSuffix, 403);

	const allBadPrefix = await purge(ALL_KEY, PURGE_URL, { hosts: ['api.example.com'] });
	assertStatus('all key: api.example.com -> 403 (fails starts_with cdn)', allBadPrefix, 403);

	// 2d. Nested: not inside any — allow if host eq "safe.com" OR host does NOT start with "internal"
	const nestedPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [
					{
						any: [
							{ field: 'host', operator: 'eq', value: 'safe.com' },
							{ not: { field: 'host', operator: 'starts_with', value: 'internal' } },
						],
					},
				],
			},
		],
	};
	const { r: nestedCr, keyId: NESTED_KEY } = await createKey('smoke-nested-compound', ZONE, nestedPolicy);
	assertStatus('nested-compound key created -> 200', nestedCr, 200);

	const nestedSafe = await purge(NESTED_KEY, PURGE_URL, { hosts: ['safe.com'] });
	assertStatus('nested key: safe.com -> 200 (first any branch)', nestedSafe, 200);

	const nestedPublic = await purge(NESTED_KEY, PURGE_URL, { hosts: ['public.com'] });
	assertStatus('nested key: public.com -> 200 (second any branch: not starts_with internal)', nestedPublic, 200);

	const nestedInternal = await purge(NESTED_KEY, PURGE_URL, { hosts: ['internal.corp'] });
	assertStatus('nested key: internal.corp -> 403 (both branches fail)', nestedInternal, 403);

	// 2e. Nested: all inside not in deny — deny host purge UNLESS host is cdn*.com
	const denyNestedPolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['purge:*'], resources: [`zone:${ZONE}`] },
			{
				effect: 'deny',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [
					{
						not: {
							all: [
								{ field: 'host', operator: 'starts_with', value: 'cdn' },
								{ field: 'host', operator: 'ends_with', value: '.com' },
							],
						},
					},
				],
			},
		],
	};
	const { r: dnCr, keyId: DENY_NESTED_KEY } = await createKey('smoke-deny-nested', ZONE, denyNestedPolicy);
	assertStatus('deny-nested key created -> 200', dnCr, 200);

	const dnCdnCom = await purge(DENY_NESTED_KEY, PURGE_URL, { hosts: ['cdn.example.com'] });
	assertStatus('deny-nested: cdn.example.com -> 200 (deny not(all(true,true))=false)', dnCdnCom, 200);

	const dnApiCom = await purge(DENY_NESTED_KEY, PURGE_URL, { hosts: ['api.example.com'] });
	assertStatus('deny-nested: api.example.com -> 403 (deny not(all(false,true))=true)', dnApiCom, 403);

	const dnTagOk = await purge(DENY_NESTED_KEY, PURGE_URL, { tags: ['v1'] });
	assertStatus('deny-nested: tag purge -> 200 (deny only on purge:host)', dnTagOk, 200);

	// 2f. Multi-statement: two allow statements with different host scopes
	const multiStmtPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'eq', value: 'cdn.erfi.io' }],
			},
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'eq', value: 'api.erfi.io' }],
			},
		],
	};
	const { r: msCr, keyId: MS_KEY } = await createKey('smoke-multi-statement', ZONE, multiStmtPolicy);
	assertStatus('multi-statement key created -> 200', msCr, 200);

	const msCdn = await purge(MS_KEY, PURGE_URL, { hosts: ['cdn.erfi.io'] });
	assertStatus('multi-stmt: cdn.erfi.io -> 200 (first stmt)', msCdn, 200);

	const msApi = await purge(MS_KEY, PURGE_URL, { hosts: ['api.erfi.io'] });
	assertStatus('multi-stmt: api.erfi.io -> 200 (second stmt)', msApi, 200);

	const msEvil = await purge(MS_KEY, PURGE_URL, { hosts: ['evil.com'] });
	assertStatus('multi-stmt: evil.com -> 403 (neither stmt)', msEvil, 403);

	// 2g. Allow + narrow conditional deny on the same action
	const allowDenyPolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['purge:host'], resources: [`zone:${ZONE}`] },
			{
				effect: 'deny',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'eq', value: 'protected.erfi.io' }],
			},
		],
	};
	const { r: adCr, keyId: AD_KEY } = await createKey('smoke-allow-deny-host', ZONE, allowDenyPolicy);
	assertStatus('allow-deny-host key created -> 200', adCr, 200);

	const adOk = await purge(AD_KEY, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('allow-deny: erfi.io -> 200', adOk, 200);

	const adProtected = await purge(AD_KEY, PURGE_URL, { hosts: ['protected.erfi.io'] });
	assertStatus('allow-deny: protected.erfi.io -> 403 (deny fires)', adProtected, 403);

	const adOther = await purge(AD_KEY, PURGE_URL, { hosts: ['other.erfi.io'] });
	assertStatus('allow-deny: other.erfi.io -> 200', adOther, 200);

	// ─── 13. Condition Operator Coverage ────────────────────────────

	section('Condition Operator Coverage');

	// 3a. `in` operator
	const inPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'in', value: ['a.com', 'b.com', 'c.com'] }],
			},
		],
	};
	const { r: inCr, keyId: IN_KEY } = await createKey('smoke-op-in', ZONE, inPolicy);
	assertStatus('in-operator key created -> 200', inCr, 200);

	const inOk = await purge(IN_KEY, PURGE_URL, { hosts: ['a.com'] });
	assertStatus('in key: a.com -> 200', inOk, 200);

	const inBad = await purge(IN_KEY, PURGE_URL, { hosts: ['d.com'] });
	assertStatus('in key: d.com -> 403', inBad, 403);

	// 3b. `not_in` operator
	const notInPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'not_in', value: ['blocked.com', 'banned.com'] }],
			},
		],
	};
	const { r: niCr, keyId: NI_KEY } = await createKey('smoke-op-not-in', ZONE, notInPolicy);
	assertStatus('not_in-operator key created -> 200', niCr, 200);

	const niOk = await purge(NI_KEY, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('not_in key: erfi.io -> 200', niOk, 200);

	const niBad = await purge(NI_KEY, PURGE_URL, { hosts: ['blocked.com'] });
	assertStatus('not_in key: blocked.com -> 403', niBad, 403);

	// 3c. `ne` operator in deny: allow purge:*, deny purge:host where host != safe.com
	const nePolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['purge:*'], resources: [`zone:${ZONE}`] },
			{
				effect: 'deny',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'ne', value: 'safe.com' }],
			},
		],
	};
	const { r: neCr, keyId: NE_KEY } = await createKey('smoke-op-ne', ZONE, nePolicy);
	assertStatus('ne-operator key created -> 200', neCr, 200);

	const neOk = await purge(NE_KEY, PURGE_URL, { hosts: ['safe.com'] });
	assertStatus('ne key: safe.com -> 200 (deny ne safe.com = false)', neOk, 200);

	const neBad = await purge(NE_KEY, PURGE_URL, { hosts: ['evil.com'] });
	assertStatus('ne key: evil.com -> 403 (deny ne safe.com = true)', neBad, 403);

	const neTag = await purge(NE_KEY, PURGE_URL, { tags: ['v1'] });
	assertStatus('ne key: tag purge -> 200 (deny only on purge:host)', neTag, 200);

	// 3d. `contains` operator
	const containsPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'contains', value: 'cdn' }],
			},
		],
	};
	const { r: coCr, keyId: CO_KEY } = await createKey('smoke-op-contains', ZONE, containsPolicy);
	assertStatus('contains-operator key created -> 200', coCr, 200);

	const coOk = await purge(CO_KEY, PURGE_URL, { hosts: ['cdn.example.com'] });
	assertStatus('contains key: cdn.example.com -> 200', coOk, 200);

	const coBad = await purge(CO_KEY, PURGE_URL, { hosts: ['api.example.com'] });
	assertStatus('contains key: api.example.com -> 403', coBad, 403);

	// 3e. `not_contains` operator
	const notContainsPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'not_contains', value: 'internal' }],
			},
		],
	};
	const { r: ncCr, keyId: NC_KEY } = await createKey('smoke-op-not-contains', ZONE, notContainsPolicy);
	assertStatus('not_contains-operator key created -> 200', ncCr, 200);

	const ncOk = await purge(NC_KEY, PURGE_URL, { hosts: ['public.example.com'] });
	assertStatus('not_contains key: public.example.com -> 200', ncOk, 200);

	const ncBad = await purge(NC_KEY, PURGE_URL, { hosts: ['internal.example.com'] });
	assertStatus('not_contains key: internal.example.com -> 403', ncBad, 403);

	// 3f. `ends_with` operator
	const endsWithPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'ends_with', value: '.erfi.io' }],
			},
		],
	};
	const { r: ewCr, keyId: EW_KEY } = await createKey('smoke-op-ends-with', ZONE, endsWithPolicy);
	assertStatus('ends_with-operator key created -> 200', ewCr, 200);

	const ewOk = await purge(EW_KEY, PURGE_URL, { hosts: ['cdn.erfi.io'] });
	assertStatus('ends_with key: cdn.erfi.io -> 200', ewOk, 200);

	const ewBad = await purge(EW_KEY, PURGE_URL, { hosts: ['cdn.evil.com'] });
	assertStatus('ends_with key: cdn.evil.com -> 403', ewBad, 403);

	// 3g. `matches` operator (regex)
	const matchesPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'matches', value: '^cdn-\\d+\\.example\\.com$' }],
			},
		],
	};
	const { r: maCr, keyId: MA_KEY } = await createKey('smoke-op-matches', ZONE, matchesPolicy);
	assertStatus('matches-operator key created -> 200', maCr, 200);

	const maOk = await purge(MA_KEY, PURGE_URL, { hosts: ['cdn-01.example.com'] });
	assertStatus('matches key: cdn-01.example.com -> 200', maOk, 200);

	const maBadLetters = await purge(MA_KEY, PURGE_URL, { hosts: ['cdn-ab.example.com'] });
	assertStatus('matches key: cdn-ab.example.com -> 403 (\\d+ fails)', maBadLetters, 403);

	const maBadPrefix = await purge(MA_KEY, PURGE_URL, { hosts: ['evil.example.com'] });
	assertStatus('matches key: evil.example.com -> 403 (no cdn- prefix)', maBadPrefix, 403);

	// 3h. `not_matches` operator (negated regex)
	const notMatchesPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'not_matches', value: '^internal-.*\\.corp$' }],
			},
		],
	};
	const { r: nmCr, keyId: NM_KEY } = await createKey('smoke-op-not-matches', ZONE, notMatchesPolicy);
	assertStatus('not_matches-operator key created -> 200', nmCr, 200);

	const nmOk = await purge(NM_KEY, PURGE_URL, { hosts: ['public.example.com'] });
	assertStatus('not_matches key: public.example.com -> 200', nmOk, 200);

	const nmBad = await purge(NM_KEY, PURGE_URL, { hosts: ['internal-db.corp'] });
	assertStatus('not_matches key: internal-db.corp -> 403', nmBad, 403);

	// 3i. `exists` — deny purge:tag when tag field exists (it does for tag purge, not for host purge)
	const existsPolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['purge:host', 'purge:tag'], resources: [`zone:${ZONE}`] },
			{
				effect: 'deny',
				actions: ['purge:tag'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'tag', operator: 'exists' }],
			},
		],
	};
	const { r: exCr, keyId: EX_KEY } = await createKey('smoke-op-exists', ZONE, existsPolicy);
	assertStatus('exists-operator key created -> 200', exCr, 200);

	const exHostOk = await purge(EX_KEY, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('exists key: host purge -> 200 (deny on purge:tag only)', exHostOk, 200);

	const exTagBad = await purge(EX_KEY, PURGE_URL, { tags: ['static-v1'] });
	assertStatus('exists key: tag purge -> 403 (tag field exists, deny fires)', exTagBad, 403);

	// 3i cont. `not_exists` — allow only when tag field does NOT exist
	const notExistsPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host', 'purge:tag'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'tag', operator: 'not_exists' }],
			},
		],
	};
	const { r: nxCr, keyId: NX_KEY } = await createKey('smoke-op-not-exists', ZONE, notExistsPolicy);
	assertStatus('not_exists-operator key created -> 200', nxCr, 200);

	const nxHostOk = await purge(NX_KEY, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('not_exists key: host purge -> 200 (tag field absent)', nxHostOk, 200);

	const nxTagBad = await purge(NX_KEY, PURGE_URL, { tags: ['v1'] });
	assertStatus('not_exists key: tag purge -> 403 (tag field present)', nxTagBad, 403);

	// ─── 14. Expired Key at Runtime ─────────────────────────────────

	section('Expired Key at Runtime');

	// Create a key, verify it works, PATCH expires_at to past, verify 403
	const { r: expCr, keyId: EXP_KEY } = await createKey('smoke-expired-key', ZONE, {
		version: '2025-01-01',
		statements: [{ effect: 'allow', actions: ['purge:*'], resources: [`zone:${ZONE}`] }],
	});
	assertStatus('expired-key created -> 200', expCr, 200);

	const expPrePurge = await purge(EXP_KEY, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('pre-expire: purge -> 200', expPrePurge, 200);

	const pastTs = Date.now() - 60_000; // 1 minute ago
	const expPatch = await admin('PATCH', `/admin/keys/${EXP_KEY}`, { expires_at: pastTs });
	assertStatus('PATCH expires_at to past -> 200', expPatch, 200);

	const expPostPurge = await purge(EXP_KEY, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('post-expire: purge -> 403', expPostPurge, 403);
	assertMatch('expired key error message', expPostPurge.body?.errors?.[0]?.message ?? '', /expired/i);

	// ─── 15. Numeric Conditions that Actually Restrict ──────────────

	section('Numeric Runtime Enforcement');

	// 6a. Always-false: time.hour < 0 (no UTC hour is negative)
	const { r: numDenyCr, keyId: NUM_DENY_KEY } = await createKey('smoke-num-always-deny', ZONE, {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:*'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'time.hour', operator: 'lt', value: '0' }],
			},
		],
	});
	assertStatus('always-deny numeric key created -> 200', numDenyCr, 200);

	const numDenyPurge = await purge(NUM_DENY_KEY, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('always-deny numeric: purge -> 403', numDenyPurge, 403);

	// 6b. Always-true: time.hour >= 0 (control)
	const { r: numAllowCr, keyId: NUM_ALLOW_KEY } = await createKey('smoke-num-always-allow', ZONE, {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:*'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'time.hour', operator: 'gte', value: '0' }],
			},
		],
	});
	assertStatus('always-allow numeric key created -> 200', numAllowCr, 200);

	const numAllowPurge = await purge(NUM_ALLOW_KEY, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('always-allow numeric: purge -> 200', numAllowPurge, 200);

	// 6c. Numeric deny with gt: allow purge:*, deny purge:everything where time.hour > -1 (always true)
	const { r: numDenyGtCr, keyId: NUM_DENY_GT_KEY } = await createKey('smoke-num-deny-gt', ZONE, {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['purge:*'], resources: [`zone:${ZONE}`] },
			{
				effect: 'deny',
				actions: ['purge:everything'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'time.hour', operator: 'gt', value: '-1' }],
			},
		],
	});
	assertStatus('numeric-deny-gt key created -> 200', numDenyGtCr, 200);

	const numGtHost = await purge(NUM_DENY_GT_KEY, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('num-deny-gt: host purge -> 200 (deny only on purge:everything)', numGtHost, 200);

	const numGtPe = await purge(NUM_DENY_GT_KEY, PURGE_URL, { purge_everything: true });
	assertStatus('num-deny-gt: purge_everything -> 403 (always-true deny)', numGtPe, 403);

	// ─── 17. Granular Tag Scoping ──────────────────────────────────

	section('Granular Tag Scoping');

	// Tag wildcard: allow tags matching static-*
	const tagWildcardPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:tag'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'tag', operator: 'wildcard', value: 'static-*' }],
			},
		],
	};
	const { r: twCr, keyId: TW_KEY } = await createKey('smoke-tag-wildcard', ZONE, tagWildcardPolicy);
	assertStatus('tag-wildcard key created -> 200', twCr, 200);

	const twOk1 = await purge(TW_KEY, PURGE_URL, { tags: ['static-v1'] });
	assertStatus('tag-wildcard: static-v1 -> 200', twOk1, 200);

	const twOk2 = await purge(TW_KEY, PURGE_URL, { tags: ['static-assets'] });
	assertStatus('tag-wildcard: static-assets -> 200', twOk2, 200);

	const twBad = await purge(TW_KEY, PURGE_URL, { tags: ['dynamic-v1'] });
	assertStatus('tag-wildcard: dynamic-v1 -> 403', twBad, 403);

	const twBadHost = await purge(TW_KEY, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('tag-wildcard: host purge (wrong action) -> 403', twBadHost, 403);

	// Tag starts_with: allow tags starting with "release-"
	const tagStartsPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:tag'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'tag', operator: 'starts_with', value: 'release-' }],
			},
		],
	};
	const { r: tswCr, keyId: TSW_KEY } = await createKey('smoke-tag-starts-with', ZONE, tagStartsPolicy);
	assertStatus('tag-starts_with key created -> 200', tswCr, 200);

	const tswOk = await purge(TSW_KEY, PURGE_URL, { tags: ['release-2026.03'] });
	assertStatus('tag-starts_with: release-2026.03 -> 200', tswOk, 200);

	const tswBad = await purge(TSW_KEY, PURGE_URL, { tags: ['hotfix-123'] });
	assertStatus('tag-starts_with: hotfix-123 -> 403', tswBad, 403);

	// Tag in-set: allow only specific tag values
	const tagInSetPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:tag'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'tag', operator: 'in', value: ['css-bundle', 'js-bundle', 'font-cache'] }],
			},
		],
	};
	const { r: tisCr, keyId: TIS_KEY } = await createKey('smoke-tag-in-set', ZONE, tagInSetPolicy);
	assertStatus('tag-in-set key created -> 200', tisCr, 200);

	const tisOk1 = await purge(TIS_KEY, PURGE_URL, { tags: ['css-bundle'] });
	assertStatus('tag-in-set: css-bundle -> 200', tisOk1, 200);

	const tisOk2 = await purge(TIS_KEY, PURGE_URL, { tags: ['font-cache'] });
	assertStatus('tag-in-set: font-cache -> 200', tisOk2, 200);

	const tisBad = await purge(TIS_KEY, PURGE_URL, { tags: ['img-cache'] });
	assertStatus('tag-in-set: img-cache -> 403', tisBad, 403);

	// Multi-tag partial deny: allow purge:tag + deny where tag contains "internal"
	const tagDenyContainsPolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['purge:tag'], resources: [`zone:${ZONE}`] },
			{
				effect: 'deny',
				actions: ['purge:tag'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'tag', operator: 'contains', value: 'internal' }],
			},
		],
	};
	const { r: tdcCr, keyId: TDC_KEY } = await createKey('smoke-tag-deny-contains', ZONE, tagDenyContainsPolicy);
	assertStatus('tag-deny-contains key created -> 200', tdcCr, 200);

	const tdcOk = await purge(TDC_KEY, PURGE_URL, { tags: ['public-assets'] });
	assertStatus('tag-deny-contains: public-assets -> 200', tdcOk, 200);

	const tdcBad = await purge(TDC_KEY, PURGE_URL, { tags: ['internal-cache'] });
	assertStatus('tag-deny-contains: internal-cache -> 403', tdcBad, 403);

	// Multi-tag body: one allowed, one denied -> 403 (ALL contexts must pass)
	const tdcPartial = await purge(TDC_KEY, PURGE_URL, { tags: ['public-assets', 'internal-config'] });
	assertStatus('tag-deny-contains: mixed tags -> 403 (partial deny)', tdcPartial, 403);

	// ─── 18. Granular Host Scoping ─────────────────────────────────

	section('Granular Host Scoping');

	// Host wildcard: allow *.erfi.io
	const hostWildcardPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'wildcard', value: '*.erfi.io' }],
			},
		],
	};
	const { r: hwCr, keyId: HW_KEY } = await createKey('smoke-host-wildcard', ZONE, hostWildcardPolicy);
	assertStatus('host-wildcard key created -> 200', hwCr, 200);

	const hwOk1 = await purge(HW_KEY, PURGE_URL, { hosts: ['cdn.erfi.io'] });
	assertStatus('host-wildcard: cdn.erfi.io -> 200', hwOk1, 200);

	const hwOk2 = await purge(HW_KEY, PURGE_URL, { hosts: ['api.erfi.io'] });
	assertStatus('host-wildcard: api.erfi.io -> 200', hwOk2, 200);

	const hwBad = await purge(HW_KEY, PURGE_URL, { hosts: ['cdn.evil.com'] });
	assertStatus('host-wildcard: cdn.evil.com -> 403', hwBad, 403);

	// Multi-host with specific allow + specific deny
	const hostMultiDenyPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'wildcard', value: '*.erfi.io' }],
			},
			{
				effect: 'deny',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'eq', value: 'admin.erfi.io' }],
			},
		],
	};
	const { r: hmdCr, keyId: HMD_KEY } = await createKey('smoke-host-multi-deny', ZONE, hostMultiDenyPolicy);
	assertStatus('host-multi-deny key created -> 200', hmdCr, 200);

	const hmdOk = await purge(HMD_KEY, PURGE_URL, { hosts: ['cdn.erfi.io'] });
	assertStatus('host-multi-deny: cdn.erfi.io -> 200', hmdOk, 200);

	const hmdDenied = await purge(HMD_KEY, PURGE_URL, { hosts: ['admin.erfi.io'] });
	assertStatus('host-multi-deny: admin.erfi.io -> 403 (deny)', hmdDenied, 403);

	// Multi-host body: one allowed, one denied
	const hmdPartial = await purge(HMD_KEY, PURGE_URL, { hosts: ['cdn.erfi.io', 'admin.erfi.io'] });
	assertStatus('host-multi-deny: mixed hosts -> 403', hmdPartial, 403);

	// Host regex: allow only cdn-NN.erfi.io pattern
	const hostRegexPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'matches', value: '^cdn-\\d{2}\\.erfi\\.io$' }],
			},
		],
	};
	const { r: hrCr, keyId: HR_KEY } = await createKey('smoke-host-regex', ZONE, hostRegexPolicy);
	assertStatus('host-regex key created -> 200', hrCr, 200);

	const hrOk = await purge(HR_KEY, PURGE_URL, { hosts: ['cdn-01.erfi.io'] });
	assertStatus('host-regex: cdn-01.erfi.io -> 200', hrOk, 200);

	const hrBad1 = await purge(HR_KEY, PURGE_URL, { hosts: ['cdn-abc.erfi.io'] });
	assertStatus('host-regex: cdn-abc.erfi.io -> 403', hrBad1, 403);

	const hrBad2 = await purge(HR_KEY, PURGE_URL, { hosts: ['cdn-1.erfi.io'] });
	assertStatus('host-regex: cdn-1.erfi.io -> 403 (need 2 digits)', hrBad2, 403);

	// ─── 19. URL Path & Query Conditions ───────────────────────────

	section('URL Path & Query Conditions');

	// url.path condition: allow file purge only for /assets/* paths
	const urlPathPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:url'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'url.path', operator: 'starts_with', value: '/assets/' }],
			},
		],
	};
	const { r: upCr, keyId: UP_KEY } = await createKey('smoke-url-path', ZONE, urlPathPolicy);
	assertStatus('url-path key created -> 200', upCr, 200);

	const upOk = await purge(UP_KEY, PURGE_URL, { files: ['https://erfi.io/assets/style.css'] });
	assertStatus('url-path: /assets/style.css -> 200', upOk, 200);

	const upOk2 = await purge(UP_KEY, PURGE_URL, { files: ['https://erfi.io/assets/js/app.js'] });
	assertStatus('url-path: /assets/js/app.js -> 200 (nested)', upOk2, 200);

	const upBad = await purge(UP_KEY, PURGE_URL, { files: ['https://erfi.io/api/v1/data'] });
	assertStatus('url-path: /api/v1/data -> 403', upBad, 403);

	const upBadRoot = await purge(UP_KEY, PURGE_URL, { files: ['https://erfi.io/'] });
	assertStatus('url-path: / (root) -> 403', upBadRoot, 403);

	// url.path with wildcard: allow paths matching /images/*.jpg
	const urlPathWildcardPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:url'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'url.path', operator: 'wildcard', value: '/images/*.jpg' }],
			},
		],
	};
	const { r: upwCr, keyId: UPW_KEY } = await createKey('smoke-url-path-wildcard', ZONE, urlPathWildcardPolicy);
	assertStatus('url-path-wildcard key created -> 200', upwCr, 200);

	const upwOk = await purge(UPW_KEY, PURGE_URL, { files: ['https://erfi.io/images/photo.jpg'] });
	assertStatus('url-path-wildcard: /images/photo.jpg -> 200', upwOk, 200);

	const upwBadExt = await purge(UPW_KEY, PURGE_URL, { files: ['https://erfi.io/images/photo.png'] });
	assertStatus('url-path-wildcard: /images/photo.png -> 403 (wrong ext)', upwBadExt, 403);

	const upwBadDir = await purge(UPW_KEY, PURGE_URL, { files: ['https://erfi.io/docs/photo.jpg'] });
	assertStatus('url-path-wildcard: /docs/photo.jpg -> 403 (wrong dir)', upwBadDir, 403);

	// url.path deny: allow purge:url broadly, deny /admin/* paths
	const urlPathDenyPolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['purge:url'], resources: [`zone:${ZONE}`] },
			{
				effect: 'deny',
				actions: ['purge:url'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'url.path', operator: 'starts_with', value: '/admin/' }],
			},
		],
	};
	const { r: updCr, keyId: UPD_KEY } = await createKey('smoke-url-path-deny', ZONE, urlPathDenyPolicy);
	assertStatus('url-path-deny key created -> 200', updCr, 200);

	const updOk = await purge(UPD_KEY, PURGE_URL, { files: ['https://erfi.io/public/page.html'] });
	assertStatus('url-path-deny: /public/page.html -> 200', updOk, 200);

	const updBad = await purge(UPD_KEY, PURGE_URL, { files: ['https://erfi.io/admin/dashboard'] });
	assertStatus('url-path-deny: /admin/dashboard -> 403', updBad, 403);

	// Multi-file: one allowed path, one denied path
	const updPartial = await purge(UPD_KEY, PURGE_URL, {
		files: ['https://erfi.io/public/ok.html', 'https://erfi.io/admin/secret.html'],
	});
	assertStatus('url-path-deny: mixed paths -> 403', updPartial, 403);

	// url.query.<key> condition: allow only when ?v= query param exists
	const urlQueryPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:url'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'url.query.v', operator: 'exists' }],
			},
		],
	};
	const { r: uqCr, keyId: UQ_KEY } = await createKey('smoke-url-query', ZONE, urlQueryPolicy);
	assertStatus('url-query key created -> 200', uqCr, 200);

	const uqOk = await purge(UQ_KEY, PURGE_URL, { files: ['https://erfi.io/style.css?v=123'] });
	assertStatus('url-query: ?v=123 -> 200', uqOk, 200);

	const uqBad = await purge(UQ_KEY, PURGE_URL, { files: ['https://erfi.io/style.css'] });
	assertStatus('url-query: no query param -> 403', uqBad, 403);

	const uqBadParam = await purge(UQ_KEY, PURGE_URL, { files: ['https://erfi.io/style.css?t=456'] });
	assertStatus('url-query: ?t=456 (wrong param) -> 403', uqBadParam, 403);

	// url.query value match: allow only when cache_bust=true
	const urlQueryValuePolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:url'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'url.query.cache_bust', operator: 'eq', value: 'true' }],
			},
		],
	};
	const { r: uqvCr, keyId: UQV_KEY } = await createKey('smoke-url-query-value', ZONE, urlQueryValuePolicy);
	assertStatus('url-query-value key created -> 200', uqvCr, 200);

	const uqvOk = await purge(UQV_KEY, PURGE_URL, { files: ['https://erfi.io/page.html?cache_bust=true'] });
	assertStatus('url-query-value: cache_bust=true -> 200', uqvOk, 200);

	const uqvBad = await purge(UQV_KEY, PURGE_URL, { files: ['https://erfi.io/page.html?cache_bust=false'] });
	assertStatus('url-query-value: cache_bust=false -> 403', uqvBad, 403);

	// ─── 20. Header-Based Cache Key Conditions ─────────────────────

	section('Header-Based Cache Key Conditions');

	// header.CF-Device-Type condition: allow purge only for mobile cache keys
	const headerPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:url'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'header.CF-Device-Type', operator: 'eq', value: 'mobile' }],
			},
		],
	};
	const { r: hdrCr, keyId: HDR_KEY } = await createKey('smoke-header-device', ZONE, headerPolicy);
	assertStatus('header-device key created -> 200', hdrCr, 200);

	// Object-style file entry with headers
	const hdrOk = await purge(HDR_KEY, PURGE_URL, {
		files: [{ url: 'https://erfi.io/page.html', headers: { 'CF-Device-Type': 'mobile' } }],
	});
	assertStatus('header-device: mobile -> 200', hdrOk, 200);

	const hdrBad = await purge(HDR_KEY, PURGE_URL, {
		files: [{ url: 'https://erfi.io/page.html', headers: { 'CF-Device-Type': 'desktop' } }],
	});
	assertStatus('header-device: desktop -> 403', hdrBad, 403);

	// Without headers -> header field doesn't exist -> 403
	const hdrNoHeader = await purge(HDR_KEY, PURGE_URL, { files: ['https://erfi.io/page.html'] });
	assertStatus('header-device: no headers -> 403', hdrNoHeader, 403);

	// Header deny: allow purge:url, deny when CF-Device-Type == "bot"
	const headerDenyPolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['purge:url'], resources: [`zone:${ZONE}`] },
			{
				effect: 'deny',
				actions: ['purge:url'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'header.CF-Device-Type', operator: 'eq', value: 'bot' }],
			},
		],
	};
	const { r: hddCr, keyId: HDD_KEY } = await createKey('smoke-header-deny', ZONE, headerDenyPolicy);
	assertStatus('header-deny key created -> 200', hddCr, 200);

	const hddOk = await purge(HDD_KEY, PURGE_URL, { files: ['https://erfi.io/page.html'] });
	assertStatus('header-deny: plain URL (no header) -> 200', hddOk, 200);

	const hddOk2 = await purge(HDD_KEY, PURGE_URL, {
		files: [{ url: 'https://erfi.io/page.html', headers: { 'CF-Device-Type': 'mobile' } }],
	});
	assertStatus('header-deny: CF-Device-Type=mobile -> 200', hddOk2, 200);

	const hddBad = await purge(HDD_KEY, PURGE_URL, {
		files: [{ url: 'https://erfi.io/page.html', headers: { 'CF-Device-Type': 'bot' } }],
	});
	assertStatus('header-deny: CF-Device-Type=bot -> 403', hddBad, 403);

	// ─── 21. Granular Prefix Scoping ───────────────────────────────

	section('Granular Prefix Scoping');

	// Prefix wildcard: allow only erfi.io/static/* prefixes
	const prefixWildcardPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:prefix'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'prefix', operator: 'wildcard', value: 'erfi.io/static/*' }],
			},
		],
	};
	const { r: pwCr, keyId: PW_KEY } = await createKey('smoke-prefix-wildcard', ZONE, prefixWildcardPolicy);
	assertStatus('prefix-wildcard key created -> 200', pwCr, 200);

	const pwOk = await purge(PW_KEY, PURGE_URL, { prefixes: ['erfi.io/static/css/'] });
	assertStatus('prefix-wildcard: erfi.io/static/css/ -> 200', pwOk, 200);

	const pwOk2 = await purge(PW_KEY, PURGE_URL, { prefixes: ['erfi.io/static/js/'] });
	assertStatus('prefix-wildcard: erfi.io/static/js/ -> 200', pwOk2, 200);

	const pwBad = await purge(PW_KEY, PURGE_URL, { prefixes: ['erfi.io/api/v1/'] });
	assertStatus('prefix-wildcard: erfi.io/api/v1/ -> 403', pwBad, 403);

	// Prefix deny: allow purge:prefix, deny erfi.io/admin/*
	const prefixDenyPolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['purge:prefix'], resources: [`zone:${ZONE}`] },
			{
				effect: 'deny',
				actions: ['purge:prefix'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'prefix', operator: 'starts_with', value: 'erfi.io/admin' }],
			},
		],
	};
	const { r: pdCr, keyId: PD_KEY } = await createKey('smoke-prefix-deny', ZONE, prefixDenyPolicy);
	assertStatus('prefix-deny key created -> 200', pdCr, 200);

	const pdOk = await purge(PD_KEY, PURGE_URL, { prefixes: ['erfi.io/public/'] });
	assertStatus('prefix-deny: erfi.io/public/ -> 200', pdOk, 200);

	const pdBad = await purge(PD_KEY, PURGE_URL, { prefixes: ['erfi.io/admin/settings/'] });
	assertStatus('prefix-deny: erfi.io/admin/settings/ -> 403', pdBad, 403);

	// Multiple prefixes: one allowed, one denied
	const pdPartial = await purge(PD_KEY, PURGE_URL, { prefixes: ['erfi.io/public/', 'erfi.io/admin/'] });
	assertStatus('prefix-deny: mixed prefixes -> 403', pdPartial, 403);

	// ─── 22. Cross-Field Combinations ──────────────────────────────

	section('Cross-Field Combinations');

	// Host + URL path: allow purge:url only for cdn.erfi.io/assets/* (both conditions AND'd)
	const hostPathPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:url'],
				resources: [`zone:${ZONE}`],
				conditions: [
					{ field: 'host', operator: 'eq', value: 'cdn.erfi.io' },
					{ field: 'url.path', operator: 'starts_with', value: '/assets/' },
				],
			},
		],
	};
	const { r: hpCr, keyId: HP_KEY } = await createKey('smoke-host-path', ZONE, hostPathPolicy);
	assertStatus('host+path key created -> 200', hpCr, 200);

	const hpOk = await purge(HP_KEY, PURGE_URL, { files: ['https://cdn.erfi.io/assets/style.css'] });
	assertStatus('host+path: cdn.erfi.io/assets/style.css -> 200', hpOk, 200);

	const hpBadHost = await purge(HP_KEY, PURGE_URL, { files: ['https://api.erfi.io/assets/style.css'] });
	assertStatus('host+path: wrong host, right path -> 403', hpBadHost, 403);

	const hpBadPath = await purge(HP_KEY, PURGE_URL, { files: ['https://cdn.erfi.io/api/data.json'] });
	assertStatus('host+path: right host, wrong path -> 403', hpBadPath, 403);

	const hpBadBoth = await purge(HP_KEY, PURGE_URL, { files: ['https://evil.com/secrets/data'] });
	assertStatus('host+path: wrong host + wrong path -> 403', hpBadBoth, 403);

	// Multi-statement multi-action: tag purge for static tags + host purge for *.erfi.io
	const multiFieldPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:tag'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'tag', operator: 'starts_with', value: 'static-' }],
			},
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ZONE}`],
				conditions: [{ field: 'host', operator: 'wildcard', value: '*.erfi.io' }],
			},
		],
	};
	const { r: mfCr, keyId: MF_KEY } = await createKey('smoke-multi-field', ZONE, multiFieldPolicy);
	assertStatus('multi-field key created -> 200', mfCr, 200);

	const mfTagOk = await purge(MF_KEY, PURGE_URL, { tags: ['static-v2'] });
	assertStatus('multi-field: static tag -> 200', mfTagOk, 200);

	const mfHostOk = await purge(MF_KEY, PURGE_URL, { hosts: ['cdn.erfi.io'] });
	assertStatus('multi-field: *.erfi.io host -> 200', mfHostOk, 200);

	const mfTagBad = await purge(MF_KEY, PURGE_URL, { tags: ['dynamic-v1'] });
	assertStatus('multi-field: non-static tag -> 403', mfTagBad, 403);

	const mfHostBad = await purge(MF_KEY, PURGE_URL, { hosts: ['evil.com'] });
	assertStatus('multi-field: non-erfi host -> 403', mfHostBad, 403);

	const mfPrefixBad = await purge(MF_KEY, PURGE_URL, { prefixes: ['erfi.io/css/'] });
	assertStatus('multi-field: prefix purge (no action) -> 403', mfPrefixBad, 403);

	// Host + path + header combined: allow file purge for cdn.erfi.io/assets/* with mobile device type
	const triplePolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:url'],
				resources: [`zone:${ZONE}`],
				conditions: [
					{ field: 'host', operator: 'eq', value: 'cdn.erfi.io' },
					{ field: 'url.path', operator: 'starts_with', value: '/assets/' },
					{ field: 'header.CF-Device-Type', operator: 'in', value: ['mobile', 'tablet'] },
				],
			},
		],
	};
	const { r: trCr, keyId: TR_KEY } = await createKey('smoke-triple-condition', ZONE, triplePolicy);
	assertStatus('triple-condition key created -> 200', trCr, 200);

	const trOk = await purge(TR_KEY, PURGE_URL, {
		files: [{ url: 'https://cdn.erfi.io/assets/app.js', headers: { 'CF-Device-Type': 'mobile' } }],
	});
	assertStatus('triple: all match -> 200', trOk, 200);

	const trOk2 = await purge(TR_KEY, PURGE_URL, {
		files: [{ url: 'https://cdn.erfi.io/assets/app.js', headers: { 'CF-Device-Type': 'tablet' } }],
	});
	assertStatus('triple: tablet device -> 200', trOk2, 200);

	const trBadDevice = await purge(TR_KEY, PURGE_URL, {
		files: [{ url: 'https://cdn.erfi.io/assets/app.js', headers: { 'CF-Device-Type': 'desktop' } }],
	});
	assertStatus('triple: desktop device -> 403', trBadDevice, 403);

	const trBadHost = await purge(TR_KEY, PURGE_URL, {
		files: [{ url: 'https://api.erfi.io/assets/app.js', headers: { 'CF-Device-Type': 'mobile' } }],
	});
	assertStatus('triple: wrong host -> 403', trBadHost, 403);

	const trBadPath = await purge(TR_KEY, PURGE_URL, {
		files: [{ url: 'https://cdn.erfi.io/api/data', headers: { 'CF-Device-Type': 'mobile' } }],
	});
	assertStatus('triple: wrong path -> 403', trBadPath, 403);

	const trNoHeader = await purge(TR_KEY, PURGE_URL, { files: ['https://cdn.erfi.io/assets/app.js'] });
	assertStatus('triple: no device header -> 403', trNoHeader, 403);

	// Allow + deny with different field combos: allow purge:url broadly, deny /admin/* on *.internal.erfi.io
	const crossDenyPolicy = {
		version: '2025-01-01',
		statements: [
			{ effect: 'allow', actions: ['purge:url'], resources: [`zone:${ZONE}`] },
			{
				effect: 'deny',
				actions: ['purge:url'],
				resources: [`zone:${ZONE}`],
				conditions: [
					{ field: 'host', operator: 'wildcard', value: '*.internal.erfi.io' },
					{ field: 'url.path', operator: 'starts_with', value: '/admin/' },
				],
			},
		],
	};
	const { r: cdCr, keyId: CD_KEY } = await createKey('smoke-cross-deny', ZONE, crossDenyPolicy);
	assertStatus('cross-deny key created -> 200', cdCr, 200);

	const cdOk1 = await purge(CD_KEY, PURGE_URL, { files: ['https://cdn.erfi.io/admin/panel'] });
	assertStatus('cross-deny: public host + /admin -> 200 (deny host doesnt match)', cdOk1, 200);

	const cdOk2 = await purge(CD_KEY, PURGE_URL, { files: ['https://db.internal.erfi.io/api/status'] });
	assertStatus('cross-deny: internal host + /api -> 200 (deny path doesnt match)', cdOk2, 200);

	const cdBad = await purge(CD_KEY, PURGE_URL, { files: ['https://db.internal.erfi.io/admin/secrets'] });
	assertStatus('cross-deny: internal host + /admin -> 403 (both conditions match)', cdBad, 403);

	// ─── 16. Security Headers ───────────────────────────────────────

	section('Security Headers');

	// Check headers on a 200 response (reuse the wildcard key)
	const secOk = await purge(WILDCARD_ID, PURGE_URL, { hosts: ['erfi.io'] });
	assertStatus('sec-headers baseline: 200', secOk, 200);
	assertJson('200: X-Content-Type-Options', secOk.headers.get('x-content-type-options'), 'nosniff');
	assertJson('200: X-Frame-Options', secOk.headers.get('x-frame-options'), 'DENY');
	assertTruthy('200: Content-Security-Policy present', secOk.headers.has('content-security-policy'));
	assertJson('200: Referrer-Policy', secOk.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
	assertTruthy('200: Permissions-Policy present', secOk.headers.has('permissions-policy'));

	// Check headers on a 401 response
	const sec401 = await req('POST', PURGE_URL, { hosts: ['erfi.io'] });
	assertJson('401: X-Content-Type-Options', sec401.headers.get('x-content-type-options'), 'nosniff');
	assertJson('401: X-Frame-Options', sec401.headers.get('x-frame-options'), 'DENY');
	assertTruthy('401: Content-Security-Policy present', sec401.headers.has('content-security-policy'));
	assertJson('401: Referrer-Policy', sec401.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
	assertTruthy('401: Permissions-Policy present', sec401.headers.has('permissions-policy'));

	// Check headers on a 403 response
	const sec403 = await purge(HOST_ID, PURGE_URL, { hosts: ['evil.com'] });
	assertJson('403: X-Content-Type-Options', sec403.headers.get('x-content-type-options'), 'nosniff');
	assertJson('403: X-Frame-Options', sec403.headers.get('x-frame-options'), 'DENY');
	assertTruthy('403: Content-Security-Policy present', sec403.headers.has('content-security-policy'));
	assertJson('403: Referrer-Policy', sec403.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
	assertTruthy('403: Permissions-Policy present', sec403.headers.has('permissions-policy'));
}
