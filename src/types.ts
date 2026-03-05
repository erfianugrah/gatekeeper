import type { PolicyDocument } from './policy-types';

// --- Purge request types ---

export type PurgeType = "single" | "bulk";

export interface ParsedPurgeRequest {
	type: PurgeType;
	/** Number of tokens to consume. For single-file: number of URLs. For bulk: always 1. */
	cost: number;
	/** Original parsed body */
	body: PurgeBody;
}

export interface PurgeBody {
	files?: (string | { url: string; headers?: Record<string, string> })[];
	hosts?: string[];
	tags?: string[];
	prefixes?: string[];
	purge_everything?: boolean;
}

// --- Token bucket types ---

export interface ConsumeResult {
	allowed: boolean;
	remaining: number;
	retryAfterSec: number;
}

export interface BucketConfig {
	rate: number;
	bucketSize: number;
	maxOps: number;
}

export interface RateLimitConfig {
	bulk: BucketConfig;
	single: BucketConfig;
}

// --- IAM types ---

export interface ApiKey {
	id: string;
	name: string;
	zone_id: string;
	created_at: number;
	expires_at: number | null;
	revoked: number;
	/** JSON-serialized PolicyDocument. NULL for v1 keys (use key_scopes table). */
	policy: string | null;
	/** Email of the user who created this key (from Access JWT). NULL for admin-key created keys. */
	created_by: string | null;
	/** Per-key bulk rate limit (req/sec). NULL = use account default. */
	bulk_rate: number | null;
	/** Per-key bulk bucket size. NULL = use account default. */
	bulk_bucket: number | null;
	/** Per-key single-file rate limit (URLs/sec). NULL = use account default. */
	single_rate: number | null;
	/** Per-key single-file bucket size. NULL = use account default. */
	single_bucket: number | null;
}

/** v1 scope — kept for backward compatibility during migration. */
export interface KeyScope {
	key_id: string;
	scope_type: ScopeType;
	scope_value: string;
}

export type ScopeType =
	| "url_prefix"
	| "host"
	| "tag"
	| "prefix"
	| "purge_everything"
	| "*";

/** v1 key creation request (backward compatible). */
export interface CreateKeyRequest {
	name: string;
	zone_id: string;
	expires_in_days?: number;
	scopes: { scope_type: ScopeType; scope_value: string }[];
	/** Optional per-key rate limit overrides. Enforced server-side to be <= account defaults. */
	rate_limit?: {
		bulk_rate?: number;
		bulk_bucket?: number;
		single_rate?: number;
		single_bucket?: number;
	};
}

/** v2 key creation request with policy document. */
export interface CreateKeyRequestV2 {
	name: string;
	zone_id: string;
	expires_in_days?: number;
	/** v2 policy document — replaces scopes. */
	policy: PolicyDocument;
	/** Email of the user creating this key (from Access JWT). */
	created_by?: string;
	/** Optional per-key rate limit overrides. */
	rate_limit?: {
		bulk_rate?: number;
		bulk_bucket?: number;
		single_rate?: number;
		single_bucket?: number;
	};
}

export interface AuthResult {
	authorized: boolean;
	error?: string;
	/** Which items were denied, if any */
	denied?: string[];
}

// --- Cached key for hot path ---

export interface CachedKey {
	key: ApiKey;
	scopes: KeyScope[];
	/** Parsed policy document, resolved from key.policy or migrated from scopes. */
	resolvedPolicy: PolicyDocument;
	cachedAt: number;
}

// --- Request collapsing types ---

export interface PurgeResult {
	status: number;
	body: string;
	headers: Record<string, string>;
	collapsed: boolean;
	/** Whether the request actually reached the Cloudflare upstream API. */
	reachedUpstream: boolean;
	rateLimitInfo: {
		remaining: number;
		secondsUntilRefill: number;
		bucketSize: number;
		rate: number;
	};
}
