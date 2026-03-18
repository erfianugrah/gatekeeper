import { DurableObject } from 'cloudflare:workers';
import { TokenBucket } from './token-bucket';
import { RequestCollapser } from './request-collapse';
import { IamManager } from './iam';
import { S3CredentialManager } from './s3/iam';
import { UpstreamTokenManager } from './upstream-tokens';
import { UpstreamR2Manager } from './s3/upstream-r2';
import { ConfigManager } from './config-registry';
import { UserManager } from './user-manager';
import { SessionManager } from './session-manager';
import { generateFlightId } from './crypto';
import { CF_API_BASE, DEFAULT_RETRY_AFTER_SEC } from './constants';
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
import type { User, CreateUserRequest } from './user-manager';
import type { Session } from './session-manager';
import type { AdminRole } from './types';

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
	private cfProxyBucket!: TokenBucket;
	private iam!: IamManager;
	private s3Iam!: S3CredentialManager;
	private upstreamTokens!: UpstreamTokenManager;
	private upstreamR2!: UpstreamR2Manager;
	private configManager!: ConfigManager;
	private users!: UserManager;
	private sessions!: SessionManager;

	/** Per-key rate limit buckets. Lazily created when a key with custom limits is first used. Capped at MAX_KEY_BUCKETS. */
	private keyBuckets = new Map<string, { bulk: TokenBucket; single: TokenBucket }>();
	private static readonly MAX_KEY_BUCKETS = 1024;

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
			this.cfProxyBucket = new TokenBucket(gwConfig.cf_proxy_rps, gwConfig.cf_proxy_burst);

			const cacheTtl = gwConfig.key_cache_ttl_ms;

			this.iam = new IamManager(ctx.storage.sql, cacheTtl);
			this.iam.initTables();

			this.s3Iam = new S3CredentialManager(ctx.storage.sql, cacheTtl);
			this.s3Iam.initTables();

			this.upstreamTokens = new UpstreamTokenManager(ctx.storage.sql, cacheTtl);
			this.upstreamTokens.initTables();

			this.upstreamR2 = new UpstreamR2Manager(ctx.storage.sql, cacheTtl);
			this.upstreamR2.initTables();

			this.users = new UserManager(ctx.storage.sql);
			this.users.initTable();

			this.sessions = new SessionManager(ctx.storage.sql);
			this.sessions.initTable();

			console.log(
				JSON.stringify({
					breadcrumb: 'do-init',
					bulkRate: rlConfig.bulk.rate,
					bulkBucket: rlConfig.bulk.bucketSize,
					singleRate: rlConfig.single.rate,
					singleBucket: rlConfig.single.bucketSize,
					s3Rps: gwConfig.s3_rps,
					s3Burst: gwConfig.s3_burst,
					cfProxyRps: gwConfig.cf_proxy_rps,
					cfProxyBurst: gwConfig.cf_proxy_burst,
					cacheTtlMs: cacheTtl,
				}),
			);
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
		const cfProxyChanged = this.cfProxyBucket.rate !== gwConfig.cf_proxy_rps || this.cfProxyBucket.bucketSize !== gwConfig.cf_proxy_burst;

		if (bulkChanged) {
			this.bulkBucket = new TokenBucket(rlConfig.bulk.rate, rlConfig.bulk.bucketSize);
		}
		if (singleChanged) {
			this.singleBucket = new TokenBucket(rlConfig.single.rate, rlConfig.single.bucketSize);
		}
		if (s3Changed) {
			this.s3Bucket = new TokenBucket(gwConfig.s3_rps, gwConfig.s3_burst);
		}
		if (cfProxyChanged) {
			this.cfProxyBucket = new TokenBucket(gwConfig.cf_proxy_rps, gwConfig.cf_proxy_burst);
		}
		if (bulkChanged || singleChanged) {
			// Clear per-key buckets so they pick up new account defaults
			this.keyBuckets.clear();
		}

		if (bulkChanged || singleChanged || s3Changed || cfProxyChanged) {
			console.log(
				JSON.stringify({
					breadcrumb: 'do-rebuild-buckets',
					bulkChanged,
					singleChanged,
					s3Changed,
					cfProxyChanged,
					keyBucketsCleared: bulkChanged || singleChanged,
				}),
			);
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
			// Evict least-recently-used entry if at capacity to prevent unbounded memory growth
			if (this.keyBuckets.size >= Gatekeeper.MAX_KEY_BUCKETS) {
				const lru = this.keyBuckets.keys().next().value!;
				this.keyBuckets.delete(lru);
			}
			const gwConfig = this.configManager.getConfig(this.env);
			buckets = {
				bulk: new TokenBucket(key.bulk_rate ?? gwConfig.bulk_rate, key.bulk_bucket ?? gwConfig.bulk_bucket_size),
				single: new TokenBucket(key.single_rate ?? gwConfig.single_rate, key.single_bucket ?? gwConfig.single_bucket_size),
			};
			this.keyBuckets.set(keyId, buckets);
		} else {
			// Move to end of Map for LRU eviction — most recently used keys are last
			this.keyBuckets.delete(keyId);
			this.keyBuckets.set(keyId, buckets);
		}

		const bucket = rateClass === 'single' ? buckets.single : buckets.bulk;
		const result = bucket.consume(tokens);

		if (!result.allowed) {
			console.log(
				JSON.stringify({
					breadcrumb: 'do-per-key-rate-limited',
					keyId,
					rateClass,
					tokens,
					remaining: result.remaining,
					retryAfterSec: result.retryAfterSec,
				}),
			);
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
			console.log(
				JSON.stringify({
					breadcrumb: 'do-account-rate-limited',
					zoneId,
					rateClass,
					tokens,
					remaining: consumeResult.remaining,
					retryAfterSec: consumeResult.retryAfterSec,
				}),
			);
			return buildRateLimitResult(
				name,
				bucket,
				consumeResult,
				`Rate limit exceeded. Retry after ${consumeResult.retryAfterSec} second(s).`,
			);
		}

		// Upstream fetch
		const upstreamUrl = `${CF_API_BASE}/zones/${zoneId}/purge_cache`;
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
			console.log(
				JSON.stringify({
					breadcrumb: 'do-upstream-fetch-error',
					zoneId,
					error: e.message,
				}),
			);
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
			const retryAfter = upstreamResponse.headers.get('Retry-After') || String(DEFAULT_RETRY_AFTER_SEC);
			console.log(
				JSON.stringify({
					breadcrumb: 'do-upstream-429-drain',
					zoneId,
					rateClass,
					retryAfter,
					flightId,
				}),
			);
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

		console.log(
			JSON.stringify({
				breadcrumb: 'do-upstream-response',
				zoneId,
				rateClass,
				status: upstreamResponse.status,
				remaining,
				flightId,
			}),
		);

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

	async getRateLimitInfo(rateClass: RateClass): Promise<{
		remaining: number;
		secondsUntilRefill: number;
		bucketSize: number;
		rate: number;
	}> {
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

	/** Generic policy authorization — takes pre-built RequestContexts directly. Used by DNS and future services. */
	async authorize(keyId: string, zoneId: string, contexts: RequestContext[]): Promise<AuthResult> {
		return this.iam.authorize(keyId, zoneId, contexts);
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

	async rotateKey(id: string, overrides?: { name?: string; expires_in_days?: number }): Promise<{ oldKey: ApiKey; newKey: ApiKey } | null> {
		const result = this.iam.rotateKey(id, overrides);
		if (result) {
			this.keyBuckets.delete(id);
		}
		return result;
	}

	async updateKey(
		id: string,
		updates: {
			name?: string;
			expires_at?: number | null;
			bulk_rate?: number | null;
			bulk_bucket?: number | null;
			single_rate?: number | null;
			single_bucket?: number | null;
		},
	): Promise<{ key: ApiKey } | null> {
		const result = this.iam.updateKey(id, updates);
		if (result) {
			// Clear per-key bucket cache so updated rate limits take effect immediately
			this.keyBuckets.delete(id);
		}
		return result;
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

	async rotateS3Credential(
		accessKeyId: string,
		overrides?: { name?: string; expires_in_days?: number },
	): Promise<{ oldCredential: S3Credential; newCredential: S3Credential } | null> {
		return this.s3Iam.rotateCredential(accessKeyId, overrides);
	}

	async updateS3Credential(
		accessKeyId: string,
		updates: {
			name?: string;
			expires_at?: number | null;
		},
	): Promise<{ credential: S3Credential } | null> {
		return this.s3Iam.updateCredential(accessKeyId, updates);
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

	/** Consume one CF proxy rate-limit token. Returns allowed/retry info for the account-level CF proxy bucket. */
	async consumeCfProxyRateLimit(): Promise<ConsumeResult> {
		return this.cfProxyBucket.consume(1);
	}

	/** Drain the CF proxy bucket (call when upstream returns 429). */
	async drainCfProxyBucket(): Promise<void> {
		this.cfProxyBucket.drain();
	}

	// ─── Referential integrity queries ──────────────────────────────────

	/** Count active API keys bound to a given upstream token. */
	async countKeysByUpstreamToken(upstreamTokenId: string): Promise<number> {
		return this.iam.countKeysByUpstreamToken(upstreamTokenId);
	}

	/** Count active S3 credentials bound to a given upstream R2 endpoint. */
	async countS3CredentialsByUpstreamToken(upstreamTokenId: string): Promise<number> {
		return this.s3Iam.countCredentialsByUpstreamToken(upstreamTokenId);
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

	async updateUpstreamToken(id: string, updates: { name?: string; expires_at?: number | null }): Promise<{ token: UpstreamToken } | null> {
		return this.upstreamTokens.updateToken(id, updates);
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

	/** Resolve the CF API token for a given account. Returns null if no match. */
	async resolveUpstreamAccountToken(accountId: string): Promise<string | null> {
		return this.upstreamTokens.resolveTokenForAccount(accountId);
	}

	/** Resolve the CF API token by its upstream token ID. Returns null if not found. */
	async resolveUpstreamTokenById(tokenId: string): Promise<string | null> {
		return this.upstreamTokens.resolveTokenById(tokenId);
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

	async updateUpstreamR2(id: string, updates: { name?: string; expires_at?: number | null }): Promise<{ endpoint: UpstreamR2 } | null> {
		return this.upstreamR2.updateEndpoint(id, updates);
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

	/** Resolve R2 credentials by upstream R2 endpoint ID. Returns null if not found. */
	async resolveR2ById(endpointId: string): Promise<R2Credentials | null> {
		return this.upstreamR2.resolveR2ById(endpointId);
	}

	// ─── Expired entity cleanup ────────────────────────────────────────

	/** Revoke expired API keys + S3 credentials, delete expired upstream tokens + R2 endpoints + sessions. */
	async cleanupExpired(): Promise<{
		keysRevoked: number;
		s3CredsRevoked: number;
		upstreamTokensDeleted: number;
		upstreamR2Deleted: number;
		sessionsDeleted: number;
	}> {
		const keysRevoked = this.iam.revokeExpired();
		const s3CredsRevoked = this.s3Iam.revokeExpired();
		const upstreamTokensDeleted = this.upstreamTokens.deleteExpired();
		const upstreamR2Deleted = this.upstreamR2.deleteExpired();
		const sessionsDeleted = this.sessions.deleteExpired();
		return { keysRevoked, s3CredsRevoked, upstreamTokensDeleted, upstreamR2Deleted, sessionsDeleted };
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

	// ─── User RPC methods ──────────────────────────────────────────────

	async createUser(req: CreateUserRequest): Promise<User> {
		return this.users.createUser(req);
	}

	async verifyCredentials(email: string, password: string): Promise<User | null> {
		return this.users.verifyCredentials(email, password);
	}

	async listUsers(): Promise<User[]> {
		return this.users.listUsers();
	}

	async getUser(id: string): Promise<User | null> {
		return this.users.getUser(id);
	}

	async getUserByEmail(email: string): Promise<User | null> {
		return this.users.getUserByEmail(email);
	}

	async updateUserRole(id: string, role: AdminRole): Promise<User | null> {
		return this.users.updateUserRole(id, role);
	}

	async updateUserPassword(id: string, newPassword: string): Promise<boolean> {
		const result = await this.users.updateUserPassword(id, newPassword);
		if (result) {
			// Revoke all sessions for the user on password change
			this.sessions.deleteUserSessions(id);
		}
		return result;
	}

	async deleteUser(id: string): Promise<boolean> {
		// Revoke all sessions before deleting the user
		this.sessions.deleteUserSessions(id);
		return this.users.deleteUser(id);
	}

	async countUsers(): Promise<number> {
		return this.users.countUsers();
	}

	// ─── Session RPC methods ───────────────────────────────────────────

	async createSession(userId: string, email: string, role: AdminRole): Promise<Session> {
		return this.sessions.createSession(userId, email, role);
	}

	async validateSession(sessionId: string): Promise<Session | null> {
		return this.sessions.validateSession(sessionId);
	}

	async deleteSession(sessionId: string): Promise<boolean> {
		return this.sessions.deleteSession(sessionId);
	}

	async deleteUserSessions(userId: string): Promise<number> {
		return this.sessions.deleteUserSessions(userId);
	}

	async deleteExpiredSessions(): Promise<number> {
		return this.sessions.deleteExpired();
	}
}
