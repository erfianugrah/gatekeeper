/**
 * Smoke tests — section 12c: Bulk Revoke & Bulk Delete (keys + S3 credentials).
 */

import type { SmokeContext } from './helpers.js';
import { admin, section, createKey, assertStatus, assertJson, assertTruthy, state, SKIP_S3 } from './helpers.js';

export async function run(ctx: SmokeContext): Promise<void> {
	const { ZONE, WILDCARD_POLICY } = ctx;

	// ─── 12c. Bulk Revoke / Delete — Keys ──────────────────────────

	section('Bulk Revoke Keys');

	// Create 3 throwaway keys
	const { r: r1, keyId: BK1 } = await createKey('smoke-bulk-1', ZONE, WILDCARD_POLICY);
	assertStatus('create bulk key 1 -> 200', r1, 200);
	const { r: r2, keyId: BK2 } = await createKey('smoke-bulk-2', ZONE, WILDCARD_POLICY);
	assertStatus('create bulk key 2 -> 200', r2, 200);
	const { r: r3, keyId: BK3 } = await createKey('smoke-bulk-3', ZONE, WILDCARD_POLICY);
	assertStatus('create bulk key 3 -> 200', r3, 200);

	// Revoke BK2 individually so it's already-revoked
	const revBk2 = await admin('DELETE', `/admin/keys/${BK2}`);
	assertStatus('pre-revoke BK2 -> 200', revBk2, 200);

	// Dry-run bulk revoke
	const dryRevoke = await admin('POST', '/admin/keys/bulk-revoke', {
		ids: [BK1, BK2, 'gw_00000000000000000000000000000000'],
		confirm_count: 3,
		dry_run: true,
	});
	assertStatus('bulk-revoke dry_run -> 200', dryRevoke, 200);
	assertJson('dry_run flag', dryRevoke.body?.result?.dry_run, true);
	assertJson('would_process', dryRevoke.body?.result?.would_process, 3);
	// Verify key is still active after dry run
	const getBk1 = await admin('GET', `/admin/keys/${BK1}`);
	assertJson('BK1 still active after dry_run', getBk1.body?.result?.key?.revoked, 0);

	// Real bulk revoke
	const bulkRevoke = await admin('POST', '/admin/keys/bulk-revoke', {
		ids: [BK1, BK2, 'gw_00000000000000000000000000000000'],
		confirm_count: 3,
	});
	assertStatus('bulk-revoke -> 200', bulkRevoke, 200);
	assertJson('processed count', bulkRevoke.body?.result?.processed, 3);
	const revokeStatuses = Object.fromEntries((bulkRevoke.body?.result?.results ?? []).map((r: any) => [r.id, r.status]));
	assertJson('BK1 revoked', revokeStatuses[BK1], 'revoked');
	assertJson('BK2 already_revoked', revokeStatuses[BK2], 'already_revoked');
	assertJson('nonexistent not_found', revokeStatuses['gw_00000000000000000000000000000000'], 'not_found');

	// Confirm_count mismatch -> 400
	const mismatch = await admin('POST', '/admin/keys/bulk-revoke', {
		ids: [BK1],
		confirm_count: 99,
	});
	assertStatus('confirm_count mismatch -> 400', mismatch, 400);

	// Empty array -> 400
	const empty = await admin('POST', '/admin/keys/bulk-revoke', {
		ids: [],
		confirm_count: 0,
	});
	assertStatus('empty ids -> 400', empty, 400);

	section('Bulk Delete Keys');

	// Dry-run bulk delete
	const dryDelete = await admin('POST', '/admin/keys/bulk-delete', {
		ids: [BK1, BK3],
		confirm_count: 2,
		dry_run: true,
	});
	assertStatus('bulk-delete dry_run -> 200', dryDelete, 200);
	assertJson('dry_run flag', dryDelete.body?.result?.dry_run, true);

	// Real bulk delete
	const bulkDelete = await admin('POST', '/admin/keys/bulk-delete', {
		ids: [BK1, BK2, BK3, 'gw_00000000000000000000000000000000'],
		confirm_count: 4,
	});
	assertStatus('bulk-delete -> 200', bulkDelete, 200);
	assertJson('processed count', bulkDelete.body?.result?.processed, 4);
	const deleteStatuses = Object.fromEntries((bulkDelete.body?.result?.results ?? []).map((r: any) => [r.id, r.status]));
	assertJson('BK1 deleted', deleteStatuses[BK1], 'deleted');
	assertJson('BK2 deleted', deleteStatuses[BK2], 'deleted');
	assertJson('BK3 deleted', deleteStatuses[BK3], 'deleted');
	assertJson('nonexistent not_found', deleteStatuses['gw_00000000000000000000000000000000'], 'not_found');

	// Verify keys are gone
	const getBk1After = await admin('GET', `/admin/keys/${BK1}`);
	assertStatus('BK1 gone after bulk-delete', getBk1After, 404);

	// Remove from cleanup list since they're already gone
	for (const kid of [BK1, BK2, BK3]) {
		const idx = state.createdKeys.indexOf(kid);
		if (idx >= 0) state.createdKeys.splice(idx, 1);
	}

	// ─── 12d. Bulk Revoke / Delete — S3 Credentials ────────────────

	if (SKIP_S3) {
		section('Bulk S3 Credentials (SKIPPED — no R2 env)');
		return;
	}

	section('Bulk Revoke S3 Credentials');

	// Create 2 S3 creds
	const s3Policy = {
		version: '2025-01-01',
		statements: [{ effect: 'allow', actions: ['s3:*'], resources: ['*'] }],
	};
	const sc1 = await admin('POST', '/admin/s3/credentials', { name: 'smoke-bulk-s3-1', policy: s3Policy });
	assertStatus('create S3 cred 1 -> 200', sc1, 200);
	const SC1_ID = sc1.body?.result?.credential?.access_key_id;
	if (SC1_ID) state.createdS3Creds.push(SC1_ID);

	const sc2 = await admin('POST', '/admin/s3/credentials', { name: 'smoke-bulk-s3-2', policy: s3Policy });
	assertStatus('create S3 cred 2 -> 200', sc2, 200);
	const SC2_ID = sc2.body?.result?.credential?.access_key_id;
	if (SC2_ID) state.createdS3Creds.push(SC2_ID);

	// Bulk revoke
	const bulkRevokeS3 = await admin('POST', '/admin/s3/credentials/bulk-revoke', {
		access_key_ids: [SC1_ID, 'GK000000000000000000'],
		confirm_count: 2,
	});
	assertStatus('bulk-revoke S3 -> 200', bulkRevokeS3, 200);
	const s3rStatuses = Object.fromEntries((bulkRevokeS3.body?.result?.results ?? []).map((r: any) => [r.id, r.status]));
	assertJson('SC1 revoked', s3rStatuses[SC1_ID], 'revoked');
	assertJson('nonexistent not_found', s3rStatuses['GK000000000000000000'], 'not_found');

	section('Bulk Delete S3 Credentials');

	// Bulk delete
	const bulkDeleteS3 = await admin('POST', '/admin/s3/credentials/bulk-delete', {
		access_key_ids: [SC1_ID, SC2_ID],
		confirm_count: 2,
	});
	assertStatus('bulk-delete S3 -> 200', bulkDeleteS3, 200);
	const s3dStatuses = Object.fromEntries((bulkDeleteS3.body?.result?.results ?? []).map((r: any) => [r.id, r.status]));
	assertJson('SC1 deleted', s3dStatuses[SC1_ID], 'deleted');
	assertJson('SC2 deleted', s3dStatuses[SC2_ID], 'deleted');

	// Verify gone
	const getSc1 = await admin('GET', `/admin/s3/credentials/${SC1_ID}`);
	assertStatus('SC1 gone after bulk-delete', getSc1, 404);

	// Remove from cleanup list
	for (const cid of [SC1_ID, SC2_ID]) {
		const idx = state.createdS3Creds.indexOf(cid);
		if (idx >= 0) state.createdS3Creds.splice(idx, 1);
	}
}
