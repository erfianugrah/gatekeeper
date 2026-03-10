import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import {
	UPSTREAM_HOST,
	adminHeaders,
	createAccountKey,
	getAccountTokenId,
	registerAccountUpstreamToken,
	cleanupCreatedResources,
	__testClearInflightCache,
} from './helpers';
import type { PolicyDocument } from '../src/policy-types';

// ─── Constants ──────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaa1111bbbb2222cccc3333dddd4444';
const NAMESPACE_ID = 'nnnn1111ssss2222pppp3333aaaa4444';
const TEST_UPSTREAM_TOKEN = 'cf-test-account-token-abcdef1234567890';
const POLICY_VERSION = '2025-01-01' as const;

const KV_BASE = `/cf/accounts/${ACCOUNT_ID}/storage/kv`;
const CF_API_KV_PATH = `/client/v4/accounts/${ACCOUNT_ID}/storage/kv`;

// ─── Policy factories ───────────────────────────────────────────────────────

function kvWildcardPolicy(): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [{ effect: 'allow', actions: ['kv:*'], resources: [`account:${ACCOUNT_ID}`] }],
	};
}

function kvReadOnlyPolicy(): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: ['kv:list_namespaces', 'kv:get_namespace', 'kv:list_keys', 'kv:get_value', 'kv:get_metadata', 'kv:bulk_get'],
				resources: [`account:${ACCOUNT_ID}`],
			},
		],
	};
}

function kvNamespaceAdminPolicy(): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: ['kv:create_namespace', 'kv:list_namespaces', 'kv:get_namespace', 'kv:update_namespace', 'kv:delete_namespace'],
				resources: [`account:${ACCOUNT_ID}`],
			},
		],
	};
}

function kvSingleNamespacePolicy(nsId: string): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: ['kv:*'],
				resources: [`account:${ACCOUNT_ID}`],
				conditions: [{ field: 'kv.namespace_id', operator: 'eq', value: nsId }],
			},
		],
	};
}

function kvWriteOnlyPolicy(): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: ['kv:put_value', 'kv:delete_value', 'kv:bulk_write', 'kv:bulk_delete'],
				resources: [`account:${ACCOUNT_ID}`],
			},
		],
	};
}

// ─── Test helpers ───────────────────────────────────────────────────────────

function mockKvUpstream(method: string, path: string, status = 200, body?: string) {
	const defaultBody =
		status < 400
			? '{"success":true,"errors":[],"messages":[],"result":{}}'
			: `{"success":false,"errors":[{"code":${status},"message":"Error"}]}`;
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method, path })
		.reply(status, body ?? defaultBody, { headers: { 'Content-Type': 'application/json' } });
}

function mockKvListUpstream(namespaces: unknown[] = []) {
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method: 'GET', path: `${CF_API_KV_PATH}/namespaces` })
		.reply(
			200,
			JSON.stringify({
				success: true,
				errors: [],
				messages: [],
				result: namespaces,
				result_info: { page: 1, per_page: 100, total_pages: 1, count: namespaces.length, total_count: namespaces.length },
			}),
			{ headers: { 'Content-Type': 'application/json' } },
		);
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	await registerAccountUpstreamToken(ACCOUNT_ID, TEST_UPSTREAM_TOKEN);
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

describe('KV proxy — authentication', () => {
	it('401 when no Authorization header', async () => {
		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces`, { method: 'GET' });
		expect(res.status).toBe(401);
		const data = await res.json<any>();
		expect(data.success).toBe(false);
	});

	it('401 with invalid key', async () => {
		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces`, {
			method: 'GET',
			headers: { Authorization: 'Bearer gw_invalid_key_that_does_not_exist' },
		});
		expect(res.status).toBe(401);
	});

	it('400 with invalid account ID format', async () => {
		const res = await SELF.fetch('http://localhost/cf/accounts/not-valid/storage/kv/namespaces', {
			method: 'GET',
			headers: { Authorization: 'Bearer gw_test' },
		});
		expect(res.status).toBe(400);
	});
});

// ─── List namespaces ────────────────────────────────────────────────────────

describe('KV proxy — list namespaces', () => {
	it('proxies GET list with wildcard policy', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		mockKvListUpstream([
			{ id: 'ns1', title: 'my-kv', supports_url_encoding: true },
			{ id: 'ns2', title: 'staging-kv', supports_url_encoding: false },
		]);

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result).toHaveLength(2);
	});

	it('403 when policy only allows writes', async () => {
		const keyId = await createAccountKey(kvWriteOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});
});

// ─── Create namespace ───────────────────────────────────────────────────────

describe('KV proxy — create namespace', () => {
	it('proxies POST create with valid policy', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		mockKvUpstream('POST', `${CF_API_KV_PATH}/namespaces`);

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'new-kv' }),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
	});

	it('400 with invalid JSON body', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: 'not json',
		});
		expect(res.status).toBe(400);
	});

	it('403 when read-only policy', async () => {
		const keyId = await createAccountKey(kvReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'new-kv' }),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Get namespace ──────────────────────────────────────────────────────────

describe('KV proxy — get namespace', () => {
	it('proxies GET by namespace ID', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		mockKvUpstream('GET', `${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}`);

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('403 when policy scoped to different namespace', async () => {
		const keyId = await createAccountKey(kvSingleNamespacePolicy('other-namespace-id'));

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});

	it('allows when policy scoped to matching namespace', async () => {
		const keyId = await createAccountKey(kvSingleNamespacePolicy(NAMESPACE_ID));
		mockKvUpstream('GET', `${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}`);

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});
});

// ─── Update namespace ───────────────────────────────────────────────────────

describe('KV proxy — update namespace', () => {
	it('proxies PUT update', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		mockKvUpstream('PUT', `${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}`);

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'renamed-kv' }),
		});
		expect(res.status).toBe(200);
	});

	it('403 when read-only policy', async () => {
		const keyId = await createAccountKey(kvReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'renamed-kv' }),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Delete namespace ───────────────────────────────────────────────────────

describe('KV proxy — delete namespace', () => {
	it('proxies DELETE', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		mockKvUpstream('DELETE', `${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}`);

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('403 when read-only policy', async () => {
		const keyId = await createAccountKey(kvReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});
});

// ─── List keys ──────────────────────────────────────────────────────────────

describe('KV proxy — list keys', () => {
	it('proxies GET keys with valid policy', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: `${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}/keys` })
			.reply(
				200,
				JSON.stringify({
					success: true,
					errors: [],
					messages: [],
					result: [
						{ name: 'key1', expiration: 1700000000 },
						{ name: 'key2', metadata: { type: 'config' } },
					],
					result_info: { cursor: '', count: 2 },
				}),
				{ headers: { 'Content-Type': 'application/json' } },
			);

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/keys`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result).toHaveLength(2);
	});

	it('403 when write-only policy', async () => {
		const keyId = await createAccountKey(kvWriteOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/keys`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});
});

// ─── Put value ──────────────────────────────────────────────────────────────

describe('KV proxy — put value', () => {
	it('proxies PUT value with multipart body', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		mockKvUpstream('PUT', `${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}/values/my-key`);

		const formData = new FormData();
		formData.append('value', 'hello world');
		formData.append('metadata', JSON.stringify({ version: 1 }));

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/values/my-key`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}` },
			body: formData,
		});
		expect(res.status).toBe(200);
	});

	it('403 when read-only policy', async () => {
		const keyId = await createAccountKey(kvReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/values/my-key`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: '"hello"',
		});
		expect(res.status).toBe(403);
	});
});

// ─── Get value (binary) ─────────────────────────────────────────────────────

describe('KV proxy — get value', () => {
	it('proxies GET value (binary passthrough)', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		const binaryContent = 'raw-binary-content-here';
		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: `${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}/values/my-key` })
			.reply(200, binaryContent, {
				headers: { 'Content-Type': 'application/octet-stream' },
			});

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/values/my-key`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
		const body = await res.text();
		expect(body).toBe(binaryContent);
	});

	it('403 when write-only policy', async () => {
		const keyId = await createAccountKey(kvWriteOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/values/my-key`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});
});

// ─── Delete value ───────────────────────────────────────────────────────────

describe('KV proxy — delete value', () => {
	it('proxies DELETE value', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		mockKvUpstream('DELETE', `${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}/values/my-key`);

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/values/my-key`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('403 when read-only policy', async () => {
		const keyId = await createAccountKey(kvReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/values/my-key`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});
});

// ─── Get metadata ───────────────────────────────────────────────────────────

describe('KV proxy — get metadata', () => {
	it('proxies GET metadata', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		mockKvUpstream(
			'GET',
			`${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}/metadata/my-key`,
			200,
			'{"success":true,"errors":[],"messages":[],"result":{"version":1,"type":"config"}}',
		);

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/metadata/my-key`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.version).toBe(1);
	});

	it('403 when write-only policy', async () => {
		const keyId = await createAccountKey(kvWriteOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/metadata/my-key`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});
});

// ─── Bulk write ─────────────────────────────────────────────────────────────

describe('KV proxy — bulk write', () => {
	it('proxies PUT bulk write', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		mockKvUpstream(
			'PUT',
			`${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}/bulk`,
			200,
			'{"success":true,"errors":[],"messages":[],"result":{"successful_key_count":2}}',
		);

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/bulk`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify([
				{ key: 'k1', value: 'v1' },
				{ key: 'k2', value: 'v2' },
			]),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.successful_key_count).toBe(2);
	});

	it('403 when read-only policy', async () => {
		const keyId = await createAccountKey(kvReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/bulk`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify([{ key: 'k1', value: 'v1' }]),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Bulk delete ────────────────────────────────────────────────────────────

describe('KV proxy — bulk delete', () => {
	it('proxies POST bulk delete', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		mockKvUpstream(
			'POST',
			`${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}/bulk/delete`,
			200,
			'{"success":true,"errors":[],"messages":[],"result":{"successful_key_count":2}}',
		);

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/bulk/delete`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(['k1', 'k2']),
		});
		expect(res.status).toBe(200);
	});

	it('403 when read-only policy', async () => {
		const keyId = await createAccountKey(kvReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/bulk/delete`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(['k1']),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Bulk get ───────────────────────────────────────────────────────────────

describe('KV proxy — bulk get', () => {
	it('proxies POST bulk get', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		mockKvUpstream(
			'POST',
			`${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}/bulk/get`,
			200,
			'{"success":true,"errors":[],"messages":[],"result":{"values":{"k1":"v1","k2":"v2"}}}',
		);

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/bulk/get`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ keys: ['k1', 'k2'] }),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.values.k1).toBe('v1');
	});

	it('403 when write-only policy', async () => {
		const keyId = await createAccountKey(kvWriteOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/bulk/get`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ keys: ['k1'] }),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Upstream error forwarding ──────────────────────────────────────────────

describe('KV proxy — upstream error forwarding', () => {
	it('forwards 404 from upstream', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		mockKvUpstream('GET', `${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}`, 404);

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(404);
		const data = await res.json<any>();
		expect(data.success).toBe(false);
	});

	it('forwards 500 from upstream', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		mockKvUpstream('GET', `${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}`, 500);

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(500);
	});

	it('forwards rate-limit headers on 429', async () => {
		const keyId = await createAccountKey(kvWildcardPolicy());
		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: `${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}` })
			.reply(429, '{"success":false,"errors":[{"code":429,"message":"Rate limited"}]}', {
				headers: {
					'Content-Type': 'application/json',
					'Retry-After': '30',
					'RateLimit-Remaining': '0',
				},
			});

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBe('30');
		expect(res.headers.get('RateLimit-Remaining')).toBe('0');
	});
});

// ─── No upstream token for account ──────────────────────────────────────────

describe('KV proxy — token binding rejects mismatched account', () => {
	it('400 when key resources target a different account than the upstream token', async () => {
		const otherAccountId = 'ffff0000eeee1111dddd2222cccc3333';
		const res = await SELF.fetch('http://localhost/admin/keys', {
			method: 'POST',
			headers: adminHeaders(),
			body: JSON.stringify({
				name: 'mismatched-account',
				upstream_token_id: getAccountTokenId(),
				policy: {
					version: POLICY_VERSION,
					statements: [{ effect: 'allow', actions: ['kv:*'], resources: [`account:${otherAccountId}`] }],
				},
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toContain('does not match');
	});
});

// ─── Namespace-scoped policy enforcement ────────────────────────────────────

describe('KV proxy — namespace-scoped policy', () => {
	it('allows list keys on matching namespace', async () => {
		const keyId = await createAccountKey(kvSingleNamespacePolicy(NAMESPACE_ID));
		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: `${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}/keys` })
			.reply(200, '{"success":true,"errors":[],"messages":[],"result":[],"result_info":{"cursor":"","count":0}}', {
				headers: { 'Content-Type': 'application/json' },
			});

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/keys`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('403 for list keys on wrong namespace', async () => {
		const keyId = await createAccountKey(kvSingleNamespacePolicy('other-ns-id'));

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/keys`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});

	it('allows put value on matching namespace', async () => {
		const keyId = await createAccountKey(kvSingleNamespacePolicy(NAMESPACE_ID));
		mockKvUpstream('PUT', `${CF_API_KV_PATH}/namespaces/${NAMESPACE_ID}/values/test-key`);

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/values/test-key`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'text/plain' },
			body: 'hello',
		});
		expect(res.status).toBe(200);
	});

	it('403 for delete value on wrong namespace', async () => {
		const keyId = await createAccountKey(kvSingleNamespacePolicy('other-ns-id'));

		const res = await SELF.fetch(`http://localhost${KV_BASE}/namespaces/${NAMESPACE_ID}/values/test-key`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});
});
