/**
 * Smoke tests for the audit log endpoint.
 *
 * These run AFTER the admin/key/s3/config sections so there are audit events to query.
 */

import { section, admin, assertStatus, assertTruthy, assertJson } from './helpers.js';
import type { SmokeContext } from './helpers.js';

export async function run(_ctx: SmokeContext): Promise<void> {
	section('Audit Log');

	// --- Query all audit events (should have at least one from key creation) ---
	const allEvents = await admin('GET', '/admin/audit/events?limit=50');
	assertStatus('GET /admin/audit/events -> 200', allEvents, 200);
	const events = allEvents.body?.result as any[];
	assertTruthy('audit events array is populated', events && events.length > 0);

	// --- Verify event shape ---
	if (events && events.length > 0) {
		const first = events[0];
		assertTruthy('event has action field', typeof first.action === 'string');
		assertTruthy('event has actor field', typeof first.actor === 'string');
		assertTruthy('event has entity_type field', typeof first.entity_type === 'string');
		assertTruthy('event has created_at field', typeof first.created_at === 'number');
	}

	// --- Filter by entity_type ---
	const keyEvents = await admin('GET', '/admin/audit/events?entity_type=key&limit=10');
	assertStatus('filter by entity_type=key -> 200', keyEvents, 200);
	const keyResults = keyEvents.body?.result as any[];
	assertTruthy('key events found', keyResults && keyResults.length > 0);
	if (keyResults && keyResults.length > 0) {
		assertJson(
			'all filtered events are entity_type=key',
			keyResults.every((e: any) => e.entity_type === 'key'),
			true,
		);
	}

	// --- Filter by action ---
	const createEvents = await admin('GET', '/admin/audit/events?action=create_key&limit=10');
	assertStatus('filter by action=create_key -> 200', createEvents, 200);
	const createResults = createEvents.body?.result as any[];
	assertTruthy('create_key events found', createResults && createResults.length > 0);
	if (createResults && createResults.length > 0) {
		assertJson(
			'all filtered events are action=create_key',
			createResults.every((e: any) => e.action === 'create_key'),
			true,
		);
		assertTruthy('create_key event has entity_id', typeof createResults[0].entity_id === 'string');
		assertTruthy('create_key event has detail', typeof createResults[0].detail === 'string');
	}

	// --- Filter by actor ---
	const actorEvents = await admin('GET', '/admin/audit/events?actor=via+admin+key&limit=10');
	assertStatus('filter by actor -> 200', actorEvents, 200);

	// --- Time range filter ---
	const since = Date.now() - 60_000; // last 60 seconds
	const recentEvents = await admin('GET', `/admin/audit/events?since=${since}&limit=5`);
	assertStatus('filter by since -> 200', recentEvents, 200);

	// --- Limit works ---
	const limitEvents = await admin('GET', '/admin/audit/events?limit=1');
	assertStatus('limit=1 -> 200', limitEvents, 200);
	const limitResults = limitEvents.body?.result as any[];
	assertJson('limit=1 returns at most 1 event', limitResults.length <= 1, true);

	// --- 503 when ANALYTICS_DB not bound is not testable in smoke (always bound) ---
	// --- Just verify the endpoint works under normal conditions ---

	// --- Verify upstream_token events exist ---
	const tokenEvents = await admin('GET', '/admin/audit/events?entity_type=upstream_token&limit=5');
	assertStatus('filter by entity_type=upstream_token -> 200', tokenEvents, 200);
	assertTruthy('upstream_token events found', (tokenEvents.body?.result as any[])?.length > 0);

	// --- Verify config events exist (from config smoke tests) ---
	const configEvents = await admin('GET', '/admin/audit/events?entity_type=config&limit=5');
	assertStatus('filter by entity_type=config -> 200', configEvents, 200);
	// Config events may or may not exist depending on test order — just check endpoint works
}
