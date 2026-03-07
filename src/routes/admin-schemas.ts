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
import { ZONE_ID_RE, DEFAULT_ANALYTICS_LIMIT, MAX_ANALYTICS_LIMIT } from '../constants';
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
		leafConditionSchema,
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
	zone_id: z.string().optional(),
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
	zone_ids: z
		.array(
			z.string().refine((v) => v === '*' || ZONE_ID_RE.test(v), {
				message: 'Each zone_id must be a 32-char hex string or "*"',
			}),
		)
		.min(1, 'Required field: zone_ids (non-empty array of strings, or ["*"])'),
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
	zone_id: z.string().optional(),
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
	zone_id: z.string().optional(),
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

/** :zoneId param for the purge route. */
export const zoneIdParamSchema = z.object({
	zoneId: zoneIdString,
});

export type ZoneIdParam = z.infer<typeof zoneIdParamSchema>;

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
