/**
 * Smoke tests — section 13: Analytics.
 */

import type { SmokeContext } from './helpers.js';
import { admin, section, assertStatus, assertJson, assertTruthy, sleep } from './helpers.js';

export async function run(ctx: SmokeContext): Promise<void> {
	const { ZONE, WILDCARD_ID } = ctx;

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
}
