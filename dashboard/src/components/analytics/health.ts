import type {
	AnalyticsSummary,
	S3AnalyticsSummary,
	DnsAnalyticsSummary,
	CfProxyAnalyticsSummary,
	SupabaseProxyAnalyticsSummary,
} from '@/lib/api';

// ─── Health model ───────────────────────────────────────────────────

export type HealthLevel = 'ok' | 'warn' | 'crit';

export interface SurfaceHealth {
	/** Stable surface id (used as React key). */
	surface: string;
	/** Display label. */
	label: string;
	total: number;
	errorCount: number;
	/** Error rate as a percentage (0..100). */
	errorRate: number;
	count5xx: number;
	level: HealthLevel;
	/** Notable surface-specific signals (e.g. '401 18.2%'); does NOT include 5xx (own column). */
	signals: string[];
}

// Generic thresholds (percentages of total requests).
export const WARN_ERROR_PCT = 5;
export const CRIT_ERROR_PCT = 15;
// Supabase-specific thresholds (mirror the previous banner logic).
export const SUPABASE_TIMEOUT_WARN_PCT = 2;
export const SUPABASE_UNAUTHORIZED_WARN_PCT = 5;

function countWhere(byStatus: Record<string, number>, pred: (n: number) => boolean): number {
	let acc = 0;
	for (const [k, v] of Object.entries(byStatus)) {
		if (pred(Number(k))) acc += v;
	}
	return acc;
}

/** Generic health from a status histogram. 5xx is surfaced as a column, not a signal. */
function baseHealth(surface: string, label: string, total: number, byStatus: Record<string, number>): SurfaceHealth {
	const errorCount = countWhere(byStatus, (n) => n >= 400);
	const count5xx = countWhere(byStatus, (n) => n >= 500);
	const errorRate = total > 0 ? (errorCount / total) * 100 : 0;
	let level: HealthLevel = 'ok';
	if (errorRate >= CRIT_ERROR_PCT) level = 'crit';
	else if (errorRate >= WARN_ERROR_PCT || count5xx > 0) level = 'warn';
	return { surface, label, total, errorCount, errorRate, count5xx, level, signals: [] };
}

export interface HealthInputs {
	purge: AnalyticsSummary | null;
	purgeTotal: number;
	s3: S3AnalyticsSummary | null;
	s3Total: number;
	dns: DnsAnalyticsSummary | null;
	dnsTotal: number;
	cf: CfProxyAnalyticsSummary | null;
	cfTotal: number;
	supabase: SupabaseProxyAnalyticsSummary | null;
	supaTotal: number;
}

/**
 * Compute uniform per-surface health for every surface that has traffic.
 * Supabase gets extra signals (timeouts / 401 / upstream 5xx) layered on top
 * of the generic error-rate model, replacing the old Supabase-only banner.
 */
export function computeSurfaceHealth(inp: HealthInputs): SurfaceHealth[] {
	const out: SurfaceHealth[] = [];
	if (inp.purgeTotal > 0 && inp.purge) out.push(baseHealth('purge', 'Purge', inp.purgeTotal, inp.purge.by_status));
	if (inp.s3Total > 0 && inp.s3) out.push(baseHealth('s3', 'S3', inp.s3Total, inp.s3.by_status));
	if (inp.dnsTotal > 0 && inp.dns) out.push(baseHealth('dns', 'DNS', inp.dnsTotal, inp.dns.by_status));
	if (inp.cfTotal > 0 && inp.cf) out.push(baseHealth('cf', 'CF', inp.cfTotal, inp.cf.by_status));
	if (inp.supaTotal > 0 && inp.supabase) {
		const h = baseHealth('supabase', 'Supabase', inp.supaTotal, inp.supabase.by_status);
		const s = inp.supabase;
		const timeoutRate = (s.timeout_count / inp.supaTotal) * 100;
		const unauthorizedRate = (s.unauthorized_count / inp.supaTotal) * 100;
		if (timeoutRate >= SUPABASE_TIMEOUT_WARN_PCT) {
			h.signals.push(`Timeouts ${timeoutRate.toFixed(1)}%`);
			if (h.level === 'ok') h.level = 'warn';
		}
		if (unauthorizedRate >= SUPABASE_UNAUTHORIZED_WARN_PCT) {
			h.signals.push(`401 ${unauthorizedRate.toFixed(1)}%`);
			if (h.level === 'ok') h.level = 'warn';
		}
		if (s.upstream_5xx_count > 0) {
			h.signals.push(`Upstream 5xx ${s.upstream_5xx_count}`);
			if (h.level === 'ok') h.level = 'warn';
		}
		out.push(h);
	}
	return out;
}
