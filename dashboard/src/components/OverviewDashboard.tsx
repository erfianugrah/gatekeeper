import { useState, useEffect, useCallback } from 'react';
import {
	PieChart,
	Pie,
	Cell,
	BarChart,
	Bar,
	ComposedChart,
	Area,
	Line,
	XAxis,
	YAxis,
	Tooltip,
	Legend,
	ResponsiveContainer,
	CartesianGrid,
} from 'recharts';
import {
	Activity,
	Link,
	Timer,
	Layers,
	AlertTriangle,
	HardDrive,
	Cloud,
	Globe,
	Key,
	Shield,
	Zap,
	Database,
	Clock,
	ArrowRight,
	ChevronDown,
	ChevronRight,
	Cpu,
	Server,
	RefreshCw,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { computeSurfaceHealth, worstHealthLevel, WARN_ERROR_PCT, type HealthLevel } from '@/components/analytics/health';
import { Tooltip as UiTooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
	getSummary,
	getS3Summary,
	getDnsSummary,
	getEvents,
	getS3Events,
	getDnsEvents,
	getCfProxyEvents,
	getCfProxySummary,
	getSupabaseProxyEvents,
	getSupabaseProxySummary,
	getSupabaseProxyTimeseries,
	getPurgeTimeseries,
	getS3Timeseries,
	getDnsTimeseries,
	getCfProxyTimeseries,
	listKeys,
	listS3Credentials,
	listUpstreamTokens,
	listUpstreamR2,
} from '@/lib/api';
import type {
	AnalyticsSummary,
	S3AnalyticsSummary,
	DnsAnalyticsSummary,
	CfProxyAnalyticsSummary,
	SupabaseProxyAnalyticsSummary,
	TimeseriesBucket,
	PurgeEvent,
	S3Event,
	DnsEvent,
	CfProxyEvent,
	SupabaseProxyEvent,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { STATUS_COLORS, PURGE_TYPE_COLORS, CHART_PALETTE, CHART_TOOLTIP_STYLE } from '@/lib/utils';
import { T } from '@/lib/typography';
import { sourceLabel } from '@/components/analytics/analytics-badges';

// ─── Helpers ────────────────────────────────────────────────────────

function statusColor(code: string): string {
	const n = Number(code);
	if (n >= 200 && n < 300) return STATUS_COLORS.success;
	if (n === 429) return STATUS_COLORS.rate_limited;
	if (n === 403) return STATUS_COLORS.denied;
	if (n >= 400) return STATUS_COLORS.error;
	return STATUS_COLORS.collapsed;
}

function formatNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toLocaleString();
}

// Shared donut chart: ring + right-aligned legend with percentages.
// Perimeter labels are omitted deliberately -- with many small slices they
// collide into an unreadable pile at the bottom of the ring. The legend keeps
// every series identifiable (incl. sub-1% slices) without any overlap.
function DonutPie({ data, colorFor }: { data: { name: string; value: number }[]; colorFor: (name: string, index: number) => string }) {
	return (
		<ResponsiveContainer width="100%" height={260}>
			<PieChart>
				<Pie data={data} cx="38%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={4} dataKey="value" nameKey="name">
					{data.map((entry, i) => (
						<Cell key={entry.name} fill={colorFor(entry.name, i)} />
					))}
				</Pie>
				<Tooltip
					contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
					itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
					labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
					formatter={(value: number, name: string) => [formatNumber(value), name]}
				/>
				<Legend
					layout="vertical"
					align="right"
					verticalAlign="middle"
					iconType="circle"
					iconSize={8}
					wrapperStyle={{ fontSize: T.chartLabel, lineHeight: '1.5', paddingLeft: 8 }}
					formatter={(value: string, entry: any) => {
						const pct = entry?.payload?.percent;
						return (
							<span style={{ color: '#8c8474' }}>
								{value}
								{typeof pct === 'number' ? <span style={{ color: '#5a5446' }}> {(pct * 100).toFixed(0)}%</span> : null}
							</span>
						);
					}}
				/>
			</PieChart>
		</ResponsiveContainer>
	);
}

function mergeByStatus(...sources: Record<string, number>[]): Record<string, number> {
	const merged: Record<string, number> = {};
	for (const src of sources) {
		for (const [k, v] of Object.entries(src)) {
			merged[k] = (merged[k] ?? 0) + v;
		}
	}
	return merged;
}

function formatTimeShort(epoch: number): string {
	const d = new Date(epoch);
	return d.toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	});
}

function truncateId(id: string, len = 12): string {
	return id.length > len ? `${id.slice(0, len)}...` : id;
}

// ─── Stat Card ──────────────────────────────────────────────────────

interface StatCardProps {
	label: string;
	value: string;
	icon: React.ReactNode;
	iconBg: string;
	/**
	 * Optional severity override. When set, replaces iconBg/value coloring
	 * with the shared health palette regardless of the icon/iconBg passed in --
	 * used by rollup KPIs (e.g. Error Rate) so a blended-looking-fine number
	 * still escalates visually when the WORST underlying surface is warn/crit.
	 */
	tone?: HealthLevel;
}

const TONE_ICON_BG: Record<HealthLevel, string> = {
	ok: 'bg-status-ok/15 text-status-ok',
	warn: 'bg-status-warn/15 text-status-warn',
	crit: 'bg-status-danger/15 text-status-danger',
};
const TONE_VALUE: Record<HealthLevel, string> = {
	ok: '',
	warn: 'text-status-warn',
	crit: 'text-status-danger',
};

function StatCard({ label, value, icon, iconBg, tone }: StatCardProps) {
	return (
		<Card>
			<CardContent className="flex items-center gap-4 p-5">
				<div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', tone ? TONE_ICON_BG[tone] : iconBg)}>{icon}</div>
				<div className="min-w-0">
					<p className={T.statLabelUpper}>{label}</p>
					<p className={cn(T.statValue, tone && TONE_VALUE[tone])}>{value}</p>
				</div>
			</CardContent>
		</Card>
	);
}

/**
 * Dense inline resource-count strip. These are plain counts (no good/bad
 * reading), so a full StatCard per number wastes two rows of vertical space
 * on four small integers -- a single hairline-divided bar is the same
 * information at a fraction of the height, matching the "tables over card
 * grids" ethos elsewhere in this dashboard.
 */
function ResourceStat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
	return (
		<div className="flex flex-1 items-center gap-2 px-4 py-2.5">
			<span className="shrink-0">{icon}</span>
			<span className={T.statLabelUpper}>{label}</span>
			<span className="ml-auto font-semibold text-foreground">{value}</span>
		</div>
	);
}

// ─── Tooltip helper ─────────────────────────────────────────────────

function WithTip({ tip, children }: { tip: string; children: React.ReactNode }) {
	return (
		<UiTooltip>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent>
				<p className="text-xs font-data max-w-[300px]">{tip}</p>
			</TooltipContent>
		</UiTooltip>
	);
}

function statusTooltip(status: number): string {
	if (status >= 200 && status < 300) return `${status} — Success`;
	if (status === 401) return '401 — Unauthorized';
	if (status === 403) return '403 — Forbidden (policy denied)';
	if (status === 429) return '429 — Rate limited';
	if (status >= 400 && status < 500) return `${status} — Client error`;
	if (status >= 500) return `${status} — Server error`;
	return String(status);
}

// ─── Status Badge ───────────────────────────────────────────────────

function StatusBadge({ status }: { status: number }) {
	const tip = statusTooltip(status);
	let badge: React.ReactNode;
	if (status >= 200 && status < 300) badge = <Badge className="bg-lv-green/20 text-lv-green border-lv-green/30">{status}</Badge>;
	else if (status === 429) badge = <Badge className="bg-lv-peach/20 text-lv-peach border-lv-peach/30">{status}</Badge>;
	else if (status === 403) badge = <Badge className="bg-lv-red-bright/20 text-lv-red-bright border-lv-red-bright/30">{status}</Badge>;
	else if (status >= 400) badge = <Badge className="bg-lv-red/20 text-lv-red border-lv-red/30">{status}</Badge>;
	else badge = <Badge className="bg-muted/20 text-muted-foreground">{status}</Badge>;
	return <WithTip tip={tip}>{badge}</WithTip>;
}

// ─── Loading Skeleton ───────────────────────────────────────────────

function LoadingSkeleton() {
	return (
		<div className="space-y-6">
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
				{Array.from({ length: 5 }).map((_, i) => (
					<Card key={i}>
						<CardContent className="flex items-center gap-4 p-5">
							<Skeleton className="h-10 w-10 rounded-lg" />
							<div className="space-y-2">
								<Skeleton className="h-3 w-20" />
								<Skeleton className="h-7 w-16" />
							</div>
						</CardContent>
					</Card>
				))}
			</div>
			<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<Skeleton className="h-4 w-40" />
					</CardHeader>
					<CardContent>
						<Skeleton className="mx-auto h-52 w-52 rounded-full" />
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<Skeleton className="h-4 w-40" />
					</CardHeader>
					<CardContent>
						<Skeleton className="h-52 w-full" />
					</CardContent>
				</Card>
			</div>
		</div>
	);
}

// ─── Unified recent event ───────────────────────────────────────────

interface RecentEvent {
	id: string;
	source: string;
	status: number;
	detail: string;
	/** Full purge target or S3 detail for tooltip */
	detailFull: string | null;
	duration_ms: number;
	created_at: number;
	identity: string;
}

function fromPurgeRecent(ev: PurgeEvent): RecentEvent {
	const target = ev.purge_target ? ` ${ev.purge_target}` : '';
	const detailShort = target ? `${ev.purge_type} ${truncateId(target.trim(), 40)}` : ev.purge_type;
	return {
		id: `p-${ev.id}`,
		source: 'purge',
		status: ev.status,
		detail: detailShort,
		detailFull: ev.purge_target,
		duration_ms: ev.duration_ms,
		created_at: ev.created_at,
		identity: truncateId(ev.key_id),
	};
}

function fromS3Recent(ev: S3Event): RecentEvent {
	const detail = `${ev.operation}${ev.bucket ? ` ${ev.bucket}` : ''}${ev.key ? `/${ev.key}` : ''}`;
	return {
		id: `s-${ev.id}`,
		source: 's3',
		status: ev.status,
		detail: truncateId(detail, 50),
		detailFull: detail.length > 50 ? detail : null,
		duration_ms: ev.duration_ms,
		created_at: ev.created_at,
		identity: truncateId(ev.credential_id),
	};
}

function fromDnsRecent(ev: DnsEvent): RecentEvent {
	const detail = `${ev.action}${ev.record_name ? ` ${ev.record_name}` : ''}${ev.record_type ? ` (${ev.record_type})` : ''}`;
	return {
		id: `d-${ev.id}`,
		source: 'dns',
		status: ev.status,
		detail: truncateId(detail, 50),
		detailFull: detail.length > 50 ? detail : null,
		duration_ms: ev.duration_ms,
		created_at: ev.created_at,
		identity: truncateId(ev.key_id),
	};
}

function fromCfRecent(ev: CfProxyEvent): RecentEvent {
	const detail = `${ev.action}${ev.resource_id ? ` ${ev.resource_id}` : ''}`;
	return {
		id: `cf-${ev.id}`,
		source: ev.service,
		status: ev.status,
		detail: truncateId(detail, 50),
		detailFull: detail.length > 50 ? detail : null,
		duration_ms: ev.duration_ms,
		created_at: ev.created_at,
		identity: truncateId(ev.key_id),
	};
}
function fromSupabaseRecent(ev: SupabaseProxyEvent): RecentEvent {
	const detail = `${ev.action}${ev.project_ref ? ` ${ev.project_ref}` : ''}`;
	return {
		id: `supa-${ev.id}`,
		source: 'supabase',
		status: ev.status,
		detail: truncateId(detail, 50),
		detailFull: detail.length > 50 ? detail : null,
		duration_ms: ev.duration_ms,
		created_at: ev.created_at,
		identity: truncateId(ev.key_id),
	};
}

// ─── Source icon/tooltip lookup for recent events ───────────────────

const SOURCE_ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
	purge: Cloud,
	s3: HardDrive,
	dns: Globe,
	d1: Database,
	kv: Layers,
	workers: Cpu,
	queues: Zap,
	vectorize: Server,
	hyperdrive: Server,
	supabase: Database,
};

const SOURCE_ICON_COLOR: Record<string, string> = {
	purge: 'text-lv-purple',
	s3: 'text-lv-cyan',
	dns: 'text-lv-green',
	d1: 'text-lv-purple',
	kv: 'text-lv-cyan',
	workers: 'text-lv-green',
	queues: 'text-lv-peach',
	vectorize: 'text-lv-blue',
	hyperdrive: 'text-lv-red-bright',
	supabase: 'text-lv-peach',
};

const SOURCE_TIP: Record<string, string> = {
	purge: 'Cache purge request',
	s3: 'S3/R2 storage request',
	dns: 'DNS record operation',
	d1: 'D1 database operation',
	kv: 'Workers KV operation',
	workers: 'Workers script operation',
	queues: 'Queues operation',
	vectorize: 'Vectorize index operation',
	hyperdrive: 'Hyperdrive config operation',
	supabase: 'Supabase Management API / metrics request',
};

function sourceIcon(source: string): React.ReactNode {
	const Icon = SOURCE_ICON_MAP[source] ?? Server;
	const color = SOURCE_ICON_COLOR[source] ?? 'text-muted-foreground';
	return <Icon className={`h-3.5 w-3.5 ${color}`} />;
}

function sourceTip(source: string): string {
	return SOURCE_TIP[source] ?? `${sourceLabel(source)} operation`;
}

// ─── Overview Dashboard ─────────────────────────────────────────────

export function OverviewDashboard() {
	const [purgeSummary, setPurgeSummary] = useState<AnalyticsSummary | null>(null);
	const [s3Summary, setS3Summary] = useState<S3AnalyticsSummary | null>(null);
	const [dnsSummary, setDnsSummary] = useState<DnsAnalyticsSummary | null>(null);
	const [cfSummary, setCfSummary] = useState<CfProxyAnalyticsSummary | null>(null);
	const [supabaseSummary, setSupabaseSummary] = useState<SupabaseProxyAnalyticsSummary | null>(null);
	const [timeseries, setTimeseries] = useState<{ bucket: number; total: number; errors: number }[]>([]);
	const [recentEvents, setRecentEvents] = useState<RecentEvent[]>([]);
	const [resourceCounts, setResourceCounts] = useState({
		activeKeys: 0,
		revokedKeys: 0,
		activeS3Creds: 0,
		revokedS3Creds: 0,
		activeUpstreamTokens: 0,
		activeUpstreamR2: 0,
	});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [chartsOpen, setChartsOpen] = useState(true);

	const fetchData = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [
				purge,
				s3,
				dns,
				cf,
				supa,
				purgeEvents,
				s3Events,
				dnsEvents,
				cfEvents,
				supabaseEvents,
				purgeTs,
				s3Ts,
				dnsTs,
				cfTs,
				supaTs,
				keys,
				s3Creds,
				upTokens,
				upR2,
			] = await Promise.all([
				getSummary().catch(() => null),
				getS3Summary().catch(() => null),
				getDnsSummary().catch(() => null),
				getCfProxySummary().catch(() => null),
				getSupabaseProxySummary().catch(() => null),
				getEvents({ limit: 10 }).catch(() => [] as PurgeEvent[]),
				getS3Events({ limit: 10 }).catch(() => [] as S3Event[]),
				getDnsEvents({ limit: 10 }).catch(() => [] as DnsEvent[]),
				getCfProxyEvents({ limit: 10 }).catch(() => [] as CfProxyEvent[]),
				getSupabaseProxyEvents({ limit: 10 }).catch(() => [] as SupabaseProxyEvent[]),
				getPurgeTimeseries().catch(() => [] as TimeseriesBucket[]),
				getS3Timeseries().catch(() => [] as TimeseriesBucket[]),
				getDnsTimeseries().catch(() => [] as TimeseriesBucket[]),
				getCfProxyTimeseries().catch(() => [] as TimeseriesBucket[]),
				getSupabaseProxyTimeseries().catch(() => [] as TimeseriesBucket[]),
				listKeys().catch(() => []),
				listS3Credentials().catch(() => []),
				listUpstreamTokens().catch(() => []),
				listUpstreamR2().catch(() => []),
			]);
			if (!purge && !s3 && !dns && !cf && !supa) {
				throw new Error('Failed to load analytics from all endpoints');
			}
			setPurgeSummary(purge);
			setS3Summary(s3);
			setDnsSummary(dns);
			setCfSummary(cf);
			setSupabaseSummary(supa);

			// Merge all timeseries into a single array keyed by bucket
			const tsMap = new Map<number, { bucket: number; total: number; errors: number }>();
			for (const series of [purgeTs, s3Ts, dnsTs, cfTs, supaTs]) {
				for (const b of series) {
					const existing = tsMap.get(b.bucket);
					if (existing) {
						existing.total += b.count;
						existing.errors += b.errors;
					} else {
						tsMap.set(b.bucket, { bucket: b.bucket, total: b.count, errors: b.errors });
					}
				}
			}
			const mergedTs = Array.from(tsMap.values()).sort((a, b) => a.bucket - b.bucket);
			setTimeseries(mergedTs);

			// Merge and sort recent events
			const all: RecentEvent[] = [
				...purgeEvents.map(fromPurgeRecent),
				...s3Events.map(fromS3Recent),
				...dnsEvents.map(fromDnsRecent),
				...cfEvents.map(fromCfRecent),
				...supabaseEvents.map(fromSupabaseRecent),
			]
				.sort((a, b) => b.created_at - a.created_at)
				.slice(0, 10);
			setRecentEvents(all);

			setResourceCounts({
				activeKeys: keys.filter((k) => !k.revoked).length,
				revokedKeys: keys.filter((k) => k.revoked).length,
				activeS3Creds: s3Creds.filter((c) => !c.revoked).length,
				revokedS3Creds: s3Creds.filter((c) => c.revoked).length,
				activeUpstreamTokens: upTokens.length,
				activeUpstreamR2: upR2.length,
			});
		} catch (e: any) {
			setError(e.message ?? 'Failed to load summary');
			setPurgeSummary(null);
			setS3Summary(null);
			setDnsSummary(null);
			setCfSummary(null);
			setSupabaseSummary(null);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	// ── Derived data ──────────────────────────────────────────────

	const purgeTotal = purgeSummary?.total_requests ?? 0;
	const s3Total = s3Summary?.total_requests ?? 0;
	const dnsTotal = dnsSummary?.total_requests ?? 0;
	const cfTotal = cfSummary?.total_requests ?? 0;
	const supaTotal = supabaseSummary?.total_requests ?? 0;
	const totalRequests = purgeTotal + s3Total + dnsTotal + cfTotal + supaTotal;

	const HEALTH_DOT: Record<HealthLevel, string> = {
		ok: 'bg-lv-green',
		warn: 'bg-lv-peach',
		crit: 'bg-lv-red',
	};

	const surfaceHealth = computeSurfaceHealth({
		purge: purgeSummary,
		purgeTotal,
		s3: s3Summary,
		s3Total,
		dns: dnsSummary,
		dnsTotal,
		cf: cfSummary,
		cfTotal,
		supabase: supabaseSummary,
		supaTotal,
	});

	// Per-service totals from cfSummary.by_service (d1, kv, workers, etc.)
	const cfByService = cfSummary?.by_service ?? {};

	// Combined status breakdown
	const mergedStatus = mergeByStatus(
		purgeSummary?.by_status ?? {},
		s3Summary?.by_status ?? {},
		dnsSummary?.by_status ?? {},
		cfSummary?.by_status ?? {},
		supabaseSummary?.by_status ?? {},
	);
	const barData = Object.entries(mergedStatus)
		.map(([status, count]) => ({ status, count }))
		.sort((a, b) => Number(a.status) - Number(b.status));

	// Purge type pie
	const purgeTypePie = purgeSummary ? Object.entries(purgeSummary.by_purge_type).map(([name, value]) => ({ name, value })) : [];

	// S3 operation pie
	const s3OpPie = s3Summary
		? Object.entries(s3Summary.by_operation)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10)
				.map(([name, value]) => ({ name, value }))
		: [];

	// S3 bucket pie
	const s3BucketPie = s3Summary
		? Object.entries(s3Summary.by_bucket)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10)
				.map(([name, value]) => ({ name, value }))
		: [];

	// DNS action pie
	const dnsActionPie = dnsSummary
		? Object.entries(dnsSummary.by_action)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10)
				.map(([name, value]) => ({ name, value }))
		: [];

	// CF service breakdown pie — shows per-service totals (d1, kv, workers, etc.)
	const cfServicePie = Object.entries(cfByService)
		.filter(([, v]) => v > 0)
		.sort((a, b) => b[1] - a[1])
		.map(([svc, value]) => ({ name: sourceLabel(svc), value }));

	// CF action breakdown
	const cfActionPie = cfSummary
		? Object.entries(cfSummary.by_action)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10)
				.map(([name, value]) => ({ name, value }))
		: [];

	const CF_SERVICE_COLORS: Record<string, string> = {
		D1: '#b08fc4',
		KV: '#6bbfae',
		Workers: '#6fab58',
		Queues: '#d9b96a',
		Vectorize: '#7fa8c9',
		Hyperdrive: '#ff5460',
	};

	// Supabase category breakdown
	const supaCategoryPie = supabaseSummary
		? Object.entries(supabaseSummary.by_category)
				.filter(([, v]) => v > 0)
				.sort((a, b) => b[1] - a[1])
				.map(([name, value]) => ({ name, value }))
		: [];

	// Traffic split — shows each service individually (purge, s3, dns, d1, kv, workers, etc.)
	const trafficPie = [
		...(purgeTotal > 0 ? [{ name: 'Purge', value: purgeTotal }] : []),
		...(s3Total > 0 ? [{ name: 'S3', value: s3Total }] : []),
		...(dnsTotal > 0 ? [{ name: 'DNS', value: dnsTotal }] : []),
		...Object.entries(cfByService)
			.filter(([, v]) => v > 0)
			.sort((a, b) => b[1] - a[1])
			.map(([svc, v]) => ({ name: sourceLabel(svc), value: v })),
		...(supaTotal > 0 ? [{ name: 'Supabase', value: supaTotal }] : []),
	];
	const TRAFFIC_COLORS: Record<string, string> = {
		Purge: '#b08fc4',
		S3: '#6bbfae',
		DNS: '#6fab58',
		D1: '#b08fc4',
		KV: '#6bbfae',
		Workers: '#6fab58',
		Queues: '#d9b96a',
		Vectorize: '#7fa8c9',
		Hyperdrive: '#ff5460',
		Supabase: '#d9b96a',
	};

	// Combined avg latency
	const avgLatency =
		totalRequests > 0
			? Math.round(
					((purgeSummary?.avg_duration_ms ?? 0) * purgeTotal +
						(s3Summary?.avg_duration_ms ?? 0) * s3Total +
						(dnsSummary?.avg_duration_ms ?? 0) * dnsTotal +
						(cfSummary?.avg_duration_ms ?? 0) * cfTotal +
						(supabaseSummary?.avg_duration_ms ?? 0) * supaTotal) /
						totalRequests,
				)
			: 0;

	// Error stats
	const errorCount = Object.entries(mergedStatus)
		.filter(([s]) => Number(s) >= 400)
		.reduce((acc, [, v]) => acc + v, 0);
	const errorPct = totalRequests > 0 ? ((errorCount / totalRequests) * 100).toFixed(1) : '0';
	// The blended errorPct above can look fine (e.g. 10%) while one surface is
	// actually on fire (e.g. Supabase at 39%) -- escalate the tile's color to
	// the WORST underlying surface, not the diluted average, so a real incident
	// is never masked by good numbers from unrelated surfaces.
	const worstLevel = worstHealthLevel(surfaceHealth);

	const collapsedPct = purgeTotal > 0 ? (((purgeSummary?.collapsed_count ?? 0) / purgeTotal) * 100).toFixed(1) : '0';

	// The query defaults to a 7-day window, but real data is often much
	// narrower (e.g. a fresh deployment, or a short test burst) -- title and
	// x-axis tick format should reflect the ACTUAL span, not the query default,
	// or a short-span chart shows misleading duplicate-looking date ticks.
	const chartSpanMs = timeseries.length > 1 ? timeseries[timeseries.length - 1].bucket - timeseries[0].bucket : 0;
	const chartSpanUnderOneDay = chartSpanMs > 0 && chartSpanMs < 24 * 60 * 60 * 1000;
	const chartRangeLabel = chartSpanUnderOneDay ? 'Last 24 Hours' : 'Last 7 Days';

	return (
		<TooltipProvider delayDuration={200}>
			<div className="space-y-6">
				{/* ── Refresh ────────────────────────────────────────────── */}
				<div className="flex justify-end">
					<button
						onClick={() => fetchData()}
						disabled={loading}
						className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
					>
						<RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
						Refresh
					</button>
				</div>

				{/* ── Error ──────────────────────────────────────────────── */}
				{error && <div className="rounded-lg border border-lv-red/30 bg-lv-red/10 px-4 py-3 text-sm text-lv-red">{error}</div>}

				{/* ── Loading ────────────────────────────────────────────── */}
				{loading && <LoadingSkeleton />}

				{/* ── Empty state ────────────────────────────────────────── */}
				{!loading && totalRequests === 0 && !error && (
					<div className="flex h-64 items-center justify-center">
						<p className={T.mutedSm}>No events recorded yet.</p>
					</div>
				)}

				{/* ── Data ───────────────────────────────────────────────── */}
				{!loading && totalRequests > 0 && (
					<>
						{/* Row 0: Per-surface health */}
						{surfaceHealth.length > 0 && (
							<Card>
								<CardHeader>
									<CardTitle className={T.sectionHeading}>
										<div className="flex items-center gap-2">
											<Activity className="h-4 w-4 text-muted-foreground" />
											Health
										</div>
									</CardTitle>
								</CardHeader>
								<CardContent className="p-0">
									<Table className="w-auto">
										<TableHeader>
											<TableRow>
												<TableHead className={cn(T.sectionLabel, 'w-40')}>Surface</TableHead>
												<TableHead className={cn(T.sectionLabel, 'text-right')}>Requests</TableHead>
												<TableHead className={cn(T.sectionLabel, 'text-right')}>Error %</TableHead>
												<TableHead className={cn(T.sectionLabel, 'text-right')}>5xx</TableHead>
												<TableHead className={cn(T.sectionLabel, 'pl-8')}>Signals</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{surfaceHealth.map((h) => (
												<TableRow key={h.surface}>
													<TableCell>
														<div className="flex items-center gap-2">
															<span className={cn('h-2 w-2 rounded-full', HEALTH_DOT[h.level])} />
															<span className={T.tableCellMono}>{h.label}</span>
														</div>
													</TableCell>
													<TableCell className={T.tableCellNumeric}>{formatNumber(h.total)}</TableCell>
													<TableCell className={cn(T.tableCellNumeric, h.errorRate >= WARN_ERROR_PCT && 'text-lv-red')}>
														{h.errorRate.toFixed(1)}%
													</TableCell>
													<TableCell className={cn(T.tableCellNumeric, h.count5xx > 0 && 'text-lv-red')}>{h.count5xx}</TableCell>
													<TableCell className="pl-8">
														{h.signals.length === 0 ? (
															<span className="text-muted-foreground/40">{'\u2014'}</span>
														) : (
															<div className="flex flex-wrap gap-1.5">
																{h.signals.map((sig) => (
																	<Badge key={sig} className="bg-lv-peach/20 text-lv-peach border-lv-peach/30">
																		{sig}
																	</Badge>
																))}
															</div>
														)}
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</CardContent>
							</Card>
						)}

						{/* Row 1: Aggregate stat cards (per-surface counts live in the Health table) */}
						<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
							<StatCard
								label="Total Requests"
								value={formatNumber(totalRequests)}
								icon={<Activity className="h-5 w-5 text-lv-green" />}
								iconBg="bg-lv-green/15"
							/>
							<StatCard
								label="Avg Latency"
								value={`${avgLatency} ms`}
								icon={<Timer className="h-5 w-5 text-lv-blue" />}
								iconBg="bg-lv-blue/15"
							/>
							<StatCard
								label="Error Rate"
								value={`${errorPct}%`}
								icon={<AlertTriangle className="h-5 w-5" />}
								iconBg="bg-lv-red/15"
								tone={worstLevel}
							/>
							<StatCard
								label="URLs Purged"
								value={formatNumber(purgeSummary?.total_urls_purged ?? 0)}
								icon={<Link className="h-5 w-5 text-lv-peach" />}
								iconBg="bg-lv-peach/15"
							/>
							<StatCard
								label="Collapsed %"
								value={`${collapsedPct}%`}
								icon={<Layers className="h-5 w-5 text-lv-blue" />}
								iconBg="bg-lv-blue/15"
							/>
						</div>

						{/* Row 2: Resource counts -- dense strip, not four full cards */}
						<div className="flex flex-col divide-y divide-border border border-border sm:flex-row sm:divide-x sm:divide-y-0">
							<ResourceStat
								label="Active Keys"
								value={String(resourceCounts.activeKeys)}
								icon={<Key className="h-4 w-4 text-lv-purple" />}
							/>
							<ResourceStat
								label="S3 Credentials"
								value={String(resourceCounts.activeS3Creds)}
								icon={<Shield className="h-4 w-4 text-lv-cyan" />}
							/>
							<ResourceStat
								label="Upstream Tokens"
								value={String(resourceCounts.activeUpstreamTokens)}
								icon={<Zap className="h-4 w-4 text-lv-peach" />}
							/>
							<ResourceStat
								label="Upstream R2"
								value={String(resourceCounts.activeUpstreamR2)}
								icon={<Database className="h-4 w-4 text-lv-green" />}
							/>
						</div>

						{/* Row 3: Request Volume Over Time */}
						{timeseries.length > 1 && (
							<Card>
								<CardHeader>
									<CardTitle className={T.sectionHeading}>Request Volume ({chartRangeLabel})</CardTitle>
								</CardHeader>
								<CardContent>
									<ResponsiveContainer width="100%" height={280}>
										<ComposedChart data={timeseries} margin={{ top: 4, right: 12, bottom: 0, left: 8 }}>
											<defs>
												<linearGradient id="gradTotal" x1="0" y1="0" x2="0" y2="1">
													<stop offset="0%" stopColor="#6fab58" stopOpacity={0.4} />
													<stop offset="100%" stopColor="#6fab58" stopOpacity={0} />
												</linearGradient>
											</defs>
											<CartesianGrid strokeDasharray="3 3" stroke="#3a342a" />
											<XAxis
												dataKey="bucket"
												tick={{ fontSize: 10, fill: '#8c8474' }}
												tickFormatter={(v: number) => {
													const d = new Date(v);
													// A chart spanning under a day formats every tick to the same
													// calendar date (e.g. two ticks both showing "Jul 1") -- show
													// time-of-day instead so ticks stay distinguishable.
													return chartSpanUnderOneDay
														? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
														: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
												}}
												interval="preserveStartEnd"
												minTickGap={60}
											/>
											<YAxis yAxisId="left" tick={{ fontSize: 10, fill: '#8c8474' }} width={50} />
											{/* Errors get their own scale -- on the shared axis a handful of errors
											    against hundreds of total requests renders as a flat line pinned to
											    zero, hiding the exact incident this chart most needs to surface. */}
											<YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: '#ff5460' }} width={40} allowDecimals={false} />
											<Tooltip
												contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
												itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
												labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
												labelFormatter={(v: number) =>
													new Date(v).toLocaleString('en-US', {
														month: 'short',
														day: 'numeric',
														hour: '2-digit',
														minute: '2-digit',
														hour12: false,
													})
												}
												formatter={(value: number, name: string) => [formatNumber(value), name === 'total' ? 'Requests' : 'Errors']}
											/>
											<Area yAxisId="left" type="monotone" dataKey="total" stroke="#6fab58" fill="url(#gradTotal)" strokeWidth={2} dot={false} />
											{/* Line, not Area -- on its own independent right-axis scale, a filled
											    Area would visually dominate the chart despite representing far
											    fewer absolute requests than the total-volume series on the left. */}
											<Line yAxisId="right" type="monotone" dataKey="errors" stroke="#ff5460" strokeWidth={1.5} dot={false} />
										</ComposedChart>
									</ResponsiveContainer>
								</CardContent>
							</Card>
						)}

						{/* Collapsible Analytics Breakdown */}
						<button
							onClick={() => setChartsOpen(!chartsOpen)}
							className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
						>
							{chartsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
							Analytics Breakdown
						</button>

						{chartsOpen && (
							<>
								{/* Row 3: Charts — Traffic split + Status breakdown */}
								<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
									{/* Traffic split pie */}
									<Card>
										<CardHeader>
											<CardTitle className={T.sectionHeading}>Traffic Split</CardTitle>
										</CardHeader>
										<CardContent>
											{trafficPie.length === 0 ? (
												<p className={cn(T.muted, 'py-12 text-center')}>No data</p>
											) : (
												<DonutPie data={trafficPie} colorFor={(name) => TRAFFIC_COLORS[name] ?? '#7fa8c9'} />
											)}
										</CardContent>
									</Card>

									{/* Combined status breakdown */}
									<Card>
										<CardHeader>
											<CardTitle className={T.sectionHeading}>Status Breakdown</CardTitle>
										</CardHeader>
										<CardContent>
											{barData.length === 0 ? (
												<p className={cn(T.muted, 'py-12 text-center')}>No data</p>
											) : (
												<ResponsiveContainer width="100%" height={260}>
													<BarChart data={barData} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 8 }}>
														<XAxis type="number" tick={{ fontSize: T.chartAxisTick, fill: '#8c8474' }} />
														<YAxis type="category" dataKey="status" tick={{ fontSize: T.chartAxisTick, fill: '#8c8474' }} width={40} />
														<Tooltip
															contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
															itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
															labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
															formatter={(value: number) => [formatNumber(value), 'Requests']}
														/>
														<Bar dataKey="count" radius={[0, 4, 4, 0]}>
															{barData.map((entry) => (
																<Cell key={entry.status} fill={statusColor(entry.status)} />
															))}
														</Bar>
													</BarChart>
												</ResponsiveContainer>
											)}
										</CardContent>
									</Card>
								</div>

								{/* Row 4: Purge types + S3 operations */}
								<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
									{/* Purge type distribution */}
									{purgeTotal > 0 && (
										<Card>
											<CardHeader>
												<CardTitle className={T.sectionHeading}>Purge Type Distribution</CardTitle>
											</CardHeader>
											<CardContent>
												{purgeTypePie.length === 0 ? (
													<p className={cn(T.muted, 'py-12 text-center')}>No data</p>
												) : (
													<DonutPie
														data={purgeTypePie}
														colorFor={(name) => PURGE_TYPE_COLORS[name as keyof typeof PURGE_TYPE_COLORS] ?? '#7fa8c9'}
													/>
												)}
											</CardContent>
										</Card>
									)}

									{/* S3 operations breakdown */}
									{s3Total > 0 && (
										<Card>
											<CardHeader>
												<CardTitle className={T.sectionHeading}>S3 Operations</CardTitle>
											</CardHeader>
											<CardContent>
												{s3OpPie.length === 0 ? (
													<p className={cn(T.muted, 'py-12 text-center')}>No data</p>
												) : (
													<ResponsiveContainer width="100%" height={260}>
														<BarChart data={s3OpPie} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 8 }}>
															<XAxis type="number" tick={{ fontSize: T.chartAxisTick, fill: '#8c8474' }} />
															<YAxis type="category" dataKey="name" tick={{ fontSize: T.chartAxisTick, fill: '#8c8474' }} width={100} />
															<Tooltip
																contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
																itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
																labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
																formatter={(value: number) => [formatNumber(value), 'Requests']}
															/>
															<Bar dataKey="value" radius={[0, 4, 4, 0]}>
																{s3OpPie.map((entry, i) => (
																	<Cell key={entry.name} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
																))}
															</Bar>
														</BarChart>
													</ResponsiveContainer>
												)}
											</CardContent>
										</Card>
									)}

									{/* S3 bucket breakdown */}
									{s3Total > 0 && s3BucketPie.length > 0 && (
										<Card>
											<CardHeader>
												<CardTitle className={T.sectionHeading}>S3 Requests by Bucket</CardTitle>
											</CardHeader>
											<CardContent>
												<DonutPie data={s3BucketPie} colorFor={(_, i) => CHART_PALETTE[i % CHART_PALETTE.length]} />
											</CardContent>
										</Card>
									)}
									{/* DNS actions breakdown */}
									{dnsTotal > 0 && (
										<Card>
											<CardHeader>
												<CardTitle className={T.sectionHeading}>DNS Actions</CardTitle>
											</CardHeader>
											<CardContent>
												{dnsActionPie.length === 0 ? (
													<p className={cn(T.muted, 'py-12 text-center')}>No data</p>
												) : (
													<ResponsiveContainer width="100%" height={260}>
														<BarChart data={dnsActionPie} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 8 }}>
															<XAxis type="number" tick={{ fontSize: T.chartAxisTick, fill: '#8c8474' }} />
															<YAxis type="category" dataKey="name" tick={{ fontSize: T.chartAxisTick, fill: '#8c8474' }} width={100} />
															<Tooltip
																contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
																itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
																labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
																formatter={(value: number) => [formatNumber(value), 'Requests']}
															/>
															<Bar dataKey="value" radius={[0, 4, 4, 0]}>
																{dnsActionPie.map((entry, i) => (
																	<Cell key={entry.name} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
																))}
															</Bar>
														</BarChart>
													</ResponsiveContainer>
												)}
											</CardContent>
										</Card>
									)}

									{/* CF service breakdown */}
									{cfTotal > 0 && cfServicePie.length > 0 && (
										<Card>
											<CardHeader>
												<CardTitle className={T.sectionHeading}>CF Services</CardTitle>
											</CardHeader>
											<CardContent>
												<DonutPie data={cfServicePie} colorFor={(name) => CF_SERVICE_COLORS[name] ?? '#7fa8c9'} />
											</CardContent>
										</Card>
									)}

									{/* CF actions breakdown */}
									{cfTotal > 0 && cfActionPie.length > 0 && (
										<Card>
											<CardHeader>
												<CardTitle className={T.sectionHeading}>CF Actions</CardTitle>
											</CardHeader>
											<CardContent>
												<ResponsiveContainer width="100%" height={260}>
													<BarChart data={cfActionPie} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 8 }}>
														<XAxis type="number" tick={{ fontSize: T.chartAxisTick, fill: '#8c8474' }} />
														<YAxis type="category" dataKey="name" tick={{ fontSize: T.chartAxisTick, fill: '#8c8474' }} width={120} />
														<Tooltip
															contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
															itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
															labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
															formatter={(value: number) => [formatNumber(value), 'Requests']}
														/>
														<Bar dataKey="value" radius={[0, 4, 4, 0]}>
															{cfActionPie.map((entry, i) => (
																<Cell key={entry.name} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
															))}
														</Bar>
													</BarChart>
												</ResponsiveContainer>
											</CardContent>
										</Card>
									)}
									{supaTotal > 0 && supaCategoryPie.length > 0 && (
										<Card>
											<CardHeader>
												<CardTitle className={T.sectionHeading}>Supabase Categories</CardTitle>
											</CardHeader>
											<CardContent>
												<ResponsiveContainer width="100%" height={260}>
													<BarChart data={supaCategoryPie} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 8 }}>
														<XAxis type="number" tick={{ fontSize: T.chartAxisTick, fill: '#8c8474' }} />
														<YAxis type="category" dataKey="name" tick={{ fontSize: T.chartAxisTick, fill: '#8c8474' }} width={120} />
														<Tooltip
															contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
															itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
															labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
															formatter={(value: number) => [formatNumber(value), 'Requests']}
														/>
														<Bar dataKey="value" radius={[0, 4, 4, 0]}>
															{supaCategoryPie.map((entry, i) => (
																<Cell key={entry.name} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
															))}
														</Bar>
													</BarChart>
												</ResponsiveContainer>
											</CardContent>
										</Card>
									)}
								</div>
							</>
						)}

						{/* Row 5: Recent Events */}
						<Card>
							<CardHeader className="flex flex-row items-center justify-between">
								<CardTitle className={T.sectionHeading}>Recent Events</CardTitle>
								<a
									href="/dashboard/analytics/"
									className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
								>
									View all <ArrowRight className="h-3 w-3" />
								</a>
							</CardHeader>
							<CardContent>
								{recentEvents.length === 0 ? (
									<p className={cn(T.mutedSm, 'py-8 text-center')}>No recent events</p>
								) : (
									<div className="space-y-2">
										{recentEvents.map((ev) => (
											<div key={ev.id} className="flex items-center gap-3 rounded-md border border-border/50 bg-card/50 px-3 py-2 text-sm">
												<WithTip tip={sourceTip(ev.source)}>
													<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/50">
														{sourceIcon(ev.source)}
													</div>
												</WithTip>
												<StatusBadge status={ev.status} />
												{ev.detailFull ? (
													<WithTip tip={ev.detailFull}>
														<span className="font-mono text-xs text-foreground truncate max-w-[260px]">{ev.detail}</span>
													</WithTip>
												) : (
													<span className="font-mono text-xs text-foreground truncate max-w-[260px]">{ev.detail}</span>
												)}
												<span className="hidden text-xs text-muted-foreground sm:inline">
													<Clock className="mr-1 inline h-3 w-3" />
													{ev.duration_ms}ms
												</span>
												<code className="hidden text-xs text-muted-foreground lg:inline">{ev.identity}</code>
												<span className="ml-auto text-xs text-muted-foreground">{formatTimeShort(ev.created_at)}</span>
											</div>
										))}
									</div>
								)}
							</CardContent>
						</Card>
					</>
				)}
			</div>
		</TooltipProvider>
	);
}
