/**
 * Smoke tests — Key and S3 Credential rotation + update.
 */

import type { SmokeContext } from './helpers.js';
import { admin, section, createKey, assertStatus, assertJson, assertTruthy, assertMatch, state, dim } from './helpers.js';

export async function run(ctx: SmokeContext): Promise<void> {
	// ─── Key Rotation ──────────────────────────────────────────────

	section('Key Rotation');

	// Create a key to rotate
	const { r: cr, keyId: rotateKeyId } = await createKey('smoke-rotate', ctx.ZONE, ctx.WILDCARD_POLICY);
	assertStatus('create key for rotation -> 200', cr, 200);

	// Rotate it
	const rotateRes = await admin('POST', `/admin/keys/${rotateKeyId}/rotate`, {});
	assertStatus('rotate key -> 200', rotateRes, 200);
	assertTruthy('rotation returns old_key', rotateRes.body?.result?.old_key);
	assertTruthy('rotation returns new_key', rotateRes.body?.result?.new_key);
	assertJson('old key ID matches', rotateRes.body?.result?.old_key?.id, rotateKeyId);
	assertJson('old key is revoked', rotateRes.body?.result?.old_key?.revoked, 1);
	assertMatch('new key has gw_ prefix', rotateRes.body?.result?.new_key?.id ?? '', /^gw_/);
	assertJson('new key not revoked', rotateRes.body?.result?.new_key?.revoked, 0);
	assertMatch('new key name has (rotated)', rotateRes.body?.result?.new_key?.name ?? '', /\(rotated\)/);

	const newKeyId = rotateRes.body?.result?.new_key?.id;
	if (newKeyId) state.createdKeys.push(newKeyId);

	// Rotate with custom name + expiry
	const { keyId: rotateKeyId2 } = await createKey('smoke-custom-rotate', ctx.ZONE, ctx.WILDCARD_POLICY);
	const rotateRes2 = await admin('POST', `/admin/keys/${rotateKeyId2}/rotate`, {
		name: 'custom-rotated-name',
		expires_in_days: 30,
	});
	assertStatus('rotate with custom name -> 200', rotateRes2, 200);
	assertJson('custom name applied', rotateRes2.body?.result?.new_key?.name, 'custom-rotated-name');
	assertTruthy('expiry set', rotateRes2.body?.result?.new_key?.expires_at);

	const newKeyId2 = rotateRes2.body?.result?.new_key?.id;
	if (newKeyId2) state.createdKeys.push(newKeyId2);

	// Cannot rotate revoked key
	const rotateRes3 = await admin('POST', `/admin/keys/${rotateKeyId}/rotate`, {});
	assertStatus('rotate revoked key -> 404', rotateRes3, 404);

	// Cannot rotate nonexistent key
	const rotateRes4 = await admin('POST', `/admin/keys/gw_00000000deadbeef00000000/rotate`, {});
	assertStatus('rotate nonexistent key -> 404', rotateRes4, 404);

	// ─── Key Update ────────────────────────────────────────────────

	section('Key Update');

	// Create a key to update
	const { r: ucr, keyId: updateKeyId } = await createKey('smoke-update', ctx.ZONE, ctx.WILDCARD_POLICY);
	assertStatus('create key for update -> 200', ucr, 200);

	// Update name
	const upd1 = await admin('PATCH', `/admin/keys/${updateKeyId}`, { name: 'updated-name' });
	assertStatus('update key name -> 200', upd1, 200);
	assertJson('name updated', upd1.body?.result?.key?.name, 'updated-name');

	// Update expires_at
	const newExpiry = Date.now() + 90 * 24 * 60 * 60 * 1000;
	const upd2 = await admin('PATCH', `/admin/keys/${updateKeyId}`, { expires_at: newExpiry });
	assertStatus('update key expiry -> 200', upd2, 200);
	assertJson('expiry updated', upd2.body?.result?.key?.expires_at, newExpiry);

	// Remove expiry
	const upd3 = await admin('PATCH', `/admin/keys/${updateKeyId}`, { expires_at: null });
	assertStatus('remove key expiry -> 200', upd3, 200);
	assertJson('expiry removed', upd3.body?.result?.key?.expires_at, null);

	// Update rate limits
	const upd4 = await admin('PATCH', `/admin/keys/${updateKeyId}`, { rate_limit: { bulk_rate: 10 } });
	assertStatus('update key rate limits -> 200', upd4, 200);
	assertJson('rate limit updated', upd4.body?.result?.key?.bulk_rate, 10);

	// Empty update body -> 400
	const upd5 = await admin('PATCH', `/admin/keys/${updateKeyId}`, {});
	assertStatus('empty update -> 400', upd5, 400);

	// Update nonexistent key -> 404
	const upd6 = await admin('PATCH', '/admin/keys/gw_00000000deadbeef00000000', { name: 'nope' });
	assertStatus('update nonexistent key -> 404', upd6, 404);

	// ─── S3 Credential Rotation ────────────────────────────────────

	section('S3 Credential Rotation');

	if (!ctx.s3UpstreamId) {
		console.log(`  ${dim('(skipped — S3 not configured)')}`);
	} else {
		const s3Policy = {
			version: '2025-01-01',
			statements: [{ effect: 'allow', actions: ['s3:*'], resources: ['account:*', 'bucket:*', 'object:*'] }],
		};

		// Create a credential
		const credRes = await admin('POST', '/admin/s3/credentials', {
			name: 'smoke-rotate-cred',
			policy: s3Policy,
			upstream_token_id: ctx.s3UpstreamId,
		});
		assertStatus('create s3 cred for rotation -> 200', credRes, 200);
		const accessKeyId = credRes.body?.result?.credential?.access_key_id;
		if (accessKeyId) state.createdS3Creds.push(accessKeyId);

		if (accessKeyId) {
			// Rotate
			const s3Rotate = await admin('POST', `/admin/s3/credentials/${accessKeyId}/rotate`, {});
			assertStatus('rotate s3 cred -> 200', s3Rotate, 200);
			assertTruthy('old credential returned', s3Rotate.body?.result?.old_credential);
			assertTruthy('new credential returned', s3Rotate.body?.result?.new_credential);
			assertJson('old credential revoked', s3Rotate.body?.result?.old_credential?.revoked, 1);
			assertJson('old secret redacted', s3Rotate.body?.result?.old_credential?.secret_access_key, '***');
			assertMatch('new AK has GK prefix', s3Rotate.body?.result?.new_credential?.access_key_id ?? '', /^GK/);

			const newAK = s3Rotate.body?.result?.new_credential?.access_key_id;
			if (newAK) state.createdS3Creds.push(newAK);

			// Update
			const s3Upd = await admin('PATCH', `/admin/s3/credentials/${newAK}`, { name: 'updated-cred-name' });
			assertStatus('update s3 cred name -> 200', s3Upd, 200);
			assertJson('cred name updated', s3Upd.body?.result?.credential?.name, 'updated-cred-name');
		}
	}

	// ─── Referential Integrity ─────────────────────────────────────

	section('Referential Integrity');

	// Create a dedicated upstream token, bind a key to it, then delete it
	const refToken = await admin('POST', '/admin/upstream-tokens', {
		name: 'smoke-ref-integrity',
		token: 'smoke-ref-test-token-1234567890',
		zone_ids: [ctx.ZONE],
		validate: false,
	});
	assertStatus('create ref-test upstream token -> 200', refToken, 200);
	const refTokenId = refToken.body?.result?.id;
	if (refTokenId) state.createdUpstreamTokens.push(refTokenId);

	if (refTokenId) {
		// Create a key bound to it
		const { keyId: refKeyId } = await createKey('ref-bound-key', ctx.ZONE, ctx.WILDCARD_POLICY, {
			upstream_token_id: refTokenId,
		});

		// Delete the upstream token — should warn
		const delRes = await admin('DELETE', `/admin/upstream-tokens/${refTokenId}`);
		assertStatus('delete upstream token with bound key -> 200', delRes, 200);
		assertTruthy('warnings returned', delRes.body?.warnings);
		assertJson('warning type is orphaned_keys', delRes.body?.warnings?.[0]?.type, 'orphaned_keys');
		// Remove from cleanup list since it's already gone
		const refTIdx = state.createdUpstreamTokens.indexOf(refTokenId);
		if (refTIdx >= 0) state.createdUpstreamTokens.splice(refTIdx, 1);

		// Also delete the orphaned key
		if (refKeyId) {
			await admin('DELETE', `/admin/keys/${refKeyId}?permanent=true`);
			const refKIdx = state.createdKeys.indexOf(refKeyId);
			if (refKIdx >= 0) state.createdKeys.splice(refKIdx, 1);
		}
	}
}
