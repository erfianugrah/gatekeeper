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

// Supabase membership audit covers the invitations surface (plan Task 5):
// dry-run previews, per-assignment denials, noops, and blocked write attempts.

/** Color for an audit outcome. */
function outcomeColor(outcome: string) {
	switch (outcome) {
		case 'denied':
		case 'failed':
			return red;
		case 'blocked':
			return yellow;
		case 'noop':
			return gray;
		default:
			return green;
	}
}

/** Shared filter args for all three subcommands. */
const filterArgs = {
	'org-slug': {
		type: 'string',
		description: 'Filter by organization slug',
	},
	'key-id': {
		type: 'string',
		description: 'Filter by API key ID',
	},
	action: {
		type: 'string',
		description: 'Filter by action (e.g. supabase:members:invite, supabase:members:update_role)',
	},
	outcome: {
		type: 'string',
		description: 'Filter by outcome (preview, denied, noop, blocked, executed, failed)',
	},
	'target-email': {
		type: 'string',
		description: 'Filter by target member email',
	},
	since: {
		type: 'string',
		description: 'Start time (ISO 8601 or unix ms)',
	},
	until: {
		type: 'string',
		description: 'End time (ISO 8601 or unix ms)',
	},
} as const;

function buildQuery(args: Record<string, unknown>): string {
	const str = (key: string): string | undefined => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
	const params = new URLSearchParams();
	if (str('org-slug')) params.set('org_slug', str('org-slug')!);
	if (str('key-id')) params.set('key_id', str('key-id')!);
	if (str('action')) params.set('action', str('action')!);
	if (str('outcome')) params.set('outcome', str('outcome')!);
	if (str('target-email')) params.set('target_email', str('target-email')!);
	if (str('since')) params.set('since', String(parseTime(str('since')!)));
	if (str('until')) params.set('until', String(parseTime(str('until')!)));
	if (str('limit')) params.set('limit', str('limit')!);
	return params.toString();
}

// --- supabase-membership events ---
const events = defineCommand({
	meta: {
		name: 'events',
		description: 'Query recent Supabase membership audit events',
	},
	args: {
		...baseArgs,
		...filterArgs,
		limit: {
			type: 'string',
			description: 'Max events to return (default 100, max 1000)',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const qs = buildQuery(args);
		const path = qs ? `/admin/supabase/membership/events?${qs}` : '/admin/supabase/membership/events';
		const { status, data, durationMs } = await request(config, 'GET', path, {
			auth: 'admin',
			label: 'Fetching membership audit events...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>[];

		if (result.length === 0) {
			info(`No membership audit events found ${dim(`(${formatDuration(durationMs)})`)}`);
			return;
		}

		console.error('');
		info(`${bold(String(result.length))} event${result.length === 1 ? '' : 's'} ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');

		const rows = result.map((e) => {
			const outcome = String(e.outcome);
			const ts = new Date(e.created_at as number).toISOString().slice(0, 19).replace('T', ' ');
			const role =
				e.from_role != null && e.from_role !== e.requested_role ? `${e.from_role} -> ${e.requested_role}` : String(e.requested_role ?? '-');

			return [
				ts,
				outcomeColor(outcome)(outcome),
				cyan(e.org_slug as string),
				cyan(e.action as string),
				e.target_email ? String(e.target_email) : dim('-'),
				role,
				gray(String(e.created_by ?? '-')),
			];
		});

		table(['Time', 'Outcome', 'Org', 'Action', 'Target', 'Role', 'Actor'], rows);
		console.error('');
	},
});

// --- supabase-membership summary ---
const summary = defineCommand({
	meta: {
		name: 'summary',
		description: 'Get aggregated Supabase membership audit summary',
	},
	args: {
		...baseArgs,
		...filterArgs,
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const qs = buildQuery(args);
		const path = qs ? `/admin/supabase/membership/summary?${qs}` : '/admin/supabase/membership/summary';
		const { status, data, durationMs } = await request(config, 'GET', path, {
			auth: 'admin',
			label: 'Fetching membership audit summary...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const s = (data as Record<string, unknown>).result as Record<string, unknown>;

		console.error('');
		success(`Supabase membership audit summary ${dim(`(${formatDuration(durationMs)})`)}`);
		console.error('');

		label('Total events', bold(String(s.total_events)));
		label('Denied', bold(String(s.denied_count)));

		const byOutcome = (s.by_outcome ?? {}) as Record<string, number>;
		if (Object.keys(byOutcome).length > 0) {
			console.error('');
			info('By outcome:');
			for (const [outcome, count] of Object.entries(byOutcome)) {
				console.error(`  ${symbols.bullet} ${outcomeColor(outcome)(bold(outcome))} ${dim('x')}${count}`);
			}
		}

		const byAction = (s.by_action ?? {}) as Record<string, number>;
		if (Object.keys(byAction).length > 0) {
			console.error('');
			info('By action:');
			for (const [action, count] of Object.entries(byAction)) {
				console.error(`  ${symbols.bullet} ${cyan(action)} ${dim('x')}${count}`);
			}
		}

		const byOrg = (s.by_org ?? {}) as Record<string, number>;
		if (Object.keys(byOrg).length > 0) {
			console.error('');
			info('By org:');
			for (const [org, count] of Object.entries(byOrg)) {
				console.error(`  ${symbols.bullet} ${cyan(org)} ${dim('x')}${count}`);
			}
		}

		console.error('');
	},
});

// --- supabase-membership timeseries ---
const timeseries = defineCommand({
	meta: {
		name: 'timeseries',
		description: 'Get Supabase membership audit timeseries buckets (errors = denied/failed outcomes)',
	},
	args: {
		...baseArgs,
		...filterArgs,
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const qs = buildQuery(args);
		const path = qs ? `/admin/supabase/membership/timeseries?${qs}` : '/admin/supabase/membership/timeseries';
		const { status, data, durationMs } = await request(config, 'GET', path, {
			auth: 'admin',
			label: 'Fetching membership audit timeseries...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>[];

		if (result.length === 0) {
			info(`No membership audit timeseries buckets found ${dim(`(${formatDuration(durationMs)})`)}`);
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

		table(['Time', 'Count', 'Denied/Failed'], rows);
		console.error('');
	},
});

// --- supabase-membership (parent) ---
export default defineCommand({
	meta: { name: 'supabase-membership', description: 'View Supabase membership audit events' },
	subCommands: { events, summary, timeseries },
});
