import { SELF, env, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, beforeEach, afterAll } from 'vitest';
import {
	ZONE_ID,
	adminHeaders,
	wildcardPolicy,
	createKeyWithPolicy,
	mockUpstreamSuccess,
	registerUpstreamToken,
	cleanupCreatedResources,
	__testClearInflightCache,
} from './helpers';
import { registerUpstreamR2 } from './s3-helpers';

// --- Expected security headers on every Worker-generated response ---

const EXPECTED_HEADERS: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'permissions-policy': 'camera=(), microphone=(), geolocation=(), document-domain=()',
	'content-security-policy':
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
};

function expectSecurityHeaders(res: Response) {
	for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
		expect(res.headers.get(name), `Missing or wrong header: ${name}`).toBe(value);
	}
}

// --- Setup ---

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

beforeEach(() => {
	__testClearInflightCache();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

afterAll(async () => {
	await cleanupCreatedResources();
});

// --- Tests ---

describe('Security headers - health endpoint', () => {
	it('GET /health includes all security headers', async () => {
		const res = await SELF.fetch('http://localhost/health');
		expect(res.status).toBe(200);
		expectSecurityHeaders(res);
	});
});

describe('Security headers - admin endpoints', () => {
	it('successful admin request includes security headers', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		expectSecurityHeaders(res);
	});

	it('rejected admin request (401) includes security headers', async () => {
		const res = await SELF.fetch('http://localhost/admin/keys', {
			headers: { 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(401);
		expectSecurityHeaders(res);
	});

	it('admin config endpoint includes security headers', async () => {
		const res = await SELF.fetch('http://localhost/admin/config', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		expectSecurityHeaders(res);
	});

	it('admin upstream-tokens endpoint includes security headers', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		expectSecurityHeaders(res);
	});

	it('admin upstream-r2 endpoint includes security headers', async () => {
		const res = await SELF.fetch('http://localhost/admin/upstream-r2', {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(200);
		expectSecurityHeaders(res);
	});
});

describe('Security headers - purge endpoint', () => {
	beforeAll(async () => {
		await registerUpstreamToken();
	});

	it('successful purge response includes security headers', async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy());
		mockUpstreamSuccess();

		const res = await SELF.fetch(`http://localhost/v1/zones/${ZONE_ID}/purge_cache`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${keyId}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ files: ['https://example.com/test.css'] }),
		});
		expect(res.status).toBe(200);
		expectSecurityHeaders(res);
	});

	it('unauthorized purge (no key) includes security headers', async () => {
		const res = await SELF.fetch(`http://localhost/v1/zones/${ZONE_ID}/purge_cache`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ files: ['https://example.com/test.css'] }),
		});
		// 401 or 403 — either way, headers should be present
		expect(res.status).toBeGreaterThanOrEqual(400);
		expectSecurityHeaders(res);
	});
});

describe('Security headers - S3 endpoint', () => {
	beforeAll(async () => {
		await registerUpstreamR2();
	});

	it('unauthenticated S3 request includes security headers', async () => {
		const res = await SELF.fetch('http://localhost/s3/', {
			method: 'GET',
		});
		// Should fail auth but still have security headers
		expect(res.status).toBeGreaterThanOrEqual(400);
		expectSecurityHeaders(res);
	});
});

describe('Security headers - do not interfere with functionality', () => {
	beforeAll(async () => {
		await registerUpstreamToken();
	});

	it('admin key CRUD still works with security headers middleware', async () => {
		// Create
		const createRes = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'sec-header-test',
				zone_id: ZONE_ID,
				policy: wildcardPolicy(),
			}),
		});
		expect(createRes.status).toBe(200);
		expectSecurityHeaders(createRes);

		const data = await createRes.json<any>();
		expect(data.success).toBe(true);
		const keyId = data.result.key.id;

		// List
		const listRes = await SELF.fetch('http://localhost/admin/keys', {
			headers: adminHeaders(),
		});
		expect(listRes.status).toBe(200);
		expectSecurityHeaders(listRes);
		const listData = await listRes.json<any>();
		expect(listData.success).toBe(true);
		expect(listData.result.length).toBeGreaterThan(0);

		// Revoke
		const revokeRes = await SELF.fetch(`http://localhost/admin/keys/${keyId}`, {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(revokeRes.status).toBe(200);
		expectSecurityHeaders(revokeRes);
	});

	it('config set/get/reset cycle works with security headers middleware', async () => {
		// Set
		const setRes = await SELF.fetch('http://localhost/admin/config', {
			method: 'PUT',
			headers: adminHeaders(),
			body: JSON.stringify({ bulk_rate: 99 }),
		});
		expect(setRes.status).toBe(200);
		expectSecurityHeaders(setRes);

		// Get
		const getRes = await SELF.fetch('http://localhost/admin/config', {
			headers: adminHeaders(),
		});
		expect(getRes.status).toBe(200);
		expectSecurityHeaders(getRes);
		const getdata = await getRes.json<any>();
		expect(getdata.result.config.bulk_rate).toBe(99);

		// Reset
		const resetRes = await SELF.fetch('http://localhost/admin/config/bulk_rate', {
			method: 'DELETE',
			headers: adminHeaders(),
		});
		expect(resetRes.status).toBe(200);
		expectSecurityHeaders(resetRes);
	});

	it('purge request body is not corrupted by middleware', async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy());
		mockUpstreamSuccess();

		const res = await SELF.fetch(`http://localhost/v1/zones/${ZONE_ID}/purge_cache`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${keyId}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				files: ['https://example.com/a.css', 'https://example.com/b.js'],
			}),
		});
		expect(res.status).toBe(200);
		expectSecurityHeaders(res);
		const body = await res.json<any>();
		expect(body.success).toBe(true);
	});
});
