/**
 * Smoke tests — Config registry: GET / PUT / DELETE lifecycle.
 */

import type { SmokeContext } from './helpers.js';
import { admin, section, assertStatus, assertJson, assertTruthy } from './helpers.js';

export async function run(_ctx: SmokeContext): Promise<void> {
	section('Config Registry');

	// --- GET defaults ---

	const initial = await admin('GET', '/admin/config');
	assertStatus('GET /admin/config -> 200', initial, 200);
	assertTruthy('config has config object', initial.body?.result?.config);
	assertTruthy('config has defaults object', initial.body?.result?.defaults);
	assertTruthy('config has overrides object', typeof initial.body?.result?.overrides === 'object');
	assertTruthy('bulk_rate is a number', typeof initial.body?.result?.config?.bulk_rate === 'number');

	const defaultBulkRate = initial.body?.result?.defaults?.bulk_rate;
	assertTruthy('defaults.bulk_rate exists', defaultBulkRate > 0);

	// --- PUT override ---

	const putRes = await admin('PUT', '/admin/config', { bulk_rate: 99 });
	assertStatus('PUT /admin/config -> 200', putRes, 200);

	const afterPut = await admin('GET', '/admin/config');
	assertJson('bulk_rate overridden to 99', afterPut.body?.result?.config?.bulk_rate, 99);
	assertTruthy('overrides contains bulk_rate', afterPut.body?.result?.overrides?.bulk_rate !== undefined);
	assertJson('overrides.bulk_rate.value is 99', afterPut.body?.result?.overrides?.bulk_rate?.value, 99);

	// --- DELETE override (reset to default) ---

	const delRes = await admin('DELETE', '/admin/config/bulk_rate');
	assertStatus('DELETE /admin/config/bulk_rate -> 200', delRes, 200);

	const afterDel = await admin('GET', '/admin/config');
	assertJson('bulk_rate reset to default', afterDel.body?.result?.config?.bulk_rate, defaultBulkRate);
	assertJson('overrides no longer has bulk_rate', afterDel.body?.result?.overrides?.bulk_rate, undefined);

	// --- DELETE non-existent key -> 404 ---

	const delAgain = await admin('DELETE', '/admin/config/bulk_rate');
	assertStatus('DELETE already-reset key -> 404', delAgain, 404);

	// --- PUT validation ---

	const badPut = await admin('PUT', '/admin/config', { not_a_real_key: 42 });
	assertStatus('PUT unknown key -> 400', badPut, 400);

	const zeroPut = await admin('PUT', '/admin/config', { bulk_rate: 0 });
	assertStatus('PUT zero value -> 400', zeroPut, 400);

	const negativePut = await admin('PUT', '/admin/config', { bulk_rate: -5 });
	assertStatus('PUT negative value -> 400', negativePut, 400);
}
