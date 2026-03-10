import { defineCommand } from 'citty';
import { resolveConfig, request, assertOk } from '../client.js';
import { info, bold, dim, cyan, green, red, yellow, gray, table, printJson, formatDuration, parseTime } from '../ui.js';
import { baseArgs } from '../shared-args.js';

const globalArgs = baseArgs;

/** Map action names to human-friendly colored labels. */
function formatAction(action: string): string {
	if (action.startsWith('create')) return green(action);
	if (action.startsWith('delete') || action.startsWith('bulk_delete')) return red(action);
	if (action.startsWith('revoke') || action.startsWith('bulk_revoke')) return yellow(action);
	if (action.startsWith('set_') || action.startsWith('reset_')) return cyan(action);
	return action;
}

// --- audit events ---
const events = defineCommand({
	meta: {
		name: 'events',
		description: 'Query admin audit log events',
	},
	args: {
		...globalArgs,
		action: {
			type: 'string',
			description: 'Filter by action (e.g. create_key, revoke_key, set_config)',
		},
		actor: {
			type: 'string',
			description: 'Filter by actor (email or "via admin key")',
		},
		'entity-type': {
			type: 'string',
			description: 'Filter by entity type (key, s3_credential, upstream_token, upstream_r2, config)',
		},
		'entity-id': {
			type: 'string',
			description: 'Filter by entity ID',
		},
		since: {
			type: 'string',
			description: 'Start time (ISO 8601 or unix ms)',
		},
		until: {
			type: 'string',
			description: 'End time (ISO 8601 or unix ms)',
		},
		limit: {
			type: 'string',
			description: 'Max events to return (default 100, max 1000)',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const params = new URLSearchParams();
		if (args.action) params.set('action', args.action);
		if (args.actor) params.set('actor', args.actor);
		if (args['entity-type']) params.set('entity_type', args['entity-type']);
		if (args['entity-id']) params.set('entity_id', args['entity-id']);
		if (args.since) params.set('since', String(parseTime(args.since)));
		if (args.until) params.set('until', String(parseTime(args.until)));
		if (args.limit) params.set('limit', args.limit);

		const qs = params.toString();
		const { status, data, durationMs } = await request(config, 'GET', `/admin/audit/events${qs ? `?${qs}` : ''}`, {
			auth: 'admin',
			label: 'Fetching audit events...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>[];

		if (result.length === 0) {
			info(`No audit events found ${dim(`(${formatDuration(durationMs)})`)}`);
			return;
		}

		console.error('');
		info(`${bold(String(result.length))} audit event${result.length === 1 ? '' : 's'} ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');

		const rows = result.map((e) => {
			const ts = new Date(e.created_at as number).toISOString().slice(0, 19).replace('T', ' ');
			const entityId = e.entity_id ? gray(String(e.entity_id).slice(0, 20)) : dim('-');

			return [ts, formatAction(e.action as string), e.entity_type as string, entityId, cyan(e.actor as string)];
		});

		table(['Time', 'Action', 'Entity', 'ID', 'Actor'], rows);
		console.error('');
	},
});

// --- audit (parent) ---
export default defineCommand({
	meta: { name: 'audit', description: 'View admin audit log' },
	subCommands: { events },
});
