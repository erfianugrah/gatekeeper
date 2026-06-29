import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { queryMetering, METERING_DESCRIPTORS } from '../src/analytics-metering';

// Direct D1 inserts — exercises the engine without driving the proxy for all 5 surfaces.
async function seedSupabase(
	rows: Array<{
		key_id: string;
		key_fingerprint: string;
		project_ref: string;
		action: string;
		status: number;
		response_size: number | null;
		created_by: string;
		created_at: number;
	}>,
) {
	const db = env.ANALYTICS_DB;
	await db.batch([
		db.prepare(`CREATE TABLE IF NOT EXISTS supabase_proxy_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT, key_id TEXT NOT NULL, key_fingerprint TEXT, project_ref TEXT,
		category TEXT NOT NULL, action TEXT NOT NULL, status INTEGER NOT NULL, upstream_status INTEGER,
		duration_ms INTEGER NOT NULL, upstream_latency_ms INTEGER, response_size INTEGER, response_detail TEXT,
		created_by TEXT, created_at INTEGER NOT NULL)`),
	]);
	for (const r of rows) {
		await db
			.prepare(
				`INSERT INTO supabase_proxy_events (key_id, key_fingerprint, project_ref, category, action, status, duration_ms, response_size, created_by, created_at)
			VALUES (?, ?, ?, 'database', ?, ?, 5, ?, ?, ?)`,
			)
			.bind(r.key_id, r.key_fingerprint, r.project_ref, r.action, r.status, r.response_size, r.created_by, r.created_at)
			.run();
	}
}

describe('queryMetering — supabase surface', () => {
	beforeEach(async () => {
		await env.ANALYTICS_DB.prepare('DROP TABLE IF EXISTS supabase_proxy_events').run();
	});

	it('rolls up by project_ref with read/write split and egress sum', async () => {
		await seedSupabase([
			{
				key_id: 'gw_aaa...bbb',
				key_fingerprint: 'fp1',
				project_ref: 'projA',
				action: 'supabase:database:read',
				status: 200,
				response_size: 100,
				created_by: 'user-1',
				created_at: 1000,
			},
			{
				key_id: 'gw_aaa...bbb',
				key_fingerprint: 'fp1',
				project_ref: 'projA',
				action: 'supabase:database:write',
				status: 200,
				response_size: 50,
				created_by: 'user-1',
				created_at: 2000,
			},
			{
				key_id: 'gw_ccc...ddd',
				key_fingerprint: 'fp2',
				project_ref: 'projA',
				action: 'supabase:database:read',
				status: 500,
				response_size: null,
				created_by: 'user-1',
				created_at: 3000,
			},
			{
				key_id: 'gw_eee...fff',
				key_fingerprint: 'fp3',
				project_ref: 'projB',
				action: 'supabase:database:read',
				status: 200,
				response_size: 10,
				created_by: 'user-2',
				created_at: 4000,
			},
		]);

		const rows = await queryMetering(env.ANALYTICS_DB, 'supabase_proxy_events', { group_by: 'project' });
		const a = rows.find((r) => r.group_key === 'projA')!;
		expect(a.total_requests).toBe(3);
		expect(a.read_requests).toBe(2);
		expect(a.write_requests).toBe(1);
		expect(a.error_count).toBe(1);
		expect(a.error_rate_pct).toBeCloseTo(33.3, 1);
		expect(a.egress_bytes).toBe(150); // null response_size ignored by SUM
		expect(a.first_seen).toBe(1000);
		expect(a.last_seen).toBe(3000);
	});

	it('rolls up by tenant (created_by)', async () => {
		await seedSupabase([
			{
				key_id: 'gw_a...b',
				key_fingerprint: 'fp1',
				project_ref: 'projA',
				action: 'supabase:database:read',
				status: 200,
				response_size: 1,
				created_by: 'user-1',
				created_at: 1,
			},
			{
				key_id: 'gw_c...d',
				key_fingerprint: 'fp2',
				project_ref: 'projB',
				action: 'supabase:database:read',
				status: 200,
				response_size: 1,
				created_by: 'user-1',
				created_at: 2,
			},
		]);
		const rows = await queryMetering(env.ANALYTICS_DB, 'supabase_proxy_events', { group_by: 'tenant' });
		expect(rows).toHaveLength(1);
		expect(rows[0].group_key).toBe('user-1');
		expect(rows[0].total_requests).toBe(2);
	});

	it('throws on unknown table', async () => {
		await expect(queryMetering(env.ANALYTICS_DB, 'evil_events', {})).rejects.toThrow('Invalid metering table');
	});

	it('throws on unknown group_by for the surface', async () => {
		await expect(queryMetering(env.ANALYTICS_DB, 'supabase_proxy_events', { group_by: 'bucket' })).rejects.toThrow('Invalid group_by');
	});

	it('returns [] when the table does not exist yet', async () => {
		await env.ANALYTICS_DB.prepare('DROP TABLE IF EXISTS supabase_proxy_events').run();
		const rows = await queryMetering(env.ANALYTICS_DB, 'supabase_proxy_events', { group_by: 'tenant' });
		expect(rows).toEqual([]);
	});

	it('every descriptor exposes a tenant group key', () => {
		for (const d of Object.values(METERING_DESCRIPTORS)) {
			expect(d.groupable.tenant).toBe('created_by');
		}
	});
});
