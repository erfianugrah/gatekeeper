import { defineCommand } from 'citty';
import { resolveConfig, request, assertOk } from '../client.js';
import { success, info, bold, dim, cyan, red, green, table, printJson, formatDuration, parseTime, error } from '../ui.js';
import { baseArgs } from '../shared-args.js';

// Per-tenant cost metering across every proxy surface. Cross-surface by default
// (unified on created_by), or a single surface via --surface.

const SURFACE_PATHS: Record<string, string> = {
	supabase: '/admin/supabase/analytics/metering',
	cf: '/admin/cf/analytics/metering',
	dns: '/admin/dns/analytics/metering',
	purge: '/admin/analytics/metering',
	s3: '/admin/s3/analytics/metering',
};

// Surface label → underlying event table key used in cross-surface rows.
const SURFACE_TABLES: Record<string, string> = {
	supabase: 'supabase_proxy_events',
	cf: 'cf_proxy_events',
	dns: 'dns_events',
	purge: 'purge_events',
	s3: 's3_events',
};

const SURFACE_ORDER = ['supabase', 'cf', 'dns', 'purge', 's3'];

function fmtBytes(value: unknown): string {
	if (value === null || value === undefined) return dim('-');
	return String(value);
}

// Cost is illustrative placeholder pricing (see src/metering-pricing.ts), not real list prices.
function fmtUsd(value: unknown): string {
	const n = Number(value ?? 0);
	if (!Number.isFinite(n) || n === 0) return dim('$0');
	if (n < 0.01) return green(`$${n.toFixed(6)}`);
	return green(`$${n.toFixed(2)}`);
}

export default defineCommand({
	meta: { name: 'metering', description: 'Per-tenant cost metering across proxy surfaces' },
	args: {
		...baseArgs,
		surface: {
			type: 'string',
			description: 'Single surface (supabase|cf|dns|purge|s3); omit for cross-surface',
		},
		'group-by': {
			type: 'string',
			description: 'Per-surface grouping dim (tenant|key|project|zone|credential|bucket)',
		},
		since: {
			type: 'string',
			description: 'Window start (ISO 8601 or unix ms)',
		},
		until: {
			type: 'string',
			description: 'Window end (ISO 8601 or unix ms)',
		},
		limit: {
			type: 'string',
			description: 'Max rows (default 100, max 1000)',
		},
	},
	async run({ args }) {
		const config = resolveConfig(args);

		const params = new URLSearchParams();
		if (args.since) params.set('since', String(parseTime(args.since)));
		if (args.until) params.set('until', String(parseTime(args.until)));
		if (args.limit) params.set('limit', String(args.limit));

		const surface = args.surface as string | undefined;
		let path: string;
		if (surface) {
			const base = SURFACE_PATHS[surface];
			if (!base) {
				error(`Unknown surface '${surface}'. One of: ${Object.keys(SURFACE_PATHS).join(', ')}`);
				process.exit(1);
			}
			if (args['group-by']) params.set('group_by', String(args['group-by']));
			const qs = params.toString();
			path = qs ? `${base}?${qs}` : base;
		} else {
			const qs = params.toString();
			path = qs ? `/admin/metering?${qs}` : '/admin/metering';
		}

		const { status, data, durationMs } = await request(config, 'GET', path, {
			auth: 'admin',
			label: 'Fetching metering rollup...',
		});

		if (args.json) {
			assertOk(status, data);
			printJson(data);
			return;
		}

		assertOk(status, data);
		const result = (data as Record<string, unknown>).result as Record<string, unknown>[];

		if (result.length === 0) {
			info(`No metering rows found ${dim(`(${formatDuration(durationMs)})`)}`);
			return;
		}

		console.error('');
		success(
			`${bold(String(result.length))} ${surface ? surface + ' ' : ''}metering row${result.length === 1 ? '' : 's'} ${dim(`(${formatDuration(durationMs)})`)}`,
		);
		console.error('');

		if (surface) {
			// Single-surface: Label | Total req | Read | Write | Error% | Egress (bytes)
			const rows = result.map((r) => {
				const total = Number(r.total_requests ?? 0);
				const errPct = Number(r.error_rate_pct ?? 0);
				return [
					cyan(String(r.label ?? r.group_key ?? '(none)')),
					bold(String(total)),
					r.read_requests === null || r.read_requests === undefined ? dim('-') : String(r.read_requests),
					r.write_requests === null || r.write_requests === undefined ? dim('-') : String(r.write_requests),
					errPct > 0 ? red(`${errPct}%`) : green(`${errPct}%`),
					fmtBytes(r.egress_bytes),
					fmtUsd(r.cost_usd),
				];
			});
			table(['Label', 'Total req', 'Read', 'Write', 'Error%', 'Egress (bytes)', 'Cost*'], rows);
		} else {
			// Cross-surface: Tenant | Total req | Errors | Egress (bytes) | one col per surface (req count)
			const headers = ['Tenant', 'Total req', 'Cost*', 'Errors', 'Egress (bytes)', ...SURFACE_ORDER];
			const rows = result.map((r) => {
				const surfaces = (r.surfaces ?? {}) as Record<string, { total_requests?: number }>;
				const errors = Number(r.total_errors ?? 0);
				const surfaceCols = SURFACE_ORDER.map((s) => {
					const t = surfaces[SURFACE_TABLES[s]];
					return t ? String(t.total_requests ?? 0) : dim('-');
				});
				return [
					cyan(String(r.tenant ?? '(none)')),
					bold(String(r.total_requests ?? 0)),
					fmtUsd(r.total_cost_usd),
					errors > 0 ? red(String(errors)) : green(String(errors)),
					fmtBytes(r.total_egress_bytes),
					...surfaceCols,
				];
			});
			table(headers, rows);
			console.error(dim('  * Cost uses illustrative placeholder pricing, not real list prices.'));
		}

		console.error('');
	},
});
