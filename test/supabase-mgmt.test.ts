import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { adminHeaders, waitForAnalytics, registerSupabaseToken, createSupabaseKey, cleanupCreatedResources } from './helpers';
import type { PolicyDocument } from '../src/policy-types';

const REF = 'dewddkcmwrzbpynylyhg';
const REF_B = 'bbbbbbbbbbbbbbbbbbbb';
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

		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/config/database/postgres`, method: 'GET' })
			.reply(200, JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });

		const ok = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/database/postgres`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(ok.status).toBe(200);

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
				return { statusCode: 201, data: JSON.stringify({ result: [] }), responseOptions: { headers: { 'Content-Type': 'application/json' } } };
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

		await waitForAnalytics();

		const analytics = await SELF.fetch(`https://gk/admin/supabase/analytics/events?project_ref=${REF}`, {
			headers: adminHeaders(),
		});
		expect(analytics.status).toBe(200);
		const data = await analytics.json<any>();
		const hit = (Array.isArray(data.result) ? (data.result as any[]) : []).some(
			(r: any) => r.action === 'supabase:database:read' && r.status === 200,
		);
		expect(hit).toBe(true);

		// Timeseries endpoint returns bucketed counts.
		const ts = await SELF.fetch(`https://gk/admin/supabase/analytics/timeseries?project_ref=${REF}`, { headers: adminHeaders() });
		expect(ts.status).toBe(200);
		const tsData = await ts.json<any>();
		expect(Array.isArray(tsData.result)).toBe(true);
	});
});

describe('supabase management proxy — classifier edge cases', () => {
	it('G23: invalid ref format in path → 404 from classifier', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(policy(['supabase:*'], [`project:${REF}`]), tid);
		const res = await SELF.fetch('https://gk/supabase/v1/projects/NOT_A_REAL_REF/database/query', {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(res.status).toBe(404);
	});

	it('G28: query string forwarded to upstream', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(policy(['supabase:secrets:read']), tid);

		let seenPath: string | undefined;
		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/secrets?format=json`, method: 'GET' })
			.reply((opts) => {
				seenPath = opts.path as string;
				return { statusCode: 200, data: '[]', responseOptions: { headers: { 'Content-Type': 'application/json' } } };
			});

		const res = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/secrets?format=json`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(res.status).toBe(200);
		expect(seenPath).toContain('format=json');
	});

	it('G29: POST network-bans/retrieve (read-override) allowed by read-only key → 200', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(policy(['supabase:projects:read']), tid);

		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/network-bans/retrieve`, method: 'POST' })
			.reply(200, '[]', { headers: { 'Content-Type': 'application/json' } });

		const res = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/network-bans/retrieve`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
	});

	it('G33: Content-Type from upstream forwarded unchanged', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(policy(['supabase:database:read']), tid);

		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/config/database/postgres`, method: 'GET' })
			.reply(200, 'plain text body', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

		const res = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/database/postgres`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(res.headers.get('Content-Type')).toMatch(/text\/plain/);
	});

	it('G27: upstream 204 No Content → client gets 204 with no Content-Type injection', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(policy(['supabase:edge_functions:write']), tid);

		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/functions/my-fn`, method: 'DELETE' })
			.reply(204);

		const res = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/functions/my-fn`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(res.status).toBe(204);
		// No content-type should be injected for a 204
		expect(res.headers.get('Content-Type')).toBeNull();
	});

	it('G26: upstream 429 + Retry-After forwarded', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(policy(['supabase:database:read']), tid);

		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/config/database/postgres`, method: 'GET' })
			.reply(429, JSON.stringify({ message: 'rate limited' }), {
				headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
			});

		const res = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/database/postgres`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBe('60');
	});
});

describe('supabase management proxy — resource scoping', () => {
	it('G24: account-level endpoint with wildcard PAT → 200, PAT forwarded', async () => {
		const tid = await registerSupabaseToken(['*'], 'sbp_wildcard_pat');
		const key = await createSupabaseKey(
			{ version: V, statements: [{ effect: 'allow', actions: ['supabase:projects:read'], resources: ['supabase:account'] }] },
			tid,
		);

		let seenAuth: string | undefined;
		fetchMock
			.get(SB_API)
			.intercept({ path: '/v1/projects', method: 'GET' })
			.reply((opts) => {
				seenAuth = (opts.headers as Record<string, string>)['authorization'] ?? (opts.headers as Record<string, string>)['Authorization'];
				return { statusCode: 200, data: '[]', responseOptions: { headers: { 'Content-Type': 'application/json' } } };
			});

		const res = await SELF.fetch('https://gk/supabase/v1/projects', { headers: { Authorization: `Bearer ${key}` } });
		expect(res.status).toBe(200);
		expect(seenAuth).toBe('Bearer sbp_wildcard_pat');
	});

	it('G25: account-level endpoint with project-specific PAT only → 502', async () => {
		// PAT only covers the specific ref, not '*'
		const tid = await registerSupabaseToken([REF], 'sbp_project_only');
		const key = await createSupabaseKey(
			{ version: V, statements: [{ effect: 'allow', actions: ['supabase:projects:read'], resources: ['supabase:account'] }] },
			tid,
		);

		// GET /v1/projects is account-level → resolveSupabaseToken('*') → null → 502
		const res = await SELF.fetch('https://gk/supabase/v1/projects', { headers: { Authorization: `Bearer ${key}` } });
		expect(res.status).toBe(502);
	});

	it('G30: supabase:account resource covers GET /v1/projects listing', async () => {
		const tid = await registerSupabaseToken(['*']);
		const key = await createSupabaseKey(
			{ version: V, statements: [{ effect: 'allow', actions: ['supabase:projects:read'], resources: ['supabase:account'] }] },
			tid,
		);

		fetchMock
			.get(SB_API)
			.intercept({ path: '/v1/projects', method: 'GET' })
			.reply(200, '[]', { headers: { 'Content-Type': 'application/json' } });

		const res = await SELF.fetch('https://gk/supabase/v1/projects', { headers: { Authorization: `Bearer ${key}` } });
		expect(res.status).toBe(200);
	});
});

describe('supabase management proxy — analytics', () => {
	it('G31: denied request (403) generates no analytics row', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(policy(['supabase:database:read']), tid, 'analytics-denied-test');

		// Write request denied at gateway — no upstream call
		const res = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/database/query`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: 'drop table users' }),
		});
		expect(res.status).toBe(403);

		await waitForAnalytics();

		// Filter by this test's own key_id (unique) — a denied request writes NO event, so this key
		// should have zero rows. Filtering by action would collide with other tests' write events.
		const evRes = await SELF.fetch(`https://gk/admin/supabase/analytics/events?key_id=${key}`, {
			headers: adminHeaders(),
		});
		expect(evRes.status).toBe(200);
		const data = await evRes.json<any>();
		expect(data.result).toEqual([]);
	});

	it('G32: analytics event has correct fields', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(policy(['supabase:database:read']), tid, 'analytics-fields-test');

		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/config/database/postgres`, method: 'GET' })
			.reply(200, JSON.stringify({ pooler: {} }), { headers: { 'Content-Type': 'application/json' } });

		await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/database/postgres`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		await waitForAnalytics();

		// Filter by this test's own key_id so result[0] is deterministically this request's event.
		const evRes = await SELF.fetch(`https://gk/admin/supabase/analytics/events?key_id=${key}`, {
			headers: adminHeaders(),
		});
		expect(evRes.status).toBe(200);
		const data = await evRes.json<any>();
		expect(Array.isArray(data.result)).toBe(true);
		expect(data.result.length).toBeGreaterThanOrEqual(1);
		const row = (data.result as any[])[0];
		expect(row.key_id).toBe(key);
		expect(row.project_ref).toBe(REF);
		expect(row.category).toBe('database');
		expect(row.action).toBe('supabase:database:read');
		expect(row.status).toBe(200);
		expect(typeof row.duration_ms).toBe('number');
		expect(row.duration_ms).toBeGreaterThanOrEqual(0);
	});
});

describe('supabase management proxy — condition engine', () => {
	it('G34: supabase.write=false condition allows GET but blocks POST on the same action group', async () => {
		const tid = await registerSupabaseToken([REF]);
		const key = await createSupabaseKey(
			{
				version: V,
				statements: [
					{
						effect: 'allow',
						actions: ['supabase:*'],
						resources: [`project:${REF}`, 'supabase:account'],
						conditions: [{ field: 'supabase.write', operator: 'eq', value: false }],
					},
				],
			},
			tid,
		);

		// GET config/auth → write:false → condition satisfied → allowed
		fetchMock
			.get(SB_API)
			.intercept({ path: `/v1/projects/${REF}/config/auth`, method: 'GET' })
			.reply(200, '{}', { headers: { 'Content-Type': 'application/json' } });

		const getRes = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/config/auth`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		expect(getRes.status).toBe(200);

		// POST database/query → write:true → condition fails → 403
		const postRes = await SELF.fetch(`https://gk/supabase/v1/projects/${REF}/database/query`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: 'select 1' }),
		});
		expect(postRes.status).toBe(403);
	});
});
