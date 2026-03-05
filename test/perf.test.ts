import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { evaluatePolicy } from "../src/policy-engine";
import type { PolicyDocument, RequestContext } from "../src/policy-types";
import type { CreateKeyRequest } from "../src/types";

// ─── Constants ─────────────────────────────────────────────────────────────

const ZONE_ID = "aaaa1111bbbb2222cccc3333dddd4444";

function getStub() {
	const id = env.PURGE_RATE_LIMITER.idFromName("account");
	return env.PURGE_RATE_LIMITER.get(id);
}

// ─── Policy factories ──────────────────────────────────────────────────────

function regexPolicy(pattern: string): PolicyDocument {
	return {
		version: "2025-01-01",
		statements: [{
			effect: "allow",
			actions: ["purge:url"],
			resources: [`zone:${ZONE_ID}`],
			conditions: [{ field: "url", operator: "matches", value: pattern }],
		}],
	};
}

function compoundRegexPolicy(): PolicyDocument {
	return {
		version: "2025-01-01",
		statements: [{
			effect: "allow",
			actions: ["purge:url"],
			resources: [`zone:${ZONE_ID}`],
			conditions: [{
				all: [
					{ field: "host", operator: "matches", value: "^(www\\.)?example\\.com$" },
					{ field: "url.path", operator: "matches", value: "^/assets/(css|js|img)/[a-z0-9_-]+\\.[a-z]{2,4}$" },
					{ field: "url", operator: "not_matches", value: "\\.(php|asp|jsp)$" },
				],
			}],
		}],
	};
}

function wildcardConditionPolicy(): PolicyDocument {
	return {
		version: "2025-01-01",
		statements: [{
			effect: "allow",
			actions: ["purge:url"],
			resources: [`zone:${ZONE_ID}`],
			conditions: [{ field: "url", operator: "wildcard", value: "https://*.example.com/assets/*" }],
		}],
	};
}

function multiStatementPolicy(): PolicyDocument {
	return {
		version: "2025-01-01",
		statements: [
			{
				effect: "allow",
				actions: ["purge:host"],
				resources: [`zone:${ZONE_ID}`],
				conditions: [{ field: "host", operator: "in", value: ["cdn.example.com", "static.example.com", "assets.example.com"] }],
			},
			{
				effect: "allow",
				actions: ["purge:tag"],
				resources: [`zone:${ZONE_ID}`],
				conditions: [{ field: "tag", operator: "starts_with", value: "release-" }],
			},
			{
				effect: "allow",
				actions: ["purge:url"],
				resources: [`zone:${ZONE_ID}`],
				conditions: [{
					any: [
						{ field: "url.path", operator: "starts_with", value: "/api/" },
						{ field: "url.path", operator: "matches", value: "^/v[0-9]+/" },
					],
				}],
			},
		],
	};
}

function simpleEqPolicy(): PolicyDocument {
	return {
		version: "2025-01-01",
		statements: [{
			effect: "allow",
			actions: ["purge:host"],
			resources: [`zone:${ZONE_ID}`],
			conditions: [{ field: "host", operator: "eq", value: "example.com" }],
		}],
	};
}

function wildcardActionPolicy(): PolicyDocument {
	return {
		version: "2025-01-01",
		statements: [{ effect: "allow", actions: ["purge:*"], resources: [`zone:${ZONE_ID}`] }],
	};
}

// ─── Context factories ─────────────────────────────────────────────────────

function urlContext(url: string): RequestContext[] {
	const parsed = new URL(url);
	return [{
		action: "purge:url",
		resource: `zone:${ZONE_ID}`,
		fields: {
			url,
			host: parsed.hostname,
			"url.path": parsed.pathname,
		},
	}];
}

function hostContext(host: string): RequestContext[] {
	return [{
		action: "purge:host",
		resource: `zone:${ZONE_ID}`,
		fields: { host },
	}];
}

function tagContext(tag: string): RequestContext[] {
	return [{
		action: "purge:tag",
		resource: `zone:${ZONE_ID}`,
		fields: { tag },
	}];
}

/** Create N distinct URL contexts for batch evaluation. */
function manyUrlContexts(n: number): RequestContext[] {
	const contexts: RequestContext[] = [];
	for (let i = 0; i < n; i++) {
		const url = `https://cdn.example.com/assets/js/bundle-${i}.js`;
		const parsed = new URL(url);
		contexts.push({
			action: "purge:url",
			resource: `zone:${ZONE_ID}`,
			fields: {
				url,
				host: parsed.hostname,
				"url.path": parsed.pathname,
			},
		});
	}
	return contexts;
}

// ─── Benchmarking helper ───────────────────────────────────────────────────

interface BenchResult {
	iterations: number;
	totalMs: number;
	avgUs: number; // microseconds
	opsPerSec: number;
	p99Us: number;
}

/** Run a function many times and report timing stats. */
function bench(fn: () => void, iterations = 10_000): BenchResult {
	const times: number[] = [];

	// Warmup
	for (let i = 0; i < 100; i++) fn();

	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		fn();
		times.push(performance.now() - start);
	}

	times.sort((a, b) => a - b);
	const totalMs = times.reduce((sum, t) => sum + t, 0);
	const avgUs = (totalMs / iterations) * 1000;
	const opsPerSec = Math.round(iterations / (totalMs / 1000));
	const p99Us = times[Math.floor(iterations * 0.99)] * 1000;

	return { iterations, totalMs, avgUs, opsPerSec, p99Us };
}

function formatBench(label: string, r: BenchResult): string {
	return `${label}: avg=${r.avgUs.toFixed(1)}us p99=${r.p99Us.toFixed(1)}us ops/sec=${r.opsPerSec.toLocaleString()}`;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Performance — policy engine (in-process)", () => {
	it("simple eq condition", () => {
		const policy = simpleEqPolicy();
		const ctx = hostContext("example.com");
		const r = bench(() => evaluatePolicy(policy, ctx));
		console.log(formatBench("simple eq", r));
		expect(r.avgUs).toBeLessThan(50); // should be sub-microsecond
	});

	it("wildcard action (no conditions)", () => {
		const policy = wildcardActionPolicy();
		const ctx = hostContext("example.com");
		const r = bench(() => evaluatePolicy(policy, ctx));
		console.log(formatBench("wildcard action", r));
		expect(r.avgUs).toBeLessThan(50);
	});

	it("single regex condition", () => {
		const policy = regexPolicy("^https://cdn\\.example\\.com/assets/");
		const ctx = urlContext("https://cdn.example.com/assets/js/bundle.js");
		const r = bench(() => evaluatePolicy(policy, ctx));
		console.log(formatBench("single regex", r));
		expect(r.avgUs).toBeLessThan(100);
	});

	it("compound regex (3 conditions AND'd)", () => {
		const policy = compoundRegexPolicy();
		const ctx = urlContext("https://www.example.com/assets/js/bundle-abc123.js");
		const r = bench(() => evaluatePolicy(policy, ctx));
		console.log(formatBench("compound regex (3 AND)", r));
		expect(r.avgUs).toBeLessThan(200);
	});

	it("wildcard condition (glob pattern)", () => {
		const policy = wildcardConditionPolicy();
		const ctx = urlContext("https://cdn.example.com/assets/img/logo.png");
		const r = bench(() => evaluatePolicy(policy, ctx));
		console.log(formatBench("wildcard glob", r));
		expect(r.avgUs).toBeLessThan(100);
	});

	it("multi-statement policy with mixed operators", () => {
		const policy = multiStatementPolicy();
		// Match the third statement (regex in any)
		const ctx = urlContext("https://api.example.com/v2/users");
		const r = bench(() => evaluatePolicy(policy, ctx));
		console.log(formatBench("multi-stmt mixed", r));
		expect(r.avgUs).toBeLessThan(200);
	});

	it("multi-statement policy — denied (must check all statements)", () => {
		const policy = multiStatementPolicy();
		// This URL won't match any statement
		const ctx = urlContext("https://example.com/about");
		const r = bench(() => evaluatePolicy(policy, ctx));
		console.log(formatBench("multi-stmt denied", r));
		expect(r.avgUs).toBeLessThan(200);
	});

	it("batch: 30 URL contexts with regex", () => {
		const policy = regexPolicy("^https://cdn\\.example\\.com/assets/");
		const ctxs = manyUrlContexts(30);
		const r = bench(() => evaluatePolicy(policy, ctxs), 1_000);
		console.log(formatBench("30-URL batch regex", r));
		expect(r.avgUs).toBeLessThan(3000); // ~100us per URL
	});

	it("batch: 500 URL contexts with compound regex", () => {
		const policy = compoundRegexPolicy();
		const ctxs = manyUrlContexts(500);
		const r = bench(() => evaluatePolicy(policy, ctxs), 100);
		console.log(formatBench("500-URL batch compound", r));
		// 500 URLs * ~20us each = ~10ms max
		expect(r.avgUs).toBeLessThan(50_000);
	});
});

describe("Performance — DO authorization (RPC)", () => {
	let keyIdSimple: string;
	let keyIdRegex: string;
	let keyIdCompound: string;

	beforeAll(async () => {
		const stub = getStub();
		const simple = await stub.createKey({
			name: "perf-simple",
			zone_id: ZONE_ID,
			policy: simpleEqPolicy(),
		} as CreateKeyRequest);
		keyIdSimple = simple.key.id;

		const regex = await stub.createKey({
			name: "perf-regex",
			zone_id: ZONE_ID,
			policy: regexPolicy("^https://cdn\\.example\\.com/assets/"),
		} as CreateKeyRequest);
		keyIdRegex = regex.key.id;

		const compound = await stub.createKey({
			name: "perf-compound",
			zone_id: ZONE_ID,
			policy: compoundRegexPolicy(),
		} as CreateKeyRequest);
		keyIdCompound = compound.key.id;
	});

	it("authorize — simple eq (via DO RPC)", async () => {
		const stub = getStub();
		const iterations = 200;
		const times: number[] = [];

		// Warmup
		for (let i = 0; i < 10; i++) {
			await stub.authorizeFromBody(keyIdSimple, ZONE_ID, { hosts: ["example.com"] });
		}

		for (let i = 0; i < iterations; i++) {
			const start = performance.now();
			const result = await stub.authorizeFromBody(keyIdSimple, ZONE_ID, { hosts: ["example.com"] });
			times.push(performance.now() - start);
			expect(result.authorized).toBe(true);
		}

		times.sort((a, b) => a - b);
		const totalMs = times.reduce((s, t) => s + t, 0);
		const avgUs = (totalMs / iterations) * 1000;
		const p99Us = times[Math.floor(iterations * 0.99)] * 1000;
		console.log(`DO RPC simple eq: avg=${avgUs.toFixed(0)}us p99=${p99Us.toFixed(0)}us`);
		expect(avgUs).toBeLessThan(5000); // DO RPC overhead is significant in tests
	});

	it("authorize — regex condition (via DO RPC)", async () => {
		const stub = getStub();
		const iterations = 200;
		const times: number[] = [];

		for (let i = 0; i < 10; i++) {
			await stub.authorizeFromBody(keyIdRegex, ZONE_ID, { files: ["https://cdn.example.com/assets/js/app.js"] });
		}

		for (let i = 0; i < iterations; i++) {
			const start = performance.now();
			const result = await stub.authorizeFromBody(keyIdRegex, ZONE_ID, { files: ["https://cdn.example.com/assets/js/app.js"] });
			times.push(performance.now() - start);
			expect(result.authorized).toBe(true);
		}

		times.sort((a, b) => a - b);
		const totalMs = times.reduce((s, t) => s + t, 0);
		const avgUs = (totalMs / iterations) * 1000;
		const p99Us = times[Math.floor(iterations * 0.99)] * 1000;
		console.log(`DO RPC regex: avg=${avgUs.toFixed(0)}us p99=${p99Us.toFixed(0)}us`);
		expect(avgUs).toBeLessThan(5000);
	});

	it("authorize — compound regex 3-AND (via DO RPC)", async () => {
		const stub = getStub();
		const iterations = 200;
		const times: number[] = [];

		for (let i = 0; i < 10; i++) {
			await stub.authorizeFromBody(keyIdCompound, ZONE_ID, { files: ["https://www.example.com/assets/js/bundle-abc.js"] });
		}

		for (let i = 0; i < iterations; i++) {
			const start = performance.now();
			const result = await stub.authorizeFromBody(keyIdCompound, ZONE_ID, { files: ["https://www.example.com/assets/js/bundle-abc.js"] });
			times.push(performance.now() - start);
			expect(result.authorized).toBe(true);
		}

		times.sort((a, b) => a - b);
		const totalMs = times.reduce((s, t) => s + t, 0);
		const avgUs = (totalMs / iterations) * 1000;
		const p99Us = times[Math.floor(iterations * 0.99)] * 1000;
		console.log(`DO RPC compound regex: avg=${avgUs.toFixed(0)}us p99=${p99Us.toFixed(0)}us`);
		expect(avgUs).toBeLessThan(5000);
	});

	it("concurrent authorization — 50 parallel requests", async () => {
		const stub = getStub();
		const concurrency = 50;

		const start = performance.now();
		const results = await Promise.all(
			Array.from({ length: concurrency }, (_, i) =>
				stub.authorizeFromBody(keyIdRegex, ZONE_ID, { files: [`https://cdn.example.com/assets/js/file-${i}.js`] }),
			),
		);
		const totalMs = performance.now() - start;

		const allAuthorized = results.every((r) => r.authorized);
		expect(allAuthorized).toBe(true);

		const avgMs = totalMs / concurrency;
		console.log(`50 concurrent DO RPCs: total=${totalMs.toFixed(0)}ms avg=${avgMs.toFixed(1)}ms/req`);
		// All 50 should complete within a reasonable window
		expect(totalMs).toBeLessThan(10_000);
	});
});
