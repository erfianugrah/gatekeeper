import { useState, useCallback, useEffect } from 'react';
import { Plus, Trash2, Loader2, Copy, Check, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { usePagination } from '@/hooks/use-pagination';
import { TablePagination } from '@/components/TablePagination';
import { listUpstreamR2, createUpstreamR2, deleteUpstreamR2, bulkDeleteUpstreamR2Endpoints } from '@/lib/api';
import type { UpstreamR2, ApiResultWithWarnings } from '@/lib/api';
import { cn, copyToClipboard } from '@/lib/utils';
import { T } from '@/lib/typography';

// ─── Helpers ────────────────────────────────────────────────────────

function truncateId(id: string, len = 20): string {
	return id.length > len ? `${id.slice(0, len)}...` : id;
}

function formatDate(epoch: number): string {
	return new Date(epoch).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

function formatExpiry(expiresAt: number | null): string {
	if (!expiresAt) return 'Never';
	if (expiresAt < Date.now()) return 'Expired';
	return formatDate(expiresAt);
}

function isExpired(expiresAt: number | null): boolean {
	return expiresAt !== null && expiresAt < Date.now();
}

function formatBuckets(bucketNames: string): string {
	if (bucketNames === '*') return 'All buckets';
	const names = bucketNames.split(',');
	if (names.length <= 2) return names.join(', ');
	return `${names[0]}, ${names[1]} +${names.length - 2} more`;
}

// ─── Warnings Banner ────────────────────────────────────────────────

interface WarningsBannerProps {
	warnings: Array<{ code: number; message: string }>;
	onDismiss: () => void;
}

function WarningsBanner({ warnings, onDismiss }: WarningsBannerProps) {
	if (warnings.length === 0) return null;
	return (
		<div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm">
			<div className="flex items-start gap-2">
				<AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
				<div className="flex-1 space-y-1">
					<p className="font-medium text-yellow-500">
						Endpoint created with {warnings.length} validation warning{warnings.length > 1 ? 's' : ''}
					</p>
					<ul className="list-disc list-inside text-yellow-400/80 space-y-0.5">
						{warnings.map((w, i) => (
							<li key={i}>{w.message}</li>
						))}
					</ul>
				</div>
				<button type="button" onClick={onDismiss} className="text-yellow-500 hover:text-yellow-400 text-xs">
					Dismiss
				</button>
			</div>
		</div>
	);
}

// ─── Create R2 Endpoint Dialog ──────────────────────────────────────

interface CreateEndpointDialogProps {
	onCreated: (warnings: Array<{ code: number; message: string }>) => void;
}

function CreateEndpointDialog({ onCreated }: CreateEndpointDialogProps) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState('');
	const [accessKeyId, setAccessKeyId] = useState('');
	const [secretAccessKey, setSecretAccessKey] = useState('');
	const [endpoint, setEndpoint] = useState('');
	const [bucketNamesInput, setBucketNamesInput] = useState('*');
	const [expiresInDays, setExpiresInDays] = useState('');
	const [skipValidation, setSkipValidation] = useState(false);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleCreate = async () => {
		setError(null);
		if (!name.trim()) {
			setError('Name is required');
			return;
		}
		if (!accessKeyId.trim()) {
			setError('Access Key ID is required');
			return;
		}
		if (!secretAccessKey.trim()) {
			setError('Secret Access Key is required');
			return;
		}
		if (!endpoint.trim()) {
			setError('R2 endpoint URL is required');
			return;
		}

		const bucketNames =
			bucketNamesInput.trim() === '*'
				? ['*']
				: bucketNamesInput
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean);

		if (bucketNames.length === 0) {
			setError('At least one bucket name is required (or * for all)');
			return;
		}

		const expDays = expiresInDays.trim() ? Number(expiresInDays.trim()) : undefined;
		if (expDays !== undefined && (!Number.isFinite(expDays) || expDays <= 0)) {
			setError('Expires in days must be a positive number');
			return;
		}

		setCreating(true);
		try {
			const { warnings } = await createUpstreamR2({
				name: name.trim(),
				access_key_id: accessKeyId.trim(),
				secret_access_key: secretAccessKey.trim(),
				endpoint: endpoint.trim(),
				bucket_names: bucketNames,
				...(expDays && { expires_in_days: expDays }),
				...(skipValidation && { validate: false }),
			});
			onCreated(warnings);
			setOpen(false);
			setName('');
			setAccessKeyId('');
			setSecretAccessKey('');
			setEndpoint('');
			setBucketNamesInput('*');
			setExpiresInDays('');
			setSkipValidation(false);
		} catch (e: any) {
			setError(e.message ?? 'Failed to create R2 endpoint');
		} finally {
			setCreating(false);
		}
	};

	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		setError(null);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button size="sm">
					<Plus className="h-4 w-4" />
					Register Endpoint
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Register R2 Endpoint</DialogTitle>
					<DialogDescription>
						Register an R2 endpoint with credentials. Credentials will be validated against declared buckets on creation.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-2">
						<Label className={T.formLabel}>Name</Label>
						<Input placeholder="e.g. production-r2, media-storage" value={name} onChange={(e) => setName(e.target.value)} />
					</div>

					<div className="space-y-2">
						<Label className={T.formLabel}>R2 Endpoint URL</Label>
						<Input
							placeholder="https://<account-id>.r2.cloudflarestorage.com"
							value={endpoint}
							onChange={(e) => setEndpoint(e.target.value)}
						/>
					</div>

					<div className="space-y-2">
						<Label className={T.formLabel}>Access Key ID</Label>
						<Input placeholder="R2 access key ID" value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} />
					</div>

					<div className="space-y-2">
						<Label className={T.formLabel}>Secret Access Key</Label>
						<Input
							type="password"
							placeholder="R2 secret access key"
							value={secretAccessKey}
							onChange={(e) => setSecretAccessKey(e.target.value)}
						/>
						<p className={T.muted}>Credentials are stored in the Durable Object and never exposed via the API.</p>
					</div>

					<div className="space-y-2">
						<Label className={T.formLabel}>Bucket Names</Label>
						<Input
							placeholder="* for all buckets, or comma-separated names"
							value={bucketNamesInput}
							onChange={(e) => setBucketNamesInput(e.target.value)}
						/>
						<p className={T.muted}>
							Use <code className="text-[10px] font-data">*</code> for all buckets, or provide specific names separated by commas.
						</p>
					</div>

					<div className="space-y-2">
						<Label className={T.formLabel}>Expires in (days)</Label>
						<Input
							type="number"
							min="1"
							placeholder="Optional — leave empty for no expiry"
							value={expiresInDays}
							onChange={(e) => setExpiresInDays(e.target.value)}
						/>
					</div>

					<div className="flex items-center gap-2">
						<input
							type="checkbox"
							id="skip-r2-validation"
							checked={skipValidation}
							onChange={(e) => setSkipValidation(e.target.checked)}
							className="rounded border-border"
						/>
						<Label htmlFor="skip-r2-validation" className="text-xs text-muted-foreground cursor-pointer">
							Skip validation (do not verify credentials against R2)
						</Label>
					</div>

					{error && <p className="text-sm text-lv-red">{error}</p>}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button
						onClick={handleCreate}
						disabled={creating || !name.trim() || !accessKeyId.trim() || !secretAccessKey.trim() || !endpoint.trim()}
					>
						{creating && <Loader2 className="h-4 w-4 animate-spin" />}
						Register
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ─── Loading Skeleton ───────────────────────────────────────────────

function EndpointsTableSkeleton() {
	return (
		<div className="space-y-2">
			{Array.from({ length: 5 }).map((_, i) => (
				<Skeleton key={i} className="h-10 w-full" />
			))}
		</div>
	);
}

// ─── Upstream R2 Page ───────────────────────────────────────────────

export function UpstreamR2Page() {
	const [endpoints, setEndpoints] = useState<UpstreamR2[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [warnings, setWarnings] = useState<Array<{ code: number; message: string }>>([]);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [bulkLoading, setBulkLoading] = useState(false);

	const fetchEndpoints = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await listUpstreamR2();
			setEndpoints(data);
		} catch (e: any) {
			setError(e.message ?? 'Failed to load R2 endpoints');
			setEndpoints([]);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchEndpoints();
	}, [fetchEndpoints]);

	const handleCreated = (creationWarnings: Array<{ code: number; message: string }>) => {
		setWarnings(creationWarnings);
		fetchEndpoints();
	};

	const handleDelete = async (id: string) => {
		if (!confirm(`Delete R2 endpoint ${truncateId(id)}? This cannot be undone.`)) return;
		setDeletingId(id);
		try {
			await deleteUpstreamR2(id);
			await fetchEndpoints();
		} catch (e: any) {
			setError(e.message ?? 'Failed to delete endpoint');
		} finally {
			setDeletingId(null);
		}
	};

	const handleCopyId = async (id: string) => {
		await copyToClipboard(id);
		setCopiedId(id);
		setTimeout(() => setCopiedId(null), 2000);
	};

	const toggleSelect = (id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const toggleSelectAll = () => {
		if (selectedIds.size === endpoints.length) {
			setSelectedIds(new Set());
		} else {
			setSelectedIds(new Set(endpoints.map((ep) => ep.id)));
		}
	};

	const handleBulkDelete = async () => {
		const ids = [...selectedIds];
		if (ids.length === 0) return;
		if (!confirm(`Permanently delete ${ids.length} endpoint${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
		setBulkLoading(true);
		try {
			await bulkDeleteUpstreamR2Endpoints(ids);
			setSelectedIds(new Set());
			await fetchEndpoints();
		} catch (e: any) {
			setError(e.message ?? 'Bulk delete failed');
		} finally {
			setBulkLoading(false);
		}
	};

	const { pageItems, page, pageSize, totalItems, totalPages, pageSizeOptions, setPage, setPageSize } = usePagination(endpoints);

	return (
		<div className="space-y-6">
			{/* ── Header row ──────────────────────────────────────── */}
			<div className="flex items-center justify-between">
				<div>
					<h2 className={T.pageTitle}>Upstream R2 Endpoints</h2>
					<p className={T.pageDescription}>
						R2 storage endpoints with credentials for proxying S3-compatible requests through the gateway.
					</p>
				</div>
				<CreateEndpointDialog onCreated={handleCreated} />
			</div>

			{/* ── Validation warnings from creation ──────────────── */}
			<WarningsBanner warnings={warnings} onDismiss={() => setWarnings([])} />

			{/* ── Error ──────────────────────────────────────────── */}
			{error && <div className="rounded-lg border border-lv-red/30 bg-lv-red/10 px-4 py-3 text-sm text-lv-red">{error}</div>}

			{/* ── Bulk actions bar ────────────────────────────────── */}
			{selectedIds.size > 0 && (
				<div className="flex items-center gap-3 rounded-lg border border-lv-purple/30 bg-lv-purple/10 px-4 py-2">
					<span className="text-sm font-data text-lv-purple">{selectedIds.size} selected</span>
					<div className="ml-auto flex gap-2">
						<Button size="sm" variant="outline" className="text-lv-red border-lv-red/30" onClick={handleBulkDelete} disabled={bulkLoading}>
							{bulkLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
							Delete ({selectedIds.size})
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
							Clear
						</Button>
					</div>
				</div>
			)}

			{/* ── Loading ────────────────────────────────────────── */}
			{loading && <EndpointsTableSkeleton />}

			{/* ── Empty state ────────────────────────────────────── */}
			{!loading && endpoints.length === 0 && !error && (
				<div className="flex h-48 items-center justify-center">
					<p className={T.mutedSm}>No R2 endpoints registered. Register one to enable S3 proxy.</p>
				</div>
			)}

			{/* ── Endpoints table ────────────────────────────────── */}
			{!loading && endpoints.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className={T.sectionHeading}>Endpoints ({endpoints.length})</CardTitle>
					</CardHeader>
					<CardContent className="p-0">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-8">
										<input
											type="checkbox"
											checked={endpoints.length > 0 && selectedIds.size === endpoints.length}
											onChange={toggleSelectAll}
											className="rounded border-border"
											aria-label="Select all"
										/>
									</TableHead>
									<TableHead className={T.sectionLabel}>Name</TableHead>
									<TableHead className={T.sectionLabel}>ID</TableHead>
									<TableHead className={T.sectionLabel}>Endpoint</TableHead>
									<TableHead className={T.sectionLabel}>Key</TableHead>
									<TableHead className={T.sectionLabel}>Buckets</TableHead>
									<TableHead className={T.sectionLabel}>Expires</TableHead>
									<TableHead className={T.sectionLabel}>Created</TableHead>
									<TableHead className={T.sectionLabel}>Created By</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')}>Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{pageItems.map((ep) => (
									<TableRow key={ep.id} className={isExpired(ep.expires_at) ? 'opacity-50' : undefined}>
										<TableCell className="w-8">
											<input
												type="checkbox"
												checked={selectedIds.has(ep.id)}
												onChange={() => toggleSelect(ep.id)}
												className="rounded border-border"
												aria-label="Select row"
											/>
										</TableCell>
										<TableCell className={T.tableRowName}>{ep.name}</TableCell>
										<TableCell>
											<div className="flex items-center gap-1">
												<code className={T.tableCellMono} title={ep.id}>
													{truncateId(ep.id)}
												</code>
												<button
													type="button"
													onClick={() => handleCopyId(ep.id)}
													className="text-muted-foreground hover:text-foreground"
													title="Copy full ID"
												>
													{copiedId === ep.id ? <Check className="h-3 w-3 text-lv-green" /> : <Copy className="h-3 w-3" />}
												</button>
											</div>
										</TableCell>
										<TableCell>
											<code className={cn(T.tableCellMono, 'text-[10px]')} title={ep.endpoint}>
												{truncateId(ep.endpoint, 30)}
											</code>
										</TableCell>
										<TableCell>
											<code className={T.tableCellMono}>{ep.access_key_preview}</code>
										</TableCell>
										<TableCell className={T.tableCell}>
											<span title={ep.bucket_names}>{formatBuckets(ep.bucket_names)}</span>
										</TableCell>
										<TableCell className={T.tableCell}>
											<span className={isExpired(ep.expires_at) ? 'text-lv-red' : undefined}>{formatExpiry(ep.expires_at)}</span>
										</TableCell>
										<TableCell className={T.tableCell}>{formatDate(ep.created_at)}</TableCell>
										<TableCell className={T.tableCell}>{ep.created_by ?? <span className={T.muted}>--</span>}</TableCell>
										<TableCell className="text-right">
											<Button
												size="xs"
												variant="ghost"
												className="text-lv-red hover:text-lv-red-bright hover:bg-lv-red/10"
												onClick={() => handleDelete(ep.id)}
												disabled={deletingId === ep.id}
											>
												{deletingId === ep.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
												Delete
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
						<TablePagination
							page={page}
							totalPages={totalPages}
							totalItems={totalItems}
							pageSize={pageSize}
							pageSizeOptions={pageSizeOptions}
							onPageChange={setPage}
							onPageSizeChange={setPageSize}
							noun="endpoints"
						/>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
