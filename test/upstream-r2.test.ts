import { SELF, env, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
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
				validate: false,
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
				validate: false,
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
				validate: false,
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
				validate: false,
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
				validate: false,
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

// --- Upstream R2 validation (capability verification) ---

const R2_VALIDATE_ENDPOINT = 'https://validate-r2.r2.cloudflarestorage.com';

describe('Upstream R2 — validate on registration', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('valid credentials + wildcard buckets with accessible buckets -> no warnings', async () => {
		fetchMock
			.get(R2_VALIDATE_ENDPOINT)
			.intercept({ method: 'GET', path: '/' })
			.reply(
				200,
				'<?xml version="1.0"?><ListAllMyBucketsResult><Buckets><Bucket><Name>assets</Name></Bucket><Bucket><Name>media</Name></Bucket></Buckets></ListAllMyBucketsResult>',
				{ headers: { 'Content-Type': 'application/xml' } },
			);

		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'r2-validate-good',
				access_key_id: 'R2VALIDACCESSKEYID12345',
				secret_access_key: 'r2validsecretaccesskey1234567890abcdef1234567890abcdef1234567890ab',
				endpoint: R2_VALIDATE_ENDPOINT,
				bucket_names: ['*'],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.id).toMatch(/^upr2_/);
		expect(data.warnings).toBeUndefined();
	});

	it('valid credentials + specific buckets all accessible -> no warnings', async () => {
		fetchMock
			.get(R2_VALIDATE_ENDPOINT)
			.intercept({ method: 'GET', path: '/' })
			.reply(
				200,
				'<?xml version="1.0"?><ListAllMyBucketsResult><Buckets><Bucket><Name>assets</Name></Bucket><Bucket><Name>media</Name></Bucket></Buckets></ListAllMyBucketsResult>',
				{ headers: { 'Content-Type': 'application/xml' } },
			);

		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'r2-validate-specific-ok',
				access_key_id: 'R2SPECOKEYID123456789',
				secret_access_key: 'r2specoksecretaccesskey1234567890abcdef1234567890abcdef123456789',
				endpoint: R2_VALIDATE_ENDPOINT,
				bucket_names: ['assets', 'media'],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.warnings).toBeUndefined();
	});

	it('valid credentials + specific bucket not in accessible list -> warning per missing bucket', async () => {
		fetchMock
			.get(R2_VALIDATE_ENDPOINT)
			.intercept({ method: 'GET', path: '/' })
			.reply(
				200,
				'<?xml version="1.0"?><ListAllMyBucketsResult><Buckets><Bucket><Name>assets</Name></Bucket></Buckets></ListAllMyBucketsResult>',
				{ headers: { 'Content-Type': 'application/xml' } },
			);

		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'r2-validate-bucket-miss',
				access_key_id: 'R2MISSOKEYID123456789',
				secret_access_key: 'r2missoksecretaccesskey1234567890abcdef1234567890abcdef12345678',
				endpoint: R2_VALIDATE_ENDPOINT,
				bucket_names: ['assets', 'missing-bucket'],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.id).toMatch(/^upr2_/);
		expect(data.warnings).toHaveLength(1);
		expect(data.warnings[0].message).toMatch(/missing-bucket.*not found/);
	});

	it('invalid credentials (403) -> credential validation warning', async () => {
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
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.id).toMatch(/^upr2_/);
		expect(data.result.name).toBe('r2-validate-bad');
		expect(data.warnings).toHaveLength(1);
		expect(data.warnings[0].code).toBe(422);
		expect(data.warnings[0].message).toMatch(/R2 credential validation failed/);
	});

	it('wildcard buckets + 0 accessible -> warning', async () => {
		fetchMock
			.get(R2_VALIDATE_ENDPOINT)
			.intercept({ method: 'GET', path: '/' })
			.reply(200, '<?xml version="1.0"?><ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>', {
				headers: { 'Content-Type': 'application/xml' },
			});

		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'r2-validate-empty-wildcard',
				access_key_id: 'R2EMPTYWILDCAREYID1234',
				secret_access_key: 'r2emptywildcardsecretaccesskey1234567890abcdef1234567890abcdef123',
				endpoint: R2_VALIDATE_ENDPOINT,
				bucket_names: ['*'],
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.id).toMatch(/^upr2_/);
		expect(data.warnings).toHaveLength(1);
		expect(data.warnings[0].message).toMatch(/can access 0 buckets/);
	});

	it('validate: false -> skips all probes, no warnings', async () => {
		// No fetchMock intercept — if validation fires, disableNetConnect would fail
		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'r2-no-validate',
				access_key_id: 'R2NOVALIDATEACCESSKEYID',
				secret_access_key: 'r2novalidatesecretaccesskey1234567890abcdef1234567890abcdef12345678',
				endpoint: 'https://novalidate.r2.cloudflarestorage.com',
				bucket_names: ['*'],
				validate: false,
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.warnings).toBeUndefined();
	});
});

// --- Resolution logic (Fix #5 — ORDER BY created_at DESC, exact vs wildcard) ---

describe('Upstream R2 — resolution', () => {
	// --- Constants ---
	const BUCKET_ASSETS = 'assets';
	const BUCKET_MEDIA = 'media';
	const BUCKET_UNREGISTERED = 'unregistered-bucket';

	const ENDPOINT_EXACT = 'https://exact-acct.r2.cloudflarestorage.com';
	const ENDPOINT_WILDCARD = 'https://wildcard-acct.r2.cloudflarestorage.com';
	const ENDPOINT_NEWER = 'https://newer-acct.r2.cloudflarestorage.com';

	const AK_EXACT = 'EXACTACCESSKEYID12345';
	const SK_EXACT = 'exactsecretaccesskey1234567890abcdef1234567890abcdef1234567890abcd';
	const AK_WILDCARD = 'WILDCRDACCESSKEYID123';
	const SK_WILDCARD = 'wildcrdsecretaccesskey1234567890abcdef1234567890abcdef1234567890ab';
	const AK_NEWER = 'NEWERACCESSKEYID12345';
	const SK_NEWER = 'newersecretaccesskey1234567890abcdef1234567890abcdef1234567890abcd';

	/** Get the DO stub for direct RPC calls. */
	function getStub() {
		return env.GATEKEEPER.get(env.GATEKEEPER.idFromName('account'));
	}

	/** Register an upstream R2 endpoint and return its ID. */
	async function registerEndpoint(
		name: string,
		accessKeyId: string,
		secretAccessKey: string,
		endpoint: string,
		bucketNames: string[],
	): Promise<string> {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name,
				access_key_id: accessKeyId,
				secret_access_key: secretAccessKey,
				endpoint,
				bucket_names: bucketNames,
				validate: false,
			}),
		});
		const data = await res.json<any>();
		if (!data.success) throw new Error(`registerEndpoint failed: ${JSON.stringify(data.errors)}`);
		return data.result.id;
	}

	/** Delete an upstream R2 endpoint by ID. */
	async function deleteEndpoint(id: string): Promise<void> {
		await SELF.fetch(`http://localhost/admin/upstream-r2/${id}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
	}

	it('exact bucket match -> returns matching credentials', async () => {
		const id = await registerEndpoint('exact-bucket', AK_EXACT, SK_EXACT, ENDPOINT_EXACT, [BUCKET_ASSETS]);
		try {
			const resolved = await getStub().resolveR2ForBucket(BUCKET_ASSETS);
			expect(resolved).not.toBeNull();
			expect(resolved!.accessKeyId).toBe(AK_EXACT);
			expect(resolved!.endpoint).toBe(ENDPOINT_EXACT);
		} finally {
			await deleteEndpoint(id);
		}
	});

	it('wildcard endpoint -> returned for any bucket', async () => {
		const id = await registerEndpoint('wildcard-bucket', AK_WILDCARD, SK_WILDCARD, ENDPOINT_WILDCARD, ['*']);
		try {
			const resolved = await getStub().resolveR2ForBucket(BUCKET_MEDIA);
			expect(resolved).not.toBeNull();
			expect(resolved!.accessKeyId).toBe(AK_WILDCARD);
			expect(resolved!.endpoint).toBe(ENDPOINT_WILDCARD);
		} finally {
			await deleteEndpoint(id);
		}
	});

	it('exact match preferred over wildcard', async () => {
		const wcId = await registerEndpoint('res-wc', AK_WILDCARD, SK_WILDCARD, ENDPOINT_WILDCARD, ['*']);
		const exactId = await registerEndpoint('res-exact', AK_EXACT, SK_EXACT, ENDPOINT_EXACT, [BUCKET_ASSETS]);
		try {
			// BUCKET_ASSETS should resolve to the exact credentials
			const resolvedAssets = await getStub().resolveR2ForBucket(BUCKET_ASSETS);
			expect(resolvedAssets).not.toBeNull();
			expect(resolvedAssets!.accessKeyId).toBe(AK_EXACT);

			// BUCKET_MEDIA should fall back to the wildcard
			const resolvedMedia = await getStub().resolveR2ForBucket(BUCKET_MEDIA);
			expect(resolvedMedia).not.toBeNull();
			expect(resolvedMedia!.accessKeyId).toBe(AK_WILDCARD);
		} finally {
			await deleteEndpoint(exactId);
			await deleteEndpoint(wcId);
		}
	});

	it('newest endpoint wins when multiple claim the same bucket', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
			const olderId = await registerEndpoint('older', AK_EXACT, SK_EXACT, ENDPOINT_EXACT, [BUCKET_ASSETS]);

			vi.setSystemTime(new Date('2025-06-01T00:00:00Z'));
			const newerId = await registerEndpoint('newer', AK_NEWER, SK_NEWER, ENDPOINT_NEWER, [BUCKET_ASSETS]);

			const resolved = await getStub().resolveR2ForBucket(BUCKET_ASSETS);
			expect(resolved).not.toBeNull();
			expect(resolved!.accessKeyId).toBe(AK_NEWER);
			expect(resolved!.endpoint).toBe(ENDPOINT_NEWER);

			await deleteEndpoint(newerId);
			await deleteEndpoint(olderId);
		} finally {
			vi.useRealTimers();
		}
	});

	it('no match -> returns null', async () => {
		const resolved = await getStub().resolveR2ForBucket(BUCKET_UNREGISTERED);
		expect(resolved).toBeNull();
	});

	it('deleted endpoint -> no longer resolved', async () => {
		const id = await registerEndpoint('delete-resolve', AK_EXACT, SK_EXACT, ENDPOINT_EXACT, [BUCKET_ASSETS]);
		const before = await getStub().resolveR2ForBucket(BUCKET_ASSETS);
		expect(before).not.toBeNull();
		expect(before!.accessKeyId).toBe(AK_EXACT);

		await deleteEndpoint(id);
		const after = await getStub().resolveR2ForBucket(BUCKET_ASSETS);
		expect(after).toBeNull();
	});

	it('multi-bucket endpoint covers all listed buckets', async () => {
		const id = await registerEndpoint('multi-bucket', AK_EXACT, SK_EXACT, ENDPOINT_EXACT, [BUCKET_ASSETS, BUCKET_MEDIA]);
		try {
			expect((await getStub().resolveR2ForBucket(BUCKET_ASSETS))!.accessKeyId).toBe(AK_EXACT);
			expect((await getStub().resolveR2ForBucket(BUCKET_MEDIA))!.accessKeyId).toBe(AK_EXACT);
			expect(await getStub().resolveR2ForBucket(BUCKET_UNREGISTERED)).toBeNull();
		} finally {
			await deleteEndpoint(id);
		}
	});

	// --- resolveForListBuckets ---

	it('resolveForListBuckets prefers newest wildcard', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
			const oldWcId = await registerEndpoint('old-wc', AK_WILDCARD, SK_WILDCARD, ENDPOINT_WILDCARD, ['*']);

			vi.setSystemTime(new Date('2025-06-01T00:00:00Z'));
			const newWcId = await registerEndpoint('new-wc', AK_NEWER, SK_NEWER, ENDPOINT_NEWER, ['*']);

			const resolved = await getStub().resolveR2ForListBuckets();
			expect(resolved).not.toBeNull();
			// Newest wildcard should win (ORDER BY created_at DESC)
			expect(resolved!.accessKeyId).toBe(AK_NEWER);

			await deleteEndpoint(newWcId);
			await deleteEndpoint(oldWcId);
		} finally {
			vi.useRealTimers();
		}
	});

	it('resolveForListBuckets falls back to newest non-wildcard when no wildcard exists', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
			const olderId = await registerEndpoint('old-specific', AK_EXACT, SK_EXACT, ENDPOINT_EXACT, [BUCKET_ASSETS]);

			vi.setSystemTime(new Date('2025-06-01T00:00:00Z'));
			const newerId = await registerEndpoint('new-specific', AK_NEWER, SK_NEWER, ENDPOINT_NEWER, [BUCKET_MEDIA]);

			const resolved = await getStub().resolveR2ForListBuckets();
			expect(resolved).not.toBeNull();
			// Falls back to newest non-wildcard (first in DESC order)
			expect(resolved!.accessKeyId).toBe(AK_NEWER);

			await deleteEndpoint(newerId);
			await deleteEndpoint(olderId);
		} finally {
			vi.useRealTimers();
		}
	});

	it('resolveForListBuckets returns null when no endpoints exist', async () => {
		const resolved = await getStub().resolveR2ForListBuckets();
		expect(resolved).toBeNull();
	});
});
