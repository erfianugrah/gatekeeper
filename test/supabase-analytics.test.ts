/**
 * Analytics tests for the Supabase proxy — mirrors s3-analytics.test.ts.
 *
 * Covers:
 *   - GET /admin/supabase/analytics/events
 *   - GET /admin/supabase/analytics/summary
 *   - GET /admin/supabase/analytics/timeseries
 *   - D1 event logging after a real proxy request
 *   - Filtering by project_ref, key_id, category, action, limit
 */

import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { adminHeaders, waitForAnalytics, registerSupabaseToken, createSupabaseKey, cleanupCreatedResources } from './helpers';
import type { PolicyDocument } from '../src/policy-types';

// Use a ref distinct from the other supabase test files to avoid cross-test pollution.
const REF = 'aabbccddee1122334455';
const SB_API = 'https://api.supabase.com';
const V = '2025-01-01' as const;

function dbReadPolicy(): PolicyDocument {
	return { version: V, statements: [{ effect: 'allow', actions: ['supabase:database:read'], resources: [`project:${REF}`] }] };
}

// Set up once: a wildcard PAT + a database:read key for event-generation tests.
let sharedTid: string;
let sharedKey: string;

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	sharedTid = await registerSupabaseToken([REF]);
	sharedKey = await createSupabaseKey(dbReadPolicy(), sharedTid, 'analytics-shared');
});
afterEach(() => fetchMock.assertNoPendingInterceptors());
afterAll(() => cleanupCreatedResources());

// ─── G36–G38: endpoint availability ─────────────────────────────────────────

describe('supabase analytics — endpoint availability', () => {
	it('G36: GET /admin/supabase/analytics/events → 200, success + array result', async () => {
		const res = await SELF.fetch('https://gk/admin/supabase/analytics/events', { headers: adminHeaders() });
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(Array.isArray(data.result)).toBe(true);
	});

	it('G37: GET /admin/supabase/analytics/summary → 200, correct summary shape', async () => {
		const res = await SELF.fetch('https://gk/admin/supabase/analytics/summary', { headers: adminHeaders() });
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(typeof data.result.total_requests).toBe('number');
		expect(typeof data.result.by_status).toBe('object');
		expect(typeof data.result.by_category).toBe('object');
		expect(typeof data.result.avg_duration_ms).toBe('number');
	});

	it('G38: all three analytics endpoints require admin key → 401 without it', async () => {
		const evRes = await SELF.fetch('https://gk/admin/supabase/analytics/events');
		expect(evRes.status).toBe(401);

		const sumRes = await SELF.fetch('https://gk/admin/supabase/analytics/summary');
		expect(sumRes.status).toBe(401);

		const tsRes = await SELF.fetch('https://gk/admin/supabase/analytics/timeseries');
		expect(tsRes.status).toBe(401);
	});
});

// ─── G39–G40: event logging ──────────────────────────────────────────────────

describe('supabase analytics — event logging', () => {
	it('G39: proxy request logs event with correct fields', async () => {
		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/config/database/postgres`, method: 'GET' })
			.reply(200, JSON.stringify({ pooler: {} }), { headers: { 'Content-Type': 'application/json' } });

		await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/database/postgres`, {
			headers: { Authorization: `Bearer ${sharedKey}` },
		});
		await waitForAnalytics();

		const res = await SELF.fetch(
			`https://gk/admin/supabase/analytics/events?project_ref=${REF}&action=supabase:database:read`,
			{ headers: adminHeaders() },
		);
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.length).toBeGreaterThanOrEqual(1);
		const row = (data.result as any[])[0];
		expect(row.key_id).toBeDefined();
		expect(row.project_ref).toBe(REF);
		expect(row.category).toBe('database');
		expect(row.action).toBe('supabase:database:read');
		expect(row.status).toBe(200);
		expect(typeof row.duration_ms).toBe('number');
		expect(row.duration_ms).toBeGreaterThanOrEqual(0);
		expect(typeof row.created_at).toBe('number');
		expect(row.created_at).toBeGreaterThan(0);
	});

	it('G40: summary aggregates category after requests', async () => {
		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/config/database/postgres`, method: 'GET' })
			.reply(200, '{}', { headers: { 'Content-Type': 'application/json' } });

		await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/database/postgres`, {
			headers: { Authorization: `Bearer ${sharedKey}` },
		});
		await waitForAnalytics();

		const res = await SELF.fetch(`https://gk/admin/supabase/analytics/summary?project_ref=${REF}`, { headers: adminHeaders() });
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.total_requests).toBeGreaterThanOrEqual(1);
		expect(typeof data.result.by_category).toBe('object');
		// database category should be present after a database:read request
		expect(data.result.by_category['database']).toBeGreaterThanOrEqual(1);
	});
});

// ─── G41–G43: filtering ──────────────────────────────────────────────────────

describe('supabase analytics — filtering', () => {
	it('G41: events filtered by project_ref only returns rows for that ref', async () => {
		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/config/database/postgres`, method: 'GET' })
			.reply(200, '{}', { headers: { 'Content-Type': 'application/json' } });

		await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/database/postgres`, {
			headers: { Authorization: `Bearer ${sharedKey}` },
		});
		await waitForAnalytics();

		const res = await SELF.fetch(`https://gk/admin/supabase/analytics/events?project_ref=${REF}`, { headers: adminHeaders() });
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		for (const row of data.result as any[]) {
			expect(row.project_ref).toBe(REF);
		}
	});

	it('G42: events filtered by key_id only returns rows for that key', async () => {
		// Create a second key to ensure we can isolate by key_id
		const tid2 = await registerSupabaseToken([REF]);
		const key2 = await createSupabaseKey(dbReadPolicy(), tid2, 'analytics-key2');

		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/config/database/postgres`, method: 'GET' })
			.reply(200, '{}', { headers: { 'Content-Type': 'application/json' } });

		await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/database/postgres`, {
			headers: { Authorization: `Bearer ${key2}` },
		});
		await waitForAnalytics();

		const res = await SELF.fetch(`https://gk/admin/supabase/analytics/events?key_id=${key2}`, { headers: adminHeaders() });
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.length).toBeGreaterThanOrEqual(1);
		for (const row of data.result as any[]) {
			expect(row.key_id).toBe(key2);
		}
	});

	it('G43: events respects limit=1 param', async () => {
		const res = await SELF.fetch('https://gk/admin/supabase/analytics/events?limit=1', { headers: adminHeaders() });
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect((data.result as any[]).length).toBeLessThanOrEqual(1);
	});
});

// ─── G44: timeseries ─────────────────────────────────────────────────────────

describe('supabase analytics — timeseries', () => {
	it('G44: timeseries returns array of bucket objects with correct shape', async () => {
		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/config/database/postgres`, method: 'GET' })
			.reply(200, '{}', { headers: { 'Content-Type': 'application/json' } });

		await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/database/postgres`, {
			headers: { Authorization: `Bearer ${sharedKey}` },
		});
		await waitForAnalytics();

		const res = await SELF.fetch(`https://gk/admin/supabase/analytics/timeseries?project_ref=${REF}`, { headers: adminHeaders() });
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(Array.isArray(data.result)).toBe(true);
		if ((data.result as any[]).length > 0) {
			const bucket = (data.result as any[])[0];
			expect(typeof bucket.bucket).toBe('number');
			expect(typeof bucket.count).toBe('number');
			expect(typeof bucket.errors).toBe('number');
		}
	});
});
