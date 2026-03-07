import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronRight, Clock, Copy, Download, Search, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TooltipProvider } from '@/components/ui/tooltip';
import { usePagination } from '@/hooks/use-pagination';
import { TablePagination } from '@/components/TablePagination';
import { getEvents, getS3Events } from '@/lib/api';
import { cn } from '@/lib/utils';
import { T } from '@/lib/typography';
import { fromPurge, fromS3, groupByFlight, LIMIT_OPTIONS } from './analytics/analytics-types';
import { formatTime, truncateId, eventSearchText, exportToJson, copyToClipboard } from './analytics/analytics-helpers';
import {
	WithTooltip,
	PURGE_TYPE_TOOLTIPS,
	COLLAPSED_TOOLTIPS,
	purgeTypeBadgeClass,
	statusBadge,
	sourceBadge,
} from './analytics/analytics-badges';
import { EventDetailRow } from './analytics/EventDetailRow';
import { EventsTableSkeleton } from './analytics/EventsTableSkeleton';
import type { PurgeEvent, S3Event } from '@/lib/api';
import type { UnifiedEvent, FlightGroup, SortField, SortDir, TabFilter, StatusFilter } from './analytics/analytics-types';

// ─── Analytics Page ─────────────────────────────────────────────────

export function AnalyticsPage() {
	const [purgeEvents, setPurgeEvents] = useState<PurgeEvent[]>([]);
	const [s3Events, setS3Events] = useState<S3Event[]>([]);
	const [limit, setLimit] = useState<number>(100);
	const [tab, setTab] = useState<TabFilter>('all');
	const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
	const [search, setSearch] = useState('');
	const [sortField, setSortField] = useState<SortField>('created_at');
	const [sortDir, setSortDir] = useState<SortDir>('desc');
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
	const [copied, setCopied] = useState(false);

	const toggleExpanded = (key: string) => {
		setExpandedIds((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const fetchData = useCallback(async (fetchLimit: number) => {
		setLoading(true);
		setError(null);
		const errors: string[] = [];
		try {
			const [purge, s3] = await Promise.all([
				getEvents({ limit: fetchLimit }).catch((e) => {
					errors.push(`Purge: ${e.message}`);
					return [] as PurgeEvent[];
				}),
				getS3Events({ limit: fetchLimit }).catch((e) => {
					errors.push(`S3: ${e.message}`);
					return [] as S3Event[];
				}),
			]);
			setPurgeEvents(purge);
			setS3Events(s3);
			if (errors.length > 0 && purge.length === 0 && s3.length === 0) {
				setError(errors.join('; '));
			}
		} catch (e: any) {
			setError(e.message ?? 'Failed to load events');
			setPurgeEvents([]);
			setS3Events([]);
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
			setSortDir(field === 'source' ? 'asc' : 'desc');
		}
	};

	const SortIcon = ({ field }: { field: SortField }) => {
		if (sortField !== field) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
		return sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
	};

	// ── Unified + filtered + sorted events ──────────────────────

	const allEvents: UnifiedEvent[] = useMemo(() => [...purgeEvents.map(fromPurge), ...s3Events.map(fromS3)], [purgeEvents, s3Events]);

	const filteredEvents = useMemo(() => {
		let result = allEvents;

		// Source tab
		if (tab !== 'all') result = result.filter((e) => e.source === tab);

		// Status filter
		if (statusFilter !== 'all') {
			result = result.filter((e) => {
				if (statusFilter === '2xx') return e.status >= 200 && e.status < 300;
				if (statusFilter === '4xx') return e.status >= 400 && e.status < 500;
				if (statusFilter === '5xx') return e.status >= 500;
				return true;
			});
		}

		// Text search
		if (search.trim()) {
			const q = search.toLowerCase();
			result = result.filter((e) => eventSearchText(e).includes(q));
		}

		return result;
	}, [allEvents, tab, statusFilter, search]);

	/** Events grouped by flight_id, sorted by the chosen field. */
	const flightGroups = useMemo(() => {
		const groups = groupByFlight(filteredEvents);

		groups.sort((a, b) => {
			let cmp = 0;
			switch (sortField) {
				case 'created_at':
					cmp = a.sortKey - b.sortKey;
					break;
				case 'status':
					cmp = a.leader.status - b.leader.status;
					break;
				case 'duration_ms':
					cmp = a.leader.duration_ms - b.leader.duration_ms;
					break;
				case 'source':
					cmp = a.leader.source.localeCompare(b.leader.source);
					break;
			}
			return sortDir === 'asc' ? cmp : -cmp;
		});

		return groups;
	}, [filteredEvents, sortField, sortDir]);

	const {
		pageItems: pageGroups,
		page: pgPage,
		pageSize: pgSize,
		totalItems: pgTotal,
		totalPages: pgTotalPages,
		pageSizeOptions: pgSizeOptions,
		setPage: pgSetPage,
		setPageSize: pgSetPageSize,
	} = usePagination(flightGroups, { defaultPageSize: 50 });

	// ── Counts for tab labels ────────────────────────────────────

	const purgeCount = purgeEvents.length;
	const s3Count = s3Events.length;
	const totalCount = allEvents.length;

	const handleCopy = () => {
		copyToClipboard(filteredEvents);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const handleExport = () => {
		const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const suffix = tab === 'all' ? 'all' : tab;
		exportToJson(filteredEvents, `gatekeeper-events-${suffix}-${ts}.json`);
	};

	return (
		<TooltipProvider delayDuration={200}>
			<div className="space-y-6">
				{/* ── Controls row 1: source tabs + status filter + export ── */}
				<div className="flex flex-wrap items-center gap-3">
					{/* Source tabs */}
					<div className="flex rounded-md border border-border">
						{(['all', 'purge', 's3'] as TabFilter[]).map((t) => {
							const count = t === 'all' ? totalCount : t === 'purge' ? purgeCount : s3Count;
							const labels: Record<TabFilter, string> = { all: 'All', purge: 'Purge', s3: 'S3' };
							return (
								<button
									key={t}
									onClick={() => setTab(t)}
									className={cn(
										'px-3 py-1 text-xs font-data transition-colors',
										tab === t ? 'bg-lv-purple/20 text-lv-purple' : 'text-muted-foreground hover:text-foreground hover:bg-muted',
										t !== 'all' && 'border-l border-border',
									)}
								>
									{labels[t]} ({count})
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

				{/* ── Controls row 2: search ─────────────────────────────── */}
				<div className="flex items-center gap-3">
					<div className="relative flex-1 max-w-sm">
						<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
						<Input
							placeholder="Search by ID, zone, bucket, operation, status..."
							value={search}
							onChange={(e: any) => setSearch(e.target.value)}
							className="pl-8 h-8 text-xs font-data"
						/>
					</div>
					{(search || statusFilter !== 'all' || tab !== 'all') && (
						<span className="text-xs text-muted-foreground font-data">
							{filteredEvents.length} of {totalCount} events
						</span>
					)}
				</div>

				{/* ── Error ──────────────────────────────────────────────── */}
				{error && <div className="rounded-lg border border-lv-red/30 bg-lv-red/10 px-4 py-3 text-sm text-lv-red">{error}</div>}

				{/* ── Loading ────────────────────────────────────────────── */}
				{loading && <EventsTableSkeleton />}

				{/* ── Empty state ────────────────────────────────────────── */}
				{!loading && filteredEvents.length === 0 && !error && (
					<div className="flex h-48 items-center justify-center">
						<p className={T.mutedSm}>
							{totalCount === 0
								? tab === 'all'
									? 'No events recorded yet.'
									: `No ${tab === 'purge' ? 'purge' : 'S3'} events recorded yet.`
								: 'No events match the current filters.'}
						</p>
					</div>
				)}

				{/* ── Events log ─────────────────────────────────────────── */}
				{!loading && filteredEvents.length > 0 && (
					<Card>
						<CardHeader>
							<CardTitle className={T.sectionHeading}>
								<div className="flex items-center gap-2">
									<Clock className="h-4 w-4 text-muted-foreground" />
									Events ({filteredEvents.length}
									{filteredEvents.length !== totalCount ? ` of ${totalCount}` : ''}
									{flightGroups.length !== filteredEvents.length ? ` · ${flightGroups.length} flights` : ''})
								</div>
							</CardTitle>
						</CardHeader>
						<CardContent className="p-0">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className={cn(T.sectionLabel, 'w-6')} />
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} onClick={() => toggleSort('created_at')}>
											<span className="flex items-center gap-1">
												Time <SortIcon field="created_at" />
											</span>
										</TableHead>
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} onClick={() => toggleSort('source')}>
											<span className="flex items-center gap-1">
												Source <SortIcon field="source" />
											</span>
										</TableHead>
										<TableHead className={T.sectionLabel}>Identity</TableHead>
										<TableHead className={T.sectionLabel}>Detail</TableHead>
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} onClick={() => toggleSort('status')}>
											<span className="flex items-center gap-1">
												Status <SortIcon field="status" />
											</span>
										</TableHead>
										<TableHead
											className={cn(T.sectionLabel, 'text-right cursor-pointer select-none')}
											onClick={() => toggleSort('duration_ms')}
										>
											<span className="flex items-center justify-end gap-1">
												Duration <SortIcon field="duration_ms" />
											</span>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{pageGroups.map((group) => {
										const ev = group.leader;
										const rowKey = `${ev.source}-${ev.id}`;
										const isExpanded = expandedIds.has(rowKey);
										const hasFollowers = group.followers.length > 0;
										const flightKey = `flight-${ev.flight_id ?? ev.id}`;
										const isFlightExpanded = expandedIds.has(flightKey);
										return (
											<>
												<TableRow
													key={rowKey}
													className={cn('cursor-pointer select-none', hasFollowers && isFlightExpanded && 'bg-lv-blue/[0.03]')}
													onClick={() => toggleExpanded(rowKey)}
												>
													<TableCell className="w-6 px-2 relative">
														{/* Vertical tree trunk extending to followers when expanded */}
														{hasFollowers && isFlightExpanded && <span className="absolute left-3 top-1/2 bottom-0 w-px bg-lv-blue/25" />}
														<ChevronRight
															className={cn(
																'h-3.5 w-3.5 text-muted-foreground transition-transform duration-150',
																isExpanded && 'rotate-90',
															)}
														/>
													</TableCell>
													<TableCell className={T.tableCellMono}>{formatTime(ev.created_at)}</TableCell>
													<TableCell>{sourceBadge(ev.source)}</TableCell>
													<TableCell>
														{ev.source === 'purge' ? (
															<code className={T.tableCellMono} title={ev.key_id}>
																{truncateId(ev.key_id ?? '', 10)}
															</code>
														) : (
															<code className={T.tableCellMono} title={ev.credential_id}>
																{truncateId(ev.credential_id ?? '', 12)}
															</code>
														)}
													</TableCell>
													<TableCell>
														{ev.source === 'purge' ? (
															<div className="flex items-center gap-2 min-w-0">
																<WithTooltip tip={PURGE_TYPE_TOOLTIPS[ev.purge_type ?? ''] ?? ev.purge_type ?? ''}>
																	<Badge className={cn(purgeTypeBadgeClass(ev.purge_type), 'shrink-0')}>{ev.purge_type}</Badge>
																</WithTooltip>
																<code className={cn(T.tableCellMono, 'shrink-0')} title={ev.zone_id}>
																	{truncateId(ev.zone_id ?? '', 8)}
																</code>
																{ev.purge_target && (
																	<WithTooltip tip={ev.purge_target}>
																		<code className={cn(T.tableCellMono, 'truncate max-w-[200px] text-lv-cyan/80')}>{ev.purge_target}</code>
																	</WithTooltip>
																)}
																{hasFollowers ? (
																	<WithTooltip
																		tip={`${group.followers.length} identical request(s) were deduplicated against this leader — only 1 upstream call was made`}
																	>
																		<Badge
																			className="bg-lv-blue/20 text-lv-blue border-lv-blue/30 shrink-0 cursor-pointer hover:bg-lv-blue/30"
																			onClick={(e: React.MouseEvent) => {
																				e.stopPropagation();
																				toggleExpanded(flightKey);
																			}}
																		>
																			+{group.followers.length} collapsed
																		</Badge>
																	</WithTooltip>
																) : ev.collapsed ? (
																	<WithTooltip tip={COLLAPSED_TOOLTIPS[ev.collapsed] ?? ev.collapsed}>
																		<Badge className="bg-lv-blue/20 text-lv-blue border-lv-blue/30 shrink-0">{ev.collapsed}</Badge>
																	</WithTooltip>
																) : null}
															</div>
														) : (
															<div className="flex items-center gap-2 min-w-0">
																<WithTooltip tip={`S3 operation: ${ev.operation}`}>
																	<Badge className="bg-lv-green/20 text-lv-green border-lv-green/30 shrink-0">{ev.operation}</Badge>
																</WithTooltip>
																{ev.bucket && (
																	<code className={cn(T.tableCellMono, 'truncate max-w-[200px]')}>
																		{ev.bucket}
																		{ev.s3_key ? `/${truncateId(ev.s3_key, 16)}` : ''}
																	</code>
																)}
															</div>
														)}
													</TableCell>
													<TableCell>{statusBadge(ev.status)}</TableCell>
													<TableCell className={T.tableCellNumeric}>{ev.duration_ms.toFixed(0)} ms</TableCell>
												</TableRow>
												{isExpanded && <EventDetailRow key={`${rowKey}-detail`} event={ev} />}
												{/* Collapsed follower rows */}
												{hasFollowers &&
													isFlightExpanded &&
													group.followers.map((follower, idx) => {
														const fKey = `${follower.source}-${follower.id}`;
														const fExpanded = expandedIds.has(fKey);
														const isLast = idx === group.followers.length - 1;
														return (
															<>
																<TableRow
																	key={fKey}
																	className="cursor-pointer select-none bg-lv-blue/5 hover:bg-lv-blue/10"
																	onClick={() => toggleExpanded(fKey)}
																>
																	<TableCell className="w-6 px-2 relative">
																		{/* Tree connector line */}
																		<span
																			className="absolute left-3 top-0 bottom-0 w-px bg-lv-blue/25"
																			style={isLast ? { bottom: '50%' } : undefined}
																		/>
																		<span className="absolute left-3 top-1/2 w-2.5 h-px bg-lv-blue/25" />
																		<ChevronRight
																			className={cn(
																				'h-3.5 w-3.5 text-muted-foreground/50 transition-transform duration-150 ml-3',
																				fExpanded && 'rotate-90',
																			)}
																		/>
																	</TableCell>
																	<TableCell className={cn(T.tableCellMono, 'text-muted-foreground/70')}>
																		{formatTime(follower.created_at)}
																	</TableCell>
																	<TableCell>
																		<WithTooltip tip={COLLAPSED_TOOLTIPS[follower.collapsed ?? ''] ?? 'Deduplicated request'}>
																			<Badge className="bg-lv-blue/10 text-lv-blue/70 border-lv-blue/20 gap-1 text-[10px]">
																				{follower.collapsed ?? 'collapsed'}
																			</Badge>
																		</WithTooltip>
																	</TableCell>
																	<TableCell>
																		<code className={cn(T.tableCellMono, 'text-muted-foreground/60')} title={follower.key_id}>
																			{truncateId(follower.key_id ?? '', 10)}
																		</code>
																	</TableCell>
																	<TableCell>
																		<span className="text-[11px] text-muted-foreground/50 italic font-data">
																			deduplicated against leader
																		</span>
																	</TableCell>
																	<TableCell>{statusBadge(follower.status)}</TableCell>
																	<TableCell className={cn(T.tableCellNumeric, 'text-muted-foreground/60')}>
																		{follower.duration_ms.toFixed(0)} ms
																	</TableCell>
																</TableRow>
																{fExpanded && <EventDetailRow key={`${fKey}-detail`} event={follower} />}
															</>
														);
													})}
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
								noun="flights"
							/>
						</CardContent>
					</Card>
				)}
			</div>
		</TooltipProvider>
	);
}
