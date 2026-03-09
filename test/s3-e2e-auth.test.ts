import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { SELF, fetchMock } from 'cloudflare:test';
import {
	createCredential,
	buildClient,
	signedFetch,
	presignedFetch,
	mockR2,
	registerUpstreamR2,
	s3WildcardPolicy,
	s3ReadOnlyPolicy,
	cleanupCreatedS3Resources,
} from './s3-helpers';
import { adminHeaders } from './helpers';

afterAll(async () => {
	await cleanupCreatedS3Resources();
});

describe('S3 proxy — authentication and signature', () => {
	beforeAll(async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		await registerUpstreamR2();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('valid signature -> reaches R2 (mocked ListBuckets)', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', '/', 200, '<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>');

		const res = await signedFetch(client, 'http://localhost/s3/');
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('ListAllMyBucketsResult');
	});

	it('missing Authorization header -> 403', async () => {
		const res = await SELF.fetch('http://localhost/s3/', { method: 'GET' });
		expect(res.status).toBe(403);
		const body = await res.text();
		expect(body).toContain('AccessDenied');
	});

	it('malformed Authorization header -> 403', async () => {
		const res = await SELF.fetch('http://localhost/s3/', {
			method: 'GET',
			headers: { Authorization: 'Bearer some-random-token' },
		});
		expect(res.status).toBe(403);
		const body = await res.text();
		expect(body).toContain('AccessDenied');
	});

	it('unknown access key ID -> 403 InvalidAccessKeyId', async () => {
		const client = buildClient('GKnonexistent1234567890', 'fakesecret1234567890abcdef');

		const res = await signedFetch(client, 'http://localhost/s3/');
		expect(res.status).toBe(403);
		const body = await res.text();
		expect(body).toContain('InvalidAccessKeyId');
	});

	it('wrong secret key -> 403 SignatureDoesNotMatch', async () => {
		const { accessKeyId } = await createCredential(s3WildcardPolicy(), 'wrong-secret-test');
		const client = buildClient(accessKeyId, 'completely-wrong-secret-key-here-1234');

		const res = await signedFetch(client, 'http://localhost/s3/');
		expect(res.status).toBe(403);
		const body = await res.text();
		expect(body).toContain('SignatureDoesNotMatch');
	});

	it('revoked credential -> 403 InvalidAccessKeyId', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy(), 'revoke-test');
		const client = buildClient(accessKeyId, secretAccessKey);

		// Revoke it
		await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});

		const res = await signedFetch(client, 'http://localhost/s3/');
		expect(res.status).toBe(403);
		const body = await res.text();
		expect(body).toContain('InvalidAccessKeyId');
	});
});

describe('S3 proxy — presigned URL authentication', () => {
	beforeAll(async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		await registerUpstreamR2();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('presigned GET -> signature verifies correctly', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', '/test-bucket/presigned-file.txt', 200, 'presigned content');

		const res = await presignedFetch(client, 'http://localhost/s3/test-bucket/presigned-file.txt');
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toBe('presigned content');
	});

	it('presigned ListBuckets -> signature verifies correctly', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', '/', 200, '<ListAllMyBucketsResult></ListAllMyBucketsResult>');

		const res = await presignedFetch(client, 'http://localhost/s3/');
		expect(res.status).toBe(200);
	});

	it('presigned with spaces in key -> signature verifies correctly', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', /\/test-bucket\/my%20file\.txt/, 200, 'spaced content');

		const res = await presignedFetch(client, 'http://localhost/s3/test-bucket/my%20file.txt');
		expect(res.status).toBe(200);
	});

	it('presigned with unknown access key -> 403 InvalidAccessKeyId', async () => {
		const client = buildClient('GKnonexistent1234567890', 'fakesecret1234567890abcdef');

		const res = await presignedFetch(client, 'http://localhost/s3/test-bucket/file.txt');
		expect(res.status).toBe(403);
		const body = await res.text();
		expect(body).toContain('InvalidAccessKeyId');
	});

	it('presigned with wrong secret -> 403 SignatureDoesNotMatch', async () => {
		const { accessKeyId } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, 'wrong-secret-key-value-123456789');

		const res = await presignedFetch(client, 'http://localhost/s3/test-bucket/file.txt');
		expect(res.status).toBe(403);
		const body = await res.text();
		expect(body).toContain('SignatureDoesNotMatch');
	});

	it('presigned URL respects IAM policy (read-only rejects PUT)', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3ReadOnlyPolicy('test-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await presignedFetch(client, 'http://localhost/s3/test-bucket/file.txt', {
			method: 'PUT',
			body: 'data',
			headers: { 'Content-Type': 'text/plain' },
		});
		expect(res.status).toBe(403);
		const body = await res.text();
		expect(body).toContain('AccessDenied');
	});

	it('presigned URL respects IAM policy (read-only allows GET)', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3ReadOnlyPolicy('test-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', '/test-bucket/allowed.txt', 200, 'allowed');

		const res = await presignedFetch(client, 'http://localhost/s3/test-bucket/allowed.txt');
		expect(res.status).toBe(200);
	});

	it('presigned with revoked credential -> 403 InvalidAccessKeyId', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());

		// Revoke the credential
		await SELF.fetch(`http://localhost/admin/s3/credentials/${accessKeyId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});

		const client = buildClient(accessKeyId, secretAccessKey);
		const res = await presignedFetch(client, 'http://localhost/s3/test-bucket/file.txt');
		expect(res.status).toBe(403);
		const body = await res.text();
		expect(body).toContain('InvalidAccessKeyId');
	});
});
