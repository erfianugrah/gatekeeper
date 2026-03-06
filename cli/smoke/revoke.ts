/**
 * Smoke tests — sections 12-12b: Revoke Key + Permanent Delete Key.
 */

import type { SmokeContext } from './helpers.js';
import { admin, purge, section, createKey, assertStatus, assertJson, assertTruthy, state } from './helpers.js';

export async function run(ctx: SmokeContext): Promise<void> {
	const { ZONE, PURGE_URL, REVOKE_ID, REVOKE_ID_2, WILDCARD_POLICY } = ctx;

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

	// ─── 12b. Permanent Delete Key ──────────────────────────────────

	section('Permanent Delete Key');

	// Hard-delete the already-revoked key (REVOKE_ID)
	const hardDel = await admin('DELETE', `/admin/keys/${REVOKE_ID}?permanent=true`);
	assertStatus('hard-delete revoked key -> 200', hardDel, 200);
	assertJson('hard-delete result has deleted:true', hardDel.body?.result?.deleted, true);

	// Key no longer appears in GET
	const getDeleted = await admin('GET', `/admin/keys/${REVOKE_ID}`);
	assertStatus('GET hard-deleted key -> 404', getDeleted, 404);

	// Key no longer appears in list (even revoked filter)
	const listAfterDel = await admin('GET', `/admin/keys?zone_id=${ZONE}&status=revoked`);
	assertStatus('list revoked after hard-delete -> 200', listAfterDel, 200);
	const deletedInList = (listAfterDel.body?.result ?? []).some((k: any) => k.id === REVOKE_ID);
	assertJson('hard-deleted key not in revoked list', deletedInList, false);

	// Hard-delete the second revoked key (REVOKE_ID_2)
	const hardDel2 = await admin('DELETE', `/admin/keys/${REVOKE_ID_2}?permanent=true`);
	assertStatus('hard-delete second key -> 200', hardDel2, 200);

	// Hard-delete nonexistent -> 404
	const hardDelNone = await admin('DELETE', '/admin/keys/gw_00000000000000000000000000000000?permanent=true');
	assertStatus('hard-delete nonexistent -> 404', hardDelNone, 404);

	// Hard-delete an active key directly (create a throwaway)
	const { r: hdActive, keyId: HD_ACTIVE_ID } = await createKey('smoke-hard-del-active', ZONE, WILDCARD_POLICY);
	assertStatus('create key for hard-delete -> 200', hdActive, 200);
	const hardDelActive = await admin('DELETE', `/admin/keys/${HD_ACTIVE_ID}?permanent=true`);
	assertStatus('hard-delete active key -> 200', hardDelActive, 200);
	assertJson('active hard-delete has deleted:true', hardDelActive.body?.result?.deleted, true);
	// Remove from cleanup list since it's already gone
	const hdIdx = state.createdKeys.indexOf(HD_ACTIVE_ID);
	if (hdIdx >= 0) state.createdKeys.splice(hdIdx, 1);
}
