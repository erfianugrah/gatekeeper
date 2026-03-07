import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import {
	wildcardPolicy as _wildcardPolicy,
	hostPolicy as _hostPolicy,
	tagPolicy as _tagPolicy,
	urlPrefixPolicy as _urlPrefixPolicy,
	prefixPolicy as _prefixPolicy,
	purgeEverythingPolicy as _purgeEverythingPolicy,
} from './helpers';
import type { CreateKeyRequest } from '../src/types';
import type { PolicyDocument } from '../src/policy-types';

// IAM tests use a dedicated zone ID (different from the purge/e2e test ZONE_ID)
const ZONE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';

// Bind shared policy factories to the local ZONE_ID
const wildcardPolicy = (zoneId = ZONE_ID): PolicyDocument => _wildcardPolicy(zoneId);
const hostPolicy = (host: string): PolicyDocument => _hostPolicy(host, ZONE_ID);
const tagPolicy = (tag: string): PolicyDocument => _tagPolicy(tag, ZONE_ID);
const urlPrefixPolicy = (prefix: string): PolicyDocument => _urlPrefixPolicy(prefix, ZONE_ID);
const prefixPolicy = (prefix: string): PolicyDocument => _prefixPolicy(prefix, ZONE_ID);
const purgeEverythingPolicy = (): PolicyDocument => _purgeEverythingPolicy(ZONE_ID);

function getStub() {
	const id = env.GATEKEEPER.idFromName('account');
	return env.GATEKEEPER.get(id);
}

/** Shorthand: create a key with a policy and return the key object. */
async function createKeyWithPolicy(
	name: string,
	policy: PolicyDocument,
	opts?: Partial<Pick<CreateKeyRequest, 'expires_in_days' | 'created_by' | 'rate_limit'>>,
) {
	const stub = getStub();
	const req: CreateKeyRequest = {
		name,
		zone_id: ZONE_ID,
		policy,
		...opts,
	};
	return stub.createKey(req);
}

// --- Tests ---

describe('IAM — key CRUD', () => {
	it('creates a key and retrieves it', async () => {
		const { key } = await createKeyWithPolicy('test-key', hostPolicy('example.com'));
		expect(key.id).toMatch(/^gw_[a-f0-9]{32}$/);
		expect(key.name).toBe('test-key');
		expect(key.zone_id).toBe(ZONE_ID);
		expect(key.revoked).toBe(0);
		expect(key.expires_at).toBeNull();
		expect(key.policy).toBeTruthy();

		// Retrieve the same key
		const stub = getStub();
		const retrieved = await stub.getKey(key.id);
		expect(retrieved).not.toBeNull();
		expect(retrieved!.key.id).toBe(key.id);
		expect(JSON.parse(retrieved!.key.policy)).toHaveProperty('statements');
	});

	it('creates a key with expiration', async () => {
		const { key } = await createKeyWithPolicy('expiring-key', hostPolicy('example.com'), {
			expires_in_days: 30,
		});
		expect(key.expires_at).not.toBeNull();
		expect(key.expires_at!).toBeGreaterThan(Date.now());
	});

	it('creates a key with created_by', async () => {
		const { key } = await createKeyWithPolicy('created-by-key', wildcardPolicy(), {
			created_by: 'admin@example.com',
		});
		expect(key.created_by).toBe('admin@example.com');
	});

	it('lists keys', async () => {
		const stub = getStub();
		await createKeyWithPolicy('key-a', hostPolicy('a.com'));
		await createKeyWithPolicy('key-b', hostPolicy('b.com'));

		const keys = await stub.listKeys(ZONE_ID);
		expect(keys.length).toBeGreaterThanOrEqual(2);
	});

	it("listKeys with 'active' filter excludes revoked keys", async () => {
		const stub = getStub();
		const { key: activeKey } = await createKeyWithPolicy('filter-active', hostPolicy('active.com'));
		const { key: revokedKey } = await createKeyWithPolicy('filter-revoked', hostPolicy('revoked.com'));
		await stub.revokeKey(revokedKey.id);

		const activeKeys = await stub.listKeys(ZONE_ID, 'active');
		const activeIds = activeKeys.map((k: any) => k.id);
		expect(activeIds).toContain(activeKey.id);
		expect(activeIds).not.toContain(revokedKey.id);
	});

	it("listKeys with 'revoked' filter returns only revoked keys", async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('filter-revoked-only', hostPolicy('rev.com'));
		await stub.revokeKey(key.id);

		const revokedKeys = await stub.listKeys(ZONE_ID, 'revoked');
		expect(revokedKeys.length).toBeGreaterThanOrEqual(1);
		for (const k of revokedKeys) {
			expect(k.revoked).toBe(1);
		}
	});

	it('revokes a key', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('revoke-me', hostPolicy('example.com'));

		const revoked = await stub.revokeKey(key.id);
		expect(revoked).toBe(true);

		// Revoking again returns false
		const revokedAgain = await stub.revokeKey(key.id);
		expect(revokedAgain).toBe(false);
	});

	it('getKey returns null for nonexistent key', async () => {
		const stub = getStub();
		const result = await stub.getKey('gw_does_not_exist_at_all_0000');
		expect(result).toBeNull();
	});
});

describe('IAM — authorization basics', () => {
	it('nonexistent key -> rejected', async () => {
		const stub = getStub();
		const result = await stub.authorizeFromBody('gw_nonexistent000000000000000000', ZONE_ID, {
			hosts: ['example.com'],
		});
		expect(result.authorized).toBe(false);
		expect(result.error).toBe('Invalid API key');
	});

	it('revoked key -> rejected', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('will-revoke', hostPolicy('example.com'));
		await stub.revokeKey(key.id);

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			hosts: ['example.com'],
		});
		expect(result.authorized).toBe(false);
		expect(result.error).toBe('API key has been revoked');
	});

	it('wrong zone -> rejected', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('zone-locked', hostPolicy('example.com'));

		const result = await stub.authorizeFromBody(key.id, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2', {
			hosts: ['example.com'],
		});
		expect(result.authorized).toBe(false);
		expect(result.error).toBe('API key is not authorized for this zone');
	});
});

describe('IAM — host authorization', () => {
	it('matching host -> allowed', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('host-key', hostPolicy('example.com'));

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			hosts: ['example.com'],
		});
		expect(result.authorized).toBe(true);
	});

	it('non-matching host -> denied', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('host-key-2', hostPolicy('example.com'));

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			hosts: ['other.com'],
		});
		expect(result.authorized).toBe(false);
		expect(result.denied).toContain('host:other.com');
	});

	it('multiple hosts — partial match -> denied with specifics', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('host-key-3', hostPolicy('a.com'));

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			hosts: ['a.com', 'b.com'],
		});
		expect(result.authorized).toBe(false);
		expect(result.denied).toContain('host:b.com');
		expect(result.denied).not.toContain('host:a.com');
	});
});

describe('IAM — URL authorization', () => {
	it('exact URL prefix -> allowed', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('url-key', urlPrefixPolicy('https://example.com/'));

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			files: ['https://example.com/page.html'],
		});
		expect(result.authorized).toBe(true);
	});

	it('partial URL prefix -> allowed', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('url-key-partial', urlPrefixPolicy('https://example.com/assets/'));

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			files: ['https://example.com/assets/style.css'],
		});
		expect(result.authorized).toBe(true);
	});

	it('non-matching URL prefix -> denied', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('url-key-no', urlPrefixPolicy('https://example.com/assets/'));

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			files: ['https://example.com/secret/file.txt'],
		});
		expect(result.authorized).toBe(false);
		expect(result.denied).toContain('https://example.com/secret/file.txt');
	});

	it('object-style file entry (url + headers) -> checks url field', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('url-key-obj', urlPrefixPolicy('https://example.com/'));

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			files: [{ url: 'https://example.com/page.html', headers: { Origin: 'https://example.com' } }],
		});
		expect(result.authorized).toBe(true);
	});
});

describe('IAM — tag authorization', () => {
	it('matching tag -> allowed', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('tag-key', tagPolicy('product-page'));

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			tags: ['product-page'],
		});
		expect(result.authorized).toBe(true);
	});

	it('non-matching tag -> denied', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('tag-key-2', tagPolicy('product-page'));

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			tags: ['admin-page'],
		});
		expect(result.authorized).toBe(false);
		expect(result.denied).toContain('tag:admin-page');
	});
});

describe('IAM — prefix authorization', () => {
	it('matching prefix -> allowed', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('pfx-key', prefixPolicy('example.com/blog'));

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			prefixes: ['example.com/blog/post-1'],
		});
		expect(result.authorized).toBe(true);
	});

	it('non-matching prefix -> denied', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('pfx-key-2', prefixPolicy('example.com/blog'));

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			prefixes: ['example.com/shop/item-1'],
		});
		expect(result.authorized).toBe(false);
		expect(result.denied).toContain('prefix:example.com/shop/item-1');
	});
});

describe('IAM — purge_everything authorization', () => {
	it('with purge_everything policy -> allowed', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('pe-key', purgeEverythingPolicy());

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			purge_everything: true,
		});
		expect(result.authorized).toBe(true);
	});

	it('without purge_everything action -> denied', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('pe-key-no', hostPolicy('example.com'));

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			purge_everything: true,
		});
		expect(result.authorized).toBe(false);
		expect(result.denied).toContain('purge_everything');
	});
});

describe('IAM — wildcard policy', () => {
	it('wildcard policy grants access to hosts', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('wildcard-key', wildcardPolicy());

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			hosts: ['anything.com', 'other.com'],
		});
		expect(result.authorized).toBe(true);
	});

	it('wildcard policy grants access to files', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('wildcard-files', wildcardPolicy());

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			files: ['https://example.com/a', 'https://example.com/b'],
		});
		expect(result.authorized).toBe(true);
	});

	it('wildcard policy grants purge_everything', async () => {
		const stub = getStub();
		const { key } = await createKeyWithPolicy('wildcard-pe', wildcardPolicy());

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			purge_everything: true,
		});
		expect(result.authorized).toBe(true);
	});
});

describe('IAM — multi-statement policies', () => {
	it('multiple statements cover different actions', async () => {
		const stub = getStub();
		const policy: PolicyDocument = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['purge:host'],
					resources: [`zone:${ZONE_ID}`],
					conditions: [{ field: 'host', operator: 'eq', value: 'a.com' }],
				},
				{
					effect: 'allow',
					actions: ['purge:host'],
					resources: [`zone:${ZONE_ID}`],
					conditions: [{ field: 'host', operator: 'eq', value: 'b.com' }],
				},
			],
		};
		const { key } = await createKeyWithPolicy('multi-stmt', policy);

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			hosts: ['a.com', 'b.com'],
		});
		expect(result.authorized).toBe(true);
	});

	it('mixed purge body (hosts + tags) requires coverage for both', async () => {
		const stub = getStub();

		// Only host statement — tags should be denied
		const { key: keyOnlyHosts } = await createKeyWithPolicy('only-hosts', hostPolicy('example.com'));
		const result1 = await stub.authorizeFromBody(keyOnlyHosts.id, ZONE_ID, {
			hosts: ['example.com'],
			tags: ['some-tag'],
		});
		expect(result1.authorized).toBe(false);
		expect(result1.denied).toContain('tag:some-tag');

		// Policy covering both hosts and tags
		const bothPolicy: PolicyDocument = {
			version: '2025-01-01',
			statements: [
				{
					effect: 'allow',
					actions: ['purge:host'],
					resources: [`zone:${ZONE_ID}`],
					conditions: [{ field: 'host', operator: 'eq', value: 'example.com' }],
				},
				{
					effect: 'allow',
					actions: ['purge:tag'],
					resources: [`zone:${ZONE_ID}`],
					conditions: [{ field: 'tag', operator: 'eq', value: 'some-tag' }],
				},
			],
		};
		const { key: keyBoth } = await createKeyWithPolicy('hosts-and-tags', bothPolicy);
		const result2 = await stub.authorizeFromBody(keyBoth.id, ZONE_ID, {
			hosts: ['example.com'],
			tags: ['some-tag'],
		});
		expect(result2.authorized).toBe(true);
	});
});

describe('IAM — expired key', () => {
	it('expired key -> rejected', async () => {
		const stub = getStub();

		// Use a tiny fractional expires_in_days so the key expires almost immediately.
		// 0.000012 days ~ 1037ms — generous enough to survive DO init latency and CI variance.
		// Then wait 1500ms to ensure we're well past expiry.
		const { key } = await createKeyWithPolicy('soon-expired', hostPolicy('example.com'), {
			expires_in_days: 0.000012,
		});

		// Wait well past expiry
		await new Promise((r) => setTimeout(r, 1500));

		const result = await stub.authorizeFromBody(key.id, ZONE_ID, {
			hosts: ['example.com'],
		});
		expect(result.authorized).toBe(false);
		expect(result.error).toBe('API key has expired');
	});
});
