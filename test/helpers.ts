import { SELF, fetchMock } from 'cloudflare:test';
import { __testClearInflightCache } from '../src/index';
import type { PolicyDocument } from '../src/policy-types';

export const ZONE_ID = 'aaaa1111bbbb2222cccc3333dddd4444';
export const ADMIN_KEY = 'test-admin-secret-key-12345';
export const UPSTREAM_HOST = 'https://api.cloudflare.com';
export const UPSTREAM_PATH = `/client/v4/zones/${ZONE_ID}/purge_cache`;
export const TEST_UPSTREAM_TOKEN = 'cf-test-upstream-token-abcdef1234567890';

export { __testClearInflightCache };

// ─── Cleanup tracker ────────────────────────────────────────────────────────

/** IDs of keys created during tests, for bulk cleanup in afterAll. */
const createdKeyIds: string[] = [];

/** IDs of upstream tokens created during tests, for bulk cleanup in afterAll. */
const createdUpstreamTokenIds: string[] = [];

/** Revoke a key via the admin API. */
export async function deleteKey(keyId: string): Promise<void> {
	await SELF.fetch(`http://localhost/admin/keys/${keyId}`, {
		method: 'DELETE',
		headers: adminHeaders(),
	});
}

/** Delete an upstream token via the admin API. */
export async function deleteUpstreamToken(tokenId: string): Promise<void> {
	await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
		method: 'DELETE',
		headers: adminHeaders(),
	});
}

/** Revoke all keys and upstream tokens created via tracked helpers. Call in afterAll. */
export async function cleanupCreatedResources(): Promise<void> {
	const keyDeletes = createdKeyIds.splice(0).map((id) => deleteKey(id));
	const tokenDeletes = createdUpstreamTokenIds.splice(0).map((id) => deleteUpstreamToken(id));
	await Promise.all([...keyDeletes, ...tokenDeletes]);
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

export function adminHeaders(extra?: Record<string, string>) {
	return {
		'X-Admin-Key': ADMIN_KEY,
		'Content-Type': 'application/json',
		...extra,
	};
}

/** Create a key via the admin API with a policy document. Returns the key ID. Auto-tracked for cleanup. */
export async function createKeyWithPolicy(
	policy: PolicyDocument | Record<string, unknown>,
	name = 'test-key',
	extra?: Record<string, unknown>,
): Promise<string> {
	const res = await SELF.fetch('http://localhost/admin/keys', {
		method: 'POST',
		headers: adminHeaders(),
		body: JSON.stringify({
			name,
			zone_id: ZONE_ID,
			policy,
			...extra,
		}),
	});
	const data = await res.json<any>();
	if (!data.success) throw new Error(`createKeyWithPolicy failed: ${JSON.stringify(data.errors)}`);
	createdKeyIds.push(data.result.key.id);
	return data.result.key.id;
}

/** Create a key with no zone_id (for account-scoped policies). Returns the key ID. Auto-tracked for cleanup. */
export async function createAccountKey(policy: PolicyDocument, name = 'cf-test-key'): Promise<string> {
	const res = await SELF.fetch('http://localhost/admin/keys', {
		method: 'POST',
		headers: adminHeaders(),
		body: JSON.stringify({ name, policy }),
	});
	const data = await res.json<any>();
	if (!data.success) throw new Error(`createAccountKey failed: ${JSON.stringify(data.errors)}`);
	createdKeyIds.push(data.result.key.id);
	return data.result.key.id;
}

// ─── Upstream token registration ────────────────────────────────────────────

/** Register a wildcard upstream CF API token. Call in beforeAll. Auto-tracked for cleanup. */
export async function registerUpstreamToken(zoneIds: string[] = ['*']): Promise<string> {
	const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
		method: 'POST',
		headers: adminHeaders(),
		body: JSON.stringify({
			name: 'test-upstream',
			token: TEST_UPSTREAM_TOKEN,
			zone_ids: zoneIds,
		}),
	});
	const data = await res.json<any>();
	if (!data.success) throw new Error(`registerUpstreamToken failed: ${JSON.stringify(data.errors)}`);
	createdUpstreamTokenIds.push(data.result.id);
	return data.result.id;
}

/** Register an account-scoped upstream CF API token. Call in beforeAll. Auto-tracked for cleanup. */
export async function registerAccountUpstreamToken(accountId: string, token: string, name = 'test-account-upstream'): Promise<string> {
	const res = await SELF.fetch('http://localhost/admin/upstream-tokens', {
		method: 'POST',
		headers: adminHeaders(),
		body: JSON.stringify({
			name,
			token,
			scope_type: 'account',
			zone_ids: [accountId],
		}),
	});
	const data = await res.json<any>();
	if (!data.success) throw new Error(`registerAccountUpstreamToken failed: ${JSON.stringify(data.errors)}`);
	createdUpstreamTokenIds.push(data.result.id);
	return data.result.id;
}

// ─── Upstream mocks ─────────────────────────────────────────────────────────

export function mockUpstreamSuccess(body = '{"success":true,"errors":[],"messages":[],"result":{"id":"test"}}') {
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method: 'POST', path: UPSTREAM_PATH })
		.reply(200, body, {
			headers: {
				'Content-Type': 'application/json',
				'cf-ray': 'mock-ray-123',
				'cf-auditlog-id': 'mock-audit-456',
			},
		});
}

export function mockUpstream429() {
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method: 'POST', path: UPSTREAM_PATH })
		.reply(429, '{"success":false,"errors":[{"code":429,"message":"Rate limited"}]}', {
			headers: {
				'Content-Type': 'application/json',
				'Retry-After': '10',
			},
		});
}

export function mockUpstream500() {
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method: 'POST', path: UPSTREAM_PATH })
		.reply(500, '{"success":false,"errors":[{"code":500,"message":"Internal Server Error"}]}', {
			headers: { 'Content-Type': 'application/json' },
		});
}

// ─── Analytics flush helper ─────────────────────────────────────────────────

/** Wait for fire-and-forget analytics writes dispatched via waitUntil() to flush to D1. */
export async function waitForAnalytics(ms = 500): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

// ─── Policy factories ───────────────────────────────────────────────────────

const POLICY_VERSION = '2025-01-01' as const;

/** Allow-all policy for a zone. Defaults to the test ZONE_ID. */
export function wildcardPolicy(zoneId = ZONE_ID): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [{ effect: 'allow', actions: ['purge:*'], resources: [`zone:${zoneId}`] }],
	};
}

/** Host-scoped policy. Defaults to the test ZONE_ID. */
export function hostPolicy(host: string, zoneId = ZONE_ID): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: ['purge:host'],
				resources: [`zone:${zoneId}`],
				conditions: [{ field: 'host', operator: 'eq', value: host }],
			},
		],
	};
}

/** URL prefix policy. Defaults to the test ZONE_ID. */
export function urlPrefixPolicy(prefix: string, zoneId = ZONE_ID): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: ['purge:url'],
				resources: [`zone:${zoneId}`],
				conditions: [{ field: 'url', operator: 'starts_with', value: prefix }],
			},
		],
	};
}

/** Tag policy. Defaults to the test ZONE_ID. */
export function tagPolicy(tag: string, zoneId = ZONE_ID): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: ['purge:tag'],
				resources: [`zone:${zoneId}`],
				conditions: [{ field: 'tag', operator: 'eq', value: tag }],
			},
		],
	};
}

/** Prefix purge policy. Defaults to the test ZONE_ID. */
export function prefixPolicy(prefix: string, zoneId = ZONE_ID): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: ['purge:prefix'],
				resources: [`zone:${zoneId}`],
				conditions: [{ field: 'prefix', operator: 'starts_with', value: prefix }],
			},
		],
	};
}

/** Purge-everything policy. Defaults to the test ZONE_ID. */
export function purgeEverythingPolicy(zoneId = ZONE_ID): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: ['purge:everything'],
				resources: [`zone:${zoneId}`],
			},
		],
	};
}
