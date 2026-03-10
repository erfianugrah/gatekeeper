import { defineCommand } from 'citty';
import { resolveConfig, request, assertOk } from '../client.js';
import { success, info, warn, error, bold, dim, cyan, table, label, printJson, formatDuration, confirmAction } from '../ui.js';
import { baseArgs, forceArg } from '../shared-args.js';
import { makeBulkSubcommand } from '../bulk-helpers.js';

const globalArgs = baseArgs;

// --- upstream-r2 create ---
const create = defineCommand({
	meta: {
		name: 'create',
		description: 'Register an R2 endpoint with credentials for S3 proxy forwarding',
	},
	args: {
		...globalArgs,
		name: {
			type: 'string',
			description: 'Human-readable name for this R2 endpoint',
			required: true,
		},
		'access-key-id': {
			type: 'string',
			description: 'R2 access key ID',
			required: true,
		},
		'secret-access-key': {
			type: 'string',
			description: 'R2 secret access key ($UPSTREAM_R2_SECRET_ACCESS_KEY). Prefer env var to avoid shell history exposure',
		},
		'r2-endpoint': {
			type: 'string',
			description: 'R2 endpoint URL (e.g. https://<account>.r2.cloudflarestorage.com)',
			required: true,
		},
		'bucket-names': {
			type: 'string',
			description: 'Comma-separated bucket names this endpoint covers, or "*" for all',
			required: true,
		},
		'expires-in-days': {
			type: 'string',
			description: 'Endpoint expires in N days from now (optional)',
		},
		validate: {
			type: 'boolean',
			description: 'Validate credentials against R2 endpoint on creation',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const secretAccessKey = args['secret-access-key'] || process.env['UPSTREAM_R2_SECRET_ACCESS_KEY'];
		if (!secretAccessKey) {
			error('Secret access key required. Set --secret-access-key or UPSTREAM_R2_SECRET_ACCESS_KEY env var.');
			process.exit(1);
		}

		const bucketNames = args['bucket-names'] === '*' ? ['*'] : args['bucket-names'].split(',').map((s) => s.trim());

		const body: Record<string, unknown> = {
			name: args.name,
			access_key_id: args['access-key-id'],
			secret_access_key: secretAccessKey,
			endpoint: args['r2-endpoint'],
			bucket_names: bucketNames,
		};

		if (args['expires-in-days']) {
			const days = Number(args['expires-in-days']);
			if (!Number.isFinite(days) || days <= 0) {
				error('--expires-in-days must be a positive number.');
				process.exit(1);
			}
			body.expires_in_days = days;
		}

		if (args.validate) {
			body.validate = true;
		}

		const { status, data, durationMs } = await request(config, 'POST', '/admin/upstream-r2', {
			body,
			auth: 'admin',
			label: 'Registering R2 endpoint...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>;

		console.error('');
		success(`R2 endpoint registered ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');
		formatUpstreamR2(result);
		console.error('');

		const warnings = result.warnings as string[] | undefined;
		if (warnings && warnings.length > 0) {
			for (const w of warnings) {
				warn(w);
			}
			console.error('');
		}

		warn('The secret access key is stored write-only and cannot be retrieved again.');
		console.error('');
	},
});

// --- upstream-r2 list ---
const list = defineCommand({
	meta: { name: 'list', description: 'List all registered R2 endpoints' },
	args: {
		...globalArgs,
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const { status, data, durationMs } = await request(config, 'GET', '/admin/upstream-r2', {
			auth: 'admin',
			label: 'Fetching R2 endpoints...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>[];

		if (result.length === 0) {
			info('No R2 endpoints found.');
			return;
		}

		console.error('');
		info(`${bold(String(result.length))} endpoint${result.length === 1 ? '' : 's'} found ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');

		const rows = result.map((ep) => {
			const created = new Date(ep.created_at as number).toISOString().slice(0, 19).replace('T', ' ');
			const buckets = ep.bucket_names as string;

			return [cyan(ep.id as string), ep.name as string, buckets, created];
		});

		table(['ID', 'Name', 'Buckets', 'Created'], rows);
		console.error('');
	},
});

// --- upstream-r2 get ---
const get = defineCommand({
	meta: { name: 'get', description: 'Get details of an R2 endpoint' },
	args: {
		...globalArgs,
		id: {
			type: 'string',
			description: 'The R2 endpoint ID (upr2_...)',
			required: true,
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const { status, data, durationMs } = await request(config, 'GET', `/admin/upstream-r2/${encodeURIComponent(args.id)}`, {
			auth: 'admin',
			label: 'Fetching R2 endpoint...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>;

		console.error('');
		formatUpstreamR2(result);
		console.error('');
	},
});

// --- upstream-r2 update ---
const update = defineCommand({
	meta: { name: 'update', description: 'Update an R2 endpoint (name, expiry)' },
	args: {
		...globalArgs,
		id: {
			type: 'string',
			description: 'The R2 endpoint ID (upr2_...)',
			required: true,
		},
		name: {
			type: 'string',
			description: 'New name for the endpoint',
		},
		'expires-at': {
			type: 'string',
			description: 'New expiry (ISO 8601 or unix ms). Set to "none" to remove expiry',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const body: Record<string, unknown> = {};

		if (args.name) body.name = args.name;

		if (args['expires-at'] !== undefined) {
			if (args['expires-at'] === 'none') {
				body.expires_at = null;
			} else {
				const ts = Number(args['expires-at']) || new Date(args['expires-at']).getTime();
				if (!Number.isFinite(ts) || ts <= 0) {
					error('--expires-at must be a valid ISO 8601 date, unix timestamp, or "none".');
					process.exit(1);
				}
				body.expires_at = ts;
			}
		}

		if (Object.keys(body).length === 0) {
			error('At least one field must be provided (--name, --expires-at).');
			process.exit(1);
		}

		const { status, data, durationMs } = await request(config, 'PATCH', `/admin/upstream-r2/${encodeURIComponent(args.id)}`, {
			body,
			auth: 'admin',
			label: 'Updating R2 endpoint...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>;

		console.error('');
		success(`R2 endpoint updated ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');
		formatUpstreamR2(result);
		console.error('');
	},
});

// --- upstream-r2 delete ---
const del = defineCommand({
	meta: { name: 'delete', description: 'Delete an R2 endpoint registration (permanent, irreversible)' },
	args: {
		...globalArgs,
		id: {
			type: 'string',
			description: 'The R2 endpoint ID to delete (upr2_...)',
			required: true,
		},
		...forceArg,
	},
	async run({ args }) {
		const config = resolveConfig(args);
		const endpointId = args.id;

		if (!args.force) {
			const confirmed = await confirmAction(`You are about to delete R2 endpoint ${bold(endpointId)}. This cannot be undone.`);
			if (!confirmed) {
				info('Aborted.');
				return;
			}
		}

		const { status, data, durationMs } = await request(config, 'DELETE', `/admin/upstream-r2/${encodeURIComponent(endpointId)}`, {
			auth: 'admin',
			label: 'Deleting R2 endpoint...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		console.error('');
		success(`R2 endpoint ${bold(endpointId)} deleted ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');
	},
});

// --- upstream-r2 bulk-delete ---
const bulkDelete = makeBulkSubcommand({
	entityName: 'endpoints',
	apiPath: '/admin/upstream-r2/bulk-delete',
	idField: 'ids',
	action: 'delete',
	displayField: 'endpoint IDs (upr2_...)',
});

// --- Formatting helper ---

function formatUpstreamR2(ep: Record<string, unknown>): void {
	label('ID', bold(ep.id as string));
	label('Name', ep.name as string);
	label('Access key preview', dim(ep.access_key_preview as string));
	label('Endpoint', ep.endpoint as string);
	label('Bucket names', ep.bucket_names as string);
	label('Created', new Date(ep.created_at as number).toISOString());
	if (ep.expires_at) {
		const exp = new Date(ep.expires_at as number);
		const isExpired = exp.getTime() <= Date.now();
		label('Expires', isExpired ? bold(`${exp.toISOString()} (EXPIRED)`) : exp.toISOString());
	} else {
		label('Expires', dim('never'));
	}
	if (ep.created_by) {
		label('Created by', ep.created_by as string);
	}
}

// --- upstream-r2 (parent) ---
export default defineCommand({
	meta: { name: 'upstream-r2', description: 'Manage upstream R2 endpoints for S3 proxy' },
	subCommands: { create, list, get, update, delete: del, 'bulk-delete': bulkDelete },
});
