import { SELF, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach, beforeEach } from "vitest";
import {
	ZONE_ID,
	adminHeaders,
	createKeyWithPolicy,
	hostPolicy,
	wildcardPolicy,
	mockUpstreamSuccess,
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

describe("Analytics — validation", () => {
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

describe("Analytics — empty state", () => {
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
});

describe("Analytics — event logging", () => {
	it("purge request logs event to D1, queryable via events endpoint", async () => {
		const keyId = await createKeyWithPolicy(hostPolicy("example.com"));
		mockUpstreamSuccess();

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

		await new Promise((r) => setTimeout(r, 100));

		const res = await SELF.fetch(
			`http://localhost/admin/analytics/events?zone_id=${ZONE_ID}`,
			{ headers: adminHeaders() },
		);
		expect(res.status).toBe(200);
		const data = await res.json<any>();
		expect(data.result.length).toBeGreaterThanOrEqual(1);

		const event = data.result[0];
		expect(event.zone_id).toBe(ZONE_ID);
		expect(event.purge_type).toBe("bulk");
		expect(event.status).toBe(200);
		expect(event.cost).toBe(1);
	});

	it("summary aggregates events correctly", async () => {
		const keyId = await createKeyWithPolicy(wildcardPolicy());

		mockUpstreamSuccess();
		await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["summary-test-1.io"] }),
			},
		);

		mockUpstreamSuccess();
		await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
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
});

describe("Analytics — filtering", () => {
	it("events endpoint filters by key_id", async () => {
		const keyId1 = await createKeyWithPolicy(wildcardPolicy(), "key-filter-1");
		const keyId2 = await createKeyWithPolicy(wildcardPolicy(), "key-filter-2");

		mockUpstreamSuccess();
		await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId1}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["filter-key1.io"] }),
			},
		);

		mockUpstreamSuccess();
		await SELF.fetch(
			`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${keyId2}`, "Content-Type": "application/json" },
				body: JSON.stringify({ hosts: ["filter-key2.io"] }),
			},
		);

		await new Promise((r) => setTimeout(r, 100));

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
		const keyId = await createKeyWithPolicy(wildcardPolicy());

		for (let i = 0; i < 3; i++) {
			mockUpstreamSuccess();
			await SELF.fetch(
				`http://localhost/v1/zones/${ZONE_ID}/purge_cache`,
				{
					method: "POST",
					headers: { Authorization: `Bearer ${keyId}`, "Content-Type": "application/json" },
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
});
