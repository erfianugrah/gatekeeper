import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import {
	createCredential,
	buildClient,
	signedFetch,
	mockR2,
	getR2Origin,
	s3WildcardPolicy,
	s3ReadOnlyPolicy,
	s3WriteOnlyPolicy,
	s3DeletePolicy,
	s3MultipartPolicy,
	s3ExtensionPolicy,
	s3ContentTypePolicy,
	s3MultiStatementPolicy,
	s3BucketAdminPolicy,
	registerUpstreamR2,
	cleanupCreatedS3Resources,
} from './s3-helpers';

afterAll(async () => {
	await cleanupCreatedS3Resources();
});

describe('S3 proxy — IAM policy enforcement', () => {
	beforeAll(async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		await registerUpstreamR2();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('read-only policy -> allows GetObject on permitted bucket', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3ReadOnlyPolicy('read-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', '/read-bucket/allowed.txt', 200, 'allowed content');

		const res = await signedFetch(client, 'http://localhost/s3/read-bucket/allowed.txt');
		expect(res.status).toBe(200);
	});

	it('read-only policy -> allows ListBucket on permitted bucket', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3ReadOnlyPolicy('read-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/read-bucket/ })
			.reply(200, '<ListBucketResult></ListBucketResult>');

		const res = await signedFetch(client, 'http://localhost/s3/read-bucket?list-type=2');
		expect(res.status).toBe(200);
	});

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

	it('read-only policy -> rejects DeleteObject', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3ReadOnlyPolicy('read-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/read-bucket/file.txt', {
			method: 'DELETE',
		});
		expect(res.status).toBe(403);
	});

	it('read-only policy -> rejects GetObject on wrong bucket', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3ReadOnlyPolicy('read-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/other-bucket/secret.txt');
		expect(res.status).toBe(403);
	});

	it('read-only policy -> rejects ListBuckets (account-level)', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3ReadOnlyPolicy('read-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/');
		expect(res.status).toBe(403);
	});

	it('write-only policy -> allows PutObject', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WriteOnlyPolicy('write-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('PUT', '/write-bucket/file.txt', 200, '');

		const res = await signedFetch(client, 'http://localhost/s3/write-bucket/file.txt', {
			method: 'PUT',
			body: 'data',
		});
		expect(res.status).toBe(200);
	});

	it('write-only policy -> rejects GetObject', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WriteOnlyPolicy('write-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/write-bucket/file.txt');
		expect(res.status).toBe(403);
	});

	it('delete-only policy -> allows DeleteObject', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3DeletePolicy('del-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock.get(getR2Origin()).intercept({ method: 'DELETE', path: '/del-bucket/file.txt' }).reply(204, '');

		const res = await signedFetch(client, 'http://localhost/s3/del-bucket/file.txt', {
			method: 'DELETE',
		});
		expect(res.status).toBe(204);
	});

	it('delete-only policy -> rejects PutObject', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3DeletePolicy('del-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/del-bucket/file.txt', {
			method: 'PUT',
			body: 'nope',
		});
		expect(res.status).toBe(403);
	});
});

describe('S3 proxy — prefix-scoped policies', () => {
	beforeAll(async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		await registerUpstreamR2();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('prefix write policy -> allows write within prefix', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WriteOnlyPolicy('uploads', 'images/'));
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('PUT', '/uploads/images/photo.jpg', 200, '');

		const res = await signedFetch(client, 'http://localhost/s3/uploads/images/photo.jpg', {
			method: 'PUT',
			body: 'image data',
		});
		expect(res.status).toBe(200);
	});

	it('prefix write policy -> rejects write outside prefix', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WriteOnlyPolicy('uploads', 'images/'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/uploads/docs/secret.pdf', {
			method: 'PUT',
			body: 'nope',
		});
		expect(res.status).toBe(403);
	});

	it('prefix write policy -> rejects write to different bucket', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WriteOnlyPolicy('uploads', 'images/'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/other-bucket/images/photo.jpg', {
			method: 'PUT',
			body: 'nope',
		});
		expect(res.status).toBe(403);
	});
});

describe('S3 proxy — extension-based policies', () => {
	beforeAll(async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		await registerUpstreamR2();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('jpg-only policy -> allows .jpg upload', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3ExtensionPolicy('media', 'jpg'));
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('PUT', '/media/photo.jpg', 200, '');

		const res = await signedFetch(client, 'http://localhost/s3/media/photo.jpg', {
			method: 'PUT',
			body: 'image bytes',
		});
		expect(res.status).toBe(200);
	});

	it('jpg-only policy -> rejects .png upload', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3ExtensionPolicy('media', 'jpg'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/media/photo.png', {
			method: 'PUT',
			body: 'image bytes',
		});
		expect(res.status).toBe(403);
	});

	it('jpg-only policy -> allows .jpg read', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3ExtensionPolicy('media', 'jpg'));
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', '/media/photo.jpg', 200, 'image data');

		const res = await signedFetch(client, 'http://localhost/s3/media/photo.jpg');
		expect(res.status).toBe(200);
	});
});

describe('S3 proxy — content-type policies', () => {
	beforeAll(async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		await registerUpstreamR2();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('image/* content-type policy -> allows image/jpeg upload', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3ContentTypePolicy('media', 'image/'));
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('PUT', '/media/photo.jpg', 200, '');

		const res = await signedFetch(client, 'http://localhost/s3/media/photo.jpg', {
			method: 'PUT',
			body: 'image bytes',
			headers: { 'Content-Type': 'image/jpeg' },
		});
		expect(res.status).toBe(200);
	});

	it('image/* content-type policy -> rejects text/plain upload', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3ContentTypePolicy('media', 'image/'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/media/readme.txt', {
			method: 'PUT',
			body: 'text data',
			headers: { 'Content-Type': 'text/plain' },
		});
		expect(res.status).toBe(403);
	});
});

describe('S3 proxy — multi-statement policies', () => {
	beforeAll(async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		await registerUpstreamR2();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('multi-statement -> allows read from read-bucket', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3MultiStatementPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', '/read-bucket/file.txt', 200, 'read content');

		const res = await signedFetch(client, 'http://localhost/s3/read-bucket/file.txt');
		expect(res.status).toBe(200);
	});

	it('multi-statement -> allows write to write-bucket', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3MultiStatementPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('PUT', '/write-bucket/file.txt', 200, '');

		const res = await signedFetch(client, 'http://localhost/s3/write-bucket/file.txt', {
			method: 'PUT',
			body: 'data',
		});
		expect(res.status).toBe(200);
	});

	it('multi-statement -> allows ListBuckets', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3MultiStatementPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', '/', 200, '<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>');

		const res = await signedFetch(client, 'http://localhost/s3/');
		expect(res.status).toBe(200);
	});

	it('multi-statement -> rejects write to read-bucket', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3MultiStatementPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/read-bucket/file.txt', {
			method: 'PUT',
			body: 'nope',
		});
		expect(res.status).toBe(403);
	});

	it('multi-statement -> rejects read from write-bucket', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3MultiStatementPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/write-bucket/file.txt');
		expect(res.status).toBe(403);
	});

	it('multi-statement -> rejects operations on unknown bucket', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3MultiStatementPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/unknown-bucket/file.txt');
		expect(res.status).toBe(403);
	});
});

describe('S3 proxy — bucket admin policies', () => {
	beforeAll(async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		await registerUpstreamR2();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('bucket admin policy -> allows HeadBucket', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3BucketAdminPolicy('admin-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock.get(getR2Origin()).intercept({ method: 'HEAD', path: '/admin-bucket' }).reply(200, '');

		const res = await signedFetch(client, 'http://localhost/s3/admin-bucket', { method: 'HEAD' });
		expect(res.status).toBe(200);
	});

	it('bucket admin policy -> allows GetBucketCors', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3BucketAdminPolicy('admin-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/admin-bucket\?cors/ })
			.reply(200, '<CORSConfiguration/>');

		const res = await signedFetch(client, 'http://localhost/s3/admin-bucket?cors');
		expect(res.status).toBe(200);
	});

	it('bucket admin policy -> rejects GetObject (object-level)', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3BucketAdminPolicy('admin-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/admin-bucket/file.txt');
		expect(res.status).toBe(403);
	});

	it('bucket admin policy -> rejects operations on other bucket', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3BucketAdminPolicy('admin-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/other-bucket', { method: 'HEAD' });
		expect(res.status).toBe(403);
	});
});

describe('S3 proxy — multipart with scoped policies', () => {
	beforeAll(async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		await registerUpstreamR2();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('multipart policy -> allows CreateMultipartUpload', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3MultipartPolicy('mp-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'POST', path: /^\/mp-bucket\/big\.bin\?uploads/ })
			.reply(200, '<InitiateMultipartUploadResult><UploadId>mp123</UploadId></InitiateMultipartUploadResult>');

		const res = await signedFetch(client, 'http://localhost/s3/mp-bucket/big.bin?uploads', {
			method: 'POST',
		});
		expect(res.status).toBe(200);
	});

	it('multipart policy -> allows AbortMultipartUpload', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3MultipartPolicy('mp-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'DELETE', path: /^\/mp-bucket\/big\.bin\?uploadId/ })
			.reply(204, '');

		const res = await signedFetch(client, 'http://localhost/s3/mp-bucket/big.bin?uploadId=mp123', {
			method: 'DELETE',
		});
		expect(res.status).toBe(204);
	});

	it('multipart policy -> allows ListMultipartUploads (bucket-level)', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3MultipartPolicy('mp-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/mp-bucket\?uploads/ })
			.reply(200, '<ListMultipartUploadsResult></ListMultipartUploadsResult>');

		const res = await signedFetch(client, 'http://localhost/s3/mp-bucket?uploads');
		expect(res.status).toBe(200);
	});

	it('multipart policy -> rejects GetObject (not in policy)', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3MultipartPolicy('mp-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/mp-bucket/big.bin');
		expect(res.status).toBe(403);
	});

	it('multipart policy -> rejects operations on other bucket', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3MultipartPolicy('mp-bucket'));
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/other-bucket/file.bin?uploads', {
			method: 'POST',
		});
		expect(res.status).toBe(403);
	});
});

describe('S3 proxy — CopyObject dual authorization', () => {
	beforeAll(async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		await registerUpstreamR2();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('wildcard policy -> allows cross-bucket copy', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('PUT', '/dest-bucket/copy.txt', 200, '<CopyObjectResult><ETag>"copy456"</ETag></CopyObjectResult>');

		const res = await signedFetch(client, 'http://localhost/s3/dest-bucket/copy.txt', {
			method: 'PUT',
			headers: { 'x-amz-copy-source': '/src-bucket/original.txt' },
		});
		expect(res.status).toBe(200);
	});

	it('write-only on dest -> rejects copy (needs read on source)', async () => {
		const policy = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['s3:PutObject'],
					resources: ['object:dest-bucket/*'],
				},
			],
		};
		const { accessKeyId, secretAccessKey } = await createCredential(policy);
		const client = buildClient(accessKeyId, secretAccessKey);

		const res = await signedFetch(client, 'http://localhost/s3/dest-bucket/copy.txt', {
			method: 'PUT',
			headers: { 'x-amz-copy-source': '/src-bucket/original.txt' },
		});
		// CopyObject requires s3:GetObject on source — should be denied
		expect(res.status).toBe(403);
	});
});
