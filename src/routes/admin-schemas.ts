/**
 * Zod schemas for all route input validation.
 *
 * These schemas are the single source of truth for:
 *   1. Server-side request validation
 *   2. OpenAPI spec generation
 *   3. Dashboard form validation
 *   4. TypeScript type inference via z.infer
 */

import { z } from 'zod';
import { ZONE_ID_RE, ACCOUNT_ID_RE, DEFAULT_ANALYTICS_LIMIT, MAX_ANALYTICS_LIMIT } from '../constants';
import { POLICY_VERSION } from '../policy-types';
import { CONFIG_DEFAULTS } from '../config-registry';

// ─── Policy document schemas ────────────────────────────────────────────────

const LEAF_OPERATORS = [
	'eq',
	'ne',
	'contains',
	'not_contains',
	'starts_with',
	'ends_with',
	'matches',
	'not_matches',
	'in',
	'not_in',
	'wildcard',
	'exists',
	'not_exists',
	'lt',
	'gt',
	'lte',
	'gte',
] as const;

const conditionValueSchema = z.union([z.string(), z.array(z.string()), z.boolean()]);

const leafConditionSchema = z.object({
	field: z.string().min(1),
	operator: z.enum(LEAF_OPERATORS),
	value: conditionValueSchema,
});

/** Recursive condition schema — leaf or compound (any/all/not). */
const conditionSchema: z.ZodType<unknown> = z.lazy(() =>
	z.union([
		leafConditionSchema.meta({ id: 'LeafCondition' }),
		z.object({ any: z.array(conditionSchema).min(1) }),
		z.object({ all: z.array(conditionSchema).min(1) }),
		z.object({ not: conditionSchema }),
	]),
);

const statementSchema = z.object({
	effect: z.enum(['allow', 'deny']),
	actions: z.array(z.string().min(1)).min(1),
	resources: z.array(z.string().min(1)).min(1),
	conditions: z.array(conditionSchema).optional(),
});

export const policyDocumentSchema = z.object({
	version: z.literal(POLICY_VERSION),
	statements: z.array(statementSchema).min(1),
});

// ─── Shared field schemas ───────────────────────────────────────────────────

const positiveFiniteNumber = z.number().positive().finite();

const zoneIdString = z.string().regex(ZONE_ID_RE, 'Must be a 32-char hex string');

// ─── Create key schema ──────────────────────────────────────────────────────

const rateLimitSchema = z
	.object({
		bulk_rate: positiveFiniteNumber.optional(),
		bulk_bucket: positiveFiniteNumber.optional(),
		single_rate: positiveFiniteNumber.optional(),
		single_bucket: positiveFiniteNumber.optional(),
	})
	.optional();

export const createKeySchema = z.object({
	name: z.string().min(1, 'Required field: name (string)'),
	zone_id: zoneIdString.optional(),
	policy: policyDocumentSchema,
	expires_in_days: positiveFiniteNumber.optional(),
	created_by: z.string().optional(),
	rate_limit: rateLimitSchema,
});

export type CreateKeyInput = z.infer<typeof createKeySchema>;

// ─── Create S3 credential schema ────────────────────────────────────────────

export const createS3CredentialSchema = z.object({
	name: z.string().min(1, 'Required field: name (string)'),
	policy: policyDocumentSchema,
	expires_in_days: positiveFiniteNumber.optional(),
	created_by: z.string().optional(),
});

export type CreateS3CredentialInput = z.infer<typeof createS3CredentialSchema>;

// ─── Create upstream token schema ───────────────────────────────────────────

export const createUpstreamTokenSchema = z.object({
	name: z.string().min(1, 'Required field: name (string)'),
	token: z.string().min(1, 'Required field: token (string)'),
	scope_type: z.enum(['zone', 'account']).optional().default('zone'),
	zone_ids: z
		.array(
			z.string().refine((v) => v === '*' || ZONE_ID_RE.test(v) || ACCOUNT_ID_RE.test(v), {
				message: 'Each ID must be a 32-char hex string or "*"',
			}),
		)
		.min(1, 'Required field: zone_ids (non-empty array of zone/account IDs, or ["*"])'),
	created_by: z.string().optional(),
	validate: z.boolean().optional(),
});

export type CreateUpstreamTokenInput = z.infer<typeof createUpstreamTokenSchema>;

// ─── Create upstream R2 schema ──────────────────────────────────────────────

export const createUpstreamR2Schema = z.object({
	name: z.string().min(1, 'Required field: name (string)'),
	access_key_id: z.string().min(1, 'Required field: access_key_id (string)'),
	secret_access_key: z.string().min(1, 'Required field: secret_access_key (string)'),
	endpoint: z
		.string()
		.min(1, 'Required field: endpoint (string URL)')
		.refine(
			(v) => {
				try {
					return new URL(v).protocol === 'https:';
				} catch {
					return false;
				}
			},
			{ message: 'endpoint must be a valid HTTPS URL' },
		),
	bucket_names: z.array(z.string().min(1)).min(1, 'Required field: bucket_names (non-empty array of strings, or ["*"])'),
	created_by: z.string().optional(),
	validate: z.boolean().optional(),
});

export type CreateUpstreamR2Input = z.infer<typeof createUpstreamR2Schema>;

// ─── Purge body schema ──────────────────────────────────────────────────────

/** A files entry can be a plain URL string or an object with url + optional headers. */
const purgeFileEntrySchema = z.union([
	z.string().min(1),
	z.object({ url: z.string().min(1), headers: z.record(z.string(), z.string()).optional() }),
]);

export const purgeBodySchema = z
	.object({
		files: z.array(purgeFileEntrySchema).min(1).optional(),
		hosts: z.array(z.string().min(1)).min(1).optional(),
		tags: z.array(z.string().min(1)).min(1).optional(),
		prefixes: z.array(z.string().min(1)).min(1).optional(),
		purge_everything: z.literal(true).optional(),
	})
	.refine(
		(body) => {
			const present = [body.files, body.hosts, body.tags, body.prefixes, body.purge_everything].filter((v) => v !== undefined).length;
			return present === 1;
		},
		{ message: 'Request body must contain exactly one purge type (files, hosts, tags, prefixes, or purge_everything)' },
	);

export type PurgeBodyInput = z.infer<typeof purgeBodySchema>;

// ─── Bulk operation body schema ─────────────────────────────────────────────

/** Maximum items in a single bulk operation. */
export const MAX_BULK_ITEMS = 100;

/**
 * Create a bulk body schema for a given ID field name.
 * Used by bulk-revoke and bulk-delete routes across all resource types.
 */
export function bulkBodySchema(idField: string = 'ids') {
	return z
		.object({
			[idField]: z
				.array(z.string().min(1))
				.min(1, `${idField} must be a non-empty array of strings`)
				.max(MAX_BULK_ITEMS, `Maximum ${MAX_BULK_ITEMS} items per request`),
			confirm_count: z.number().int(),
			dry_run: z.boolean().optional().default(false),
		})
		.refine((data) => data.confirm_count === (data[idField] as string[]).length, {
			message: `confirm_count must equal ${idField} array length`,
			path: ['confirm_count'],
		});
}

/** Pre-built bulk schema for the common 'ids' field. */
export const bulkIdsSchema = bulkBodySchema('ids');

/** Pre-built bulk schema for S3 credential bulk ops. */
export const bulkAccessKeyIdsSchema = bulkBodySchema('access_key_ids');

export type BulkBodyInput = { ids: string[]; confirm_count: number; dry_run: boolean };

// ─── Analytics query schemas ────────────────────────────────────────────────

/**
 * Coerce a query string value to a number, or return undefined if absent.
 * Query params arrive as strings; z.coerce.number() handles the conversion.
 */
const optionalNumericQuery = z.coerce.number().positive().finite().optional();

/** Purge analytics: GET /admin/analytics/events */
export const purgeAnalyticsEventsQuerySchema = z.object({
	since: optionalNumericQuery,
	until: optionalNumericQuery,
	limit: z.coerce.number().int().min(1).max(MAX_ANALYTICS_LIMIT).optional().default(DEFAULT_ANALYTICS_LIMIT),
	zone_id: z.string().optional(),
	key_id: z.string().optional(),
});

export type PurgeAnalyticsEventsQuery = z.infer<typeof purgeAnalyticsEventsQuerySchema>;

/** Purge analytics: GET /admin/analytics/summary */
export const purgeAnalyticsSummaryQuerySchema = z.object({
	since: optionalNumericQuery,
	until: optionalNumericQuery,
	zone_id: z.string().optional(),
	key_id: z.string().optional(),
});

export type PurgeAnalyticsSummaryQuery = z.infer<typeof purgeAnalyticsSummaryQuerySchema>;

/** S3 analytics: GET /admin/s3/analytics/events */
export const s3AnalyticsEventsQuerySchema = z.object({
	since: optionalNumericQuery,
	until: optionalNumericQuery,
	limit: z.coerce.number().int().min(1).max(MAX_ANALYTICS_LIMIT).optional().default(DEFAULT_ANALYTICS_LIMIT),
	credential_id: z.string().optional(),
	bucket: z.string().optional(),
	operation: z.string().optional(),
});

export type S3AnalyticsEventsQuery = z.infer<typeof s3AnalyticsEventsQuerySchema>;

/** S3 analytics: GET /admin/s3/analytics/summary */
export const s3AnalyticsSummaryQuerySchema = z.object({
	since: optionalNumericQuery,
	until: optionalNumericQuery,
	credential_id: z.string().optional(),
	bucket: z.string().optional(),
	operation: z.string().optional(),
});

export type S3AnalyticsSummaryQuery = z.infer<typeof s3AnalyticsSummaryQuerySchema>;

// ─── List / filter query schemas ────────────────────────────────────────────

/** Keys list query: GET /admin/keys?zone_id=&status= */
export const listKeysQuerySchema = z.object({
	zone_id: zoneIdString.optional(),
	status: z.enum(['active', 'revoked']).optional(),
});

export type ListKeysQuery = z.infer<typeof listKeysQuerySchema>;

/** S3 credentials list query: GET /admin/s3/credentials?status= */
export const listS3CredentialsQuerySchema = z.object({
	status: z.enum(['active', 'revoked']).optional(),
});

export type ListS3CredentialsQuery = z.infer<typeof listS3CredentialsQuerySchema>;

/** Delete query params: DELETE /:id?permanent=&zone_id= */
export const deleteQuerySchema = z.object({
	permanent: z
		.enum(['true', 'false'])
		.optional()
		.transform((v) => v === 'true'),
	zone_id: zoneIdString.optional(),
});

export type DeleteQuery = z.infer<typeof deleteQuerySchema>;

// ─── Config schemas ─────────────────────────────────────────────────────────

/** Valid config key names derived from CONFIG_DEFAULTS. */
const configKeys = Object.keys(CONFIG_DEFAULTS) as [string, ...string[]];

/** PUT /admin/config body: { key: number, ... } */
export const setConfigBodySchema = z
	.record(z.string(), z.unknown())
	.refine((obj) => Object.keys(obj).length > 0, { message: 'Request body must contain at least one config key' })
	.superRefine((obj, ctx) => {
		for (const [key, value] of Object.entries(obj)) {
			if (!configKeys.includes(key)) {
				ctx.addIssue({ code: 'custom', path: [key], message: `Unknown config key: ${key}` });
				continue;
			}
			if (typeof value !== 'number' || value <= 0 || !isFinite(value)) {
				ctx.addIssue({ code: 'custom', path: [key], message: `${key}: must be a positive finite number` });
			}
		}
	})
	.transform((obj) => {
		const updates: Record<string, number> = {};
		for (const [key, value] of Object.entries(obj)) {
			if (key in CONFIG_DEFAULTS && typeof value === 'number') {
				updates[key] = value;
			}
		}
		return updates;
	});

export type SetConfigInput = z.infer<typeof setConfigBodySchema>;

/** DELETE /admin/config/:key param. */
export const configKeyParamSchema = z.object({
	key: z.string().refine((k) => k in CONFIG_DEFAULTS, { message: 'Unknown config key' }),
});

export type ConfigKeyParam = z.infer<typeof configKeyParamSchema>;

// ─── URL param schemas ──────────────────────────────────────────────────────

/** Generic :id param used by get/delete routes. */
export const idParamSchema = z.object({
	id: z.string().min(1, 'ID is required'),
});

/** :zoneId param for the purge and DNS routes. */
export const zoneIdParamSchema = z.object({
	zoneId: zoneIdString,
});

export type ZoneIdParam = z.infer<typeof zoneIdParamSchema>;

/** :zoneId + :recordId params for single-record DNS routes. */
export const dnsRecordParamSchema = z.object({
	zoneId: zoneIdString,
	recordId: z.string().min(1, 'Record ID is required'),
});

export type DnsRecordParam = z.infer<typeof dnsRecordParamSchema>;

// ─── Parse helpers ──────────────────────────────────────────────────────────

/** Minimal Hono-like context for body parsing. */
interface ParseContext {
	req: { json: <T>() => Promise<T>; query: (key?: string) => any; param: (key?: string) => any };
	json: (data: unknown, status: number) => Response;
}

/**
 * Return a Cloudflare API-style JSON error response.
 * DRYs the `c.json({ success: false, errors: [{ code, message }] }, status)` pattern
 * used across all route handlers.
 */
export function jsonError(c: ParseContext, status: number, message: string): Response {
	return c.json({ success: false, errors: [{ code: status, message }] }, status);
}

/**
 * Parse and validate a JSON body against a Zod schema.
 * Returns the typed data on success, or a 400 Response on failure.
 */
export async function parseJsonBody<T>(c: ParseContext, schema: z.ZodType<T>, log: Record<string, unknown>): Promise<T | Response> {
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		log.status = 400;
		log.error = 'invalid_json';
		console.log(JSON.stringify(log));
		return jsonError(c, 400, 'Invalid JSON body');
	}

	const result = schema.safeParse(raw);
	if (!result.success) {
		const errors = result.error.issues.map((issue) => ({
			code: 400,
			message: `${issue.path.join('.')}: ${issue.message}`,
		}));
		log.status = 400;
		log.error = 'validation_failed';
		log.validationErrors = errors.map((e) => e.message);
		console.log(JSON.stringify(log));
		return c.json({ success: false, errors }, 400);
	}

	return result.data;
}

/**
 * Parse and validate query parameters against a Zod schema.
 * Builds a raw object from c.req.query() and validates it.
 * Returns the typed data on success, or a 400 Response on failure.
 */
export function parseQueryParams<T>(c: ParseContext, schema: z.ZodType<T>): T | Response {
	// c.req.query() with no args returns all query params as Record<string, string>
	const raw = c.req.query();

	const result = schema.safeParse(raw);
	if (!result.success) {
		const errors = result.error.issues.map((issue) => ({
			code: 400,
			message: `${issue.path.join('.')}: ${issue.message}`,
		}));
		console.log(JSON.stringify({ breadcrumb: 'parse-query-params-failed', errors: errors.map((e) => e.message) }));
		return c.json({ success: false, errors }, 400);
	}

	return result.data;
}

/**
 * Parse and validate URL params against a Zod schema.
 * Returns the typed data on success, or a 400 Response on failure.
 */
export function parseParams<T>(c: ParseContext, schema: z.ZodType<T>): T | Response {
	const raw = c.req.param();

	const result = schema.safeParse(raw);
	if (!result.success) {
		const errors = result.error.issues.map((issue) => ({
			code: 400,
			message: `${issue.path.join('.')}: ${issue.message}`,
		}));
		console.log(JSON.stringify({ breadcrumb: 'parse-params-failed', errors: errors.map((e) => e.message) }));
		return c.json({ success: false, errors }, 400);
	}

	return result.data;
}

/**
 * Parse a bulk operation JSON body with Zod.
 * Returns typed { ids, dryRun } or a 400 Response.
 */
export async function parseBulkBody(
	c: ParseContext,
	idField: string = 'ids',
	log?: Record<string, unknown>,
): Promise<{ ids: string[]; dryRun: boolean } | Response> {
	const schema = bulkBodySchema(idField);

	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		if (log) {
			log.status = 400;
			log.error = 'invalid_json';
			console.log(JSON.stringify(log));
		}
		return jsonError(c, 400, 'Invalid JSON body');
	}

	const result = schema.safeParse(raw);
	if (!result.success) {
		const errors = result.error.issues.map((issue) => ({
			code: 400,
			message: `${issue.path.join('.')}: ${issue.message}`,
		}));
		if (log) {
			log.status = 400;
			log.error = 'validation_failed';
			log.validationErrors = errors.map((e) => e.message);
			console.log(JSON.stringify(log));
		}
		return c.json({ success: false, errors }, 400);
	}

	const data = result.data as Record<string, unknown>;
	return { ids: data[idField] as string[], dryRun: data.dry_run === true };
}

// ─── Response / entity schemas (for OpenAPI spec generation) ────────────────

/** Single API error item. */
export const apiErrorSchema = z
	.object({
		code: z.number().int(),
		message: z.string(),
	})
	.meta({ id: 'ApiError', description: 'A single error entry' });

/** Standard error envelope used by all error responses. */
export const errorEnvelopeSchema = z
	.object({
		success: z.literal(false),
		errors: z.array(apiErrorSchema),
	})
	.meta({ id: 'ErrorEnvelope', description: 'Cloudflare API-style error response' });

/** Health check response. */
export const healthResponseSchema = z.object({ ok: z.literal(true) }).meta({ id: 'HealthResponse' });

// ─── Entity schemas ─────────────────────────────────────────────────────────

/** API key entity as returned from the admin API. */
export const apiKeySchema = z
	.object({
		id: z.string(),
		name: z.string(),
		zone_id: z.string().nullable(),
		created_at: z.number(),
		expires_at: z.number().nullable(),
		revoked: z.number(),
		policy: z.string().meta({ description: 'JSON-serialized PolicyDocument' }),
		created_by: z.string().nullable(),
		bulk_rate: z.number().nullable(),
		bulk_bucket: z.number().nullable(),
		single_rate: z.number().nullable(),
		single_bucket: z.number().nullable(),
	})
	.meta({ id: 'ApiKey', description: 'A purge API key' });

/** S3 credential entity as returned from the admin API. */
export const s3CredentialSchema = z
	.object({
		access_key_id: z.string(),
		secret_access_key: z.string(),
		name: z.string(),
		created_at: z.number(),
		expires_at: z.number().nullable(),
		revoked: z.number(),
		policy: z.string().meta({ description: 'JSON-serialized PolicyDocument' }),
		created_by: z.string().nullable(),
	})
	.meta({ id: 'S3Credential', description: 'An S3-compatible credential' });

/** Upstream Cloudflare API token entity. */
export const upstreamTokenSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		scope_type: z.enum(['zone', 'account']).meta({ description: "'zone' for zone-scoped ops, 'account' for dev platform ops" }),
		zone_ids: z.string().meta({ description: 'Comma-separated zone/account IDs or "*"' }),
		token_preview: z.string().meta({ description: 'First 4 + last 4 chars of the token' }),
		created_at: z.number(),
		created_by: z.string().nullable(),
	})
	.meta({ id: 'UpstreamToken', description: 'A registered upstream Cloudflare API token' });

/** Upstream R2 endpoint entity. */
export const upstreamR2Schema = z
	.object({
		id: z.string(),
		name: z.string(),
		bucket_names: z.string().meta({ description: 'Comma-separated bucket names or "*"' }),
		access_key_preview: z.string(),
		endpoint: z.string(),
		created_at: z.number(),
		created_by: z.string().nullable(),
	})
	.meta({ id: 'UpstreamR2', description: 'A registered upstream R2 endpoint' });

// ─── Bulk operation response schemas ────────────────────────────────────────

export const bulkItemResultSchema = z
	.object({
		id: z.string(),
		status: z.enum(['revoked', 'already_revoked', 'deleted', 'not_found']),
	})
	.meta({ id: 'BulkItemResult' });

export const bulkResultSchema = z
	.object({
		processed: z.number().int(),
		results: z.array(bulkItemResultSchema),
	})
	.meta({ id: 'BulkResult', description: 'Result of a bulk operation' });

export const bulkInspectItemSchema = z
	.object({
		id: z.string(),
		current_status: z.enum(['active', 'revoked', 'expired', 'not_found']),
		would_become: z.string(),
	})
	.meta({ id: 'BulkInspectItem' });

export const bulkDryRunResultSchema = z
	.object({
		dry_run: z.literal(true),
		would_process: z.number().int(),
		items: z.array(bulkInspectItemSchema),
	})
	.meta({ id: 'BulkDryRunResult', description: 'Preview of a dry-run bulk operation' });

// ─── Analytics response schemas ─────────────────────────────────────────────

/** Purge event row from D1. */
export const purgeEventSchema = z
	.object({
		key_id: z.string(),
		zone_id: z.string(),
		purge_type: z.string(),
		purge_target: z.string().nullable(),
		tokens: z.number(),
		status: z.number(),
		collapsed: z.union([z.string(), z.literal(false)]),
		upstream_status: z.number().nullable(),
		duration_ms: z.number(),
		created_at: z.number(),
		response_detail: z.string().nullable(),
		created_by: z.string().nullable(),
		flight_id: z.string(),
	})
	.meta({ id: 'PurgeEvent', description: 'A single purge analytics event' });

/** Purge analytics summary. */
export const analyticsSummarySchema = z
	.object({
		total_requests: z.number(),
		total_urls_purged: z.number(),
		by_status: z.record(z.string(), z.number()),
		by_purge_type: z.record(z.string(), z.number()),
		collapsed_count: z.number(),
		avg_duration_ms: z.number(),
	})
	.meta({ id: 'AnalyticsSummary', description: 'Aggregate purge analytics' });

/** S3 event row from D1. */
export const s3EventSchema = z
	.object({
		credential_id: z.string(),
		operation: z.string(),
		bucket: z.string().nullable(),
		key: z.string().nullable(),
		status: z.number(),
		duration_ms: z.number(),
		created_at: z.number(),
		response_detail: z.string().nullable(),
		created_by: z.string().nullable(),
	})
	.meta({ id: 'S3Event', description: 'A single S3 proxy analytics event' });

/** S3 analytics summary. */
export const s3AnalyticsSummarySchema = z
	.object({
		total_requests: z.number(),
		by_status: z.record(z.string(), z.number()),
		by_operation: z.record(z.string(), z.number()),
		by_bucket: z.record(z.string(), z.number()),
		avg_duration_ms: z.number(),
	})
	.meta({ id: 'S3AnalyticsSummary', description: 'Aggregate S3 proxy analytics' });

// ─── Config response schemas ────────────────────────────────────────────────

/** All 12 config values. */
export const gatewayConfigSchema = z
	.object({
		bulk_rate: z.number(),
		bulk_bucket_size: z.number(),
		bulk_max_ops: z.number(),
		single_rate: z.number(),
		single_bucket_size: z.number(),
		single_max_ops: z.number(),
		key_cache_ttl_ms: z.number(),
		retention_days: z.number(),
		s3_rps: z.number(),
		s3_burst: z.number(),
		cf_proxy_rps: z.number(),
		cf_proxy_burst: z.number(),
	})
	.meta({ id: 'GatewayConfig', description: 'Resolved gateway configuration' });

export const configOverrideSchema = z
	.object({
		key: z.string(),
		value: z.string(),
		updated_at: z.number(),
		updated_by: z.string().nullable(),
	})
	.meta({ id: 'ConfigOverride', description: 'A single config override entry' });

/** GET /admin/config response result. */
export const configResponseSchema = z
	.object({
		config: gatewayConfigSchema,
		overrides: z.array(configOverrideSchema),
		defaults: z.record(z.string(), z.number()),
	})
	.meta({ id: 'ConfigResponse', description: 'Full config response with overrides and defaults' });

// ─── Upstream validation warning ────────────────────────────────────────────

export const validationWarningSchema = z
	.object({
		type: z.string(),
		message: z.string(),
	})
	.meta({ id: 'ValidationWarning', description: 'Warning from upstream credential validation' });

// ─── DNS analytics schemas ──────────────────────────────────────────────────

/** CF proxy analytics: GET /admin/cf/analytics/events */
export const cfProxyAnalyticsEventsQuerySchema = z.object({
	account_id: z.string().optional(),
	key_id: z.string().optional(),
	service: z.string().optional(),
	action: z.string().optional(),
	since: z.coerce.number().optional(),
	until: z.coerce.number().optional(),
	limit: z.coerce.number().int().min(1).max(MAX_ANALYTICS_LIMIT).optional().default(DEFAULT_ANALYTICS_LIMIT),
});

export type CfProxyAnalyticsEventsQuery = z.infer<typeof cfProxyAnalyticsEventsQuerySchema>;

/** CF proxy analytics: GET /admin/cf/analytics/summary */
export const cfProxyAnalyticsSummaryQuerySchema = z.object({
	account_id: z.string().optional(),
	key_id: z.string().optional(),
	service: z.string().optional(),
	action: z.string().optional(),
	since: z.coerce.number().optional(),
	until: z.coerce.number().optional(),
});

export type CfProxyAnalyticsSummaryQuery = z.infer<typeof cfProxyAnalyticsSummaryQuerySchema>;

/** DNS analytics: GET /admin/dns/analytics/events */
export const dnsAnalyticsEventsQuerySchema = z.object({
	zone_id: z.string().optional(),
	key_id: z.string().optional(),
	action: z.string().optional(),
	record_type: z.string().optional(),
	since: z.coerce.number().optional(),
	until: z.coerce.number().optional(),
	limit: z.coerce.number().int().min(1).max(MAX_ANALYTICS_LIMIT).optional().default(DEFAULT_ANALYTICS_LIMIT),
});

export type DnsAnalyticsEventsQuery = z.infer<typeof dnsAnalyticsEventsQuerySchema>;

/** DNS analytics: GET /admin/dns/analytics/summary */
export const dnsAnalyticsSummaryQuerySchema = z.object({
	zone_id: z.string().optional(),
	key_id: z.string().optional(),
	action: z.string().optional(),
	record_type: z.string().optional(),
	since: z.coerce.number().optional(),
	until: z.coerce.number().optional(),
});

export type DnsAnalyticsSummaryQuery = z.infer<typeof dnsAnalyticsSummaryQuerySchema>;

// ─── DNS entity schemas ─────────────────────────────────────────────────────

/** DNS event row from D1. */
export const dnsEventSchema = z
	.object({
		key_id: z.string(),
		zone_id: z.string(),
		action: z.string(),
		record_name: z.string().nullable(),
		record_type: z.string().nullable(),
		status: z.number(),
		upstream_status: z.number().nullable(),
		duration_ms: z.number(),
		created_at: z.number(),
		response_detail: z.string().nullable(),
		created_by: z.string().nullable(),
	})
	.meta({ id: 'DnsEvent', description: 'A single DNS proxy analytics event' });

/** CF proxy event row from D1. */
export const cfProxyEventSchema = z
	.object({
		key_id: z.string(),
		account_id: z.string(),
		service: z.string(),
		action: z.string(),
		resource_id: z.string().nullable(),
		status: z.number(),
		upstream_status: z.number().nullable(),
		duration_ms: z.number(),
		created_at: z.number(),
		response_detail: z.string().nullable(),
		created_by: z.string().nullable(),
	})
	.meta({ id: 'CfProxyEvent', description: 'A single CF API proxy analytics event' });

/** CF proxy analytics summary. */
export const cfProxyAnalyticsSummarySchema = z
	.object({
		total_requests: z.number(),
		by_status: z.record(z.string(), z.number()),
		by_service: z.record(z.string(), z.number()),
		by_action: z.record(z.string(), z.number()),
		avg_duration_ms: z.number(),
	})
	.meta({ id: 'CfProxyAnalyticsSummary', description: 'Aggregate CF proxy analytics' });

/** DNS analytics summary. */
export const dnsAnalyticsSummarySchema = z
	.object({
		total_requests: z.number(),
		by_status: z.record(z.string(), z.number()),
		by_action: z.record(z.string(), z.number()),
		by_record_type: z.record(z.string(), z.number()),
		avg_duration_ms: z.number(),
	})
	.meta({ id: 'DnsAnalyticsSummary', description: 'Aggregate DNS proxy analytics' });
