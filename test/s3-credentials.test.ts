import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { SELF, fetchMock } from 'cloudflare:test';
import { s3WildcardPolicy, s3ReadOnlyPolicy } from './s3-helpers';
import { adminHeaders } from './helpers';

// --- Helpers ---

/** Access key IDs created by the local helper, for cleanup in afterAll. */
const localCreatedIds: string[] = [];

async function createS3Credential(policy: Record<string, unknown>, name = 'test-s3-cred', extra?: Record<string, unknown>) {
	const res = await SELF.fetch('http://localhost/admin/s3/credentials', {
		method: 'POST',
		headers: adminHeaders(),
		body: JSON.stringify({ name, policy, ...extra }),
	});
	if (res.status === 200) {
		const cloned = res.clone();
		const data = await cloned.json<any>();
		if (data.result?.credential?.access_key_id) {
			localCreatedIds.push(data.result.credential.access_key_id);
		}
	}
	return res;
}

afterAll(async () => {
	const ids = localCreatedIds.splice(0);
	await Promise.all(
		ids.map((id) =>
			SELF.fetch(`http://localhost/admin/s3/credentials/${id}?permanent=true`, {
				method: 'DELETE',
				headers: adminHeaders(),
			}),
		),
	);
});

// --- Tests ---

describe('S3 credentials — CRUD', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('create credential -> returns access_key_id and secret_access_key', async () => {
		const res = await createS3Credential(s3WildcardPolicy());
		expect(res.status).toBe(200);

		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.credential.access_key_id).toMatch(/^GK[0-9A-F]{18}$/);
		expect(data.result.credential.secret_access_key).toMatch(/^[0-9a-f]{64}$/);
		expect(data.result.credential.name).toBe('test-s3-cred');
		expect(data.result.credential.revoked).toBe(0);
	});

	it('create -> list -> get -> revoke lifecycle', async () => {
		// Create
		const createRes = await createS3Credential(s3ReadOnlyPolicy('my-assets'), 'lifecycle-cred');
		const createData = await createRes.json<any>();
		expect(createData.success).toBe(true);
		const accessKeyId = createData.result.credential.access_key_id;

		// List
		const listRes = await SELF.fetch('http://localhost/admin/s3/credentials', {
			headers: adminHeaders(),
		});
		const listData = await listRes.json<any>();
		expect(listData.success).toBe(true);
		expect(listData.result.length).toBeGreaterThanOrEqual(1);
		// Secret should be redacted in list
		const found = listData.result.find((c: any) => c.access_key_id === accessKeyId);
		expect(found).toBeTruthy();
		expect(found.secret_access_key).toBe('***');

		// Get
		const getRes = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}`, {
			headers: adminHeaders(),
		});
		const getData = await getRes.json<any>();
		expect(getData.success).toBe(true);
		expect(getData.result.credential.access_key_id).toBe(accessKeyId);
		expect(getData.result.credential.secret_access_key).toBe('***');

		// Revoke
		const revokeRes = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		const revokeData = await revokeRes.json<any>();
		expect(revokeData.success).toBe(true);
		expect(revokeData.result.revoked).toBe(true);

		// Verify revoked — double revoke returns 404
		const revokeRes2 = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(revokeRes2.status).toBe(404);
	});

	it('permanent delete removes the credential entirely', async () => {
		const createRes = await createS3Credential(s3WildcardPolicy(), 'delete-me');
		const accessKeyId = (await createRes.json<any>()).result.credential.access_key_id;

		// Permanent delete (active credential)
		const delRes = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}?permanent=true`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(delRes.status).toBe(200);
		expect((await delRes.json<any>()).result.deleted).toBe(true);

		// GET -> 404
		const getRes = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}`, { headers: adminHeaders() });
		expect(getRes.status).toBe(404);

		// Delete again -> 404
		const delAgain = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}?permanent=true`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(delAgain.status).toBe(404);
	});

	it('permanent delete works on already-revoked credentials', async () => {
		const createRes = await createS3Credential(s3WildcardPolicy(), 'revoke-then-delete');
		const accessKeyId = (await createRes.json<any>()).result.credential.access_key_id;

		// Revoke first
		await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}`, { method: 'DELETE', headers: adminHeaders() });

		// Permanent delete
		const delRes = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}?permanent=true`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(delRes.status).toBe(200);
		expect((await delRes.json<any>()).result.deleted).toBe(true);

		// Gone from list
		const listRes = await SELF.fetch('http://localhost/admin/s3/credentials', { headers: adminHeaders() });
		const creds = (await listRes.json<any>()).result;
		expect(creds.some((c: any) => c.access_key_id === accessKeyId)).toBe(false);
	});

	it('bulk-revoke mix of active, already-revoked, not-found', async () => {
		const res1 = await createS3Credential(s3WildcardPolicy(), 'bulk-r-1');
		const id1 = (await res1.json<any>()).result.credential.access_key_id;
		const res2 = await createS3Credential(s3WildcardPolicy(), 'bulk-r-2');
		const id2 = (await res2.json<any>()).result.credential.access_key_id;
		// Revoke id2 first
		await SELF.fetch(`http://localhost/admin/s3/credentials/${id2}`, { method: 'DELETE', headers: adminHeaders() });

		const res = await SELF.fetch('http://localhost/admin/s3/credentials/bulk-revoke', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				access_key_ids: [id1, id2, 'GK000000000000000000'],
				confirm_count: 3,
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.processed).toBe(3);

		const statuses = Object.fromEntries(data.result.results.map((r: any) => [r.id, r.status]));
		expect(statuses[id1]).toBe('revoked');
		expect(statuses[id2]).toBe('already_revoked');
		expect(statuses['GK000000000000000000']).toBe('not_found');
	});

	it('bulk-revoke dry_run returns preview without modifying', async () => {
		const res1 = await createS3Credential(s3WildcardPolicy(), 'bulk-dry-s3');
		const id1 = (await res1.json<any>()).result.credential.access_key_id;

		const res = await SELF.fetch('http://localhost/admin/s3/credentials/bulk-revoke', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ access_key_ids: [id1], confirm_count: 1, dry_run: true }),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.dry_run).toBe(true);
		expect(data.result.items[0].current_status).toBe('active');
		expect(data.result.items[0].would_become).toBe('revoked');

		// Credential should still be active
		const getRes = await SELF.fetch(`http://localhost/admin/s3/credentials/${id1}`, { headers: adminHeaders() });
		const getCred = await getRes.json<any>();
		expect(getCred.result.credential.revoked).toBe(0);
	});

	it('bulk-revoke rejects confirm_count mismatch', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/credentials/bulk-revoke', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ access_key_ids: ['GKa', 'GKb'], confirm_count: 5 }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/confirm_count/);
	});

	it('bulk-delete mix of existing and not-found', async () => {
		const res1 = await createS3Credential(s3WildcardPolicy(), 'bulk-d-s3-1');
		const id1 = (await res1.json<any>()).result.credential.access_key_id;
		const res2 = await createS3Credential(s3WildcardPolicy(), 'bulk-d-s3-2');
		const id2 = (await res2.json<any>()).result.credential.access_key_id;

		const res = await SELF.fetch('http://localhost/admin/s3/credentials/bulk-delete', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				access_key_ids: [id1, id2, 'GK000000000000000000'],
				confirm_count: 3,
			}),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.processed).toBe(3);

		const statuses = Object.fromEntries(data.result.results.map((r: any) => [r.id, r.status]));
		expect(statuses[id1]).toBe('deleted');
		expect(statuses[id2]).toBe('deleted');
		expect(statuses['GK000000000000000000']).toBe('not_found');

		// Both should be gone
		const get1 = await SELF.fetch(`http://localhost/admin/s3/credentials/${id1}`, { headers: adminHeaders() });
		expect(get1.status).toBe(404);
	});

	it('bulk-delete dry_run returns preview without modifying', async () => {
		const res1 = await createS3Credential(s3WildcardPolicy(), 'bulk-dry-d-s3');
		const id1 = (await res1.json<any>()).result.credential.access_key_id;

		const res = await SELF.fetch('http://localhost/admin/s3/credentials/bulk-delete', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ access_key_ids: [id1], confirm_count: 1, dry_run: true }),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.dry_run).toBe(true);
		expect(data.result.items[0].would_become).toBe('deleted');

		// Credential should still exist
		const getRes = await SELF.fetch(`http://localhost/admin/s3/credentials/${id1}`, { headers: adminHeaders() });
		expect(getRes.status).toBe(200);
	});

	it('get non-existent credential -> 404', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/credentials/GK000000000000000000', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(404);
	});

	it('create without name -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/credentials', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ policy: s3WildcardPolicy() }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/name/);
	});

	it('create without policy -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/credentials', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'test' }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/policy/);
	});

	it('create with invalid policy -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/credentials', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'test',
				policy: { version: 'wrong', statements: [] },
			}),
		});
		expect(res.status).toBe(400);
	});

	it('list with status=active filter', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/credentials?status=active', {
			headers: adminHeaders(),
		});
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		// All returned should not be revoked
		for (const cred of data.result) {
			expect(cred.revoked).toBe(0);
		}
	});

	it('requires admin auth', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/credentials', {
			headers: { 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(401);
	});

	it('create with expires_in_days sets expires_at', async () => {
		const res = await createS3Credential(s3WildcardPolicy(), 'expiring-cred', { expires_in_days: 7 });
		const data = await res.json<any>();
		expect(data.success).toBe(true);

		const cred = data.result.credential;
		expect(cred.expires_at).toBeTruthy();
		// Should expire roughly 7 days from now (within 1 minute tolerance)
		const sevenDaysMs = 7 * 86400_000;
		const diff = cred.expires_at - cred.created_at;
		expect(Math.abs(diff - sevenDaysMs)).toBeLessThan(60_000);
	});
});
