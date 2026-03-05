import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { CreateKeyRequest, PurgeBody } from "../src/types";

const ZONE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";

function getStub() {
	const id = env.PURGE_RATE_LIMITER.idFromName("account");
	return env.PURGE_RATE_LIMITER.get(id);
}

describe("IAM — key CRUD", () => {
	it("creates a key and retrieves it", async () => {
		const stub = getStub();
		const req: CreateKeyRequest = {
			name: "test-key",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "host", scope_value: "example.com" }],
		};

		const { key, scopes } = await stub.createKey(req);
		expect(key.id).toMatch(/^gw_[a-f0-9]{32}$/);
		expect(key.name).toBe("test-key");
		expect(key.zone_id).toBe(ZONE_ID);
		expect(key.revoked).toBe(0);
		expect(key.expires_at).toBeNull();
		expect(scopes).toHaveLength(1);
		expect(scopes[0].scope_type).toBe("host");
		expect(scopes[0].scope_value).toBe("example.com");

		// Retrieve the same key
		const retrieved = await stub.getKey(key.id);
		expect(retrieved).not.toBeNull();
		expect(retrieved!.key.id).toBe(key.id);
		expect(retrieved!.scopes).toHaveLength(1);
	});

	it("creates a key with expiration", async () => {
		const stub = getStub();
		const req: CreateKeyRequest = {
			name: "expiring-key",
			zone_id: ZONE_ID,
			expires_in_days: 30,
			scopes: [{ scope_type: "host", scope_value: "example.com" }],
		};
		const { key } = await stub.createKey(req);
		expect(key.expires_at).not.toBeNull();
		expect(key.expires_at!).toBeGreaterThan(Date.now());
	});

	it("lists keys", async () => {
		const stub = getStub();
		await stub.createKey({
			name: "key-a",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "host", scope_value: "a.com" }],
		});
		await stub.createKey({
			name: "key-b",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "host", scope_value: "b.com" }],
		});

		const keys = await stub.listKeys(ZONE_ID);
		expect(keys.length).toBeGreaterThanOrEqual(2);
	});

	it("listKeys with 'active' filter excludes revoked keys", async () => {
		const stub = getStub();
		const { key: activeKey } = await stub.createKey({
			name: "filter-active",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "host", scope_value: "active.com" }],
		});
		const { key: revokedKey } = await stub.createKey({
			name: "filter-revoked",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "host", scope_value: "revoked.com" }],
		});
		await stub.revokeKey(revokedKey.id);

		const activeKeys = await stub.listKeys(ZONE_ID, "active");
		const activeIds = activeKeys.map((k) => k.id);
		expect(activeIds).toContain(activeKey.id);
		expect(activeIds).not.toContain(revokedKey.id);
	});

	it("listKeys with 'revoked' filter returns only revoked keys", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "filter-revoked-only",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "host", scope_value: "rev.com" }],
		});
		await stub.revokeKey(key.id);

		const revokedKeys = await stub.listKeys(ZONE_ID, "revoked");
		expect(revokedKeys.length).toBeGreaterThanOrEqual(1);
		for (const k of revokedKeys) {
			expect(k.revoked).toBe(1);
		}
	});

	it("revokes a key", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "revoke-me",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "host", scope_value: "example.com" }],
		});

		const revoked = await stub.revokeKey(key.id);
		expect(revoked).toBe(true);

		// Revoking again returns false
		const revokedAgain = await stub.revokeKey(key.id);
		expect(revokedAgain).toBe(false);
	});

	it("getKey returns null for nonexistent key", async () => {
		const stub = getStub();
		const result = await stub.getKey("pgw_does_not_exist_at_all_00");
		expect(result).toBeNull();
	});
});

describe("IAM — authorization", () => {
	it("nonexistent key → rejected", async () => {
		const stub = getStub();
		const result = await stub.authorize("pgw_nonexistent00000000000000000", ZONE_ID, {
			hosts: ["example.com"],
		});
		expect(result.authorized).toBe(false);
		expect(result.error).toBe("Invalid API key");
	});

	it("revoked key → rejected", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "will-revoke",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "host", scope_value: "example.com" }],
		});
		await stub.revokeKey(key.id);

		const result = await stub.authorize(key.id, ZONE_ID, {
			hosts: ["example.com"],
		});
		expect(result.authorized).toBe(false);
		expect(result.error).toBe("API key has been revoked");
	});

	it("wrong zone → rejected", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "zone-locked",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "host", scope_value: "example.com" }],
		});

		const result = await stub.authorize(key.id, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2", {
			hosts: ["example.com"],
		});
		expect(result.authorized).toBe(false);
		expect(result.error).toBe("API key is not authorized for this zone");
	});
});

describe("IAM — scope checking: host", () => {
	it("matching host → allowed", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "host-key",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "host", scope_value: "example.com" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			hosts: ["example.com"],
		});
		expect(result.authorized).toBe(true);
	});

	it("non-matching host → denied", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "host-key-2",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "host", scope_value: "example.com" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			hosts: ["other.com"],
		});
		expect(result.authorized).toBe(false);
		expect(result.denied).toContain("host:other.com");
	});

	it("multiple hosts — partial match → denied with specifics", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "host-key-3",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "host", scope_value: "a.com" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			hosts: ["a.com", "b.com"],
		});
		expect(result.authorized).toBe(false);
		expect(result.denied).toContain("host:b.com");
		expect(result.denied).not.toContain("host:a.com");
	});
});

describe("IAM — scope checking: url_prefix", () => {
	it("exact URL prefix → allowed", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "url-key",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "url_prefix", scope_value: "https://example.com/" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			files: ["https://example.com/page.html"],
		});
		expect(result.authorized).toBe(true);
	});

	it("partial URL prefix → allowed", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "url-key-partial",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "url_prefix", scope_value: "https://example.com/assets/" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			files: ["https://example.com/assets/style.css"],
		});
		expect(result.authorized).toBe(true);
	});

	it("non-matching URL prefix → denied", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "url-key-no",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "url_prefix", scope_value: "https://example.com/assets/" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			files: ["https://example.com/secret/file.txt"],
		});
		expect(result.authorized).toBe(false);
		expect(result.denied).toContain("https://example.com/secret/file.txt");
	});

	it("object-style file entry (url + headers) → checks url field", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "url-key-obj",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "url_prefix", scope_value: "https://example.com/" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			files: [{ url: "https://example.com/page.html", headers: { Origin: "https://example.com" } }],
		});
		expect(result.authorized).toBe(true);
	});
});

describe("IAM — scope checking: tag", () => {
	it("matching tag → allowed", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "tag-key",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "tag", scope_value: "product-page" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			tags: ["product-page"],
		});
		expect(result.authorized).toBe(true);
	});

	it("non-matching tag → denied", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "tag-key-2",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "tag", scope_value: "product-page" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			tags: ["admin-page"],
		});
		expect(result.authorized).toBe(false);
		expect(result.denied).toContain("tag:admin-page");
	});
});

describe("IAM — scope checking: prefix", () => {
	it("matching prefix → allowed", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "pfx-key",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "prefix", scope_value: "example.com/blog" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			prefixes: ["example.com/blog/post-1"],
		});
		expect(result.authorized).toBe(true);
	});

	it("non-matching prefix → denied", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "pfx-key-2",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "prefix", scope_value: "example.com/blog" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			prefixes: ["example.com/shop/item-1"],
		});
		expect(result.authorized).toBe(false);
		expect(result.denied).toContain("prefix:example.com/shop/item-1");
	});
});

describe("IAM — scope checking: purge_everything", () => {
	it("with purge_everything scope → allowed", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "pe-key",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "purge_everything", scope_value: "true" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			purge_everything: true,
		});
		expect(result.authorized).toBe(true);
	});

	it("without purge_everything scope → denied", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "pe-key-no",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "host", scope_value: "example.com" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			purge_everything: true,
		});
		expect(result.authorized).toBe(false);
		expect(result.denied).toContain("purge_everything");
	});
});

describe("IAM — scope checking: wildcard", () => {
	it("wildcard scope grants access to hosts", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "wildcard-key",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "*", scope_value: "*" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			hosts: ["anything.com", "other.com"],
		});
		expect(result.authorized).toBe(true);
	});

	it("wildcard scope grants access to files", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "wildcard-files",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "*", scope_value: "*" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			files: ["https://example.com/a", "https://example.com/b"],
		});
		expect(result.authorized).toBe(true);
	});

	it("wildcard scope grants purge_everything", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "wildcard-pe",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "*", scope_value: "*" }],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			purge_everything: true,
		});
		expect(result.authorized).toBe(true);
	});
});

describe("IAM — scope checking: multiple scopes", () => {
	it("at least one scope must match per item", async () => {
		const stub = getStub();
		const { key } = await stub.createKey({
			name: "multi-scope",
			zone_id: ZONE_ID,
			scopes: [
				{ scope_type: "host", scope_value: "a.com" },
				{ scope_type: "host", scope_value: "b.com" },
			],
		});

		const result = await stub.authorize(key.id, ZONE_ID, {
			hosts: ["a.com", "b.com"],
		});
		expect(result.authorized).toBe(true);
	});

	it("mixed purge body (hosts + tags) requires scopes for both", async () => {
		const stub = getStub();
		const { key: keyOnlyHosts } = await stub.createKey({
			name: "only-hosts",
			zone_id: ZONE_ID,
			scopes: [{ scope_type: "host", scope_value: "example.com" }],
		});

		// Has hosts scope but not tags scope → denied
		const result1 = await stub.authorize(keyOnlyHosts.id, ZONE_ID, {
			hosts: ["example.com"],
			tags: ["some-tag"],
		});
		expect(result1.authorized).toBe(false);
		expect(result1.denied).toContain("tag:some-tag");

		// Key with both scopes → allowed
		const { key: keyBoth } = await stub.createKey({
			name: "hosts-and-tags",
			zone_id: ZONE_ID,
			scopes: [
				{ scope_type: "host", scope_value: "example.com" },
				{ scope_type: "tag", scope_value: "some-tag" },
			],
		});

		const result2 = await stub.authorize(keyBoth.id, ZONE_ID, {
			hosts: ["example.com"],
			tags: ["some-tag"],
		});
		expect(result2.authorized).toBe(true);
	});
});

describe("IAM — expired key", () => {
	it("expired key → rejected", async () => {
		const stub = getStub();

		// Use a tiny fractional expires_in_days so the key expires almost immediately.
		// 0.000002 days ≈ 173ms — generous enough to survive DO init latency.
		// Then wait 250ms to ensure we're well past expiry.
		const { key } = await stub.createKey({
			name: "soon-expired",
			zone_id: ZONE_ID,
			expires_in_days: 0.000002, // ~173ms
			scopes: [{ scope_type: "host", scope_value: "example.com" }],
		});

		// Wait well past expiry
		await new Promise((r) => setTimeout(r, 250));

		const result = await stub.authorize(key.id, ZONE_ID, {
			hosts: ["example.com"],
		});
		expect(result.authorized).toBe(false);
		expect(result.error).toBe("API key has expired");
	});
});
