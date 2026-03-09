import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import {
	UPSTREAM_HOST,
	adminHeaders,
	createAccountKey,
	registerAccountUpstreamToken,
	registerUpstreamToken,
	cleanupCreatedResources,
	__testClearInflightCache,
} from './helpers';
import { classifySqlCommand } from '../src/cf/d1/operations';
import type { PolicyDocument } from '../src/policy-types';

// ─── Constants ──────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaa1111bbbb2222cccc3333dddd4444';
const DATABASE_ID = 'dddd4444eeee5555-ffff-6666-7777-888899990000';
const TEST_UPSTREAM_TOKEN = 'cf-test-account-token-abcdef1234567890';
const POLICY_VERSION = '2025-01-01' as const;

const D1_BASE = `/cf/accounts/${ACCOUNT_ID}/d1`;
const CF_API_D1_PATH = `/client/v4/accounts/${ACCOUNT_ID}/d1`;

// ─── Policy factories ───────────────────────────────────────────────────────

function d1WildcardPolicy(): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [{ effect: 'allow', actions: ['d1:*'], resources: [`account:${ACCOUNT_ID}`] }],
	};
}

function d1ReadOnlyPolicy(): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [{ effect: 'allow', actions: ['d1:list', 'd1:get'], resources: [`account:${ACCOUNT_ID}`] }],
	};
}

function d1QueryOnlyPolicy(): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [{ effect: 'allow', actions: ['d1:query', 'd1:raw'], resources: [`account:${ACCOUNT_ID}`] }],
	};
}

function d1SelectOnlyPolicy(): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: ['d1:query'],
				resources: [`account:${ACCOUNT_ID}`],
				conditions: [{ field: 'd1.sql_command', operator: 'eq', value: 'select' }],
			},
		],
	};
}

function d1SingleDbPolicy(dbId: string): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: ['d1:*'],
				resources: [`account:${ACCOUNT_ID}`],
				conditions: [{ field: 'd1.database_id', operator: 'eq', value: dbId }],
			},
		],
	};
}

// ─── Test helpers ───────────────────────────────────────────────────────────

function mockD1Upstream(method: string, path: string, status = 200, body?: string) {
	const defaultBody =
		status < 400
			? '{"success":true,"errors":[],"messages":[],"result":{}}'
			: `{"success":false,"errors":[{"code":${status},"message":"Error"}]}`;
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method, path })
		.reply(status, body ?? defaultBody, { headers: { 'Content-Type': 'application/json' } });
}

function mockD1ListUpstream(databases: unknown[] = []) {
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method: 'GET', path: `${CF_API_D1_PATH}/database` })
		.reply(
			200,
			JSON.stringify({
				success: true,
				errors: [],
				messages: [],
				result: databases,
				result_info: { page: 1, per_page: 100, total_pages: 1, count: databases.length, total_count: databases.length },
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

// ─── Unit: SQL command classification ───────────────────────────────────────

describe('classifySqlCommand', () => {
	it('classifies SELECT', () => {
		expect(classifySqlCommand('SELECT * FROM users')).toBe('select');
	});

	it('classifies INSERT', () => {
		expect(classifySqlCommand('INSERT INTO users (name) VALUES (?)')).toBe('insert');
	});

	it('classifies UPDATE', () => {
		expect(classifySqlCommand('UPDATE users SET name = ? WHERE id = ?')).toBe('update');
	});

	it('classifies DELETE', () => {
		expect(classifySqlCommand('DELETE FROM users WHERE id = ?')).toBe('delete');
	});

	it('classifies CREATE', () => {
		expect(classifySqlCommand('CREATE TABLE users (id INTEGER PRIMARY KEY)')).toBe('create');
	});

	it('classifies DROP', () => {
		expect(classifySqlCommand('DROP TABLE users')).toBe('drop');
	});

	it('classifies ALTER', () => {
		expect(classifySqlCommand('ALTER TABLE users ADD COLUMN age INTEGER')).toBe('alter');
	});

	it('classifies PRAGMA', () => {
		expect(classifySqlCommand('PRAGMA table_info(users)')).toBe('pragma');
	});

	it('classifies unknown as other', () => {
		expect(classifySqlCommand('VACUUM')).toBe('other');
	});

	it('handles leading whitespace', () => {
		expect(classifySqlCommand('  \n  SELECT 1')).toBe('select');
	});

	it('is case-insensitive', () => {
		expect(classifySqlCommand('select * from t')).toBe('select');
	});
});

// ─── Authentication ─────────────────────────────────────────────────────────

describe('D1 proxy — authentication', () => {
	it('401 when no Authorization header', async () => {
		const res = await SELF.fetch(`http://localhost${D1_BASE}/database`, { method: 'GET' });
		expect(res.status).toBe(401);
		const data = await res.json<any>();
		expect(data.success).toBe(false);
	});

	it('401 with invalid key', async () => {
		const res = await SELF.fetch(`http://localhost${D1_BASE}/database`, {
			method: 'GET',
			headers: { Authorization: 'Bearer gw_invalid_key_that_does_not_exist' },
		});
		expect(res.status).toBe(401);
	});

	it('400 with invalid account ID format', async () => {
		const res = await SELF.fetch('http://localhost/cf/accounts/not-valid/d1/database', {
			method: 'GET',
			headers: { Authorization: 'Bearer gw_test' },
		});
		expect(res.status).toBe(400);
	});
});

// ─── List databases ─────────────────────────────────────────────────────────

describe('D1 proxy — list databases', () => {
	it('proxies GET list with wildcard policy', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());
		mockD1ListUpstream([
			{ uuid: 'db1', name: 'my-db', version: 'production', created_at: '2025-01-01' },
			{ uuid: 'db2', name: 'staging-db', version: 'production', created_at: '2025-01-02' },
		]);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result).toHaveLength(2);
	});

	it('403 when policy only allows d1:query', async () => {
		const keyId = await createAccountKey(d1QueryOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});
});

// ─── Create database ────────────────────────────────────────────────────────

describe('D1 proxy — create database', () => {
	it('proxies POST create with valid policy', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());
		mockD1Upstream('POST', `${CF_API_D1_PATH}/database`);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'new-db' }),
		});
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
	});

	it('400 with invalid JSON body', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: 'not json',
		});
		expect(res.status).toBe(400);
	});

	it('403 when read-only policy', async () => {
		const keyId = await createAccountKey(d1ReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'new-db' }),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Get single database ────────────────────────────────────────────────────

describe('D1 proxy — get database', () => {
	it('proxies GET by database ID', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());
		mockD1Upstream('GET', `${CF_API_D1_PATH}/database/${DATABASE_ID}`);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('403 when policy scoped to different database', async () => {
		const keyId = await createAccountKey(d1SingleDbPolicy('other-database-id'));

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});

	it('allows when policy scoped to matching database', async () => {
		const keyId = await createAccountKey(d1SingleDbPolicy(DATABASE_ID));
		mockD1Upstream('GET', `${CF_API_D1_PATH}/database/${DATABASE_ID}`);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});
});

// ─── Update database ────────────────────────────────────────────────────────

describe('D1 proxy — update database', () => {
	it('proxies PUT update', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());
		mockD1Upstream('PUT', `${CF_API_D1_PATH}/database/${DATABASE_ID}`);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ read_replication: { mode: 'auto' } }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies PATCH edit', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());
		mockD1Upstream('PATCH', `${CF_API_D1_PATH}/database/${DATABASE_ID}`);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
	});

	it('403 when read-only policy', async () => {
		const keyId = await createAccountKey(d1ReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Delete database ────────────────────────────────────────────────────────

describe('D1 proxy — delete database', () => {
	it('proxies DELETE', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());
		mockD1Upstream('DELETE', `${CF_API_D1_PATH}/database/${DATABASE_ID}`);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('403 when read-only policy', async () => {
		const keyId = await createAccountKey(d1ReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});
});

// ─── Query database ─────────────────────────────────────────────────────────

describe('D1 proxy — query', () => {
	it('proxies POST /query with valid policy', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());
		mockD1Upstream('POST', `${CF_API_D1_PATH}/database/${DATABASE_ID}/query`);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}/query`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ sql: 'SELECT * FROM users WHERE id = ?', params: [1] }),
		});
		expect(res.status).toBe(200);
	});

	it('400 with invalid JSON body', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}/query`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: 'not json',
		});
		expect(res.status).toBe(400);
	});

	it('403 when read-only policy (no d1:query)', async () => {
		const keyId = await createAccountKey(d1ReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}/query`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ sql: 'SELECT 1' }),
		});
		expect(res.status).toBe(403);
	});

	it('allows SELECT when select-only policy', async () => {
		const keyId = await createAccountKey(d1SelectOnlyPolicy());
		mockD1Upstream('POST', `${CF_API_D1_PATH}/database/${DATABASE_ID}/query`);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}/query`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ sql: 'SELECT * FROM users' }),
		});
		expect(res.status).toBe(200);
	});

	it('403 when INSERT but select-only policy', async () => {
		const keyId = await createAccountKey(d1SelectOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}/query`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ sql: 'INSERT INTO users (name) VALUES (?)' }),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Raw query ──────────────────────────────────────────────────────────────

describe('D1 proxy — raw', () => {
	it('proxies POST /raw with valid policy', async () => {
		const keyId = await createAccountKey(d1QueryOnlyPolicy());
		mockD1Upstream('POST', `${CF_API_D1_PATH}/database/${DATABASE_ID}/raw`);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}/raw`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ sql: 'SELECT * FROM users' }),
		});
		expect(res.status).toBe(200);
	});

	it('400 with invalid JSON body', async () => {
		const keyId = await createAccountKey(d1QueryOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}/raw`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: '{bad',
		});
		expect(res.status).toBe(400);
	});
});

// ─── Export database ────────────────────────────────────────────────────────

describe('D1 proxy — export', () => {
	it('proxies POST /export', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());
		mockD1Upstream('POST', `${CF_API_D1_PATH}/database/${DATABASE_ID}/export`);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}/export`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ output_format: 'polling' }),
		});
		expect(res.status).toBe(200);
	});

	it('403 when read-only policy', async () => {
		const keyId = await createAccountKey(d1ReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}/export`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ output_format: 'polling' }),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Import database ────────────────────────────────────────────────────────

describe('D1 proxy — import', () => {
	it('proxies POST /import', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());
		mockD1Upstream('POST', `${CF_API_D1_PATH}/database/${DATABASE_ID}/import`);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}/import`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'init', etag: 'abc123' }),
		});
		expect(res.status).toBe(200);
	});

	it('403 when query-only policy', async () => {
		const keyId = await createAccountKey(d1QueryOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}/import`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'init', etag: 'abc123' }),
		});
		expect(res.status).toBe(403);
	});
});

// ─── Time travel ────────────────────────────────────────────────────────────

describe('D1 proxy — time travel', () => {
	it('proxies GET /time_travel/bookmark', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());
		mockD1Upstream('GET', `${CF_API_D1_PATH}/database/${DATABASE_ID}/time_travel/bookmark`);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}/time_travel/bookmark`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies POST /time_travel/restore', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());
		mockD1Upstream('POST', `${CF_API_D1_PATH}/database/${DATABASE_ID}/time_travel/restore`);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}/time_travel/restore`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
	});

	it('403 when read-only policy', async () => {
		const keyId = await createAccountKey(d1ReadOnlyPolicy());

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}/time_travel/bookmark`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});
});

// ─── Upstream error forwarding ──────────────────────────────────────────────

describe('D1 proxy — upstream error forwarding', () => {
	it('forwards 404 from upstream', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());
		mockD1Upstream('GET', `${CF_API_D1_PATH}/database/${DATABASE_ID}`, 404);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(404);
		const data = await res.json<any>();
		expect(data.success).toBe(false);
	});

	it('forwards 500 from upstream', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());
		mockD1Upstream('GET', `${CF_API_D1_PATH}/database/${DATABASE_ID}`, 500);

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(500);
	});

	it('forwards rate-limit headers on 429', async () => {
		const keyId = await createAccountKey(d1WildcardPolicy());
		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: `${CF_API_D1_PATH}/database/${DATABASE_ID}` })
			.reply(429, '{"success":false,"errors":[{"code":429,"message":"Rate limited"}]}', {
				headers: {
					'Content-Type': 'application/json',
					'Retry-After': '30',
					'RateLimit-Remaining': '0',
				},
			});

		const res = await SELF.fetch(`http://localhost${D1_BASE}/database/${DATABASE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBe('30');
		expect(res.headers.get('RateLimit-Remaining')).toBe('0');
	});
});

// ─── No upstream token for account ──────────────────────────────────────────

describe('D1 proxy — missing upstream token', () => {
	it('502 when no upstream token for account', async () => {
		const otherAccountId = 'ffff0000eeee1111dddd2222cccc3333';
		const keyId = await createAccountKey({
			version: POLICY_VERSION,
			statements: [{ effect: 'allow', actions: ['d1:*'], resources: [`account:${otherAccountId}`] }],
		});

		const res = await SELF.fetch(`http://localhost/cf/accounts/${otherAccountId}/d1/database`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(502);
		const data = await res.json<any>();
		expect(data.errors[0].message).toContain('No upstream API token');
	});
});

// ─── Upstream token scope_type in admin API ─────────────────────────────────

describe('Upstream tokens — scope_type', () => {
	it('create account-scoped token and verify scope_type in list', async () => {
		const tokenId = await registerAccountUpstreamToken('*', 'cf-scope-type-test-token-abcdef0123456789', 'scope-type-test');

		// Verify in list
		const listRes = await SELF.fetch('http://localhost/admin/upstream-tokens', {
			headers: adminHeaders(),
		});
		const listData = await listRes.json<any>();
		const found = listData.result.find((t: any) => t.id === tokenId);
		expect(found).toBeDefined();
		expect(found.scope_type).toBe('account');

		// Verify in get
		const getRes = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			headers: adminHeaders(),
		});
		const getData = await getRes.json<any>();
		expect(getData.result.scope_type).toBe('account');
	});

	it('defaults to zone scope_type when not specified', async () => {
		const tokenId = await registerUpstreamToken(['*']);

		const getRes = await SELF.fetch(`http://localhost/admin/upstream-tokens/${tokenId}`, {
			headers: adminHeaders(),
		});
		const getData = await getRes.json<any>();
		expect(getData.result.scope_type).toBe('zone');
	});
});
