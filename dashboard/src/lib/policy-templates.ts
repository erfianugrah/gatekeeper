// ─── Policy templates ───────────────────────────────────────────────
// Common-use starting points for the policy builder, one catalog per token
// scope (plus a standalone S3 catalog since S3 credentials use their own
// builder). A template is a pure function of a small context (the default
// resources derived from the selected token) so the same template yields a
// correctly-scoped policy regardless of which zone / account / project the
// token grants.
//
// Every template here is covered by test/policy-templates.test.ts, which runs
// each generated policy through the worker's validatePolicy(). Keep them in
// sync with the "Policy Templates" appendix in docs/GUIDE.md.

import { POLICY_VERSION } from './api';
import type { PolicyDocument, Statement, UpstreamTokenScopeType } from './api';

export interface TemplateContext {
	/**
	 * Default resources derived from the selected token, e.g. ['project:<ref>'],
	 * ['account:<id>'], ['zone:<id>']. When empty (no token yet) a readable
	 * placeholder is substituted so the produced policy is still editable.
	 */
	resources: string[];
}

export interface PolicyTemplate {
	id: string;
	label: string;
	description: string;
	/** Grouping label shown in the picker (e.g. 'D1', 'DNS'). */
	group: string;
	build: (ctx: TemplateContext) => Statement[];
}

/** Resources from the token if present, else a single readable placeholder. */
function res(ctx: TemplateContext, placeholder: string): string[] {
	return ctx.resources.length > 0 ? ctx.resources : [placeholder];
}

/** Wrap a template's statements into a full, id-stamped policy document. */
export function applyTemplate(template: PolicyTemplate, ctx: TemplateContext): PolicyDocument {
	return {
		version: POLICY_VERSION,
		statements: template.build(ctx).map((s) => ({ ...s, _id: crypto.randomUUID() })),
	};
}

// ─── Zone-scoped: Purge + DNS ────────────────────────────────────────

const ZONE_TEMPLATES: PolicyTemplate[] = [
	{
		id: 'purge-full',
		group: 'Purge',
		label: 'Purge - full access',
		description: 'All purge types (URL, host, tag, prefix, everything).',
		build: (c) => [{ effect: 'allow', actions: ['purge:*'], resources: res(c, 'zone:<zone-id>') }],
	},
	{
		id: 'purge-no-everything',
		group: 'Purge',
		label: 'Purge - all except purge-everything',
		description: 'Every targeted purge type, but block the account-wide "purge everything".',
		build: (c) => [
			{ effect: 'allow', actions: ['purge:*'], resources: res(c, 'zone:<zone-id>') },
			{ effect: 'deny', actions: ['purge:everything'], resources: res(c, 'zone:<zone-id>') },
		],
	},
	{
		id: 'purge-tags',
		group: 'Purge',
		label: 'Purge - tags only',
		description: 'Only cache-tag purges (Enterprise cache tags).',
		build: (c) => [{ effect: 'allow', actions: ['purge:tag'], resources: res(c, 'zone:<zone-id>') }],
	},
	{
		id: 'purge-hosts',
		group: 'Purge',
		label: 'Purge - specific hosts',
		description: 'Purge scoped to hostnames matching a pattern. Edit the host value.',
		build: (c) => [
			{
				effect: 'allow',
				actions: ['purge:*'],
				resources: res(c, 'zone:<zone-id>'),
				conditions: [{ field: 'host', operator: 'wildcard', value: '*.example.com' }],
			},
		],
	},
	{
		id: 'dns-acme',
		group: 'DNS',
		label: 'DNS - ACME client',
		description: 'Create/read/delete only _acme-challenge TXT records (cert issuance).',
		build: (c) => [
			{
				effect: 'allow',
				actions: ['dns:create', 'dns:read', 'dns:delete'],
				resources: res(c, 'zone:<zone-id>'),
				conditions: [
					{ field: 'dns.type', operator: 'eq', value: 'TXT' },
					{ field: 'dns.name', operator: 'starts_with', value: '_acme-challenge.' },
				],
			},
		],
	},
	{
		id: 'dns-readonly',
		group: 'DNS',
		label: 'DNS - read-only',
		description: 'List and get DNS records only.',
		build: (c) => [{ effect: 'allow', actions: ['dns:read'], resources: res(c, 'zone:<zone-id>') }],
	},
	{
		id: 'dns-full',
		group: 'DNS',
		label: 'DNS - full access',
		description: 'All DNS operations including batch, import, and export.',
		build: (c) => [{ effect: 'allow', actions: ['dns:*'], resources: res(c, 'zone:<zone-id>') }],
	},
];

// ─── Account-scoped: D1 / KV / Workers / Queues / Vectorize / Hyperdrive ─────

const ACCOUNT_TEMPLATES: PolicyTemplate[] = [
	{
		id: 'account-full',
		group: 'All services',
		label: 'Full - all CF services',
		description: 'Wildcard across D1, KV, Workers, Queues, Vectorize, and Hyperdrive.',
		build: (c) => [
			{
				effect: 'allow',
				actions: ['d1:*', 'kv:*', 'workers:*', 'queues:*', 'vectorize:*', 'hyperdrive:*'],
				resources: res(c, 'account:<id>'),
			},
		],
	},
	// D1
	{
		id: 'd1-readonly',
		group: 'D1',
		label: 'D1 - read-only',
		description: 'List databases, get details, and run queries.',
		build: (c) => [{ effect: 'allow', actions: ['d1:list', 'd1:get', 'd1:query'], resources: res(c, 'account:<id>') }],
	},
	{
		id: 'd1-select-only',
		group: 'D1',
		label: 'D1 - SELECT only',
		description: 'Query, restricted to read-only SQL commands (select, pragma).',
		build: (c) => [
			{
				effect: 'allow',
				actions: ['d1:query'],
				resources: res(c, 'account:<id>'),
				conditions: [{ field: 'd1.sql_command', operator: 'in', value: ['select', 'pragma'] }],
			},
		],
	},
	{
		id: 'd1-full',
		group: 'D1',
		label: 'D1 - full access',
		description: 'All D1 operations including create, delete, import/export, time travel.',
		build: (c) => [{ effect: 'allow', actions: ['d1:*'], resources: res(c, 'account:<id>') }],
	},
	// KV
	{
		id: 'kv-readonly',
		group: 'KV',
		label: 'KV - read-only',
		description: 'List and read namespaces, keys, values, and metadata.',
		build: (c) => [
			{
				effect: 'allow',
				actions: ['kv:list_namespaces', 'kv:get_namespace', 'kv:list_keys', 'kv:get_value', 'kv:get_metadata', 'kv:bulk_get'],
				resources: res(c, 'account:<id>'),
			},
		],
	},
	{
		id: 'kv-no-delete',
		group: 'KV',
		label: 'KV - admin, no delete',
		description: 'Full KV access except deleting keys, namespaces, or bulk deletes.',
		build: (c) => [
			{ effect: 'allow', actions: ['kv:*'], resources: res(c, 'account:<id>') },
			{ effect: 'deny', actions: ['kv:delete_value', 'kv:delete_namespace', 'kv:bulk_delete'], resources: res(c, 'account:<id>') },
		],
	},
	{
		id: 'kv-full',
		group: 'KV',
		label: 'KV - full access',
		description: 'All KV namespace and key/value operations.',
		build: (c) => [{ effect: 'allow', actions: ['kv:*'], resources: res(c, 'account:<id>') }],
	},
	// Workers
	{
		id: 'workers-deploy',
		group: 'Workers',
		label: 'Workers - deploy-only',
		description: 'Upload script/content and cut versions/deployments for one script. Edit the script name.',
		build: (c) => [
			{
				effect: 'allow',
				actions: [
					'workers:list_scripts',
					'workers:get_script',
					'workers:update_script',
					'workers:update_content',
					'workers:create_version',
					'workers:create_deployment',
				],
				resources: res(c, 'account:<id>'),
				conditions: [{ field: 'workers.script_name', operator: 'eq', value: 'my-worker' }],
			},
		],
	},
	{
		id: 'workers-readonly',
		group: 'Workers',
		label: 'Workers - read-only',
		description: 'List/get scripts, content, settings, versions, and deployments.',
		build: (c) => [
			{
				effect: 'allow',
				actions: [
					'workers:list_scripts',
					'workers:get_script',
					'workers:get_content',
					'workers:get_settings',
					'workers:list_versions',
					'workers:get_version',
					'workers:list_deployments',
					'workers:get_deployment',
				],
				resources: res(c, 'account:<id>'),
			},
		],
	},
	{
		id: 'workers-full',
		group: 'Workers',
		label: 'Workers - full access',
		description: 'All Workers operations (scripts, versions, deployments, secrets, cron, tails).',
		build: (c) => [{ effect: 'allow', actions: ['workers:*'], resources: res(c, 'account:<id>') }],
	},
	// Queues
	{
		id: 'queues-producer',
		group: 'Queues',
		label: 'Queues - producer',
		description: 'Push messages (single + bulk); list and get queues.',
		build: (c) => [
			{
				effect: 'allow',
				actions: ['queues:push_message', 'queues:bulk_push', 'queues:list', 'queues:get'],
				resources: res(c, 'account:<id>'),
			},
		],
	},
	{
		id: 'queues-consumer',
		group: 'Queues',
		label: 'Queues - consumer',
		description: 'Pull and acknowledge messages; list and get queues.',
		build: (c) => [
			{
				effect: 'allow',
				actions: ['queues:pull_messages', 'queues:ack_messages', 'queues:list', 'queues:get'],
				resources: res(c, 'account:<id>'),
			},
		],
	},
	{
		id: 'queues-full',
		group: 'Queues',
		label: 'Queues - full access',
		description: 'All queue, message, and consumer operations.',
		build: (c) => [{ effect: 'allow', actions: ['queues:*'], resources: res(c, 'account:<id>') }],
	},
	// Vectorize
	{
		id: 'vectorize-query',
		group: 'Vectorize',
		label: 'Vectorize - query-only',
		description: 'Query vectors and read index metadata; no inserts or deletes.',
		build: (c) => [
			{
				effect: 'allow',
				actions: ['vectorize:query', 'vectorize:get_by_ids', 'vectorize:list_indexes', 'vectorize:get_index', 'vectorize:get_info'],
				resources: res(c, 'account:<id>'),
			},
		],
	},
	{
		id: 'vectorize-full',
		group: 'Vectorize',
		label: 'Vectorize - full access',
		description: 'All Vectorize index and vector operations.',
		build: (c) => [{ effect: 'allow', actions: ['vectorize:*'], resources: res(c, 'account:<id>') }],
	},
	// Hyperdrive
	{
		id: 'hyperdrive-readonly',
		group: 'Hyperdrive',
		label: 'Hyperdrive - read-only',
		description: 'List and get Hyperdrive configs.',
		build: (c) => [{ effect: 'allow', actions: ['hyperdrive:list', 'hyperdrive:get'], resources: res(c, 'account:<id>') }],
	},
	{
		id: 'hyperdrive-full',
		group: 'Hyperdrive',
		label: 'Hyperdrive - full access',
		description: 'All Hyperdrive config operations.',
		build: (c) => [{ effect: 'allow', actions: ['hyperdrive:*'], resources: res(c, 'account:<id>') }],
	},
];

// ─── Supabase Management API ─────────────────────────────────────────

const SUPABASE_TEMPLATES: PolicyTemplate[] = [
	{
		id: 'sb-full',
		group: 'General',
		label: 'Full - bound project(s)',
		description: "All Management API operations on the token's project(s).",
		build: (c) => [{ effect: 'allow', actions: ['supabase:*'], resources: res(c, 'project:<ref>') }],
	},
	{
		id: 'sb-readonly',
		group: 'General',
		label: 'Read-only',
		description: 'All read operations; every write is blocked via the is-write condition.',
		build: (c) => [
			{
				effect: 'allow',
				actions: ['supabase:*'],
				resources: res(c, 'project:<ref>'),
				conditions: [{ field: 'supabase.write', operator: 'eq', value: false }],
			},
		],
	},
	{
		id: 'sb-no-secrets',
		group: 'General',
		label: 'Full except secrets',
		description: 'Everything except reading or writing project secrets/env.',
		build: (c) => [
			{ effect: 'allow', actions: ['supabase:*'], resources: res(c, 'project:<ref>') },
			{ effect: 'deny', actions: ['supabase:secrets:read', 'supabase:secrets:write'], resources: res(c, 'project:<ref>') },
		],
	},
	{
		id: 'sb-database',
		group: 'Database',
		label: 'Database - full',
		description: 'Read + write database config, queries, migrations, backups, branches.',
		build: (c) => [{ effect: 'allow', actions: ['supabase:database:read', 'supabase:database:write'], resources: res(c, 'project:<ref>') }],
	},
	{
		id: 'sb-database-ro',
		group: 'Database',
		label: 'Database - read-only',
		description: 'Read database config and run read-only queries.',
		build: (c) => [{ effect: 'allow', actions: ['supabase:database:read'], resources: res(c, 'project:<ref>') }],
	},
	{
		id: 'sb-functions',
		group: 'Edge Functions',
		label: 'Edge Functions - deploy',
		description: 'Read and deploy/modify Edge Functions.',
		build: (c) => [
			{ effect: 'allow', actions: ['supabase:edge_functions:read', 'supabase:edge_functions:write'], resources: res(c, 'project:<ref>') },
		],
	},
	{
		id: 'sb-auth',
		group: 'Auth',
		label: 'Auth - admin',
		description: 'Read and modify auth config, SSO, and users.',
		build: (c) => [{ effect: 'allow', actions: ['supabase:auth:read', 'supabase:auth:write'], resources: res(c, 'project:<ref>') }],
	},
	{
		id: 'sb-secrets',
		group: 'Secrets',
		label: 'Secrets - manage',
		description: 'Read and write project secrets/env only.',
		build: (c) => [{ effect: 'allow', actions: ['supabase:secrets:read', 'supabase:secrets:write'], resources: res(c, 'project:<ref>') }],
	},
	{
		id: 'sb-metrics',
		group: 'Metrics',
		label: 'Metrics - read (v0)',
		description: 'Read the per-project analytics metrics endpoint (Management /v0).',
		build: (c) => [{ effect: 'allow', actions: ['supabase:metrics:read'], resources: res(c, 'project:<ref>') }],
	},
];

const SUPABASE_METRICS_TEMPLATES: PolicyTemplate[] = [
	{
		id: 'sbm-scrape',
		group: 'Metrics',
		label: 'Metrics - scrape',
		description: 'Read per-project Prometheus metrics via the Basic-auth metrics proxy.',
		build: (c) => [{ effect: 'allow', actions: ['supabase:metrics:read'], resources: res(c, 'project:<ref>') }],
	},
];

/** Templates keyed by upstream-token scope, for the main policy builder. */
export const POLICY_TEMPLATES: Record<UpstreamTokenScopeType, PolicyTemplate[]> = {
	zone: ZONE_TEMPLATES,
	account: ACCOUNT_TEMPLATES,
	supabase: SUPABASE_TEMPLATES,
	supabase_metrics: SUPABASE_METRICS_TEMPLATES,
};

// ─── S3 (standalone credential model) ────────────────────────────────
// S3 credentials use their own builder + resource model (bucket:/object:),
// so their templates carry concrete placeholder buckets the user edits.

export const S3_POLICY_TEMPLATES: PolicyTemplate[] = [
	{
		id: 's3-full',
		group: 'General',
		label: 'Full access',
		description: 'All S3 operations on all buckets.',
		build: () => [{ effect: 'allow', actions: ['s3:*'], resources: ['*'] }],
	},
	{
		id: 's3-readonly',
		group: 'General',
		label: 'Read-only (all buckets)',
		description: 'Get/list objects and buckets; no writes or deletes.',
		build: () => [
			{
				effect: 'allow',
				actions: ['s3:GetObject', 's3:ListBucket', 's3:ListAllMyBuckets', 's3:HeadBucket', 's3:GetBucketLocation'],
				resources: ['*'],
			},
		],
	},
	{
		id: 's3-readonly-bucket',
		group: 'Bucket-scoped',
		label: 'Read-only - one bucket',
		description: 'Get and list within a single bucket. Edit the bucket name.',
		build: () => [{ effect: 'allow', actions: ['s3:GetObject', 's3:ListBucket'], resources: ['bucket:my-bucket', 'object:my-bucket/*'] }],
	},
	{
		id: 's3-prefix',
		group: 'Bucket-scoped',
		label: 'Prefix-scoped read/write',
		description: 'Read/write objects under a key prefix. Edit the bucket and prefix.',
		build: () => [
			{
				effect: 'allow',
				actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
				resources: ['bucket:my-bucket', 'object:my-bucket/*'],
				conditions: [{ field: 'key.prefix', operator: 'starts_with', value: 'uploads/' }],
			},
		],
	},
	{
		id: 's3-upload-only',
		group: 'Uploads',
		label: 'Upload-only',
		description: 'PutObject only - no read, list, or delete. Edit the bucket name.',
		build: () => [{ effect: 'allow', actions: ['s3:PutObject'], resources: ['object:my-bucket/*'] }],
	},
	{
		id: 's3-images',
		group: 'Uploads',
		label: 'Image uploads only',
		description: 'PutObject restricted to image/* content types. Edit the bucket name.',
		build: () => [
			{
				effect: 'allow',
				actions: ['s3:PutObject'],
				resources: ['object:my-bucket/*'],
				conditions: [{ field: 'content_type', operator: 'starts_with', value: 'image/' }],
			},
		],
	},
	{
		id: 's3-protect',
		group: 'Protection',
		label: 'Full access, protect from deletion',
		description: 'All S3 operations but deny object and bucket deletes.',
		build: () => [
			{ effect: 'allow', actions: ['s3:*'], resources: ['*'] },
			{ effect: 'deny', actions: ['s3:DeleteObject', 's3:DeleteBucket'], resources: ['*'] },
		],
	},
	{
		id: 's3-business-hours',
		group: 'Time',
		label: 'Writes during business hours (UTC)',
		description: 'Read anytime; PutObject/DeleteObject only 09:00-18:00 UTC.',
		build: () => [
			{ effect: 'allow', actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'], resources: ['*'] },
			{
				effect: 'deny',
				actions: ['s3:PutObject', 's3:DeleteObject'],
				resources: ['*'],
				conditions: [
					{
						any: [
							{ field: 'time.hour', operator: 'lt', value: '9' },
							{ field: 'time.hour', operator: 'gte', value: '18' },
						],
					},
				],
			},
		],
	},
];

/** Group templates by their `group` field, preserving first-seen order. */
export function groupTemplates(templates: PolicyTemplate[]): Array<{ group: string; items: PolicyTemplate[] }> {
	const order: string[] = [];
	const byGroup = new Map<string, PolicyTemplate[]>();
	for (const t of templates) {
		if (!byGroup.has(t.group)) {
			byGroup.set(t.group, []);
			order.push(t.group);
		}
		byGroup.get(t.group)!.push(t);
	}
	return order.map((group) => ({ group, items: byGroup.get(group)! }));
}
