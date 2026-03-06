import { defineCommand } from 'citty';
import { resolveConfig, resolveZoneId, request, assertOk } from '../client.js';
import {
	success,
	info,
	warn,
	error,
	bold,
	dim,
	cyan,
	green,
	red,
	yellow,
	gray,
	table,
	label,
	printJson,
	formatKey,
	formatPolicy,
	parsePolicy,
	formatDuration,
	symbols,
} from '../ui.js';

/** Shared args across key commands */
const globalArgs = {
	endpoint: {
		type: 'string' as const,
		description: 'Gateway URL ($GATEKEEPER_URL)',
	},
	'admin-key': {
		type: 'string' as const,
		description: 'Admin key ($GATEKEEPER_ADMIN_KEY)',
	},
	'zone-id': {
		type: 'string' as const,
		alias: ['z'] as string[],
		description: 'Cloudflare zone ID ($GATEKEEPER_ZONE_ID)',
	},
	json: {
		type: 'boolean' as const,
		description: 'Output raw JSON',
	},
};

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
		'expires-in-days': {
			type: 'string',
			description: 'Auto-expire after N days',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const zoneId = resolveZoneId(args);

		const body: Record<string, unknown> = {
			name: args.name,
			zone_id: zoneId,
			policy: parsePolicy(args.policy),
		};

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
		const zoneId = resolveZoneId(args);

		const statusFilter = args['active-only'] ? '&status=active' : '';
		const { status, data, durationMs } = await request(config, 'GET', `/admin/keys?zone_id=${encodeURIComponent(zoneId)}${statusFilter}`, {
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
			info(`No keys found for zone ${dim(zoneId)}`);
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
		const zoneId = resolveZoneId(args);

		const { status, data, durationMs } = await request(
			config,
			'GET',
			`/admin/keys/${encodeURIComponent(args['key-id'])}?zone_id=${encodeURIComponent(zoneId)}`,
			{ auth: 'admin', label: 'Fetching key...' },
		);

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
		force: {
			type: 'boolean',
			alias: ['f'],
			description: 'Skip confirmation prompt',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const zoneId = resolveZoneId(args);
		const keyId = args['key-id'];
		const isPermanent = !!args.permanent;
		const action = isPermanent ? 'permanently delete' : 'revoke';

		if (!args.force && process.stdin.isTTY) {
			warn(`You are about to ${action} key ${bold(keyId)}. This cannot be undone.`);
			process.stderr.write(`  Continue? [y/N] `);

			const confirmed = await new Promise<boolean>((resolve) => {
				process.stdin.setRawMode?.(true);
				process.stdin.resume();
				process.stdin.once('data', (chunk) => {
					process.stdin.setRawMode?.(false);
					process.stdin.pause();
					const char = chunk.toString().trim().toLowerCase();
					process.stderr.write(char + '\n');
					resolve(char === 'y');
				});
			});

			if (!confirmed) {
				info('Aborted.');
				return;
			}
		}

		const qs = `zone_id=${encodeURIComponent(zoneId)}${isPermanent ? '&permanent=true' : ''}`;
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
const bulkRevoke = defineCommand({
	meta: { name: 'bulk-revoke', description: 'Bulk soft-revoke multiple API keys' },
	args: {
		...globalArgs,
		ids: {
			type: 'string',
			description: 'Comma-separated list of key IDs (gw_...)',
			required: true,
		},
		confirm: {
			type: 'boolean',
			description: 'Execute the operation (without this flag, runs in dry-run mode)',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const ids = args.ids
			.split(',')
			.map((s: string) => s.trim())
			.filter(Boolean);

		if (ids.length === 0) {
			error('No key IDs provided');
			process.exit(1);
		}

		const body: Record<string, unknown> = {
			ids,
			confirm_count: ids.length,
			dry_run: !args.confirm,
		};

		const { status, data, durationMs } = await request(config, 'POST', '/admin/keys/bulk-revoke', {
			body,
			auth: 'admin',
			label: args.confirm ? 'Bulk revoking keys...' : 'Previewing bulk revoke (dry run)...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>;

		console.error('');
		if (result.dry_run) {
			warn(`Dry run — no changes made ${dim(`(${formatDuration(durationMs)})`)}`);
			console.error('');
			const items = result.items as { id: string; current_status: string; would_become: string }[];
			const rows = items.map((i) => [cyan(i.id), i.current_status, yellow(i.would_become)]);
			table(['ID', 'Current Status', 'Would Become'], rows);
			console.error('');
			info(`Re-run with ${bold('--confirm')} to execute.`);
		} else {
			success(`Bulk revoke complete ${dim(`(${formatDuration(durationMs)})`)}`);
			console.error('');
			const results = result.results as { id: string; status: string }[];
			const rows = results.map((r) => {
				const statusLabel = r.status === 'revoked' ? green(r.status) : r.status === 'not_found' ? red(r.status) : yellow(r.status);
				return [cyan(r.id), statusLabel];
			});
			table(['ID', 'Status'], rows);
		}
		console.error('');
	},
});

// --- keys bulk-delete ---
const bulkDelete = defineCommand({
	meta: { name: 'bulk-delete', description: 'Bulk permanently delete multiple API keys' },
	args: {
		...globalArgs,
		ids: {
			type: 'string',
			description: 'Comma-separated list of key IDs (gw_...)',
			required: true,
		},
		confirm: {
			type: 'boolean',
			description: 'Execute the operation (without this flag, runs in dry-run mode)',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const ids = args.ids
			.split(',')
			.map((s: string) => s.trim())
			.filter(Boolean);

		if (ids.length === 0) {
			error('No key IDs provided');
			process.exit(1);
		}

		const body: Record<string, unknown> = {
			ids,
			confirm_count: ids.length,
			dry_run: !args.confirm,
		};

		const { status, data, durationMs } = await request(config, 'POST', '/admin/keys/bulk-delete', {
			body,
			auth: 'admin',
			label: args.confirm ? 'Bulk deleting keys...' : 'Previewing bulk delete (dry run)...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>;

		console.error('');
		if (result.dry_run) {
			warn(`Dry run — no changes made ${dim(`(${formatDuration(durationMs)})`)}`);
			console.error('');
			const items = result.items as { id: string; current_status: string; would_become: string }[];
			const rows = items.map((i) => [cyan(i.id), i.current_status, yellow(i.would_become)]);
			table(['ID', 'Current Status', 'Would Become'], rows);
			console.error('');
			info(`Re-run with ${bold('--confirm')} to execute.`);
		} else {
			success(`Bulk delete complete ${dim(`(${formatDuration(durationMs)})`)}`);
			console.error('');
			const results = result.results as { id: string; status: string }[];
			const rows = results.map((r) => {
				const statusLabel = r.status === 'deleted' ? green(r.status) : red(r.status);
				return [cyan(r.id), statusLabel];
			});
			table(['ID', 'Status'], rows);
		}
		console.error('');
	},
});

// --- keys (parent) ---
export default defineCommand({
	meta: { name: 'keys', description: 'Manage API keys' },
	subCommands: { create, list, get, revoke, 'bulk-revoke': bulkRevoke, 'bulk-delete': bulkDelete },
});
