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

// Supabase proxy analytics cover both the Management API and the metrics scrape paths.

// --- supabase-analytics events ---
const events = defineCommand({
	meta: {
		name: 'events',
		description: 'Query recent Supabase proxy events',
	},
	args: {
		...baseArgs,
		'project-ref': {
			type: 'string',
			description: 'Filter by Supabase project ref',
		},
		'key-id': {
			type: 'string',
			description: 'Filter by API key ID',
		},
		category: {
			type: 'string',
			description: 'Filter by category (database, auth, secrets, edge_functions, metrics, ...)',
		},
		action: {
			type: 'string',
			description: 'Filter by action (e.g. supabase:database:write, supabase:metrics:read)',
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
		if (args['project-ref']) params.set('project_ref', args['project-ref']);
		if (args['key-id']) params.set('key_id', args['key-id']);
		if (args.category) params.set('category', args.category);
		if (args.action) params.set('action', args.action);
		if (args.since) params.set('since', String(parseTime(args.since)));
		if (args.until) params.set('until', String(parseTime(args.until)));
		if (args.limit) params.set('limit', args.limit);

		const qs = params.toString();
		const path = qs ? `/admin/supabase/analytics/events?${qs}` : '/admin/supabase/analytics/events';
		const { status, data, durationMs } = await request(config, 'GET', path, {
			auth: 'admin',
			label: 'Fetching Supabase proxy events...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>[];

		if (result.length === 0) {
			info(`No Supabase proxy events found ${dim(`(${formatDuration(durationMs)})`)}`);
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
				e.project_ref ? cyan(e.project_ref as string) : dim('-'),
				cyan(e.category as string),
				cyan(e.action as string),
				dim(String(e.duration_ms) + 'ms'),
				gray(keyShort),
			];
		});

		table(['Time', 'Status', 'Project', 'Category', 'Action', 'Duration', 'Key'], rows);
		console.error('');
	},
});

// --- supabase-analytics summary ---
const summary = defineCommand({
	meta: {
		name: 'summary',
		description: 'Get aggregated Supabase proxy analytics summary',
	},
	args: {
		...baseArgs,
		'project-ref': {
			type: 'string',
			description: 'Filter by Supabase project ref',
		},
		'key-id': {
			type: 'string',
			description: 'Filter by API key ID',
		},
		category: {
			type: 'string',
			description: 'Filter by category (database, auth, metrics, ...)',
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
		if (args['project-ref']) params.set('project_ref', args['project-ref']);
		if (args['key-id']) params.set('key_id', args['key-id']);
		if (args.category) params.set('category', args.category);
		if (args.action) params.set('action', args.action);
		if (args.since) params.set('since', String(parseTime(args.since)));
		if (args.until) params.set('until', String(parseTime(args.until)));

		const qs = params.toString();
		const path = qs ? `/admin/supabase/analytics/summary?${qs}` : '/admin/supabase/analytics/summary';
		const { status, data, durationMs } = await request(config, 'GET', path, {
			auth: 'admin',
			label: 'Fetching Supabase proxy summary...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const s = (data as Record<string, unknown>).result as Record<string, unknown>;

		console.error('');
		success(`Supabase proxy analytics summary ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');

		label('Total requests', bold(String(s.total_requests)));
		label('Total errors', bold(String(s.total_errors)));
		label('Error rate', bold(String(s.error_rate_pct) + '%'));
		label('Unauthorized', bold(String(s.unauthorized_count)));
		label('Timeouts', bold(String(s.timeout_count)));
		label('Upstream 5xx', bold(String(s.upstream_5xx_count)));
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

		// Category breakdown
		const byCategory = (s.by_category ?? {}) as Record<string, number>;
		if (Object.keys(byCategory).length > 0) {
			console.error('');
			info('By category:');
			for (const [category, count] of Object.entries(byCategory)) {
				console.error(`  ${symbols.bullet} ${cyan(category)} ${dim('x')}${count}`);
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

// --- supabase-analytics timeseries ---
const timeseries = defineCommand({
	meta: {
		name: 'timeseries',
		description: 'Get Supabase proxy analytics timeseries buckets',
	},
	args: {
		...baseArgs,
		'project-ref': {
			type: 'string',
			description: 'Filter by Supabase project ref',
		},
		'key-id': {
			type: 'string',
			description: 'Filter by API key ID',
		},
		category: {
			type: 'string',
			description: 'Filter by category (database, auth, metrics, ...)',
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
		if (args['project-ref']) params.set('project_ref', args['project-ref']);
		if (args['key-id']) params.set('key_id', args['key-id']);
		if (args.category) params.set('category', args.category);
		if (args.action) params.set('action', args.action);
		if (args.since) params.set('since', String(parseTime(args.since)));
		if (args.until) params.set('until', String(parseTime(args.until)));

		const qs = params.toString();
		const path = qs ? `/admin/supabase/analytics/timeseries?${qs}` : '/admin/supabase/analytics/timeseries';
		const { status, data, durationMs } = await request(config, 'GET', path, {
			auth: 'admin',
			label: 'Fetching Supabase proxy timeseries...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>[];

		if (result.length === 0) {
			info(`No Supabase proxy timeseries buckets found ${dim(`(${formatDuration(durationMs)})`)}`);
			return;
		}

		console.error('');
		info(`${bold(String(result.length))} bucket${result.length === 1 ? '' : 's'} ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');

		const rows = result.map((bucket) => {
			const ts = new Date(bucket.bucket as number).toISOString().slice(0, 19).replace('T', ' ');
			const count = Number(bucket.count ?? 0);
			const errors = Number(bucket.errors ?? 0);
			return [ts, bold(String(count)), errors > 0 ? red(String(errors)) : green(String(errors))];
		});

		table(['Time', 'Count', 'Errors'], rows);
		console.error('');
	},
});

// --- supabase-analytics (parent) ---
export default defineCommand({
	meta: { name: 'supabase-analytics', description: 'View Supabase proxy analytics' },
	subCommands: { events, summary, timeseries },
});
