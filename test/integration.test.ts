import { SELF, fetchMock, env } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach, beforeEach } from "vitest";
import { __testClearInflightCache } from "../src/index";

const ZONE_ID = "aaaa1111bbbb2222cccc3333dddd4444";
const ADMIN_KEY = "test-admin-secret-key-12345";
const UPSTREAM_HOST = "https://api.cloudflare.com";
const UPSTREAM_PATH = `/client/v4/zones/${ZONE_ID}/purge_cache`;

// --- Helpers ---

function adminHeaders(extra?: Record<string, string>) {
	return {
		"X-Admin-Key": ADMIN_KEY,
		"Content-Type": "application/json",
		...extra,
	};
}

async function createKey(
	scopes: { scope_type: string; scope_value: string }[],
	name = "test-key",
): Promise<string> {
	const res = await SELF.fetch("http://localhost/admin/keys", {
		method: "POST",
		headers: adminHeaders(),
		body: JSON.stringify({
			name,
			zone_id: ZONE_ID,
			scopes,
		}),
	});
	const data = await res.json<any>();
	return data.result.key.id;
}

function mockUpstreamSuccess(body = '{"success":true,"errors":[],"messages":[],"result":{"id":"test"}}') {
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method: "POST", path: UPSTREAM_PATH })
		.reply(200, body, {
			headers: {
				"Content-Type": "application/json",
				"cf-ray": "mock-ray-123",
				"cf-auditlog-id": "mock-audit-456",
			},
		});
}

function mockUpstream429() {
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method: "POST", path: UPSTREAM_PATH })
		.reply(
			429,
			'{"success":false,"errors":[{"code":429,"message":"Rate limited"}]}',
			{
				headers: {
					"Content-Type": "application/json",
					"Retry-After": "10",
				},
			},
		);
}

function mockUpstream500() {
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method: "POST", path: UPSTREAM_PATH })
		.reply(500, '{"success":false,"errors":[{"code":500,"message":"Internal Server Error"}]}', {
			headers: { "Content-Type": "application/json" },
		});
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

// --- Tests ---

describe("Health check", () => {
	it("GET /health returns 200", async () => {
		const res = await SELF.fetch("http://localhost/health");
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.ok).toBe(true);
	});
});

describe("Admin endpoints", () => {
	it("rejects requests without admin key", async () => {
		const res = await SELF.fetch("http://localhost/admin/keys", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "x", zone_id: ZONE_ID, scopes: [] }),
		});
		expect(res.status).toBe(401);
	});

	it("rejects requests with wrong admin key", async () => {
		const res = await SELF.fetch("http://localhost/admin/keys", {
			method: "POST",
			headers: { "X-Admin-Key": "wrong-key", "Content-Type": "application/json" },
			body: JSON.stringify({ name: "x", zone_id: ZONE_ID, scopes: [] }),
		});
		expect(res.status).toBe(401);
	});

	it("create key -> list -> get -> revoke -> verify revoked", async () => {
		// Create
		const createRes = await SELF.fetch("http://localhost/admin/keys", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				name: "lifecycle-key",
				zone_id: ZONE_ID,
				scopes: [{ scope_type: "host", scope_value: "example.com" }],
			}),
		});
		expect(createRes.status).toBe(200);
		const createData = await createRes.json<any>();
		expect(createData.success).toBe(true);
		const keyId = createData.result.key.id;
		expect(keyId).toMatch(/^pgw_/);

		// List
		const listRes = await SELF.fetch(
			`http://localhost/admin/keys?zone_id=${ZONE_ID}`,
			{ headers: adminHeaders() },
		);
		expect(listRes.status).toBe(200);
		const listData = await listRes.json<any>();
		expect(listData.result.some((k: any) => k.id === keyId)).toBe(true);

		// Get
		const getRes = await SELF.fetch(
			`http://localhost/admin/keys/${keyId}?zone_id=${ZONE_ID}`,
			{ headers: adminHeaders() },
		);
		expect(getRes.status).toBe(200);
		const getData = await getRes.json<any>();
		expect(getData.result.key.id).toBe(keyId);
		expect(getData.result.scopes).toHaveLength(1);

		// Revoke
		const revokeRes = await SELF.fetch(
			`http://localhost/admin/keys/${keyId}?zone_id=${ZONE_ID}`,
			{ method: "DELETE", headers: adminHeaders() },
		);
		expect(revokeRes.status).toBe(200);
		const revokeData = await revokeRes.json<any>();
		expect(revokeData.result.revoked).toBe(true);

		// Revoke again -> 404
		const revokeAgainRes = await SELF.fetch(
			`http://localhost/admin/keys/${keyId}?zone_id=${ZONE_ID}`,
			{ method: "DELETE", headers: adminHeaders() },
		);
		expect(revokeAgainRes.status).toBe(404);
	});

	it("rejects create with missing fields", async () => {
		const res = await SELF.fetch("http://localhost/admin/keys", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({ name: "no-zone" }),
		});
		expect(res.status).toBe(400);
	});

	it("get nonexistent key returns 404", async () => {
		const res = await SELF.fetch(
			`http://localhost/admin/keys/pgw_doesnotexist000000000000000?zone_id=${ZONE_ID}`,
			{ headers: adminHeaders() },
		);
		expect(res.status).toBe(404);
	});

	it("list keys requires zone_id", async () => {
		const res = await SELF.fetch("http://localhost/admin/keys", {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(400);
	});
});

describe("Purge - authentication", () => {
	it("401 when no Authorization header", async () => {
		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(401);
		const data = await res.json<any>();
		expect(data.success).toBe(false);
	});

	it("401 when key does not exist", async () => {
		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: "Bearer pgw_nonexistent000000000000000000",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(401);
	});

	it("403 when key has wrong scope", async () => {
		const keyId = await createKey([
			{ scope_type: "host", scope_value: "other.com" },
		]);

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(403);
		const data = await res.json<any>();
		expect(data.denied).toContain("host:example.com");
	});

	it("403 when revoked key is used", async () => {
		const keyId = await createKey([
			{ scope_type: "host", scope_value: "example.com" },
		]);
		// Revoke
		await SELF.fetch(
			`http://localhost/admin/keys/${keyId}?zone_id=${ZONE_ID}`,
			{ method: "DELETE", headers: adminHeaders() },
		);

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(403);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/revoked/i);
	});
});

describe("Purge - body validation", () => {
	it("400 for invalid zone ID format", async () => {
		const res = await SELF.fetch(
			"http://localhost/v1/zones/not-a-valid-zone/purge_cache",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer pgw_test",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/zone ID/i);
	});

	it("400 for invalid JSON body", async () => {
		const keyId = await createKey([
			{ scope_type: "host", scope_value: "example.com" },
		]);
		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: "not json{{{",
			},
		);
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/JSON/i);
	});

	it("400 for empty purge body", async () => {
		const keyId = await createKey([
			{ scope_type: "host", scope_value: "example.com" },
		]);
		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({}),
			},
		);
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/must contain/i);
	});

	it("400 for oversized files array", async () => {
		const keyId = await createKey([
			{ scope_type: "url_prefix", scope_value: "https://example.com/" },
		]);
		const files = Array.from({ length: 501 }, (_, i) => `https://example.com/${i}`);
		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ files }),
			},
		);
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/max/i);
	});
});

describe("Purge - happy path", () => {
	it("host purge -> 200 with rate limit headers", async () => {
		const keyId = await createKey([
			{ scope_type: "host", scope_value: "example.com" },
		]);
		mockUpstreamSuccess();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(200);

		// Rate limit headers present
		const ratelimit = res.headers.get("Ratelimit");
		expect(ratelimit).not.toBeNull();
		expect(ratelimit).toMatch(/purge-bulk/);
		expect(ratelimit).toMatch(/;r=\d+/);

		const policy = res.headers.get("Ratelimit-Policy");
		expect(policy).not.toBeNull();
		expect(policy).toMatch(/purge-bulk/);
		expect(policy).toMatch(/;q=500/); // bulk bucket size
		expect(policy).toMatch(/;w=10/); // 500/50 = 10

		// Forwarded upstream headers
		expect(res.headers.get("cf-ray")).toBe("mock-ray-123");
		expect(res.headers.get("cf-auditlog-id")).toBe("mock-audit-456");

		// Body forwarded
		const data = await res.json<any>();
		expect(data.success).toBe(true);
	});

	it("single-file purge -> 200 with purge-single rate limit", async () => {
		const keyId = await createKey([
			{ scope_type: "url_prefix", scope_value: "https://example.com/" },
		]);
		mockUpstreamSuccess();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ files: ["https://example.com/page.html"] }),
			},
		);
		expect(res.status).toBe(200);

		const ratelimit = res.headers.get("Ratelimit");
		expect(ratelimit).toMatch(/purge-single/);

		const policy = res.headers.get("Ratelimit-Policy");
		expect(policy).toMatch(/purge-single/);
		expect(policy).toMatch(/;q=6000/); // single bucket size
	});

	it("purge_everything with wildcard scope -> 200", async () => {
		const keyId = await createKey([{ scope_type: "*", scope_value: "*" }]);
		mockUpstreamSuccess();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ purge_everything: true }),
			},
		);
		expect(res.status).toBe(200);
		const ratelimit = res.headers.get("Ratelimit");
		expect(ratelimit).toMatch(/purge-bulk/);
	});

	it("tag purge -> 200", async () => {
		const keyId = await createKey([
			{ scope_type: "tag", scope_value: "my-tag" },
		]);
		mockUpstreamSuccess();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ tags: ["my-tag"] }),
			},
		);
		expect(res.status).toBe(200);
	});

	it("prefix purge -> 200", async () => {
		const keyId = await createKey([
			{ scope_type: "prefix", scope_value: "example.com/blog" },
		]);
		mockUpstreamSuccess();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ prefixes: ["example.com/blog/post-1"] }),
			},
		);
		expect(res.status).toBe(200);
	});
});

describe("Purge - upstream errors", () => {
	it("upstream 500 -> forwarded as-is with rate limit headers", async () => {
		const keyId = await createKey([
			{ scope_type: "host", scope_value: "example.com" },
		]);
		mockUpstream500();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		// Upstream status forwarded
		expect(res.status).toBe(500);
		// Rate limit headers still present (we consumed a token)
		expect(res.headers.get("Ratelimit")).toMatch(/purge-bulk/);
	});

	it("upstream 429 -> forwarded with Retry-After, drains bucket", async () => {
		const keyId = await createKey([
			{ scope_type: "host", scope_value: "example.com" },
		]);
		mockUpstream429();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("10");
	});
});

describe("Purge - client-side rate limiting", () => {
	it("exhausting bucket returns 429 with Retry-After", async () => {
		const keyId = await createKey([{ scope_type: "*", scope_value: "*" }]);

		// First, exhaust the bulk bucket by sending many requests.
		// Bulk bucket = 500 tokens, each request costs 1.
		// We'll use the DO directly to drain faster.
		const stub = env.PURGE_RATE_LIMITER.get(
			env.PURGE_RATE_LIMITER.idFromName("account"),
		);
		// Consume all 500 tokens
		await stub.consume("bulk", 500);

		// Now a purge request should be rejected client-side (no upstream mock needed)
		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(429);

		const retryAfter = res.headers.get("Retry-After");
		expect(retryAfter).not.toBeNull();
		expect(Number(retryAfter)).toBeGreaterThan(0);

		const ratelimit = res.headers.get("Ratelimit");
		expect(ratelimit).toMatch(/purge-bulk/);
		expect(ratelimit).toMatch(/;r=0/); // no remaining

		const policy = res.headers.get("Ratelimit-Policy");
		expect(policy).toMatch(/purge-bulk/);

		const data = await res.json<any>();
		expect(data.success).toBe(false);
		expect(data.errors[0].code).toBe(429);
	});
});

describe("Purge - per-key rate limiting", () => {
	it("key with custom rate limit gets 429 when per-key bucket exhausted", async () => {
		// Create key with very tight per-key rate limit: 2 req/sec, bucket of 2
		const createRes = await SELF.fetch("http://localhost/admin/keys", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				name: "limited-key",
				zone_id: ZONE_ID,
				scopes: [{ scope_type: "*", scope_value: "*" }],
				rate_limit: { bulk_rate: 2, bulk_bucket: 2 },
			}),
		});
		expect(createRes.status).toBe(200);
		const createData = await createRes.json<any>();
		const keyId = createData.result.key.id;
		expect(createData.result.key.bulk_rate).toBe(2);
		expect(createData.result.key.bulk_bucket).toBe(2);

		// First two requests should succeed (bucket=2)
		for (let i = 0; i < 2; i++) {
			mockUpstreamSuccess();
			const res = await SELF.fetch(
				`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${keyId}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ hosts: [`host-perkey-${i}.io`] }),
				},
			);
			expect(res.status).toBe(200);
		}

		// Third request should hit per-key rate limit (no upstream mock needed)
		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hosts: ["host-perkey-blocked.io"] }),
			},
		);
		expect(res.status).toBe(429);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/per-key/i);
		const ratelimit = res.headers.get("Ratelimit");
		expect(ratelimit).toMatch(/purge-bulk-key/);
	});

	it("key without custom rate limit uses account defaults only", async () => {
		const keyId = await createKey([
			{ scope_type: "host", scope_value: "example.com" },
		]);
		mockUpstreamSuccess();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(200);
		// Account-level rate limit header, not per-key
		const ratelimit = res.headers.get("Ratelimit");
		expect(ratelimit).toMatch(/purge-bulk/);
		expect(ratelimit).not.toMatch(/purge-bulk-key/);
	});
});

describe("Admin analytics", () => {
	it("events endpoint requires zone_id", async () => {
		const res = await SELF.fetch("http://localhost/admin/analytics/events", {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/zone_id/i);
	});

	it("summary endpoint requires zone_id", async () => {
		const res = await SELF.fetch("http://localhost/admin/analytics/summary", {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/zone_id/i);
	});

	it("events endpoint returns empty array when no events", async () => {
		const res = await SELF.fetch(
			`http://localhost/admin/analytics/events?zone_id=${ZONE_ID}`,
			{ headers: adminHeaders() },
		);
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result).toEqual([]);
	});

	it("summary endpoint returns zeros when no events", async () => {
		const res = await SELF.fetch(
			`http://localhost/admin/analytics/summary?zone_id=${ZONE_ID}`,
			{ headers: adminHeaders() },
		);
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.total_requests).toBe(0);
		expect(data.result.total_cost).toBe(0);
		expect(data.result.collapsed_count).toBe(0);
	});

	it("purge request logs event to D1, queryable via events endpoint", async () => {
		const keyId = await createKey([
			{ scope_type: "host", scope_value: "example.com" },
		]);
		mockUpstreamSuccess();

		// Make a purge request — analytics is logged via waitUntil
		const purgeRes = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(purgeRes.status).toBe(200);

		// waitUntil fires asynchronously; give it a moment
		await new Promise((r) => setTimeout(r, 100));

		// Query events
		const res = await SELF.fetch(
			`http://localhost/admin/analytics/events?zone_id=${ZONE_ID}`,
			{ headers: adminHeaders() },
		);
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.success).toBe(true);
		expect(data.result.length).toBeGreaterThanOrEqual(1);

		const event = data.result[0];
		expect(event.zone_id).toBe(ZONE_ID);
		expect(event.purge_type).toBe("bulk");
		expect(event.status).toBe(200);
		expect(event.cost).toBe(1);
	});

	it("summary aggregates events correctly", async () => {
		const keyId = await createKey([{ scope_type: "*", scope_value: "*" }]);

		// Make two purge requests with different bodies so they don't collapse
		mockUpstreamSuccess();
		await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hosts: ["summary-test-1.io"] }),
			},
		);

		mockUpstreamSuccess();
		await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ tags: ["summary-tag"] }),
			},
		);

		await new Promise((r) => setTimeout(r, 100));

		const res = await SELF.fetch(
			`http://localhost/admin/analytics/summary?zone_id=${ZONE_ID}`,
			{ headers: adminHeaders() },
		);
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.total_requests).toBeGreaterThanOrEqual(2);
		expect(data.result.total_cost).toBeGreaterThanOrEqual(2);
		expect(data.result.by_status["200"]).toBeGreaterThanOrEqual(2);
		expect(data.result.by_purge_type["bulk"]).toBeGreaterThanOrEqual(2);
	});

	it("events endpoint filters by key_id", async () => {
		const keyId1 = await createKey(
			[{ scope_type: "*", scope_value: "*" }],
			"key-filter-1",
		);
		const keyId2 = await createKey(
			[{ scope_type: "*", scope_value: "*" }],
			"key-filter-2",
		);

		// Use distinct bodies to avoid isolate-level collapsing
		mockUpstreamSuccess();
		await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId1}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hosts: ["filter-key1.io"] }),
			},
		);

		mockUpstreamSuccess();
		await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${keyId2}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hosts: ["filter-key2.io"] }),
			},
		);

		await new Promise((r) => setTimeout(r, 100));

		// Filter by key1
		const res = await SELF.fetch(
			`http://localhost/admin/analytics/events?zone_id=${ZONE_ID}&key_id=${keyId1}`,
			{ headers: adminHeaders() },
		);
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.length).toBeGreaterThanOrEqual(1);
		for (const event of data.result) {
			expect(event.key_id).toBe(keyId1);
		}
	});

	it("events endpoint respects limit param", async () => {
		const keyId = await createKey([{ scope_type: "*", scope_value: "*" }]);

		// Make 3 requests
		for (let i = 0; i < 3; i++) {
			mockUpstreamSuccess();
			await SELF.fetch(
				`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${keyId}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ hosts: [`limit-test-${i}.io`] }),
				},
			);
		}

		await new Promise((r) => setTimeout(r, 100));

		const res = await SELF.fetch(
			`http://localhost/admin/analytics/events?zone_id=${ZONE_ID}&limit=2`,
			{ headers: adminHeaders() },
		);
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.length).toBe(2);
	});

	it("analytics endpoints require admin key", async () => {
		const eventsRes = await SELF.fetch(
			`http://localhost/admin/analytics/events?zone_id=${ZONE_ID}`,
		);
		expect(eventsRes.status).toBe(401);

		const summaryRes = await SELF.fetch(
			`http://localhost/admin/analytics/summary?zone_id=${ZONE_ID}`,
		);
		expect(summaryRes.status).toBe(401);
	});
});

describe("404 handling", () => {
	it("unknown routes return 404", async () => {
		const res = await SELF.fetch("http://localhost/unknown/path");
		expect(res.status).toBe(404);
	});
});
