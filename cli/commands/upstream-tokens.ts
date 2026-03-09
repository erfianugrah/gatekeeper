import { defineCommand } from 'citty';
import { resolveConfig, request, assertOk } from '../client.js';
import { success, info, warn, error, bold, dim, cyan, table, label, printJson, formatDuration, confirmAction } from '../ui.js';
import { baseArgs, forceArg } from '../shared-args.js';
import { makeBulkSubcommand } from '../bulk-helpers.js';

const globalArgs = baseArgs;

// --- upstream-tokens create ---
const create = defineCommand({
	meta: {
		name: 'create',
		description: 'Register a Cloudflare API token for upstream requests',
	},
	args: {
		...globalArgs,
		name: {
			type: 'string',
			description: 'Human-readable name for this token',
			required: true,
		},
		token: {
			type: 'string',
			description: 'Cloudflare API token value ($UPSTREAM_CF_TOKEN). Prefer UPSTREAM_CF_TOKEN env var to avoid shell history exposure',
		},
		'scope-type': {
			type: 'string',
			description: 'Token scope: "zone" (purge/DNS) or "account" (CF proxy: D1, KV, Workers, etc.)',
			default: 'zone',
		},
		'zone-ids': {
			type: 'string',
			description: 'Comma-separated zone/account IDs this token covers, or "*" for all',
			required: true,
		},
		validate: {
			type: 'boolean',
			description: 'Validate the token against Cloudflare API on creation',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const tokenValue = args.token || process.env['UPSTREAM_CF_TOKEN'];
		if (!tokenValue) {
			error('Token required. Set --token or UPSTREAM_CF_TOKEN env var.');
			process.exit(1);
		}

		const scopeType = args['scope-type'] ?? 'zone';
		if (scopeType !== 'zone' && scopeType !== 'account') {
			error('--scope-type must be "zone" or "account".');
			process.exit(1);
		}

		const zoneIds = args['zone-ids'] === '*' ? ['*'] : args['zone-ids'].split(',').map((s) => s.trim());

		const body: Record<string, unknown> = {
			name: args.name,
			token: tokenValue,
			scope_type: scopeType,
			zone_ids: zoneIds,
		};

		if (args.validate) {
			body.validate = true;
		}

		const { status, data, durationMs } = await request(config, 'POST', '/admin/upstream-tokens', {
			body,
			auth: 'admin',
			label: 'Registering upstream token...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>;

		console.error('');
		success(`Upstream token registered ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');
		formatUpstreamToken(result);
		console.error('');

		const warnings = result.warnings as string[] | undefined;
		if (warnings && warnings.length > 0) {
			for (const w of warnings) {
				warn(w);
			}
			console.error('');
		}

		warn('The token value is stored write-only and cannot be retrieved again.');
		console.error('');
	},
});

// --- upstream-tokens list ---
const list = defineCommand({
	meta: { name: 'list', description: 'List all registered upstream tokens' },
	args: {
		...globalArgs,
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const { status, data, durationMs } = await request(config, 'GET', '/admin/upstream-tokens', {
			auth: 'admin',
			label: 'Fetching upstream tokens...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>[];

		if (result.length === 0) {
			info('No upstream tokens found.');
			return;
		}

		console.error('');
		info(`${bold(String(result.length))} token${result.length === 1 ? '' : 's'} found ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');

		const rows = result.map((t) => {
			const created = new Date(t.created_at as number).toISOString().slice(0, 19).replace('T', ' ');
			const zones = t.zone_ids as string;
			const scope = (t.scope_type as string) ?? 'zone';

			return [cyan(t.id as string), t.name as string, scope, zones, created];
		});

		table(['ID', 'Name', 'Scope', 'Zone/Account IDs', 'Created'], rows);
		console.error('');
	},
});

// --- upstream-tokens get ---
const get = defineCommand({
	meta: { name: 'get', description: 'Get details of an upstream token' },
	args: {
		...globalArgs,
		id: {
			type: 'string',
			description: 'The upstream token ID (upt_...)',
			required: true,
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const { status, data, durationMs } = await request(config, 'GET', `/admin/upstream-tokens/${encodeURIComponent(args.id)}`, {
			auth: 'admin',
			label: 'Fetching upstream token...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>;

		console.error('');
		formatUpstreamToken(result);
		console.error('');
	},
});

// --- upstream-tokens delete ---
const del = defineCommand({
	meta: { name: 'delete', description: 'Delete an upstream token (permanent, irreversible)' },
	args: {
		...globalArgs,
		id: {
			type: 'string',
			description: 'The upstream token ID to delete (upt_...)',
			required: true,
		},
		...forceArg,
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const tokenId = args.id;

		if (!args.force) {
			const confirmed = await confirmAction(`You are about to delete upstream token ${bold(tokenId)}. This cannot be undone.`);
			if (!confirmed) {
				info('Aborted.');
				return;
			}
		}

		const { status, data, durationMs } = await request(config, 'DELETE', `/admin/upstream-tokens/${encodeURIComponent(tokenId)}`, {
			auth: 'admin',
			label: 'Deleting upstream token...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		console.error('');
		success(`Upstream token ${bold(tokenId)} deleted ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');
	},
});

// --- upstream-tokens bulk-delete ---
const bulkDelete = makeBulkSubcommand({
	entityName: 'tokens',
	apiPath: '/admin/upstream-tokens/bulk-delete',
	idField: 'ids',
	action: 'delete',
	displayField: 'token IDs (upt_...)',
});

// --- Formatting helper ---

function formatUpstreamToken(token: Record<string, unknown>): void {
	label('ID', bold(token.id as string));
	label('Name', token.name as string);
	label('Scope type', (token.scope_type as string) ?? 'zone');
	label('Token preview', dim(token.token_preview as string));
	label('Zone/Account IDs', token.zone_ids as string);
	label('Created', new Date(token.created_at as number).toISOString());
	if (token.created_by) {
		label('Created by', token.created_by as string);
	}
}

// --- upstream-tokens (parent) ---
export default defineCommand({
	meta: { name: 'upstream-tokens', description: 'Manage upstream Cloudflare API tokens (purge, DNS, CF proxy)' },
	subCommands: { create, list, get, delete: del, 'bulk-delete': bulkDelete },
});
