import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronRight, ChevronsDownUp, Clock, Copy, Download, Search, ArrowUpDown, ArrowUp, ArrowDown, Server } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TooltipProvider } from '@/components/ui/tooltip';
import { usePagination } from '@/hooks/use-pagination';
import { TablePagination } from '@/components/TablePagination';
import { getCfProxyEvents, getCfProxySummary } from '@/lib/api';
import { cn } from '@/lib/utils';
import { T } from '@/lib/typography';
import { WithTooltip, statusBadge } from './analytics/analytics-badges';
import { formatTime, formatTimeISO, truncateId, exportToJson, copyToClipboard } from './analytics/analytics-helpers';
import { EventsTableSkeleton } from './analytics/EventsTableSkeleton';
import type { CfProxyEvent, CfProxyAnalyticsSummary } from '@/lib/api';

// ─── Types ──────────────────────────────────────────────────────────

/** Format byte count to human-readable string. */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

type SortField = 'created_at' | 'status' | 'duration_ms' | 'service';
type SortDir = 'asc' | 'desc';
type ServiceFilter = 'all' | 'd1' | 'kv' | 'workers' | 'queues' | 'vectorize' | 'hyperdrive' | 'dns';
type StatusFilter = 'all' | '2xx' | '4xx' | '5xx';

const SERVICE_LABELS: Record<ServiceFilter, string> = {
	all: 'All',
	d1: 'D1',
	kv: 'KV',
	workers: 'Workers',
	queues: 'Queues',
	vectorize: 'Vectorize',
	hyperdrive: 'Hyperdrive',
	dns: 'DNS',
};

const SERVICE_BADGE_CLASSES: Record<string, string> = {
	d1: 'bg-lv-purple/20 text-lv-purple border-lv-purple/30',
	kv: 'bg-lv-cyan/20 text-lv-cyan border-lv-cyan/30',
	workers: 'bg-lv-green/20 text-lv-green border-lv-green/30',
	queues: 'bg-lv-peach/20 text-lv-peach border-lv-peach/30',
	vectorize: 'bg-lv-blue/20 text-lv-blue border-lv-blue/30',
	hyperdrive: 'bg-lv-red-bright/20 text-lv-red-bright border-lv-red-bright/30',
	dns: 'bg-lv-green/20 text-lv-green border-lv-green/30',
};

const LIMIT_OPTIONS = [50, 100, 500] as const;

// ─── Detail row ─────────────────────────────────────────────────────

function CfDetailRow({ event }: { event: CfProxyEvent }) {
	const fields = [
		{ key: 'id', value: event.id, cls: 'text-lv-purple' },
		{ key: 'key_id', value: event.key_id, cls: 'text-lv-cyan' },
		{ key: 'account_id', value: event.account_id, cls: 'text-lv-cyan' },
		{ key: 'service', value: event.service, cls: 'text-lv-green font-medium' },
		{ key: 'action', value: event.action, cls: 'text-lv-green font-medium' },
		{ key: 'resource_id', value: event.resource_id, cls: 'text-lv-cyan' },
		{ key: 'status', value: event.status, cls: event.status >= 400 ? 'text-lv-red font-semibold' : 'text-lv-green font-semibold' },
		{
			key: 'upstream_status',
			value: event.upstream_status,
			cls: event.upstream_status && event.upstream_status >= 400 ? 'text-lv-red font-semibold' : 'text-lv-green font-semibold',
		},
		{ key: 'duration_ms', value: `${event.duration_ms} ms`, cls: 'text-lv-peach' },
		{
			key: 'upstream_latency_ms',
			value: event.upstream_latency_ms != null ? `${event.upstream_latency_ms} ms` : null,
			cls: 'text-lv-peach',
		},
		{ key: 'response_size', value: event.response_size != null ? formatBytes(event.response_size) : null, cls: 'text-lv-blue' },
		{ key: 'created_by', value: event.created_by, cls: 'text-lv-cyan' },
		{ key: 'response_detail', value: event.response_detail, cls: 'text-foreground' },
		{ key: 'created_at', value: formatTimeISO(event.created_at), cls: 'text-lv-blue' },
	];

	return (
		<TableRow className="bg-muted/30 hover:bg-muted/40 border-b border-border/50">
			<TableCell colSpan={7} className="px-6 py-3">
				<div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 max-w-2xl">
					{fields.map((f) => (
						<div key={f.key} className="contents">
							<span className="text-[11px] font-data text-muted-foreground/70 select-none">{f.key}</span>
							<span className={cn('text-[11px] font-data break-all select-all', f.cls)}>
								{f.value === null || f.value === undefined ? (
									<span className="italic text-muted-foreground/40">null</span>
								) : (
									String(f.value)
								)}
							</span>
						</div>
					))}
				</div>
			</TableCell>
		</TableRow>
	);
}

// ─── Summary cards ──────────────────────────────────────────────────

function SummaryCards({ summary }: { summary: CfProxyAnalyticsSummary | null }) {
	if (!summary) return null;
	const successCount = Object.entries(summary.by_status)
		.filter(([s]) => Number(s) >= 200 && Number(s) < 300)
		.reduce((a, [, c]) => a + c, 0);
	const errorCount = summary.total_requests - successCount;

	return (
		<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
			<Card>
				<CardContent className="pt-4 pb-3 px-4">
					<p className={T.mutedSm}>Total Requests</p>
					<p className={T.statValue}>{summary.total_requests.toLocaleString()}</p>
				</CardContent>
			</Card>
			<Card>
				<CardContent className="pt-4 pb-3 px-4">
					<p className={T.mutedSm}>Success / Error</p>
					<p className={T.statValue}>
						<span className="text-lv-green">{successCount.toLocaleString()}</span>
						<span className="text-muted-foreground mx-1">/</span>
						<span className="text-lv-red">{errorCount.toLocaleString()}</span>
					</p>
				</CardContent>
			</Card>
			<Card>
				<CardContent className="pt-4 pb-3 px-4">
					<p className={T.mutedSm}>Avg Duration</p>
					<p className={T.statValue}>{summary.avg_duration_ms} ms</p>
				</CardContent>
			</Card>
			<Card>
				<CardContent className="pt-4 pb-3 px-4">
					<p className={T.mutedSm}>Avg Upstream Latency</p>
					<p className={T.statValue}>{summary.avg_upstream_latency_ms} ms</p>
				</CardContent>
			</Card>
			<Card>
				<CardContent className="pt-4 pb-3 px-4">
					<p className={T.mutedSm}>Avg Response Size</p>
					<p className={T.statValue}>{formatBytes(summary.avg_response_size)}</p>
				</CardContent>
			</Card>
			<Card>
				<CardContent className="pt-4 pb-3 px-4">
					<p className={T.mutedSm}>Services</p>
					<p className={T.statValue}>{Object.keys(summary.by_service).length}</p>
				</CardContent>
			</Card>
		</div>
	);
}

// ─── Main page ──────────────────────────────────────────────────────

export function CfProxyAnalyticsPage() {
	const [events, setEvents] = useState<CfProxyEvent[]>([]);
	const [summary, setSummary] = useState<CfProxyAnalyticsSummary | null>(null);
	const [limit, setLimit] = useState<number>(100);
	const [serviceFilter, setServiceFilter] = useState<ServiceFilter>('all');
	const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
	const [search, setSearch] = useState('');
	const [sortField, setSortField] = useState<SortField>('created_at');
	const [sortDir, setSortDir] = useState<SortDir>('desc');
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
	const [copied, setCopied] = useState(false);

	const toggleExpanded = (id: number) => {
		setExpandedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const fetchData = useCallback(async (fetchLimit: number) => {
		setLoading(true);
		setError(null);
		try {
			const [evts, sum] = await Promise.all([getCfProxyEvents({ limit: fetchLimit }), getCfProxySummary()]);
			setEvents(evts);
			setSummary(sum);
		} catch (e: any) {
			setError(e.message ?? 'Failed to load CF proxy events');
			setEvents([]);
			setSummary(null);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchData(limit);
	}, [fetchData, limit]);

	// ── Sorting ─────────────────────────────────────────────────

	const toggleSort = (field: SortField) => {
		if (sortField === field) {
			setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
		} else {
			setSortField(field);
			setSortDir(field === 'service' ? 'asc' : 'desc');
		}
	};

	const SortIcon = ({ field }: { field: SortField }) => {
		if (sortField !== field) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
		return sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
	};

	const sortableProps = (field: SortField) => ({
		role: 'button' as const,
		tabIndex: 0,
		'aria-sort': (sortField === field ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none') as 'ascending' | 'descending' | 'none',
		onClick: () => toggleSort(field),
		onKeyDown: (e: React.KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				toggleSort(field);
			}
		},
	});

	// ── Filtered + sorted events ────────────────────────────────

	const filteredEvents = useMemo(() => {
		let result = events;

		if (serviceFilter !== 'all') result = result.filter((e) => e.service === serviceFilter);

		if (statusFilter !== 'all') {
			result = result.filter((e) => {
				if (statusFilter === '2xx') return e.status >= 200 && e.status < 300;
				if (statusFilter === '4xx') return e.status >= 400 && e.status < 500;
				if (statusFilter === '5xx') return e.status >= 500;
				return true;
			});
		}

		if (search.trim()) {
			const q = search.toLowerCase();
			result = result.filter((e) =>
				[e.key_id, e.account_id, e.service, e.action, e.resource_id, e.created_by, e.response_detail, String(e.status)]
					.filter(Boolean)
					.join(' ')
					.toLowerCase()
					.includes(q),
			);
		}

		return result;
	}, [events, serviceFilter, statusFilter, search]);

	const sortedEvents = useMemo(() => {
		const sorted = [...filteredEvents];
		sorted.sort((a, b) => {
			let cmp = 0;
			switch (sortField) {
				case 'created_at':
					cmp = a.created_at - b.created_at;
					break;
				case 'status':
					cmp = a.status - b.status;
					break;
				case 'duration_ms':
					cmp = a.duration_ms - b.duration_ms;
					break;
				case 'service':
					cmp = a.service.localeCompare(b.service);
					break;
			}
			return sortDir === 'asc' ? cmp : -cmp;
		});
		return sorted;
	}, [filteredEvents, sortField, sortDir]);

	const {
		pageItems,
		page: pgPage,
		pageSize: pgSize,
		totalItems: pgTotal,
		totalPages: pgTotalPages,
		pageSizeOptions: pgSizeOptions,
		setPage: pgSetPage,
		setPageSize: pgSetPageSize,
	} = usePagination(sortedEvents, { defaultPageSize: 50 });

	// ── Service counts for tabs ─────────────────────────────────

	const serviceCounts = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const ev of events) {
			counts[ev.service] = (counts[ev.service] ?? 0) + 1;
		}
		return counts;
	}, [events]);

	// ── Export ───────────────────────────────────────────────────

	const handleCopy = () => {
		copyToClipboard(filteredEvents.map((e) => ({ ...e, source: 'cf' }) as any));
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const handleExport = () => {
		const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const suffix = serviceFilter === 'all' ? 'all' : serviceFilter;
		exportToJson(
			filteredEvents.map((e) => ({ ...e, source: 'cf', raw: e }) as any),
			`gatekeeper-cf-proxy-${suffix}-${ts}.json`,
		);
	};

	return (
		<TooltipProvider delayDuration={200}>
			<div className="space-y-6">
				{/* ── Summary ────────────────────────────────────────── */}
				<SummaryCards summary={summary} />

				{/* ── Controls row 1: service tabs + status filter ──── */}
				<div className="flex flex-wrap items-center gap-3">
					{/* Service tabs */}
					<div className="flex rounded-md border border-border">
						{(Object.keys(SERVICE_LABELS) as ServiceFilter[]).map((s, i) => {
							const count = s === 'all' ? events.length : (serviceCounts[s] ?? 0);
							if (s !== 'all' && count === 0) return null;
							return (
								<button
									key={s}
									onClick={() => setServiceFilter(s)}
									className={cn(
										'px-3 py-1 text-xs font-data transition-colors',
										serviceFilter === s ? 'bg-lv-purple/20 text-lv-purple' : 'text-muted-foreground hover:text-foreground hover:bg-muted',
										i !== 0 && 'border-l border-border',
									)}
								>
									{SERVICE_LABELS[s]} ({count})
								</button>
							);
						})}
					</div>

					{/* Status filter */}
					<div className="flex rounded-md border border-border">
						{(['all', '2xx', '4xx', '5xx'] as StatusFilter[]).map((s) => (
							<button
								key={s}
								onClick={() => setStatusFilter(s)}
								className={cn(
									'px-3 py-1 text-xs font-data transition-colors',
									statusFilter === s ? 'bg-lv-purple/20 text-lv-purple' : 'text-muted-foreground hover:text-foreground hover:bg-muted',
									s !== 'all' && 'border-l border-border',
								)}
							>
								{s === 'all' ? 'Any status' : s}
							</button>
						))}
					</div>

					{/* Export controls */}
					{filteredEvents.length > 0 && (
						<div className="flex items-center gap-1">
							<Button variant="ghost" size="sm" className="h-7 gap-1 text-xs text-muted-foreground" onClick={handleCopy}>
								<Copy className="h-3 w-3" />
								{copied ? 'Copied' : 'Copy JSON'}
							</Button>
							<Button variant="ghost" size="sm" className="h-7 gap-1 text-xs text-muted-foreground" onClick={handleExport}>
								<Download className="h-3 w-3" />
								Export
							</Button>
						</div>
					)}

					{/* Limit selector */}
					<div className="ml-auto flex items-center gap-2">
						<span className={T.formLabel}>Limit</span>
						<div className="flex rounded-md border border-border">
							{LIMIT_OPTIONS.map((opt) => (
								<button
									key={opt}
									onClick={() => setLimit(opt)}
									className={cn(
										'px-3 py-1 text-xs font-data transition-colors',
										limit === opt ? 'bg-lv-purple/20 text-lv-purple' : 'text-muted-foreground hover:text-foreground hover:bg-muted',
										opt !== LIMIT_OPTIONS[0] && 'border-l border-border',
									)}
								>
									{opt}
								</button>
							))}
						</div>
					</div>
				</div>

				{/* ── Controls row 2: search ─────────────────────────── */}
				<div className="flex items-center gap-3">
					<div className="relative flex-1 max-w-sm">
						<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
						<Input
							placeholder="Search by key, account, service, action, resource..."
							value={search}
							onChange={(e: any) => setSearch(e.target.value)}
							className="pl-8 h-8 text-xs font-data"
						/>
					</div>
					{(search || statusFilter !== 'all' || serviceFilter !== 'all') && (
						<span className="text-xs text-muted-foreground font-data">
							{filteredEvents.length} of {events.length} events
						</span>
					)}
				</div>

				{/* ── Error ──────────────────────────────────────────── */}
				{error && <div className="rounded-lg border border-lv-red/30 bg-lv-red/10 px-4 py-3 text-sm text-lv-red">{error}</div>}

				{/* ── Loading ────────────────────────────────────────── */}
				{loading && <EventsTableSkeleton />}

				{/* ── Empty state ────────────────────────────────────── */}
				{!loading && filteredEvents.length === 0 && !error && (
					<div className="flex h-48 items-center justify-center">
						<p className={T.mutedSm}>{events.length === 0 ? 'No CF proxy events recorded yet.' : 'No events match the current filters.'}</p>
					</div>
				)}

				{/* ── Events table ───────────────────────────────────── */}
				{!loading && filteredEvents.length > 0 && (
					<Card>
						<CardHeader>
							<div className="flex items-center justify-between">
								<CardTitle className={T.sectionHeading}>
									<div className="flex items-center gap-2">
										<Server className="h-4 w-4 text-muted-foreground" />
										Events ({filteredEvents.length}
										{filteredEvents.length !== events.length ? ` of ${events.length}` : ''})
									</div>
								</CardTitle>
								{expandedIds.size > 0 && (
									<Button
										variant="ghost"
										size="xs"
										className="text-muted-foreground hover:text-foreground"
										onClick={() => setExpandedIds(new Set())}
										title="Collapse all expanded rows"
									>
										<ChevronsDownUp className="h-3 w-3 mr-1" />
										Collapse ({expandedIds.size})
									</Button>
								)}
							</div>
						</CardHeader>
						<CardContent className="p-0">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className={cn(T.sectionLabel, 'w-6')} />
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} {...sortableProps('created_at')}>
											<span className="flex items-center gap-1">
												Time <SortIcon field="created_at" />
											</span>
										</TableHead>
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} {...sortableProps('service')}>
											<span className="flex items-center gap-1">
												Service <SortIcon field="service" />
											</span>
										</TableHead>
										<TableHead className={T.sectionLabel}>Key</TableHead>
										<TableHead className={T.sectionLabel}>Action / Resource</TableHead>
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} {...sortableProps('status')}>
											<span className="flex items-center gap-1">
												Status <SortIcon field="status" />
											</span>
										</TableHead>
										<TableHead className={cn(T.sectionLabel, 'text-right cursor-pointer select-none')} {...sortableProps('duration_ms')}>
											<span className="flex items-center justify-end gap-1">
												Duration <SortIcon field="duration_ms" />
											</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{pageItems.map((ev) => {
										const isExpanded = expandedIds.has(ev.id);
										return (
											<>
												<TableRow key={ev.id} className="cursor-pointer select-none" onClick={() => toggleExpanded(ev.id)}>
													<TableCell className="w-6 px-2">
														<ChevronRight
															className={cn(
																'h-3.5 w-3.5 text-muted-foreground transition-transform duration-150',
																isExpanded && 'rotate-90',
															)}
														/>
													</TableCell>
													<TableCell className={T.tableCellMono}>{formatTime(ev.created_at)}</TableCell>
													<TableCell>
														<Badge
															className={cn(
																SERVICE_BADGE_CLASSES[ev.service] ?? 'bg-muted/20 text-muted-foreground border-muted/30',
																'shrink-0',
															)}
														>
															{ev.service}
														</Badge>
													</TableCell>
													<TableCell>
														<code className={T.tableCellMono} title={ev.key_id}>
															{truncateId(ev.key_id, 10)}
														</code>
													</TableCell>
													<TableCell>
														<div className="flex items-center gap-2 min-w-0">
															<WithTooltip tip={ev.action}>
																<Badge className="bg-muted/30 text-foreground border-muted/40 shrink-0">{ev.action}</Badge>
															</WithTooltip>
															{ev.resource_id && (
																<WithTooltip tip={`Resource: ${ev.resource_id}`}>
																	<code className={cn(T.tableCellMono, 'truncate max-w-[180px] text-lv-cyan/80')}>
																		{truncateId(ev.resource_id, 16)}
																	</code>
																</WithTooltip>
															)}
														</div>
													</TableCell>
													<TableCell>{statusBadge(ev.status)}</TableCell>
													<TableCell className={T.tableCellNumeric}>{ev.duration_ms.toFixed(0)} ms</TableCell>
												</TableRow>
												{isExpanded && <CfDetailRow key={`${ev.id}-detail`} event={ev} />}
											</>
										);
									})}
								</TableBody>
							</Table>
							<TablePagination
								page={pgPage}
								totalPages={pgTotalPages}
								totalItems={pgTotal}
								pageSize={pgSize}
								pageSizeOptions={pgSizeOptions}
								onPageChange={pgSetPage}
								onPageSizeChange={pgSetPageSize}
								noun="events"
							/>
						</CardContent>
					</Card>
				)}
			</div>
		</TooltipProvider>
	);
}
