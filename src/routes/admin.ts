import { Hono } from "hono";
import { queryEvents, querySummary } from "../analytics";
import type { AnalyticsQuery } from "../analytics";
import { validatePolicy } from "../policy-engine";
import { validateAccessJwt } from "../auth-access";
import { parseConfig } from "../durable-object";
import type { CreateKeyRequest, HonoEnv } from "../types";
import type { PolicyDocument } from "../policy-types";
import type { CreateS3CredentialRequest } from "../s3/types";

// ─── DO stub helper ─────────────────────────────────────────────────────────

const DO_NAME = "account";

function getStub(env: Env) {
	return env.PURGE_RATE_LIMITER.get(
		env.PURGE_RATE_LIMITER.idFromName(DO_NAME),
	);
}

// ─── Admin sub-app ──────────────────────────────────────────────────────────

export const adminApp = new Hono<HonoEnv>();

// ─── Auth middleware ────────────────────────────────────────────────────────

adminApp.use("*", async (c, next) => {
	// 1. Try Cloudflare Access JWT (if configured)
	if (c.env.CF_ACCESS_TEAM_NAME && c.env.CF_ACCESS_AUD) {
		const identity = await validateAccessJwt(c.req.raw, c.env.CF_ACCESS_TEAM_NAME, c.env.CF_ACCESS_AUD);
		if (identity) {
			c.set("accessIdentity", identity);
			await next();
			return;
		}
	}

	// 2. Fall back to X-Admin-Key
	const adminKey = c.req.header("X-Admin-Key");
	if (adminKey && (await timingSafeEqual(adminKey, c.env.ADMIN_KEY))) {
		await next();
		return;
	}

	return c.json(
		{ success: false, errors: [{ code: 401, message: "Unauthorized" }] },
		401,
	);
});

// ─── Create key ─────────────────────────────────────────────────────────────

adminApp.post("/keys", async (c) => {
	const log: Record<string, unknown> = {
		route: "admin.createKey",
		ts: new Date().toISOString(),
	};

	let raw: Record<string, unknown>;
	try {
		raw = await c.req.json<Record<string, unknown>>();
	} catch {
		log.status = 400;
		log.error = "invalid_json";
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: "Invalid JSON body" }] },
			400,
		);
	}

	if (!raw.name || typeof raw.name !== "string") {
		log.status = 400;
		log.error = "missing_name";
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: "Required field: name (string)" }] },
			400,
		);
	}
	if (!raw.zone_id || typeof raw.zone_id !== "string") {
		log.status = 400;
		log.error = "missing_zone_id";
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: "Required field: zone_id (string)" }] },
			400,
		);
	}

	if (!raw.policy || typeof raw.policy !== "object") {
		log.status = 400;
		log.error = "missing_policy";
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: "Required field: policy (object with version + statements)" }] },
			400,
		);
	}

	const policyErrors = validatePolicy(raw.policy);
	if (policyErrors.length > 0) {
		log.status = 400;
		log.error = "invalid_policy";
		log.policyErrors = policyErrors;
		console.log(JSON.stringify(log));
		return c.json(
			{
				success: false,
				errors: policyErrors.map((e) => ({
					code: 400,
					message: `${e.path}: ${e.message}`,
				})),
			},
			400,
		);
	}

	const rateLimit = raw.rate_limit as CreateKeyRequest["rate_limit"] | undefined;
	if (rateLimit) {
		const rateLimitError = validateRateLimits(rateLimit, c.env);
		if (rateLimitError) {
			log.status = 400;
			log.error = "rate_limit_exceeds_account";
			console.log(JSON.stringify(log));
			return c.json(
				{ success: false, errors: [{ code: 400, message: rateLimitError }] },
				400,
			);
		}
	}

	const identity = c.get("accessIdentity");
	const req: CreateKeyRequest = {
		name: raw.name as string,
		zone_id: raw.zone_id as string,
		policy: raw.policy as PolicyDocument,
		created_by: identity?.email ?? (typeof raw.created_by === "string" ? raw.created_by : undefined),
		expires_in_days: typeof raw.expires_in_days === "number" ? raw.expires_in_days : undefined,
		rate_limit: rateLimit,
	};

	log.zoneId = req.zone_id;
	log.keyName = req.name;
	log.statementCount = req.policy.statements.length;

	const stub = getStub(c.env);
	const result = await stub.createKey(req);

	log.status = 200;
	log.keyId = result.key.id.slice(0, 12) + "...";
	console.log(JSON.stringify(log));

	return c.json({ success: true, result });
});

// ─── List keys ──────────────────────────────────────────────────────────────

adminApp.get("/keys", async (c) => {
	const zoneId = c.req.query("zone_id");
	if (!zoneId) {
		return c.json(
			{ success: false, errors: [{ code: 400, message: "zone_id query param required" }] },
			400,
		);
	}

	const statusFilter = c.req.query("status") as "active" | "revoked" | undefined;
	const validFilters = ["active", "revoked"];
	const filter = statusFilter && validFilters.includes(statusFilter) ? statusFilter : undefined;

	const stub = getStub(c.env);
	const keys = await stub.listKeys(zoneId, filter);

	console.log(JSON.stringify({
		route: "admin.listKeys",
		zoneId,
		filter: filter ?? "all",
		count: keys.length,
		ts: new Date().toISOString(),
	}));

	return c.json({ success: true, result: keys });
});

// ─── Get key ────────────────────────────────────────────────────────────────

adminApp.get("/keys/:id", async (c) => {
	const zoneId = c.req.query("zone_id");
	if (!zoneId) {
		return c.json(
			{ success: false, errors: [{ code: 400, message: "zone_id query param required" }] },
			400,
		);
	}

	const keyId = c.req.param("id");
	const stub = getStub(c.env);
	const result = await stub.getKey(keyId);

	if (!result || result.key.zone_id !== zoneId) {
		return c.json(
			{ success: false, errors: [{ code: 404, message: "Key not found" }] },
			404,
		);
	}

	return c.json({ success: true, result });
});

// ─── Revoke key ─────────────────────────────────────────────────────────────

adminApp.delete("/keys/:id", async (c) => {
	const zoneId = c.req.query("zone_id");
	if (!zoneId) {
		return c.json(
			{ success: false, errors: [{ code: 400, message: "zone_id query param required" }] },
			400,
		);
	}

	const keyId = c.req.param("id");
	const stub = getStub(c.env);

	const existing = await stub.getKey(keyId);
	if (!existing || existing.key.zone_id !== zoneId) {
		return c.json(
			{ success: false, errors: [{ code: 404, message: "Key not found or already revoked" }] },
			404,
		);
	}

	const revoked = await stub.revokeKey(keyId);

	const log: Record<string, unknown> = {
		route: "admin.revokeKey",
		zoneId,
		keyId: keyId.slice(0, 12) + "...",
		revoked,
		ts: new Date().toISOString(),
	};
	console.log(JSON.stringify(log));

	if (!revoked) {
		return c.json(
			{ success: false, errors: [{ code: 404, message: "Key not found or already revoked" }] },
			404,
		);
	}

	return c.json({ success: true, result: { revoked: true } });
});

// ─── Analytics: events ──────────────────────────────────────────────────────

adminApp.get("/analytics/events", async (c) => {
	const zoneId = c.req.query("zone_id");
	if (!zoneId) {
		return c.json(
			{ success: false, errors: [{ code: 400, message: "zone_id query param required" }] },
			400,
		);
	}

	if (!c.env.ANALYTICS_DB) {
		return c.json(
			{ success: false, errors: [{ code: 503, message: "Analytics not configured" }] },
			503,
		);
	}

	const query: AnalyticsQuery = {
		zone_id: zoneId,
		key_id: c.req.query("key_id") || undefined,
		since: c.req.query("since") ? Number(c.req.query("since")) : undefined,
		until: c.req.query("until") ? Number(c.req.query("until")) : undefined,
		limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
	};

	const events = await queryEvents(c.env.ANALYTICS_DB, query);

	console.log(JSON.stringify({
		route: "admin.analytics.events",
		zoneId,
		count: events.length,
		ts: new Date().toISOString(),
	}));

	return c.json({ success: true, result: events });
});

// ─── Analytics: summary ─────────────────────────────────────────────────────

adminApp.get("/analytics/summary", async (c) => {
	const zoneId = c.req.query("zone_id");
	if (!zoneId) {
		return c.json(
			{ success: false, errors: [{ code: 400, message: "zone_id query param required" }] },
			400,
		);
	}

	if (!c.env.ANALYTICS_DB) {
		return c.json(
			{ success: false, errors: [{ code: 503, message: "Analytics not configured" }] },
			503,
		);
	}

	const query: AnalyticsQuery = {
		zone_id: zoneId,
		key_id: c.req.query("key_id") || undefined,
		since: c.req.query("since") ? Number(c.req.query("since")) : undefined,
		until: c.req.query("until") ? Number(c.req.query("until")) : undefined,
	};

	const summary = await querySummary(c.env.ANALYTICS_DB, query);

	console.log(JSON.stringify({
		route: "admin.analytics.summary",
		zoneId,
		totalRequests: summary.total_requests,
		ts: new Date().toISOString(),
	}));

	return c.json({ success: true, result: summary });
});

// ─── S3 Credentials: create ─────────────────────────────────────────────────

adminApp.post("/s3/credentials", async (c) => {
	const log: Record<string, unknown> = {
		route: "admin.createS3Credential",
		ts: new Date().toISOString(),
	};

	let raw: Record<string, unknown>;
	try {
		raw = await c.req.json<Record<string, unknown>>();
	} catch {
		log.status = 400;
		log.error = "invalid_json";
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: "Invalid JSON body" }] },
			400,
		);
	}

	if (!raw.name || typeof raw.name !== "string") {
		log.status = 400;
		log.error = "missing_name";
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: "Required field: name (string)" }] },
			400,
		);
	}

	if (!raw.policy || typeof raw.policy !== "object") {
		log.status = 400;
		log.error = "missing_policy";
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: "Required field: policy (object with version + statements)" }] },
			400,
		);
	}

	const policyErrors = validatePolicy(raw.policy);
	if (policyErrors.length > 0) {
		log.status = 400;
		log.error = "invalid_policy";
		log.policyErrors = policyErrors;
		console.log(JSON.stringify(log));
		return c.json(
			{
				success: false,
				errors: policyErrors.map((e) => ({
					code: 400,
					message: `${e.path}: ${e.message}`,
				})),
			},
			400,
		);
	}

	const identity = c.get("accessIdentity");
	const req: CreateS3CredentialRequest = {
		name: raw.name as string,
		policy: raw.policy as PolicyDocument,
		created_by: identity?.email ?? (typeof raw.created_by === "string" ? raw.created_by : undefined),
		expires_in_days: typeof raw.expires_in_days === "number" ? raw.expires_in_days : undefined,
	};

	log.credentialName = req.name;
	log.statementCount = req.policy.statements.length;

	const stub = getStub(c.env);
	const result = await stub.createS3Credential(req);

	log.status = 200;
	log.accessKeyId = result.credential.access_key_id;
	console.log(JSON.stringify(log));

	return c.json({ success: true, result });
});

// ─── S3 Credentials: list ───────────────────────────────────────────────────

adminApp.get("/s3/credentials", async (c) => {
	const statusFilter = c.req.query("status") as "active" | "revoked" | undefined;
	const validFilters = ["active", "revoked"];
	const filter = statusFilter && validFilters.includes(statusFilter) ? statusFilter : undefined;

	const stub = getStub(c.env);
	const credentials = await stub.listS3Credentials(filter);

	console.log(JSON.stringify({
		route: "admin.listS3Credentials",
		filter: filter ?? "all",
		count: credentials.length,
		ts: new Date().toISOString(),
	}));

	return c.json({ success: true, result: credentials });
});

// ─── S3 Credentials: get ────────────────────────────────────────────────────

adminApp.get("/s3/credentials/:id", async (c) => {
	const accessKeyId = c.req.param("id");
	const stub = getStub(c.env);
	const result = await stub.getS3Credential(accessKeyId);

	if (!result) {
		return c.json(
			{ success: false, errors: [{ code: 404, message: "Credential not found" }] },
			404,
		);
	}

	return c.json({ success: true, result });
});

// ─── S3 Credentials: revoke ─────────────────────────────────────────────────

adminApp.delete("/s3/credentials/:id", async (c) => {
	const accessKeyId = c.req.param("id");
	const stub = getStub(c.env);

	const existing = await stub.getS3Credential(accessKeyId);
	if (!existing) {
		return c.json(
			{ success: false, errors: [{ code: 404, message: "Credential not found or already revoked" }] },
			404,
		);
	}

	const revoked = await stub.revokeS3Credential(accessKeyId);

	console.log(JSON.stringify({
		route: "admin.revokeS3Credential",
		accessKeyId,
		revoked,
		ts: new Date().toISOString(),
	}));

	if (!revoked) {
		return c.json(
			{ success: false, errors: [{ code: 404, message: "Credential not found or already revoked" }] },
			404,
		);
	}

	return c.json({ success: true, result: { revoked: true } });
});

// ─── Private helpers ────────────────────────────────────────────────────────

/**
 * Constant-time string comparison to prevent timing attacks on admin key.
 * Uses HMAC-SHA256 so that both length and content are compared in constant time.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const hmacKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode("gatekeeper-admin-compare"),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const [macA, macB] = await Promise.all([
		crypto.subtle.sign("HMAC", hmacKey, encoder.encode(a)),
		crypto.subtle.sign("HMAC", hmacKey, encoder.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(macA, macB);
}

/** Validate per-key rate limits against account defaults. Returns error string or null. */
function validateRateLimits(rl: NonNullable<CreateKeyRequest["rate_limit"]>, env: Env): string | null {
	const config = parseConfig(env);
	const errors: string[] = [];
	if (rl.bulk_rate != null && rl.bulk_rate > config.bulk.rate) {
		errors.push(`bulk_rate ${rl.bulk_rate} exceeds account default ${config.bulk.rate}`);
	}
	if (rl.bulk_bucket != null && rl.bulk_bucket > config.bulk.bucketSize) {
		errors.push(`bulk_bucket ${rl.bulk_bucket} exceeds account default ${config.bulk.bucketSize}`);
	}
	if (rl.single_rate != null && rl.single_rate > config.single.rate) {
		errors.push(`single_rate ${rl.single_rate} exceeds account default ${config.single.rate}`);
	}
	if (rl.single_bucket != null && rl.single_bucket > config.single.bucketSize) {
		errors.push(`single_bucket ${rl.single_bucket} exceeds account default ${config.single.bucketSize}`);
	}
	if (errors.length > 0) {
		return `Per-key rate limits must not exceed account defaults: ${errors.join("; ")}`;
	}
	return null;
}
