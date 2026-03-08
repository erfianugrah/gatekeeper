import { useState, useEffect, useCallback } from 'react';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
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
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip as UiTooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
	getSummary,
	getS3Summary,
	getDnsSummary,
	getEvents,
	getS3Events,
	getDnsEvents,
	listKeys,
	listS3Credentials,
	listUpstreamTokens,
	listUpstreamR2,
} from '@/lib/api';
import type { AnalyticsSummary, S3AnalyticsSummary, DnsAnalyticsSummary, PurgeEvent, S3Event, DnsEvent } from '@/lib/api';
import { cn } from '@/lib/utils';
import { STATUS_COLORS, PURGE_TYPE_COLORS, CHART_PALETTE, CHART_TOOLTIP_STYLE } from '@/lib/utils';
import { T } from '@/lib/typography';

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
	delay: number;
}

function StatCard({ label, value, icon, iconBg, delay }: StatCardProps) {
	return (
		<Card className="animate-fade-in-up opacity-0" style={{ animationDelay: `${delay}ms` }}>
			<CardContent className="flex items-center gap-4 p-5">
				<div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', iconBg)}>{icon}</div>
				<div className="min-w-0">
					<p className={T.statLabelUpper}>{label}</p>
					<p className={T.statValue}>{value}</p>
				</div>
			</CardContent>
		</Card>
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
	source: 'purge' | 's3' | 'dns';
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

// ─── Overview Dashboard ─────────────────────────────────────────────

export function OverviewDashboard() {
	const [purgeSummary, setPurgeSummary] = useState<AnalyticsSummary | null>(null);
	const [s3Summary, setS3Summary] = useState<S3AnalyticsSummary | null>(null);
	const [dnsSummary, setDnsSummary] = useState<DnsAnalyticsSummary | null>(null);
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

	const fetchData = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [purge, s3, dns, purgeEvents, s3Events, dnsEvents, keys, s3Creds, upTokens, upR2] = await Promise.all([
				getSummary().catch(() => null),
				getS3Summary().catch(() => null),
				getDnsSummary().catch(() => null),
				getEvents({ limit: 10 }).catch(() => [] as PurgeEvent[]),
				getS3Events({ limit: 10 }).catch(() => [] as S3Event[]),
				getDnsEvents({ limit: 10 }).catch(() => [] as DnsEvent[]),
				listKeys().catch(() => []),
				listS3Credentials().catch(() => []),
				listUpstreamTokens().catch(() => []),
				listUpstreamR2().catch(() => []),
			]);
			if (!purge && !s3 && !dns) {
				throw new Error('Failed to load analytics from all endpoints');
			}
			setPurgeSummary(purge);
			setS3Summary(s3);
			setDnsSummary(dns);

			// Merge and sort recent events
			const all: RecentEvent[] = [...purgeEvents.map(fromPurgeRecent), ...s3Events.map(fromS3Recent), ...dnsEvents.map(fromDnsRecent)]
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
	const totalRequests = purgeTotal + s3Total + dnsTotal;

	// Combined status breakdown
	const mergedStatus = mergeByStatus(purgeSummary?.by_status ?? {}, s3Summary?.by_status ?? {}, dnsSummary?.by_status ?? {});
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

	// Traffic split (purge vs s3 vs dns)
	const trafficPie = [
		...(purgeTotal > 0 ? [{ name: 'Purge', value: purgeTotal }] : []),
		...(s3Total > 0 ? [{ name: 'S3', value: s3Total }] : []),
		...(dnsTotal > 0 ? [{ name: 'DNS', value: dnsTotal }] : []),
	];
	const TRAFFIC_COLORS: Record<string, string> = {
		Purge: '#c574dd',
		S3: '#79e6f3',
		DNS: '#a6e3a1',
	};

	// Combined avg latency
	const avgLatency =
		totalRequests > 0
			? Math.round(
					((purgeSummary?.avg_duration_ms ?? 0) * purgeTotal +
						(s3Summary?.avg_duration_ms ?? 0) * s3Total +
						(dnsSummary?.avg_duration_ms ?? 0) * dnsTotal) /
						totalRequests,
				)
			: 0;

	// Error stats
	const errorCount = Object.entries(mergedStatus)
		.filter(([s]) => Number(s) >= 400)
		.reduce((acc, [, v]) => acc + v, 0);
	const errorPct = totalRequests > 0 ? ((errorCount / totalRequests) * 100).toFixed(1) : '0';

	const collapsedPct = purgeTotal > 0 ? (((purgeSummary?.collapsed_count ?? 0) / purgeTotal) * 100).toFixed(1) : '0';

	return (
		<TooltipProvider delayDuration={200}>
			<div className="space-y-6">
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
						{/* Row 1: Traffic stat cards */}
						<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
							<StatCard
								label="Total Requests"
								value={formatNumber(totalRequests)}
								icon={<Activity className="h-5 w-5 text-lv-green" />}
								iconBg="bg-lv-green/15"
								delay={0}
							/>
							<StatCard
								label="Purge Requests"
								value={formatNumber(purgeTotal)}
								icon={<Cloud className="h-5 w-5 text-lv-purple" />}
								iconBg="bg-lv-purple/15"
								delay={60}
							/>
							<StatCard
								label="S3 Requests"
								value={formatNumber(s3Total)}
								icon={<HardDrive className="h-5 w-5 text-lv-cyan" />}
								iconBg="bg-lv-cyan/15"
								delay={120}
							/>
							<StatCard
								label="DNS Requests"
								value={formatNumber(dnsTotal)}
								icon={<Globe className="h-5 w-5 text-lv-green" />}
								iconBg="bg-lv-green/15"
								delay={150}
							/>
							<StatCard
								label="Avg Latency"
								value={`${avgLatency} ms`}
								icon={<Timer className="h-5 w-5 text-lv-blue" />}
								iconBg="bg-lv-blue/15"
								delay={180}
							/>
							<StatCard
								label="Error Rate"
								value={`${errorPct}%`}
								icon={<AlertTriangle className="h-5 w-5 text-lv-red" />}
								iconBg="bg-lv-red/15"
								delay={240}
							/>
							<StatCard
								label="URLs Purged"
								value={formatNumber(purgeSummary?.total_urls_purged ?? 0)}
								icon={<Link className="h-5 w-5 text-lv-peach" />}
								iconBg="bg-lv-peach/15"
								delay={300}
							/>
							<StatCard
								label="Collapsed %"
								value={`${collapsedPct}%`}
								icon={<Layers className="h-5 w-5 text-lv-blue" />}
								iconBg="bg-lv-blue/15"
								delay={360}
							/>
						</div>

						{/* Row 2: Resource counts */}
						<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
							<StatCard
								label="Active Keys"
								value={String(resourceCounts.activeKeys)}
								icon={<Key className="h-5 w-5 text-lv-purple" />}
								iconBg="bg-lv-purple/15"
								delay={80}
							/>
							<StatCard
								label="S3 Credentials"
								value={String(resourceCounts.activeS3Creds)}
								icon={<Shield className="h-5 w-5 text-lv-cyan" />}
								iconBg="bg-lv-cyan/15"
								delay={140}
							/>
							<StatCard
								label="Upstream Tokens"
								value={String(resourceCounts.activeUpstreamTokens)}
								icon={<Zap className="h-5 w-5 text-lv-peach" />}
								iconBg="bg-lv-peach/15"
								delay={200}
							/>
							<StatCard
								label="Upstream R2"
								value={String(resourceCounts.activeUpstreamR2)}
								icon={<Database className="h-5 w-5 text-lv-green" />}
								iconBg="bg-lv-green/15"
								delay={260}
							/>
						</div>

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
										<ResponsiveContainer width="100%" height={260}>
											<PieChart>
												<Pie
													data={trafficPie}
													cx="50%"
													cy="50%"
													innerRadius={60}
													outerRadius={100}
													paddingAngle={4}
													dataKey="value"
													nameKey="name"
													label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
													labelLine={false}
													fontSize={T.chartLabel}
												>
													{trafficPie.map((entry) => (
														<Cell key={entry.name} fill={TRAFFIC_COLORS[entry.name] ?? '#8796f4'} />
													))}
												</Pie>
												<Tooltip
													contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
													itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
													labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
												/>
											</PieChart>
										</ResponsiveContainer>
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
												<XAxis type="number" tick={{ fontSize: T.chartAxisTick, fill: '#bdbdc1' }} />
												<YAxis type="category" dataKey="status" tick={{ fontSize: T.chartAxisTick, fill: '#bdbdc1' }} width={40} />
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
											<ResponsiveContainer width="100%" height={260}>
												<PieChart>
													<Pie
														data={purgeTypePie}
														cx="50%"
														cy="50%"
														innerRadius={60}
														outerRadius={100}
														paddingAngle={4}
														dataKey="value"
														nameKey="name"
														label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
														labelLine={false}
														fontSize={T.chartLabel}
													>
														{purgeTypePie.map((entry) => (
															<Cell key={entry.name} fill={PURGE_TYPE_COLORS[entry.name as keyof typeof PURGE_TYPE_COLORS] ?? '#8796f4'} />
														))}
													</Pie>
													<Tooltip
														contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
														itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
														labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
													/>
												</PieChart>
											</ResponsiveContainer>
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
													<XAxis type="number" tick={{ fontSize: T.chartAxisTick, fill: '#bdbdc1' }} />
													<YAxis type="category" dataKey="name" tick={{ fontSize: T.chartAxisTick, fill: '#bdbdc1' }} width={100} />
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
										<ResponsiveContainer width="100%" height={260}>
											<PieChart>
												<Pie
													data={s3BucketPie}
													cx="50%"
													cy="50%"
													innerRadius={60}
													outerRadius={100}
													paddingAngle={4}
													dataKey="value"
													nameKey="name"
													label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
													labelLine={false}
													fontSize={T.chartLabel}
												>
													{s3BucketPie.map((entry, i) => (
														<Cell key={entry.name} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
													))}
												</Pie>
												<Tooltip
													contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
													itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
													labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
												/>
											</PieChart>
										</ResponsiveContainer>
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
													<XAxis type="number" tick={{ fontSize: T.chartAxisTick, fill: '#bdbdc1' }} />
													<YAxis type="category" dataKey="name" tick={{ fontSize: T.chartAxisTick, fill: '#bdbdc1' }} width={100} />
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
						</div>

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
												<WithTip
													tip={
														ev.source === 'purge'
															? 'Cache purge request'
															: ev.source === 'dns'
																? 'DNS record operation'
																: 'S3/R2 storage request'
													}
												>
													<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/50">
														{ev.source === 'purge' ? (
															<Cloud className="h-3.5 w-3.5 text-lv-purple" />
														) : ev.source === 'dns' ? (
															<Globe className="h-3.5 w-3.5 text-lv-green" />
														) : (
															<HardDrive className="h-3.5 w-3.5 text-lv-cyan" />
														)}
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
