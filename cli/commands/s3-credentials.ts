import { defineCommand } from 'citty';
import { resolveConfig, request, assertOk } from '../client.js';
import {
	success,
	info,
	warn,
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
	confirmAction,
} from '../ui.js';
import { baseArgs, forceArg } from '../shared-args.js';
import { makeBulkSubcommand } from '../bulk-helpers.js';
import { buildS3Policy } from '../policy-wizard.js';

const globalArgs = baseArgs;

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
		'upstream-token-id': {
			type: 'string',
			description: 'Upstream R2 endpoint ID to bind this credential to (upr2_...)',
			required: true,
		},
		policy: {
			type: 'string',
			description: 'Policy document as JSON string or @path/to/file.json (omit for interactive builder)',
		},
		'expires-in-days': {
			type: 'string',
			description: 'Auto-expire after N days',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);

		// Resolve policy: from --policy flag or interactive builder
		let policy: unknown;
		if (args.policy) {
			policy = parsePolicy(args.policy);
		} else {
			policy = await buildS3Policy();
		}

		const body: Record<string, unknown> = {
			name: args.name,
			upstream_token_id: args['upstream-token-id'],
			policy,
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

// --- s3-credentials rotate ---
const rotate = defineCommand({
	meta: { name: 'rotate', description: 'Rotate an S3 credential (create new + revoke old)' },
	args: {
		...globalArgs,
		'access-key-id': {
			type: 'string',
			description: 'The access key ID to rotate (GK...)',
			required: true,
		},
		name: {
			type: 'string',
			description: 'Name for the new credential (defaults to "<old name> (rotated)")',
		},
		'expires-in-days': {
			type: 'string',
			description: 'Expiry for the new credential in days',
		},
		...forceArg,
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const accessKeyId = args['access-key-id'];

		if (!args.force) {
			const confirmed = await confirmAction(
				`You are about to rotate S3 credential ${bold(accessKeyId)}. The old credential will be revoked immediately.`,
			);
			if (!confirmed) {
				info('Aborted.');
				return;
			}
		}

		const body: Record<string, unknown> = {};
		if (args.name) body.name = args.name;
		if (args['expires-in-days']) body.expires_in_days = Number(args['expires-in-days']);

		const { status, data, durationMs } = await request(config, 'POST', `/admin/s3/credentials/${encodeURIComponent(accessKeyId)}/rotate`, {
			body,
			auth: 'admin',
			label: 'Rotating S3 credential...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>;
		const oldCred = result.old_credential as Record<string, unknown>;
		const newCred = result.new_credential as Record<string, unknown>;

		console.error('');
		success(`S3 credential rotated ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');
		info('Old credential (now revoked):');
		label('  Access Key ID', red(oldCred.access_key_id as string));
		label('  Name', oldCred.name as string);
		console.error('');
		info('New credential:');
		formatS3Credential(newCred);
		console.error('');
		console.error(`  ${yellow(bold('Access Key ID:'))}     ${bold(newCred.access_key_id as string)}`);
		console.error(`  ${yellow(bold('Secret Access Key:'))} ${bold(newCred.secret_access_key as string)}`);
		console.error('');
		warn('Save these credentials now — the secret will not be shown again.');
		console.error('');
	},
});

// --- s3-credentials update ---
const update = defineCommand({
	meta: { name: 'update', description: 'Update mutable fields on an S3 credential (name, expiry)' },
	args: {
		...globalArgs,
		'access-key-id': {
			type: 'string',
			description: 'The access key ID to update (GK...)',
			required: true,
		},
		name: {
			type: 'string',
			description: 'New name for the credential',
		},
		'expires-at': {
			type: 'string',
			description: 'New expiry timestamp (ISO 8601 or unix ms). Use "null" to remove expiry.',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const accessKeyId = args['access-key-id'];

		const body: Record<string, unknown> = {};
		if (args.name) body.name = args.name;
		if (args['expires-at'] !== undefined) {
			body.expires_at = args['expires-at'] === 'null' ? null : Number(args['expires-at']);
		}

		if (Object.keys(body).length === 0) {
			info('No fields to update. Provide at least one of: --name, --expires-at');
			return;
		}

		const { status, data, durationMs } = await request(config, 'PATCH', `/admin/s3/credentials/${encodeURIComponent(accessKeyId)}`, {
			body,
			auth: 'admin',
			label: 'Updating S3 credential...',
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
		success(`S3 credential updated ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');
		formatS3Credential(cred);
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
		...forceArg,
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const accessKeyId = args['access-key-id'];
		const isPermanent = !!args.permanent;
		const action = isPermanent ? 'permanently delete' : 'revoke';

		if (!args.force) {
			const confirmed = await confirmAction(`You are about to ${action} S3 credential ${bold(accessKeyId)}. This cannot be undone.`);
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
	if (cred.upstream_token_id) {
		label('Upstream R2', cred.upstream_token_id as string);
	}
	label('Created', new Date(cred.created_at as number).toISOString());
	if (cred.expires_at) {
		label('Expires', new Date(cred.expires_at as number).toISOString());
	}
	if (cred.created_by) {
		label('Created by', cred.created_by as string);
	}
}

// --- s3-credentials bulk-revoke ---
const bulkRevoke = makeBulkSubcommand({
	entityName: 'credentials',
	apiPath: '/admin/s3/credentials/bulk-revoke',
	idField: 'access_key_ids',
	action: 'revoke',
	displayField: 'access key IDs (GK...)',
});

// --- s3-credentials bulk-delete ---
const bulkDelete = makeBulkSubcommand({
	entityName: 'credentials',
	apiPath: '/admin/s3/credentials/bulk-delete',
	idField: 'access_key_ids',
	action: 'delete',
	displayField: 'access key IDs (GK...)',
});

// --- s3-credentials (parent) ---
export default defineCommand({
	meta: { name: 's3-credentials', description: 'Manage S3 proxy credentials' },
	subCommands: { create, list, get, rotate, update, revoke, 'bulk-revoke': bulkRevoke, 'bulk-delete': bulkDelete },
});
