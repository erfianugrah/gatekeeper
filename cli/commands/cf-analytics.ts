import { defineCommand } from 'citty';
import { resolveConfig, request, assertOk } from '../client.js';
import {
	success,
	info,
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
	formatDuration,
	symbols,
	parseTime,
} from '../ui.js';
import { baseArgs } from '../shared-args.js';

// CF proxy analytics are account-scoped.

// --- cf-analytics events ---
const events = defineCommand({
	meta: {
		name: 'events',
		description: 'Query recent CF API proxy events',
	},
	args: {
		...baseArgs,
		'account-id': {
			type: 'string',
			description: 'Filter by account ID',
		},
		'key-id': {
			type: 'string',
			description: 'Filter by API key ID',
		},
		service: {
			type: 'string',
			description: 'Filter by service (d1, kv, workers, queues, vectorize, hyperdrive)',
		},
		action: {
			type: 'string',
			description: 'Filter by action (e.g. d1:query, kv:write, workers:deploy)',
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
		if (args['account-id']) params.set('account_id', args['account-id']);
		if (args['key-id']) params.set('key_id', args['key-id']);
		if (args.service) params.set('service', args.service);
		if (args.action) params.set('action', args.action);
		if (args.since) params.set('since', String(parseTime(args.since)));
		if (args.until) params.set('until', String(parseTime(args.until)));
		if (args.limit) params.set('limit', args.limit);

		const qs = params.toString();
		const path = qs ? `/admin/cf/analytics/events?${qs}` : '/admin/cf/analytics/events';
		const { status, data, durationMs } = await request(config, 'GET', path, {
			auth: 'admin',
			label: 'Fetching CF proxy events...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>[];

		if (result.length === 0) {
			info(`No CF proxy events found ${dim(`(${formatDuration(durationMs)})`)}`);
			return;
		}

		console.error('');
		info(`${bold(String(result.length))} event${result.length === 1 ? '' : 's'} ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');

		const rows = result.map((e) => {
			const statusCode = e.status as number;
			const statusColor = statusCode >= 400 ? red : statusCode >= 300 ? yellow : green;
			const ts = new Date(e.created_at as number).toISOString().slice(0, 19).replace('T', ' ');
			const keyShort = (e.key_id as string).slice(0, 12) + '...';

			return [
				ts,
				statusColor(String(statusCode)),
				cyan(e.service as string),
				cyan(e.action as string),
				e.resource_id ? gray(String(e.resource_id).slice(0, 24)) : dim('-'),
				dim(String(e.duration_ms) + 'ms'),
				gray(keyShort),
			];
		});

		table(['Time', 'Status', 'Service', 'Action', 'Resource', 'Duration', 'Key'], rows);
		console.error('');
	},
});

// --- cf-analytics summary ---
const summary = defineCommand({
	meta: {
		name: 'summary',
		description: 'Get aggregated CF API proxy analytics summary',
	},
	args: {
		...baseArgs,
		'account-id': {
			type: 'string',
			description: 'Filter by account ID',
		},
		'key-id': {
			type: 'string',
			description: 'Filter by API key ID',
		},
		service: {
			type: 'string',
			description: 'Filter by service (d1, kv, workers, queues, vectorize, hyperdrive)',
		},
		action: {
			type: 'string',
			description: 'Filter by action',
		},
		since: {
			type: 'string',
			description: 'Start time (ISO 8601 or unix ms)',
		},
		until: {
			type: 'string',
			description: 'End time (ISO 8601 or unix ms)',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const params = new URLSearchParams();
		if (args['account-id']) params.set('account_id', args['account-id']);
		if (args['key-id']) params.set('key_id', args['key-id']);
		if (args.service) params.set('service', args.service);
		if (args.action) params.set('action', args.action);
		if (args.since) params.set('since', String(parseTime(args.since)));
		if (args.until) params.set('until', String(parseTime(args.until)));

		const qs = params.toString();
		const path = qs ? `/admin/cf/analytics/summary?${qs}` : '/admin/cf/analytics/summary';
		const { status, data, durationMs } = await request(config, 'GET', path, {
			auth: 'admin',
			label: 'Fetching CF proxy summary...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const s = (data as Record<string, unknown>).result as Record<string, unknown>;

		console.error('');
		success(`CF proxy analytics summary ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');

		label('Total requests', bold(String(s.total_requests)));
		label('Avg duration', bold(String(s.avg_duration_ms) + 'ms'));
		label('Avg upstream latency', bold(String(s.avg_upstream_latency_ms) + 'ms'));
		label('Avg response size', bold(String(s.avg_response_size) + ' bytes'));

		// Status breakdown
		const byStatus = (s.by_status ?? {}) as Record<string, number>;
		if (Object.keys(byStatus).length > 0) {
			console.error('');
			info('By status:');
			for (const [code, count] of Object.entries(byStatus)) {
				const color = Number(code) >= 400 ? red : Number(code) >= 300 ? yellow : green;
				console.error(`  ${symbols.bullet} ${color(bold(code))} ${dim('x')}${count}`);
			}
		}

		// Service breakdown
		const byService = (s.by_service ?? {}) as Record<string, number>;
		if (Object.keys(byService).length > 0) {
			console.error('');
			info('By service:');
			for (const [service, count] of Object.entries(byService)) {
				console.error(`  ${symbols.bullet} ${cyan(service)} ${dim('x')}${count}`);
			}
		}

		// Action breakdown
		const byAction = (s.by_action ?? {}) as Record<string, number>;
		if (Object.keys(byAction).length > 0) {
			console.error('');
			info('By action:');
			for (const [action, count] of Object.entries(byAction)) {
				console.error(`  ${symbols.bullet} ${cyan(action)} ${dim('x')}${count}`);
			}
		}

		console.error('');
	},
});

// --- cf-analytics (parent) ---
export default defineCommand({
	meta: { name: 'cf-analytics', description: 'View CF API proxy analytics' },
	subCommands: { events, summary },
});
