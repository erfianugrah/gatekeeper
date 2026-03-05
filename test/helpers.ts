import { SELF, fetchMock } from "cloudflare:test";
import { __testClearInflightCache } from "../src/index";

export const ZONE_ID = "aaaa1111bbbb2222cccc3333dddd4444";
export const ADMIN_KEY = "test-admin-secret-key-12345";
export const UPSTREAM_HOST = "https://api.cloudflare.com";
export const UPSTREAM_PATH = `/client/v4/zones/${ZONE_ID}/purge_cache`;

export { __testClearInflightCache };

// ─── HTTP helpers ───────────────────────────────────────────────────────────

export function adminHeaders(extra?: Record<string, string>) {
	return {
		"X-Admin-Key": ADMIN_KEY,
		"Content-Type": "application/json",
		...extra,
	};
}

/** Create a key via the admin API with a policy document. Returns the key ID. */
export async function createKeyWithPolicy(
	policy: Record<string, unknown>,
	name = "test-key",
	extra?: Record<string, unknown>,
): Promise<string> {
	const res = await SELF.fetch("http://localhost/admin/keys", {
		method: "POST",
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
	return data.result.key.id;
}

// ─── Upstream mocks ─────────────────────────────────────────────────────────

export function mockUpstreamSuccess(body = '{"success":true,"errors":[],"messages":[],"result":{"id":"test"}}') {
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

export function mockUpstream429() {
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

export function mockUpstream500() {
	fetchMock
		.get(UPSTREAM_HOST)
		.intercept({ method: "POST", path: UPSTREAM_PATH })
		.reply(500, '{"success":false,"errors":[{"code":500,"message":"Internal Server Error"}]}', {
			headers: { "Content-Type": "application/json" },
		});
}

// ─── Policy factories ───────────────────────────────────────────────────────

/** Allow-all policy for the test zone. */
export function wildcardPolicy() {
	return {
		version: "2025-01-01",
		statements: [{ effect: "allow", actions: ["purge:*"], resources: [`zone:${ZONE_ID}`] }],
	};
}

/** Host-scoped policy. */
export function hostPolicy(host: string) {
	return {
		version: "2025-01-01",
		statements: [{
			effect: "allow",
			actions: ["purge:host"],
			resources: [`zone:${ZONE_ID}`],
			conditions: [{ field: "host", operator: "eq", value: host }],
		}],
	};
}

/** URL prefix policy. */
export function urlPrefixPolicy(prefix: string) {
	return {
		version: "2025-01-01",
		statements: [{
			effect: "allow",
			actions: ["purge:url"],
			resources: [`zone:${ZONE_ID}`],
			conditions: [{ field: "url", operator: "starts_with", value: prefix }],
		}],
	};
}

/** Tag policy. */
export function tagPolicy(tag: string) {
	return {
		version: "2025-01-01",
		statements: [{
			effect: "allow",
			actions: ["purge:tag"],
			resources: [`zone:${ZONE_ID}`],
			conditions: [{ field: "tag", operator: "eq", value: tag }],
		}],
	};
}

/** Prefix purge policy. */
export function prefixPolicy(prefix: string) {
	return {
		version: "2025-01-01",
		statements: [{
			effect: "allow",
			actions: ["purge:prefix"],
			resources: [`zone:${ZONE_ID}`],
			conditions: [{ field: "prefix", operator: "starts_with", value: prefix }],
		}],
	};
}
