import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import {
	createCredential, buildClient, signedFetch, mockR2, getR2Origin,
	s3WildcardPolicy,
} from './s3-helpers';

describe('S3 proxy — core object operations', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('GetObject -> proxies through with body and headers', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', '/test-bucket/hello.txt', 200, 'hello world', {
			'Content-Type': 'text/plain',
			'ETag': '"abc123"',
		});

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/hello.txt');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('hello world');
	});

	it('HeadObject -> proxies through', async () => {
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

	it('PutObject -> proxies body through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('PUT', '/test-bucket/upload.txt', 200, '', { 'ETag': '"def456"' });

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/upload.txt', {
			method: 'PUT',
			body: 'file contents here',
			headers: { 'Content-Type': 'text/plain' },
		});
		expect(res.status).toBe(200);
	});

	it('DeleteObject -> proxies through with 204', async () => {
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

	it('CopyObject (x-amz-copy-source) -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('PUT', '/dest-bucket/copied.txt', 200,
			'<CopyObjectResult><ETag>"copy123"</ETag></CopyObjectResult>');

		const res = await signedFetch(client, 'http://localhost/s3/dest-bucket/copied.txt', {
			method: 'PUT',
			headers: { 'x-amz-copy-source': '/src-bucket/original.txt' },
		});
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('CopyObjectResult');
	});

	it('GetObject for non-existent key -> R2 returns 404', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', '/test-bucket/no-such-key.txt', 404,
			'<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/no-such-key.txt');
		expect(res.status).toBe(404);
		const body = await res.text();
		expect(body).toContain('NoSuchKey');
	});
});

describe('S3 proxy — multipart upload operations', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('CreateMultipartUpload -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'POST', path: /^\/test-bucket\/big-file\.bin\?uploads/ })
			.reply(200, '<InitiateMultipartUploadResult><UploadId>abc123</UploadId></InitiateMultipartUploadResult>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/big-file.bin?uploads', {
			method: 'POST',
		});
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('UploadId');
	});

	it('UploadPart -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'PUT', path: /^\/test-bucket\/big-file\.bin\?/ })
			.reply(200, '', { headers: { 'ETag': '"part1"' } });

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/big-file.bin?partNumber=1&uploadId=abc123', {
			method: 'PUT',
			body: 'part data',
		});
		expect(res.status).toBe(200);
	});

	it('CompleteMultipartUpload -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'POST', path: /^\/test-bucket\/big-file\.bin\?uploadId/ })
			.reply(200, '<CompleteMultipartUploadResult><Location>/test-bucket/big-file.bin</Location></CompleteMultipartUploadResult>');

		const completeXml = '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"part1"</ETag></Part></CompleteMultipartUpload>';
		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/big-file.bin?uploadId=abc123', {
			method: 'POST',
			body: completeXml,
		});
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('CompleteMultipartUploadResult');
	});

	it('AbortMultipartUpload -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'DELETE', path: /^\/test-bucket\/big-file\.bin\?uploadId/ })
			.reply(204, '');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/big-file.bin?uploadId=abc123', {
			method: 'DELETE',
		});
		expect(res.status).toBe(204);
	});

	it('ListParts -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'GET', path: /^\/test-bucket\/big-file\.bin\?uploadId/ })
			.reply(200, '<ListPartsResult><IsTruncated>false</IsTruncated></ListPartsResult>');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/big-file.bin?uploadId=abc123');
		expect(res.status).toBe(200);
	});
});

describe('S3 proxy — DeleteObjects (batch)', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('DeleteObjects (POST ?delete) -> proxies XML body', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'POST', path: /^\/test-bucket\?delete/ })
			.reply(200, [
				'<DeleteResult>',
				'<Deleted><Key>file1.txt</Key></Deleted>',
				'<Deleted><Key>file2.txt</Key></Deleted>',
				'</DeleteResult>',
			].join(''));

		const deleteXml = [
			'<Delete>',
			'<Object><Key>file1.txt</Key></Object>',
			'<Object><Key>file2.txt</Key></Object>',
			'<Quiet>false</Quiet>',
			'</Delete>',
		].join('');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?delete', {
			method: 'POST',
			body: deleteXml,
			headers: { 'Content-Type': 'application/xml' },
		});
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('DeleteResult');
		expect(body).toContain('file1.txt');
	});

	it('DeleteObjects with per-key auth -> rejects when one key is outside allowed prefix', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential({
			version: '2025-01-01',
			statements: [{
				effect: 'allow',
				actions: ['s3:DeleteObject'],
				resources: ['object:test-bucket/*'],
				conditions: [{ field: 'key.prefix', operator: 'eq', value: 'images/' }],
			}],
		});
		const client = buildClient(accessKeyId, secretAccessKey);

		const deleteXml = [
			'<Delete>',
			'<Object><Key>images/photo.jpg</Key></Object>',
			'<Object><Key>docs/secret.pdf</Key></Object>',
			'</Delete>',
		].join('');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?delete', {
			method: 'POST',
			body: deleteXml,
			headers: { 'Content-Type': 'application/xml' },
		});
		expect(res.status).toBe(403);
		const body = await res.text();
		expect(body).toContain('AccessDenied');
	});

	it('DeleteObjects with per-key auth -> allows when all keys are within allowed prefix', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential({
			version: '2025-01-01',
			statements: [{
				effect: 'allow',
				actions: ['s3:DeleteObject'],
				resources: ['object:test-bucket/*'],
				conditions: [{ field: 'key.prefix', operator: 'eq', value: 'images/' }],
			}],
		});
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'POST', path: /^\/test-bucket\?delete/ })
			.reply(200, [
				'<DeleteResult>',
				'<Deleted><Key>images/photo1.jpg</Key></Deleted>',
				'<Deleted><Key>images/photo2.jpg</Key></Deleted>',
				'</DeleteResult>',
			].join(''));

		const deleteXml = [
			'<Delete>',
			'<Object><Key>images/photo1.jpg</Key></Object>',
			'<Object><Key>images/photo2.jpg</Key></Object>',
			'</Delete>',
		].join('');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?delete', {
			method: 'POST',
			body: deleteXml,
			headers: { 'Content-Type': 'application/xml' },
		});
		expect(res.status).toBe(200);
	});

	it('DeleteObjects per-key auth -> rejects when bucket is wrong', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential({
			version: '2025-01-01',
			statements: [{
				effect: 'allow',
				actions: ['s3:DeleteObject'],
				resources: ['object:allowed-bucket/*'],
			}],
		});
		const client = buildClient(accessKeyId, secretAccessKey);

		const deleteXml = [
			'<Delete>',
			'<Object><Key>file1.txt</Key></Object>',
			'</Delete>',
		].join('');

		const res = await signedFetch(client, 'http://localhost/s3/wrong-bucket?delete', {
			method: 'POST',
			body: deleteXml,
			headers: { 'Content-Type': 'application/xml' },
		});
		expect(res.status).toBe(403);
		const body = await res.text();
		expect(body).toContain('AccessDenied');
	});

	it('DeleteObjects per-key auth -> handles XML entities in keys', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		fetchMock
			.get(getR2Origin())
			.intercept({ method: 'POST', path: /^\/test-bucket\?delete/ })
			.reply(200, '<DeleteResult><Deleted><Key>file&amp;name.txt</Key></Deleted></DeleteResult>');

		const deleteXml = [
			'<Delete>',
			'<Object><Key>file&amp;name.txt</Key></Object>',
			'</Delete>',
		].join('');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket?delete', {
			method: 'POST',
			body: deleteXml,
			headers: { 'Content-Type': 'application/xml' },
		});
		expect(res.status).toBe(200);
	});
});

describe('S3 proxy — special characters in object keys', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('key with special characters (dashes, dots, underscores) -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', '/test-bucket/my-file_v2.0.txt', 200, 'content');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/my-file_v2.0.txt');
		expect(res.status).toBe(200);
	});

	it('key with nested path -> proxies through', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', '/test-bucket/a/b/c/d/deep.txt', 200, 'deep content');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/a/b/c/d/deep.txt');
		expect(res.status).toBe(200);
	});

	it('key with spaces (URL-encoded %20) -> signature verifies correctly', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', /\/test-bucket\/my%20file\.txt/, 200, 'spaced content');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/my%20file.txt');
		expect(res.status).toBe(200);
	});

	it('key with parentheses -> signature verifies correctly', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', /\/test-bucket\/report%20\(final\)\.pdf/, 200, 'pdf content');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/report%20(final).pdf');
		expect(res.status).toBe(200);
	});

	it('key with plus sign -> signature verifies correctly', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', /\/test-bucket\/a\+b\.txt/, 200, 'plus content');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/a+b.txt');
		expect(res.status).toBe(200);
	});

	it('key with exclamation mark -> signature verifies correctly', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', /\/test-bucket\/hello!world/, 200, 'exclaim content');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/hello!world');
		expect(res.status).toBe(200);
	});

	it('PUT with spaces in key -> signature verifies correctly', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('PUT', /\/test-bucket\/my%20folder\/my%20file\.txt/, 200, '');

		const res = await signedFetch(client, 'http://localhost/s3/test-bucket/my%20folder/my%20file.txt', {
			method: 'PUT',
			body: 'hello world',
			headers: { 'Content-Type': 'text/plain' },
		});
		expect(res.status).toBe(200);
	});
});

describe('S3 proxy — upstream error handling', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('R2 returns 500 -> proxied through as-is', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', '/error-bucket/file.txt', 500,
			'<Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>');

		const res = await signedFetch(client, 'http://localhost/s3/error-bucket/file.txt');
		expect(res.status).toBe(500);
		const body = await res.text();
		expect(body).toContain('InternalError');
	});
});
