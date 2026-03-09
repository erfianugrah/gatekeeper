// ─── Shared constants ───────────────────────────────────────────────────────
// Centralised magic values used across the worker codebase.
// Import individual constants rather than importing the whole module.

// ─── Cloudflare API ─────────────────────────────────────────────────────────

/** Base URL for the Cloudflare v4 API. */
export const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

// ─── Time ───────────────────────────────────────────────────────────────────

/** Milliseconds in one day (86 400 000). */
export const MS_PER_DAY = 86_400_000;

/** Default in-memory cache TTL for key / credential / token lookups (1 minute). */
export const DEFAULT_CACHE_TTL_MS = 60_000;

/** Default Retry-After value (seconds) when the upstream doesn't provide one. */
export const DEFAULT_RETRY_AFTER_SEC = 5;

/** JWT clock-skew tolerance in seconds (matches AWS Sig V4 convention). */
export const JWT_CLOCK_SKEW_SEC = 60;

// ─── HTTP / Auth ────────────────────────────────────────────────────────────

/** Bearer token prefix used in Authorization headers. */
export const BEARER_PREFIX = 'Bearer ';

/** Admin API key header name. */
export const ADMIN_KEY_HEADER = 'X-Admin-Key';

/** Cloudflare Access JWT header. */
export const CF_ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';

/** Cloudflare Access cookie name. */
export const CF_ACCESS_COOKIE = 'CF_Authorization';

// ─── Validation ─────────────────────────────────────────────────────────────

/** Regex for a 32-hex-char Cloudflare zone ID. */
export const ZONE_ID_RE = /^[a-f0-9]{32}$/;

/** Regex for a 32-hex-char Cloudflare account ID. Same format as zone IDs. */
export const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/;

// ─── Limits ─────────────────────────────────────────────────────────────────

/** Max characters stored / logged for upstream response bodies and analytics targets. */
export const MAX_LOG_VALUE_LENGTH = 4096;

/** Maximum body size accepted for S3 DeleteObjects (1 MiB). */
export const MAX_DELETE_OBJECTS_BODY_BYTES = 1_048_576;

/** Maximum presigned URL lifetime in seconds (7 days, per AWS spec). */
export const MAX_PRESIGNED_EXPIRY_SEC = 604_800;

/** Default analytics query limit. */
export const DEFAULT_ANALYTICS_LIMIT = 100;

/** Maximum analytics query limit. */
export const MAX_ANALYTICS_LIMIT = 1000;

// ─── SigV4 ──────────────────────────────────────────────────────────────────

/** AWS Signature Version 4 algorithm identifier. */
export const SIG_V4_ALGORITHM = 'AWS4-HMAC-SHA256';

/** AWS Signature Version 4 request terminator string. */
export const SIG_V4_TERMINATOR = 'aws4_request';

// ─── Misc ───────────────────────────────────────────────────────────────────

/** Audit trail value for actions performed via client API key (not admin). */
export const AUDIT_CREATED_BY_API_KEY = 'via API key';

/** Redacted placeholder for short secrets. */
export const REDACTED_PLACEHOLDER = '****';

/** HMAC key label used for timing-safe admin key comparison. */
export const HMAC_COMPARE_LABEL = 'gatekeeper-admin-compare';
