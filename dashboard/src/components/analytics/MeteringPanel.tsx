import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { T } from '@/lib/typography';
import { getCrossSurfaceMetering, getSurfaceMetering } from '@/lib/api';
import type { CrossSurfaceTenantRow, MeteringRow } from '@/lib/api';
import { formatBytes, truncateId } from './analytics-helpers';

// ─── Surface metadata ───────────────────────────────────────────────

/** Short surface id → cross-surface table key (server row.surfaces key). */
const SURFACE_TABLE_KEY: Record<string, string> = {
	supabase: 'supabase_proxy_events',
	cf: 'cf_proxy_events',
	dns: 'dns_events',
	purge: 'purge_events',
	s3: 's3_events',
};

/** Ordered surfaces for cross-surface columns + the single-surface selector. */
const SURFACES: { id: string; label: string }[] = [
	{ id: 'supabase', label: 'supabase' },
	{ id: 'cf', label: 'cf' },
	{ id: 'dns', label: 'dns' },
	{ id: 'purge', label: 'purge' },
	{ id: 's3', label: 's3' },
];

/** Valid group-by dimensions per surface. */
const GROUP_BY_DIMS: Record<string, string[]> = {
	supabase: ['tenant', 'key', 'project'],
	cf: ['tenant', 'key'],
	dns: ['tenant', 'key', 'zone'],
	purge: ['tenant', 'key', 'zone'],
	s3: ['tenant', 'credential', 'bucket'],
};

type SurfaceSel = 'all' | 'supabase' | 'cf' | 'dns' | 'purge' | 's3';

const WINDOW_OPTIONS: { label: string; days: number }[] = [
	{ label: '24h', days: 1 },
	{ label: '7d', days: 7 },
	{ label: '30d', days: 30 },
];

const EGRESS_FOOTNOTE = 'Best-effort — excludes streamed responses';

function fmtNum(n: number | null | undefined): string {
	return n === null || n === undefined ? '—' : n.toLocaleString('en-US');
}

function fmtEgress(bytes: number | null | undefined): string {
	return bytes === null || bytes === undefined ? '—' : formatBytes(bytes);
}

// ─── Metering Panel ─────────────────────────────────────────────────

const COST_NOTE = 'Illustrative placeholder pricing - not real list prices';

function fmtUsd(n: number | null | undefined): string {
	if (n === null || n === undefined) return '-';
	if (n === 0) return '$0';
	if (n < 0.01) return `$${n.toFixed(6)}`;
	return `$${n.toFixed(2)}`;
}

export function MeteringPanel() {
	const [surface, setSurface] = useState<SurfaceSel>('all');
	const [groupBy, setGroupBy] = useState<string>('tenant');
	const [windowDays, setWindowDays] = useState<number>(7);
	const [crossRows, setCrossRows] = useState<CrossSurfaceTenantRow[]>([]);
	const [surfaceRows, setSurfaceRows] = useState<MeteringRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Keep group-by valid when switching surfaces.
	useEffect(() => {
		if (surface === 'all') return;
		const dims = GROUP_BY_DIMS[surface] ?? ['tenant'];
		if (!dims.includes(groupBy)) setGroupBy(dims[0]);
	}, [surface, groupBy]);

	const fetchData = useCallback(async () => {
		setLoading(true);
		setError(null);
		const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;
		try {
			if (surface === 'all') {
				const rows = await getCrossSurfaceMetering({ since });
				setCrossRows(rows);
				setSurfaceRows([]);
			} else {
				const dims = GROUP_BY_DIMS[surface] ?? ['tenant'];
				const dim = dims.includes(groupBy) ? groupBy : dims[0];
				const rows = await getSurfaceMetering(surface, { group_by: dim, since });
				setSurfaceRows(rows);
				setCrossRows([]);
			}
		} catch (e: any) {
			setError(e.message ?? 'Failed to load metering');
			setCrossRows([]);
			setSurfaceRows([]);
		} finally {
			setLoading(false);
		}
	}, [surface, groupBy, windowDays]);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	const isEmpty = useMemo(() => (surface === 'all' ? crossRows.length === 0 : surfaceRows.length === 0), [surface, crossRows, surfaceRows]);

	return (
		<div className="space-y-6">
			{/* ── Controls ─────────────────────────────────────────── */}
			<div className="flex flex-wrap items-center gap-3">
				{/* Surface selector */}
				<div className="flex rounded-md border border-border">
					<button
						key="all"
						onClick={() => setSurface('all')}
						className={cn(
							'px-3 py-1 text-xs font-data transition-colors',
							surface === 'all' ? 'bg-lv-purple/20 text-lv-purple' : 'text-muted-foreground hover:text-foreground hover:bg-muted',
						)}
					>
						All (cross-surface)
					</button>
					{SURFACES.map(({ id, label }) => (
						<button
							key={id}
							onClick={() => setSurface(id as SurfaceSel)}
							className={cn(
								'px-3 py-1 text-xs font-data transition-colors border-l border-border',
								surface === id ? 'bg-lv-purple/20 text-lv-purple' : 'text-muted-foreground hover:text-foreground hover:bg-muted',
							)}
						>
							{label}
						</button>
					))}
				</div>

				{/* Group-by selector (single surface only) */}
				{surface !== 'all' && (
					<div className="flex items-center gap-2">
						<span className={T.formLabel}>Group by</span>
						<div className="flex rounded-md border border-border">
							{(GROUP_BY_DIMS[surface] ?? ['tenant']).map((dim, idx) => (
								<button
									key={dim}
									onClick={() => setGroupBy(dim)}
									className={cn(
										'px-3 py-1 text-xs font-data transition-colors',
										groupBy === dim ? 'bg-lv-green/20 text-lv-green' : 'text-muted-foreground hover:text-foreground hover:bg-muted',
										idx > 0 && 'border-l border-border',
									)}
								>
									{dim}
								</button>
							))}
						</div>
					</div>
				)}

				{/* Time window + refresh */}
				<div className="ml-auto flex items-center gap-2">
					<span className={T.formLabel}>Window</span>
					<div className="flex rounded-md border border-border">
						{WINDOW_OPTIONS.map((opt, idx) => (
							<button
								key={opt.days}
								onClick={() => setWindowDays(opt.days)}
								className={cn(
									'px-3 py-1 text-xs font-data transition-colors',
									windowDays === opt.days ? 'bg-lv-purple/20 text-lv-purple' : 'text-muted-foreground hover:text-foreground hover:bg-muted',
									idx > 0 && 'border-l border-border',
								)}
							>
								{opt.label}
							</button>
						))}
					</div>
					<button
						onClick={() => fetchData()}
						disabled={loading}
						className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
					>
						<RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
						Refresh
					</button>
				</div>
			</div>

			{/* ── Error ────────────────────────────────────────────── */}
			{error && <div className="rounded-lg border border-lv-red/30 bg-lv-red/10 px-4 py-3 text-sm text-lv-red">{error}</div>}

			{/* ── Loading ──────────────────────────────────────────── */}
			{loading && (
				<div className="flex h-48 items-center justify-center">
					<p className={T.mutedSm}>Loading metering…</p>
				</div>
			)}

			{/* ── Empty ────────────────────────────────────────────── */}
			{!loading && isEmpty && !error && (
				<div className="flex h-48 items-center justify-center">
					<p className={T.mutedSm}>No metering data for the selected window.</p>
				</div>
			)}

			{/* ── Cross-surface table ──────────────────────────────── */}
			{!loading && !isEmpty && surface === 'all' && (
				<Card>
					<CardHeader>
						<CardTitle className={T.sectionHeading}>
							<div className="flex items-center gap-2">
								<Gauge className="h-4 w-4 text-muted-foreground" />
								Cross-surface metering ({crossRows.length} tenants)
							</div>
						</CardTitle>
					</CardHeader>
					<CardContent className="p-0">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className={T.sectionLabel}>Tenant</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')}>Total req</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')} title={COST_NOTE}>
										Cost*
									</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')}>Errors</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')} title={EGRESS_FOOTNOTE}>
										Egress*
									</TableHead>
									{SURFACES.map(({ id, label }) => (
										<TableHead key={id} className={cn(T.sectionLabel, 'text-right')}>
											{label}
										</TableHead>
									))}
								</TableRow>
							</TableHeader>
							<TableBody>
								{crossRows.map((row, i) => (
									<TableRow key={row.tenant ?? `null-${i}`}>
										<TableCell className={T.tableCellMono} title={row.tenant ?? undefined}>
											{row.tenant ? truncateId(row.tenant, 24) : <span className="text-muted-foreground/60 italic">(none)</span>}
										</TableCell>
										<TableCell className={T.tableCellNumeric}>{fmtNum(row.total_requests)}</TableCell>
										<TableCell className={cn(T.tableCellNumeric, 'text-lv-green')}>{fmtUsd(row.total_cost_usd)}</TableCell>
										<TableCell className={cn(T.tableCellNumeric, row.total_errors > 0 && 'text-lv-red')}>
											{fmtNum(row.total_errors)}
										</TableCell>
										<TableCell className={T.tableCellNumeric}>{fmtEgress(row.total_egress_bytes)}</TableCell>
										{SURFACES.map(({ id }) => {
											const s = row.surfaces[SURFACE_TABLE_KEY[id]];
											return (
												<TableCell key={id} className={T.tableCellNumeric}>
													{s ? fmtNum(s.total_requests) : <span className="text-muted-foreground/40">—</span>}
												</TableCell>
											);
										})}
									</TableRow>
								))}
							</TableBody>
						</Table>
						<p className={cn(T.mutedSm, 'px-4 py-2 text-xs')}>* {EGRESS_FOOTNOTE}. Cost uses illustrative placeholder pricing.</p>
					</CardContent>
				</Card>
			)}

			{/* ── Single-surface table ─────────────────────────────── */}
			{!loading && !isEmpty && surface !== 'all' && (
				<Card>
					<CardHeader>
						<CardTitle className={T.sectionHeading}>
							<div className="flex items-center gap-2">
								<Gauge className="h-4 w-4 text-muted-foreground" />
								{surface} metering by {groupBy} ({surfaceRows.length} rows)
							</div>
						</CardTitle>
					</CardHeader>
					<CardContent className="p-0">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className={T.sectionLabel}>Label</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')}>Total req</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')}>Read</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')}>Write</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')}>Error %</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')} title={EGRESS_FOOTNOTE}>
										Egress*
									</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')} title={COST_NOTE}>
										Cost*
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{surfaceRows.map((row, i) => {
									const label = row.label ?? row.group_key;
									return (
										<TableRow key={row.group_key ?? `null-${i}`}>
											<TableCell className={T.tableCellMono} title={label ?? undefined}>
												{label ? truncateId(label, 32) : <span className="text-muted-foreground/60 italic">(none)</span>}
											</TableCell>
											<TableCell className={T.tableCellNumeric}>{fmtNum(row.total_requests)}</TableCell>
											<TableCell className={T.tableCellNumeric}>{fmtNum(row.read_requests)}</TableCell>
											<TableCell className={T.tableCellNumeric}>{fmtNum(row.write_requests)}</TableCell>
											<TableCell className={cn(T.tableCellNumeric, row.error_rate_pct > 0 && 'text-lv-red')}>
												{row.error_rate_pct.toFixed(1)}%
											</TableCell>
											<TableCell className={T.tableCellNumeric}>{fmtEgress(row.egress_bytes)}</TableCell>
											<TableCell className={cn(T.tableCellNumeric, 'text-lv-green')}>{fmtUsd(row.cost_usd)}</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
						<p className={cn(T.mutedSm, 'px-4 py-2 text-xs')}>* {EGRESS_FOOTNOTE}. Cost uses illustrative placeholder pricing.</p>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
