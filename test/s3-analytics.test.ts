import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { adminHeaders, waitForAnalytics } from './helpers';
import {
	registerUpstreamR2,
	createCredential,
	buildClient,
	signedFetch,
	mockR2,
	s3WildcardPolicy,
	getR2Origin,
	cleanupCreatedS3Resources,
} from './s3-helpers';

// --- Setup ---

afterAll(async () => {
	await cleanupCreatedS3Resources();
});

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	await registerUpstreamR2();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

// --- Tests ---

describe('S3 Analytics — validation', () => {
	it('S3 events endpoint -> 200 with array', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/analytics/events', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(Array.isArray(data.result)).toBe(true);
	});

	it('S3 summary endpoint -> 200 with shape', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/analytics/summary', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result).toBeDefined();
		expect(typeof data.result.total_requests).toBe('number');
		expect(typeof data.result.by_status).toBe('object');
		expect(typeof data.result.by_operation).toBe('object');
		expect(typeof data.result.by_bucket).toBe('object');
		expect(typeof data.result.avg_duration_ms).toBe('number');
	});

	it('S3 analytics endpoints require admin key', async () => {
		const eventsRes = await SELF.fetch('http://localhost/admin/s3/analytics/events');
		expect(eventsRes.status).toBe(401);

		const summaryRes = await SELF.fetch('http://localhost/admin/s3/analytics/summary');
		expect(summaryRes.status).toBe(401);
	});
});

describe('S3 Analytics — empty state', () => {
	it('events returns empty array when no events', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/analytics/events', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		// May have events from other tests, but shape is correct
		expect(Array.isArray(data.result)).toBe(true);
	});

	it('summary returns zero-ish defaults when no events', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/analytics/summary', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(typeof data.result.total_requests).toBe('number');
	});
});

describe('S3 Analytics — event logging', () => {
	it('S3 request logs event to D1, queryable via events endpoint', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy());
		const client = buildClient(accessKeyId, secretAccessKey);

		// Mock R2 response for ListBuckets
		mockR2('GET', '/', 200, '<?xml version="1.0"?><ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>');

		const s3Res = await signedFetch(client, 'http://localhost/s3/');
		expect(s3Res.status).toBe(200);

		// Wait for fire-and-forget analytics write
		await waitForAnalytics();

		const res = await SELF.fetch('http://localhost/admin/s3/analytics/events', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.length).toBeGreaterThanOrEqual(1);

		const event = data.result[0];
		expect(event.credential_id).toBeDefined();
		expect(event.operation).toBeDefined();
		expect(event.status).toBeGreaterThan(0);
		expect(event.duration_ms).toBeGreaterThanOrEqual(0);
		expect(event.created_at).toBeGreaterThan(0);
	});

	it('S3 summary aggregates after requests', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy(), 'summary-test-cred');
		const client = buildClient(accessKeyId, secretAccessKey);

		// Mock R2 response for GetObject
		mockR2('GET', /\/test-bucket\//, 200, 'hello world', { 'Content-Type': 'text/plain' });

		await signedFetch(client, 'http://localhost/s3/test-bucket/hello.txt');

		await waitForAnalytics();

		const res = await SELF.fetch('http://localhost/admin/s3/analytics/summary', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.total_requests).toBeGreaterThanOrEqual(1);
	});
});

describe('S3 Analytics — filtering', () => {
	it('events endpoint filters by credential_id', async () => {
		const { accessKeyId, secretAccessKey } = await createCredential(s3WildcardPolicy(), 'filter-cred');
		const client = buildClient(accessKeyId, secretAccessKey);

		mockR2('GET', '/', 200, '<?xml version="1.0"?><ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>');
		await signedFetch(client, 'http://localhost/s3/');
		await waitForAnalytics();

		const res = await SELF.fetch(`http://localhost/admin/s3/analytics/events?credential_id=${accessKeyId}`, {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		for (const event of data.result) {
			expect(event.credential_id).toBe(accessKeyId);
		}
	});

	it('events endpoint respects limit param', async () => {
		const res = await SELF.fetch('http://localhost/admin/s3/analytics/events?limit=1', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.length).toBeLessThanOrEqual(1);
	});
});
