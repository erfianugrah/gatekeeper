import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import {
	ZONE_ID,
	ADMIN_KEY,
	UPSTREAM_HOST,
	adminHeaders,
	createKeyWithPolicy,
	registerUpstreamToken,
	cleanupCreatedResources,
	__testClearInflightCache,
	waitForAnalytics,
} from './helpers';
import type { PolicyDocument } from '../src/policy-types';

// ─── Constants ──────────────────────────────────────────────────────────────

const DNS_BASE = `/v1/zones/${ZONE_ID}/dns_records`;
const CF_API_DNS_PATH = `/client/v4/zones/${ZONE_ID}/dns_records`;
const POLICY_VERSION = '2025-01-01' as const;

// ─── Policy factories ───────────────────────────────────────────────────────

function dnsWildcardPolicy(zoneId = ZONE_ID): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [{ effect: 'allow', actions: ['dns:*'], resources: [`zone:${zoneId}`] }],
	};
}

function dnsReadOnlyPolicy(zoneId = ZONE_ID): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [{ effect: 'allow', actions: ['dns:read'], resources: [`zone:${zoneId}`] }],
	};
}

function dnsCreateOnlyPolicy(zoneId = ZONE_ID): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [{ effect: 'allow', actions: ['dns:create', 'dns:read'], resources: [`zone:${zoneId}`] }],
	};
}

function dnsTxtOnlyPolicy(zoneId = ZONE_ID): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: ['dns:create', 'dns:read', 'dns:delete'],
				resources: [`zone:${zoneId}`],
				conditions: [{ field: 'dns.type', operator: 'eq', value: 'TXT' }],
			},
		],
	};
}

function dnsAcmePolicy(zoneId = ZONE_ID): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: ['dns:create', 'dns:read', 'dns:delete'],
				resources: [`zone:${zoneId}`],
				conditions: [
					{ field: 'dns.type', operator: 'eq', value: 'TXT' },
					{ field: 'dns.name', operator: 'starts_with', value: '_acme-challenge.' },
				],
			},
		],
	};
}

// ─── Upstream mock helpers ──────────────────────────────────────────────────

function mockDnsUpstream(method: string, path: string, status = 200, body?: string) {
	const defaultBody =
		status < 400
			? '{"success":true,"errors":[],"messages":[],"result":{"id":"rec123","type":"A","name":"example.com","content":"1.2.3.4","ttl":300}}'
			: '{"success":false,"errors":[{"code":' + status + ',"message":"Error"}]}';
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method, path })
		.reply(status, body ?? defaultBody, { headers: { 'Content-Type': 'application/json' } });
}

function mockDnsListUpstream(records: unknown[] = []) {
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method: 'GET', path: CF_API_DNS_PATH })
		.reply(
			200,
			JSON.stringify({
				success: true,
				errors: [],
				messages: [],
				result: records,
				result_info: { page: 1, per_page: 100, total_pages: 1, count: records.length, total_count: records.length },
			}),
			{ headers: { 'Content-Type': 'application/json' } },
		);
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	await registerUpstreamToken();
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

// ─── Authentication ─────────────────────────────────────────────────────────

describe('DNS proxy — authentication', () => {
	it('401 when no Authorization header', async () => {
		const res = await SELF.fetch(`http://localhost${DNS_BASE}`, { method: 'GET' });
		expect(res.status).toBe(401);
		const data = await res.json<any>();
		expect(data.success).toBe(false);
	});

	it('401 with invalid key', async () => {
		const res = await SELF.fetch(`http://localhost${DNS_BASE}`, {
			method: 'GET',
			headers: { Authorization: 'Bearer gw_invalid_key_that_does_not_exist' },
		});
		expect(res.status).toBe(401);
	});

	it('400 with invalid zone ID format', async () => {
		const res = await SELF.fetch('http://localhost/v1/zones/not-a-valid-zone/dns_records', {
			method: 'GET',
			headers: { Authorization: 'Bearer gw_test' },
		});
		expect(res.status).toBe(400);
	});
});

// ─── List records ───────────────────────────────────────────────────────────

describe('DNS proxy — list records', () => {
	it('proxies GET list with wildcard policy', async () => {
		const keyId = await createKeyWithPolicy(dnsWildcardPolicy());
		mockDnsListUpstream([
			{ id: 'rec1', type: 'A', name: 'example.com', content: '1.2.3.4', ttl: 300 },
			{ id: 'rec2', type: 'AAAA', name: 'example.com', content: '::1', ttl: 300 },
		]);

		const res = await SELF.fetch(`http://localhost${DNS_BASE}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result).toHaveLength(2);
	});

	it('passes query params through to upstream', async () => {
		const keyId = await createKeyWithPolicy(dnsWildcardPolicy());
		// fetchMock matches on path prefix — query string is passed through
		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: `${CF_API_DNS_PATH}?type=A&name=example.com` })
			.reply(200, '{"success":true,"result":[],"result_info":{"total_count":0}}', {
				headers: { 'Content-Type': 'application/json' },
			});

		const res = await SELF.fetch(`http://localhost${DNS_BASE}?type=A&name=example.com`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('403 when read policy missing for dns:read', async () => {
		// Create a key with only dns:create, no dns:read
		const keyId = await createKeyWithPolicy({
			version: POLICY_VERSION,
			statements: [{ effect: 'allow', actions: ['dns:create'], resources: [`zone:${ZONE_ID}`] }],
		});

		const res = await SELF.fetch(`http://localhost${DNS_BASE}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});
});

// ─── Create record ──────────────────────────────────────────────────────────

describe('DNS proxy — create record', () => {
	it('proxies POST create with valid policy', async () => {
		const keyId = await createKeyWithPolicy(dnsWildcardPolicy());
		mockDnsUpstream('POST', CF_API_DNS_PATH);

		const res = await SELF.fetch(`http://localhost${DNS_BASE}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'A', name: 'test.example.com', content: '1.2.3.4', ttl: 300 }),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
	});

	it('400 with invalid JSON body', async () => {
		const keyId = await createKeyWithPolicy(dnsWildcardPolicy());

		const res = await SELF.fetch(`http://localhost${DNS_BASE}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: 'not json',
		});
		expect(res.status).toBe(400);
	});

	it('403 when policy restricts to TXT only', async () => {
		const keyId = await createKeyWithPolicy(dnsTxtOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${DNS_BASE}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'A', name: 'test.example.com', content: '1.2.3.4' }),
		});
		expect(res.status).toBe(403);
	});

	it('allows TXT create when policy restricts to TXT', async () => {
		const keyId = await createKeyWithPolicy(dnsTxtOnlyPolicy());
		mockDnsUpstream('POST', CF_API_DNS_PATH);

		const res = await SELF.fetch(`http://localhost${DNS_BASE}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'TXT', name: '_acme-challenge.example.com', content: 'validation-token' }),
		});
		expect(res.status).toBe(200);
	});

	it('ACME policy allows _acme-challenge TXT but denies other TXT names', async () => {
		const keyId = await createKeyWithPolicy(dnsAcmePolicy());

		// This should be denied — name doesn't start with _acme-challenge.
		const res = await SELF.fetch(`http://localhost${DNS_BASE}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'TXT', name: 'other.example.com', content: 'not-acme' }),
		});
		expect(res.status).toBe(403);
	});

	it('ACME policy allows _acme-challenge TXT create', async () => {
		const keyId = await createKeyWithPolicy(dnsAcmePolicy());
		mockDnsUpstream('POST', CF_API_DNS_PATH);

		const res = await SELF.fetch(`http://localhost${DNS_BASE}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'TXT', name: '_acme-challenge.example.com', content: 'token' }),
		});
		expect(res.status).toBe(200);
	});
});

// ─── Get single record ──────────────────────────────────────────────────────

describe('DNS proxy — get record', () => {
	it('proxies GET single record', async () => {
		const keyId = await createKeyWithPolicy(dnsReadOnlyPolicy());
		mockDnsUpstream('GET', `${CF_API_DNS_PATH}/rec123`);

		const res = await SELF.fetch(`http://localhost${DNS_BASE}/rec123`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.id).toBe('rec123');
	});
});

// ─── Update record ──────────────────────────────────────────────────────────

describe('DNS proxy — update record', () => {
	it('proxies PATCH update with dns:update policy', async () => {
		const keyId = await createKeyWithPolicy(dnsWildcardPolicy());
		mockDnsUpstream('PATCH', `${CF_API_DNS_PATH}/rec123`);

		const res = await SELF.fetch(`http://localhost${DNS_BASE}/rec123`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '2.3.4.5' }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies PUT overwrite', async () => {
		const keyId = await createKeyWithPolicy(dnsWildcardPolicy());
		mockDnsUpstream('PUT', `${CF_API_DNS_PATH}/rec123`);

		const res = await SELF.fetch(`http://localhost${DNS_BASE}/rec123`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'A', name: 'test.example.com', content: '2.3.4.5', ttl: 300 }),
		});
		expect(res.status).toBe(200);
	});

	it('403 when read-only policy tries to update', async () => {
		const keyId = await createKeyWithPolicy(dnsReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${DNS_BASE}/rec123`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '2.3.4.5' }),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Delete record ──────────────────────────────────────────────────────────

describe('DNS proxy — delete record', () => {
	it('proxies DELETE with wildcard policy', async () => {
		const keyId = await createKeyWithPolicy(dnsWildcardPolicy());
		// Pre-flight GET to fetch record details
		mockDnsUpstream('GET', `${CF_API_DNS_PATH}/rec123`);
		// Actual DELETE
		mockDnsUpstream('DELETE', `${CF_API_DNS_PATH}/rec123`);

		const res = await SELF.fetch(`http://localhost${DNS_BASE}/rec123`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('403 when read-only policy tries to delete', async () => {
		const keyId = await createKeyWithPolicy(dnsReadOnlyPolicy());
		// Pre-flight GET
		mockDnsUpstream('GET', `${CF_API_DNS_PATH}/rec123`);

		const res = await SELF.fetch(`http://localhost${DNS_BASE}/rec123`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});
});

// ─── Export ─────────────────────────────────────────────────────────────────

describe('DNS proxy — export', () => {
	it('proxies GET export with dns:export policy', async () => {
		const keyId = await createKeyWithPolicy({
			version: POLICY_VERSION,
			statements: [{ effect: 'allow', actions: ['dns:export', 'dns:read'], resources: [`zone:${ZONE_ID}`] }],
		});
		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: `${CF_API_DNS_PATH}/export` })
			.reply(200, '; BIND zone file\nexample.com. 300 IN A 1.2.3.4', { headers: { 'Content-Type': 'text/plain' } });

		const res = await SELF.fetch(`http://localhost${DNS_BASE}/export`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('403 when read-only policy tries export', async () => {
		const keyId = await createKeyWithPolicy(dnsReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${DNS_BASE}/export`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});
});

// ─── Batch ──────────────────────────────────────────────────────────────────

describe('DNS proxy — batch', () => {
	it('proxies batch with wildcard policy', async () => {
		const keyId = await createKeyWithPolicy(dnsWildcardPolicy());
		// Pre-flight GETs for deletes
		mockDnsUpstream('GET', `${CF_API_DNS_PATH}/rec-del1`);
		// Batch request
		mockDnsUpstream('POST', `${CF_API_DNS_PATH}/batch`, 200, '{"success":true,"result":{"deletes":[],"posts":[]}}');

		const res = await SELF.fetch(`http://localhost${DNS_BASE}/batch`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				deletes: [{ id: 'rec-del1' }],
				posts: [{ type: 'A', name: 'new.example.com', content: '5.6.7.8', ttl: 300 }],
			}),
		});
		expect(res.status).toBe(200);
	});

	it('403 when create-only policy tries batch with deletes', async () => {
		const keyId = await createKeyWithPolicy(dnsCreateOnlyPolicy());
		// Pre-flight GET for the delete target
		mockDnsUpstream('GET', `${CF_API_DNS_PATH}/rec-del1`);

		const res = await SELF.fetch(`http://localhost${DNS_BASE}/batch`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				deletes: [{ id: 'rec-del1' }],
			}),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Upstream error proxying ────────────────────────────────────────────────

describe('DNS proxy — upstream errors', () => {
	it('proxies 404 from upstream when record not found', async () => {
		const keyId = await createKeyWithPolicy(dnsWildcardPolicy());
		mockDnsUpstream('GET', `${CF_API_DNS_PATH}/nonexistent`, 404);

		const res = await SELF.fetch(`http://localhost${DNS_BASE}/nonexistent`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(404);
	});

	it('403 when key is zone-scoped to different zone', async () => {
		// Key is scoped to ZONE_ID, but request is for a different zone
		const otherZone = 'bbbb2222cccc3333dddd4444eeee5555';
		const keyId = await createKeyWithPolicy(dnsWildcardPolicy());

		const res = await SELF.fetch(`http://localhost/v1/zones/${otherZone}/dns_records`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		// Key zone_id doesn't match request zone -> 403
		expect(res.status).toBe(403);
	});
});

// ─── Analytics ──────────────────────────────────────────────────────────────

describe('DNS proxy — analytics', () => {
	it('DNS analytics events endpoint returns 200', async () => {
		const res = await SELF.fetch('http://localhost/admin/dns/analytics/events', { headers: adminHeaders() });
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(Array.isArray(data.result)).toBe(true);
	});

	it('DNS analytics summary endpoint returns 200', async () => {
		const res = await SELF.fetch('http://localhost/admin/dns/analytics/summary', { headers: adminHeaders() });
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.total_requests).toBeDefined();
	});

	it('DNS request logs event to analytics', async () => {
		const keyId = await createKeyWithPolicy(dnsWildcardPolicy());
		mockDnsListUpstream([{ id: 'rec1', type: 'A', name: 'example.com', content: '1.2.3.4' }]);

		await SELF.fetch(`http://localhost${DNS_BASE}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});

		await waitForAnalytics();

		const res = await SELF.fetch(`http://localhost/admin/dns/analytics/events?zone_id=${ZONE_ID}`, { headers: adminHeaders() });
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.length).toBeGreaterThanOrEqual(1);
		const event = data.result[0];
		expect(event.zone_id).toBe(ZONE_ID);
		expect(event.action).toBe('dns:read');
	});
});
