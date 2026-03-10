import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { adminHeaders, __testClearInflightCache } from './helpers';
import {
	registerUpstreamR2,
	createCredential,
	cleanupCreatedS3Resources,
	getR2EndpointId,
	s3WildcardPolicy,
	s3ReadOnlyPolicy,
} from './s3-helpers';

// --- Setup ---

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	await registerUpstreamR2();
});

beforeEach(() => {
	__testClearInflightCache();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

afterAll(async () => {
	await cleanupCreatedS3Resources();
});

// --- S3 Credential Rotation ---

describe('S3 Credential Rotation — POST /admin/s3/credentials/:id/rotate', () => {
	it('rotates a credential -> new created, old revoked', async () => {
		const { accessKeyId } = await createCredential(s3WildcardPolicy(), 'rotate-cred');

		const res = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}/rotate`, {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		const data = await res.json<any>();

		expect(res.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.result.old_credential.access_key_id).toBe(accessKeyId);
		expect(data.result.old_credential.revoked).toBe(1);
		expect(data.result.old_credential.secret_access_key).toBe('***'); // redacted
		expect(data.result.new_credential.access_key_id).not.toBe(accessKeyId);
		expect(data.result.new_credential.access_key_id).toMatch(/^GK/);
		expect(data.result.new_credential.name).toBe('rotate-cred (rotated)');
		expect(data.result.new_credential.secret_access_key).not.toBe('***'); // new secret visible
		expect(data.result.new_credential.upstream_token_id).toBe(getR2EndpointId());
	});

	it('rotates with custom name and expiry', async () => {
		const { accessKeyId } = await createCredential(s3WildcardPolicy(), 'custom-rotate-cred');

		const res = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}/rotate`, {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'new-cred-name', expires_in_days: 60 }),
		});
		const data = await res.json<any>();

		expect(res.status).toBe(200);
		expect(data.result.new_credential.name).toBe('new-cred-name');
		expect(data.result.new_credential.expires_at).toBeGreaterThan(Date.now());
	});

	it('cannot rotate a revoked credential', async () => {
		const { accessKeyId } = await createCredential(s3WildcardPolicy(), 'revoked-rotate-cred');

		// Revoke first
		await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});

		const res = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}/rotate`, {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(404);
	});

	it('cannot rotate nonexistent credential', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/credentials/GK000000000000000000/rotate', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(404);
	});

	it('preserves policy during rotation', async () => {
		const policy = s3ReadOnlyPolicy('my-bucket');
		const { accessKeyId } = await createCredential(policy, 'policy-rotate-cred');

		const res = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}/rotate`, {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		const data = await res.json<any>();

		const newPolicy = JSON.parse(data.result.new_credential.policy);
		expect(newPolicy.statements[0].actions).toEqual(['s3:GetObject', 's3:ListBucket']);
	});
});

// --- S3 Credential Update ---

describe('S3 Credential Update — PATCH /admin/s3/credentials/:id', () => {
	it('updates name', async () => {
		const { accessKeyId } = await createCredential(s3WildcardPolicy(), 'old-cred-name');

		const res = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'new-cred-name' }),
		});
		const data = await res.json<any>();

		expect(res.status).toBe(200);
		expect(data.result.credential.name).toBe('new-cred-name');
	});

	it('updates expires_at', async () => {
		const { accessKeyId } = await createCredential(s3WildcardPolicy(), 'expiry-cred');
		const newExpiry = Date.now() + 90 * 24 * 60 * 60 * 1000;

		const res = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ expires_at: newExpiry }),
		});
		const data = await res.json<any>();

		expect(res.status).toBe(200);
		expect(data.result.credential.expires_at).toBe(newExpiry);
	});

	it('removes expiry by setting null', async () => {
		// Create with expiry
		const res1 = await SELF.fetch('http://localhost/admin/s3/credentials', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'expires-cred',
				policy: s3WildcardPolicy(),
				upstream_token_id: getR2EndpointId(),
				expires_in_days: 30,
			}),
		});
		const d1 = await res1.json<any>();
		const accessKeyId = d1.result.credential.access_key_id;

		const res = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ expires_at: null }),
		});
		const data = await res.json<any>();

		expect(res.status).toBe(200);
		expect(data.result.credential.expires_at).toBeNull();
	});

	it('rejects update on revoked credential', async () => {
		const { accessKeyId } = await createCredential(s3WildcardPolicy(), 'revoked-cred-update');

		await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});

		const res = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({ name: 'nope' }),
		});
		expect(res.status).toBe(404);
	});

	it('rejects update with no fields', async () => {
		const { accessKeyId } = await createCredential(s3WildcardPolicy(), 'empty-cred-update');

		const res = await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}`, {
			method: 'PATCH',
			headers: adminHeaders(),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});
});
