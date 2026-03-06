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

	const noName = await admin('POST', '/admin/keys', { zone_id: ctx.ZONE, policy: ctx.WILDCARD_POLICY });
	assertStatus('missing name -> 400', noName, 400);

	const noZone = await admin('POST', '/admin/keys', { name: 'smoke-no-zone', policy: ctx.WILDCARD_POLICY });
	assertStatus('missing zone_id -> 200 (zone_id is optional)', noZone, 200);
	const noZoneKeyId = noZone.body?.result?.key?.id;
	if (noZoneKeyId) state.createdKeys.push(noZoneKeyId);

	const noPol = await admin('POST', '/admin/keys', { name: 'x', zone_id: ctx.ZONE });
	assertStatus('missing policy -> 400', noPol, 400);

	const badVer = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		policy: { version: 'wrong', statements: [] },
	});
	assertStatus('invalid policy version -> 400', badVer, 400);

	const emptyStmt = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
		policy: { version: '2025-01-01', statements: [] },
	});
	assertStatus('empty statements -> 400', emptyStmt, 400);

	const badRegex = await admin('POST', '/admin/keys', {
		name: 'x',
		zone_id: ctx.ZONE,
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
		policy: ctx.WILDCARD_POLICY,
		rate_limit: { bulk_rate: 99999 },
	});
	assertStatus('rate_limit exceeds account default -> 400', bigRate, 400);

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
}
