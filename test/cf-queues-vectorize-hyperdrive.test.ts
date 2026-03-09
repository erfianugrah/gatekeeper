import { SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import {
	UPSTREAM_HOST,
	createAccountKey,
	registerAccountUpstreamToken,
	cleanupCreatedResources,
	__testClearInflightCache,
} from './helpers';
import type { PolicyDocument } from '../src/policy-types';

// ─── Constants ──────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaa1111bbbb2222cccc3333dddd4444';
const QUEUE_ID = 'queue-abc123-def456-789';
const CONSUMER_ID = 'consumer-xyz789';
const INDEX_NAME = 'my-embeddings';
const HYPERDRIVE_ID = 'hd-config-abc123';
const POLICY_VERSION = '2025-01-01' as const;

const CF_API = `/client/v4/accounts/${ACCOUNT_ID}`;

// ─── Policy factories ───────────────────────────────────────────────────────

function wildcardPolicy(prefix: string): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [{ effect: 'allow', actions: [`${prefix}:*`], resources: [`account:${ACCOUNT_ID}`] }],
	};
}

function readOnlyPolicy(prefix: string, readActions: string[]): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [{ effect: 'allow', actions: readActions, resources: [`account:${ACCOUNT_ID}`] }],
	};
}

function scopedPolicy(prefix: string, field: string, value: string): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: [
			{
				effect: 'allow',
				actions: [`${prefix}:*`],
				resources: [`account:${ACCOUNT_ID}`],
				conditions: [{ field, operator: 'eq', value }],
			},
		],
	};
}

// ─── Test helpers ───────────────────────────────────────────────────────────

function mockUpstream(method: string, path: string, status = 200, body?: string) {
	const defaultBody =
		status < 400
			? '{"success":true,"errors":[],"messages":[],"result":{}}'
			: `{"success":false,"errors":[{"code":${status},"message":"Error"}]}`;
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method, path })
		.reply(status, body ?? defaultBody, { headers: { 'Content-Type': 'application/json' } });
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	await registerAccountUpstreamToken(ACCOUNT_ID, 'cf-test-qvh-token-abcdef1234567890');
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

// ═══════════════════════════════════════════════════════════════════════════
// QUEUES
// ═══════════════════════════════════════════════════════════════════════════

describe('Queues proxy — CRUD', () => {
	it('proxies POST /queues (create)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('queues'));
		mockUpstream('POST', `${CF_API}/queues`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ queue_name: 'my-queue' }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /queues (list)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('queues'));
		mockUpstream('GET', `${CF_API}/queues`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /queues/:id (get)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('queues'));
		mockUpstream('GET', `${CF_API}/queues/${QUEUE_ID}`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies PUT /queues/:id (update)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('queues'));
		mockUpstream('PUT', `${CF_API}/queues/${QUEUE_ID}`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ queue_name: 'renamed-queue' }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies PATCH /queues/:id (edit)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('queues'));
		mockUpstream('PATCH', `${CF_API}/queues/${QUEUE_ID}`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
	});

	it('proxies DELETE /queues/:id', async () => {
		const keyId = await createAccountKey(wildcardPolicy('queues'));
		mockUpstream('DELETE', `${CF_API}/queues/${QUEUE_ID}`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});
});

describe('Queues proxy — messages', () => {
	it('proxies POST /queues/:id/messages (push)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('queues'));
		mockUpstream('POST', `${CF_API}/queues/${QUEUE_ID}/messages`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}/messages`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ body: 'hello' }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies POST /queues/:id/messages/batch (bulk push)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('queues'));
		mockUpstream('POST', `${CF_API}/queues/${QUEUE_ID}/messages/batch`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}/messages/batch`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ messages: [{ body: 'a' }, { body: 'b' }] }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies POST /queues/:id/messages/pull', async () => {
		const keyId = await createAccountKey(wildcardPolicy('queues'));
		mockUpstream('POST', `${CF_API}/queues/${QUEUE_ID}/messages/pull`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}/messages/pull`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ batch_size: 10 }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies POST /queues/:id/messages/ack', async () => {
		const keyId = await createAccountKey(wildcardPolicy('queues'));
		mockUpstream('POST', `${CF_API}/queues/${QUEUE_ID}/messages/ack`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}/messages/ack`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ acks: [], retries: [] }),
		});
		expect(res.status).toBe(200);
	});
});

describe('Queues proxy — purge + consumers', () => {
	it('proxies POST /queues/:id/purge', async () => {
		const keyId = await createAccountKey(wildcardPolicy('queues'));
		mockUpstream('POST', `${CF_API}/queues/${QUEUE_ID}/purge`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}/purge`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /queues/:id/purge (status)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('queues'));
		mockUpstream('GET', `${CF_API}/queues/${QUEUE_ID}/purge`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}/purge`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies POST /queues/:id/consumers (create)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('queues'));
		mockUpstream('POST', `${CF_API}/queues/${QUEUE_ID}/consumers`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}/consumers`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ script_name: 'my-consumer', environment: 'production' }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies DELETE /queues/:id/consumers/:cid', async () => {
		const keyId = await createAccountKey(wildcardPolicy('queues'));
		mockUpstream('DELETE', `${CF_API}/queues/${QUEUE_ID}/consumers/${CONSUMER_ID}`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}/consumers/${CONSUMER_ID}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});
});

describe('Queues proxy — policy enforcement', () => {
	it('403 when policy only allows read actions', async () => {
		const keyId = await createAccountKey(readOnlyPolicy('queues', ['queues:list', 'queues:get']));

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ queue_name: 'new' }),
		});
		expect(res.status).toBe(403);
	});

	it('403 when queue-scoped policy does not match queue_id', async () => {
		const keyId = await createAccountKey(scopedPolicy('queues', 'queues.queue_id', 'other-queue'));

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});

	it('allows when queue-scoped policy matches', async () => {
		const keyId = await createAccountKey(scopedPolicy('queues', 'queues.queue_id', QUEUE_ID));
		mockUpstream('GET', `${CF_API}/queues/${QUEUE_ID}`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// VECTORIZE
// ═══════════════════════════════════════════════════════════════════════════

describe('Vectorize proxy — index CRUD', () => {
	it('proxies POST /vectorize/v2/indexes (create)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('vectorize'));
		mockUpstream('POST', `${CF_API}/vectorize/v2/indexes`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: INDEX_NAME, config: { dimensions: 768, metric: 'cosine' } }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /vectorize/v2/indexes (list)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('vectorize'));
		mockUpstream('GET', `${CF_API}/vectorize/v2/indexes`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /vectorize/v2/indexes/:name', async () => {
		const keyId = await createAccountKey(wildcardPolicy('vectorize'));
		mockUpstream('GET', `${CF_API}/vectorize/v2/indexes/${INDEX_NAME}`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies DELETE /vectorize/v2/indexes/:name', async () => {
		const keyId = await createAccountKey(wildcardPolicy('vectorize'));
		mockUpstream('DELETE', `${CF_API}/vectorize/v2/indexes/${INDEX_NAME}`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});
});

describe('Vectorize proxy — operations', () => {
	it('proxies GET /indexes/:name/info', async () => {
		const keyId = await createAccountKey(wildcardPolicy('vectorize'));
		mockUpstream('GET', `${CF_API}/vectorize/v2/indexes/${INDEX_NAME}/info`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/info`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies POST /indexes/:name/query', async () => {
		const keyId = await createAccountKey(wildcardPolicy('vectorize'));
		mockUpstream('POST', `${CF_API}/vectorize/v2/indexes/${INDEX_NAME}/query`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/query`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ vector: [0.1, 0.2, 0.3], topK: 5 }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies POST /indexes/:name/insert (ndjson binary)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('vectorize'));
		mockUpstream('POST', `${CF_API}/vectorize/v2/indexes/${INDEX_NAME}/insert`);

		const ndjson = '{"id":"vec1","values":[0.1,0.2]}\n{"id":"vec2","values":[0.3,0.4]}\n';
		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/insert`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/x-ndjson' },
			body: ndjson,
		});
		expect(res.status).toBe(200);
	});

	it('proxies POST /indexes/:name/upsert (ndjson binary)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('vectorize'));
		mockUpstream('POST', `${CF_API}/vectorize/v2/indexes/${INDEX_NAME}/upsert`);

		const ndjson = '{"id":"vec1","values":[0.1,0.2]}\n';
		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/upsert`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/x-ndjson' },
			body: ndjson,
		});
		expect(res.status).toBe(200);
	});

	it('proxies POST /indexes/:name/get_by_ids', async () => {
		const keyId = await createAccountKey(wildcardPolicy('vectorize'));
		mockUpstream('POST', `${CF_API}/vectorize/v2/indexes/${INDEX_NAME}/get_by_ids`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/get_by_ids`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids: ['vec1', 'vec2'] }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies POST /indexes/:name/delete_by_ids', async () => {
		const keyId = await createAccountKey(wildcardPolicy('vectorize'));
		mockUpstream('POST', `${CF_API}/vectorize/v2/indexes/${INDEX_NAME}/delete_by_ids`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/delete_by_ids`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids: ['vec1'] }),
		});
		expect(res.status).toBe(200);
	});
});

describe('Vectorize proxy — metadata index', () => {
	it('proxies POST /indexes/:name/metadata_index/create', async () => {
		const keyId = await createAccountKey(wildcardPolicy('vectorize'));
		mockUpstream('POST', `${CF_API}/vectorize/v2/indexes/${INDEX_NAME}/metadata_index/create`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/metadata_index/create`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ propertyName: 'category', indexType: 'string' }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /indexes/:name/metadata_index/list', async () => {
		const keyId = await createAccountKey(wildcardPolicy('vectorize'));
		mockUpstream('GET', `${CF_API}/vectorize/v2/indexes/${INDEX_NAME}/metadata_index/list`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/metadata_index/list`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});
});

describe('Vectorize proxy — policy enforcement', () => {
	it('403 when read-only policy blocks insert', async () => {
		const keyId = await createAccountKey(readOnlyPolicy('vectorize', ['vectorize:list_indexes', 'vectorize:get_index', 'vectorize:query']));

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/insert`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/x-ndjson' },
			body: '{"id":"v1","values":[0.1]}\n',
		});
		expect(res.status).toBe(403);
	});

	it('403 when index-scoped policy does not match', async () => {
		const keyId = await createAccountKey(scopedPolicy('vectorize', 'vectorize.index_name', 'other-index'));

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});

	it('allows when index-scoped policy matches', async () => {
		const keyId = await createAccountKey(scopedPolicy('vectorize', 'vectorize.index_name', INDEX_NAME));
		mockUpstream('GET', `${CF_API}/vectorize/v2/indexes/${INDEX_NAME}`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// HYPERDRIVE
// ═══════════════════════════════════════════════════════════════════════════

describe('Hyperdrive proxy — CRUD', () => {
	it('proxies POST /hyperdrive/configs (create)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('hyperdrive'));
		mockUpstream('POST', `${CF_API}/hyperdrive/configs`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/hyperdrive/configs`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'my-pg',
				origin: { host: 'db.example.com', port: 5432, database: 'mydb', scheme: 'postgresql', user: 'u', password: 'p' },
			}),
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /hyperdrive/configs (list)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('hyperdrive'));
		mockUpstream('GET', `${CF_API}/hyperdrive/configs`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/hyperdrive/configs`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies GET /hyperdrive/configs/:id', async () => {
		const keyId = await createAccountKey(wildcardPolicy('hyperdrive'));
		mockUpstream('GET', `${CF_API}/hyperdrive/configs/${HYPERDRIVE_ID}`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/hyperdrive/configs/${HYPERDRIVE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});

	it('proxies PUT /hyperdrive/configs/:id (update)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('hyperdrive'));
		mockUpstream('PUT', `${CF_API}/hyperdrive/configs/${HYPERDRIVE_ID}`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/hyperdrive/configs/${HYPERDRIVE_ID}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'renamed' }),
		});
		expect(res.status).toBe(200);
	});

	it('proxies PATCH /hyperdrive/configs/:id (edit)', async () => {
		const keyId = await createAccountKey(wildcardPolicy('hyperdrive'));
		mockUpstream('PATCH', `${CF_API}/hyperdrive/configs/${HYPERDRIVE_ID}`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/hyperdrive/configs/${HYPERDRIVE_ID}`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
	});

	it('proxies DELETE /hyperdrive/configs/:id', async () => {
		const keyId = await createAccountKey(wildcardPolicy('hyperdrive'));
		mockUpstream('DELETE', `${CF_API}/hyperdrive/configs/${HYPERDRIVE_ID}`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/hyperdrive/configs/${HYPERDRIVE_ID}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});
});

describe('Hyperdrive proxy — policy enforcement', () => {
	it('403 when read-only policy blocks create', async () => {
		const keyId = await createAccountKey(readOnlyPolicy('hyperdrive', ['hyperdrive:list', 'hyperdrive:get']));

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/hyperdrive/configs`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${keyId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'blocked' }),
		});
		expect(res.status).toBe(403);
	});

	it('403 when config-scoped policy does not match', async () => {
		const keyId = await createAccountKey(scopedPolicy('hyperdrive', 'hyperdrive.config_id', 'other-id'));

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/hyperdrive/configs/${HYPERDRIVE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(403);
	});

	it('allows when config-scoped policy matches', async () => {
		const keyId = await createAccountKey(scopedPolicy('hyperdrive', 'hyperdrive.config_id', HYPERDRIVE_ID));
		mockUpstream('GET', `${CF_API}/hyperdrive/configs/${HYPERDRIVE_ID}`);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/hyperdrive/configs/${HYPERDRIVE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(200);
	});
});

// ─── Upstream error forwarding ──────────────────────────────────────────────

describe('CF proxy services — upstream error forwarding', () => {
	it('queues: forwards 404', async () => {
		const keyId = await createAccountKey(wildcardPolicy('queues'));
		mockUpstream('GET', `${CF_API}/queues/${QUEUE_ID}`, 404);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(404);
	});

	it('vectorize: forwards 429 with rate-limit headers', async () => {
		const keyId = await createAccountKey(wildcardPolicy('vectorize'));
		fetchMock
			.get(UPSTREAM_HOST)
			.intercept({ method: 'GET', path: `${CF_API}/vectorize/v2/indexes` })
			.reply(429, '{"success":false,"errors":[{"code":429,"message":"Rate limited"}]}', {
				headers: { 'Content-Type': 'application/json', 'Retry-After': '30', 'RateLimit-Remaining': '0' },
			});

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/vectorize/v2/indexes`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(429);
		expect(res.headers.get('Retry-After')).toBe('30');
	});

	it('hyperdrive: forwards 500', async () => {
		const keyId = await createAccountKey(wildcardPolicy('hyperdrive'));
		mockUpstream('GET', `${CF_API}/hyperdrive/configs/${HYPERDRIVE_ID}`, 500);

		const res = await SELF.fetch(`http://localhost/cf/accounts/${ACCOUNT_ID}/hyperdrive/configs/${HYPERDRIVE_ID}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${keyId}` },
		});
		expect(res.status).toBe(500);
	});
});
