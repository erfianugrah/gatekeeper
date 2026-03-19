import { useState, useCallback, useMemo } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

import { ConditionEditor, summarizeStatement } from '@/components/ConditionEditor';
import type { FieldOption, OperatorOption } from '@/components/ConditionEditor';
import type { PolicyDocument, Statement, Condition } from '@/lib/api';
import { cn } from '@/lib/utils';
import { T } from '@/lib/typography';

// ─── Constants ──────────────────────────────────────────────────────

interface ActionDef {
	readonly value: string;
	readonly label: string;
	readonly description: string;
	readonly category?: string;
}

interface ActionGroup {
	readonly prefix: string;
	readonly label: string;
	readonly description: string;
	readonly scope: 'zone' | 'account';
	readonly resource: string;
	readonly actions: readonly ActionDef[];
}

const ACTION_GROUPS: readonly ActionGroup[] = [
	{
		prefix: 'purge',
		label: 'Purge',
		description: 'Cache invalidation by URL, host, tag, or prefix',
		scope: 'zone',
		resource: 'zone:<zone-id>',
		actions: [
			{ value: 'purge:*', label: 'All Purge', description: 'All purge types' },
			{ value: 'purge:url', label: 'URL', description: 'Purge by URL (files)' },
			{ value: 'purge:host', label: 'Host', description: 'Purge by hostname' },
			{ value: 'purge:tag', label: 'Tag', description: 'Purge by cache tag' },
			{ value: 'purge:prefix', label: 'Prefix', description: 'Purge by URL prefix' },
			{ value: 'purge:everything', label: 'Everything', description: 'Purge all cached content' },
		],
	},
	{
		prefix: 'dns',
		label: 'DNS',
		description: 'DNS record management (CRUD, import/export)',
		scope: 'zone',
		resource: 'zone:<zone-id>',
		actions: [
			{ value: 'dns:*', label: 'All DNS', description: 'All DNS operations' },
			{ value: 'dns:create', label: 'Create', description: 'Create DNS records' },
			{ value: 'dns:read', label: 'Read', description: 'Get or list DNS records' },
			{ value: 'dns:update', label: 'Update', description: 'Edit or overwrite DNS records' },
			{ value: 'dns:delete', label: 'Delete', description: 'Delete DNS records' },
			{ value: 'dns:batch', label: 'Batch', description: 'Batch create/update/delete' },
			{ value: 'dns:export', label: 'Export', description: 'Export BIND zone file' },
			{ value: 'dns:import', label: 'Import', description: 'Import BIND zone file' },
		],
	},
	{
		prefix: 'd1',
		label: 'D1',
		description: 'Serverless SQL databases',
		scope: 'account',
		resource: 'account:<id>/d1/<database-id>',
		actions: [
			{ value: 'd1:*', label: 'All D1', description: 'All D1 database operations' },
			{ value: 'd1:create', label: 'Create', description: 'Create a database' },
			{ value: 'd1:list', label: 'List', description: 'List databases' },
			{ value: 'd1:get', label: 'Get', description: 'Get database details' },
			{ value: 'd1:update', label: 'Update', description: 'Update database settings' },
			{ value: 'd1:delete', label: 'Delete', description: 'Delete a database' },
			{ value: 'd1:query', label: 'Query', description: 'Execute SQL query' },
			{ value: 'd1:raw', label: 'Raw', description: 'Execute raw SQL' },
			{ value: 'd1:export', label: 'Export', description: 'Export database' },
			{ value: 'd1:import', label: 'Import', description: 'Import data' },
			{ value: 'd1:time_travel', label: 'Time Travel', description: 'Point-in-time recovery' },
		],
	},
	{
		prefix: 'kv',
		label: 'KV',
		description: 'Key-value storage namespaces',
		scope: 'account',
		resource: 'account:<id>/kv/<namespace-id>',
		actions: [
			{ value: 'kv:*', label: 'All KV', description: 'All KV namespace operations' },
			{ value: 'kv:create_namespace', label: 'Create NS', description: 'Create a namespace' },
			{ value: 'kv:list_namespaces', label: 'List NS', description: 'List namespaces' },
			{ value: 'kv:get_namespace', label: 'Get NS', description: 'Get namespace details' },
			{ value: 'kv:update_namespace', label: 'Update NS', description: 'Update namespace title' },
			{ value: 'kv:delete_namespace', label: 'Delete NS', description: 'Delete namespace' },
			{ value: 'kv:list_keys', label: 'List Keys', description: 'List keys in namespace' },
			{ value: 'kv:put_value', label: 'Put', description: 'Write key-value pair' },
			{ value: 'kv:get_value', label: 'Get', description: 'Read value by key' },
			{ value: 'kv:delete_value', label: 'Delete', description: 'Delete key-value pair' },
			{ value: 'kv:get_metadata', label: 'Metadata', description: 'Get key metadata' },
			{ value: 'kv:bulk_write', label: 'Bulk Write', description: 'Write multiple pairs' },
			{ value: 'kv:bulk_delete', label: 'Bulk Delete', description: 'Delete multiple keys' },
			{ value: 'kv:bulk_get', label: 'Bulk Get', description: 'Read multiple values' },
		],
	},
	{
		prefix: 'workers',
		label: 'Workers',
		description: 'Serverless compute scripts, deployments, and configuration',
		scope: 'account',
		resource: 'account:<id>/workers/<script-name>',
		actions: [
			{ value: 'workers:*', label: 'All Workers', description: 'All Workers operations' },
			// Scripts
			{ value: 'workers:list_scripts', label: 'List Scripts', description: 'List all scripts', category: 'Scripts' },
			{ value: 'workers:get_script', label: 'Get Script', description: 'Get script metadata', category: 'Scripts' },
			{ value: 'workers:update_script', label: 'Update Script', description: 'Upload/update script', category: 'Scripts' },
			{ value: 'workers:delete_script', label: 'Delete Script', description: 'Delete a script', category: 'Scripts' },
			{ value: 'workers:get_content', label: 'Get Content', description: 'Download script content', category: 'Scripts' },
			{ value: 'workers:update_content', label: 'Update Content', description: 'Upload script content', category: 'Scripts' },
			// Settings
			{ value: 'workers:get_settings', label: 'Get Settings', description: 'Get Worker settings', category: 'Settings' },
			{ value: 'workers:update_settings', label: 'Update Settings', description: 'Update Worker settings', category: 'Settings' },
			{ value: 'workers:get_script_settings', label: 'Script Settings', description: 'Get script-level settings', category: 'Settings' },
			{
				value: 'workers:update_script_settings',
				label: 'Update Script Settings',
				description: 'Update script-level settings',
				category: 'Settings',
			},
			// Versions & Deployments
			{
				value: 'workers:list_versions',
				label: 'List Versions',
				description: 'List script versions',
				category: 'Versions & Deployments',
			},
			{ value: 'workers:get_version', label: 'Get Version', description: 'Get version details', category: 'Versions & Deployments' },
			{
				value: 'workers:create_version',
				label: 'Create Version',
				description: 'Create new version',
				category: 'Versions & Deployments',
			},
			{
				value: 'workers:list_deployments',
				label: 'List Deployments',
				description: 'List deployments',
				category: 'Versions & Deployments',
			},
			{
				value: 'workers:get_deployment',
				label: 'Get Deployment',
				description: 'Get deployment details',
				category: 'Versions & Deployments',
			},
			{
				value: 'workers:create_deployment',
				label: 'Create Deployment',
				description: 'Create deployment',
				category: 'Versions & Deployments',
			},
			{
				value: 'workers:delete_deployment',
				label: 'Delete Deployment',
				description: 'Delete deployment',
				category: 'Versions & Deployments',
			},
			// Secrets
			{ value: 'workers:list_secrets', label: 'List Secrets', description: 'List Worker secrets', category: 'Secrets' },
			{ value: 'workers:get_secret', label: 'Get Secret', description: 'Get secret value', category: 'Secrets' },
			{ value: 'workers:update_secret', label: 'Update Secret', description: 'Set/update secret', category: 'Secrets' },
			{ value: 'workers:delete_secret', label: 'Delete Secret', description: 'Delete a secret', category: 'Secrets' },
			// Cron & Tails
			{ value: 'workers:get_schedules', label: 'Get Schedules', description: 'Get cron schedules', category: 'Cron & Tails' },
			{ value: 'workers:update_schedules', label: 'Update Schedules', description: 'Update cron schedules', category: 'Cron & Tails' },
			{ value: 'workers:list_tails', label: 'List Tails', description: 'List tail sessions', category: 'Cron & Tails' },
			{ value: 'workers:create_tail', label: 'Create Tail', description: 'Create tail session', category: 'Cron & Tails' },
			{ value: 'workers:delete_tail', label: 'Delete Tail', description: 'Delete tail session', category: 'Cron & Tails' },
			// Subdomains & Domains
			{
				value: 'workers:get_subdomain',
				label: 'Get Subdomain',
				description: 'Get script subdomain',
				category: 'Routing & Domains',
			},
			{
				value: 'workers:update_subdomain',
				label: 'Update Subdomain',
				description: 'Set script subdomain',
				category: 'Routing & Domains',
			},
			{
				value: 'workers:delete_subdomain',
				label: 'Delete Subdomain',
				description: 'Remove script subdomain',
				category: 'Routing & Domains',
			},
			{ value: 'workers:upload_assets', label: 'Upload Assets', description: 'Upload static assets', category: 'Routing & Domains' },
			{
				value: 'workers:get_account_subdomain',
				label: 'Account Subdomain',
				description: 'Get account subdomain',
				category: 'Routing & Domains',
			},
			{
				value: 'workers:update_account_subdomain',
				label: 'Set Account Subdomain',
				description: 'Set account subdomain',
				category: 'Routing & Domains',
			},
			{
				value: 'workers:delete_account_subdomain',
				label: 'Delete Account Subdomain',
				description: 'Remove account subdomain',
				category: 'Routing & Domains',
			},
			{
				value: 'workers:get_account_settings',
				label: 'Account Settings',
				description: 'Get account settings',
				category: 'Routing & Domains',
			},
			{
				value: 'workers:update_account_settings',
				label: 'Update Account Settings',
				description: 'Update account settings',
				category: 'Routing & Domains',
			},
			{ value: 'workers:list_domains', label: 'List Domains', description: 'List custom domains', category: 'Routing & Domains' },
			{ value: 'workers:get_domain', label: 'Get Domain', description: 'Get domain details', category: 'Routing & Domains' },
			{ value: 'workers:update_domain', label: 'Update Domain', description: 'Update custom domain', category: 'Routing & Domains' },
			{ value: 'workers:delete_domain', label: 'Delete Domain', description: 'Delete custom domain', category: 'Routing & Domains' },
			// Telemetry
			{ value: 'workers:telemetry', label: 'Telemetry', description: 'Query Workers telemetry' },
		],
	},
	{
		prefix: 'queues',
		label: 'Queues',
		description: 'Message queues for async processing',
		scope: 'account',
		resource: 'account:<id>/queues/<queue-id>',
		actions: [
			{ value: 'queues:*', label: 'All Queues', description: 'All Queues operations' },
			{ value: 'queues:create', label: 'Create', description: 'Create a queue', category: 'Management' },
			{ value: 'queues:list', label: 'List', description: 'List queues', category: 'Management' },
			{ value: 'queues:get', label: 'Get', description: 'Get queue details', category: 'Management' },
			{ value: 'queues:update', label: 'Update', description: 'Update queue settings', category: 'Management' },
			{ value: 'queues:edit', label: 'Edit', description: 'Edit queue config', category: 'Management' },
			{ value: 'queues:delete', label: 'Delete', description: 'Delete a queue', category: 'Management' },
			{ value: 'queues:push_message', label: 'Push', description: 'Push a message', category: 'Messages' },
			{ value: 'queues:bulk_push', label: 'Bulk Push', description: 'Push multiple messages', category: 'Messages' },
			{ value: 'queues:pull_messages', label: 'Pull', description: 'Pull messages', category: 'Messages' },
			{ value: 'queues:ack_messages', label: 'Ack', description: 'Acknowledge messages', category: 'Messages' },
			{ value: 'queues:purge', label: 'Purge', description: 'Purge all messages', category: 'Messages' },
			{ value: 'queues:purge_status', label: 'Purge Status', description: 'Check purge status', category: 'Messages' },
			{ value: 'queues:create_consumer', label: 'Create Consumer', description: 'Create consumer', category: 'Consumers' },
			{ value: 'queues:list_consumers', label: 'List Consumers', description: 'List consumers', category: 'Consumers' },
			{ value: 'queues:get_consumer', label: 'Get Consumer', description: 'Get consumer details', category: 'Consumers' },
			{ value: 'queues:update_consumer', label: 'Update Consumer', description: 'Update consumer', category: 'Consumers' },
			{ value: 'queues:delete_consumer', label: 'Delete Consumer', description: 'Delete consumer', category: 'Consumers' },
		],
	},
	{
		prefix: 'vectorize',
		label: 'Vectorize',
		description: 'Vector database indexes for AI/ML',
		scope: 'account',
		resource: 'account:<id>/vectorize/<index-name>',
		actions: [
			{ value: 'vectorize:*', label: 'All Vectorize', description: 'All Vectorize operations' },
			{ value: 'vectorize:create_index', label: 'Create Index', description: 'Create an index', category: 'Indexes' },
			{ value: 'vectorize:list_indexes', label: 'List Indexes', description: 'List indexes', category: 'Indexes' },
			{ value: 'vectorize:get_index', label: 'Get Index', description: 'Get index details', category: 'Indexes' },
			{ value: 'vectorize:delete_index', label: 'Delete Index', description: 'Delete an index', category: 'Indexes' },
			{ value: 'vectorize:get_info', label: 'Get Info', description: 'Get index info/stats', category: 'Indexes' },
			{ value: 'vectorize:query', label: 'Query', description: 'Query vectors', category: 'Vectors' },
			{ value: 'vectorize:insert', label: 'Insert', description: 'Insert vectors', category: 'Vectors' },
			{ value: 'vectorize:upsert', label: 'Upsert', description: 'Upsert vectors', category: 'Vectors' },
			{ value: 'vectorize:get_by_ids', label: 'Get by IDs', description: 'Get vectors by ID', category: 'Vectors' },
			{ value: 'vectorize:delete_by_ids', label: 'Delete by IDs', description: 'Delete vectors by ID', category: 'Vectors' },
			{ value: 'vectorize:list_vectors', label: 'List Vectors', description: 'List vectors', category: 'Vectors' },
			{
				value: 'vectorize:create_metadata_index',
				label: 'Create Meta Index',
				description: 'Create metadata index',
				category: 'Metadata',
			},
			{
				value: 'vectorize:list_metadata_indexes',
				label: 'List Meta Indexes',
				description: 'List metadata indexes',
				category: 'Metadata',
			},
			{
				value: 'vectorize:delete_metadata_index',
				label: 'Delete Meta Index',
				description: 'Delete metadata index',
				category: 'Metadata',
			},
		],
	},
	{
		prefix: 'hyperdrive',
		label: 'Hyperdrive',
		description: 'Database connection pooling and caching',
		scope: 'account',
		resource: 'account:<id>/hyperdrive/<config-id>',
		actions: [
			{ value: 'hyperdrive:*', label: 'All Hyperdrive', description: 'All Hyperdrive operations' },
			{ value: 'hyperdrive:create', label: 'Create', description: 'Create a config' },
			{ value: 'hyperdrive:list', label: 'List', description: 'List configs' },
			{ value: 'hyperdrive:get', label: 'Get', description: 'Get config details' },
			{ value: 'hyperdrive:update', label: 'Update', description: 'Update config' },
			{ value: 'hyperdrive:edit', label: 'Edit', description: 'Edit config' },
			{ value: 'hyperdrive:delete', label: 'Delete', description: 'Delete config' },
		],
	},
] as const;

/** All known service prefixes for wildcard detection. */
const ALL_PREFIXES = ACTION_GROUPS.map((g) => g.prefix);

/** Detect which service prefixes are active in a set of actions. */
function getActivePrefixes(actions: string[]): string[] {
	return ALL_PREFIXES.filter((p) => actions.some((a) => a.startsWith(p + ':')));
}

const CONDITION_FIELDS: readonly FieldOption[] = [
	// --- Purge (action-specific) ---
	{ value: 'host', label: 'Host', hint: 'e.g. example.com', appliesTo: ['purge'] },
	{ value: 'tag', label: 'Tag', hint: 'e.g. static-v2', appliesTo: ['purge'] },
	{ value: 'prefix', label: 'Prefix', hint: 'e.g. example.com/assets/', appliesTo: ['purge'] },
	{ value: 'url', label: 'URL', hint: 'e.g. https://example.com/page', appliesTo: ['purge'] },
	{ value: 'url.path', label: 'URL Path', hint: 'e.g. /api/v1/', appliesTo: ['purge'] },
	{ value: 'purge_everything', label: 'Purge Everything', hint: 'true/false', appliesTo: ['purge'] },
	// --- DNS ---
	{ value: 'dns.name', label: 'DNS Name', hint: 'e.g. _acme-challenge.example.com', appliesTo: ['dns'] },
	{ value: 'dns.type', label: 'DNS Type', hint: 'e.g. A, AAAA, CNAME, TXT', appliesTo: ['dns'] },
	{ value: 'dns.content', label: 'DNS Content', hint: 'e.g. 1.2.3.4', appliesTo: ['dns'] },
	{ value: 'dns.proxied', label: 'DNS Proxied', hint: 'true/false', appliesTo: ['dns'] },
	{ value: 'dns.ttl', label: 'DNS TTL', hint: 'e.g. 300', appliesTo: ['dns'] },
	{ value: 'dns.comment', label: 'DNS Comment', hint: 'e.g. managed by cert-manager', appliesTo: ['dns'] },
	// --- D1 ---
	{ value: 'd1.name', label: 'D1 Name', hint: 'e.g. my-database', appliesTo: ['d1'] },
	{ value: 'd1.sql_command', label: 'D1 SQL Command', hint: 'e.g. SELECT, INSERT, DELETE', appliesTo: ['d1'] },
	// --- KV ---
	{ value: 'kv.key_name', label: 'KV Key', hint: 'e.g. user:1234', appliesTo: ['kv'] },
	{ value: 'kv.title', label: 'KV Title', hint: 'e.g. MY_NAMESPACE', appliesTo: ['kv'] },
	// --- Workers ---
	{ value: 'workers.domain_id', label: 'Workers Domain ID', hint: 'e.g. abc123...', appliesTo: ['workers'] },
	// --- Request context (universal — applies to all actions) ---
	{ value: 'client_ip', label: 'Client IP', hint: 'e.g. 203.0.113.42' },
	{ value: 'client_country', label: 'Country', hint: 'e.g. US, DE, SG' },
	{ value: 'client_asn', label: 'ASN', hint: 'e.g. 13335' },
	{ value: 'time.hour', label: 'Hour (UTC)', hint: '0-23' },
	{ value: 'time.day_of_week', label: 'Day of Week', hint: '0=Sun, 6=Sat' },
	{ value: 'time.iso', label: 'Time (ISO)', hint: 'e.g. 2025-01-01T...' },
] as const;

const OPERATORS: readonly OperatorOption[] = [
	{ value: 'eq', label: 'equals' },
	{ value: 'ne', label: 'not equals' },
	{ value: 'contains', label: 'contains' },
	{ value: 'not_contains', label: 'not contains' },
	{ value: 'starts_with', label: 'starts with' },
	{ value: 'ends_with', label: 'ends with' },
	{ value: 'wildcard', label: 'wildcard (*)' },
	{ value: 'matches', label: 'regex' },
	{ value: 'in', label: 'in (list)' },
	{ value: 'not_in', label: 'not in (list)' },
	{ value: 'exists', label: 'exists' },
	{ value: 'not_exists', label: 'not exists' },
	{ value: 'lt', label: '< (less than)' },
	{ value: 'gt', label: '> (greater than)' },
	{ value: 'lte', label: '<= (less or equal)' },
	{ value: 'gte', label: '>= (greater or equal)' },
] as const;

/** Summarize a statement that spans multiple service prefixes. */
function summarizeMultiDomain(statement: { effect: string; actions: string[]; resources: string[]; conditions?: Condition[] }): string {
	const { actions, resources, conditions } = statement;

	// Group actions by prefix
	const byPrefix = new Map<string, string[]>();
	for (const a of actions) {
		const [prefix] = a.split(':');
		if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
		byPrefix.get(prefix)!.push(a);
	}

	const parts: string[] = [];
	for (const [prefix, acts] of byPrefix) {
		if (acts.includes(`${prefix}:*`)) {
			parts.push(`all ${prefix}`);
		} else {
			parts.push(acts.map((a) => a.replace(`${prefix}:`, `${prefix}/`)).join(', '));
		}
	}

	const actionStr = parts.join(' + ');
	let resourceStr = '';
	if (resources.length > 0 && !(resources.length === 1 && resources[0] === '*')) {
		resourceStr = ` on ${resources.join(', ')}`;
	}

	let condStr = '';
	if (conditions && conditions.length > 0) {
		condStr = ` where ${conditions.length} condition${conditions.length > 1 ? 's' : ''}`;
	}

	const effectLabel = statement.effect === 'deny' ? 'Deny' : 'Allow';
	return `${effectLabel} ${actionStr}${resourceStr}${condStr}`;
}

// ─── Types ──────────────────────────────────────────────────────────

interface PolicyBuilderProps {
	value: PolicyDocument;
	onChange: (policy: PolicyDocument) => void;
	/** When set, only show action groups matching this scope. */
	tokenScopeType?: 'zone' | 'account';
	/** Resource hint derived from token scope — shown as placeholder. */
	resourceHint?: string;
}

// ─── Statement Editor ───────────────────────────────────────────────

interface StatementEditorProps {
	index: number;
	statement: Statement;
	onChange: (s: Statement) => void;
	onRemove: () => void;
	canRemove: boolean;
	visibleGroups: readonly ActionGroup[];
	resourceHint?: string;
}

/** Group actions with categories into sections with dividers. */
function renderActionsWithCategories(
	actions: readonly ActionDef[],
	hasWildcard: boolean,
	selectedActions: string[],
	onToggle: (action: string) => void,
) {
	const items: React.ReactNode[] = [];
	let lastCategory: string | undefined;

	for (const a of actions) {
		// Category divider
		if (a.category && a.category !== lastCategory) {
			lastCategory = a.category;
			items.push(
				<div key={`cat-${a.category}`} className="w-full">
					<span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50 select-none">{a.category}</span>
				</div>,
			);
		}

		const active = hasWildcard || selectedActions.includes(a.value);
		items.push(
			<Tooltip key={a.value}>
				<TooltipTrigger asChild>
					<button
						type="button"
						onClick={() => onToggle(a.value)}
						disabled={hasWildcard}
						className={cn(
							'rounded border px-2 py-0.5 text-[11px] font-data transition-colors',
							active
								? 'border-lv-purple/50 bg-lv-purple/20 text-lv-purple'
								: 'border-border text-muted-foreground hover:border-lv-purple/30 hover:text-foreground',
							hasWildcard && 'opacity-50 cursor-not-allowed',
						)}
					>
						{a.label}
					</button>
				</TooltipTrigger>
				<TooltipContent side="top">
					<p className="text-xs">
						<code className="text-lv-cyan">{a.value}</code> — {a.description}
					</p>
				</TooltipContent>
			</Tooltip>,
		);
	}

	return items;
}

function StatementEditor({ index, statement, onChange, onRemove, canRemove, visibleGroups, resourceHint }: StatementEditorProps) {
	const [collapsed, setCollapsed] = useState(false);

	// Smart collapse: only expand groups that have active selections
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
		const active = new Set<string>();
		for (const group of visibleGroups) {
			const hasAction = statement.actions.some((a) => a.startsWith(group.prefix + ':'));
			if (hasAction) active.add(group.prefix);
		}
		// If nothing selected, expand the first group
		if (active.size === 0 && visibleGroups.length > 0) active.add(visibleGroups[0].prefix);
		return active;
	});

	const toggleGroup = (prefix: string) => {
		setExpandedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(prefix)) next.delete(prefix);
			else next.add(prefix);
			return next;
		});
	};

	const toggleAction = (action: string) => {
		const current = new Set(statement.actions);
		const actionPrefix = action.split(':')[0] + ':';
		const isWildcardAction = action.endsWith(':*') && ALL_PREFIXES.includes(action.split(':')[0]);
		if (isWildcardAction) {
			// Toggle wildcard: if already set, remove all actions with that prefix; otherwise set only the wildcard
			const otherActions = Array.from(current).filter((a) => !a.startsWith(actionPrefix));
			if (current.has(action)) {
				onChange({ ...statement, actions: otherActions });
			} else {
				onChange({ ...statement, actions: [...otherActions, action] });
			}
			return;
		}
		// Remove same-prefix wildcard when toggling a specific action
		current.delete(actionPrefix + '*');
		if (current.has(action)) {
			current.delete(action);
		} else {
			current.add(action);
		}
		onChange({ ...statement, actions: Array.from(current) });
	};

	const conditions: Condition[] = statement.conditions ?? [];

	/** Detect the primary domain for the summary line. */
	const activePrefixes = ALL_PREFIXES.filter((p) => statement.actions.some((a) => a.startsWith(p + ':')));
	const domain = activePrefixes.length === 1 ? activePrefixes[0] : (activePrefixes[0] ?? 'purge');
	const summary = activePrefixes.length > 1 ? summarizeMultiDomain(statement) : summarizeStatement(statement, domain);

	return (
		<div className="rounded-lg border border-border bg-card/50 p-3 space-y-3">
			{/* ── Statement header ──────────────────────────────── */}
			<div className="flex items-center gap-2">
				<button type="button" onClick={() => setCollapsed(!collapsed)} className="text-muted-foreground hover:text-foreground">
					{collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
				</button>
				<span className={T.sectionLabel}>Statement {index + 1}</span>
				<Select value={statement.effect} onValueChange={(v) => onChange({ ...statement, effect: v as 'allow' | 'deny' })}>
					<SelectTrigger
						className={cn(
							'w-[90px] h-6 text-[10px] font-semibold border',
							statement.effect === 'deny' ? 'bg-lv-red/20 text-lv-red border-lv-red/30' : 'bg-lv-green/20 text-lv-green border-lv-green/30',
						)}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="allow" className="text-xs text-lv-green">
							ALLOW
						</SelectItem>
						<SelectItem value="deny" className="text-xs text-lv-red">
							DENY
						</SelectItem>
					</SelectContent>
				</Select>
				{canRemove && (
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="ml-auto h-7 w-7 text-muted-foreground hover:text-lv-red"
						onClick={onRemove}
					>
						<Trash2 className="h-3.5 w-3.5" />
					</Button>
				)}
			</div>

			{/* ── Human-readable summary (always visible) ─────── */}
			<p className="text-xs text-muted-foreground bg-background/50 rounded-md px-2.5 py-1.5 border border-border/50 font-data">{summary}</p>

			{!collapsed && (
				<>
					{/* ── Actions (grouped by service) ─────────────── */}
					<div className="space-y-2">
						<Label className={T.formLabel}>Actions</Label>
						<TooltipProvider delayDuration={200}>
							<div className="space-y-1.5">
								{visibleGroups.map((group) => {
									const groupWildcard = `${group.prefix}:*`;
									const hasWildcard = statement.actions.includes(groupWildcard);
									const groupActionCount = statement.actions.filter((a) => a.startsWith(group.prefix + ':') && a !== groupWildcard).length;
									const isExpanded = expandedGroups.has(group.prefix);
									const hasAny = hasWildcard || groupActionCount > 0;
									const hasCategories = group.actions.some((a) => a.category);

									return (
										<div
											key={group.prefix}
											className={cn('rounded-md border', hasAny ? 'border-lv-purple/30 bg-lv-purple/5' : 'border-border')}
										>
											{/* Group header row — always visible */}
											<div className="flex items-center gap-1.5 px-2 py-1">
												<button
													type="button"
													onClick={() => toggleGroup(group.prefix)}
													className="text-muted-foreground hover:text-foreground"
												>
													{isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
												</button>
												<span className="text-[11px] font-semibold text-muted-foreground select-none min-w-[70px]">{group.label}</span>
												<Tooltip>
													<TooltipTrigger asChild>
														<button
															type="button"
															onClick={() => toggleAction(groupWildcard)}
															className={cn(
																'rounded border px-2 py-0.5 text-[11px] font-data transition-colors',
																hasWildcard
																	? 'border-lv-purple/50 bg-lv-purple/20 text-lv-purple'
																	: 'border-border text-muted-foreground hover:border-lv-purple/30 hover:text-foreground',
															)}
														>
															{group.prefix}:*
														</button>
													</TooltipTrigger>
													<TooltipContent side="top">
														<p className="text-xs">
															<code className="text-lv-cyan">{groupWildcard}</code> — {group.actions[0].description}
														</p>
														<p className="text-[10px] text-muted-foreground mt-0.5">Resource: {group.resource}</p>
													</TooltipContent>
												</Tooltip>
												{!hasWildcard && groupActionCount > 0 && (
													<span className="text-[10px] text-lv-purple font-data">{groupActionCount} selected</span>
												)}
												<span className="ml-auto text-[10px] text-muted-foreground/50 font-data">{group.description}</span>
											</div>
											{/* Individual actions — shown when expanded */}
											{isExpanded && (
												<div className="flex flex-wrap gap-1 px-2 pb-1.5">
													{hasCategories
														? renderActionsWithCategories(group.actions.slice(1), hasWildcard, [...statement.actions], toggleAction)
														: group.actions.slice(1).map((a) => {
																const active = hasWildcard || statement.actions.includes(a.value);
																return (
																	<Tooltip key={a.value}>
																		<TooltipTrigger asChild>
																			<button
																				type="button"
																				onClick={() => toggleAction(a.value)}
																				disabled={hasWildcard}
																				className={cn(
																					'rounded border px-2 py-0.5 text-[11px] font-data transition-colors',
																					active
																						? 'border-lv-purple/50 bg-lv-purple/20 text-lv-purple'
																						: 'border-border text-muted-foreground hover:border-lv-purple/30 hover:text-foreground',
																					hasWildcard && 'opacity-50 cursor-not-allowed',
																				)}
																			>
																				{a.label}
																			</button>
																		</TooltipTrigger>
																		<TooltipContent side="top">
																			<p className="text-xs">
																				<code className="text-lv-cyan">{a.value}</code> — {a.description}
																			</p>
																		</TooltipContent>
																	</Tooltip>
																);
															})}
												</div>
											)}
										</div>
									);
								})}
							</div>
						</TooltipProvider>
					</div>

					{/* ── Resources ─────────────────────────────────── */}
					<div className="space-y-2">
						<Label className={T.formLabel}>Resources</Label>
						<Input
							placeholder={resourceHint ?? 'e.g. zone:abc123, account:id/d1/db-id'}
							value={statement.resources.join(', ')}
							onChange={(e) => {
								const raw = e.target.value;
								const resources = raw
									.split(',')
									.map((s) => s.trim())
									.filter(Boolean);
								onChange({ ...statement, resources: resources.length > 0 ? resources : [] });
							}}
							className="text-xs font-data"
						/>
						<p className={cn(T.muted, 'italic')}>
							<code className="text-lv-cyan">zone:id</code> for zones, <code className="text-lv-cyan">account:id</code> for account-level,{' '}
							<code className="text-lv-cyan">account:id/d1/db-id</code> for instance-scoped. Bare <code className="text-lv-cyan">*</code> is
							not allowed.
						</p>
					</div>

					{/* ── Conditions ────────────────────────────────── */}
					<div className="space-y-2">
						<Label className={T.formLabel}>Conditions {conditions.length > 0 && `(${conditions.length})`}</Label>
						<ConditionEditor
							conditions={conditions}
							onChange={(next) => onChange({ ...statement, conditions: next.length > 0 ? next : undefined })}
							fields={CONDITION_FIELDS}
							operators={OPERATORS}
							defaultField="host"
							activeActionPrefixes={getActivePrefixes(statement.actions)}
						/>
					</div>
				</>
			)}
		</div>
	);
}

// ─── Policy Builder ─────────────────────────────────────────────────

export function PolicyBuilder({ value, onChange, tokenScopeType, resourceHint }: PolicyBuilderProps) {
	const [showJson, setShowJson] = useState(false);

	const visibleGroups = useMemo(() => {
		if (!tokenScopeType) return ACTION_GROUPS;
		return ACTION_GROUPS.filter((g) => g.scope === tokenScopeType);
	}, [tokenScopeType]);

	const ensureId = (stmt: Statement): Statement => (stmt._id ? stmt : { ...stmt, _id: crypto.randomUUID() });

	const updateStatement = useCallback(
		(index: number, stmt: Statement) => {
			const next = [...value.statements];
			next[index] = stmt;
			onChange({ ...value, statements: next });
		},
		[value, onChange],
	);

	const removeStatement = useCallback(
		(index: number) => {
			onChange({
				...value,
				statements: value.statements.filter((_, i) => i !== index),
			});
		},
		[value, onChange],
	);

	const addStatement = useCallback(() => {
		// Default action for new statement: first visible group's wildcard
		const defaultAction = visibleGroups.length > 0 ? `${visibleGroups[0].prefix}:*` : 'purge:*';
		onChange({
			...value,
			statements: [
				...value.statements,
				{
					_id: crypto.randomUUID(),
					effect: 'allow',
					actions: [defaultAction],
					resources: [],
				},
			],
		});
	}, [value, onChange, visibleGroups]);

	return (
		<div className="space-y-3">
			{value.statements.map((rawStmt, i) => {
				const stmt = ensureId(rawStmt);
				if (stmt !== rawStmt) {
					// Backfill _id on first render without triggering extra re-render
					value.statements[i] = stmt;
				}
				return (
					<StatementEditor
						key={stmt._id}
						index={i}
						statement={stmt}
						onChange={(s) => updateStatement(i, s)}
						onRemove={() => removeStatement(i)}
						canRemove={value.statements.length > 1}
						visibleGroups={visibleGroups}
						resourceHint={resourceHint}
					/>
				);
			})}

			<div className="flex items-center gap-2">
				<Button type="button" variant="outline" size="sm" className="text-xs" onClick={addStatement}>
					<Plus className="h-3 w-3 mr-1" />
					Add Statement
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="ml-auto text-xs text-muted-foreground"
					onClick={() => setShowJson(!showJson)}
				>
					{showJson ? <EyeOff className="h-3 w-3 mr-1" /> : <Eye className="h-3 w-3 mr-1" />}
					{showJson ? 'Hide' : 'Show'} JSON
				</Button>
			</div>

			{showJson && (
				<pre className="rounded-md border border-border bg-background/50 p-3 text-[11px] font-data text-muted-foreground overflow-x-auto max-h-48 overflow-y-auto">
					{JSON.stringify(value, null, 2)}
				</pre>
			)}
		</div>
	);
}
