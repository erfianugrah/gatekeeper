import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import {
	createCredential, buildClient, signedFetch, mockR2, getR2Origin,
	s3WildcardPolicy,
} from './s3-helpers';

describe('S3 proxy — bucket-level operations', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('ListObjectsV2 -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/test-bucket/ })
			.reply(200, '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?list-type=2&prefix=images/');
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('ListBucketResult');
	});

	it('ListObjects (v1) -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/test-bucket/ })
			.reply(200, '<ListBucketResult><Name>test-bucket</Name></ListBucketResult>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket');
		expect(res.status).toBe(200);
	});

	it('HeadBucket -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'HEAD', path: '/test-bucket' })
			.reply(200, '');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket', { method: 'HEAD' });
		expect(res.status).toBe(200);
	});

	it('CreateBucket -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('PUT', '/new-bucket', 200, '');

		const res = await signedFetch(client, 'http://localhost/s3/new-bucket', { method: 'PUT' });
		expect(res.status).toBe(200);
	});

	it('DeleteBucket -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'DELETE', path: '/old-bucket' })
			.reply(204, '');

		const res = await signedFetch(client, 'http://localhost/s3/old-bucket', { method: 'DELETE' });
		expect(res.status).toBe(204);
	});

	it('GetBucketLocation -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/test-bucket\?location/ })
			.reply(200, '<LocationConstraint>auto</LocationConstraint>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?location');
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('LocationConstraint');
	});

	it('GetBucketEncryption -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/test-bucket\?encryption/ })
			.reply(200, '<ServerSideEncryptionConfiguration></ServerSideEncryptionConfiguration>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?encryption');
		expect(res.status).toBe(200);
	});

	it('GetBucketCors -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/test-bucket\?cors/ })
			.reply(200, '<CORSConfiguration></CORSConfiguration>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?cors');
		expect(res.status).toBe(200);
	});

	it('PutBucketCors -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'PUT', path: /^\/test-bucket\?cors/ })
			.reply(200, '');

		const corsXml = '<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin></CORSRule></CORSConfiguration>';
		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?cors', {
			method: 'PUT',
			body: corsXml,
		});
		expect(res.status).toBe(200);
	});

	it('GetBucketLifecycle -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/test-bucket\?lifecycle/ })
			.reply(200, '<LifecycleConfiguration></LifecycleConfiguration>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?lifecycle');
		expect(res.status).toBe(200);
	});

	it('ListMultipartUploads -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/test-bucket\?uploads/ })
			.reply(200, '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?uploads');
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('ListMultipartUploadsResult');
	});
});

describe('S3 proxy — R2 unsupported operations (forwarded to R2)', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('GetBucketVersioning -> forwarded (R2 returns 200 stub)', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/test-bucket\?versioning/ })
			.reply(200, '<VersioningConfiguration/>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?versioning');
		expect(res.status).toBe(200);
	});

	it('PutBucketVersioning -> forwarded (R2 returns 501)', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'PUT', path: /^\/test-bucket\?versioning/ })
			.reply(501, '<Error><Code>NotImplemented</Code></Error>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?versioning', {
			method: 'PUT',
			body: '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
		});
		expect(res.status).toBe(501);
	});

	it('GetBucketAcl -> forwarded (R2 returns 200 stub)', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/test-bucket\?acl/ })
			.reply(200, '<AccessControlPolicy><Owner><ID>owner</ID></Owner></AccessControlPolicy>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?acl');
		expect(res.status).toBe(200);
	});

	it('GetObjectTagging -> forwarded', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/test-bucket\/key\.txt\?tagging/ })
			.reply(200, '<Tagging><TagSet></TagSet></Tagging>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/key.txt?tagging');
		expect(res.status).toBe(200);
	});

	it('DeleteObjectTagging -> forwarded (R2 returns 204)', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'DELETE', path: /^\/test-bucket\/key\.txt\?tagging/ })
			.reply(204, '');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/key.txt?tagging', {
			method: 'DELETE',
		});
		expect(res.status).toBe(204);
	});

	it('GetBucketPolicy -> forwarded', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/test-bucket\?policy/ })
			.reply(501, '<Error><Code>NotImplemented</Code></Error>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?policy');
		expect(res.status).toBe(501);
	});

	it('GetBucketTagging -> forwarded (R2 returns 404 NoSuchTagSet)', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/test-bucket\?tagging/ })
			.reply(404, '<Error><Code>NoSuchTagSet</Code></Error>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?tagging');
		expect(res.status).toBe(404);
		const body = await res.text();
		expect(body).toContain('NoSuchTagSet');
	});
});
