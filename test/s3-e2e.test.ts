import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF, fetchMock } from 'cloudflare:test';
import { AwsClient } from 'aws4fetch';
import { adminHeaders } from './helpers';

// --- Helpers ---

/** Reads the R2 endpoint from the worker env (set in .dev.vars). */
function getR2Origin(): string {
	const endpoint = env.R2_ENDPOINT;
	const url = new URL(endpoint);
	return url.origin;
}


/** Create an S3 credential via admin API and return both keys. */
async function createCredential(
	policy: Record<string, unknown>,
	name = 'e2e-test-cred',
) {
	const res = await SELF.fetch('http://localhost/admin/s3/credentials', {
		method: 'POST',
		headers: adminHeaders(),
		body: JSON.stringify({ name, policy }),
	});
	const data = await res.json<any>();
	if (!data.success) throw new Error(`createCredential failed: ${JSON.stringify(data.errors)}`);
	return {
		accessKeyId: data.result.credential.access_key_id as string,
		secretAccessKey: data.result.credential.secret_access_key as string,
	};
}

/** Build an AwsClient pointed at our proxy. */
function buildClient(accessKeyId: string, secretAccessKey: string): AwsClient {
	return new AwsClient({
		accessKeyId,
		secretAccessKey,
		service: 's3',
		region: 'auto',
	});
}

/** Sign a request and send it through SELF.fetch. */
async function signedFetch(
	client: AwsClient,
	url: string,
	init?: RequestInit,
): Promise<Response> {
	const signed = await client.sign(url, {
		method: init?.method || 'GET',
		headers: init?.headers as HeadersInit | undefined,
		body: init?.body,
	});
	// Extract the signed request details and send via SELF.fetch
	return SELF.fetch(signed);
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

describe('S3 proxy — end-to-end with aws4fetch', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	// --- Auth + Sig V4 verification ---

	it('valid signature -> reaches R2 (mocked)', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		// Mock R2 response for ListBuckets
		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: '/' })
			.reply(200, '<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>', {
				headers: { 'Content-Type': 'application/xml' },
			});

		const res = await signedFetch(client, 'http://localhost/s3/');
		// Should forward to R2 and get 200 back
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('ListAllMyBucketsResult');
	});

	it('GetObject with valid sig -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: '/test-bucket/hello.txt' })
			.reply(200, 'hello world', {
				headers: {
					'Content-Type': 'text/plain',
					'ETag': '"abc123"',
				},
			});

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/hello.txt');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('hello world');
	});

	it('PutObject with valid sig -> proxies body through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'PUT', path: '/test-bucket/upload.txt' })
			.reply(200, '', {
				headers: { 'ETag': '"def456"' },
			});

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/upload.txt', {
			method: 'PUT',
			body: 'file contents here',
			headers: { 'Content-Type': 'text/plain' },
		});
		expect(res.status).toBe(200);
	});

	it('DeleteObject with valid sig -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'DELETE', path: '/test-bucket/delete-me.txt' })
			.reply(204, '');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/delete-me.txt', {
			method: 'DELETE',
		});
		expect(res.status).toBe(204);
	});

	it('HeadObject with valid sig -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'HEAD', path: '/test-bucket/check.txt' })
			.reply(200, '', {
				headers: {
					'Content-Type': 'text/plain',
					'Content-Length': '42',
					'ETag': '"ghi789"',
				},
			});

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/check.txt', {
			method: 'HEAD',
		});
		expect(res.status).toBe(200);
	});

	it('ListObjectsV2 with valid sig -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({
				method: 'GET',
				path: /^\/test-bucket/,
			})
			.reply(200, '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', {
				headers: { 'Content-Type': 'application/xml' },
			});

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?list-type=2&prefix=images/');
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('ListBucketResult');
	});

	// --- IAM policy enforcement ---

	it('read-only policy -> rejects PutObject', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3ReadOnlyPolicy('read-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/read-bucket/write-attempt.txt', {
			method: 'PUT',
			body: 'should be denied',
		});
		expect(res.status).toBe(403);
		const body = await res.text();
		expect(body).toContain('AccessDenied');
	});

	it('read-only policy -> allows GetObject on permitted bucket', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3ReadOnlyPolicy('read-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: '/read-bucket/allowed.txt' })
			.reply(200, 'allowed content');

		const res = await signedFetch(client, 'http://localhost/s3/read-bucket/allowed.txt');
		expect(res.status).toBe(200);
	});

	it('read-only policy -> rejects GetObject on wrong bucket', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3ReadOnlyPolicy('read-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/other-bucket/secret.txt');
		expect(res.status).toBe(403);
	});

	it('prefix-scoped write policy -> allows write within prefix', async () => {
		const policy = {
			version: '2025-01-01',
			statements: [{
				effect: 'allow',
				actions: ['s3:PutObject'],
				resources: ['object:uploads/*'],
				conditions: [{
					field: 'key',
					operator: 'starts_with',
					value: 'images/',
				}],
			}],
		};
		const { accessKeyId, secretAccessKey } = await createCredential(policy);
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'PUT', path: '/uploads/images/photo.jpg' })
			.reply(200, '');

		const res = await signedFetch(client, 'http://localhost/s3/uploads/images/photo.jpg', {
			method: 'PUT',
			body: 'image data',
		});
		expect(res.status).toBe(200);
	});

	it('prefix-scoped write policy -> rejects write outside prefix', async () => {
		const policy = {
			version: '2025-01-01',
			statements: [{
				effect: 'allow',
				actions: ['s3:PutObject'],
				resources: ['object:uploads/*'],
				conditions: [{
					field: 'key',
					operator: 'starts_with',
					value: 'images/',
				}],
			}],
		};
		const { accessKeyId, secretAccessKey } = await createCredential(policy);
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/uploads/docs/secret.pdf', {
			method: 'PUT',
			body: 'nope',
		});
		expect(res.status).toBe(403);
	});

	// --- Revoked credential ---

	it('revoked credential -> rejected', async () => {
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
