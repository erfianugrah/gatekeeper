import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { SELF, fetchMock } from 'cloudflare:test';
import {
	createCredential,
	buildClient,
	signedFetch,
	mockR2,
	registerUpstreamR2,
	s3WildcardPolicy,
	cleanupCreatedS3Resources,
} from './s3-helpers';
import { adminHeaders } from './helpers';

afterAll(async () => {
	await cleanupCreatedS3Resources();
});

describe('S3 proxy — account-level rate limiting', () => {
	beforeAll(async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		await registerUpstreamR2();
	});

	afterEach(async () => {
		fetchMock.assertNoPendingInterceptors();
		// Ensure rate-limit config is always reset, even if assertions fail
		await SELF.fetch('http://localhost/admin/config/s3_rps', { method: 'DELETE', headers: adminHeaders() });
		await SELF.fetch('http://localhost/admin/config/s3_burst', { method: 'DELETE', headers: adminHeaders() });
	});

	it('config defaults include s3_rps and s3_burst', async () => {
		const res = await SELF.fetch('http://localhost/admin/config', {
			headers: adminHeaders(),
		});
		const data = await res.json<any>();
		expect(data.result.defaults.s3_rps).toBe(100);
		expect(data.result.defaults.s3_burst).toBe(200);
		expect(data.result.config.s3_rps).toBeGreaterThan(0);
		expect(data.result.config.s3_burst).toBeGreaterThan(0);
	});

	it('admin can configure s3_rps and s3_burst via config API', async () => {
		const putRes = await SELF.fetch('http://localhost/admin/config', {
			method: 'PUT',
			headers: adminHeaders(),
			body: JSON.stringify({ s3_rps: 50, s3_burst: 100 }),
		});
		expect(putRes.status).toBe(200);
		const putData = await putRes.json<any>();
		expect(putData.result.config.s3_rps).toBe(50);
		expect(putData.result.config.s3_burst).toBe(100);
	});

	it('returns 429 SlowDown with Retry-After when rate limit exhausted', async () => {
		// Set burst to 1 so the second request is rate-limited
		const putRes = await SELF.fetch('http://localhost/admin/config', {
			method: 'PUT',
			headers: adminHeaders(),
			body: JSON.stringify({ s3_rps: 1, s3_burst: 1 }),
		});
		expect(putRes.status).toBe(200);

		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		// First request — should succeed (consumes the 1 token)
		mockR2('GET', '/', 200, '<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>');
		const res1 = await signedFetch(client, 'http://localhost/s3/');
		expect(res1.status).toBe(200);

		// Second request — should be rate-limited (no tokens left)
		const res2 = await signedFetch(client, 'http://localhost/s3/');
		expect(res2.status).toBe(429);
		const body = await res2.text();
		expect(body).toContain('SlowDown');
		expect(body).toContain('Please reduce your request rate');
		expect(res2.headers.get('Retry-After')).toBeTruthy();
	});

	it('rate-limited response is valid S3 XML with correct content type', async () => {
		// Set burst to 1
		await SELF.fetch('http://localhost/admin/config', {
			method: 'PUT',
			headers: adminHeaders(),
			body: JSON.stringify({ s3_rps: 1, s3_burst: 1 }),
		});

		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		// Exhaust the bucket
		mockR2('GET', '/', 200, '<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>');
		await signedFetch(client, 'http://localhost/s3/');

		// Rate-limited request
		const res = await signedFetch(client, 'http://localhost/s3/');
		expect(res.status).toBe(429);
		expect(res.headers.get('Content-Type')).toBe('application/xml');
		const body = await res.text();
		expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
		expect(body).toContain('<Error>');
		expect(body).toContain('<Code>SlowDown</Code>');
		expect(body).toContain('<RequestId>');
	});
});
