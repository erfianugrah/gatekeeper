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

// S3 analytics are not zone-scoped, so we use baseArgs (no --zone-id).

// --- s3-analytics events ---
const events = defineCommand({
	meta: {
		name: 'events',
		description: 'Query recent S3 proxy events',
	},
	args: {
		...baseArgs,
		'credential-id': {
			type: 'string',
			description: 'Filter by S3 credential (access_key_id)',
		},
		bucket: {
			type: 'string',
			description: 'Filter by bucket name',
		},
		operation: {
			type: 'string',
			description: 'Filter by S3 operation (e.g. GetObject, PutObject)',
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
		if (args['credential-id']) params.set('credential_id', args['credential-id']);
		if (args.bucket) params.set('bucket', args.bucket);
		if (args.operation) params.set('operation', args.operation);
		if (args.since) params.set('since', String(parseTime(args.since)));
		if (args.until) params.set('until', String(parseTime(args.until)));
		if (args.limit) params.set('limit', args.limit);

		const qs = params.toString();
		const path = qs ? `/admin/s3/analytics/events?${qs}` : '/admin/s3/analytics/events';
		const { status, data, durationMs } = await request(config, 'GET', path, {
			auth: 'admin',
			label: 'Fetching S3 events...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>[];

		if (result.length === 0) {
			info(`No S3 events found ${dim(`(${formatDuration(durationMs)})`)}`);
			return;
		}

		console.error('');
		info(`${bold(String(result.length))} event${result.length === 1 ? '' : 's'} ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');

		const rows = result.map((e) => {
			const statusCode = e.status as number;
			const statusColor = statusCode >= 400 ? red : statusCode >= 300 ? yellow : green;
			const ts = new Date(e.created_at as number).toISOString().slice(0, 19).replace('T', ' ');
			const credShort = (e.credential_id as string).slice(0, 16) + '...';

			return [
				ts,
				statusColor(String(statusCode)),
				cyan(e.operation as string),
				e.bucket ? String(e.bucket) : dim('-'),
				e.key ? gray(String(e.key).slice(0, 30)) : dim('-'),
				dim(String(e.duration_ms) + 'ms'),
				gray(credShort),
			];
		});

		table(['Time', 'Status', 'Operation', 'Bucket', 'Key', 'Duration', 'Credential'], rows);
		console.error('');
	},
});

// --- s3-analytics summary ---
const summary = defineCommand({
	meta: {
		name: 'summary',
		description: 'Get aggregated S3 proxy analytics summary',
	},
	args: {
		...baseArgs,
		'credential-id': {
			type: 'string',
			description: 'Filter by S3 credential (access_key_id)',
		},
		bucket: {
			type: 'string',
			description: 'Filter by bucket name',
		},
		operation: {
			type: 'string',
			description: 'Filter by S3 operation',
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
		if (args['credential-id']) params.set('credential_id', args['credential-id']);
		if (args.bucket) params.set('bucket', args.bucket);
		if (args.operation) params.set('operation', args.operation);
		if (args.since) params.set('since', String(parseTime(args.since)));
		if (args.until) params.set('until', String(parseTime(args.until)));

		const qs = params.toString();
		const path = qs ? `/admin/s3/analytics/summary?${qs}` : '/admin/s3/analytics/summary';
		const { status, data, durationMs } = await request(config, 'GET', path, {
			auth: 'admin',
			label: 'Fetching S3 summary...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const s = (data as Record<string, unknown>).result as Record<string, unknown>;

		console.error('');
		success(`S3 analytics summary ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');

		label('Total requests', bold(String(s.total_requests)));
		label('Avg duration', bold(String(s.avg_duration_ms) + 'ms'));

		// Status breakdown
		const byStatus = s.by_status as Record<string, number>;
		if (Object.keys(byStatus).length > 0) {
			console.error('');
			info('By status:');
			for (const [code, count] of Object.entries(byStatus)) {
				const color = Number(code) >= 400 ? red : Number(code) >= 300 ? yellow : green;
				console.error(`  ${symbols.bullet} ${color(bold(code))} ${dim('x')}${count}`);
			}
		}

		// Operation breakdown
		const byOp = s.by_operation as Record<string, number>;
		if (Object.keys(byOp).length > 0) {
			console.error('');
			info('By operation:');
			for (const [op, count] of Object.entries(byOp)) {
				console.error(`  ${symbols.bullet} ${cyan(op)} ${dim('x')}${count}`);
			}
		}

		// Bucket breakdown
		const byBucket = s.by_bucket as Record<string, number>;
		if (Object.keys(byBucket).length > 0) {
			console.error('');
			info('By bucket:');
			for (const [bucket, count] of Object.entries(byBucket)) {
				console.error(`  ${symbols.bullet} ${bold(bucket)} ${dim('x')}${count}`);
			}
		}

		console.error('');
	},
});

// --- s3-analytics (parent) ---
export default defineCommand({
	meta: { name: 's3-analytics', description: 'View S3 proxy analytics' },
	subCommands: { events, summary },
});
