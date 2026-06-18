import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { registerSupabaseToken, createSupabaseKey, adminHeaders, cleanupCreatedResources } from './helpers';
import type { PolicyDocument } from '../src/policy-types';

const REF = 'dewddkcmwrzbpynylyhg';
const V = '2025-01-01' as const;
const SB_API = 'https://api.supabase.com';

function policy(actions: string[], resources: string[] = [`project:${REF}`]): PolicyDocument {
	return { version: V, statements: [{ effect: 'allow', actions, resources }] };
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());
afterAll(() => cleanupCreatedResources());

describe('supabase management proxy RBAC', () => {
	it('allows database:read but denies database:write for a read-only key', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(policy(['supabase:database:read']), tid);

		// upstream mock for the allowed read (PAT swapped in)
		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/config/database/postgres`, method: 'GET' })
			.reply(200, JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });

		const ok = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/database/postgres`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(ok.status).toBe(200);

		// write must be denied at the gateway — no upstream call is made
		const denied = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/database/query`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: 'drop table users' }),
		});
		expect(denied.status).toBe(403);
	});

	it('forwards the request to the Supabase API with the stored PAT as Bearer', async () => {
		const tid = await registerSupabaseToken([REF], 'sbp_real_pat_value');
		const key = await createSupabaseKey(policy(['supabase:database:write']), tid);

		let seenAuth: string | undefined;
		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/database/query`, method: 'POST' })
			.reply((opts) => {
				seenAuth = (opts.headers as Record<string, string>)['authorization'] ?? (opts.headers as Record<string, string>)['Authorization'];
				return {
					statusCode: 201,
					data: JSON.stringify({ result: [] }),
					responseOptions: { headers: { 'Content-Type': 'application/json' } },
				};
			});

		const res = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/database/query`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: 'select 1' }),
		});
		expect(res.status).toBe(201);
		expect(seenAuth).toBe('Bearer sbp_real_pat_value');
	});

	it('rejects unauthenticated requests with 401', async () => {
		const res = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/auth`);
		expect(res.status).toBe(401);
	});

	it('returns 404 for unmapped paths even with a wildcard key', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(policy(['supabase:*'], [`project:${REF}`]), tid);
		const res = await SELF.fetch(`https://gk/supabase/v1/totally/unmapped`, { headers: { Authorization: `Bearer ${key}` } });
		expect(res.status).toBe(404);
	});

	it('scrapes the experimental v0 analytics metrics endpoint via the stored PAT (Bearer)', async () => {
		const tid = await registerSupabaseToken([REF], 'sbp_metrics_pat');
		const key = await createSupabaseKey(policy(['supabase:metrics:read']), tid);

		let seenAuth: string | undefined;
		fetchMock
			.get(SB_API)
			.intercept({ path: `/v0/projects/${REF}/analytics/metrics`, method: 'GET' })
			.reply((opts) => {
				seenAuth = (opts.headers as Record<string, string>)['authorization'] ?? (opts.headers as Record<string, string>)['Authorization'];
				return { statusCode: 200, data: 'pg_stat_database_blks_hit 42', responseOptions: { headers: { 'Content-Type': 'text/plain' } } };
			});

		const res = await SELF.fetch(`https://gk/supabase/v0/projects/${REF}/analytics/metrics`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(res.status).toBe(200);
		expect(seenAuth).toBe('Bearer sbp_metrics_pat');
		expect(await res.text()).toContain('pg_stat_database_blks_hit');
	});

	it('denies a database-only key from scraping the v0 metrics endpoint', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(policy(['supabase:database:read']), tid);
		const res = await SELF.fetch(`https://gk/supabase/v0/projects/${REF}/analytics/metrics`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(res.status).toBe(403);
	});

	it('records an analytics row for an allowed request', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(policy(['supabase:database:read']), tid);
		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/config/database/postgres`, method: 'GET' })
			.reply(200, JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });

		await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/database/postgres`, {
			headers: { Authorization: `Bearer ${key}` },
		});

		const analytics = await SELF.fetch(`https://gk/admin/supabase/analytics?project_ref=${REF}`, { headers: adminHeaders() });
		expect(analytics.status).toBe(200);
		const data = await analytics.json<any>();
		const rows = data.result ?? data.events ?? data;
		const hit = (Array.isArray(rows) ? rows : []).some((r: any) => r.action === 'supabase:database:read' && r.status === 200);
		expect(hit).toBe(true);
	});
});
