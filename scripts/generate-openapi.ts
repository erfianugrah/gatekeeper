#!/usr/bin/env tsx
/**
 * Build-time script: generates openapi.json from Zod schemas.
 *
 * Usage:  npx tsx scripts/generate-openapi.ts
 *         npm run openapi
 */

import 'zod-openapi';
import { z } from 'zod';
import { createDocument } from 'zod-openapi';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
	// Request schemas
	policyDocumentSchema,
	createKeySchema,
	createS3CredentialSchema,
	createUpstreamTokenSchema,
	createUpstreamR2Schema,
	purgeBodySchema,
	bulkBodySchema,
	purgeAnalyticsEventsQuerySchema,
	purgeAnalyticsSummaryQuerySchema,
	s3AnalyticsEventsQuerySchema,
	s3AnalyticsSummaryQuerySchema,
	listKeysQuerySchema,
	listS3CredentialsQuerySchema,
	deleteQuerySchema,
	setConfigBodySchema,
	configKeyParamSchema,
	idParamSchema,
	zoneIdParamSchema,
	// Response / entity schemas
	apiErrorSchema,
	errorEnvelopeSchema,
	healthResponseSchema,
	apiKeySchema,
	s3CredentialSchema,
	upstreamTokenSchema,
	upstreamR2Schema,
	bulkItemResultSchema,
	bulkResultSchema,
	bulkInspectItemSchema,
	bulkDryRunResultSchema,
	purgeEventSchema,
	analyticsSummarySchema,
	s3EventSchema,
	s3AnalyticsSummarySchema,
	gatewayConfigSchema,
	configOverrideSchema,
	configResponseSchema,
	validationWarningSchema,
} from '../src/routes/admin-schemas.js';

// ─── Envelope helpers ───────────────────────────────────────────────────────

function successEnvelope(resultSchema: z.ZodType, id?: string) {
	const schema = z.object({
		success: z.literal(true),
		result: resultSchema,
	});
	if (id) schema.meta({ id });
	return schema;
}

function successEnvelopeWithWarnings(resultSchema: z.ZodType, id?: string) {
	const schema = z.object({
		success: z.literal(true),
		result: resultSchema,
		warnings: z.array(validationWarningSchema).optional(),
	});
	if (id) schema.meta({ id });
	return schema;
}

// ─── Response shorthands ────────────────────────────────────────────────────

const jsonContent = (schema: z.ZodType) => ({
	content: { 'application/json': { schema } },
});

const ok = (description: string, schema: z.ZodType) => ({
	description,
	...jsonContent(schema),
});

const errorResponse = (description: string) => ({
	description,
	...jsonContent(errorEnvelopeSchema),
});

type SecReq = Record<string, string[]>;
const adminSecurity: SecReq[] = [{ AdminKeyAuth: [] }, { CloudflareAccess: [] }];
const purgeKeySecurity: SecReq[] = [{ ApiKeyAuth: [] }];
const s3Security: SecReq[] = [{ S3SigV4Auth: [] }];

// ─── Tags ───────────────────────────────────────────────────────────────────

const tags = [
	{ name: 'System', description: 'Health and status endpoints' },
	{ name: 'Purge', description: 'Cloudflare cache purge via gateway keys' },
	{ name: 'Keys', description: 'CRUD for purge API keys with IAM policies' },
	{ name: 'Analytics', description: 'Purge analytics events and summaries' },
	{ name: 'S3Credentials', description: 'CRUD for S3-compatible credentials with IAM policies' },
	{ name: 'S3Analytics', description: 'S3 proxy analytics events and summaries' },
	{ name: 'S3Proxy', description: 'S3-compatible proxy to Cloudflare R2 storage' },
	{ name: 'UpstreamTokens', description: 'Manage upstream Cloudflare API tokens for cache purge' },
	{ name: 'UpstreamR2', description: 'Manage upstream R2 endpoints for S3 proxy' },
	{ name: 'Config', description: 'Gateway configuration management' },
];

// ─── Assemble the document ──────────────────────────────────────────────────

const document = createDocument({
	openapi: '3.1.0',
	info: {
		title: 'Gatekeeper',
		description:
			'API gateway on Cloudflare Workers with AWS IAM-style policy authorization. ' +
			"Fronts Cloudflare's cache purge API and S3-compatible R2 storage with " +
			'per-key/credential policies, token-bucket rate limiting, request collapsing, ' +
			'and D1-backed analytics.',
		version: '4.0.0',
		contact: { name: 'Erfi Anugrah' },
	},
	servers: [{ url: 'https://gate.erfi.io', description: 'Production' }],
	security: [],
	tags,
	components: {
		securitySchemes: {
			ApiKeyAuth: {
				type: 'http',
				scheme: 'bearer',
				description: 'Gateway API key (prefix `gw_`). Issued via POST /admin/keys.',
			},
			AdminKeyAuth: {
				type: 'apiKey',
				in: 'header',
				name: 'X-Admin-Key',
				description: 'Shared admin secret for CLI and automation.',
			},
			CloudflareAccess: {
				type: 'apiKey',
				in: 'header',
				name: 'Cf-Access-Jwt-Assertion',
				description: 'Cloudflare Access JWT for browser-based dashboard users.',
			},
			S3SigV4Auth: {
				type: 'apiKey',
				in: 'header',
				name: 'Authorization',
				description: 'AWS Signature Version 4 authentication for S3-compatible clients.',
			},
		},
	},
	paths: {
		// ─── System ─────────────────────────────────────────────────────
		'/health': {
			get: {
				tags: ['System'],
				operationId: 'getHealth',
				summary: 'Health check',
				responses: {
					'200': ok('Service is healthy', healthResponseSchema),
				},
			},
		},

		// ─── Purge ──────────────────────────────────────────────────────
		'/v1/zones/{zoneId}/purge_cache': {
			post: {
				tags: ['Purge'],
				operationId: 'purgeCache',
				summary: 'Purge Cloudflare cache',
				description:
					'Proxies to the Cloudflare cache purge API with IAM policy authorization, ' +
					'token-bucket rate limiting, and request collapsing. The request body must ' +
					'contain exactly one purge type.',
				security: purgeKeySecurity,
				requestParams: { path: zoneIdParamSchema },
				requestBody: { required: true, ...jsonContent(purgeBodySchema) },
				responses: {
					'200': {
						description: 'Purge result (proxied from Cloudflare)',
						content: {
							'application/json': {
								schema: z.object({
									success: z.boolean(),
									errors: z.array(apiErrorSchema).optional(),
									messages: z.array(z.unknown()).optional(),
									result: z.unknown().optional(),
								}),
							},
						},
						headers: z.object({
							'X-Ratelimit-Remaining': z.string().optional().meta({ description: 'Remaining rate-limit tokens' }),
							'X-Ratelimit-Reset': z.string().optional().meta({ description: 'Seconds until bucket refill' }),
							'X-Ratelimit-Bucket-Size': z.string().optional().meta({ description: 'Bucket capacity' }),
							'X-Ratelimit-Rate': z.string().optional().meta({ description: 'Refill rate (tokens/sec)' }),
							'X-Purge-Flight-Id': z.string().optional().meta({ description: 'Stable ID linking collapsed requests' }),
						}),
					},
					'400': errorResponse('Invalid request body'),
					'401': errorResponse('Missing or invalid API key'),
					'403': errorResponse('Policy denied'),
					'429': errorResponse('Rate limited'),
				},
			},
		},

		// ─── Keys ───────────────────────────────────────────────────────
		'/admin/keys': {
			post: {
				tags: ['Keys'],
				operationId: 'createKey',
				summary: 'Create a purge API key',
				description: 'Creates a new API key with an attached IAM policy document.',
				security: adminSecurity,
				requestBody: { required: true, ...jsonContent(createKeySchema) },
				responses: {
					'200': ok('Key created', successEnvelope(z.object({ key: apiKeySchema }))),
					'400': errorResponse('Validation error'),
					'401': errorResponse('Unauthorized'),
					'403': errorResponse('Forbidden (role)'),
				},
			},
			get: {
				tags: ['Keys'],
				operationId: 'listKeys',
				summary: 'List purge API keys',
				security: adminSecurity,
				requestParams: { query: listKeysQuerySchema },
				responses: {
					'200': ok('List of keys', successEnvelope(z.array(apiKeySchema))),
					'401': errorResponse('Unauthorized'),
				},
			},
		},
		'/admin/keys/{id}': {
			get: {
				tags: ['Keys'],
				operationId: 'getKey',
				summary: 'Get a specific key',
				security: adminSecurity,
				requestParams: {
					path: idParamSchema,
					query: z.object({ zone_id: z.string().optional() }),
				},
				responses: {
					'200': ok('Key details', successEnvelope(z.object({ key: apiKeySchema }))),
					'404': errorResponse('Key not found'),
				},
			},
			delete: {
				tags: ['Keys'],
				operationId: 'deleteKey',
				summary: 'Revoke or permanently delete a key',
				description: 'Soft-revokes by default. Pass `permanent=true` to hard-delete.',
				security: adminSecurity,
				requestParams: { path: idParamSchema, query: deleteQuerySchema },
				responses: {
					'200': ok(
						'Key revoked or deleted',
						z.union([successEnvelope(z.object({ revoked: z.literal(true) })), successEnvelope(z.object({ deleted: z.literal(true) }))]),
					),
					'404': errorResponse('Key not found'),
				},
			},
		},
		'/admin/keys/bulk-revoke': {
			post: {
				tags: ['Keys'],
				operationId: 'bulkRevokeKeys',
				summary: 'Bulk revoke keys',
				description: 'Revoke multiple keys in one request. Supports dry_run preview.',
				security: adminSecurity,
				requestBody: { required: true, ...jsonContent(bulkBodySchema('ids')) },
				responses: {
					'200': ok(
						'Bulk result or dry-run preview',
						z.union([successEnvelope(bulkResultSchema), successEnvelope(bulkDryRunResultSchema)]),
					),
					'400': errorResponse('Validation error'),
				},
			},
		},
		'/admin/keys/bulk-delete': {
			post: {
				tags: ['Keys'],
				operationId: 'bulkDeleteKeys',
				summary: 'Bulk delete keys',
				description: 'Permanently delete multiple keys. Supports dry_run preview.',
				security: adminSecurity,
				requestBody: { required: true, ...jsonContent(bulkBodySchema('ids')) },
				responses: {
					'200': ok(
						'Bulk result or dry-run preview',
						z.union([successEnvelope(bulkResultSchema), successEnvelope(bulkDryRunResultSchema)]),
					),
					'400': errorResponse('Validation error'),
				},
			},
		},

		// ─── Purge Analytics ────────────────────────────────────────────
		'/admin/analytics/events': {
			get: {
				tags: ['Analytics'],
				operationId: 'getPurgeAnalyticsEvents',
				summary: 'Query purge analytics events',
				security: adminSecurity,
				requestParams: { query: purgeAnalyticsEventsQuerySchema },
				responses: {
					'200': ok('List of purge events', successEnvelope(z.array(purgeEventSchema))),
					'503': errorResponse('Analytics not configured'),
				},
			},
		},
		'/admin/analytics/summary': {
			get: {
				tags: ['Analytics'],
				operationId: 'getPurgeAnalyticsSummary',
				summary: 'Query purge analytics summary',
				security: adminSecurity,
				requestParams: { query: purgeAnalyticsSummaryQuerySchema },
				responses: {
					'200': ok('Purge analytics summary', successEnvelope(analyticsSummarySchema)),
					'503': errorResponse('Analytics not configured'),
				},
			},
		},

		// ─── S3 Credentials ─────────────────────────────────────────────
		'/admin/s3/credentials': {
			post: {
				tags: ['S3Credentials'],
				operationId: 'createS3Credential',
				summary: 'Create an S3 credential',
				description: 'Creates a new S3-compatible credential with an IAM policy. Returns the secret_access_key only once.',
				security: adminSecurity,
				requestBody: { required: true, ...jsonContent(createS3CredentialSchema) },
				responses: {
					'200': ok('Credential created', successEnvelope(z.object({ credential: s3CredentialSchema }))),
					'400': errorResponse('Validation error'),
				},
			},
			get: {
				tags: ['S3Credentials'],
				operationId: 'listS3Credentials',
				summary: 'List S3 credentials',
				security: adminSecurity,
				requestParams: { query: listS3CredentialsQuerySchema },
				responses: {
					'200': ok('List of credentials', successEnvelope(z.array(s3CredentialSchema))),
				},
			},
		},
		'/admin/s3/credentials/{id}': {
			get: {
				tags: ['S3Credentials'],
				operationId: 'getS3Credential',
				summary: 'Get a specific S3 credential',
				security: adminSecurity,
				requestParams: { path: idParamSchema },
				responses: {
					'200': ok('Credential details', successEnvelope(z.object({ credential: s3CredentialSchema }))),
					'404': errorResponse('Credential not found'),
				},
			},
			delete: {
				tags: ['S3Credentials'],
				operationId: 'deleteS3Credential',
				summary: 'Revoke or permanently delete an S3 credential',
				security: adminSecurity,
				requestParams: { path: idParamSchema, query: deleteQuerySchema },
				responses: {
					'200': ok(
						'Credential revoked or deleted',
						z.union([successEnvelope(z.object({ revoked: z.literal(true) })), successEnvelope(z.object({ deleted: z.literal(true) }))]),
					),
					'404': errorResponse('Credential not found'),
				},
			},
		},
		'/admin/s3/credentials/bulk-revoke': {
			post: {
				tags: ['S3Credentials'],
				operationId: 'bulkRevokeS3Credentials',
				summary: 'Bulk revoke S3 credentials',
				security: adminSecurity,
				requestBody: { required: true, ...jsonContent(bulkBodySchema('access_key_ids')) },
				responses: {
					'200': ok(
						'Bulk result or dry-run preview',
						z.union([successEnvelope(bulkResultSchema), successEnvelope(bulkDryRunResultSchema)]),
					),
					'400': errorResponse('Validation error'),
				},
			},
		},
		'/admin/s3/credentials/bulk-delete': {
			post: {
				tags: ['S3Credentials'],
				operationId: 'bulkDeleteS3Credentials',
				summary: 'Bulk delete S3 credentials',
				security: adminSecurity,
				requestBody: { required: true, ...jsonContent(bulkBodySchema('access_key_ids')) },
				responses: {
					'200': ok(
						'Bulk result or dry-run preview',
						z.union([successEnvelope(bulkResultSchema), successEnvelope(bulkDryRunResultSchema)]),
					),
					'400': errorResponse('Validation error'),
				},
			},
		},

		// ─── S3 Analytics ───────────────────────────────────────────────
		'/admin/s3/analytics/events': {
			get: {
				tags: ['S3Analytics'],
				operationId: 'getS3AnalyticsEvents',
				summary: 'Query S3 proxy analytics events',
				security: adminSecurity,
				requestParams: { query: s3AnalyticsEventsQuerySchema },
				responses: {
					'200': ok('List of S3 events', successEnvelope(z.array(s3EventSchema))),
					'503': errorResponse('Analytics not configured'),
				},
			},
		},
		'/admin/s3/analytics/summary': {
			get: {
				tags: ['S3Analytics'],
				operationId: 'getS3AnalyticsSummary',
				summary: 'Query S3 proxy analytics summary',
				security: adminSecurity,
				requestParams: { query: s3AnalyticsSummaryQuerySchema },
				responses: {
					'200': ok('S3 analytics summary', successEnvelope(s3AnalyticsSummarySchema)),
					'503': errorResponse('Analytics not configured'),
				},
			},
		},

		// ─── Upstream Tokens ────────────────────────────────────────────
		'/admin/upstream-tokens': {
			post: {
				tags: ['UpstreamTokens'],
				operationId: 'createUpstreamToken',
				summary: 'Register an upstream Cloudflare API token',
				description:
					'Registers a Cloudflare API token for proxying purge requests. ' +
					'Optionally validates the token against the Cloudflare API when `validate: true`.',
				security: adminSecurity,
				requestBody: { required: true, ...jsonContent(createUpstreamTokenSchema) },
				responses: {
					'200': ok('Token registered', successEnvelopeWithWarnings(upstreamTokenSchema)),
					'400': errorResponse('Validation error'),
				},
			},
			get: {
				tags: ['UpstreamTokens'],
				operationId: 'listUpstreamTokens',
				summary: 'List upstream tokens',
				security: adminSecurity,
				responses: {
					'200': ok('List of tokens', successEnvelope(z.array(upstreamTokenSchema))),
				},
			},
		},
		'/admin/upstream-tokens/{id}': {
			get: {
				tags: ['UpstreamTokens'],
				operationId: 'getUpstreamToken',
				summary: 'Get a specific upstream token',
				security: adminSecurity,
				requestParams: { path: idParamSchema },
				responses: {
					'200': ok('Token details', successEnvelope(upstreamTokenSchema)),
					'404': errorResponse('Token not found'),
				},
			},
			delete: {
				tags: ['UpstreamTokens'],
				operationId: 'deleteUpstreamToken',
				summary: 'Delete an upstream token',
				security: adminSecurity,
				requestParams: { path: idParamSchema },
				responses: {
					'200': ok('Token deleted', successEnvelope(z.object({ deleted: z.literal(true) }))),
					'404': errorResponse('Token not found'),
				},
			},
		},
		'/admin/upstream-tokens/bulk-delete': {
			post: {
				tags: ['UpstreamTokens'],
				operationId: 'bulkDeleteUpstreamTokens',
				summary: 'Bulk delete upstream tokens',
				security: adminSecurity,
				requestBody: { required: true, ...jsonContent(bulkBodySchema('ids')) },
				responses: {
					'200': ok(
						'Bulk result or dry-run preview',
						z.union([successEnvelope(bulkResultSchema), successEnvelope(bulkDryRunResultSchema)]),
					),
					'400': errorResponse('Validation error'),
				},
			},
		},

		// ─── Upstream R2 ────────────────────────────────────────────────
		'/admin/upstream-r2': {
			post: {
				tags: ['UpstreamR2'],
				operationId: 'createUpstreamR2',
				summary: 'Register an upstream R2 endpoint',
				description:
					'Registers an R2 endpoint with credentials for S3 proxy forwarding. ' +
					'Optionally validates connectivity when `validate: true`.',
				security: adminSecurity,
				requestBody: { required: true, ...jsonContent(createUpstreamR2Schema) },
				responses: {
					'200': ok('R2 endpoint registered', successEnvelopeWithWarnings(upstreamR2Schema)),
					'400': errorResponse('Validation error'),
				},
			},
			get: {
				tags: ['UpstreamR2'],
				operationId: 'listUpstreamR2',
				summary: 'List upstream R2 endpoints',
				security: adminSecurity,
				responses: {
					'200': ok('List of R2 endpoints', successEnvelope(z.array(upstreamR2Schema))),
				},
			},
		},
		'/admin/upstream-r2/{id}': {
			get: {
				tags: ['UpstreamR2'],
				operationId: 'getUpstreamR2',
				summary: 'Get a specific upstream R2 endpoint',
				security: adminSecurity,
				requestParams: { path: idParamSchema },
				responses: {
					'200': ok('R2 endpoint details', successEnvelope(upstreamR2Schema)),
					'404': errorResponse('R2 endpoint not found'),
				},
			},
			delete: {
				tags: ['UpstreamR2'],
				operationId: 'deleteUpstreamR2',
				summary: 'Delete an upstream R2 endpoint',
				security: adminSecurity,
				requestParams: { path: idParamSchema },
				responses: {
					'200': ok('R2 endpoint deleted', successEnvelope(z.object({ deleted: z.literal(true) }))),
					'404': errorResponse('R2 endpoint not found'),
				},
			},
		},
		'/admin/upstream-r2/bulk-delete': {
			post: {
				tags: ['UpstreamR2'],
				operationId: 'bulkDeleteUpstreamR2',
				summary: 'Bulk delete upstream R2 endpoints',
				security: adminSecurity,
				requestBody: { required: true, ...jsonContent(bulkBodySchema('ids')) },
				responses: {
					'200': ok(
						'Bulk result or dry-run preview',
						z.union([successEnvelope(bulkResultSchema), successEnvelope(bulkDryRunResultSchema)]),
					),
					'400': errorResponse('Validation error'),
				},
			},
		},

		// ─── Config ─────────────────────────────────────────────────────
		'/admin/config': {
			get: {
				tags: ['Config'],
				operationId: 'getConfig',
				summary: 'Get gateway configuration',
				description: 'Returns resolved config values, admin overrides, and hardcoded defaults.',
				security: adminSecurity,
				responses: {
					'200': ok('Current configuration', successEnvelope(configResponseSchema)),
				},
			},
			put: {
				tags: ['Config'],
				operationId: 'setConfig',
				summary: 'Update gateway configuration',
				description: 'Sets one or more config overrides. Values must be positive finite numbers.',
				security: adminSecurity,
				requestBody: { required: true, ...jsonContent(setConfigBodySchema) },
				responses: {
					'200': ok('Config updated', successEnvelope(z.object({ config: gatewayConfigSchema }))),
					'400': errorResponse('Validation error'),
				},
			},
		},
		'/admin/config/{key}': {
			delete: {
				tags: ['Config'],
				operationId: 'resetConfigKey',
				summary: 'Reset a config key to default',
				description: 'Removes an admin override, reverting the key to its env/default value.',
				security: adminSecurity,
				requestParams: { path: configKeyParamSchema },
				responses: {
					'200': ok('Config key reset', successEnvelope(z.object({ config: gatewayConfigSchema }))),
					'404': errorResponse('No override found for key'),
				},
			},
		},

		// ─── S3 Proxy ───────────────────────────────────────────────────
		'/s3/{path}': {
			get: {
				tags: ['S3Proxy'],
				operationId: 's3Get',
				summary: 'S3 GET operations',
				description:
					'Handles GetObject, ListObjectsV2, ListBuckets, and other S3 GET operations. ' +
					'Authenticates via AWS Sig V4, evaluates IAM policies, then proxies to R2.',
				security: s3Security,
				requestParams: {
					path: z.object({ path: z.string().meta({ description: 'S3 path (bucket/key)' }) }),
				},
				responses: {
					'200': { description: 'S3 response (proxied from R2)' },
					'403': { description: 'Access denied by IAM policy (S3 XML error)' },
					'404': { description: 'Object or bucket not found (S3 XML error)' },
				},
			},
			put: {
				tags: ['S3Proxy'],
				operationId: 's3Put',
				summary: 'S3 PUT operations',
				description: 'Handles PutObject, CopyObject, CreateBucket, and other S3 PUT operations.',
				security: s3Security,
				requestParams: {
					path: z.object({ path: z.string() }),
				},
				responses: {
					'200': { description: 'S3 response (proxied from R2)' },
					'403': { description: 'Access denied by IAM policy' },
				},
			},
			post: {
				tags: ['S3Proxy'],
				operationId: 's3Post',
				summary: 'S3 POST operations',
				description: 'Handles DeleteObjects (batch), CompleteMultipartUpload, and other S3 POST operations.',
				security: s3Security,
				requestParams: {
					path: z.object({ path: z.string() }),
				},
				responses: {
					'200': { description: 'S3 response (proxied from R2)' },
					'403': { description: 'Access denied by IAM policy' },
				},
			},
			delete: {
				tags: ['S3Proxy'],
				operationId: 's3Delete',
				summary: 'S3 DELETE operations',
				description: 'Handles DeleteObject, DeleteBucket, AbortMultipartUpload, and other S3 DELETE operations.',
				security: s3Security,
				requestParams: {
					path: z.object({ path: z.string() }),
				},
				responses: {
					'200': { description: 'S3 response (proxied from R2)' },
					'403': { description: 'Access denied by IAM policy' },
				},
			},
			head: {
				tags: ['S3Proxy'],
				operationId: 's3Head',
				summary: 'S3 HEAD operations',
				description: 'Handles HeadObject and HeadBucket.',
				security: s3Security,
				requestParams: {
					path: z.object({ path: z.string() }),
				},
				responses: {
					'200': { description: 'S3 response headers (proxied from R2)' },
					'404': { description: 'Object or bucket not found' },
				},
			},
		},
	},
});

// ─── Write output ───────────────────────────────────────────────────────────

const json = JSON.stringify(document, null, 2);
const outPath = resolve(import.meta.dirname!, '..', 'openapi.json');
writeFileSync(outPath, json + '\n', 'utf-8');

const pathCount = Object.keys(document.paths ?? {}).length;
const schemaCount = Object.keys((document as any).components?.schemas ?? {}).length;
console.log(`✓ Generated ${outPath} (${pathCount} paths, ${schemaCount} component schemas)`);
