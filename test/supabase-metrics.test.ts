import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createSupabaseKey, registerSupabaseMetricsCredential, cleanupCreatedResources } from './helpers';

const REF = 'abcdefghijklmnopqrst';
const V = '2025-01-01' as const;

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());
afterAll(() => cleanupCreatedResources());

describe('supabase metrics proxy', () => {
	it('lets a metrics:read key scrape, swapping in Basic auth', async () => {
		const tid = await registerSupabaseMetricsCredential([REF], 'sb_secret_xyz');
		const key = await createSupabaseKey(
			{ version: V, statements: [{ effect: 'allow', actions: ['supabase:metrics:read'], resources: [`project:${REF}`] }] },
			tid,
		);

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
		const key = await createSupabaseKey(
			{ version: V, statements: [{ effect: 'allow', actions: ['supabase:metrics:read'], resources: [`project:${REF}`] }] },
			tid,
		);
		const res = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/database/query`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: 'select 1' }),
		});
		expect(res.status).toBe(403);
	});
});
