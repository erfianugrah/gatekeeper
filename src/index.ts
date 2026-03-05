import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { TokenBucket } from "./token-bucket";
import { IamManager } from "./iam";
import { logPurgeEvent, queryEvents, querySummary } from "./analytics";
import type { PurgeEvent } from "./analytics";
import type {
	PurgeBody,
	ParsedPurgeRequest,
	ConsumeResult,
	RateLimitConfig,
	CreateKeyRequest,
	CreateKeyRequestV2,
	AuthResult,
	ApiKey,
	KeyScope,
	PurgeResult,
} from "./types";
import type { PolicyDocument, RequestContext } from "./policy-types";
import { validatePolicy } from "./policy-engine";

// ─── App types ──────────────────────────────────────────────────────────────

type HonoEnv = {
	Bindings: Env;
};

// All zones purged through this gateway share one upstream API token, which
// belongs to a single Cloudflare account. The purge rate limit is per-account,
// so we use one DO instance for everything (keyed by this fixed name).
const DO_NAME = "account";

/** Get the single account-level DO stub. */
function getStub(env: Env) {
	return env.PURGE_RATE_LIMITER.get(
		env.PURGE_RATE_LIMITER.idFromName(DO_NAME),
	);
}

// ─── Per-isolate request collapsing ─────────────────────────────────────────
// Deduplicates identical purge requests within the same V8 isolate before
// they hit the DO via RPC. Key = "zoneId\0bodyText".
// Stores Promise<PurgeResult> (serializable data) so every caller constructs
// its own Response — avoids the "body already consumed" bug with Response.clone().
// Entries are cleaned up 50ms after the promise settles to catch
// near-simultaneous requests arriving slightly later.

const ISOLATE_COLLAPSE_GRACE_MS = 50;
const inflightIsolate = new Map<string, Promise<PurgeResult>>();

/**
 * Clear the isolate-level inflight cache.
 * @internal Exported for testing only — do not use in production code.
 */
export function __testClearInflightCache() {
	inflightIsolate.clear();
}

// ─── Durable Object ────────────────────────────────────────────────────────

export class PurgeRateLimiter extends DurableObject<Env> {
	private bulkBucket!: TokenBucket;
	private singleBucket!: TokenBucket;
	private iam!: IamManager;

	/** Per-key rate limit buckets. Lazily created when a key with custom limits is first used. */
	private keyBuckets = new Map<string, { bulk: TokenBucket; single: TokenBucket }>();

	/** DO-level request collapsing map. Key = zoneId\0bodyText, cleaned up after settle + grace. */
	private inflightDO = new Map<string, Promise<PurgeResult>>();
	private static DO_COLLAPSE_GRACE_MS = 50;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		const config = parseConfig(env);
		this.bulkBucket = new TokenBucket(config.bulk.rate, config.bulk.bucketSize);
		this.singleBucket = new TokenBucket(config.single.rate, config.single.bucketSize);

		ctx.blockConcurrencyWhile(async () => {
			this.iam = new IamManager(
				ctx.storage.sql,
				Number(env.KEY_CACHE_TTL_MS) || 60_000,
			);
			this.iam.initTables();
		});
	}

	// ─── Purge with DO-level collapsing ─────────────────────────────────

	/**
	 * Combined rate-limit + upstream-fetch with request collapsing.
	 * Identical bodyText within the grace window shares one upstream call
	 * and one token deduction.
	 * keyId is used for per-key rate limiting (checked before the account-level bucket).
	 */
	async purge(
		zoneId: string,
		bodyText: string,
		type: "single" | "bulk",
		cost: number,
		upstreamToken: string,
		keyId?: string,
	): Promise<PurgeResult> {
		// Per-key rate limit check (runs before collapsing — each key's budget is independent)
		if (keyId) {
			const keyResult = this.checkPerKeyRateLimit(keyId, type, cost);
			if (keyResult) return keyResult;
		}

		// DO-level collapsing — key includes zoneId since multiple zones share this DO
		const collapseKey = `${zoneId}\0${bodyText}`;
		const existing = this.inflightDO.get(collapseKey);
		if (existing) {
			// Follower — reuse leader's result, no token consumed
			const result = await existing;
			return { ...result, collapsed: true };
		}

		// Leader — consume tokens and make the upstream call
		const promise = this.doPurge(zoneId, bodyText, type, cost, upstreamToken);

		this.inflightDO.set(collapseKey, promise);
		promise.finally(() => {
			setTimeout(() => {
				this.inflightDO.delete(collapseKey);
			}, PurgeRateLimiter.DO_COLLAPSE_GRACE_MS);
		});

		return promise;
	}

	/**
	 * Check per-key rate limit. Returns a PurgeResult if rate limited, null if allowed.
	 * Lazily creates per-key buckets from the key's stored rate limit config.
	 */
	private checkPerKeyRateLimit(
		keyId: string,
		type: "single" | "bulk",
		cost: number,
	): PurgeResult | null {
		const keyData = this.iam.getKey(keyId);
		if (!keyData) return null;

		const { key } = keyData;
		const hasBulkLimit = key.bulk_rate !== null && key.bulk_bucket !== null;
		const hasSingleLimit = key.single_rate !== null && key.single_bucket !== null;

		if ((type === "bulk" && !hasBulkLimit) || (type === "single" && !hasSingleLimit)) {
			return null; // no per-key limit for this type
		}

		// Lazily create per-key buckets
		let buckets = this.keyBuckets.get(keyId);
		if (!buckets) {
			buckets = {
				bulk: new TokenBucket(key.bulk_rate ?? 50, key.bulk_bucket ?? 500),
				single: new TokenBucket(key.single_rate ?? 3000, key.single_bucket ?? 6000),
			};
			this.keyBuckets.set(keyId, buckets);
		}

		const bucket = type === "single" ? buckets.single : buckets.bulk;
		const result = bucket.consume(cost);

		if (!result.allowed) {
			const name = type === "single" ? "purge-single-key" : "purge-bulk-key";
			return buildRateLimitResult(
				name,
				bucket,
				result,
				`Per-key rate limit exceeded. Retry after ${result.retryAfterSec} second(s).`,
			);
		}

		return null; // allowed
	}

	private async doPurge(
		zoneId: string,
		bodyText: string,
		type: "single" | "bulk",
		cost: number,
		upstreamToken: string,
	): Promise<PurgeResult> {
		const bucket = type === "single" ? this.singleBucket : this.bulkBucket;
		const consumeResult = bucket.consume(cost);

		const name = type === "single" ? "purge-single" : "purge-bulk";
		const window = Math.round(bucket.bucketSize / bucket.rate);

		if (!consumeResult.allowed) {
			return buildRateLimitResult(
				name,
				bucket,
				consumeResult,
				`Rate limit exceeded. Retry after ${consumeResult.retryAfterSec} second(s).`,
			);
		}

		// Upstream fetch
		const upstreamUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`;
		let upstreamResponse: Response;

		try {
			upstreamResponse = await fetch(upstreamUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${upstreamToken}`,
					"Content-Type": "application/json",
				},
				body: bodyText,
			});
		} catch (e: any) {
			return {
				status: 502,
				body: JSON.stringify({
					success: false,
					errors: [{ code: 502, message: `Upstream request failed: ${e.message}` }],
				}),
				headers: { "Content-Type": "application/json" },
				collapsed: false,
				reachedUpstream: false,
				rateLimitInfo: {
					remaining: bucket.getRemaining(),
					secondsUntilRefill: bucket.getSecondsUntilRefill(),
					bucketSize: bucket.bucketSize,
					rate: bucket.rate,
				},
			};
		}

		// Handle upstream 429 — drain bucket
		if (upstreamResponse.status === 429) {
			bucket.drain();
			const retryAfter = upstreamResponse.headers.get("Retry-After") || "5";
			const responseBody = await upstreamResponse.text();

			return {
				status: 429,
				body: responseBody,
				headers: {
					"Content-Type": upstreamResponse.headers.get("Content-Type") || "application/json",
					"Retry-After": retryAfter,
				},
				collapsed: false,
				reachedUpstream: true,
				rateLimitInfo: {
					remaining: 0,
					secondsUntilRefill: Number(retryAfter),
					bucketSize: bucket.bucketSize,
					rate: bucket.rate,
				},
			};
		}

		// Success
		const responseBody = await upstreamResponse.text();
		const remaining = bucket.getRemaining();
		const secondsUntilRefill = bucket.getSecondsUntilRefill();

		const responseHeaders: Record<string, string> = {
			"Content-Type": upstreamResponse.headers.get("Content-Type") || "application/json",
			Ratelimit: `"${name}";r=${remaining};t=${secondsUntilRefill}`,
			"Ratelimit-Policy": `"${name}";q=${bucket.bucketSize};w=${window}`,
		};

		const cfRay = upstreamResponse.headers.get("cf-ray");
		const auditId = upstreamResponse.headers.get("cf-auditlog-id");
		if (cfRay) responseHeaders["cf-ray"] = cfRay;
		if (auditId) responseHeaders["cf-auditlog-id"] = auditId;

		return {
			status: upstreamResponse.status,
			body: responseBody,
			headers: responseHeaders,
			collapsed: false,
			reachedUpstream: true,
			rateLimitInfo: {
				remaining,
				secondsUntilRefill,
				bucketSize: bucket.bucketSize,
				rate: bucket.rate,
			},
		};
	}

	// ─── Legacy RPC methods (kept for tests / direct use) ───────────────

	async consume(type: "single" | "bulk", count: number): Promise<ConsumeResult> {
		const bucket = type === "single" ? this.singleBucket : this.bulkBucket;
		return bucket.consume(count);
	}

	async getRateLimitInfo(type: "single" | "bulk") {
		const bucket = type === "single" ? this.singleBucket : this.bulkBucket;
		return {
			remaining: bucket.getRemaining(),
			secondsUntilRefill: bucket.getSecondsUntilRefill(),
			bucketSize: bucket.bucketSize,
			rate: bucket.rate,
		};
	}

	async drainBucket(type: "single" | "bulk"): Promise<void> {
		const bucket = type === "single" ? this.singleBucket : this.bulkBucket;
		bucket.drain();
	}

	async authorize(keyId: string, zoneId: string, body: PurgeBody): Promise<AuthResult> {
		return this.iam.authorize(keyId, zoneId, body);
	}

	async authorizeV2(keyId: string, zoneId: string, contexts: RequestContext[]): Promise<AuthResult> {
		return this.iam.authorizeV2(keyId, zoneId, contexts);
	}

	async createKey(req: CreateKeyRequest): Promise<{ key: ApiKey; scopes: KeyScope[] }> {
		return this.iam.createKey(req);
	}

	async createKeyV2(req: CreateKeyRequestV2): Promise<{ key: ApiKey }> {
		return this.iam.createKeyV2(req);
	}

	async listKeys(zoneId?: string, filter?: "active" | "revoked"): Promise<ApiKey[]> {
		return this.iam.listKeys(zoneId, filter);
	}

	async getKey(id: string): Promise<{ key: ApiKey; scopes: KeyScope[] } | null> {
		return this.iam.getKey(id);
	}

	async revokeKey(id: string): Promise<boolean> {
		this.keyBuckets.delete(id);
		return this.iam.revokeKey(id);
	}
}

// ─── Shared rate-limit 429 builder ──────────────────────────────────────────

function buildRateLimitResult(
	name: string,
	bucket: TokenBucket,
	consumeResult: ConsumeResult,
	message: string,
): PurgeResult {
	const window = Math.round(bucket.bucketSize / bucket.rate);
	return {
		status: 429,
		body: JSON.stringify({
			success: false,
			errors: [{ code: 429, message }],
			messages: [],
			result: null,
		}),
		headers: {
			"Content-Type": "application/json",
			"Retry-After": String(consumeResult.retryAfterSec),
			Ratelimit: `"${name}";r=${consumeResult.remaining};t=${consumeResult.retryAfterSec}`,
			"Ratelimit-Policy": `"${name}";q=${bucket.bucketSize};w=${window}`,
		},
		collapsed: false,
		reachedUpstream: false,
		rateLimitInfo: {
			remaining: consumeResult.remaining,
			secondsUntilRefill: consumeResult.retryAfterSec,
			bucketSize: bucket.bucketSize,
			rate: bucket.rate,
		},
	};
}

// ─── Hono app ───────────────────────────────────────────────────────────────

const app = new Hono<HonoEnv>();

// ─── Health ─────────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ ok: true }));

// ─── Purge ──────────────────────────────────────────────────────────────────

app.post("/v1/zones/:zoneId/purge_cache", async (c) => {
	const start = Date.now();
	const zoneId = c.req.param("zoneId");
	const env = c.env;

	// Wide log accumulator — one rich object emitted at the end
	const log: Record<string, unknown> = {
		route: "purge",
		method: "POST",
		zoneId,
		ts: new Date().toISOString(),
	};

	// Validate zone ID format
	if (!/^[a-f0-9]{32}$/.test(zoneId)) {
		log.status = 400;
		log.error = "invalid_zone_id";
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: "Invalid zone ID format" }] },
			400,
		);
	}

	// Check auth header presence early (before body parsing) to avoid leaking
	// validation details to unauthenticated callers
	const authHeader = c.req.header("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		log.status = 401;
		log.error = "missing_auth";
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 401, message: "Missing Authorization: Bearer <key>" }] },
			401,
		);
	}
	const keyId = authHeader.slice(7).trim();
	log.keyId = keyId.slice(0, 12) + "..."; // truncate for logs

	// Parse body
	let bodyText: string;
	let body: PurgeBody;
	try {
		bodyText = await c.req.text();
		body = JSON.parse(bodyText);
	} catch {
		log.status = 400;
		log.error = "invalid_json";
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: "Invalid JSON body" }] },
			400,
		);
	}

	// Classify purge type
	let parsed: ParsedPurgeRequest;
	try {
		parsed = classifyPurge(body, env);
	} catch (e: any) {
		log.status = 400;
		log.error = "invalid_purge_body";
		log.detail = e.message;
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: e.message }] },
			400,
		);
	}

	log.purgeType = parsed.type;
	log.cost = parsed.cost;

	// Get the single account-level DO stub
	const stub = getStub(env);

	// Full scope authorization (always per-request, never collapsed)
	const authResult = await stub.authorize(keyId, zoneId, body);
	if (!authResult.authorized) {
		const status = authResult.error === "Invalid API key" ? 401 : 403;
		log.status = status;
		log.error = "auth_failed";
		log.authError = authResult.error;
		log.denied = authResult.denied;
		log.durationMs = Date.now() - start;
		console.log(JSON.stringify(log));
		return c.json(
			{
				success: false,
				errors: [{ code: status, message: authResult.error }],
				...(authResult.denied ? { denied: authResult.denied } : {}),
			},
			status as 401 | 403,
		);
	}

	// ── Isolate-level request collapsing ────────────────────────────────
	// After auth passes, check if an identical request is already in-flight
	// in this isolate. If so, reuse its PurgeResult data (each caller gets
	// a fresh Response constructed from the shared data — no body-consumed bug).

	const collapseKey = `${zoneId}\0${bodyText}`;
	let result: PurgeResult;
	let collapsedAtIsolate = false;

	const existingFlight = inflightIsolate.get(collapseKey);
	if (existingFlight) {
		try {
			result = await existingFlight;
			collapsedAtIsolate = true;
		} catch {
			// Leader failed — fall through and become a new leader
			inflightIsolate.delete(collapseKey);
			result = await createAndTrackFlight(collapseKey, stub, zoneId, bodyText, parsed, env, keyId);
		}
	} else {
		result = await createAndTrackFlight(collapseKey, stub, zoneId, bodyText, parsed, env, keyId);
	}

	// Determine collapse level for logging
	const collapseLevel = collapsedAtIsolate ? "isolate" : result.collapsed ? "do" : false;
	log.collapsed = collapseLevel;
	log.rateLimitAllowed = result.status !== 429 || !!collapseLevel;
	log.rateLimitRemaining = result.rateLimitInfo.remaining;
	log.status = result.status;
	log.durationMs = Date.now() - start;

	if (result.status === 429) {
		const isUpstream = !result.headers["Ratelimit"]; // upstream 429 won't have our header
		log.error = isUpstream ? "upstream_rate_limited" : "client_rate_limited";
		log.retryAfterSec = Number(result.headers["Retry-After"] ?? 0);
	}

	console.log(JSON.stringify(log));

	// Log to D1 analytics asynchronously (fire-and-forget)
	if (env.ANALYTICS_DB) {
		const event: PurgeEvent = {
			key_id: keyId,
			zone_id: zoneId,
			purge_type: parsed.type,
			cost: parsed.cost,
			status: result.status,
			collapsed: collapseLevel,
			upstream_status: !collapseLevel && result.reachedUpstream ? result.status : null,
			duration_ms: Date.now() - start,
			created_at: Date.now(),
		};
		c.executionCtx.waitUntil(logPurgeEvent(env.ANALYTICS_DB, event));
	}

	// Every caller gets a fresh Response from the shared PurgeResult data
	return new Response(result.body, {
		status: result.status,
		headers: result.headers,
	});
});

/**
 * Create a new in-flight PurgeResult promise, store it in the isolate map,
 * and schedule cleanup after settlement.
 */
function createAndTrackFlight(
	collapseKey: string,
	stub: DurableObjectStub<PurgeRateLimiter>,
	zoneId: string,
	bodyText: string,
	parsed: ParsedPurgeRequest,
	env: Env,
	keyId?: string,
): Promise<PurgeResult> {
	const promise = stub.purge(
		zoneId,
		bodyText,
		parsed.type,
		parsed.cost,
		env.UPSTREAM_API_TOKEN,
		keyId,
	);

	inflightIsolate.set(collapseKey, promise);
	promise.finally(() => {
		setTimeout(() => {
			// Only delete if this is still our promise (not replaced by a newer leader)
			if (inflightIsolate.get(collapseKey) === promise) {
				inflightIsolate.delete(collapseKey);
			}
		}, ISOLATE_COLLAPSE_GRACE_MS);
	});

	return promise;
}

// ─── Admin: middleware ───────────────────────────────────────────────────────

const admin = new Hono<HonoEnv>();

admin.use("*", async (c, next) => {
	const adminKey = c.req.header("X-Admin-Key");
	if (!adminKey || !(await timingSafeEqual(adminKey, c.env.ADMIN_KEY))) {
		return c.json(
			{ success: false, errors: [{ code: 401, message: "Invalid admin key" }] },
			401,
		);
	}
	await next();
});

// ─── Admin: create key ──────────────────────────────────────────────────────
// Accepts both v1 (scopes) and v2 (policy) request bodies.
// v1: { name, zone_id, scopes: [{scope_type, scope_value}], ... }
// v2: { name, zone_id, policy: {version, statements}, ... }

admin.post("/keys", async (c) => {
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

	// Common required fields
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

	const hasPolicy = raw.policy && typeof raw.policy === "object";
	const hasScopes = Array.isArray(raw.scopes);

	if (hasPolicy && hasScopes) {
		log.status = 400;
		log.error = "both_policy_and_scopes";
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: "Provide either 'policy' (v2) or 'scopes' (v1), not both" }] },
			400,
		);
	}

	if (!hasPolicy && !hasScopes) {
		log.status = 400;
		log.error = "missing_auth_config";
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: "Required: either 'policy' (v2) or 'scopes[]' (v1)" }] },
			400,
		);
	}

	// Validate rate limits (shared between v1 and v2)
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

	const stub = getStub(c.env);

	// ── v2 path: policy document ──
	if (hasPolicy) {
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

		const req: CreateKeyRequestV2 = {
			name: raw.name as string,
			zone_id: raw.zone_id as string,
			policy: raw.policy as PolicyDocument,
			created_by: typeof raw.created_by === "string" ? raw.created_by : undefined,
			expires_in_days: typeof raw.expires_in_days === "number" ? raw.expires_in_days : undefined,
			rate_limit: rateLimit,
		};

		log.zoneId = req.zone_id;
		log.keyName = req.name;
		log.version = "v2";
		log.statementCount = req.policy.statements.length;

		const result = await stub.createKeyV2(req);

		log.status = 200;
		log.keyId = result.key.id.slice(0, 12) + "...";
		console.log(JSON.stringify(log));

		return c.json({ success: true, result });
	}

	// ── v1 path: scopes (backward compatible) ──
	const body = raw as unknown as CreateKeyRequest;

	if (!body.scopes || !Array.isArray(body.scopes)) {
		log.status = 400;
		log.error = "missing_scopes";
		console.log(JSON.stringify(log));
		return c.json(
			{ success: false, errors: [{ code: 400, message: "Required fields: scopes[]" }] },
			400,
		);
	}

	// Validate scope entries
	const validScopeTypes = new Set(["url_prefix", "host", "tag", "prefix", "purge_everything", "*"]);
	for (const s of body.scopes) {
		if (!s.scope_type || !s.scope_value || !validScopeTypes.has(s.scope_type)) {
			log.status = 400;
			log.error = "invalid_scope";
			console.log(JSON.stringify(log));
			return c.json(
				{
					success: false,
					errors: [{
						code: 400,
						message: `Invalid scope: each scope must have scope_type (${[...validScopeTypes].join(", ")}) and scope_value`,
					}],
				},
				400,
			);
		}
	}

	log.zoneId = body.zone_id;
	log.keyName = body.name;
	log.version = "v1";
	log.scopeCount = body.scopes.length;

	const result = await stub.createKey(body);

	log.status = 200;
	log.keyId = result.key.id.slice(0, 12) + "...";
	console.log(JSON.stringify(log));

	return c.json({ success: true, result });
});

// ─── Admin: list keys ───────────────────────────────────────────────────────

admin.get("/keys", async (c) => {
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

// ─── Admin: get key ─────────────────────────────────────────────────────────

admin.get("/keys/:id", async (c) => {
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

// ─── Admin: revoke key ──────────────────────────────────────────────────────

admin.delete("/keys/:id", async (c) => {
	const zoneId = c.req.query("zone_id");
	if (!zoneId) {
		return c.json(
			{ success: false, errors: [{ code: 400, message: "zone_id query param required" }] },
			400,
		);
	}

	const keyId = c.req.param("id");
	const stub = getStub(c.env);

	// Verify key belongs to the specified zone before revoking
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

// ─── Admin: analytics events ────────────────────────────────────────────────

admin.get("/analytics/events", async (c) => {
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

	const query: import("./analytics").AnalyticsQuery = {
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

// ─── Admin: analytics summary ───────────────────────────────────────────────

admin.get("/analytics/summary", async (c) => {
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

	const query: import("./analytics").AnalyticsQuery = {
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

// ─── Mount admin ────────────────────────────────────────────────────────────

app.route("/admin", admin);

// ─── Export ─────────────────────────────────────────────────────────────────

export default app;

// ─── Helpers ────────────────────────────────────────────────────────────────

function classifyPurge(body: PurgeBody, env: Env): ParsedPurgeRequest {
	const singleMaxOps = Number(env.SINGLE_MAX_OPS) || 500;
	const bulkMaxOps = Number(env.BULK_MAX_OPS) || 100;

	if (body.files && body.files.length > 0) {
		if (body.files.length > singleMaxOps) {
			throw new Error(`files array has ${body.files.length} items, max is ${singleMaxOps}`);
		}
		return { type: "single", cost: body.files.length, body };
	}

	if ("purge_everything" in body) {
		if (body.purge_everything !== true) {
			throw new Error("purge_everything must be boolean true");
		}
		return { type: "bulk", cost: 1, body };
	}

	const hasBulk =
		(body.hosts && body.hosts.length > 0) ||
		(body.tags && body.tags.length > 0) ||
		(body.prefixes && body.prefixes.length > 0);

	if (hasBulk) {
		const totalOps =
			(body.hosts?.length || 0) +
			(body.tags?.length || 0) +
			(body.prefixes?.length || 0);

		if (totalOps > bulkMaxOps) {
			throw new Error(`Total bulk operations is ${totalOps}, max per request is ${bulkMaxOps}`);
		}
		return { type: "bulk", cost: 1, body };
	}

	throw new Error("Request body must contain one of: files, hosts, tags, prefixes, or purge_everything");
}

/**
 * Constant-time string comparison to prevent timing attacks on admin key.
 * Uses HMAC-SHA256 so that both length and content are compared in constant time
 * (no early return on length mismatch leaking key length).
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	// Use a fixed key to HMAC both strings — this normalizes them to equal-length digests
	const hmacKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode("purge-gw-admin-compare"),
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

function parseConfig(env: Env): RateLimitConfig {
	return {
		bulk: {
			rate: Number(env.BULK_RATE) || 50,
			bucketSize: Number(env.BULK_BUCKET_SIZE) || 500,
			maxOps: Number(env.BULK_MAX_OPS) || 100,
		},
		single: {
			rate: Number(env.SINGLE_RATE) || 3000,
			bucketSize: Number(env.SINGLE_BUCKET_SIZE) || 6000,
			maxOps: Number(env.SINGLE_MAX_OPS) || 500,
		},
	};
}
