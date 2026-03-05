import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, fetchMock } from 'cloudflare:test';
import { adminHeaders, ADMIN_KEY } from './helpers';

// --- Helpers ---

async function createS3Credential(
	policy: Record<string, unknown>,
	name = 'test-s3-cred',
	extra?: Record<string, unknown>,
) {
	const res = await SELF.fetch('http://localhost/admin/s3/credentials', {
		method: 'POST',
		headers: adminHeaders(),
		body: JSON.stringify({ name, policy, ...extra }),
	});
	return res;
}

function s3WildcardPolicy() {
	return {
		version: '2025-01-01',
		statements: [{ effect: 'allow', actions: ['s3:*'], resources: ['*'] }],
	};
}

function s3ReadOnlyPolicy(bucket: string) {
	return {
		version: '2025-01-01',
		statements: [{
			effect: 'allow',
			actions: ['s3:GetObject', 's3:ListBucket'],
			resources: [`bucket:${bucket}`, `object:${bucket}/*`],
		}],
	};
}

// --- Tests ---

describe('S3 credentials — CRUD', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
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
