import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest';
import { ZONE_ID, adminHeaders, createKeyWithPolicy, hostPolicy, wildcardPolicy, __testClearInflightCache } from './helpers';

// --- Setup ---

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

beforeEach(() => {
	__testClearInflightCache();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

// --- Tests ---

describe('Admin — authentication', () => {
	it('rejects requests without admin key', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'x', zone_id: ZONE_ID, policy: wildcardPolicy() }),
		});
		expect(res.status).toBe(401);
	});

	it('rejects requests with wrong admin key', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: { 'X-Admin-Key': 'wrong-key', 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'x', zone_id: ZONE_ID, policy: wildcardPolicy() }),
		});
		expect(res.status).toBe(401);
	});
});

describe('Admin — key lifecycle', () => {
	it('create -> list -> get -> revoke -> verify revoked', async () => {
		// Create
		const createRes = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'lifecycle-key',
				zone_id: ZONE_ID,
				policy: hostPolicy('example.com'),
			}),
		});
		expect(createRes.status).toBe(200);
		const createData = await createRes.json<any>();
		expect(createData.success).toBe(true);
		const keyId = createData.result.key.id;
		expect(keyId).toMatch(/^gw_/);

		// List
		const listRes = await SELF.fetch(`http://localhost/admin/keys?zone_id=${ZONE_ID}`, { headers: adminHeaders() });
		expect(listRes.status).toBe(200);
		const listData = await listRes.json<any>();
		expect(listData.result.some((k: any) => k.id === keyId)).toBe(true);

		// Get
		const getRes = await SELF.fetch(`http://localhost/admin/keys/${keyId}?zone_id=${ZONE_ID}`, { headers: adminHeaders() });
		expect(getRes.status).toBe(200);
		const getData = await getRes.json<any>();
		expect(getData.result.key.id).toBe(keyId);
		expect(getData.result.key.policy).toBeTruthy();

		// Revoke
		const revokeRes = await SELF.fetch(`http://localhost/admin/keys/${keyId}?zone_id=${ZONE_ID}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(revokeRes.status).toBe(200);
		const revokeData = await revokeRes.json<any>();
		expect(revokeData.result.revoked).toBe(true);

		// Revoke again -> 404
		const revokeAgainRes = await SELF.fetch(`http://localhost/admin/keys/${keyId}?zone_id=${ZONE_ID}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(revokeAgainRes.status).toBe(404);
	});

	it('permanent delete removes the key entirely', async () => {
		// Create
		const createRes = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'delete-me', zone_id: ZONE_ID, policy: wildcardPolicy() }),
		});
		const keyId = (await createRes.json<any>()).result.key.id;

		// Permanent delete (active key)
		const delRes = await SELF.fetch(`http://localhost/admin/keys/${keyId}?zone_id=${ZONE_ID}&permanent=true`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(delRes.status).toBe(200);
		const delData = await delRes.json<any>();
		expect(delData.result.deleted).toBe(true);

		// GET -> 404 (key is gone)
		const getRes = await SELF.fetch(`http://localhost/admin/keys/${keyId}`, { headers: adminHeaders() });
		expect(getRes.status).toBe(404);

		// Delete again -> 404
		const delAgain = await SELF.fetch(`http://localhost/admin/keys/${keyId}?permanent=true`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(delAgain.status).toBe(404);
	});

	it('permanent delete works on already-revoked keys', async () => {
		// Create + revoke
		const createRes = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'revoke-then-delete', zone_id: ZONE_ID, policy: wildcardPolicy() }),
		});
		const keyId = (await createRes.json<any>()).result.key.id;

		await SELF.fetch(`http://localhost/admin/keys/${keyId}`, { method: 'DELETE', headers: adminHeaders() });

		// Permanent delete the revoked key
		const delRes = await SELF.fetch(`http://localhost/admin/keys/${keyId}?permanent=true`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(delRes.status).toBe(200);
		expect((await delRes.json<any>()).result.deleted).toBe(true);

		// Gone from list
		const listRes = await SELF.fetch(`http://localhost/admin/keys?zone_id=${ZONE_ID}`, { headers: adminHeaders() });
		const keys = (await listRes.json<any>()).result;
		expect(keys.some((k: any) => k.id === keyId)).toBe(false);
	});
});

describe('Admin — validation', () => {
	it('rejects create with missing fields', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'no-zone' }),
		});
		expect(res.status).toBe(400);
	});

	it('rejects create without policy', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'no-policy', zone_id: ZONE_ID }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/policy/i);
	});

	it('rejects invalid policy: missing version', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'bad-policy',
				zone_id: ZONE_ID,
				policy: {
					statements: [{ effect: 'allow', actions: ['*'], resources: ['*'] }],
				},
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors.some((e: any) => e.message.includes('version'))).toBe(true);
	});

	it('rejects invalid policy: empty statements', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'empty-stmts',
				zone_id: ZONE_ID,
				policy: { version: '2025-01-01', statements: [] },
			}),
		});
		expect(res.status).toBe(400);
	});

	it('rejects invalid policy: dangerous regex', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'bad-regex',
				zone_id: ZONE_ID,
				policy: {
					version: '2025-01-01',
					statements: [
						{
							effect: 'allow',
							actions: ['purge:*'],
							resources: ['zone:*'],
							conditions: [{ field: 'tag', operator: 'matches', value: '(a+)+$' }],
						},
					],
				},
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors.some((e: any) => e.message.includes('catastrophic'))).toBe(true);
	});
});

describe('Admin — bulk revoke', () => {
	it('bulk-revoke mix of active, already-revoked, not-found', async () => {
		const key1 = await createKeyWithPolicy(wildcardPolicy(), 'bulk-r-1');
		const key2 = await createKeyWithPolicy(wildcardPolicy(), 'bulk-r-2');
		// Revoke key2 first
		await SELF.fetch(`http://localhost/admin/keys/${key2}`, { method: 'DELETE', headers: adminHeaders() });

		const res = await SELF.fetch('http://localhost/admin/keys/bulk-revoke', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				ids: [key1, key2, 'gw_doesnotexist0000000000000000'],
				confirm_count: 3,
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.processed).toBe(3);

		const statuses = Object.fromEntries(data.result.results.map((r: any) => [r.id, r.status]));
		expect(statuses[key1]).toBe('revoked');
		expect(statuses[key2]).toBe('already_revoked');
		expect(statuses['gw_doesnotexist0000000000000000']).toBe('not_found');
	});

	it('bulk-revoke dry_run returns preview without modifying', async () => {
		const key1 = await createKeyWithPolicy(wildcardPolicy(), 'bulk-dry-1');

		const res = await SELF.fetch('http://localhost/admin/keys/bulk-revoke', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids: [key1], confirm_count: 1, dry_run: true }),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.dry_run).toBe(true);
		expect(data.result.items[0].current_status).toBe('active');
		expect(data.result.items[0].would_become).toBe('revoked');

		// Key should still be active
		const getRes = await SELF.fetch(`http://localhost/admin/keys/${key1}`, { headers: adminHeaders() });
		const getKey = await getRes.json<any>();
		expect(getKey.result.key.revoked).toBe(0);
	});

	it('bulk-revoke rejects confirm_count mismatch', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys/bulk-revoke', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids: ['gw_a', 'gw_b'], confirm_count: 5 }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/confirm_count/);
	});

	it('bulk-revoke rejects empty array', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys/bulk-revoke', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids: [], confirm_count: 0 }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/non-empty/);
	});

	it('bulk-revoke rejects over 100 items', async () => {
		const ids = Array.from({ length: 101 }, (_, i) => `gw_${String(i).padStart(30, '0')}`);
		const res = await SELF.fetch('http://localhost/admin/keys/bulk-revoke', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids, confirm_count: 101 }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/100/);
	});
});

describe('Admin — bulk delete', () => {
	it('bulk-delete mix of existing and not-found', async () => {
		const key1 = await createKeyWithPolicy(wildcardPolicy(), 'bulk-d-1');
		const key2 = await createKeyWithPolicy(wildcardPolicy(), 'bulk-d-2');

		const res = await SELF.fetch('http://localhost/admin/keys/bulk-delete', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				ids: [key1, key2, 'gw_doesnotexist0000000000000000'],
				confirm_count: 3,
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.processed).toBe(3);

		const statuses = Object.fromEntries(data.result.results.map((r: any) => [r.id, r.status]));
		expect(statuses[key1]).toBe('deleted');
		expect(statuses[key2]).toBe('deleted');
		expect(statuses['gw_doesnotexist0000000000000000']).toBe('not_found');

		// Keys should be gone
		const get1 = await SELF.fetch(`http://localhost/admin/keys/${key1}`, { headers: adminHeaders() });
		expect(get1.status).toBe(404);
		const get2 = await SELF.fetch(`http://localhost/admin/keys/${key2}`, { headers: adminHeaders() });
		expect(get2.status).toBe(404);
	});

	it('bulk-delete dry_run returns preview without modifying', async () => {
		const key1 = await createKeyWithPolicy(wildcardPolicy(), 'bulk-dry-d-1');

		const res = await SELF.fetch('http://localhost/admin/keys/bulk-delete', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids: [key1], confirm_count: 1, dry_run: true }),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.dry_run).toBe(true);
		expect(data.result.items[0].would_become).toBe('deleted');

		// Key should still exist
		const getRes = await SELF.fetch(`http://localhost/admin/keys/${key1}`, { headers: adminHeaders() });
		expect(getRes.status).toBe(200);
	});

	it('bulk-delete can delete already-revoked keys', async () => {
		const key1 = await createKeyWithPolicy(wildcardPolicy(), 'bulk-revoked-d-1');
		// Revoke first
		await SELF.fetch(`http://localhost/admin/keys/${key1}`, { method: 'DELETE', headers: adminHeaders() });

		const res = await SELF.fetch('http://localhost/admin/keys/bulk-delete', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids: [key1], confirm_count: 1 }),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.results[0].status).toBe('deleted');

		// Gone
		const getRes = await SELF.fetch(`http://localhost/admin/keys/${key1}`, { headers: adminHeaders() });
		expect(getRes.status).toBe(404);
	});
});

describe('Admin — edge cases', () => {
	it('get nonexistent key returns 404', async () => {
		const res = await SELF.fetch(`http://localhost/admin/keys/gw_doesnotexist0000000000000000?zone_id=${ZONE_ID}`, {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(404);
	});

	it('get key with wrong zone_id returns 404', async () => {
		const keyId = await createKeyWithPolicy(hostPolicy('example.com'));
		const res = await SELF.fetch(`http://localhost/admin/keys/${keyId}?zone_id=bbbb2222cccc3333dddd4444eeee5555`, {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(404);
	});

	it('revoke key with wrong zone_id returns 404 and key is untouched', async () => {
		const keyId = await createKeyWithPolicy(hostPolicy('example.com'));
		const res = await SELF.fetch(`http://localhost/admin/keys/${keyId}?zone_id=bbbb2222cccc3333dddd4444eeee5555`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(res.status).toBe(404);

		const getRes = await SELF.fetch(`http://localhost/admin/keys/${keyId}?zone_id=${ZONE_ID}`, { headers: adminHeaders() });
		expect(getRes.status).toBe(200);
		const data = await getRes.json<any>();
		expect(data.result.key.revoked).toBe(0);
	});

	it('list keys without zone_id -> returns all keys', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(Array.isArray(data.result)).toBe(true);
	});
});

// --- Zone ID validation on admin endpoints ---

describe('Admin — zone_id validation', () => {
	it('create key with invalid zone_id -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'bad-zone-key',
				zone_id: 'NOT-A-VALID-ZONE!',
				policy: wildcardPolicy(),
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.success).toBe(false);
	});

	it('create key with short zone_id -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'short-zone-key',
				zone_id: 'abc123',
				policy: wildcardPolicy(),
			}),
		});
		expect(res.status).toBe(400);
	});

	it('list keys with invalid zone_id -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys?zone_id=ZZZZ-invalid', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(400);
	});

	it('delete key with invalid zone_id -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys/gw_fake1234567890abcdef12345678?zone_id=not-hex!!', {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(res.status).toBe(400);
	});

	it('list keys with valid zone_id -> 200', async () => {
		const res = await SELF.fetch(`http://localhost/admin/keys?zone_id=${ZONE_ID}`, {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
	});
});
