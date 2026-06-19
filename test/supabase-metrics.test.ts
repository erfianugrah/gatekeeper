import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { adminHeaders, waitForAnalytics, createSupabaseKey, registerSupabaseMetricsCredential, registerSupabaseToken, cleanupCreatedResources } from './helpers';

const REF = 'abcdefghijklmnopqrst';
const REF_B = 'zzzzzzzzzz0000000000';
const V = '2025-01-01' as const;

function metricsPolicy(ref: string) {
	return { version: V, statements: [{ effect: 'allow', actions: ['supabase:metrics:read'], resources: [`project:${ref}`] }] };
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());
afterAll(() => cleanupCreatedResources());

describe('supabase metrics proxy — auth and validation', () => {
	it('lets a metrics:read key scrape, swapping in Basic auth', async () => {
		const tid = await registerSupabaseMetricsCredential([REF], 'sb_secret_xyz');
		const key = await createSupabaseKey(metricsPolicy(REF), tid);

		fetchMock
			.get(`https://${REF}.supabase.co`)
			.intercept({ path: '/customer/v1/privileged/metrics', method: 'GET' })
			.reply(200, 'pg_stat_database_blks_hit 42', { headers: { 'Content-Type': 'text/plain' } });

		const res = await SELF.fetch(`https://gk/supabase/metrics/${REF}`, { headers: { Authorization: `Bearer ${key}` } });
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('pg_stat_database_blks_hit');
	});

	it('denies a metrics key from calling the Management API (no data access)', async () => {
		const tid = await registerSupabaseMetricsCredential([REF], 'sb_secret_xyz');
		const key = await createSupabaseKey(metricsPolicy(REF), tid);
		const res = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/database/query`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: 'select 1' }),
		});
		expect(res.status).toBe(403);
	});

	it('G15: no Authorization header → 401', async () => {
		const res = await SELF.fetch(`https://gk/supabase/metrics/${REF}`);
		expect(res.status).toBe(401);
		const body = await res.json<any>();
		expect(typeof body.message).toBe('string');
	});

	it('G16: empty Bearer value → 401', async () => {
		const res = await SELF.fetch(`https://gk/supabase/metrics/${REF}`, { headers: { Authorization: 'Bearer ' } });
		expect(res.status).toBe(401);
	});

	it('G17: invalid ref format → 400', async () => {
		const res = await SELF.fetch('https://gk/supabase/metrics/NOTAVALIDREF_TOO_LONG', {
			headers: { Authorization: 'Bearer gw_00000000000000000000000000000000' },
		});
		expect(res.status).toBe(400);
		const body = await res.json<any>();
		expect(body.message).toMatch(/invalid project ref/i);
	});

	it('G18: key scoped to REF_A is denied (403) when hitting metrics for REF_B', async () => {
		// Credential and key both cover only REF, not REF_B
		const tid = await registerSupabaseMetricsCredential([REF], 'sb_secret_other');
		const key = await createSupabaseKey(metricsPolicy(REF), tid);

		// Policy only allows project:REF — hitting REF_B should be denied at the auth layer
		const res = await SELF.fetch(`https://gk/supabase/metrics/${REF_B}`, { headers: { Authorization: `Bearer ${key}` } });
		expect(res.status).toBe(403);
		// Note: the 502 (no credential) path is covered by G22
	});

	it('G19: upstream 401 → client gets 401 (status passthrough)', async () => {
		const tid = await registerSupabaseMetricsCredential([REF], 'sb_secret_bad');
		const key = await createSupabaseKey(metricsPolicy(REF), tid);

		fetchMock
			.get(`https://${REF}.supabase.co`)
			.intercept({ path: '/customer/v1/privileged/metrics', method: 'GET' })
			.reply(401, JSON.stringify({ message: 'Unauthorized' }), { headers: { 'Content-Type': 'application/json' } });

		const res = await SELF.fetch(`https://gk/supabase/metrics/${REF}`, { headers: { Authorization: `Bearer ${key}` } });
		expect(res.status).toBe(401);
	});

	it('G20: upstream 429 + Retry-After forwarded to client', async () => {
		const tid = await registerSupabaseMetricsCredential([REF], 'sb_secret_rl');
		const key = await createSupabaseKey(metricsPolicy(REF), tid);

		fetchMock
			.get(`https://${REF}.supabase.co`)
			.intercept({ path: '/customer/v1/privileged/metrics', method: 'GET' })
			.reply(429, 'rate limited', { headers: { 'Retry-After': '30' } });

		const res = await SELF.fetch(`https://gk/supabase/metrics/${REF}`, { headers: { Authorization: `Bearer ${key}` } });
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBe('30');
	});

	it('G21: successful scrape writes an analytics row', async () => {
		const tid = await registerSupabaseMetricsCredential([REF], 'sb_secret_analytics');
		const key = await createSupabaseKey(metricsPolicy(REF), tid);

		fetchMock
			.get(`https://${REF}.supabase.co`)
			.intercept({ path: '/customer/v1/privileged/metrics', method: 'GET' })
			.reply(200, 'pg_up 1', { headers: { 'Content-Type': 'text/plain' } });

		await SELF.fetch(`https://gk/supabase/metrics/${REF}`, { headers: { Authorization: `Bearer ${key}` } });
		await waitForAnalytics();

		const evRes = await SELF.fetch(`https://gk/admin/supabase/analytics/events?project_ref=${REF}`, {
			headers: adminHeaders(),
		});
		expect(evRes.status).toBe(200);
		const data = await evRes.json<any>();
		expect(Array.isArray(data.result)).toBe(true);
		const hit = (data.result as any[]).some(
			(r) => r.action === 'supabase:metrics:read' && r.category === 'metrics' && r.status === 200,
		);
		expect(hit).toBe(true);
	});

	it('G22: PAT-scoped key with metrics:read policy hits /metrics/:ref → 502 (no metrics credential)', async () => {
		// Register a supabase PAT (not a metrics credential)
		const patTid = await registerSupabaseToken([REF], 'sbp_pat_not_metrics');
		const key = await createSupabaseKey(metricsPolicy(REF), patTid);

		// No supabase_metrics credential registered — resolveSupabaseMetricsCredential returns null
		const res = await SELF.fetch(`https://gk/supabase/metrics/${REF}`, { headers: { Authorization: `Bearer ${key}` } });
		expect(res.status).toBe(502);
	});
});
