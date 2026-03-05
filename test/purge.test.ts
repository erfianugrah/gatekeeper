import { SELF, fetchMock, env } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach, beforeEach } from "vitest";
import {
	ZONE_ID,
	adminHeaders,
	createKeyWithPolicy,
	hostPolicy,
	wildcardPolicy,
	urlPrefixPolicy,
	tagPolicy,
	prefixPolicy,
	mockUpstreamSuccess,
	mockUpstream429,
	mockUpstream500,
	__testClearInflightCache,
} from "./helpers";

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

describe("Purge — authentication", () => {
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
					Authorization: "Bearer gw_nonexistent0000000000000000000",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(401);
	});

	it("403 when key lacks required scope", async () => {
		const keyId = await createKeyWithPolicy(hostPolicy("other.com"));

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
		const keyId = await createKeyWithPolicy(hostPolicy("example.com"));
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

describe("Purge — body validation", () => {
	it("400 for invalid zone ID format", async () => {
		const res = await SELF.fetch(
			"http://localhost/v1/zones/not-a-valid-zone/purge_cache",
			{
				method: "POST",
				headers: { Authorization: "Bearer gw_test", "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/zone ID/i);
	});

	it("400 for invalid JSON body", async () => {
		const keyId = await createKeyWithPolicy(hostPolicy("example.com"));
		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: "not json{{{",
			},
		);
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/JSON/i);
	});

	it("400 for empty purge body", async () => {
		const keyId = await createKeyWithPolicy(hostPolicy("example.com"));
		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({}),
			},
		);
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/must contain/i);
	});

	it("400 for oversized files array", async () => {
		const keyId = await createKeyWithPolicy(urlPrefixPolicy("https://example.com/"));
		const files = Array.from({ length: 501 }, (_, i) => `https://example.com/${i}`);
		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ files }),
			},
		);
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/max/i);
	});
});

describe("Purge — happy path", () => {
	it("host purge -> 200 with rate limit headers", async () => {
		const keyId = await createKeyWithPolicy(hostPolicy("example.com"));
		mockUpstreamSuccess();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(200);

		const ratelimit = res.headers.get("Ratelimit");
		expect(ratelimit).toMatch(/purge-bulk/);
		expect(ratelimit).toMatch(/;r=\d+/);

		const rlPolicy = res.headers.get("Ratelimit-Policy");
		expect(rlPolicy).toMatch(/purge-bulk/);
		expect(rlPolicy).toMatch(/;q=500/);
		expect(rlPolicy).toMatch(/;w=10/);

		expect(res.headers.get("cf-ray")).toBe("mock-ray-123");
		expect(res.headers.get("cf-auditlog-id")).toBe("mock-audit-456");

		const data = await res.json<any>();
		expect(data.success).toBe(true);
	});

	it("single-file purge -> 200 with purge-single rate limit", async () => {
		const keyId = await createKeyWithPolicy(urlPrefixPolicy("https://example.com/"));
		mockUpstreamSuccess();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ files: ["https://example.com/page.html"] }),
			},
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Ratelimit")).toMatch(/purge-single/);
		expect(res.headers.get("Ratelimit-Policy")).toMatch(/;q=6000/);
	});

	it("purge_everything with wildcard policy -> 200", async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy());
		mockUpstreamSuccess();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ purge_everything: true }),
			},
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Ratelimit")).toMatch(/purge-bulk/);
	});

	it("tag purge -> 200", async () => {
		const keyId = await createKeyWithPolicy(tagPolicy("my-tag"));
		mockUpstreamSuccess();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ tags: ["my-tag"] }),
			},
		);
		expect(res.status).toBe(200);
	});

	it("prefix purge -> 200", async () => {
		const keyId = await createKeyWithPolicy(prefixPolicy("example.com/blog"));
		mockUpstreamSuccess();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ prefixes: ["example.com/blog/post-1"] }),
			},
		);
		expect(res.status).toBe(200);
	});
});

describe("Purge — upstream errors", () => {
	it("upstream 500 -> forwarded as-is with rate limit headers", async () => {
		const keyId = await createKeyWithPolicy(hostPolicy("example.com"));
		mockUpstream500();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(500);
		expect(res.headers.get("Ratelimit")).toMatch(/purge-bulk/);
	});

	it("upstream 429 -> forwarded with Retry-After, drains bucket", async () => {
		const keyId = await createKeyWithPolicy(hostPolicy("example.com"));
		mockUpstream429();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("10");
	});
});

describe("Purge — client-side rate limiting", () => {
	it("exhausting bucket returns 429 with Retry-After", async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy());

		const stub = env.PURGE_RATE_LIMITER.get(
			env.PURGE_RATE_LIMITER.idFromName("account"),
		);
		await stub.consume("bulk", 500);

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(429);

		const retryAfter = res.headers.get("Retry-After");
		expect(retryAfter).not.toBeNull();
		expect(Number(retryAfter)).toBeGreaterThan(0);
		expect(res.headers.get("Ratelimit")).toMatch(/;r=0/);

		const data = await res.json<any>();
		expect(data.success).toBe(false);
		expect(data.errors[0].code).toBe(429);
	});
});

describe("Purge — per-key rate limiting", () => {
	it("key with custom rate limit gets 429 when per-key bucket exhausted", async () => {
		const createRes = await SELF.fetch("http://localhost/admin/keys", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				name: "limited-key",
				zone_id: ZONE_ID,
				policy: wildcardPolicy(),
				rate_limit: { bulk_rate: 2, bulk_bucket: 2 },
			}),
		});
		expect(createRes.status).toBe(200);
		const createData = await createRes.json<any>();
		const keyId = createData.result.key.id;

		for (let i = 0; i < 2; i++) {
			mockUpstreamSuccess();
			const res = await SELF.fetch(
				`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
				{
					method: "POST",
					headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
					body: JSON.stringify({ hosts: [`host-perkey-${i}.io`] }),
				},
			);
			expect(res.status).toBe(200);
		}

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["host-perkey-blocked.io"] }),
			},
		);
		expect(res.status).toBe(429);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/per-key/i);
		expect(res.headers.get("Ratelimit")).toMatch(/purge-bulk-key/);
	});

	it("key without custom rate limit uses account defaults only", async () => {
		const keyId = await createKeyWithPolicy(hostPolicy("example.com"));
		mockUpstreamSuccess();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(200);
		const ratelimit = res.headers.get("Ratelimit");
		expect(ratelimit).toMatch(/purge-bulk/);
		expect(ratelimit).not.toMatch(/purge-bulk-key/);
	});
});

describe("Purge — policy authorization", () => {
	it("host condition allows matching host", async () => {
		const keyId = await createKeyWithPolicy(hostPolicy("cdn.example.com"));
		mockUpstreamSuccess();

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["cdn.example.com"] }),
			},
		);
		expect(res.status).toBe(200);
	});

	it("host condition denies non-matching host", async () => {
		const keyId = await createKeyWithPolicy(hostPolicy("cdn.example.com"));

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["evil.com"] }),
			},
		);
		expect(res.status).toBe(403);
		const data = await res.json<any>();
		expect(data.denied).toContain("host:evil.com");
	});

	it("wildcard action allows any purge type", async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy());

		mockUpstreamSuccess();
		const res1 = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["anything.com"] }),
			},
		);
		expect(res1.status).toBe(200);

		mockUpstreamSuccess();
		const res2 = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ tags: ["any-tag"] }),
			},
		);
		expect(res2.status).toBe(200);
	});

	it("ends_with condition for host suffix matching", async () => {
		const keyId = await createKeyWithPolicy({
			version: "2025-01-01",
			statements: [{
				effect: "allow",
				actions: ["purge:host"],
				resources: [`zone:${ZONE_ID}`],
				conditions: [{ field: "host", operator: "ends_with", value: ".example.com" }],
			}],
		});

		mockUpstreamSuccess();
		const res1 = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["cdn.example.com"] }),
			},
		);
		expect(res1.status).toBe(200);

		const res2 = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["evil.com"] }),
			},
		);
		expect(res2.status).toBe(403);
	});

	it("URL file purge with header condition", async () => {
		const keyId = await createKeyWithPolicy({
			version: "2025-01-01",
			statements: [{
				effect: "allow",
				actions: ["purge:url"],
				resources: [`zone:${ZONE_ID}`],
				conditions: [
					{ field: "host", operator: "eq", value: "cdn.example.com" },
					{ field: "header.CF-Device-Type", operator: "eq", value: "mobile" },
				],
			}],
		});

		mockUpstreamSuccess();
		const res1 = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					files: [{ url: "https://cdn.example.com/img/logo.png", headers: { "CF-Device-Type": "mobile" } }],
				}),
			},
		);
		expect(res1.status).toBe(200);

		const res2 = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					files: [{ url: "https://cdn.example.com/img/logo.png", headers: { "CF-Device-Type": "desktop" } }],
				}),
			},
		);
		expect(res2.status).toBe(403);

		const res3 = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ files: ["https://cdn.example.com/img/logo.png"] }),
			},
		);
		expect(res3.status).toBe(403);
	});

	it("denies action not in policy", async () => {
		const keyId = await createKeyWithPolicy(tagPolicy("release-v1"));

		mockUpstreamSuccess();
		const res1 = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ tags: ["release-v1"] }),
			},
		);
		expect(res1.status).toBe(200);

		const res2 = await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res2.status).toBe(403);
	});

	it("denies wrong zone", async () => {
		const OTHER_ZONE = "bbbb2222cccc3333dddd4444eeee5555";
		const keyId = await createKeyWithPolicy(wildcardPolicy());

		const res = await SELF.fetch(
			`http://localhost/v1/zones/${OTHER_ZONE}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["example.com"] }),
			},
		);
		expect(res.status).toBe(403);
	});
});

describe("Misc", () => {
	it("GET /health returns 200", async () => {
		const res = await SELF.fetch("http://localhost/health");
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.ok).toBe(true);
	});

	it("unknown routes return 404", async () => {
		const res = await SELF.fetch("http://localhost/unknown/path");
		expect(res.status).toBe(404);
	});
});
