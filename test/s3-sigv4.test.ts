import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { SELF, fetchMock } from 'cloudflare:test';
import { parseAuthHeader } from '../src/s3/sig-v4-verify';
import { adminHeaders } from './helpers';

/** Access key IDs created during tests, for cleanup in afterAll. */
const localCreatedIds: string[] = [];

afterAll(async () => {
	const ids = localCreatedIds.splice(0);
	await Promise.all(
		ids.map((id) =>
			SELF.fetch(`http://localhost/admin/s3/credentials/${id}?permanent=true`, {
				method: 'DELETE',
				headers: adminHeaders(),
			}),
		),
	);
});

// --- parseAuthHeader unit tests (runs in Workers runtime) ---

describe('S3 Sig V4 — parseAuthHeader', () => {
	it('parses valid Sig V4 auth header', () => {
		const header =
			'AWS4-HMAC-SHA256 Credential=GKAABBCCDD11223344/20260305/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
		const result = parseAuthHeader(header);
		expect(result).not.toBeNull();
		expect(result!.accessKeyId).toBe('GKAABBCCDD11223344');
		expect(result!.date).toBe('20260305');
		expect(result!.region).toBe('auto');
		expect(result!.service).toBe('s3');
		expect(result!.signedHeaders).toEqual(['host', 'x-amz-content-sha256', 'x-amz-date']);
		expect(result!.signature).toBe('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
		expect(result!.credentialScope).toBe('20260305/auto/s3/aws4_request');
	});

	it('parses with us-east-1 region', () => {
		const header =
			'AWS4-HMAC-SHA256 Credential=GKAABBCCDD11223344/20260305/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44';
		const result = parseAuthHeader(header);
		expect(result).not.toBeNull();
		expect(result!.region).toBe('us-east-1');
	});

	it('rejects non-AWS4-HMAC-SHA256 header', () => {
		expect(parseAuthHeader('Bearer token123')).toBeNull();
	});

	it('rejects malformed credential', () => {
		expect(parseAuthHeader('AWS4-HMAC-SHA256 Credential=bad, SignedHeaders=host, Signature=aa')).toBeNull();
	});

	it('rejects missing Signature', () => {
		expect(parseAuthHeader('AWS4-HMAC-SHA256 Credential=KEY/20260305/auto/s3/aws4_request, SignedHeaders=host')).toBeNull();
	});

	it('rejects non-aws4_request type', () => {
		expect(parseAuthHeader('AWS4-HMAC-SHA256 Credential=KEY/20260305/auto/s3/other_request, SignedHeaders=host, Signature=aa')).toBeNull();
	});
});

// --- S3 proxy auth integration tests ---

describe('S3 proxy — auth flow', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it('rejects request with no Authorization header -> AccessDenied XML', async () => {
		const res = await SELF.fetch('http://localhost/s3/my-bucket/key.txt');
		expect(res.status).toBe(403);

		const body = await res.text();
		expect(body).toContain('<Code>AccessDenied</Code>');
		expect(body).toContain('Missing Authorization header');
		expect(res.headers.get('content-type')).toBe('application/xml');
	});

	it('rejects request with malformed Authorization header', async () => {
		const res = await SELF.fetch('http://localhost/s3/my-bucket/key.txt', {
			headers: { Authorization: 'Bearer some-token' },
		});
		expect(res.status).toBe(403);

		const body = await res.text();
		expect(body).toContain('<Code>AccessDenied</Code>');
	});

	it('rejects request with non-existent access key', async () => {
		const res = await SELF.fetch('http://localhost/s3/my-bucket/key.txt', {
			headers: {
				Authorization:
					'AWS4-HMAC-SHA256 Credential=GKNONEXISTENT000000/20260305/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=0000000000000000000000000000000000000000000000000000000000000000',
				'x-amz-date': '20260305T120000Z',
				'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
				Host: 'localhost',
			},
		});
		expect(res.status).toBe(403);

		const body = await res.text();
		expect(body).toContain('<Code>InvalidAccessKeyId</Code>');
	});

	it('rejects request with valid key but wrong signature', async () => {
		// Create a credential first
		const createRes = await SELF.fetch('http://localhost/admin/s3/credentials', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'sig-test',
				policy: {
					version: '2025-01-01',
					statements: [{ effect: 'allow', actions: ['s3:*'], resources: ['*'] }],
				},
			}),
		});
		const createData = await createRes.json<any>();
		const accessKeyId = createData.result.credential.access_key_id;
		localCreatedIds.push(accessKeyId);

		// Send request with wrong signature
		const res = await SELF.fetch('http://localhost/s3/my-bucket/key.txt', {
			headers: {
				Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260305/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=0000000000000000000000000000000000000000000000000000000000000000`,
				'x-amz-date': '20260305T120000Z',
				'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
				Host: 'localhost',
			},
		});
		expect(res.status).toBe(403);

		const body = await res.text();
		// Could be SignatureDoesNotMatch or timestamp error depending on clock
		expect(body).toContain('<Code>');
	});
});
