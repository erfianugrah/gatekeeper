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
import { adminHeaders, waitForAnalytics } from './helpers';

afterAll(async () => {
	await cleanupCreatedS3Resources();
});

describe('S3 proxy — credential lifecycle via admin API', () => {
	beforeAll(async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		await registerUpstreamR2();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('create -> list -> get -> revoke lifecycle', async () => {
		// Create
		const createRes = await SELF.fetch('http://localhost/admin/s3/credentials', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'lifecycle-test',
				policy: s3WildcardPolicy(),
			}),
		});
		const createData = await createRes.json<any>();
		expect(createData.success).toBe(true);
		const akid = createData.result.credential.access_key_id;
		expect(akid).toMatch(/^GK/);
		expect(createData.result.credential.secret_access_key).toBeTruthy();

		// List
		const listRes = await SELF.fetch('http://localhost/admin/s3/credentials', {
			headers: adminHeaders(),
		});
		const listData = await listRes.json<any>();
		expect(listData.success).toBe(true);
		expect(listData.result.some((c: any) => c.access_key_id === akid)).toBe(true);

		// Get
		const getRes = await SELF.fetch(`http://localhost/admin/s3/credentials/${akid}`, {
			headers: adminHeaders(),
		});
		const getData = await getRes.json<any>();
		expect(getData.success).toBe(true);
		expect(getData.result.credential.name).toBe('lifecycle-test');

		// Revoke
		const revokeRes = await SELF.fetch(`http://localhost/admin/s3/credentials/${akid}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		const revokeData = await revokeRes.json<any>();
		expect(revokeData.success).toBe(true);
		expect(revokeData.result.revoked).toBe(true);

		// Verify revoked credential can't auth
		const client = buildClient(akid, createData.result.credential.secret_access_key);
		const authRes = await signedFetch(client, 'http://localhost/s3/');
		expect(authRes.status).toBe(403);
	});

	it('list with status filter -> returns filtered results', async () => {
		const { accessKeyId } = await createCredential(s3WildcardPolicy(), 'filter-active');
		const { accessKeyId: revokedId } = await createCredential(s3WildcardPolicy(), 'filter-revoked');

		// Revoke one
		await SELF.fetch(`http://localhost/admin/s3/credentials/${revokedId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});

		// List active only
		const activeRes = await SELF.fetch('http://localhost/admin/s3/credentials?status=active', {
			headers: adminHeaders(),
		});
		const activeData = await activeRes.json<any>();
		expect(activeData.success).toBe(true);
		const activeIds = activeData.result.map((c: any) => c.access_key_id);
		expect(activeIds).toContain(accessKeyId);
		expect(activeIds).not.toContain(revokedId);
	});

	it('get non-existent credential -> 404', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/credentials/GKnonexistent', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(404);
	});

	it('revoke non-existent credential -> 404', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/credentials/GKnonexistent', {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(res.status).toBe(404);
	});

	it('create with invalid policy -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/credentials', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'bad-policy',
				policy: { version: '2025-01-01', statements: [] },
			}),
		});
		expect(res.status).toBe(400);
	});

	it('create without name -> 400', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/credentials', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				policy: s3WildcardPolicy(),
			}),
		});
		expect(res.status).toBe(400);
	});
});

describe('S3 proxy — S3 analytics', () => {
	beforeAll(async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		await registerUpstreamR2();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('S3 analytics events endpoint returns empty array initially', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/analytics/events', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(Array.isArray(data.result)).toBe(true);
	});

	it('S3 analytics summary returns zeros initially', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/analytics/summary', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.total_requests).toBe(0);
		expect(data.result.avg_duration_ms).toBe(0);
	});

	it('S3 request logs event queryable via analytics endpoint', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', '/', 200, '<ListAllMyBucketsResult></ListAllMyBucketsResult>');

		const res = await signedFetch(client, 'http://localhost/s3/');
		expect(res.status).toBe(200);

		// Give waitUntil a moment to complete
		await waitForAnalytics(100);

		const eventsRes = await SELF.fetch(`http://localhost/admin/s3/analytics/events?credential_id=${accessKeyId}`, {
			headers: adminHeaders(),
		});
		expect(eventsRes.status).toBe(200);
		const eventsData = await eventsRes.json<any>();
		expect(eventsData.result.length).toBeGreaterThanOrEqual(1);

		const event = eventsData.result[0];
		expect(event.credential_id).toBe(accessKeyId);
		expect(event.operation).toBe('ListBuckets');
		expect(event.status).toBe(200);
	});

	it('S3 analytics summary aggregates correctly', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		// Make two different requests
		mockR2('GET', '/analytics-bucket/file.txt', 200, 'content');
		await signedFetch(client, 'http://localhost/s3/analytics-bucket/file.txt');

		mockR2('PUT', '/analytics-bucket/upload.txt', 200, '');
		await signedFetch(client, 'http://localhost/s3/analytics-bucket/upload.txt', {
			method: 'PUT',
			body: 'data',
			headers: { 'Content-Type': 'text/plain' },
		});

		await waitForAnalytics(100);

		const summaryRes = await SELF.fetch(`http://localhost/admin/s3/analytics/summary?bucket=analytics-bucket`, { headers: adminHeaders() });
		expect(summaryRes.status).toBe(200);
		const summaryData = await summaryRes.json<any>();
		expect(summaryData.result.total_requests).toBeGreaterThanOrEqual(2);
		expect(summaryData.result.by_bucket['analytics-bucket']).toBeGreaterThanOrEqual(2);
	});

	it('S3 analytics requires admin key', async () => {
		const eventsRes = await SELF.fetch('http://localhost/admin/s3/analytics/events');
		expect(eventsRes.status).toBe(401);

		const summaryRes = await SELF.fetch('http://localhost/admin/s3/analytics/summary');
		expect(summaryRes.status).toBe(401);
	});
});
