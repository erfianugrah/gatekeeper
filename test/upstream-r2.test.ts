import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { adminHeaders, ADMIN_KEY } from './helpers';

// --- Tests ---

describe('Upstream R2 — CRUD', () => {
	it('create -> list -> get -> delete -> verify gone (full lifecycle)', async () => {
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
		// No revoked field on upstream R2
		expect(createData.result.revoked).toBeUndefined();
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

		// --- Delete ---
		const delRes = await SELF.fetch(`http://localhost/admin/upstream-r2/${endpointId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(delRes.status).toBe(200);
		const delData = await delRes.json<any>();
		expect(delData.result.deleted).toBe(true);

		// --- Delete already-deleted -> 404 ---
		const delAgainRes = await SELF.fetch(`http://localhost/admin/upstream-r2/${endpointId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(delAgainRes.status).toBe(404);

		// --- Verify gone ---
		const getAfterRes = await SELF.fetch(`http://localhost/admin/upstream-r2/${endpointId}`, {
			headers: adminHeaders(),
		});
		expect(getAfterRes.status).toBe(404);
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

	it('delete nonexistent endpoint -> 404', async () => {
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

describe('Upstream R2 — bulk delete', () => {
	it('bulk-delete mix of existing and not-found', async () => {
		const c1 = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'bulk-d-1',
				access_key_id: 'EKIAIOSFODNN7EXAMPL1',
				secret_access_key: 'eJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKE1',
				endpoint: 'https://bulkd1.r2.cloudflarestorage.com',
				bucket_names: ['*'],
			}),
		});
		const e1 = (await c1.json<any>()).result.id;

		const c2 = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'bulk-d-2',
				access_key_id: 'EKIAIOSFODNN7EXAMPL2',
				secret_access_key: 'eJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKE2',
				endpoint: 'https://bulkd2.r2.cloudflarestorage.com',
				bucket_names: ['*'],
			}),
		});
		const e2 = (await c2.json<any>()).result.id;

		const res = await SELF.fetch('http://localhost/admin/upstream-r2/bulk-delete', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids: [e1, e2, 'upr2_doesnotexist00000'], confirm_count: 3 }),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.processed).toBe(3);

		const statuses = Object.fromEntries(data.result.results.map((r: any) => [r.id, r.status]));
		expect(statuses[e1]).toBe('deleted');
		expect(statuses[e2]).toBe('deleted');
		expect(statuses['upr2_doesnotexist00000']).toBe('not_found');

		// Endpoints should be gone
		const get1 = await SELF.fetch(`http://localhost/admin/upstream-r2/${e1}`, { headers: adminHeaders() });
		expect(get1.status).toBe(404);
	});

	it('bulk-delete dry_run returns preview without modifying', async () => {
		const c1 = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'bulk-dry-d-1',
				access_key_id: 'FKIAIOSFODNN7EXAMPL1',
				secret_access_key: 'fJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKE1',
				endpoint: 'https://bulkdryd1.r2.cloudflarestorage.com',
				bucket_names: ['*'],
			}),
		});
		const e1 = (await c1.json<any>()).result.id;

		const res = await SELF.fetch('http://localhost/admin/upstream-r2/bulk-delete', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids: [e1], confirm_count: 1, dry_run: true }),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.dry_run).toBe(true);
		expect(data.result.items[0].would_become).toBe('deleted');

		// Endpoint should still exist
		const getRes = await SELF.fetch(`http://localhost/admin/upstream-r2/${e1}`, { headers: adminHeaders() });
		expect(getRes.status).toBe(200);
	});

	it('bulk-delete rejects confirm_count mismatch', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2/bulk-delete', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids: ['upr2_a', 'upr2_b'], confirm_count: 5 }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/confirm_count/);
	});

	it('bulk-delete rejects empty array', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2/bulk-delete', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids: [], confirm_count: 0 }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/non-empty/);
	});

	it('bulk-delete rejects over 100 items', async () => {
		const ids = Array.from({ length: 101 }, (_, i) => `upr2_${String(i).padStart(24, '0')}`);
		const res = await SELF.fetch('http://localhost/admin/upstream-r2/bulk-delete', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ ids, confirm_count: 101 }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/100/);
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

// --- Upstream R2 validation (6.1) ---

const R2_VALIDATE_ENDPOINT = 'https://validate-r2.r2.cloudflarestorage.com';

describe('Upstream R2 — validate on registration', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('validate: true with valid credentials -> 200 with no warnings', async () => {
		fetchMock
			.get(R2_VALIDATE_ENDPOINT)
			.intercept({ method: 'GET', path: '/' })
			.reply(200, '<?xml version="1.0"?><ListAllMyBucketsResult></ListAllMyBucketsResult>', {
				headers: { 'Content-Type': 'application/xml' },
			});

		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'r2-validate-good',
				access_key_id: 'R2VALIDACCESSKEYID12345',
				secret_access_key: 'r2validsecretaccesskey1234567890abcdef1234567890abcdef1234567890ab',
				endpoint: R2_VALIDATE_ENDPOINT,
				bucket_names: ['*'],
				validate: true,
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.id).toMatch(/^upr2_/);
		expect(data.warnings).toBeUndefined();
	});

	it('validate: true with invalid credentials -> 200 with warnings (still registered)', async () => {
		fetchMock
			.get(R2_VALIDATE_ENDPOINT)
			.intercept({ method: 'GET', path: '/' })
			.reply(403, '<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>', {
				headers: { 'Content-Type': 'application/xml' },
			});

		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'r2-validate-bad',
				access_key_id: 'R2INVALIDACCESSKEYID1234',
				secret_access_key: 'r2invalidsecretaccesskey1234567890abcdef1234567890abcdef1234567890',
				endpoint: R2_VALIDATE_ENDPOINT,
				bucket_names: ['*'],
				validate: true,
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		// Credential is still registered despite validation failure
		expect(data.result.id).toMatch(/^upr2_/);
		expect(data.result.name).toBe('r2-validate-bad');
		// Warnings array present
		expect(data.warnings).toBeDefined();
		expect(data.warnings).toHaveLength(1);
		expect(data.warnings[0].code).toBe(422);
		expect(data.warnings[0].message).toMatch(/R2 credential validation failed/);
	});

	it('validate not set -> no validation probe, no warnings', async () => {
		// No fetchMock intercept — if validation fires, it would fail with disableNetConnect
		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'r2-no-validate',
				access_key_id: 'R2NOVALIDATEACCESSKEYID',
				secret_access_key: 'r2novalidatesecretaccesskey1234567890abcdef1234567890abcdef12345678',
				endpoint: 'https://novalidate.r2.cloudflarestorage.com',
				bucket_names: ['*'],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.warnings).toBeUndefined();
	});
});
