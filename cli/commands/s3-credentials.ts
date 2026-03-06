import { defineCommand } from 'citty';
import { resolveConfig, request, assertOk } from '../client.js';
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
	table,
	label,
	printJson,
	formatPolicy,
	parsePolicy,
	formatDuration,
	symbols,
} from '../ui.js';

/** Shared args across s3-credentials commands — no zone-id needed. */
const globalArgs = {
	endpoint: {
		type: 'string' as const,
		description: 'Gateway URL ($GATEKEEPER_URL)',
	},
	'admin-key': {
		type: 'string' as const,
		description: 'Admin key ($GATEKEEPER_ADMIN_KEY)',
	},
	json: {
		type: 'boolean' as const,
		description: 'Output raw JSON',
	},
};

// --- s3-credentials create ---
const create = defineCommand({
	meta: {
		name: 'create',
		description: 'Create a new S3 credential with a policy document',
	},
	args: {
		...globalArgs,
		name: {
			type: 'string',
			description: 'Human-readable credential name',
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

		const body: Record<string, unknown> = {
			name: args.name,
			policy: parsePolicy(args.policy),
		};

		if (args['expires-in-days']) {
			body['expires_in_days'] = Number(args['expires-in-days']);
		}

		const { status, data, durationMs } = await request(config, 'POST', '/admin/s3/credentials', {
			body,
			auth: 'admin',
			label: 'Creating S3 credential...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>;
		const cred = result.credential as Record<string, unknown>;

		console.error('');
		success(`S3 credential created ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');
		formatS3Credential(cred);
		console.error('');
		console.error(`  ${yellow(bold('Access Key ID:'))}     ${bold(cred.access_key_id as string)}`);
		console.error(`  ${yellow(bold('Secret Access Key:'))} ${bold(cred.secret_access_key as string)}`);
		console.error('');
		warn('Save these credentials now — the secret will not be shown again.');
		console.error('');
		if (cred.policy) {
			info('Policy:');
			formatPolicy(typeof cred.policy === 'string' ? cred.policy : JSON.stringify(cred.policy));
		}
		console.error('');
	},
});

// --- s3-credentials list ---
const list = defineCommand({
	meta: { name: 'list', description: 'List all S3 credentials' },
	args: {
		...globalArgs,
		'active-only': {
			type: 'boolean',
			description: 'Only show active (non-revoked) credentials',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const statusFilter = args['active-only'] ? '?status=active' : '';
		const { status, data, durationMs } = await request(config, 'GET', `/admin/s3/credentials${statusFilter}`, {
			auth: 'admin',
			label: 'Fetching S3 credentials...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>[];

		if (result.length === 0) {
			info('No S3 credentials found.');
			return;
		}

		console.error('');
		info(`${bold(String(result.length))} credential${result.length === 1 ? '' : 's'} found ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');

		const rows = result.map((c) => {
			const statusLabel =
				(c.revoked as number) === 1
					? red('revoked')
					: c.expires_at && (c.expires_at as number) < Date.now()
						? red('expired')
						: green('active');

			const created = new Date(c.created_at as number).toISOString().slice(0, 19).replace('T', ' ');

			return [cyan(c.access_key_id as string), c.name as string, statusLabel, created];
		});

		table(['Access Key ID', 'Name', 'Status', 'Created'], rows);
		console.error('');
	},
});

// --- s3-credentials get ---
const get = defineCommand({
	meta: { name: 'get', description: 'Get details of an S3 credential' },
	args: {
		...globalArgs,
		'access-key-id': {
			type: 'string',
			description: 'The access key ID (GK...)',
			required: true,
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const { status, data, durationMs } = await request(
			config,
			'GET',
			`/admin/s3/credentials/${encodeURIComponent(args['access-key-id'])}`,
			{ auth: 'admin', label: 'Fetching S3 credential...' },
		);

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>;
		const cred = result.credential as Record<string, unknown>;

		console.error('');
		formatS3Credential(cred);
		console.error('');
		if (cred.policy) {
			info('Policy:');
			formatPolicy(typeof cred.policy === 'string' ? cred.policy : JSON.stringify(cred.policy));
		}
		console.error('');
	},
});

// --- s3-credentials revoke ---
const revoke = defineCommand({
	meta: { name: 'revoke', description: 'Revoke or permanently delete an S3 credential' },
	args: {
		...globalArgs,
		'access-key-id': {
			type: 'string',
			description: 'The access key ID to revoke (GK...)',
			required: true,
		},
		permanent: {
			type: 'boolean',
			description: 'Permanently delete the credential row instead of soft-revoking',
		},
		force: {
			type: 'boolean',
			alias: ['f'],
			description: 'Skip confirmation prompt',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const accessKeyId = args['access-key-id'];
		const isPermanent = !!args.permanent;
		const action = isPermanent ? 'permanently delete' : 'revoke';

		if (!args.force && process.stdin.isTTY) {
			warn(`You are about to ${action} S3 credential ${bold(accessKeyId)}. This cannot be undone.`);
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

		const qs = isPermanent ? '?permanent=true' : '';
		const { status, data, durationMs } = await request(config, 'DELETE', `/admin/s3/credentials/${encodeURIComponent(accessKeyId)}${qs}`, {
			auth: 'admin',
			label: isPermanent ? 'Deleting S3 credential...' : 'Revoking S3 credential...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		console.error('');
		if (isPermanent) {
			success(`S3 credential ${bold(accessKeyId)} permanently deleted ${dim(`(${formatDuration(durationMs)})`)}`);
		} else {
			success(`S3 credential ${bold(accessKeyId)} revoked ${dim(`(${formatDuration(durationMs)})`)}`);
		}
		console.error('');
	},
});

// --- Formatting helper ---

function formatS3Credential(cred: Record<string, unknown>): void {
	const status =
		(cred.revoked as number) === 1
			? red('revoked')
			: cred.expires_at && (cred.expires_at as number) < Date.now()
				? red('expired')
				: green('active');

	label('Access Key ID', bold(cred.access_key_id as string));
	label('Name', cred.name as string);
	label('Status', status);
	label('Created', new Date(cred.created_at as number).toISOString());
	if (cred.expires_at) {
		label('Expires', new Date(cred.expires_at as number).toISOString());
	}
	if (cred.created_by) {
		label('Created by', cred.created_by as string);
	}
}

// --- s3-credentials bulk-revoke ---
const bulkRevoke = defineCommand({
	meta: { name: 'bulk-revoke', description: 'Bulk soft-revoke multiple S3 credentials' },
	args: {
		...globalArgs,
		ids: {
			type: 'string',
			description: 'Comma-separated list of access key IDs (GK...)',
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
			error('No access key IDs provided');
			process.exit(1);
		}

		const body: Record<string, unknown> = {
			access_key_ids: ids,
			confirm_count: ids.length,
			dry_run: !args.confirm,
		};

		const { status, data, durationMs } = await request(config, 'POST', '/admin/s3/credentials/bulk-revoke', {
			body,
			auth: 'admin',
			label: args.confirm ? 'Bulk revoking credentials...' : 'Previewing bulk revoke (dry run)...',
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

// --- s3-credentials bulk-delete ---
const bulkDelete = defineCommand({
	meta: { name: 'bulk-delete', description: 'Bulk permanently delete multiple S3 credentials' },
	args: {
		...globalArgs,
		ids: {
			type: 'string',
			description: 'Comma-separated list of access key IDs (GK...)',
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
			error('No access key IDs provided');
			process.exit(1);
		}

		const body: Record<string, unknown> = {
			access_key_ids: ids,
			confirm_count: ids.length,
			dry_run: !args.confirm,
		};

		const { status, data, durationMs } = await request(config, 'POST', '/admin/s3/credentials/bulk-delete', {
			body,
			auth: 'admin',
			label: args.confirm ? 'Bulk deleting credentials...' : 'Previewing bulk delete (dry run)...',
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

// --- s3-credentials (parent) ---
export default defineCommand({
	meta: { name: 's3-credentials', description: 'Manage S3 proxy credentials' },
	subCommands: { create, list, get, revoke, 'bulk-revoke': bulkRevoke, 'bulk-delete': bulkDelete },
});
