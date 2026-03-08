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

// DNS analytics are zone-scoped but zone_id is an optional filter (not required).

// --- dns-analytics events ---
const events = defineCommand({
	meta: {
		name: 'events',
		description: 'Query recent DNS proxy events',
	},
	args: {
		...baseArgs,
		'zone-id': {
			type: 'string',
			description: 'Filter by zone ID',
		},
		'key-id': {
			type: 'string',
			description: 'Filter by API key ID',
		},
		action: {
			type: 'string',
			description: 'Filter by DNS action (e.g. dns:create, dns:read, dns:update, dns:delete)',
		},
		'record-type': {
			type: 'string',
			description: 'Filter by DNS record type (e.g. A, AAAA, CNAME, TXT)',
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
		if (args['zone-id']) params.set('zone_id', args['zone-id']);
		if (args['key-id']) params.set('key_id', args['key-id']);
		if (args.action) params.set('action', args.action);
		if (args['record-type']) params.set('record_type', args['record-type']);
		if (args.since) params.set('since', String(parseTime(args.since)));
		if (args.until) params.set('until', String(parseTime(args.until)));
		if (args.limit) params.set('limit', args.limit);

		const qs = params.toString();
		const path = qs ? `/admin/dns/analytics/events?${qs}` : '/admin/dns/analytics/events';
		const { status, data, durationMs } = await request(config, 'GET', path, {
			auth: 'admin',
			label: 'Fetching DNS events...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>[];

		if (result.length === 0) {
			info(`No DNS events found ${dim(`(${formatDuration(durationMs)})`)}`);
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
				cyan(e.action as string),
				e.record_type ? String(e.record_type) : dim('-'),
				e.record_name ? gray(String(e.record_name).slice(0, 40)) : dim('-'),
				dim(String(e.duration_ms) + 'ms'),
				gray(keyShort),
			];
		});

		table(['Time', 'Status', 'Action', 'Type', 'Name', 'Duration', 'Key'], rows);
		console.error('');
	},
});

// --- dns-analytics summary ---
const summary = defineCommand({
	meta: {
		name: 'summary',
		description: 'Get aggregated DNS proxy analytics summary',
	},
	args: {
		...baseArgs,
		'zone-id': {
			type: 'string',
			description: 'Filter by zone ID',
		},
		'key-id': {
			type: 'string',
			description: 'Filter by API key ID',
		},
		action: {
			type: 'string',
			description: 'Filter by DNS action',
		},
		'record-type': {
			type: 'string',
			description: 'Filter by DNS record type',
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
		if (args['zone-id']) params.set('zone_id', args['zone-id']);
		if (args['key-id']) params.set('key_id', args['key-id']);
		if (args.action) params.set('action', args.action);
		if (args['record-type']) params.set('record_type', args['record-type']);
		if (args.since) params.set('since', String(parseTime(args.since)));
		if (args.until) params.set('until', String(parseTime(args.until)));

		const qs = params.toString();
		const path = qs ? `/admin/dns/analytics/summary?${qs}` : '/admin/dns/analytics/summary';
		const { status, data, durationMs } = await request(config, 'GET', path, {
			auth: 'admin',
			label: 'Fetching DNS summary...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const s = (data as Record<string, unknown>).result as Record<string, unknown>;

		console.error('');
		success(`DNS analytics summary ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');

		label('Total requests', bold(String(s.total_requests)));
		label('Avg duration', bold(String(s.avg_duration_ms) + 'ms'));

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

		// Action breakdown
		const byAction = (s.by_action ?? {}) as Record<string, number>;
		if (Object.keys(byAction).length > 0) {
			console.error('');
			info('By action:');
			for (const [action, count] of Object.entries(byAction)) {
				console.error(`  ${symbols.bullet} ${cyan(action)} ${dim('x')}${count}`);
			}
		}

		// Record type breakdown
		const byType = (s.by_record_type ?? {}) as Record<string, number>;
		if (Object.keys(byType).length > 0) {
			console.error('');
			info('By record type:');
			for (const [type, count] of Object.entries(byType)) {
				console.error(`  ${symbols.bullet} ${bold(type)} ${dim('x')}${count}`);
			}
		}

		console.error('');
	},
});

// --- dns-analytics (parent) ---
export default defineCommand({
	meta: { name: 'dns-analytics', description: 'View DNS proxy analytics' },
	subCommands: { events, summary },
});
