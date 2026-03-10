import { SELF, env, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
	adminHeaders,
	registerUpstreamToken,
	createKeyWithPolicy,
	wildcardPolicy,
	mockUpstreamSuccess,
	waitForAnalytics,
	cleanupCreatedResources,
	ZONE_ID,
} from './helpers';

// --- Setup ---

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	await registerUpstreamToken();
});

// ─── Purge timeseries ───────────────────────────────────────────────────────

describe('Purge analytics -- timeseries endpoint', () => {
	it('GET /admin/analytics/timeseries -> 200 with bucket array (with data)', async () => {
		// Create a key and make a purge request to generate at least one event
		const keyId = await createKeyWithPolicy(wildcardPolicy());
		mockUpstreamSuccess();

		const purgeRes = await SELF.fetch(`http://localhost/v1/zones/${ZONE_ID}/purge_cache`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${keyId}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ hosts: ['example.com'] }),
		});
		expect(purgeRes.status).toBe(200);

		await waitForAnalytics();

		// Fetch timeseries
		const res = await SELF.fetch('http://localhost/admin/analytics/timeseries', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(Array.isArray(data.result)).toBe(true);

		// Should have at least one bucket with count > 0
		const totalCount = data.result.reduce((s: number, b: any) => s + b.count, 0);
		expect(totalCount).toBeGreaterThan(0);

		// Each bucket should have correct shape
		for (const bucket of data.result) {
			expect(bucket).toHaveProperty('bucket');
			expect(bucket).toHaveProperty('count');
			expect(bucket).toHaveProperty('errors');
			expect(typeof bucket.bucket).toBe('number');
			expect(typeof bucket.count).toBe('number');
			expect(typeof bucket.errors).toBe('number');
			// Bucket should be aligned to hour boundaries (divisible by 3600000)
			expect(bucket.bucket % 3600000).toBe(0);
		}

		await cleanupCreatedResources();
	});

	it('GET /admin/analytics/timeseries?zone_id=... -> filters by zone', async () => {
		const res = await SELF.fetch(`http://localhost/admin/analytics/timeseries?zone_id=nonexistent_zone`, {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(Array.isArray(data.result)).toBe(true);
		// All counts should be 0 for a zone that has no events
		const totalCount = data.result.reduce((s: number, b: any) => s + b.count, 0);
		expect(totalCount).toBe(0);
	});

	it('GET /admin/analytics/timeseries?since=...&until=... -> time range', async () => {
		const now = Date.now();
		const hourAgo = now - 3600000;
		const res = await SELF.fetch(`http://localhost/admin/analytics/timeseries?since=${hourAgo}&until=${now}`, { headers: adminHeaders() });
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(Array.isArray(data.result)).toBe(true);
	});
});

// ─── S3 analytics timeseries ────────────────────────────────────────────────

describe('S3 analytics -- timeseries endpoint', () => {
	it('GET /admin/s3/analytics/timeseries -> 200 with bucket array', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/analytics/timeseries', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(Array.isArray(data.result)).toBe(true);
	});
});

// ─── DNS analytics timeseries ───────────────────────────────────────────────

describe('DNS analytics -- timeseries endpoint', () => {
	it('GET /admin/dns/analytics/timeseries -> 200 with bucket array', async () => {
		const res = await SELF.fetch('http://localhost/admin/dns/analytics/timeseries', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(Array.isArray(data.result)).toBe(true);
	});
});

// ─── CF proxy analytics timeseries ──────────────────────────────────────────

describe('CF proxy analytics -- timeseries endpoint', () => {
	it('GET /admin/cf/analytics/timeseries -> 200 with bucket array', async () => {
		const res = await SELF.fetch('http://localhost/admin/cf/analytics/timeseries', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(Array.isArray(data.result)).toBe(true);
	});
});

// ─── Auth: timeseries endpoints require admin key ───────────────────────────

describe('Timeseries endpoints -- authentication', () => {
	it('purge timeseries without admin key -> 401', async () => {
		const res = await SELF.fetch('http://localhost/admin/analytics/timeseries');
		expect(res.status).toBe(401);
	});

	it('S3 timeseries without admin key -> 401', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/analytics/timeseries');
		expect(res.status).toBe(401);
	});

	it('DNS timeseries without admin key -> 401', async () => {
		const res = await SELF.fetch('http://localhost/admin/dns/analytics/timeseries');
		expect(res.status).toBe(401);
	});

	it('CF proxy timeseries without admin key -> 401', async () => {
		const res = await SELF.fetch('http://localhost/admin/cf/analytics/timeseries');
		expect(res.status).toBe(401);
	});
});
