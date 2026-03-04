import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	validateScope,
	ScopeError,
	SCOPE_TYPES,
	formatDuration,
} from "./ui.js";
import { resolveConfig, resolveZoneId } from "./client.js";

// ---------- validateScope ----------

describe("validateScope", () => {
	it("parses host scope", () => {
		expect(validateScope("host:example.com")).toEqual({
			scope_type: "host",
			scope_value: "example.com",
		});
	});

	it("parses tag scope", () => {
		expect(validateScope("tag:product-page")).toEqual({
			scope_type: "tag",
			scope_value: "product-page",
		});
	});

	it("parses prefix scope", () => {
		expect(validateScope("prefix:example.com/blog")).toEqual({
			scope_type: "prefix",
			scope_value: "example.com/blog",
		});
	});

	it("parses url_prefix scope with full URL (colon in value)", () => {
		expect(validateScope("url_prefix:https://example.com/assets/")).toEqual({
			scope_type: "url_prefix",
			scope_value: "https://example.com/assets/",
		});
	});

	it("parses purge_everything scope", () => {
		expect(validateScope("purge_everything:true")).toEqual({
			scope_type: "purge_everything",
			scope_value: "true",
		});
	});

	it("parses wildcard scope", () => {
		expect(validateScope("*:*")).toEqual({
			scope_type: "*",
			scope_value: "*",
		});
	});

	it("trims whitespace", () => {
		expect(validateScope("  host:example.com  ")).toEqual({
			scope_type: "host",
			scope_value: "example.com",
		});
	});

	it("throws format error for missing colon", () => {
		expect(() => validateScope("example.com")).toThrow(ScopeError);
		try {
			validateScope("example.com");
		} catch (e) {
			const err = e as ScopeError;
			expect(err.kind).toBe("format");
			expect(err.raw).toBe("example.com");
		}
	});

	it("throws format error for plain path", () => {
		expect(() => validateScope("waf.example.com/blocklists")).toThrow(ScopeError);
		try {
			validateScope("waf.example.com/blocklists");
		} catch (e) {
			const err = e as ScopeError;
			expect(err.kind).toBe("format");
		}
	});

	it("throws type error for unknown scope type", () => {
		expect(() => validateScope("hostname:example.com")).toThrow(ScopeError);
		try {
			validateScope("hostname:example.com");
		} catch (e) {
			const err = e as ScopeError;
			expect(err.kind).toBe("type");
			expect(err.raw).toBe("hostname:example.com");
		}
	});

	it("throws type error for 'domain' type", () => {
		expect(() => validateScope("domain:example.com")).toThrow(ScopeError);
		try {
			validateScope("domain:example.com");
		} catch (e) {
			expect((e as ScopeError).kind).toBe("type");
		}
	});

	it("handles empty scope type before colon", () => {
		// ":value" — empty string is not a valid scope type
		expect(() => validateScope(":example.com")).toThrow(ScopeError);
		try {
			validateScope(":example.com");
		} catch (e) {
			expect((e as ScopeError).kind).toBe("type");
		}
	});

	it("handles empty scope value after colon", () => {
		// "host:" — valid type, empty value (the API will reject it, but parsing succeeds)
		expect(validateScope("host:")).toEqual({
			scope_type: "host",
			scope_value: "",
		});
	});

	it("accepts all valid scope types", () => {
		for (const t of SCOPE_TYPES) {
			const result = validateScope(`${t}:test`);
			expect(result.scope_type).toBe(t);
			expect(result.scope_value).toBe("test");
		}
	});
});

// ---------- formatDuration ----------

describe("formatDuration", () => {
	it("formats milliseconds under 1s", () => {
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(1)).toBe("1ms");
		expect(formatDuration(150)).toBe("150ms");
		expect(formatDuration(999)).toBe("999ms");
	});

	it("formats seconds at 1s boundary", () => {
		expect(formatDuration(1000)).toBe("1.0s");
	});

	it("formats seconds with decimal", () => {
		expect(formatDuration(1500)).toBe("1.5s");
		expect(formatDuration(2345)).toBe("2.3s");
		expect(formatDuration(10000)).toBe("10.0s");
	});
});

// ---------- resolveConfig ----------

describe("resolveConfig", () => {
	const origEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...origEnv };
	});

	it("uses defaults when no args or env", () => {
		delete process.env["PURGE_GATEWAY_URL"];
		delete process.env["PURGE_GATEWAY_ADMIN_KEY"];
		delete process.env["PURGE_GATEWAY_API_KEY"];

		const config = resolveConfig({});
		expect(config.baseUrl).toBe("https://purge.erfi.io");
		expect(config.adminKey).toBeUndefined();
		expect(config.apiKey).toBeUndefined();
	});

	it("prefers args over env vars", () => {
		process.env["PURGE_GATEWAY_URL"] = "https://env.example.com";
		process.env["PURGE_GATEWAY_ADMIN_KEY"] = "env-admin";
		process.env["PURGE_GATEWAY_API_KEY"] = "env-api";

		const config = resolveConfig({
			endpoint: "https://arg.example.com",
			"admin-key": "arg-admin",
			"api-key": "arg-api",
		});
		expect(config.baseUrl).toBe("https://arg.example.com");
		expect(config.adminKey).toBe("arg-admin");
		expect(config.apiKey).toBe("arg-api");
	});

	it("falls back to env vars when args missing", () => {
		process.env["PURGE_GATEWAY_URL"] = "https://env.example.com";
		process.env["PURGE_GATEWAY_ADMIN_KEY"] = "env-admin";
		process.env["PURGE_GATEWAY_API_KEY"] = "env-api";

		const config = resolveConfig({});
		expect(config.baseUrl).toBe("https://env.example.com");
		expect(config.adminKey).toBe("env-admin");
		expect(config.apiKey).toBe("env-api");
	});

	it("strips trailing slashes from URL", () => {
		const config = resolveConfig({
			endpoint: "https://example.com///",
		});
		expect(config.baseUrl).toBe("https://example.com");
	});
});

// ---------- resolveZoneId ----------

describe("resolveZoneId", () => {
	const origEnv = { ...process.env };
	beforeEach(() => {
		vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		process.env = { ...origEnv };
		vi.restoreAllMocks();
	});

	it("uses --zone-id arg", () => {
		const zoneId = resolveZoneId({ "zone-id": "abc123" });
		expect(zoneId).toBe("abc123");
		expect(process.exit).not.toHaveBeenCalled();
	});

	it("falls back to env var", () => {
		process.env["PURGE_GATEWAY_ZONE_ID"] = "env-zone";
		const zoneId = resolveZoneId({});
		expect(zoneId).toBe("env-zone");
		expect(process.exit).not.toHaveBeenCalled();
	});

	it("prefers arg over env", () => {
		process.env["PURGE_GATEWAY_ZONE_ID"] = "env-zone";
		const zoneId = resolveZoneId({ "zone-id": "arg-zone" });
		expect(zoneId).toBe("arg-zone");
	});

	it("exits when neither arg nor env set", () => {
		delete process.env["PURGE_GATEWAY_ZONE_ID"];
		resolveZoneId({});
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});

// ---------- ScopeError ----------

describe("ScopeError", () => {
	it("has correct name property", () => {
		const err = new ScopeError("test", "format", "raw");
		expect(err.name).toBe("ScopeError");
		expect(err.message).toBe("test");
		expect(err.kind).toBe("format");
		expect(err.raw).toBe("raw");
	});

	it("is instanceof Error", () => {
		const err = new ScopeError("test", "type", "raw");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(ScopeError);
	});
});

// ---------- SCOPE_TYPES constant ----------

describe("SCOPE_TYPES", () => {
	it("includes all expected types", () => {
		expect(SCOPE_TYPES).toContain("host");
		expect(SCOPE_TYPES).toContain("tag");
		expect(SCOPE_TYPES).toContain("prefix");
		expect(SCOPE_TYPES).toContain("url_prefix");
		expect(SCOPE_TYPES).toContain("purge_everything");
		expect(SCOPE_TYPES).toContain("*");
		expect(SCOPE_TYPES).toHaveLength(6);
	});
});
