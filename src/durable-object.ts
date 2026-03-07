import { DurableObject } from 'cloudflare:workers';
import { TokenBucket } from './token-bucket';
import { RequestCollapser } from './request-collapse';
import { IamManager } from './iam';
import { S3CredentialManager } from './s3/iam';
import { UpstreamTokenManager } from './upstream-tokens';
import { UpstreamR2Manager } from './s3/upstream-r2';
import { ConfigManager } from './config-registry';
import { generateFlightId } from './crypto';
import type {
	PurgeBody,
	ConsumeResult,
	CreateKeyRequest,
	AuthResult,
	ApiKey,
	PurgeResult,
	RateClass,
	BulkResult,
	BulkDryRunResult,
} from './types';
import type { S3Credential, CreateS3CredentialRequest } from './s3/types';
import type { UpstreamToken, CreateUpstreamTokenRequest } from './upstream-tokens';
import type { UpstreamR2, CreateUpstreamR2Request, R2Credentials } from './s3/upstream-r2';
import type { GatewayConfig, ConfigOverride } from './config-registry';
import type { RequestContext } from './policy-types';

// ─── Rate-limit 429 builder ─────────────────────────────────────────────────

function buildRateLimitResult(name: string, bucket: TokenBucket, consumeResult: ConsumeResult, message: string): PurgeResult {
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
			'Content-Type': 'application/json',
			'Retry-After': String(consumeResult.retryAfterSec),
			Ratelimit: `"${name}";r=${consumeResult.remaining};t=${consumeResult.retryAfterSec}`,
			'Ratelimit-Policy': `"${name}";q=${bucket.bucketSize};w=${window}`,
		},
		collapsed: false,
		reachedUpstream: false,
		flightId: generateFlightId(),
		rateLimitInfo: {
			remaining: consumeResult.remaining,
			secondsUntilRefill: consumeResult.retryAfterSec,
			bucketSize: bucket.bucketSize,
			rate: bucket.rate,
		},
	};
}

// ─── Durable Object ─────────────────────────────────────────────────────────

export class Gatekeeper extends DurableObject<Env> {
	private bulkBucket!: TokenBucket;
	private singleBucket!: TokenBucket;
	private s3Bucket!: TokenBucket;
	private iam!: IamManager;
	private s3Iam!: S3CredentialManager;
	private upstreamTokens!: UpstreamTokenManager;
	private upstreamR2!: UpstreamR2Manager;
	private configManager!: ConfigManager;

	/** Per-key rate limit buckets. Lazily created when a key with custom limits is first used. */
	private keyBuckets = new Map<string, { bulk: TokenBucket; single: TokenBucket }>();

	/** DO-level request collapsing. */
	private collapser = new RequestCollapser<PurgeResult>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		ctx.blockConcurrencyWhile(async () => {
			this.configManager = new ConfigManager(ctx.storage.sql);
			this.configManager.initTable();

			const gwConfig = this.configManager.getConfig(env);
			const rlConfig = ConfigManager.toRateLimitConfig(gwConfig);

			this.bulkBucket = new TokenBucket(rlConfig.bulk.rate, rlConfig.bulk.bucketSize);
			this.singleBucket = new TokenBucket(rlConfig.single.rate, rlConfig.single.bucketSize);
			this.s3Bucket = new TokenBucket(gwConfig.s3_rps, gwConfig.s3_burst);

			const cacheTtl = gwConfig.key_cache_ttl_ms;

			this.iam = new IamManager(ctx.storage.sql, cacheTtl);
			this.iam.initTables();

			this.s3Iam = new S3CredentialManager(ctx.storage.sql, cacheTtl);
			this.s3Iam.initTables();

			this.upstreamTokens = new UpstreamTokenManager(ctx.storage.sql, cacheTtl);
			this.upstreamTokens.initTables();

			this.upstreamR2 = new UpstreamR2Manager(ctx.storage.sql, cacheTtl);
			this.upstreamR2.initTables();
		});
	}

	/** Rebuild token buckets from the current config. Only recreates if rate-limit values changed. */
	private rebuildBuckets(): void {
		const gwConfig = this.configManager.getConfig(this.env);
		const rlConfig = ConfigManager.toRateLimitConfig(gwConfig);

		// Only rebuild if rate-limit config actually changed — preserves remaining tokens otherwise
		const bulkChanged = this.bulkBucket.rate !== rlConfig.bulk.rate || this.bulkBucket.bucketSize !== rlConfig.bulk.bucketSize;
		const singleChanged = this.singleBucket.rate !== rlConfig.single.rate || this.singleBucket.bucketSize !== rlConfig.single.bucketSize;
		const s3Changed = this.s3Bucket.rate !== gwConfig.s3_rps || this.s3Bucket.bucketSize !== gwConfig.s3_burst;

		if (bulkChanged) {
			this.bulkBucket = new TokenBucket(rlConfig.bulk.rate, rlConfig.bulk.bucketSize);
		}
		if (singleChanged) {
			this.singleBucket = new TokenBucket(rlConfig.single.rate, rlConfig.single.bucketSize);
		}
		if (s3Changed) {
			this.s3Bucket = new TokenBucket(gwConfig.s3_rps, gwConfig.s3_burst);
		}
		if (bulkChanged || singleChanged) {
			// Clear per-key buckets so they pick up new account defaults
			this.keyBuckets.clear();
		}
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
		rateClass: RateClass,
		tokens: number,
		upstreamToken: string,
		keyId?: string,
	): Promise<PurgeResult> {
		// Guard: tokens must be positive to prevent rate limit bypass
		if (tokens <= 0) tokens = 1;

		// Per-key rate limit check (runs before collapsing — each key's budget is independent)
		if (keyId) {
			const keyResult = this.checkPerKeyRateLimit(keyId, rateClass, tokens);
			if (keyResult) return keyResult;
		}

		// DO-level collapsing — key includes zoneId since multiple zones share this DO
		const collapseKey = `${zoneId}\0${bodyText}`;
		const { result, collapsed } = await this.collapser.collapseOrCreate(collapseKey, () =>
			this.doPurge(zoneId, bodyText, rateClass, tokens, upstreamToken),
		);

		if (collapsed) {
			return { ...result, collapsed: true };
		}
		return result;
	}

	/**
	 * Check per-key rate limit. Returns a PurgeResult if rate limited, null if allowed.
	 * Lazily creates per-key buckets from the key's stored rate limit config.
	 */
	private checkPerKeyRateLimit(keyId: string, rateClass: RateClass, tokens: number): PurgeResult | null {
		const keyData = this.iam.getKey(keyId);
		if (!keyData) return null;

		const { key } = keyData;
		const hasBulkLimit = key.bulk_rate !== null && key.bulk_bucket !== null;
		const hasSingleLimit = key.single_rate !== null && key.single_bucket !== null;

		if ((rateClass === 'bulk' && !hasBulkLimit) || (rateClass === 'single' && !hasSingleLimit)) {
			return null;
		}

		let buckets = this.keyBuckets.get(keyId);
		if (!buckets) {
			const gwConfig = this.configManager.getConfig(this.env);
			buckets = {
				bulk: new TokenBucket(key.bulk_rate ?? gwConfig.bulk_rate, key.bulk_bucket ?? gwConfig.bulk_bucket_size),
				single: new TokenBucket(key.single_rate ?? gwConfig.single_rate, key.single_bucket ?? gwConfig.single_bucket_size),
			};
			this.keyBuckets.set(keyId, buckets);
		}

		const bucket = rateClass === 'single' ? buckets.single : buckets.bulk;
		const result = bucket.consume(tokens);

		if (!result.allowed) {
			const name = rateClass === 'single' ? 'purge-single-key' : 'purge-bulk-key';
			return buildRateLimitResult(name, bucket, result, `Per-key rate limit exceeded. Retry after ${result.retryAfterSec} second(s).`);
		}

		return null;
	}

	private async doPurge(
		zoneId: string,
		bodyText: string,
		rateClass: RateClass,
		tokens: number,
		upstreamToken: string,
	): Promise<PurgeResult> {
		const bucket = rateClass === 'single' ? this.singleBucket : this.bulkBucket;
		const consumeResult = bucket.consume(tokens);

		const name = rateClass === 'single' ? 'purge-single' : 'purge-bulk';
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
				method: 'POST',
				headers: {
					Authorization: `Bearer ${upstreamToken}`,
					'Content-Type': 'application/json',
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
				headers: { 'Content-Type': 'application/json' },
				collapsed: false,
				reachedUpstream: false,
				flightId: generateFlightId(),
				rateLimitInfo: {
					remaining: bucket.getRemaining(),
					secondsUntilRefill: bucket.getSecondsUntilRefill(),
					bucketSize: bucket.bucketSize,
					rate: bucket.rate,
				},
			};
		}

		const flightId = generateFlightId();

		// Handle upstream 429 — drain bucket
		if (upstreamResponse.status === 429) {
			bucket.drain();
			const retryAfter = upstreamResponse.headers.get('Retry-After') || '5';
			const responseBody = await upstreamResponse.text();

			return {
				status: 429,
				body: responseBody,
				headers: {
					'Content-Type': upstreamResponse.headers.get('Content-Type') || 'application/json',
					'Retry-After': retryAfter,
				},
				collapsed: false,
				reachedUpstream: true,
				flightId,
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
			'Content-Type': upstreamResponse.headers.get('Content-Type') || 'application/json',
			Ratelimit: `"${name}";r=${remaining};t=${secondsUntilRefill}`,
			'Ratelimit-Policy': `"${name}";q=${bucket.bucketSize};w=${window}`,
		};

		const cfRay = upstreamResponse.headers.get('cf-ray');
		const auditId = upstreamResponse.headers.get('cf-auditlog-id');
		if (cfRay) responseHeaders['cf-ray'] = cfRay;
		if (auditId) responseHeaders['cf-auditlog-id'] = auditId;

		return {
			status: upstreamResponse.status,
			body: responseBody,
			headers: responseHeaders,
			collapsed: false,
			reachedUpstream: true,
			flightId,
			rateLimitInfo: {
				remaining,
				secondsUntilRefill,
				bucketSize: bucket.bucketSize,
				rate: bucket.rate,
			},
		};
	}

	// ─── RPC methods ────────────────────────────────────────────────────

	async consume(rateClass: RateClass, count: number): Promise<ConsumeResult> {
		const bucket = rateClass === 'single' ? this.singleBucket : this.bulkBucket;
		return bucket.consume(count);
	}

	async getRateLimitInfo(rateClass: RateClass) {
		const bucket = rateClass === 'single' ? this.singleBucket : this.bulkBucket;
		return {
			remaining: bucket.getRemaining(),
			secondsUntilRefill: bucket.getSecondsUntilRefill(),
			bucketSize: bucket.bucketSize,
			rate: bucket.rate,
		};
	}

	async drainBucket(rateClass: RateClass): Promise<void> {
		const bucket = rateClass === 'single' ? this.singleBucket : this.bulkBucket;
		bucket.drain();
	}

	async authorizeFromBody(keyId: string, zoneId: string, body: PurgeBody, requestFields?: Record<string, string>): Promise<AuthResult> {
		return this.iam.authorizeFromBody(keyId, zoneId, body, requestFields);
	}

	async createKey(req: CreateKeyRequest): Promise<{ key: ApiKey }> {
		return this.iam.createKey(req);
	}

	async listKeys(zoneId?: string, filter?: 'active' | 'revoked'): Promise<ApiKey[]> {
		return this.iam.listKeys(zoneId, filter);
	}

	async getKey(id: string): Promise<{ key: ApiKey } | null> {
		return this.iam.getKey(id);
	}

	async revokeKey(id: string): Promise<boolean> {
		this.keyBuckets.delete(id);
		return this.iam.revokeKey(id);
	}

	async deleteKey(id: string): Promise<boolean> {
		this.keyBuckets.delete(id);
		return this.iam.deleteKey(id);
	}

	async bulkRevokeKeys(ids: string[]): Promise<BulkResult> {
		const result = this.iam.bulkRevoke(ids);
		for (const item of result.results) {
			if (item.status === 'revoked') this.keyBuckets.delete(item.id);
		}
		return result;
	}

	async bulkDeleteKeys(ids: string[]): Promise<BulkResult> {
		const result = this.iam.bulkDelete(ids);
		for (const item of result.results) {
			if (item.status === 'deleted') this.keyBuckets.delete(item.id);
		}
		return result;
	}

	async bulkInspectKeys(ids: string[], wouldBecome: string): Promise<BulkDryRunResult> {
		return this.iam.bulkInspect(ids, wouldBecome);
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

	async deleteS3Credential(accessKeyId: string): Promise<boolean> {
		return this.s3Iam.deleteCredential(accessKeyId);
	}

	async bulkRevokeS3Credentials(accessKeyIds: string[]): Promise<BulkResult> {
		return this.s3Iam.bulkRevoke(accessKeyIds);
	}

	async bulkDeleteS3Credentials(accessKeyIds: string[]): Promise<BulkResult> {
		return this.s3Iam.bulkDelete(accessKeyIds);
	}

	async bulkInspectS3Credentials(accessKeyIds: string[], wouldBecome: string): Promise<BulkDryRunResult> {
		return this.s3Iam.bulkInspect(accessKeyIds, wouldBecome);
	}

	/** Get the secret for Sig V4 verification. Returns null if credential is invalid/revoked/expired. */
	async getS3Secret(accessKeyId: string): Promise<string | null> {
		return this.s3Iam.getSecretForAuth(accessKeyId);
	}

	/** Authorize an S3 request against the credential's policy. */
	async authorizeS3(accessKeyId: string, contexts: RequestContext[]): Promise<AuthResult> {
		return this.s3Iam.authorize(accessKeyId, contexts);
	}

	/** Consume one S3 rate-limit token. Returns allowed/retry info for the account-level S3 bucket. */
	async consumeS3RateLimit(): Promise<ConsumeResult> {
		return this.s3Bucket.consume(1);
	}

	// ─── Upstream Token RPC methods ─────────────────────────────────────

	async createUpstreamToken(req: CreateUpstreamTokenRequest): Promise<{ token: UpstreamToken }> {
		return this.upstreamTokens.createToken(req);
	}

	async listUpstreamTokens(): Promise<UpstreamToken[]> {
		return this.upstreamTokens.listTokens();
	}

	async getUpstreamToken(id: string): Promise<{ token: UpstreamToken } | null> {
		return this.upstreamTokens.getToken(id);
	}

	async deleteUpstreamToken(id: string): Promise<boolean> {
		return this.upstreamTokens.deleteToken(id);
	}

	async bulkDeleteUpstreamTokens(ids: string[]): Promise<BulkResult> {
		return this.upstreamTokens.bulkDelete(ids);
	}

	async bulkInspectUpstreamTokens(ids: string[], wouldBecome: string): Promise<BulkDryRunResult> {
		return this.upstreamTokens.bulkInspect(ids, wouldBecome);
	}

	/** Resolve the CF API token for a given zone. Returns null if no match. */
	async resolveUpstreamToken(zoneId: string): Promise<string | null> {
		return this.upstreamTokens.resolveTokenForZone(zoneId);
	}

	// ─── Upstream R2 RPC methods ────────────────────────────────────────

	async createUpstreamR2(req: CreateUpstreamR2Request): Promise<{ endpoint: UpstreamR2 }> {
		return this.upstreamR2.createEndpoint(req);
	}

	async listUpstreamR2(): Promise<UpstreamR2[]> {
		return this.upstreamR2.listEndpoints();
	}

	async getUpstreamR2(id: string): Promise<{ endpoint: UpstreamR2 } | null> {
		return this.upstreamR2.getEndpoint(id);
	}

	async deleteUpstreamR2(id: string): Promise<boolean> {
		return this.upstreamR2.deleteEndpoint(id);
	}

	async bulkDeleteUpstreamR2(ids: string[]): Promise<BulkResult> {
		return this.upstreamR2.bulkDelete(ids);
	}

	async bulkInspectUpstreamR2(ids: string[], wouldBecome: string): Promise<BulkDryRunResult> {
		return this.upstreamR2.bulkInspect(ids, wouldBecome);
	}

	/** Resolve R2 credentials for a bucket. Returns null if no match. */
	async resolveR2ForBucket(bucket: string): Promise<R2Credentials | null> {
		return this.upstreamR2.resolveForBucket(bucket);
	}

	/** Resolve R2 credentials for ListBuckets (no specific bucket). */
	async resolveR2ForListBuckets(): Promise<R2Credentials | null> {
		return this.upstreamR2.resolveForListBuckets();
	}

	// ─── Config Registry RPC methods ────────────────────────────────────

	/** Get the full resolved config. */
	async getConfig(): Promise<GatewayConfig> {
		return this.configManager.getConfig(this.env);
	}

	/** Set one or more config values, rebuild token buckets, and return the resolved config. */
	async setConfig(updates: Record<string, number>, updatedBy?: string): Promise<GatewayConfig> {
		this.configManager.setConfig(updates, updatedBy);
		this.rebuildBuckets();
		return this.configManager.getConfig(this.env);
	}

	/** Reset a config key to env/default, rebuild token buckets, and return { deleted, config }. */
	async resetConfigKey(key: string): Promise<{ deleted: boolean; config: GatewayConfig }> {
		const deleted = this.configManager.resetKey(key);
		if (deleted) {
			this.rebuildBuckets();
		}
		return { deleted, config: this.configManager.getConfig(this.env) };
	}

	/** List all config overrides stored in the registry. */
	async listConfigOverrides(): Promise<ConfigOverride[]> {
		return this.configManager.listOverrides();
	}
}
