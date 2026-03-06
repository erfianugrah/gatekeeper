import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { adminHeaders, ADMIN_KEY } from './helpers';

// --- Tests ---

describe('Upstream R2 — CRUD', () => {
	it('create -> list -> get -> revoke -> verify revoked (full lifecycle)', async () => {
		// --- Create ---
		const createRes = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'r2-crud-test',
				access_key_id: 'AKIAIOSFODNN7EXAMPLE',
				secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
				endpoint: 'https://account123.r2.cloudflarestorage.com',
				bucket_names: ['*'],
			}),
		});
		expect(createRes.status).toBe(200);
		const createData = await createRes.json<any>();
		expect(createData.success).toBe(true);
		expect(createData.result.id).toMatch(/^upr2_/);
		expect(createData.result.name).toBe('r2-crud-test');
		expect(createData.result.bucket_names).toBe('*');
		// preview: first 4 + "..." + last 4 = "AKIA...MPLE"
		expect(createData.result.access_key_preview).toMatch(/^.{4}\.\.\..{4}$/);
		expect(createData.result.endpoint).toBe('https://account123.r2.cloudflarestorage.com');
		expect(createData.result.revoked).toBe(0);
		// Secrets must never appear
		expect(createData.result.access_key_id).toBeUndefined();
		expect(createData.result.secret_access_key).toBeUndefined();
		const endpointId = createData.result.id;

		// --- List (includes created endpoint) ---
		const listRes = await SELF.fetch('http://localhost/admin/upstream-r2', {
			headers: adminHeaders(),
		});
		expect(listRes.status).toBe(200);
		const listData = await listRes.json<any>();
		expect(listData.success).toBe(true);
		expect(Array.isArray(listData.result)).toBe(true);
		const found = listData.result.find((e: any) => e.id === endpointId);
		expect(found).toBeDefined();
		expect(found.name).toBe('r2-crud-test');
		// Secrets never in list
		expect(found.access_key_id).toBeUndefined();
		expect(found.secret_access_key).toBeUndefined();

		// --- List with status=active ---
		const activeRes = await SELF.fetch('http://localhost/admin/upstream-r2?status=active', {
			headers: adminHeaders(),
		});
		expect(activeRes.status).toBe(200);
		const activeData = await activeRes.json<any>();
		for (const ep of activeData.result) {
			expect(ep.revoked).toBe(0);
		}

		// --- Get by ID ---
		const getRes = await SELF.fetch(`http://localhost/admin/upstream-r2/${endpointId}`, {
			headers: adminHeaders(),
		});
		expect(getRes.status).toBe(200);
		const getData = await getRes.json<any>();
		expect(getData.success).toBe(true);
		expect(getData.result.id).toBe(endpointId);
		expect(getData.result.name).toBe('r2-crud-test');
		expect(getData.result.access_key_id).toBeUndefined();
		expect(getData.result.secret_access_key).toBeUndefined();

		// --- Revoke ---
		const revokeRes = await SELF.fetch(`http://localhost/admin/upstream-r2/${endpointId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(revokeRes.status).toBe(200);
		const revokeData = await revokeRes.json<any>();
		expect(revokeData.result.revoked).toBe(true);

		// --- Revoke already-revoked -> 404 ---
		const revokeAgainRes = await SELF.fetch(`http://localhost/admin/upstream-r2/${endpointId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(revokeAgainRes.status).toBe(404);

		// --- List with status=revoked -> includes revoked endpoint ---
		const revokedRes = await SELF.fetch('http://localhost/admin/upstream-r2?status=revoked', {
			headers: adminHeaders(),
		});
		expect(revokedRes.status).toBe(200);
		const revokedData = await revokedRes.json<any>();
		const revokedFound = revokedData.result.find((e: any) => e.id === endpointId);
		expect(revokedFound).toBeDefined();
		expect(revokedFound.revoked).toBe(1);
	});

	it('create with specific bucket names -> comma-separated storage', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'r2-multi-bucket',
				access_key_id: 'BKIAIOSFODNN7EXAMPLE',
				secret_access_key: 'xJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
				endpoint: 'https://account456.r2.cloudflarestorage.com',
				bucket_names: ['vault', 'videos', 'images'],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.bucket_names).toBe('vault,videos,images');
	});

	it('get nonexistent endpoint -> 404', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2/upr2_does_not_exist', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(404);
	});

	it('revoke nonexistent endpoint -> 404', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2/upr2_does_not_exist', {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(res.status).toBe(404);
	});
});

describe('Upstream R2 — validation', () => {
	it('missing name -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				access_key_id: 'AKID',
				secret_access_key: 'SAK',
				endpoint: 'https://r2.example.com',
				bucket_names: ['*'],
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/name/i);
	});

	it('missing access_key_id -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'test',
				secret_access_key: 'SAK',
				endpoint: 'https://r2.example.com',
				bucket_names: ['*'],
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/access_key_id/i);
	});

	it('missing secret_access_key -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'test',
				access_key_id: 'AKID',
				endpoint: 'https://r2.example.com',
				bucket_names: ['*'],
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/secret_access_key/i);
	});

	it('missing endpoint -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'test',
				access_key_id: 'AKID',
				secret_access_key: 'SAK',
				bucket_names: ['*'],
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/endpoint/i);
	});

	it('missing bucket_names -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'test',
				access_key_id: 'AKID',
				secret_access_key: 'SAK',
				endpoint: 'https://r2.example.com',
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/bucket_names/i);
	});

	it('empty bucket_names array -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'test',
				access_key_id: 'AKID',
				secret_access_key: 'SAK',
				endpoint: 'https://r2.example.com',
				bucket_names: [],
			}),
		});
		expect(res.status).toBe(400);
	});

	it('invalid JSON body -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
			body: 'not json',
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/json/i);
	});
});

describe('Upstream R2 — authentication', () => {
	it('no admin key -> 401', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2');
		expect(res.status).toBe(401);
	});

	it('wrong admin key -> 401', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			headers: { 'X-Admin-Key': 'wrong-key' },
		});
		expect(res.status).toBe(401);
	});

	it('create without admin key -> 401', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'test',
				access_key_id: 'AKID',
				secret_access_key: 'SAK',
				endpoint: 'https://r2.example.com',
				bucket_names: ['*'],
			}),
		});
		expect(res.status).toBe(401);
	});
});
