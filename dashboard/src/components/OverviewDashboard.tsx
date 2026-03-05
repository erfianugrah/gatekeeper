import { useState, useCallback } from "react";
import {
	PieChart,
	Pie,
	Cell,
	BarChart,
	Bar,
	XAxis,
	YAxis,
	Tooltip,
	ResponsiveContainer,
} from "recharts";
import {
	Activity,
	Link,
	Timer,
	Layers,
	AlertTriangle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getSummary } from "@/lib/api";
import type { AnalyticsSummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import { STATUS_COLORS, PURGE_TYPE_COLORS, CHART_TOOLTIP_STYLE } from "@/lib/utils";
import { T } from "@/lib/typography";

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
		<Card
			className="animate-fade-in-up opacity-0"
			style={{ animationDelay: `${delay}ms` }}
		>
			<CardContent className="flex items-center gap-4 p-5">
				<div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", iconBg)}>
					{icon}
				</div>
				<div className="min-w-0">
					<p className={T.statLabelUpper}>{label}</p>
					<p className={T.statValue}>{value}</p>
				</div>
			</CardContent>
		</Card>
	);
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
					<CardHeader><Skeleton className="h-4 w-40" /></CardHeader>
					<CardContent><Skeleton className="mx-auto h-52 w-52 rounded-full" /></CardContent>
				</Card>
				<Card>
					<CardHeader><Skeleton className="h-4 w-40" /></CardHeader>
					<CardContent><Skeleton className="h-52 w-full" /></CardContent>
				</Card>
			</div>
		</div>
	);
}

// ─── Overview Dashboard ─────────────────────────────────────────────

export function OverviewDashboard() {
	const [zoneId, setZoneId] = useState("");
	const [inputValue, setInputValue] = useState("");
	const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const fetchData = useCallback(async (zone: string) => {
		if (!zone.trim()) return;
		setZoneId(zone.trim());
		setLoading(true);
		setError(null);
		try {
			const data = await getSummary({ zone_id: zone.trim() });
			setSummary(data);
		} catch (e: any) {
			setError(e.message ?? "Failed to load summary");
			setSummary(null);
		} finally {
			setLoading(false);
		}
	}, []);

	const handleSubmit = () => fetchData(inputValue);
	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") fetchData(inputValue);
	};

	// ── Derived chart data ─────────────────────────────────────────

	const pieData = summary
		? Object.entries(summary.by_purge_type).map(([name, value]) => ({ name, value }))
		: [];

	const barData = summary
		? Object.entries(summary.by_status)
				.map(([status, count]) => ({ status, count }))
				.sort((a, b) => Number(a.status) - Number(b.status))
		: [];

	const totalRequests = summary?.total_requests ?? 0;
	const collapsedPct = totalRequests > 0
		? ((summary!.collapsed_count / totalRequests) * 100).toFixed(1)
		: "0";
	const errorCount = summary
		? Object.entries(summary.by_status)
				.filter(([s]) => Number(s) >= 400)
				.reduce((acc, [, v]) => acc + v, 0)
		: 0;
	const errorPct = totalRequests > 0
		? ((errorCount / totalRequests) * 100).toFixed(1)
		: "0";

	return (
		<div className="space-y-6">
			{/* ── Zone ID input ──────────────────────────────────────── */}
			<div className="flex items-center gap-3">
				<Input
					placeholder="Enter Zone ID..."
					value={inputValue}
					onChange={(e) => setInputValue(e.target.value)}
					onKeyDown={handleKeyDown}
					className="max-w-sm font-data"
				/>
				<Button onClick={handleSubmit} disabled={loading || !inputValue.trim()}>
					{loading ? "Loading..." : "Load"}
				</Button>
			</div>

			{/* ── Error ──────────────────────────────────────────────── */}
			{error && (
				<div className="rounded-lg border border-lv-red/30 bg-lv-red/10 px-4 py-3 text-sm text-lv-red">
					{error}
				</div>
			)}

			{/* ── Loading ────────────────────────────────────────────── */}
			{loading && <LoadingSkeleton />}

			{/* ── Empty state ────────────────────────────────────────── */}
			{!loading && !summary && !error && (
				<div className="flex h-64 items-center justify-center">
					<p className={T.mutedSm}>Enter a Zone ID to view the overview dashboard.</p>
				</div>
			)}

			{/* ── Data ───────────────────────────────────────────────── */}
			{!loading && summary && (
				<>
					{/* Stat cards */}
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
						<StatCard
							label="Total Requests"
							value={formatNumber(summary.total_requests)}
							icon={<Activity className="h-5 w-5 text-lv-green" />}
							iconBg="bg-lv-green/15"
							delay={0}
						/>
						<StatCard
							label="URLs Purged"
							value={formatNumber(summary.total_urls_purged)}
							icon={<Link className="h-5 w-5 text-lv-peach" />}
							iconBg="bg-lv-peach/15"
							delay={60}
						/>
						<StatCard
							label="Avg Latency"
							value={`${summary.avg_duration_ms.toFixed(0)} ms`}
							icon={<Timer className="h-5 w-5 text-lv-blue" />}
							iconBg="bg-lv-blue/15"
							delay={120}
						/>
						<StatCard
							label="Collapsed %"
							value={`${collapsedPct}%`}
							icon={<Layers className="h-5 w-5 text-lv-purple" />}
							iconBg="bg-lv-purple/15"
							delay={180}
						/>
						<StatCard
							label="Error Rate"
							value={`${errorPct}%`}
							icon={<AlertTriangle className="h-5 w-5 text-lv-red" />}
							iconBg="bg-lv-red/15"
							delay={240}
						/>
					</div>

					{/* Charts row */}
					<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
						{/* Purge type pie chart */}
						<Card>
							<CardHeader>
								<CardTitle className={T.sectionHeading}>Purge Type Distribution</CardTitle>
							</CardHeader>
							<CardContent>
								{pieData.length === 0 ? (
									<p className={cn(T.muted, "py-12 text-center")}>No data</p>
								) : (
									<ResponsiveContainer width="100%" height={260}>
										<PieChart>
											<Pie
												data={pieData}
												cx="50%"
												cy="50%"
												innerRadius={60}
												outerRadius={100}
												paddingAngle={4}
												dataKey="value"
												nameKey="name"
												label={({ name, percent }) =>
													`${name} ${(percent * 100).toFixed(0)}%`
												}
												labelLine={false}
												fontSize={T.chartLabel}
											>
												{pieData.map((entry) => (
													<Cell
														key={entry.name}
														fill={
															PURGE_TYPE_COLORS[entry.name as keyof typeof PURGE_TYPE_COLORS] ??
															"#8796f4"
														}
													/>
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

						{/* Status breakdown bar chart */}
						<Card>
							<CardHeader>
								<CardTitle className={T.sectionHeading}>Status Breakdown</CardTitle>
							</CardHeader>
							<CardContent>
								{barData.length === 0 ? (
									<p className={cn(T.muted, "py-12 text-center")}>No data</p>
								) : (
									<ResponsiveContainer width="100%" height={260}>
										<BarChart
											data={barData}
											layout="vertical"
											margin={{ top: 0, right: 12, bottom: 0, left: 8 }}
										>
											<XAxis type="number" tick={{ fontSize: T.chartAxisTick, fill: "#bdbdc1" }} />
											<YAxis
												type="category"
												dataKey="status"
												tick={{ fontSize: T.chartAxisTick, fill: "#bdbdc1" }}
												width={40}
											/>
											<Tooltip
												contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
												itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
												labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
												formatter={(value: number) => [formatNumber(value), "Requests"]}
											/>
											<Bar dataKey="count" radius={[0, 4, 4, 0]}>
												{barData.map((entry) => (
													<Cell
														key={entry.status}
														fill={statusColor(entry.status)}
													/>
												))}
											</Bar>
										</BarChart>
									</ResponsiveContainer>
								)}
							</CardContent>
						</Card>
					</div>
				</>
			)}
		</div>
	);
}
