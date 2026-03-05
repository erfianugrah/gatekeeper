import { DurableObject } from "cloudflare:workers";
import { TokenBucket } from "./token-bucket";
import { IamManager } from "./iam";
import { S3CredentialManager } from "./s3/iam";
import type {
	PurgeBody,
	ConsumeResult,
	RateLimitConfig,
	CreateKeyRequest,
	AuthResult,
	ApiKey,
	PurgeResult,
} from "./types";
import type { S3Credential, CreateS3CredentialRequest } from "./s3/types";
import type { RequestContext } from "./policy-types";

// ─── Config ─────────────────────────────────────────────────────────────────

export function parseConfig(env: Env): RateLimitConfig {
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

// ─── Rate-limit 429 builder ─────────────────────────────────────────────────

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

// ─── Durable Object ─────────────────────────────────────────────────────────

export class PurgeRateLimiter extends DurableObject<Env> {
	private bulkBucket!: TokenBucket;
	private singleBucket!: TokenBucket;
	private iam!: IamManager;
	private s3Iam!: S3CredentialManager;

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
			const cacheTtl = Number(env.KEY_CACHE_TTL_MS) || 60_000;

			this.iam = new IamManager(ctx.storage.sql, cacheTtl);
			this.iam.initTables();

			this.s3Iam = new S3CredentialManager(ctx.storage.sql, cacheTtl);
			this.s3Iam.initTables();
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
			return null;
		}

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

		return null;
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

		// Success (or non-429 error from upstream)
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

	// ─── RPC methods ────────────────────────────────────────────────────

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

	async authorizeFromBody(keyId: string, zoneId: string, body: PurgeBody): Promise<AuthResult> {
		return this.iam.authorizeFromBody(keyId, zoneId, body);
	}

	async createKey(req: CreateKeyRequest): Promise<{ key: ApiKey }> {
		return this.iam.createKey(req);
	}

	async listKeys(zoneId?: string, filter?: "active" | "revoked"): Promise<ApiKey[]> {
		return this.iam.listKeys(zoneId, filter);
	}

	async getKey(id: string): Promise<{ key: ApiKey } | null> {
		return this.iam.getKey(id);
	}

	async revokeKey(id: string): Promise<boolean> {
		this.keyBuckets.delete(id);
		return this.iam.revokeKey(id);
	}

	// ─── S3 Credential RPC methods ──────────────────────────────────────

	async createS3Credential(req: CreateS3CredentialRequest): Promise<{ credential: S3Credential }> {
		return this.s3Iam.createCredential(req);
	}

	async listS3Credentials(filter?: 'active' | 'revoked'): Promise<S3Credential[]> {
		return this.s3Iam.listCredentials(filter);
	}

	async getS3Credential(accessKeyId: string): Promise<{ credential: S3Credential } | null> {
		return this.s3Iam.getCredential(accessKeyId);
	}

	async revokeS3Credential(accessKeyId: string): Promise<boolean> {
		return this.s3Iam.revokeCredential(accessKeyId);
	}

	/** Get the secret for Sig V4 verification. Returns null if credential is invalid/revoked/expired. */
	async getS3Secret(accessKeyId: string): Promise<string | null> {
		return this.s3Iam.getSecretForAuth(accessKeyId);
	}

	/** Authorize an S3 request against the credential's policy. */
	async authorizeS3(accessKeyId: string, contexts: RequestContext[]): Promise<AuthResult> {
		return this.s3Iam.authorize(accessKeyId, contexts);
	}
}
