import { defineCommand } from 'citty';
import { resolveConfig, resolveZoneId, resolveOptionalZoneId, request, assertOk } from '../client.js';
import {
	success,
	info,
	bold,
	dim,
	cyan,
	green,
	red,
	table,
	printJson,
	formatKey,
	formatPolicy,
	parsePolicy,
	formatDuration,
	symbols,
	confirmAction,
} from '../ui.js';
import { zoneArgs, forceArg } from '../shared-args.js';
import { makeBulkSubcommand } from '../bulk-helpers.js';

const globalArgs = zoneArgs;

// --- keys create ---
const create = defineCommand({
	meta: {
		name: 'create',
		description: 'Create a new API key with a policy document',
	},
	args: {
		...globalArgs,
		name: {
			type: 'string',
			description: 'Human-readable key name',
			required: true,
		},
		policy: {
			type: 'string',
			description: 'Policy document as JSON string or @path/to/file.json',
			required: true,
		},
		'account-scoped': {
			type: 'boolean',
			description: 'Create key without zone scope (for CF proxy: D1, KV, Workers, etc.)',
		},
		'expires-in-days': {
			type: 'string',
			description: 'Key expiration in days (optional)',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const zoneId = args['account-scoped'] ? undefined : resolveOptionalZoneId(args);

		const body: Record<string, unknown> = {
			name: args.name,
			policy: parsePolicy(args.policy),
		};

		if (zoneId) {
			body.zone_id = zoneId;
		}

		if (args['expires-in-days']) {
			body['expires_in_days'] = Number(args['expires-in-days']);
		}

		const { status, data, durationMs } = await request(config, 'POST', '/admin/keys', {
			body,
			auth: 'admin',
			label: 'Creating API key...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>;
		const key = result.key as Record<string, unknown>;

		console.error('');
		success(`Key created ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');
		formatKey(key as Parameters<typeof formatKey>[0]);
		console.error('');
		info('Policy:');
		formatPolicy(key.policy as string);
		console.error('');
		console.error(`  ${symbols.arrow} Use as: ${cyan(`Authorization: Bearer ${key.id}`)}`);
		console.error('');
	},
});

// --- keys list ---
const list = defineCommand({
	meta: { name: 'list', description: 'List all API keys for a zone' },
	args: {
		...globalArgs,
		'active-only': {
			type: 'boolean',
			description: 'Only show active (non-revoked, non-expired) keys',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const zoneId = resolveOptionalZoneId(args);

		const params = new URLSearchParams();
		if (zoneId) params.set('zone_id', zoneId);
		if (args['active-only']) params.set('status', 'active');
		const qs = params.toString();
		const { status, data, durationMs } = await request(config, 'GET', `/admin/keys${qs ? `?${qs}` : ''}`, {
			auth: 'admin',
			label: 'Fetching keys...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>[];

		if (result.length === 0) {
			info(zoneId ? `No keys found for zone ${dim(zoneId)}` : 'No keys found.');
			return;
		}

		console.error('');
		info(`${bold(String(result.length))} key${result.length === 1 ? '' : 's'} found ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');

		const rows = result.map((k) => {
			const statusLabel =
				(k.revoked as number) === 1
					? red('revoked')
					: k.expires_at && (k.expires_at as number) < Date.now()
						? red('expired')
						: green('active');

			const created = new Date(k.created_at as number).toISOString().slice(0, 19).replace('T', ' ');

			return [cyan(k.id as string), k.name as string, statusLabel, created];
		});

		table(['ID', 'Name', 'Status', 'Created'], rows);
		console.error('');
	},
});

// --- keys get ---
const get = defineCommand({
	meta: { name: 'get', description: 'Get details and scopes of an API key' },
	args: {
		...globalArgs,
		'key-id': {
			type: 'string',
			description: 'The API key ID (gw_...)',
			required: true,
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const zoneId = resolveOptionalZoneId(args);

		const qs = zoneId ? `?zone_id=${encodeURIComponent(zoneId)}` : '';
		const { status, data, durationMs } = await request(config, 'GET', `/admin/keys/${encodeURIComponent(args['key-id'])}${qs}`, {
			auth: 'admin',
			label: 'Fetching key...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>;
		const key = result.key as Record<string, unknown>;

		console.error('');
		formatKey(key as Parameters<typeof formatKey>[0]);
		console.error('');
		if (key.policy) {
			info('Policy:');
			formatPolicy(key.policy as string);
		}
		console.error('');
	},
});

// --- keys revoke ---
const revoke = defineCommand({
	meta: { name: 'revoke', description: 'Revoke or permanently delete an API key' },
	args: {
		...globalArgs,
		'key-id': {
			type: 'string',
			description: 'The API key ID to revoke (gw_...)',
			required: true,
		},
		permanent: {
			type: 'boolean',
			description: 'Permanently delete the key row instead of soft-revoking',
		},
		...forceArg,
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const zoneId = resolveOptionalZoneId(args);
		const keyId = args['key-id'];
		const isPermanent = !!args.permanent;
		const action = isPermanent ? 'permanently delete' : 'revoke';

		if (!args.force) {
			const confirmed = await confirmAction(`You are about to ${action} key ${bold(keyId)}. This cannot be undone.`);
			if (!confirmed) {
				info('Aborted.');
				return;
			}
		}

		const params = new URLSearchParams();
		if (zoneId) params.set('zone_id', zoneId);
		if (isPermanent) params.set('permanent', 'true');
		const qs = params.toString();
		const { status, data, durationMs } = await request(config, 'DELETE', `/admin/keys/${encodeURIComponent(keyId)}?${qs}`, {
			auth: 'admin',
			label: isPermanent ? 'Deleting key...' : 'Revoking key...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		console.error('');
		if (isPermanent) {
			success(`Key ${bold(keyId)} permanently deleted ${dim(`(${formatDuration(durationMs)})`)}`);
		} else {
			success(`Key ${bold(keyId)} revoked ${dim(`(${formatDuration(durationMs)})`)}`);
		}
		console.error('');
	},
});

// --- keys bulk-revoke ---
const bulkRevoke = makeBulkSubcommand({
	entityName: 'keys',
	apiPath: '/admin/keys/bulk-revoke',
	idField: 'ids',
	action: 'revoke',
	displayField: 'key IDs (gw_...)',
});

// --- keys bulk-delete ---
const bulkDelete = makeBulkSubcommand({
	entityName: 'keys',
	apiPath: '/admin/keys/bulk-delete',
	idField: 'ids',
	action: 'delete',
	displayField: 'key IDs (gw_...)',
});

// --- keys (parent) ---
export default defineCommand({
	meta: { name: 'keys', description: 'Manage API keys' },
	subCommands: { create, list, get, revoke, 'bulk-revoke': bulkRevoke, 'bulk-delete': bulkDelete },
});
