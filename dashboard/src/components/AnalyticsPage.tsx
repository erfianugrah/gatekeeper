import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronRight, Clock, Cloud, Copy, Download, HardDrive, Search, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getEvents, getS3Events } from '@/lib/api';
import type { PurgeEvent, S3Event } from '@/lib/api';
import { cn } from '@/lib/utils';
import { T } from '@/lib/typography';

// ─── Unified event type ─────────────────────────────────────────────

type UnifiedEvent = {
	id: number;
	source: 'purge' | 's3';
	status: number;
	duration_ms: number;
	created_at: number;
	raw: PurgeEvent | S3Event;
	key_id?: string;
	zone_id?: string;
	purge_type?: 'single' | 'bulk';
	cost?: number;
	collapsed?: string | null;
	upstream_status?: number | null;
	credential_id?: string;
	operation?: string;
	bucket?: string | null;
	s3_key?: string | null;
};

function fromPurge(ev: PurgeEvent): UnifiedEvent {
	return {
		id: ev.id,
		source: 'purge',
		status: ev.status,
		duration_ms: ev.duration_ms,
		created_at: ev.created_at,
		raw: ev,
		key_id: ev.key_id,
		zone_id: ev.zone_id,
		purge_type: ev.purge_type,
		cost: ev.cost,
		collapsed: ev.collapsed,
		upstream_status: ev.upstream_status,
	};
}

function fromS3(ev: S3Event): UnifiedEvent {
	return {
		id: ev.id + 1_000_000_000,
		source: 's3',
		status: ev.status,
		duration_ms: ev.duration_ms,
		created_at: ev.created_at,
		raw: ev,
		credential_id: ev.credential_id,
		operation: ev.operation,
		bucket: ev.bucket,
		s3_key: ev.key,
	};
}

// ─── Sort types ─────────────────────────────────────────────────────

type SortField = 'created_at' | 'status' | 'duration_ms' | 'source';
type SortDir = 'asc' | 'desc';

// ─── Helpers ────────────────────────────────────────────────────────

function formatTime(epoch: number): string {
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

function formatTimeISO(epoch: number): string {
	return new Date(epoch).toISOString();
}

function truncateId(id: string, len = 10): string {
	return id.length > len ? `${id.slice(0, len)}...` : id;
}

function statusBadge(status: number): React.ReactNode {
	if (status >= 200 && status < 300) {
		return <Badge className="bg-lv-green/20 text-lv-green border-lv-green/30">{status}</Badge>;
	}
	if (status === 429) {
		return <Badge className="bg-lv-peach/20 text-lv-peach border-lv-peach/30">{status}</Badge>;
	}
	if (status === 403) {
		return <Badge className="bg-lv-red-bright/20 text-lv-red-bright border-lv-red-bright/30">{status}</Badge>;
	}
	if (status >= 400) {
		return <Badge className="bg-lv-red/20 text-lv-red border-lv-red/30">{status}</Badge>;
	}
	return <Badge variant="secondary">{status}</Badge>;
}

function sourceBadge(source: 'purge' | 's3'): React.ReactNode {
	if (source === 'purge') {
		return (
			<Badge className="bg-lv-purple/20 text-lv-purple border-lv-purple/30 gap-1">
				<Cloud className="h-3 w-3" />
				Purge
			</Badge>
		);
	}
	return (
		<Badge className="bg-lv-cyan/20 text-lv-cyan border-lv-cyan/30 gap-1">
			<HardDrive className="h-3 w-3" />
			S3
		</Badge>
	);
}

const LIMIT_OPTIONS = [50, 100, 500] as const;
type TabFilter = 'all' | 'purge' | 's3';
type StatusFilter = 'all' | '2xx' | '4xx' | '5xx';

// ─── Detail row (expanded) ──────────────────────────────────────────

type FieldType = 'id' | 'string' | 'number' | 'status' | 'duration' | 'timestamp' | 'null' | 'operation';

interface DetailField {
	key: string;
	value: string | number | null | undefined;
	type: FieldType;
}

function coloredValue(field: DetailField): React.ReactNode {
	const { value, type } = field;

	if (value === null || value === undefined) {
		return <span className="italic text-muted-foreground/40">null</span>;
	}

	switch (type) {
		case 'id':
			return <span className="text-lv-cyan">{String(value)}</span>;
		case 'status': {
			const n = Number(value);
			if (n >= 200 && n < 300) return <span className="text-lv-green font-semibold">{n}</span>;
			if (n === 429) return <span className="text-lv-peach font-semibold">{n}</span>;
			if (n >= 400) return <span className="text-lv-red font-semibold">{n}</span>;
			return <span className="font-semibold">{n}</span>;
		}
		case 'duration':
			return (
				<span className="text-lv-peach">
					{value} <span className="text-muted-foreground">ms</span>
				</span>
			);
		case 'number':
			return <span className="text-lv-purple">{String(value)}</span>;
		case 'timestamp':
			return <span className="text-lv-blue">{String(value)}</span>;
		case 'operation':
			return <span className="text-lv-green font-medium">{String(value)}</span>;
		default:
			return <span className="text-foreground">{String(value)}</span>;
	}
}

function DetailRow({ event }: { event: UnifiedEvent }) {
	const raw = event.raw;
	const fields: DetailField[] =
		event.source === 'purge'
			? [
					{ key: 'id', value: (raw as PurgeEvent).id, type: 'number' },
					{ key: 'key_id', value: event.key_id, type: 'id' },
					{ key: 'zone_id', value: event.zone_id, type: 'id' },
					{ key: 'purge_type', value: event.purge_type, type: 'operation' },
					{ key: 'cost', value: event.cost, type: 'number' },
					{ key: 'status', value: event.status, type: 'status' },
					{ key: 'upstream_status', value: event.upstream_status, type: 'status' },
					{ key: 'collapsed', value: event.collapsed, type: 'string' },
					{ key: 'duration_ms', value: event.duration_ms, type: 'duration' },
					{ key: 'created_by', value: (raw as PurgeEvent).created_by, type: 'id' },
					{ key: 'response_detail', value: (raw as PurgeEvent).response_detail, type: 'string' },
					{ key: 'created_at', value: formatTimeISO(event.created_at), type: 'timestamp' },
				]
			: [
					{ key: 'id', value: (raw as S3Event).id, type: 'number' },
					{ key: 'credential_id', value: event.credential_id, type: 'id' },
					{ key: 'operation', value: event.operation, type: 'operation' },
					{ key: 'bucket', value: event.bucket, type: 'string' },
					{ key: 'key', value: event.s3_key, type: 'string' },
					{ key: 'status', value: event.status, type: 'status' },
					{ key: 'duration_ms', value: event.duration_ms, type: 'duration' },
					{ key: 'created_by', value: (raw as S3Event).created_by, type: 'id' },
					{ key: 'response_detail', value: (raw as S3Event).response_detail, type: 'string' },
					{ key: 'created_at', value: formatTimeISO(event.created_at), type: 'timestamp' },
				];

	return (
		<TableRow className="bg-muted/30 hover:bg-muted/40 border-b border-border/50">
			<TableCell colSpan={7} className="px-6 py-3">
				<div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 max-w-2xl">
					{fields.map((field) => (
						<div key={field.key} className="contents">
							<span className="text-[11px] font-data text-muted-foreground/70 select-none">{field.key}</span>
							<span className="text-[11px] font-data break-all select-all">{coloredValue(field)}</span>
						</div>
					))}
				</div>
			</TableCell>
		</TableRow>
	);
}

// ─── Loading Skeleton ───────────────────────────────────────────────

function EventsTableSkeleton() {
	return (
		<div className="space-y-2">
			{Array.from({ length: 8 }).map((_, i) => (
				<Skeleton key={i} className="h-9 w-full" />
			))}
		</div>
	);
}

// ─── Export helpers ──────────────────────────────────────────────────

function exportToJson(events: UnifiedEvent[], filename: string) {
	const raw = events.map((ev) => ev.raw);
	const blob = new Blob([JSON.stringify(raw, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

function copyToClipboard(events: UnifiedEvent[]) {
	const raw = events.map((ev) => ev.raw);
	navigator.clipboard.writeText(JSON.stringify(raw, null, 2));
}

// ─── Event text for search matching ─────────────────────────────────

function eventSearchText(ev: UnifiedEvent): string {
	const parts = [
		ev.source,
		String(ev.status),
		ev.key_id ?? '',
		ev.zone_id ?? '',
		ev.credential_id ?? '',
		ev.operation ?? '',
		ev.bucket ?? '',
		ev.s3_key ?? '',
		ev.purge_type ?? '',
		ev.collapsed ?? '',
		(ev.raw as any).created_by ?? '',
		(ev.raw as any).response_detail ?? '',
	];
	return parts.join(' ').toLowerCase();
}

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

		// Sort
		result = [...result].sort((a, b) => {
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
				case 'source':
					cmp = a.source.localeCompare(b.source);
					break;
			}
			return sortDir === 'asc' ? cmp : -cmp;
		});

		return result;
	}, [allEvents, tab, statusFilter, search, sortField, sortDir]);

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
								{filteredEvents.length !== totalCount ? ` of ${totalCount}` : ''})
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
								{filteredEvents.map((ev) => {
									const rowKey = `${ev.source}-${ev.id}`;
									const isExpanded = expandedIds.has(rowKey);
									return (
										<>
											<TableRow key={rowKey} className="cursor-pointer select-none" onClick={() => toggleExpanded(rowKey)}>
												<TableCell className="w-6 px-2">
													<ChevronRight
														className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform duration-150', isExpanded && 'rotate-90')}
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
														<div className="flex items-center gap-2">
															<Badge
																className={cn(
																	ev.purge_type === 'single'
																		? 'bg-lv-purple/20 text-lv-purple border-lv-purple/30'
																		: 'bg-lv-cyan/20 text-lv-cyan border-lv-cyan/30',
																)}
															>
																{ev.purge_type}
															</Badge>
															<code className={T.tableCellMono} title={ev.zone_id}>
																{truncateId(ev.zone_id ?? '', 8)}
															</code>
															{ev.collapsed && <Badge className="bg-lv-blue/20 text-lv-blue border-lv-blue/30">{ev.collapsed}</Badge>}
														</div>
													) : (
														<div className="flex items-center gap-2">
															<Badge className="bg-lv-green/20 text-lv-green border-lv-green/30">{ev.operation}</Badge>
															{ev.bucket && (
																<code className={T.tableCellMono}>
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
											{isExpanded && <DetailRow key={`${rowKey}-detail`} event={ev} />}
										</>
									);
								})}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
