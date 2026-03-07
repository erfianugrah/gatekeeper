import type { PolicyDocument } from './policy-types';
import type { AccessIdentity } from './auth-access';

// --- Hono env ───────────────────────────────────────────────────────────────

/** Admin role hierarchy: admin > operator > viewer. */
export type AdminRole = 'admin' | 'operator' | 'viewer';

type HonoEnv = {
	Bindings: Env;
	Variables: {
		/** Set when authenticated via Cloudflare Access JWT (dashboard SSO). */
		accessIdentity?: AccessIdentity;
		/** Resolved RBAC role for the current admin request. */
		adminRole?: AdminRole;
	};
};

export type { HonoEnv };

// --- Purge request types ---

/** Human-readable purge operation type stored in analytics. */
export type PurgeType = 'host' | 'tag' | 'prefix' | 'url' | 'everything';

/** Rate-limit bucket class — determines which token bucket is used. */
export type RateClass = 'bulk' | 'single';

export interface ParsedPurgeRequest {
	type: PurgeType;
	/** Which rate-limit bucket to consume from. */
	rateClass: RateClass;
	/** Number of rate-limit tokens to consume. For url: number of URLs. For bulk types: always 1. */
	tokens: number;
	/** Human-readable summary of the purge target — hosts, URLs, tags, prefixes, or "all". */
	target: string;
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
	zone_id: string | null;
	created_at: number;
	expires_at: number | null;
	revoked: number;
	/** JSON-serialized PolicyDocument. */
	policy: string;
	/** Email of the user who created this key (from Access SSO or request body). NULL if not provided. */
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

/** Key creation request with policy document. */
export interface CreateKeyRequest {
	name: string;
	zone_id?: string;
	expires_in_days?: number;
	/** Policy document. */
	policy: PolicyDocument;
	/** Email of the user creating this key. */
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
	/** Parsed policy document from key.policy. */
	resolvedPolicy: PolicyDocument;
	cachedAt: number;
}

// --- Bulk operation types ---

/** Per-item status from a bulk revoke operation. */
export type BulkRevokeStatus = 'revoked' | 'already_revoked' | 'not_found';

/** Per-item status from a bulk delete operation. */
export type BulkDeleteStatus = 'deleted' | 'not_found';

/** Per-item result for a bulk operation. */
export interface BulkItemResult {
	id: string;
	status: BulkRevokeStatus | BulkDeleteStatus;
}

/** Response payload for a bulk operation. */
export interface BulkResult {
	processed: number;
	results: BulkItemResult[];
}

/** Per-item preview for a dry-run bulk operation. */
export interface BulkInspectItem {
	id: string;
	current_status: 'active' | 'revoked' | 'expired' | 'not_found';
	would_become: string;
}

/** Response payload for a dry-run bulk operation. */
export interface BulkDryRunResult {
	dry_run: true;
	would_process: number;
	items: BulkInspectItem[];
}

// --- Request collapsing types ---

export interface PurgeResult {
	status: number;
	body: string;
	headers: Record<string, string>;
	collapsed: boolean;
	/** Whether the request actually reached the Cloudflare upstream API. */
	reachedUpstream: boolean;
	/** Stable identifier linking a leader to its collapsed followers. */
	flightId: string;
	rateLimitInfo: {
		remaining: number;
		secondsUntilRefill: number;
		bucketSize: number;
		rate: number;
	};
}
