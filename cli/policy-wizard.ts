/** Interactive policy builder wizard for the CLI. */

import { createInterface } from 'node:readline';
import { bold, dim, cyan, green, red, yellow, info, error, warn, symbols } from './ui.js';

// ─── Readline helpers ───────────────────────────────────────────────────────

function createRl(): ReturnType<typeof createInterface> {
	return createInterface({ input: process.stdin, output: process.stderr });
}

async function ask(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
	return new Promise((resolve) => {
		rl.question(prompt, (answer) => resolve(answer.trim()));
	});
}

// ─── Action definitions ─────────────────────────────────────────────────────

interface ActionDef {
	value: string;
	label: string;
	description: string;
}

interface ActionGroup {
	prefix: string;
	label: string;
	scope: 'zone' | 'account';
	resourceHint: string;
	actions: ActionDef[];
}

const CF_ACTION_GROUPS: ActionGroup[] = [
	{
		prefix: 'purge',
		label: 'Purge',
		scope: 'zone',
		resourceHint: 'zone:<zone-id>',
		actions: [
			{ value: 'purge:*', label: 'All Purge', description: 'All purge types' },
			{ value: 'purge:url', label: 'URL', description: 'Purge by URL' },
			{ value: 'purge:host', label: 'Host', description: 'Purge by hostname' },
			{ value: 'purge:tag', label: 'Tag', description: 'Purge by cache tag' },
			{ value: 'purge:prefix', label: 'Prefix', description: 'Purge by URL prefix' },
			{ value: 'purge:everything', label: 'Everything', description: 'Purge all cached content' },
		],
	},
	{
		prefix: 'dns',
		label: 'DNS',
		scope: 'zone',
		resourceHint: 'zone:<zone-id>',
		actions: [
			{ value: 'dns:*', label: 'All DNS', description: 'All DNS operations' },
			{ value: 'dns:create', label: 'Create', description: 'Create DNS records' },
			{ value: 'dns:read', label: 'Read', description: 'Get or list DNS records' },
			{ value: 'dns:update', label: 'Update', description: 'Edit DNS records' },
			{ value: 'dns:delete', label: 'Delete', description: 'Delete DNS records' },
			{ value: 'dns:batch', label: 'Batch', description: 'Batch operations' },
			{ value: 'dns:export', label: 'Export', description: 'Export BIND zone file' },
			{ value: 'dns:import', label: 'Import', description: 'Import BIND zone file' },
		],
	},
	{
		prefix: 'd1',
		label: 'D1',
		scope: 'account',
		resourceHint: 'account:<id>/d1/<database-id>',
		actions: [
			{ value: 'd1:*', label: 'All D1', description: 'All D1 operations' },
			{ value: 'd1:create', label: 'Create', description: 'Create a database' },
			{ value: 'd1:list', label: 'List', description: 'List databases' },
			{ value: 'd1:get', label: 'Get', description: 'Get database details' },
			{ value: 'd1:query', label: 'Query', description: 'Execute SQL query' },
			{ value: 'd1:delete', label: 'Delete', description: 'Delete a database' },
		],
	},
	{
		prefix: 'kv',
		label: 'KV',
		scope: 'account',
		resourceHint: 'account:<id>/kv/<namespace-id>',
		actions: [
			{ value: 'kv:*', label: 'All KV', description: 'All KV operations' },
			{ value: 'kv:list_namespaces', label: 'List NS', description: 'List namespaces' },
			{ value: 'kv:put_value', label: 'Put', description: 'Write key-value pair' },
			{ value: 'kv:get_value', label: 'Get', description: 'Read value by key' },
			{ value: 'kv:delete_value', label: 'Delete', description: 'Delete key-value pair' },
			{ value: 'kv:list_keys', label: 'List Keys', description: 'List keys' },
		],
	},
	{
		prefix: 'workers',
		label: 'Workers',
		scope: 'account',
		resourceHint: 'account:<id>/workers/<script-name>',
		actions: [
			{ value: 'workers:*', label: 'All Workers', description: 'All Workers operations' },
			{ value: 'workers:list_scripts', label: 'List Scripts', description: 'List all scripts' },
			{ value: 'workers:get_script', label: 'Get Script', description: 'Get script metadata' },
			{ value: 'workers:update_script', label: 'Update Script', description: 'Upload/update script' },
			{ value: 'workers:delete_script', label: 'Delete Script', description: 'Delete a script' },
			{ value: 'workers:list_deployments', label: 'List Deployments', description: 'List deployments' },
			{ value: 'workers:create_deployment', label: 'Create Deployment', description: 'Create deployment' },
		],
	},
	{
		prefix: 'queues',
		label: 'Queues',
		scope: 'account',
		resourceHint: 'account:<id>/queues/<queue-id>',
		actions: [
			{ value: 'queues:*', label: 'All Queues', description: 'All Queues operations' },
			{ value: 'queues:create', label: 'Create', description: 'Create a queue' },
			{ value: 'queues:list', label: 'List', description: 'List queues' },
			{ value: 'queues:push_message', label: 'Push', description: 'Push a message' },
			{ value: 'queues:pull_messages', label: 'Pull', description: 'Pull messages' },
			{ value: 'queues:delete', label: 'Delete', description: 'Delete a queue' },
		],
	},
	{
		prefix: 'vectorize',
		label: 'Vectorize',
		scope: 'account',
		resourceHint: 'account:<id>/vectorize/<index-name>',
		actions: [
			{ value: 'vectorize:*', label: 'All Vectorize', description: 'All Vectorize operations' },
			{ value: 'vectorize:query', label: 'Query', description: 'Query vectors' },
			{ value: 'vectorize:insert', label: 'Insert', description: 'Insert vectors' },
			{ value: 'vectorize:upsert', label: 'Upsert', description: 'Upsert vectors' },
			{ value: 'vectorize:delete_by_ids', label: 'Delete', description: 'Delete vectors by ID' },
		],
	},
	{
		prefix: 'hyperdrive',
		label: 'Hyperdrive',
		scope: 'account',
		resourceHint: 'account:<id>/hyperdrive/<config-id>',
		actions: [
			{ value: 'hyperdrive:*', label: 'All Hyperdrive', description: 'All Hyperdrive operations' },
			{ value: 'hyperdrive:create', label: 'Create', description: 'Create a config' },
			{ value: 'hyperdrive:list', label: 'List', description: 'List configs' },
			{ value: 'hyperdrive:get', label: 'Get', description: 'Get config details' },
			{ value: 'hyperdrive:delete', label: 'Delete', description: 'Delete config' },
		],
	},
];

const S3_ACTIONS: ActionDef[] = [
	{ value: 's3:*', label: 'All S3', description: 'Full access to all S3 operations' },
	{ value: 's3:GetObject', label: 'GetObject', description: 'Read objects' },
	{ value: 's3:PutObject', label: 'PutObject', description: 'Write/upload objects' },
	{ value: 's3:DeleteObject', label: 'DeleteObject', description: 'Delete objects' },
	{ value: 's3:ListBucket', label: 'ListBucket', description: 'List objects in a bucket' },
	{ value: 's3:ListAllMyBuckets', label: 'ListBuckets', description: 'List all buckets' },
	{ value: 's3:CreateBucket', label: 'CreateBucket', description: 'Create buckets' },
	{ value: 's3:DeleteBucket', label: 'DeleteBucket', description: 'Delete buckets' },
	{ value: 's3:HeadBucket', label: 'HeadBucket', description: 'Check bucket exists' },
	{ value: 's3:AbortMultipartUpload', label: 'AbortMultipart', description: 'Abort multipart uploads' },
];

// ─── Condition definitions ──────────────────────────────────────────────────

interface ConditionFieldDef {
	value: string;
	label: string;
	hint: string;
}

const CF_CONDITION_FIELDS: ConditionFieldDef[] = [
	{ value: 'host', label: 'Host', hint: 'e.g. example.com' },
	{ value: 'tag', label: 'Tag', hint: 'e.g. static-v2' },
	{ value: 'url', label: 'URL', hint: 'e.g. https://example.com/page' },
	{ value: 'url.path', label: 'URL Path', hint: 'e.g. /api/v1/' },
	{ value: 'dns.name', label: 'DNS Name', hint: 'e.g. _acme-challenge.example.com' },
	{ value: 'dns.type', label: 'DNS Type', hint: 'e.g. A, AAAA, CNAME, TXT' },
	{ value: 'client_ip', label: 'Client IP', hint: 'e.g. 203.0.113.42' },
	{ value: 'client_country', label: 'Country', hint: 'e.g. US, DE, SG' },
	{ value: 'time.hour', label: 'Hour (UTC)', hint: '0-23' },
];

const S3_CONDITION_FIELDS: ConditionFieldDef[] = [
	{ value: 'bucket', label: 'Bucket', hint: 'e.g. my-bucket' },
	{ value: 'key', label: 'Key', hint: 'e.g. images/photo.jpg' },
	{ value: 'key.prefix', label: 'Key Prefix', hint: 'e.g. uploads/' },
	{ value: 'key.extension', label: 'Extension', hint: 'e.g. jpg' },
	{ value: 'content_type', label: 'Content-Type', hint: 'e.g. image/jpeg' },
	{ value: 'client_ip', label: 'Client IP', hint: 'e.g. 203.0.113.42' },
	{ value: 'client_country', label: 'Country', hint: 'e.g. US, DE, SG' },
	{ value: 'time.hour', label: 'Hour (UTC)', hint: '0-23' },
];

const OPERATORS = [
	{ value: 'eq', label: 'equals' },
	{ value: 'ne', label: 'not equals' },
	{ value: 'contains', label: 'contains' },
	{ value: 'starts_with', label: 'starts with' },
	{ value: 'ends_with', label: 'ends with' },
	{ value: 'wildcard', label: 'wildcard (*)' },
	{ value: 'matches', label: 'regex' },
	{ value: 'in', label: 'in (comma-separated list)' },
	{ value: 'not_in', label: 'not in (comma-separated list)' },
];

// ─── Generic chooser helpers ────────────────────────────────────────────────

/** Display numbered list and return selected indices (1-based input, 0-based output). */
async function chooseMultiple(
	rl: ReturnType<typeof createInterface>,
	label: string,
	items: { value: string; label: string; description: string }[],
): Promise<string[]> {
	console.error('');
	console.error(`  ${bold(label)}`);
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		console.error(`    ${dim(String(i + 1) + '.')} ${cyan(item.label)} ${dim('—')} ${item.description} ${dim(`(${item.value})`)}`);
	}
	console.error('');
	const input = await ask(rl, `  ${dim('Select numbers (comma-separated, e.g. 1,3,5):')} `);

	const indices = input
		.split(/[,\s]+/)
		.map((s) => Number(s) - 1)
		.filter((n) => !isNaN(n) && n >= 0 && n < items.length);

	if (indices.length === 0) {
		warn('No valid selection. Please try again.');
		return chooseMultiple(rl, label, items);
	}

	return indices.map((i) => items[i].value);
}

/** Display numbered list and return single selection. */
async function chooseSingle(
	rl: ReturnType<typeof createInterface>,
	label: string,
	items: { value: string; label: string }[],
): Promise<string> {
	console.error('');
	console.error(`  ${bold(label)}`);
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		console.error(`    ${dim(String(i + 1) + '.')} ${item.label}`);
	}
	console.error('');
	const input = await ask(rl, `  ${dim('Select number:')} `);
	const idx = Number(input) - 1;
	if (isNaN(idx) || idx < 0 || idx >= items.length) {
		warn('Invalid selection. Please try again.');
		return chooseSingle(rl, label, items);
	}
	return items[idx].value;
}

async function askYesNo(rl: ReturnType<typeof createInterface>, question: string, defaultYes = false): Promise<boolean> {
	const hint = defaultYes ? '[Y/n]' : '[y/N]';
	const input = await ask(rl, `  ${question} ${dim(hint)} `);
	if (input === '') return defaultYes;
	return input.toLowerCase() === 'y';
}

// ─── Statement builder ──────────────────────────────────────────────────────

interface StatementResult {
	effect: 'allow' | 'deny';
	actions: string[];
	resources: string[];
	conditions?: ConditionResult[];
}

interface ConditionResult {
	field: string;
	operator: string;
	value: string | string[];
}

async function buildCondition(rl: ReturnType<typeof createInterface>, fields: ConditionFieldDef[]): Promise<ConditionResult | null> {
	// Field
	console.error('');
	console.error(`  ${bold('Condition field:')}`);
	for (let i = 0; i < fields.length; i++) {
		const f = fields[i];
		console.error(`    ${dim(String(i + 1) + '.')} ${cyan(f.label)} ${dim(`(${f.value})`)} ${dim('—')} ${f.hint}`);
	}
	console.error('');
	const fieldInput = await ask(rl, `  ${dim('Select number or type a custom field name:')} `);

	let field: string;
	const fieldIdx = Number(fieldInput) - 1;
	if (!isNaN(fieldIdx) && fieldIdx >= 0 && fieldIdx < fields.length) {
		field = fields[fieldIdx].value;
	} else if (fieldInput.length > 0) {
		field = fieldInput;
	} else {
		return null;
	}

	// Operator
	const operator = await chooseSingle(
		rl,
		'Operator:',
		OPERATORS.map((o) => ({ value: o.value, label: `${o.label} ${dim(`(${o.value})`)}` })),
	);

	// Value
	let value: string | string[];
	if (operator === 'in' || operator === 'not_in') {
		const raw = await ask(rl, `  ${dim('Values (comma-separated):')} `);
		value = raw
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (value.length === 0) {
			warn('No values provided.');
			return null;
		}
	} else {
		const raw = await ask(rl, `  ${dim('Value:')} `);
		if (raw === '') {
			warn('Empty value.');
			return null;
		}
		value = raw;
	}

	return { field, operator, value };
}

async function buildCfStatement(rl: ReturnType<typeof createInterface>): Promise<StatementResult> {
	// Effect
	const effect = (await chooseSingle(rl, 'Effect:', [
		{ value: 'allow', label: green('Allow') },
		{ value: 'deny', label: red('Deny') },
	])) as 'allow' | 'deny';

	// Service groups
	console.error('');
	console.error(`  ${bold('Service groups:')}`);
	for (let i = 0; i < CF_ACTION_GROUPS.length; i++) {
		const g = CF_ACTION_GROUPS[i];
		console.error(`    ${dim(String(i + 1) + '.')} ${cyan(g.label)} ${dim(`(${g.scope}-scoped)`)} ${dim('—')} ${g.resourceHint}`);
	}
	console.error('');
	const groupInput = await ask(rl, `  ${dim('Select service groups (comma-separated, e.g. 1,2):')} `);
	const groupIndices = groupInput
		.split(/[,\s]+/)
		.map((s) => Number(s) - 1)
		.filter((n) => !isNaN(n) && n >= 0 && n < CF_ACTION_GROUPS.length);

	if (groupIndices.length === 0) {
		warn('No groups selected, defaulting to Purge.');
		groupIndices.push(0);
	}

	const selectedGroups = groupIndices.map((i) => CF_ACTION_GROUPS[i]);

	// Actions per selected group
	const actions: string[] = [];
	for (const group of selectedGroups) {
		const groupActions = await chooseMultiple(rl, `${group.label} actions:`, group.actions);
		actions.push(...groupActions);
	}

	// Resources
	const resourceHints = [...new Set(selectedGroups.map((g) => g.resourceHint))];
	console.error('');
	info(`Resource format: ${resourceHints.map((h) => cyan(h)).join(', ')}`);
	const resourceInput = await ask(rl, `  ${dim('Resources (comma-separated):')} `);
	const resources = resourceInput
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (resources.length === 0) {
		warn('No resources specified. You must add resources for the policy to match anything.');
	}

	// Conditions
	const conditions: ConditionResult[] = [];
	const wantConditions = await askYesNo(rl, 'Add conditions?');
	if (wantConditions) {
		let addMore = true;
		while (addMore) {
			const cond = await buildCondition(rl, CF_CONDITION_FIELDS);
			if (cond) {
				conditions.push(cond);
				console.error(`  ${symbols.success} Condition added: ${cyan(cond.field)} ${dim(cond.operator)} ${JSON.stringify(cond.value)}`);
			}
			addMore = await askYesNo(rl, 'Add another condition?');
		}
	}

	return {
		effect,
		actions,
		resources,
		conditions: conditions.length > 0 ? conditions : undefined,
	};
}

async function buildS3Statement(rl: ReturnType<typeof createInterface>): Promise<StatementResult> {
	// Effect
	const effect = (await chooseSingle(rl, 'Effect:', [
		{ value: 'allow', label: green('Allow') },
		{ value: 'deny', label: red('Deny') },
	])) as 'allow' | 'deny';

	// Actions
	const actions = await chooseMultiple(rl, 'S3 actions:', S3_ACTIONS);

	// Resources
	console.error('');
	info(`Resource format: ${cyan('bucket:<name>')}, ${cyan('object:<bucket>/*')}, or ${cyan('*')}`);
	const resourceInput = await ask(rl, `  ${dim('Resources (comma-separated):')} `);
	const resources = resourceInput
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (resources.length === 0) {
		resources.push('*');
		info('Defaulting to * (all resources).');
	}

	// Conditions
	const conditions: ConditionResult[] = [];
	const wantConditions = await askYesNo(rl, 'Add conditions?');
	if (wantConditions) {
		let addMore = true;
		while (addMore) {
			const cond = await buildCondition(rl, S3_CONDITION_FIELDS);
			if (cond) {
				conditions.push(cond);
				console.error(`  ${symbols.success} Condition added: ${cyan(cond.field)} ${dim(cond.operator)} ${JSON.stringify(cond.value)}`);
			}
			addMore = await askYesNo(rl, 'Add another condition?');
		}
	}

	return {
		effect,
		actions,
		resources,
		conditions: conditions.length > 0 ? conditions : undefined,
	};
}

// ─── Policy document builder ────────────────────────────────────────────────

interface PolicyDocument {
	version: '2025-01-01';
	statements: StatementResult[];
}

async function buildPolicy(mode: 'cf' | 's3'): Promise<PolicyDocument> {
	if (!process.stdin.isTTY) {
		error('Interactive policy builder requires a TTY. Use --policy to provide a policy document.');
		process.exit(1);
	}

	const rl = createRl();

	try {
		console.error('');
		console.error(`  ${bold(yellow('Interactive Policy Builder'))}`);
		console.error(`  ${dim('Build a policy document step by step. Press Ctrl+C to abort.')}`);

		const statements: StatementResult[] = [];
		let addMore = true;

		while (addMore) {
			console.error('');
			console.error(`  ${dim('─── Statement ' + (statements.length + 1) + ' ───')}`);

			const stmt = mode === 's3' ? await buildS3Statement(rl) : await buildCfStatement(rl);
			statements.push(stmt);

			// Preview
			console.error('');
			console.error(`  ${symbols.success} Statement added:`);
			const effectLabel = stmt.effect === 'deny' ? red('DENY') : green('ALLOW');
			console.error(`    ${effectLabel} ${stmt.actions.map((a) => cyan(a)).join(', ')}`);
			console.error(`    ${dim('on')} ${stmt.resources.join(', ')}`);
			if (stmt.conditions) {
				console.error(`    ${dim('with')} ${stmt.conditions.length} condition${stmt.conditions.length > 1 ? 's' : ''}`);
			}

			addMore = await askYesNo(rl, 'Add another statement?');
		}

		const policy: PolicyDocument = {
			version: '2025-01-01',
			statements,
		};

		// Final preview
		console.error('');
		console.error(`  ${bold('Final policy:')}`);
		console.error(dim('  ' + JSON.stringify(policy, null, 2).split('\n').join('\n  ')));
		console.error('');

		const confirmed = await askYesNo(rl, 'Use this policy?', true);
		if (!confirmed) {
			info('Policy builder cancelled.');
			process.exit(0);
		}

		return policy;
	} finally {
		rl.close();
	}
}

/** Build a Cloudflare proxy policy (purge, DNS, D1, KV, Workers, etc.) interactively. */
export async function buildCfPolicy(): Promise<PolicyDocument> {
	return buildPolicy('cf');
}

/** Build an S3 policy interactively. */
export async function buildS3Policy(): Promise<PolicyDocument> {
	return buildPolicy('s3');
}
