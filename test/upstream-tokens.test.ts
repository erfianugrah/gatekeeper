import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { adminHeaders, ADMIN_KEY } from './helpers';

// --- Tests ---

describe('Upstream tokens — CRUD', () => {
	it('create -> list -> get -> revoke -> verify revoked (full lifecycle)', async () => {
		// --- Create ---
		const createRes = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'crud-test',
				token: 'cf-token-abcdef0123456789abcdef0123456789abcdef',
				zone_ids: ['*'],
			}),
		});
		expect(createRes.status).toBe(200);
		const createData = await createRes.json<any>();
		expect(createData.success).toBe(true);
		expect(createData.result.id).toMatch(/^upt_/);
		expect(createData.result.name).toBe('crud-test');
		expect(createData.result.zone_ids).toBe('*');
		// preview: first 4 + "..." + last 4 = "cf-t...cdef"
		expect(createData.result.token_preview).toMatch(/^.{4}\.\.\..{4}$/);
		expect(createData.result.revoked).toBe(0);
		expect(createData.result.created_at).toBeGreaterThan(0);
		// Secret must never appear in response
		expect(createData.result.token).toBeUndefined();
		const tokenId = createData.result.id;

		// --- List (includes created token) ---
		const listRes = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			headers: adminHeaders(),
		});
		expect(listRes.status).toBe(200);
		const listData = await listRes.json<any>();
		expect(listData.success).toBe(true);
		expect(Array.isArray(listData.result)).toBe(true);
		const found = listData.result.find((t: any) => t.id === tokenId);
		expect(found).toBeDefined();
		expect(found.name).toBe('crud-test');
		// Secret must never appear in list
		expect(found.token).toBeUndefined();

		// --- List with status=active ---
		const activeRes = await SELF.fetch('http://localhost/admin/upstream-tokens?status=active', {
			headers: adminHeaders(),
		});
		expect(activeRes.status).toBe(200);
		const activeData = await activeRes.json<any>();
		for (const t of activeData.result) {
			expect(t.revoked).toBe(0);
		}

		// --- Get by ID ---
		const getRes = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			headers: adminHeaders(),
		});
		expect(getRes.status).toBe(200);
		const getData = await getRes.json<any>();
		expect(getData.success).toBe(true);
		expect(getData.result.id).toBe(tokenId);
		expect(getData.result.name).toBe('crud-test');
		expect(getData.result.token).toBeUndefined();

		// --- Revoke ---
		const revokeRes = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(revokeRes.status).toBe(200);
		const revokeData = await revokeRes.json<any>();
		expect(revokeData.result.revoked).toBe(true);

		// --- Revoke already-revoked -> 404 ---
		const revokeAgainRes = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(revokeAgainRes.status).toBe(404);

		// --- List with status=revoked -> includes revoked token ---
		const revokedRes = await SELF.fetch('http://localhost/admin/upstream-tokens?status=revoked', {
			headers: adminHeaders(),
		});
		expect(revokedRes.status).toBe(200);
		const revokedData = await revokedRes.json<any>();
		const revokedFound = revokedData.result.find((t: any) => t.id === tokenId);
		expect(revokedFound).toBeDefined();
		expect(revokedFound.revoked).toBe(1);
	});

	it('create token with specific zone_ids -> comma-separated storage', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'multi-zone',
				token: 'cf-multi-zone-token-1234567890abcdef1234567890ab',
				zone_ids: ['zone-aaa', 'zone-bbb'],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.zone_ids).toBe('zone-aaa,zone-bbb');
	});

	it('get nonexistent token -> 404', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens/upt_does_not_exist', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(404);
	});

	it('revoke nonexistent token -> 404', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens/upt_does_not_exist', {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(res.status).toBe(404);
	});
});

describe('Upstream tokens — validation', () => {
	it('missing name -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				token: 'cf-token-abc123',
				zone_ids: ['*'],
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/name/i);
	});

	it('missing token -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'val-test',
				zone_ids: ['*'],
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/token/i);
	});

	it('missing zone_ids -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'val-test',
				token: 'cf-token-abc123',
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/zone_ids/i);
	});

	it('empty zone_ids array -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'val-test',
				token: 'cf-token-abc123',
				zone_ids: [],
			}),
		});
		expect(res.status).toBe(400);
	});

	it('zone_ids with non-string element -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'val-test',
				token: 'cf-token-abc123',
				zone_ids: [123],
			}),
		});
		expect(res.status).toBe(400);
	});

	it('invalid JSON body -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
			body: 'not json',
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/json/i);
	});

	it('numeric name -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 12345,
				token: 'cf-token-abc123',
				zone_ids: ['*'],
			}),
		});
		expect(res.status).toBe(400);
	});
});

describe('Upstream tokens — authentication', () => {
	it('no admin key -> 401', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens');
		expect(res.status).toBe(401);
	});

	it('wrong admin key -> 401', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			headers: { 'X-Admin-Key': 'wrong-key' },
		});
		expect(res.status).toBe(401);
	});

	it('create without admin key -> 401', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'test', token: 'abc', zone_ids: ['*'] }),
		});
		expect(res.status).toBe(401);
	});
});

describe('Upstream tokens — created_by', () => {
	it('created_by from request body when no Access identity', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'created-by-test',
				token: 'cf-token-createdby-test-1234567890abcdef1234567890',
				zone_ids: ['*'],
				created_by: 'test@example.com',
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.created_by).toBe('test@example.com');
	});
});
