import { useState, useCallback, useEffect } from 'react';
import { Plus, Trash2, Loader2, Copy, Check, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { usePagination } from '@/hooks/use-pagination';
import { TablePagination } from '@/components/TablePagination';
import { listUpstreamTokens, createUpstreamToken, deleteUpstreamToken, bulkDeleteUpstreamTokens } from '@/lib/api';
import type { UpstreamToken, ApiResultWithWarnings } from '@/lib/api';
import { cn, copyToClipboard } from '@/lib/utils';
import { T } from '@/lib/typography';

// ─── Constants ──────────────────────────────────────────────────────

const ZONE_ID_RE = /^[a-f0-9]{32}$/;

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
	const now = Date.now();
	if (expiresAt < now) return 'Expired';
	return formatDate(expiresAt);
}

function isExpired(expiresAt: number | null): boolean {
	return expiresAt !== null && expiresAt < Date.now();
}

function formatZoneIds(zoneIds: string): string {
	if (zoneIds === '*') return 'All zones';
	const ids = zoneIds.split(',');
	if (ids.length === 1) return ids[0];
	return `${ids.length} zones`;
}

function formatScopeType(scope: 'zone' | 'account'): string {
	return scope === 'account' ? 'Account' : 'Zone';
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
						Token created with {warnings.length} validation warning{warnings.length > 1 ? 's' : ''}
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

// ─── Create Token Dialog ────────────────────────────────────────────

interface CreateTokenDialogProps {
	onCreated: (warnings: Array<{ code: number; message: string }>) => void;
}

function CreateTokenDialog({ onCreated }: CreateTokenDialogProps) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState('');
	const [token, setToken] = useState('');
	const [scopeType, setScopeType] = useState<'zone' | 'account'>('zone');
	const [zoneIdsInput, setZoneIdsInput] = useState('*');
	const [expiresInDays, setExpiresInDays] = useState('');
	const [skipValidation, setSkipValidation] = useState(false);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const scopeLabel = scopeType === 'account' ? 'Account IDs' : 'Zone IDs';
	const scopePlaceholder =
		scopeType === 'account' ? '* for all accounts, or comma-separated account IDs' : '* for all zones, or comma-separated zone IDs';

	const handleCreate = async () => {
		setError(null);
		if (!name.trim()) {
			setError('Name is required');
			return;
		}
		if (!token.trim()) {
			setError('Cloudflare API token is required');
			return;
		}

		const ids =
			zoneIdsInput.trim() === '*'
				? ['*']
				: zoneIdsInput
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean);

		if (ids.length === 0) {
			setError(`At least one ${scopeType} ID is required (or * for all)`);
			return;
		}

		const invalidIds = ids.filter((z) => z !== '*' && !ZONE_ID_RE.test(z));
		if (invalidIds.length > 0) {
			setError(`Invalid ${scopeType} ID(s): ${invalidIds.join(', ')} — must be 32-char hex or *`);
			return;
		}

		const expDays = expiresInDays.trim() ? Number(expiresInDays.trim()) : undefined;
		if (expDays !== undefined && (!Number.isFinite(expDays) || expDays <= 0)) {
			setError('Expires in days must be a positive number');
			return;
		}

		setCreating(true);
		try {
			const { warnings } = await createUpstreamToken({
				name: name.trim(),
				token: token.trim(),
				scope_type: scopeType,
				zone_ids: ids,
				...(expDays && { expires_in_days: expDays }),
				...(skipValidation && { validate: false }),
			});
			onCreated(warnings);
			setOpen(false);
			setName('');
			setToken('');
			setScopeType('zone');
			setZoneIdsInput('*');
			setExpiresInDays('');
			setSkipValidation(false);
		} catch (e: any) {
			setError(e.message ?? 'Failed to create upstream token');
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
					Register Token
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Register Upstream Token</DialogTitle>
					<DialogDescription>
						Register a Cloudflare API token. The token will be validated against declared zones/accounts on creation.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-2">
						<Label className={T.formLabel}>Name</Label>
						<Input placeholder="e.g. production-purge, staging-token" value={name} onChange={(e) => setName(e.target.value)} />
					</div>

					<div className="space-y-2">
						<Label className={T.formLabel}>Cloudflare API Token</Label>
						<Input type="password" placeholder="Your Cloudflare API token" value={token} onChange={(e) => setToken(e.target.value)} />
						<p className={T.muted}>The token will not be shown again after creation.</p>
					</div>

					<div className="space-y-2">
						<Label className={T.formLabel}>Scope Type</Label>
						<Select value={scopeType} onValueChange={(v) => setScopeType(v as 'zone' | 'account')}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="zone">Zone</SelectItem>
								<SelectItem value="account">Account</SelectItem>
							</SelectContent>
						</Select>
						<p className={T.muted}>Zone-scoped tokens are used for cache purge / DNS. Account-scoped for CF API proxy.</p>
					</div>

					<div className="space-y-2">
						<Label className={T.formLabel}>{scopeLabel}</Label>
						<Input placeholder={scopePlaceholder} value={zoneIdsInput} onChange={(e) => setZoneIdsInput(e.target.value)} />
						<p className={T.muted}>
							Use <code className="text-[10px] font-data">*</code> for all, or provide specific IDs separated by commas.
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
							id="skip-validation"
							checked={skipValidation}
							onChange={(e) => setSkipValidation(e.target.checked)}
							className="rounded border-border"
						/>
						<Label htmlFor="skip-validation" className="text-xs text-muted-foreground cursor-pointer">
							Skip validation (do not verify token against Cloudflare API)
						</Label>
					</div>

					{error && <p className="text-sm text-lv-red">{error}</p>}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button onClick={handleCreate} disabled={creating || !name.trim() || !token.trim()}>
						{creating && <Loader2 className="h-4 w-4 animate-spin" />}
						Register
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ─── Loading Skeleton ───────────────────────────────────────────────

function TokensTableSkeleton() {
	return (
		<div className="space-y-2">
			{Array.from({ length: 5 }).map((_, i) => (
				<Skeleton key={i} className="h-10 w-full" />
			))}
		</div>
	);
}

// ─── Upstream Tokens Page ───────────────────────────────────────────

export function UpstreamTokensPage() {
	const [tokens, setTokens] = useState<UpstreamToken[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [warnings, setWarnings] = useState<Array<{ code: number; message: string }>>([]);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [bulkLoading, setBulkLoading] = useState(false);

	const fetchTokens = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await listUpstreamTokens();
			setTokens(data);
		} catch (e: any) {
			setError(e.message ?? 'Failed to load upstream tokens');
			setTokens([]);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchTokens();
	}, [fetchTokens]);

	const handleCreated = (creationWarnings: Array<{ code: number; message: string }>) => {
		setWarnings(creationWarnings);
		fetchTokens();
	};

	const handleDelete = async (id: string) => {
		if (!confirm(`Delete upstream token ${truncateId(id)}? This cannot be undone.`)) return;
		setDeletingId(id);
		try {
			await deleteUpstreamToken(id);
			await fetchTokens();
		} catch (e: any) {
			setError(e.message ?? 'Failed to delete token');
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
		if (selectedIds.size === tokens.length) {
			setSelectedIds(new Set());
		} else {
			setSelectedIds(new Set(tokens.map((t) => t.id)));
		}
	};

	const handleBulkDelete = async () => {
		const ids = [...selectedIds];
		if (ids.length === 0) return;
		if (!confirm(`Permanently delete ${ids.length} token${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
		setBulkLoading(true);
		try {
			await bulkDeleteUpstreamTokens(ids);
			setSelectedIds(new Set());
			await fetchTokens();
		} catch (e: any) {
			setError(e.message ?? 'Bulk delete failed');
		} finally {
			setBulkLoading(false);
		}
	};

	const { pageItems, page, pageSize, totalItems, totalPages, pageSizeOptions, setPage, setPageSize } = usePagination(tokens);

	return (
		<div className="space-y-6">
			{/* ── Header row ──────────────────────────────────────── */}
			<div className="flex items-center justify-between">
				<div>
					<h2 className={T.pageTitle}>Upstream Tokens</h2>
					<p className={T.pageDescription}>
						Cloudflare API tokens used for cache purge, DNS, and API proxy operations. Each token is scoped to zones or accounts.
					</p>
				</div>
				<CreateTokenDialog onCreated={handleCreated} />
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
			{loading && <TokensTableSkeleton />}

			{/* ── Empty state ────────────────────────────────────── */}
			{!loading && tokens.length === 0 && !error && (
				<div className="flex h-48 items-center justify-center">
					<p className={T.mutedSm}>No upstream tokens registered. Register one to enable cache purging.</p>
				</div>
			)}

			{/* ── Tokens table ───────────────────────────────────── */}
			{!loading && tokens.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className={T.sectionHeading}>Tokens ({tokens.length})</CardTitle>
					</CardHeader>
					<CardContent className="p-0">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-8">
										<input
											type="checkbox"
											checked={tokens.length > 0 && selectedIds.size === tokens.length}
											onChange={toggleSelectAll}
											className="rounded border-border"
											aria-label="Select all"
										/>
									</TableHead>
									<TableHead className={T.sectionLabel}>Name</TableHead>
									<TableHead className={T.sectionLabel}>ID</TableHead>
									<TableHead className={T.sectionLabel}>Token</TableHead>
									<TableHead className={T.sectionLabel}>Scope</TableHead>
									<TableHead className={T.sectionLabel}>Zones / Accounts</TableHead>
									<TableHead className={T.sectionLabel}>Expires</TableHead>
									<TableHead className={T.sectionLabel}>Created</TableHead>
									<TableHead className={T.sectionLabel}>Created By</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')}>Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{pageItems.map((t) => (
									<TableRow key={t.id} className={isExpired(t.expires_at) ? 'opacity-50' : undefined}>
										<TableCell className="w-8">
											<input
												type="checkbox"
												checked={selectedIds.has(t.id)}
												onChange={() => toggleSelect(t.id)}
												className="rounded border-border"
												aria-label="Select row"
											/>
										</TableCell>
										<TableCell className={T.tableRowName}>{t.name}</TableCell>
										<TableCell>
											<div className="flex items-center gap-1">
												<code className={T.tableCellMono} title={t.id}>
													{truncateId(t.id)}
												</code>
												<button
													type="button"
													onClick={() => handleCopyId(t.id)}
													className="text-muted-foreground hover:text-foreground"
													title="Copy full ID"
												>
													{copiedId === t.id ? <Check className="h-3 w-3 text-lv-green" /> : <Copy className="h-3 w-3" />}
												</button>
											</div>
										</TableCell>
										<TableCell>
											<code className={T.tableCellMono}>{t.token_preview}</code>
										</TableCell>
										<TableCell className={T.tableCell}>
											<span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-data">
												{formatScopeType(t.scope_type)}
											</span>
										</TableCell>
										<TableCell className={T.tableCell}>
											<span title={t.zone_ids}>{formatZoneIds(t.zone_ids)}</span>
										</TableCell>
										<TableCell className={T.tableCell}>
											<span className={isExpired(t.expires_at) ? 'text-lv-red' : undefined}>{formatExpiry(t.expires_at)}</span>
										</TableCell>
										<TableCell className={T.tableCell}>{formatDate(t.created_at)}</TableCell>
										<TableCell className={T.tableCell}>{t.created_by ?? <span className={T.muted}>--</span>}</TableCell>
										<TableCell className="text-right">
											<Button
												size="xs"
												variant="ghost"
												className="text-lv-red hover:text-lv-red-bright hover:bg-lv-red/10"
												onClick={() => handleDelete(t.id)}
												disabled={deletingId === t.id}
											>
												{deletingId === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
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
							noun="tokens"
						/>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
