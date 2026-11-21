import { SELF } from './cloudflare-test-compat';
import { describe, it, expect, beforeAll } from 'vitest';
import { adminHeaders } from './helpers';

// --- Tests ---

describe('Admin — config lifecycle', () => {
	it('GET -> PUT -> GET -> DELETE -> GET (full lifecycle)', async () => {
		// 1. GET defaults
		const getRes1 = await SELF.fetch('http://localhost/admin/config', {
			headers: adminHeaders(),
		});
		expect(getRes1.status).toBe(200);
		const getData1 = await getRes1.json<any>();
		expect(getData1.success).toBe(true);
		expect(getData1.result.config).toBeDefined();
		expect(getData1.result.defaults).toBeDefined();
		expect(getData1.result.overrides).toBeDefined();
		expect(getData1.result.defaults.bulk_rate).toBe(50);
		expect(getData1.result.defaults.single_rate).toBe(3000);
		expect(getData1.result.defaults.retention_days).toBe(30);
		expect(getData1.result.config.bulk_rate).toBeGreaterThan(0);

		// 2. PUT overrides
		const putRes = await SELF.fetch('http://localhost/admin/config', {
			method: 'PUT',
			headers: adminHeaders(),
			body: JSON.stringify({ bulk_rate: 75, single_rate: 5000 }),
		});
		expect(putRes.status).toBe(200);
		const putData = await putRes.json<any>();
		expect(putData.success).toBe(true);
		expect(putData.result.config.bulk_rate).toBe(75);
		expect(putData.result.config.single_rate).toBe(5000);

		// 3. GET reflects overrides
		const getRes2 = await SELF.fetch('http://localhost/admin/config', {
			headers: adminHeaders(),
		});
		const getData2 = await getRes2.json<any>();
		expect(getData2.result.config.bulk_rate).toBe(75);
		expect(getData2.result.config.single_rate).toBe(5000);
		const overrides = getData2.result.overrides as Array<{ key: string; value: string }>;
		expect(overrides.some((o) => o.key === 'bulk_rate' && o.value === '75')).toBe(true);
		expect(overrides.some((o) => o.key === 'single_rate' && o.value === '5000')).toBe(true);

		// 4. DELETE one override
		const delRes = await SELF.fetch('http://localhost/admin/config/bulk_rate', {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(delRes.status).toBe(200);
		const delData = await delRes.json<any>();
		expect(delData.success).toBe(true);
		expect(delData.result.config.bulk_rate).toBe(50); // reverted to default
		expect(delData.result.config.single_rate).toBe(5000); // still overridden

		// 5. DELETE same key again -> 404
		const delRes2 = await SELF.fetch('http://localhost/admin/config/bulk_rate', {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(delRes2.status).toBe(404);
	});
});

describe('Admin — config validation', () => {
	it('PUT rejects unknown keys', async () => {
		const res = await SELF.fetch('http://localhost/admin/config', {
			method: 'PUT',
			headers: adminHeaders(),
			body: JSON.stringify({ not_a_real_key: 42 }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toContain('Unknown config key');
	});

	it('PUT rejects non-positive values', async () => {
		const res = await SELF.fetch('http://localhost/admin/config', {
			method: 'PUT',
			headers: adminHeaders(),
			body: JSON.stringify({ bulk_rate: -1 }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toContain('positive finite number');
	});

	it('PUT rejects zero values', async () => {
		const res = await SELF.fetch('http://localhost/admin/config', {
			method: 'PUT',
			headers: adminHeaders(),
			body: JSON.stringify({ bulk_rate: 0 }),
		});
		expect(res.status).toBe(400);
	});

	it('PUT rejects string values', async () => {
		const res = await SELF.fetch('http://localhost/admin/config', {
			method: 'PUT',
			headers: adminHeaders(),
			body: JSON.stringify({ bulk_rate: 'fast' }),
		});
		expect(res.status).toBe(400);
	});

	it('PUT rejects empty body', async () => {
		const res = await SELF.fetch('http://localhost/admin/config', {
			method: 'PUT',
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toContain('at least one config key');
	});

	it('PUT rejects invalid JSON', async () => {
		const res = await SELF.fetch('http://localhost/admin/config', {
			method: 'PUT',
			headers: adminHeaders({ 'Content-Type': 'application/json' }),
			body: 'not json',
		});
		expect(res.status).toBe(400);
	});

	it('DELETE rejects unknown key', async () => {
		const res = await SELF.fetch('http://localhost/admin/config/nope', {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toContain('Unknown config key');
	});
});

describe('Admin — config auth', () => {
	it('GET rejects without admin key', async () => {
		const res = await SELF.fetch('http://localhost/admin/config');
		expect(res.status).toBe(401);
	});

	it('PUT rejects without admin key', async () => {
		const res = await SELF.fetch('http://localhost/admin/config', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ bulk_rate: 100 }),
		});
		expect(res.status).toBe(401);
	});

	it('DELETE rejects without admin key', async () => {
		const res = await SELF.fetch('http://localhost/admin/config/bulk_rate', {
			method: 'DELETE',
		});
		expect(res.status).toBe(401);
	});
});

describe('Admin — config affects purge classification', () => {
	it('low single_max_ops rejects oversized purge, resetting allows it', async () => {
		// Set single_max_ops=2
		const putRes = await SELF.fetch('http://localhost/admin/config', {
			method: 'PUT',
			headers: adminHeaders(),
			body: JSON.stringify({ single_max_ops: 2 }),
		});
		expect(putRes.status).toBe(200);

		// Try to purge 3 files — should be rejected
		const purgeRes1 = await SELF.fetch('http://localhost/v1/zones/aaaa1111bbbb2222cccc3333dddd4444/purge_cache', {
			method: 'POST',
			headers: { Authorization: 'Bearer fake-key-id', 'Content-Type': 'application/json' },
			body: JSON.stringify({ files: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'] }),
		});
		expect(purgeRes1.status).toBe(400);
		const data1 = await purgeRes1.json<any>();
		expect(data1.errors[0].message).toContain('max is 2');

		// Reset the override
		const delRes = await SELF.fetch('http://localhost/admin/config/single_max_ops', {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(delRes.status).toBe(200);

		// Now 3 files should pass classification (will fail at auth, not body validation)
		const purgeRes2 = await SELF.fetch('http://localhost/v1/zones/aaaa1111bbbb2222cccc3333dddd4444/purge_cache', {
			method: 'POST',
			headers: { Authorization: 'Bearer fake-key-id', 'Content-Type': 'application/json' },
			body: JSON.stringify({ files: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'] }),
		});
		// Should NOT be 400 for body validation — should fail at auth (401) instead
		expect(purgeRes2.status).not.toBe(400);
	});
});

describe('Admin — config bulk set', () => {
	it('can set all 8 config keys at once', async () => {
		const res = await SELF.fetch('http://localhost/admin/config', {
			method: 'PUT',
			headers: adminHeaders(),
			body: JSON.stringify({
				bulk_rate: 100,
				bulk_bucket_size: 1000,
				bulk_max_ops: 200,
				single_rate: 6000,
				single_bucket_size: 12000,
				single_max_ops: 1000,
				key_cache_ttl_ms: 120000,
				retention_days: 60,
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.config.bulk_rate).toBe(100);
		expect(data.result.config.bulk_bucket_size).toBe(1000);
		expect(data.result.config.bulk_max_ops).toBe(200);
		expect(data.result.config.single_rate).toBe(6000);
		expect(data.result.config.single_bucket_size).toBe(12000);
		expect(data.result.config.single_max_ops).toBe(1000);
		expect(data.result.config.key_cache_ttl_ms).toBe(120000);
		expect(data.result.config.retention_days).toBe(60);
	});
});
