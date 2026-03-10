/**
 * Smoke tests — sections 1-6: Health, Admin Auth, Key Creation, Validation, List Keys, Get Key.
 */

import type { SmokeContext } from './helpers.js';
import { req, admin, section, createKey, assertStatus, assertJson, assertMatch, assertTruthy, state, ADMIN_KEY } from './helpers.js';

export async function run(ctx: SmokeContext): Promise<void> {
	// ─── 1. Health ──────────────────────────────────────────────────

	section('Health');
	const hr = await req('GET', '/health');
	assertStatus('GET /health -> 200', hr, 200);
	assertJson('health body has ok:true', hr.body?.ok, true);

	// ─── 2. Admin Authentication ────────────────────────────────────

	section('Admin Authentication');

	const noKey = await req('GET', `/admin/keys?zone_id=${ctx.ZONE}`);
	assertStatus('no admin key -> 401', noKey, 401);

	const wrongKey = await req('GET', `/admin/keys?zone_id=${ctx.ZONE}`, undefined, { 'X-Admin-Key': 'wrong-key-entirely' });
	assertStatus('wrong admin key -> 401', wrongKey, 401);

	const rightKey = await admin('GET', `/admin/keys?zone_id=${ctx.ZONE}`);
	assertStatus('correct admin key -> 200', rightKey, 200);

	// ─── 3. Key Creation — happy path ───────────────────────────────

	section('Key Creation');

	const { r: wcr, keyId: WILDCARD_ID } = await createKey('smoke-wildcard', ctx.ZONE, ctx.WILDCARD_POLICY);
	assertStatus('create wildcard key -> 200', wcr, 200);
	assertTruthy('key has gw_ prefix', wcr.body?.result?.key?.id?.startsWith('gw_'));
	assertJson('key name matches', wcr.body?.result?.key?.name, 'smoke-wildcard');
	assertJson('key zone matches', wcr.body?.result?.key?.zone_id, ctx.ZONE);
	assertJson('key not revoked', wcr.body?.result?.key?.revoked, 0);
	ctx.WILDCARD_ID = WILDCARD_ID;

	const hostPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${ctx.ZONE}`],
				conditions: [{ field: 'host', operator: 'eq', value: 'erfi.io' }],
			},
		],
	};
	const { r: hr2, keyId: HOST_ID } = await createKey('smoke-host-scoped', ctx.ZONE, hostPolicy);
	assertStatus('create host-scoped key -> 200', hr2, 200);
	ctx.HOST_ID = HOST_ID;

	const tagPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:tag'],
				resources: [`zone:${ctx.ZONE}`],
				conditions: [{ field: 'tag', operator: 'starts_with', value: 'static-' }],
			},
		],
	};
	const { r: tr, keyId: TAG_ID } = await createKey('smoke-tag-scoped', ctx.ZONE, tagPolicy);
	assertStatus('create tag-scoped key -> 200', tr, 200);
	ctx.TAG_ID = TAG_ID;

	const prefixPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:prefix'],
				resources: [`zone:${ctx.ZONE}`],
				conditions: [{ field: 'prefix', operator: 'wildcard', value: 'erfi.io/assets/*' }],
			},
		],
	};
	const { r: pr, keyId: PREFIX_ID } = await createKey('smoke-prefix-scoped', ctx.ZONE, prefixPolicy);
	assertStatus('create prefix-scoped key -> 200', pr, 200);
	ctx.PREFIX_ID = PREFIX_ID;

	const urlPolicy = {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:url'],
				resources: [`zone:${ctx.ZONE}`],
				conditions: [{ field: 'host', operator: 'eq', value: 'erfi.io' }],
			},
		],
	};
	const { r: ur, keyId: URL_ID } = await createKey('smoke-url-scoped', ctx.ZONE, urlPolicy);
	assertStatus('create url-scoped key -> 200', ur, 200);
	ctx.URL_ID = URL_ID;

	const multiPolicy = {
		version: '2025-01-01',
		statements: [{ effect: 'allow', actions: ['purge:host', 'purge:tag'], resources: [`zone:${ctx.ZONE}`] }],
	};
	const { r: mr, keyId: MULTI_ID } = await createKey('smoke-multi-action', ctx.ZONE, multiPolicy);
	assertStatus('create multi-action key -> 200', mr, 200);
	ctx.MULTI_ID = MULTI_ID;

	const { r: rr, keyId: REVOKE_ID } = await createKey('smoke-revoke-target', ctx.ZONE, ctx.WILDCARD_POLICY);
	assertStatus('create key for revoke -> 200', rr, 200);
	ctx.REVOKE_ID = REVOKE_ID;

	const { r: rr2, keyId: REVOKE_ID_2 } = await createKey('smoke-revoke-target-2', ctx.ZONE, ctx.WILDCARD_POLICY);
	assertStatus('create second revoke target -> 200', rr2, 200);
	ctx.REVOKE_ID_2 = REVOKE_ID_2;

	const rlr = await admin('POST', '/admin/keys', {
		name: 'smoke-with-ratelimit',
		zone_id: ctx.ZONE,
		policy: ctx.WILDCARD_POLICY,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
		rate_limit: { bulk_rate: 10, bulk_bucket: 100 },
	});
	const RATELIMIT_ID = rlr.body?.result?.key?.id;
	if (RATELIMIT_ID) state.createdKeys.push(RATELIMIT_ID);
	assertStatus('create key with per-key rate limit -> 200', rlr, 200);
	assertJson('per-key bulk_rate stored', rlr.body?.result?.key?.bulk_rate, 10);
	assertJson('per-key bulk_bucket stored', rlr.body?.result?.key?.bulk_bucket, 100);
	ctx.RATELIMIT_ID = RATELIMIT_ID;

	// ─── 4. Key Creation — validation errors ────────────────────────

	section('Key Creation Validation');

	const noName = await admin('POST', '/admin/keys', {
		zone_id: ctx.ZONE,
		policy: ctx.WILDCARD_POLICY,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
	});
	assertStatus('missing name -> 400', noName, 400);

	const noZone = await admin('POST', '/admin/keys', {
		name: 'smoke-no-zone',
		policy: ctx.WILDCARD_POLICY,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
	});
	assertStatus('missing zone_id -> 200 (zone_id is optional)', noZone, 200);
	const noZoneKeyId = noZone.body?.result?.key?.id;
	if (noZoneKeyId) state.createdKeys.push(noZoneKeyId);

	const noPol = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
	});
	assertStatus('missing policy -> 400', noPol, 400);

	const badVer = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
		policy: { version: 'wrong', statements: [] },
	});
	assertStatus('invalid policy version -> 400', badVer, 400);

	const emptyStmt = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
		policy: { version: '2025-01-01', statements: [] },
	});
	assertStatus('empty statements -> 400', emptyStmt, 400);

	const badRegex = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
		policy: {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['purge:*'],
					resources: [`zone:${ctx.ZONE}`],
					conditions: [{ field: 'x', operator: 'matches', value: '(a+)+$' }],
				},
			],
		},
	});
	assertStatus('dangerous regex -> 400', badRegex, 400);
	assertMatch('error mentions backtracking', badRegex.body?.errors?.[0]?.message ?? '', /backtracking/i);

	// deny is now a valid effect (IAM v2) — verify it's accepted
	const denyEffect = await admin('POST', '/admin/keys', {
		name: 'smoke-deny-valid',
		zone_id: ctx.ZONE,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
		policy: {
			version: '2025-01-01',
			statements: [
				{ effect: 'allow', actions: ['purge:*'], resources: [`zone:${ctx.ZONE}`] },
				{ effect: 'deny', actions: ['purge:everything'], resources: [`zone:${ctx.ZONE}`] },
			],
		},
	});
	assertStatus('effect=deny -> 200 (valid in IAM v2)', denyEffect, 200);
	const denyEffectKeyId = denyEffect.body?.result?.key?.id;
	if (denyEffectKeyId) state.createdKeys.push(denyEffectKeyId);

	// Invalid effect (not allow/deny) should still be rejected
	const badEffect = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
		policy: {
			version: '2025-01-01',
			statements: [{ effect: 'block', actions: ['purge:*'], resources: [`zone:${ctx.ZONE}`] }],
		},
	});
	assertStatus('effect=block (invalid) -> 400', badEffect, 400);

	const badJson = await req('POST', '/admin/keys', 'not json at all', {
		'X-Admin-Key': ADMIN_KEY!,
		'Content-Type': 'application/json',
	});
	assertStatus('invalid JSON body -> 400', badJson, 400);

	const bigRate = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
		policy: ctx.WILDCARD_POLICY,
		rate_limit: { bulk_rate: 99999 },
	});
	assertStatus('rate_limit exceeds account default -> 400', bigRate, 400);

	// ─── 4b. Token Binding Validation (zone-scoped) ────────────────

	section('Token Binding Validation (zone-scoped)');

	// T1: Nonexistent upstream token
	const tbNoToken = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		upstream_token_id: 'upt_does_not_exist_at_all',
		policy: { version: '2025-01-01', statements: [{ effect: 'allow', actions: ['purge:*'], resources: [`zone:${ctx.ZONE}`] }] },
	});
	assertStatus('nonexistent upstream_token_id -> 400', tbNoToken, 400);
	assertMatch('error mentions token not found', tbNoToken.body?.errors?.[0]?.message ?? '', /not found/i);

	// T2: Zone-scoped token with account-scoped action (d1:read)
	const tbWrongAction = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
		policy: { version: '2025-01-01', statements: [{ effect: 'allow', actions: ['d1:read'], resources: [`zone:${ctx.ZONE}`] }] },
	});
	assertStatus('zone token + account action (d1:read) -> 400', tbWrongAction, 400);
	assertMatch('error mentions zone-scoped', tbWrongAction.body?.errors?.[0]?.message ?? '', /zone-scoped/i);

	// T4: Bare wildcard resource "*"
	const tbBareWildcard = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
		policy: { version: '2025-01-01', statements: [{ effect: 'allow', actions: ['purge:*'], resources: ['*'] }] },
	});
	assertStatus('bare wildcard resource "*" -> 400', tbBareWildcard, 400);
	assertMatch('error mentions wildcard not allowed', tbBareWildcard.body?.errors?.[0]?.message ?? '', /wildcard/i);

	// T5: Zone-scoped token with account-prefixed resource
	const tbWrongPrefix = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
		policy: { version: '2025-01-01', statements: [{ effect: 'allow', actions: ['purge:*'], resources: ['account:abc123'] }] },
	});
	assertStatus('zone token + account resource -> 400', tbWrongPrefix, 400);
	assertMatch('error mentions zone: prefix', tbWrongPrefix.body?.errors?.[0]?.message ?? '', /zone:/i);

	// T6: Zone-scoped token (specific zones) with zone:* resource
	const tbZoneWildcard = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
		policy: { version: '2025-01-01', statements: [{ effect: 'allow', actions: ['purge:*'], resources: ['zone:*'] }] },
	});
	assertStatus('zone:* on non-wildcard token -> 400', tbZoneWildcard, 400);
	assertMatch('error mentions zone:* not allowed', tbZoneWildcard.body?.errors?.[0]?.message ?? '', /zone:\*/i);

	// T7: Zone-scoped token with wrong zone ID
	const tbWrongZone = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
		policy: {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: ['purge:*'], resources: ['zone:aaaa1111bbbb2222cccc3333dddd4444'] }],
		},
	});
	assertStatus('zone not in token scope -> 400', tbWrongZone, 400);
	assertMatch('error mentions zone not covered', tbWrongZone.body?.errors?.[0]?.message ?? '', /not covered/i);

	// Missing upstream_token_id entirely
	const tbMissingToken = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		policy: { version: '2025-01-01', statements: [{ effect: 'allow', actions: ['purge:*'], resources: [`zone:${ctx.ZONE}`] }] },
	});
	assertStatus('missing upstream_token_id -> 400', tbMissingToken, 400);

	// Multiple errors in one request (wrong action + wrong resource)
	const tbMultiError = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		upstream_token_id: ctx.UPSTREAM_TOKEN_ID,
		policy: {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: ['d1:read', 'kv:list'], resources: ['account:abc123', '*'] }],
		},
	});
	assertStatus('multiple binding errors -> 400', tbMultiError, 400);

	// ─── 5. List Keys ───────────────────────────────────────────────

	section('List Keys');

	const listByZone = await admin('GET', `/admin/keys?zone_id=${ctx.ZONE}`);
	assertStatus('list keys by zone -> 200', listByZone, 200);
	const keyCount = listByZone.body?.result?.length ?? 0;
	assertTruthy(`key count >= 8 (got ${keyCount})`, keyCount >= 8);

	const listActive = await admin('GET', `/admin/keys?zone_id=${ctx.ZONE}&status=active`);
	assertStatus('list active keys -> 200', listActive, 200);

	const listAll = await admin('GET', '/admin/keys');
	assertStatus('list without zone_id -> 200 (returns all)', listAll, 200);

	const listEmpty = await admin('GET', '/admin/keys?zone_id=aaaa1111bbbb2222cccc3333dddd4444');
	assertStatus('list for unknown zone -> 200 (empty)', listEmpty, 200);
	assertJson('unknown zone returns empty', listEmpty.body?.result?.length, 0);

	// ─── 6. Get Key ─────────────────────────────────────────────────

	section('Get Key');

	const getKey = await admin('GET', `/admin/keys/${ctx.WILDCARD_ID}?zone_id=${ctx.ZONE}`);
	assertStatus('get existing key -> 200', getKey, 200);
	assertJson('get key returns correct id', getKey.body?.result?.key?.id, ctx.WILDCARD_ID);
	const parsedPol = JSON.parse(getKey.body?.result?.key?.policy ?? '{}');
	assertJson('get key has policy version', parsedPol?.version, '2025-01-01');

	const getNone = await admin('GET', `/admin/keys/gw_00000000000000000000000000000000?zone_id=${ctx.ZONE}`);
	assertStatus('get nonexistent key -> 404', getNone, 404);

	const getWrongZone = await admin('GET', `/admin/keys/${ctx.WILDCARD_ID}?zone_id=aaaa1111bbbb2222cccc3333dddd4444`);
	assertStatus('get key with wrong zone -> 404', getWrongZone, 404);

	const getNoZone = await admin('GET', `/admin/keys/${ctx.WILDCARD_ID}`);
	assertStatus('get key without zone_id -> 200', getNoZone, 200);

	// ─── 7. Upstream Tokens — list & get ────────────────────────────

	section('Upstream Tokens (list/get)');

	const listTokens = await admin('GET', '/admin/upstream-tokens');
	assertStatus('list upstream tokens -> 200', listTokens, 200);
	assertTruthy('tokens result is array', Array.isArray(listTokens.body?.result));
	const upstreamFound = listTokens.body?.result?.find((t: any) => t.id === ctx.UPSTREAM_TOKEN_ID);
	assertTruthy('smoke-test token in list', upstreamFound);
	assertTruthy('token_preview present (no secret)', upstreamFound?.token_preview && !upstreamFound?.token);

	const getToken = await admin('GET', `/admin/upstream-tokens/${ctx.UPSTREAM_TOKEN_ID}`);
	assertStatus('get upstream token by ID -> 200', getToken, 200);
	assertJson('token ID matches', getToken.body?.result?.id, ctx.UPSTREAM_TOKEN_ID);
	assertTruthy('secret not exposed in get', !getToken.body?.result?.token);

	const getNoToken = await admin('GET', '/admin/upstream-tokens/upt_does_not_exist_smoke');
	assertStatus('get nonexistent upstream token -> 404', getNoToken, 404);

	const listActiveTokens = await admin('GET', '/admin/upstream-tokens');
	assertStatus('list active upstream tokens -> 200', listActiveTokens, 200);
	assertTruthy('active tokens list is non-empty', (listActiveTokens.body?.result ?? []).length > 0);

	// ─── 8. Upstream R2 — list & get ────────────────────────────────

	section('Upstream R2 (list/get)');

	const listR2 = await admin('GET', '/admin/upstream-r2');
	assertStatus('list upstream R2 -> 200', listR2, 200);
	assertTruthy('R2 result is array', Array.isArray(listR2.body?.result));

	// If an R2 endpoint exists (created later in S3 tests), we can verify it.
	// For now, just verify the endpoint works and returns a proper array.
	const getNoR2 = await admin('GET', '/admin/upstream-r2/upr2_does_not_exist_smoke');
	assertStatus('get nonexistent upstream R2 -> 404', getNoR2, 404);

	// ─── 9. Upstream Token — PATCH update ──────────────────────────

	section('Upstream Token PATCH');

	const patchTokenName = await admin('PATCH', `/admin/upstream-tokens/${ctx.UPSTREAM_TOKEN_ID}`, { name: 'smoke-test-token-renamed' });
	assertStatus('PATCH upstream token name -> 200', patchTokenName, 200);
	assertJson('PATCH name applied', patchTokenName.body?.result?.name, 'smoke-test-token-renamed');

	const futureTs = Date.now() + 365 * 24 * 60 * 60 * 1000;
	const patchTokenExpiry = await admin('PATCH', `/admin/upstream-tokens/${ctx.UPSTREAM_TOKEN_ID}`, { expires_at: futureTs });
	assertStatus('PATCH upstream token expires_at -> 200', patchTokenExpiry, 200);
	assertJson('PATCH expires_at applied', patchTokenExpiry.body?.result?.expires_at, futureTs);

	const clearTokenExpiry = await admin('PATCH', `/admin/upstream-tokens/${ctx.UPSTREAM_TOKEN_ID}`, { expires_at: null });
	assertStatus('PATCH clear upstream token expires_at -> 200', clearTokenExpiry, 200);
	assertJson('PATCH expires_at cleared', clearTokenExpiry.body?.result?.expires_at, null);

	// Restore the name back
	await admin('PATCH', `/admin/upstream-tokens/${ctx.UPSTREAM_TOKEN_ID}`, { name: 'smoke-test-token' });

	const patchTokenNotFound = await admin('PATCH', '/admin/upstream-tokens/upt_doesnotexist12345', { name: 'nope' });
	assertStatus('PATCH nonexistent token -> 404', patchTokenNotFound, 404);

	const patchTokenEmpty = await admin('PATCH', `/admin/upstream-tokens/${ctx.UPSTREAM_TOKEN_ID}`, {});
	assertStatus('PATCH token empty body -> 400', patchTokenEmpty, 400);

	// ─── 10. Upstream Token — create with expiry ───────────────────

	section('Upstream Token Expiry');

	const tokenWithExpiry = await admin('POST', '/admin/upstream-tokens', {
		name: 'smoke-expiry-token',
		token: 'cf-smoke-expiry-token-' + Date.now().toString(36) + '-abcdefgh',
		zone_ids: ['*'],
		expires_in_days: 30,
	});
	assertStatus('create token with expires_in_days -> 200', tokenWithExpiry, 200);
	assertTruthy('expires_at is set', tokenWithExpiry.body?.result?.expires_at > Date.now());
	const expiryTokenId = tokenWithExpiry.body?.result?.id;
	if (expiryTokenId) state.createdUpstreamTokens.push(expiryTokenId);

	const tokenNoExpiry = await admin('POST', '/admin/upstream-tokens', {
		name: 'smoke-no-expiry-token',
		token: 'cf-smoke-no-expiry-token-' + Date.now().toString(36) + '-abcdef',
		zone_ids: ['*'],
	});
	assertStatus('create token without expires_in_days -> 200', tokenNoExpiry, 200);
	assertJson('expires_at is null', tokenNoExpiry.body?.result?.expires_at, null);
	const noExpiryTokenId = tokenNoExpiry.body?.result?.id;
	if (noExpiryTokenId) state.createdUpstreamTokens.push(noExpiryTokenId);
}
