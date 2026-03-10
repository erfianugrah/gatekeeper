import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import {
	ZONE_ID,
	adminHeaders,
	createKeyWithPolicy,
	wildcardPolicy,
	hostPolicy,
	cleanupCreatedResources,
	registerUpstreamToken,
	getZoneTokenId,
	__testClearInflightCache,
} from './helpers';

// --- Setup ---

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	await registerUpstreamToken();
});

beforeEach(() => {
	__testClearInflightCache();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

afterAll(async () => {
	await cleanupCreatedResources();
});

// --- Key Rotation ---

describe('Key Rotation — POST /admin/keys/:id/rotate', () => {
	it('rotates a key -> new key created, old revoked', async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy(), 'rotate-test');

		const res = await SELF.fetch(`http://localhost/admin/keys/${keyId}/rotate`, {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		const data = await res.json<any>();

		expect(res.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.result.old_key.id).toBe(keyId);
		expect(data.result.old_key.revoked).toBe(1);
		expect(data.result.new_key.id).not.toBe(keyId);
		expect(data.result.new_key.id).toMatch(/^gw_/);
		expect(data.result.new_key.revoked).toBe(0);
		expect(data.result.new_key.name).toBe('rotate-test (rotated)');
		expect(data.result.new_key.zone_id).toBe(ZONE_ID);
		expect(data.result.new_key.upstream_token_id).toBe(getZoneTokenId());
	});

	it('rotates with custom name and expiry', async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy(), 'custom-rotate');

		const res = await SELF.fetch(`http://localhost/admin/keys/${keyId}/rotate`, {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'my-new-key', expires_in_days: 30 }),
		});
		const data = await res.json<any>();

		expect(res.status).toBe(200);
		expect(data.result.new_key.name).toBe('my-new-key');
		expect(data.result.new_key.expires_at).toBeGreaterThan(Date.now());
	});

	it('cannot rotate a revoked key', async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy(), 'revoked-rotate');

		// Revoke the key first
		await SELF.fetch(`http://localhost/admin/keys/${keyId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});

		const res = await SELF.fetch(`http://localhost/admin/keys/${keyId}/rotate`, {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(404);
	});

	it('cannot rotate a nonexistent key', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys/gw_0000000000000000/rotate', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(404);
	});

	it('preserves rate limit config during rotation', async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy(), 'rate-limit-rotate', {
			rate_limit: { bulk_rate: 5, bulk_bucket: 10 },
		});

		const res = await SELF.fetch(`http://localhost/admin/keys/${keyId}/rotate`, {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		const data = await res.json<any>();

		expect(res.status).toBe(200);
		expect(data.result.new_key.bulk_rate).toBe(5);
		expect(data.result.new_key.bulk_bucket).toBe(10);
	});

	it('preserves policy during rotation', async () => {
		const policy = hostPolicy('cdn.example.com');
		const keyId = await createKeyWithPolicy(policy, 'policy-rotate');

		const res = await SELF.fetch(`http://localhost/admin/keys/${keyId}/rotate`, {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		const data = await res.json<any>();

		const newPolicy = JSON.parse(data.result.new_key.policy);
		expect(newPolicy.statements[0].actions).toEqual(['purge:host']);
		expect(newPolicy.statements[0].conditions[0].field).toBe('host');
		expect(newPolicy.statements[0].conditions[0].value).toBe('cdn.example.com');
	});
});

// --- Key Update ---

describe('Key Update — PATCH /admin/keys/:id', () => {
	it('updates name', async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy(), 'old-name');

		const res = await SELF.fetch(`http://localhost/admin/keys/${keyId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'new-name' }),
		});
		const data = await res.json<any>();

		expect(res.status).toBe(200);
		expect(data.result.key.name).toBe('new-name');
		expect(data.result.key.id).toBe(keyId);
	});

	it('updates expires_at', async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy(), 'expiry-update');
		const newExpiry = Date.now() + 90 * 24 * 60 * 60 * 1000; // 90 days

		const res = await SELF.fetch(`http://localhost/admin/keys/${keyId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ expires_at: newExpiry }),
		});
		const data = await res.json<any>();

		expect(res.status).toBe(200);
		expect(data.result.key.expires_at).toBe(newExpiry);
	});

	it('removes expiry by setting null', async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy(), 'remove-expiry', {
			expires_in_days: 30,
		});

		const res = await SELF.fetch(`http://localhost/admin/keys/${keyId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ expires_at: null }),
		});
		const data = await res.json<any>();

		expect(res.status).toBe(200);
		expect(data.result.key.expires_at).toBeNull();
	});

	it('updates rate limits', async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy(), 'rate-update');

		const res = await SELF.fetch(`http://localhost/admin/keys/${keyId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ rate_limit: { bulk_rate: 10, single_rate: 100 } }),
		});
		const data = await res.json<any>();

		expect(res.status).toBe(200);
		expect(data.result.key.bulk_rate).toBe(10);
		expect(data.result.key.single_rate).toBe(100);
	});

	it('clears rate limits by setting null', async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy(), 'clear-rate', {
			rate_limit: { bulk_rate: 5, single_rate: 50 },
		});

		const res = await SELF.fetch(`http://localhost/admin/keys/${keyId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ rate_limit: { bulk_rate: null, single_rate: null } }),
		});
		const data = await res.json<any>();

		expect(res.status).toBe(200);
		expect(data.result.key.bulk_rate).toBeNull();
		expect(data.result.key.single_rate).toBeNull();
	});

	it('rejects update on revoked key', async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy(), 'revoked-update');

		await SELF.fetch(`http://localhost/admin/keys/${keyId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});

		const res = await SELF.fetch(`http://localhost/admin/keys/${keyId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'nope' }),
		});
		expect(res.status).toBe(404);
	});

	it('rejects update with no fields', async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy(), 'empty-update');

		const res = await SELF.fetch(`http://localhost/admin/keys/${keyId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it('rejects update on nonexistent key', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys/gw_0000000000000000', {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'nope' }),
		});
		expect(res.status).toBe(404);
	});

	it('updates multiple fields at once', async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy(), 'multi-update');
		const newExpiry = Date.now() + 60 * 24 * 60 * 60 * 1000;

		const res = await SELF.fetch(`http://localhost/admin/keys/${keyId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'updated-name',
				expires_at: newExpiry,
				rate_limit: { bulk_rate: 20 },
			}),
		});
		const data = await res.json<any>();

		expect(res.status).toBe(200);
		expect(data.result.key.name).toBe('updated-name');
		expect(data.result.key.expires_at).toBe(newExpiry);
		expect(data.result.key.bulk_rate).toBe(20);
	});
});

// --- Referential Integrity ---

describe('Referential Integrity — upstream token delete warns about bound keys', () => {
	it('returns warning when deleting upstream token with bound keys', async () => {
		// Create a dedicated upstream token
		const tokenRes = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'ref-integrity-test',
				token: 'cf-ref-test-token-1234',
				zone_ids: ['*'],
			}),
		});
		const tokenData = await tokenRes.json<any>();
		const tokenId = tokenData.result.id;

		// Create a key bound to that token
		await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'bound-key',
				zone_id: ZONE_ID,
				upstream_token_id: tokenId,
				policy: wildcardPolicy(),
			}),
		});

		// Delete the upstream token — should get a warning
		const deleteRes = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		const deleteData = await deleteRes.json<any>();

		expect(deleteRes.status).toBe(200);
		expect(deleteData.success).toBe(true);
		expect(deleteData.result.deleted).toBe(true);
		expect(deleteData.warnings).toBeDefined();
		expect(deleteData.warnings.length).toBe(1);
		expect(deleteData.warnings[0].type).toBe('orphaned_keys');
		expect(deleteData.warnings[0].message).toContain('active API key');
	});

	it('no warning when upstream token has no bound keys', async () => {
		// Create a dedicated upstream token with no keys
		const tokenRes = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'no-keys-token',
				token: 'cf-nokeys-test-token-5678',
				zone_ids: ['*'],
			}),
		});
		const tokenData = await tokenRes.json<any>();
		const tokenId = tokenData.result.id;

		// Delete immediately — should have no warnings
		const deleteRes = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		const deleteData = await deleteRes.json<any>();

		expect(deleteRes.status).toBe(200);
		expect(deleteData.success).toBe(true);
		expect(deleteData.warnings).toBeUndefined();
	});
});
