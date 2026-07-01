import { defineCommand } from 'citty';
import { resolveConfig, request, assertOk } from '../client.js';
import { success, info, warn, error, bold, dim, cyan, table, label, printJson, formatDuration, confirmAction } from '../ui.js';
import { baseArgs, forceArg } from '../shared-args.js';

const globalArgs = baseArgs;

const VALID_ROLES = ['admin', 'operator', 'viewer'];

// --- admin-tokens create ---
const create = defineCommand({
	meta: {
		name: 'create',
		description: 'Mint a named, revocable admin API token (gka_...). The value is shown once.',
	},
	args: {
		...globalArgs,
		name: {
			type: 'string',
			description: 'Human-readable name for this token',
			required: true,
		},
		role: {
			type: 'string',
			description: 'Role: admin | operator | viewer (default: admin)',
			default: 'admin',
		},
		'expires-in-days': {
			type: 'string',
			description: 'Token expires in N days from now (optional; omit for never)',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const role = args.role ?? 'admin';
		if (!VALID_ROLES.includes(role)) {
			error(`--role must be one of: ${VALID_ROLES.join(', ')}`);
			process.exit(1);
		}

		const body: Record<string, unknown> = { name: args.name, role };
		if (args['expires-in-days']) {
			const days = Number(args['expires-in-days']);
			if (!Number.isFinite(days) || days <= 0) {
				error('--expires-in-days must be a positive number.');
				process.exit(1);
			}
			body.expires_in_days = days;
		}

		const { status, data, durationMs } = await request(config, 'POST', '/admin/tokens', {
			auth: 'admin',
			body,
			label: 'Creating admin token...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>;

		console.error('');
		success(`Admin token created ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');
		label('ID', bold(result.id as string));
		label('Name', result.name as string);
		label('Role', result.role as string);
		label('Expires', result.expires_at ? new Date(result.expires_at as number).toISOString() : dim('never'));
		console.error('');
		warn('Copy this token now. It will not be shown again:');
		console.error('');
		console.log(result.token as string);
		console.error('');
		info(`Use it as ${bold('GATEKEEPER_ADMIN_KEY')} or an ${bold('Authorization: Bearer')} header.`);
		console.error('');
	},
});

// --- admin-tokens list ---
const list = defineCommand({
	meta: { name: 'list', description: 'List all admin API tokens (metadata only)' },
	args: {
		...globalArgs,
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const { status, data, durationMs } = await request(config, 'GET', '/admin/tokens', {
			auth: 'admin',
			label: 'Fetching admin tokens...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>[];

		if (result.length === 0) {
			info('No admin tokens found.');
			return;
		}

		console.error('');
		info(`${bold(String(result.length))} token${result.length === 1 ? '' : 's'} found ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');

		const rows = result.map((t) => {
			const created = new Date(t.created_at as number).toISOString().slice(0, 10);
			const expires = t.expires_at ? new Date(t.expires_at as number).toISOString().slice(0, 10) : 'never';
			const lastUsed = t.last_used_at ? new Date(t.last_used_at as number).toISOString().slice(0, 10) : 'never';
			const statusStr = t.revoked ? 'revoked' : 'active';
			return [cyan(t.id as string), t.name as string, t.role as string, statusStr, created, expires, lastUsed];
		});

		table(['ID', 'Name', 'Role', 'Status', 'Created', 'Expires', 'Last used'], rows);
		console.error('');
	},
});

// --- admin-tokens revoke ---
const revoke = defineCommand({
	meta: { name: 'revoke', description: 'Revoke an admin API token by id' },
	args: {
		...globalArgs,
		...forceArg,
		id: {
			type: 'positional',
			description: 'Token id (atk_...)',
			required: true,
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);

		if (!args.force) {
			const ok = await confirmAction(`Revoke admin token ${bold(args.id)}? Any client using it will lose access.`);
			if (!ok) {
				info('Aborted.');
				return;
			}
		}

		const { status, data, durationMs } = await request(config, 'DELETE', `/admin/tokens/${encodeURIComponent(args.id)}`, {
			auth: 'admin',
			label: 'Revoking admin token...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		success(`Admin token ${bold(args.id)} revoked ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');
	},
});

// --- admin-tokens (parent) ---
export default defineCommand({
	meta: { name: 'admin-tokens', description: 'Manage admin API tokens for the /admin management plane' },
	subCommands: { create, list, revoke },
});
