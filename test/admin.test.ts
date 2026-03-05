import { SELF, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach, beforeEach } from "vitest";
import {
	ZONE_ID,
	adminHeaders,
	createKeyWithPolicy,
	hostPolicy,
	wildcardPolicy,
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

describe("Admin — authentication", () => {
	it("rejects requests without admin key", async () => {
		const res = await SELF.fetch("http://localhost/admin/keys", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "x", zone_id: ZONE_ID, policy: wildcardPolicy() }),
		});
		expect(res.status).toBe(401);
	});

	it("rejects requests with wrong admin key", async () => {
		const res = await SELF.fetch("http://localhost/admin/keys", {
			method: "POST",
			headers: { "X-Admin-Key": "wrong-key", "Content-Type": "application/json" },
			body: JSON.stringify({ name: "x", zone_id: ZONE_ID, policy: wildcardPolicy() }),
		});
		expect(res.status).toBe(401);
	});
});

describe("Admin — key lifecycle", () => {
	it("create -> list -> get -> revoke -> verify revoked", async () => {
		// Create
		const createRes = await SELF.fetch("http://localhost/admin/keys", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				name: "lifecycle-key",
				zone_id: ZONE_ID,
				policy: hostPolicy("example.com"),
			}),
		});
		expect(createRes.status).toBe(200);
		const createData = await createRes.json<any>();
		expect(createData.success).toBe(true);
		const keyId = createData.result.key.id;
		expect(keyId).toMatch(/^gw_/);

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
		expect(getData.result.key.policy).toBeTruthy();

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
});

describe("Admin — validation", () => {
	it("rejects create with missing fields", async () => {
		const res = await SELF.fetch("http://localhost/admin/keys", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({ name: "no-zone" }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects create without policy", async () => {
		const res = await SELF.fetch("http://localhost/admin/keys", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({ name: "no-policy", zone_id: ZONE_ID }),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors[0].message).toMatch(/policy/i);
	});

	it("rejects invalid policy: missing version", async () => {
		const res = await SELF.fetch("http://localhost/admin/keys", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				name: "bad-policy",
				zone_id: ZONE_ID,
				policy: {
					statements: [{ effect: "allow", actions: ["*"], resources: ["*"] }],
				},
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors.some((e: any) => e.message.includes("version"))).toBe(true);
	});

	it("rejects invalid policy: empty statements", async () => {
		const res = await SELF.fetch("http://localhost/admin/keys", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				name: "empty-stmts",
				zone_id: ZONE_ID,
				policy: { version: "2025-01-01", statements: [] },
			}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects invalid policy: dangerous regex", async () => {
		const res = await SELF.fetch("http://localhost/admin/keys", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				name: "bad-regex",
				zone_id: ZONE_ID,
				policy: {
					version: "2025-01-01",
					statements: [{
						effect: "allow",
						actions: ["purge:*"],
						resources: ["zone:*"],
						conditions: [{ field: "tag", operator: "matches", value: "(a+)+$" }],
					}],
				},
			}),
		});
		expect(res.status).toBe(400);
		const data = await res.json<any>();
		expect(data.errors.some((e: any) => e.message.includes("catastrophic"))).toBe(true);
	});
});

describe("Admin — edge cases", () => {
	it("get nonexistent key returns 404", async () => {
		const res = await SELF.fetch(
			`http://localhost/admin/keys/gw_doesnotexist0000000000000000?zone_id=${ZONE_ID}`,
			{ headers: adminHeaders() },
		);
		expect(res.status).toBe(404);
	});

	it("get key with wrong zone_id returns 404", async () => {
		const keyId = await createKeyWithPolicy(hostPolicy("example.com"));
		const res = await SELF.fetch(
			`http://localhost/admin/keys/${keyId}?zone_id=bbbb2222cccc3333dddd4444eeee5555`,
			{ headers: adminHeaders() },
		);
		expect(res.status).toBe(404);
	});

	it("revoke key with wrong zone_id returns 404 and key is untouched", async () => {
		const keyId = await createKeyWithPolicy(hostPolicy("example.com"));
		const res = await SELF.fetch(
			`http://localhost/admin/keys/${keyId}?zone_id=bbbb2222cccc3333dddd4444eeee5555`,
			{ method: "DELETE", headers: adminHeaders() },
		);
		expect(res.status).toBe(404);

		const getRes = await SELF.fetch(
			`http://localhost/admin/keys/${keyId}?zone_id=${ZONE_ID}`,
			{ headers: adminHeaders() },
		);
		expect(getRes.status).toBe(200);
		const data = await getRes.json<any>();
		expect(data.result.key.revoked).toBe(0);
	});

	it("list keys requires zone_id", async () => {
		const res = await SELF.fetch("http://localhost/admin/keys", {
			headers: adminHeaders(),
		});
		expect(res.status).toBe(400);
	});
});
