import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, ShieldOff, Trash2, Loader2, Search, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { PolicyBuilder } from '@/components/PolicyBuilder';
import { listKeys, createKey, revokeKey, deleteKey, bulkRevokeKeys, bulkDeleteKeys } from '@/lib/api';
import type { ApiKey, PolicyDocument } from '@/lib/api';
import { cn } from '@/lib/utils';
import { T } from '@/lib/typography';

// ─── Sort types ─────────────────────────────────────────────────────

type SortField = 'name' | 'id' | 'zone_id' | 'created_at' | 'expires_at' | 'created_by';
type SortDir = 'asc' | 'desc';

// ─── Helpers ────────────────────────────────────────────────────────

function truncateId(id: string, len = 12): string {
	return id.length > len ? `${id.slice(0, len)}...` : id;
}

function formatDate(epoch: number): string {
	return new Date(epoch).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

// ─── Create Key Dialog ──────────────────────────────────────────────

interface CreateKeyDialogProps {
	onCreated: (secret: string) => void;
}

function makeDefaultPolicy(): PolicyDocument {
	return {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['purge:*'],
				resources: ['*'],
			},
		],
	};
}

function CreateKeyDialog({ onCreated }: CreateKeyDialogProps) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState('');
	const [policy, setPolicy] = useState<PolicyDocument>(() => makeDefaultPolicy());
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleCreate = async () => {
		setError(null);
		if (policy.statements.length === 0) {
			setError('Policy must have at least one statement');
			return;
		}
		if (policy.statements.some((s: any) => s.actions.length === 0)) {
			setError('Each statement must have at least one action');
			return;
		}

		setCreating(true);
		try {
			const result = await createKey({ name, policy });
			onCreated(result.key.id);
			setOpen(false);
			setName('');
			setPolicy(makeDefaultPolicy());
		} catch (e: any) {
			setError(e.message ?? 'Failed to create key');
		} finally {
			setCreating(false);
		}
	};

	const handleOpenChange = (next: boolean) => {
		if (next) setPolicy(makeDefaultPolicy());
		setOpen(next);
		setError(null);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button size="sm">
					<Plus className="h-4 w-4" />
					Create Key
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-2xl xl:max-w-4xl 2xl:max-w-5xl max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Create API Key</DialogTitle>
					<DialogDescription>Create a new purge API key. The zone is determined at purge time, not key creation.</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-2">
						<Label className={T.formLabel}>Key Name</Label>
						<Input placeholder="e.g. deploy-bot" value={name} onChange={(e: any) => setName(e.target.value)} />
					</div>

					<div className="space-y-2">
						<Label className={T.formLabel}>Policy</Label>
						<PolicyBuilder value={policy} onChange={setPolicy} />
					</div>

					{error && <p className="text-sm text-lv-red">{error}</p>}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button onClick={handleCreate} disabled={creating || !name.trim()}>
						{creating && <Loader2 className="h-4 w-4 animate-spin" />}
						Create
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ─── Secret Banner ──────────────────────────────────────────────────

function SecretBanner({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(secret);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<div className="rounded-lg border border-lv-green/30 bg-lv-green/10 px-4 py-3 space-y-2">
			<p className="text-sm font-medium text-lv-green">Key created! Copy the secret now — it will not be shown again.</p>
			<div className="flex items-center gap-2">
				<code className="flex-1 break-all rounded bg-lovelace-800 px-3 py-1.5 font-data text-xs text-foreground">{secret}</code>
				<Button size="sm" variant="outline" onClick={handleCopy}>
					{copied ? 'Copied!' : 'Copy'}
				</Button>
				<Button size="sm" variant="ghost" onClick={onDismiss}>
					Dismiss
				</Button>
			</div>
		</div>
	);
}

// ─── Loading Skeleton ───────────────────────────────────────────────

function KeysTableSkeleton() {
	return (
		<div className="space-y-2">
			{Array.from({ length: 5 }).map((_, i) => (
				<Skeleton key={i} className="h-10 w-full" />
			))}
		</div>
	);
}

// ─── Keys Page ──────────────────────────────────────────────────────

export function KeysPage() {
	const [keys, setKeys] = useState<ApiKey[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [secret, setSecret] = useState<string | null>(null);
	const [revokingId, setRevokingId] = useState<string | null>(null);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [bulkLoading, setBulkLoading] = useState(false);
	const [search, setSearch] = useState('');
	const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'revoked'>('all');
	const [sortField, setSortField] = useState<SortField>('created_at');
	const [sortDir, setSortDir] = useState<SortDir>('desc');

	const fetchKeys = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await listKeys();
			setKeys(data);
		} catch (e: any) {
			setError(e.message ?? 'Failed to load keys');
			setKeys([]);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchKeys();
	}, [fetchKeys]);

	const handleRevoke = async (keyId: string) => {
		if (!confirm(`Revoke key ${truncateId(keyId)}? This cannot be undone.`)) return;
		setRevokingId(keyId);
		try {
			await revokeKey(keyId);
			await fetchKeys();
		} catch (e: any) {
			setError(e.message ?? 'Failed to revoke key');
		} finally {
			setRevokingId(null);
		}
	};

	const handleDelete = async (keyId: string) => {
		if (!confirm(`Permanently delete key ${truncateId(keyId)}? The row will be removed from the database. Analytics are preserved.`))
			return;
		setDeletingId(keyId);
		try {
			await deleteKey(keyId);
			await fetchKeys();
		} catch (e: any) {
			setError(e.message ?? 'Failed to delete key');
		} finally {
			setDeletingId(null);
		}
	};

	const handleKeyCreated = (newSecret: string) => {
		setSecret(newSecret);
		fetchKeys();
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
		if (selectedIds.size === filteredKeys.length) {
			setSelectedIds(new Set());
		} else {
			setSelectedIds(new Set(filteredKeys.map((k) => k.id)));
		}
	};

	const handleBulkRevoke = async () => {
		const ids = [...selectedIds];
		const activeIds = ids.filter((id) => keys.find((k) => k.id === id && !k.revoked));
		if (activeIds.length === 0) return;
		if (!confirm(`Bulk revoke ${activeIds.length} key${activeIds.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
		setBulkLoading(true);
		try {
			await bulkRevokeKeys(activeIds);
			setSelectedIds(new Set());
			await fetchKeys();
		} catch (e: any) {
			setError(e.message ?? 'Bulk revoke failed');
		} finally {
			setBulkLoading(false);
		}
	};

	const handleBulkDelete = async () => {
		const ids = [...selectedIds];
		const revokedIds = ids.filter((id) => keys.find((k) => k.id === id && k.revoked));
		if (revokedIds.length === 0) return;
		if (!confirm(`Permanently delete ${revokedIds.length} key${revokedIds.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
		setBulkLoading(true);
		try {
			await bulkDeleteKeys(revokedIds);
			setSelectedIds(new Set());
			await fetchKeys();
		} catch (e: any) {
			setError(e.message ?? 'Bulk delete failed');
		} finally {
			setBulkLoading(false);
		}
	};

	const selectedActiveCount = [...selectedIds].filter((id) => keys.find((k) => k.id === id && !k.revoked)).length;
	const selectedRevokedCount = [...selectedIds].filter((id) => keys.find((k) => k.id === id && k.revoked)).length;

	const toggleSort = (field: SortField) => {
		if (sortField === field) {
			setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
		} else {
			setSortField(field);
			setSortDir(field === 'name' ? 'asc' : 'desc');
		}
	};

	const SortIcon = ({ field }: { field: SortField }) => {
		if (sortField !== field) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
		return sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
	};

	const filteredKeys = useMemo(() => {
		let result = keys;

		// Status filter
		if (statusFilter === 'active') result = result.filter((k) => !k.revoked);
		else if (statusFilter === 'revoked') result = result.filter((k) => k.revoked);

		// Text search
		if (search.trim()) {
			const q = search.toLowerCase();
			result = result.filter(
				(k) =>
					k.name.toLowerCase().includes(q) ||
					k.id.toLowerCase().includes(q) ||
					(k.zone_id ?? '').toLowerCase().includes(q) ||
					(k.created_by ?? '').toLowerCase().includes(q),
			);
		}

		// Sort
		result = [...result].sort((a, b) => {
			let cmp = 0;
			switch (sortField) {
				case 'name':
					cmp = a.name.localeCompare(b.name);
					break;
				case 'id':
					cmp = a.id.localeCompare(b.id);
					break;
				case 'zone_id':
					cmp = (a.zone_id ?? '').localeCompare(b.zone_id ?? '');
					break;
				case 'created_at':
					cmp = a.created_at - b.created_at;
					break;
				case 'expires_at':
					cmp = (a.expires_at ?? Infinity) - (b.expires_at ?? Infinity);
					break;
				case 'created_by':
					cmp = (a.created_by ?? '').localeCompare(b.created_by ?? '');
					break;
			}
			return sortDir === 'asc' ? cmp : -cmp;
		});

		return result;
	}, [keys, statusFilter, search, sortField, sortDir]);

	const activeCount = keys.filter((k) => !k.revoked).length;
	const revokedCount = keys.filter((k) => k.revoked).length;

	return (
		<div className="space-y-6">
			{/* ── Header ─────────────────────────────────────────────── */}
			<div className="flex items-center gap-3">
				<div className="ml-auto">
					<CreateKeyDialog onCreated={handleKeyCreated} />
				</div>
			</div>

			{/* ── Filters ────────────────────────────────────────────── */}
			<div className="flex flex-wrap items-center gap-3">
				{/* Status tabs */}
				<div className="flex rounded-md border border-border">
					{(['all', 'active', 'revoked'] as const).map((t) => {
						const count = t === 'all' ? keys.length : t === 'active' ? activeCount : revokedCount;
						const labels = { all: 'All', active: 'Active', revoked: 'Revoked' };
						return (
							<button
								key={t}
								onClick={() => setStatusFilter(t)}
								className={cn(
									'px-3 py-1 text-xs font-data transition-colors',
									statusFilter === t ? 'bg-lv-purple/20 text-lv-purple' : 'text-muted-foreground hover:text-foreground hover:bg-muted',
									t !== 'all' && 'border-l border-border',
								)}
							>
								{labels[t]} ({count})
							</button>
						);
					})}
				</div>

				{/* Search */}
				<div className="relative flex-1 max-w-xs">
					<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
					<Input
						placeholder="Search name, ID, zone, created by..."
						value={search}
						onChange={(e: any) => setSearch(e.target.value)}
						className="pl-8 h-8 text-xs font-data"
					/>
				</div>
			</div>

			{/* ── Bulk actions bar ────────────────────────────────────── */}
			{selectedIds.size > 0 && (
				<div className="flex items-center gap-3 rounded-lg border border-lv-purple/30 bg-lv-purple/10 px-4 py-2">
					<span className="text-sm font-data text-lv-purple">{selectedIds.size} selected</span>
					<div className="ml-auto flex gap-2">
						{selectedActiveCount > 0 && (
							<Button
								size="sm"
								variant="outline"
								className="text-lv-red border-lv-red/30"
								onClick={handleBulkRevoke}
								disabled={bulkLoading}
							>
								{bulkLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
								Revoke ({selectedActiveCount})
							</Button>
						)}
						{selectedRevokedCount > 0 && (
							<Button
								size="sm"
								variant="outline"
								className="text-lv-red border-lv-red/30"
								onClick={handleBulkDelete}
								disabled={bulkLoading}
							>
								{bulkLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
								Delete ({selectedRevokedCount})
							</Button>
						)}
						<Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
							Clear
						</Button>
					</div>
				</div>
			)}

			{/* ── Secret banner ──────────────────────────────────────── */}
			{secret && <SecretBanner secret={secret} onDismiss={() => setSecret(null)} />}

			{/* ── Error ──────────────────────────────────────────────── */}
			{error && <div className="rounded-lg border border-lv-red/30 bg-lv-red/10 px-4 py-3 text-sm text-lv-red">{error}</div>}

			{/* ── Loading ────────────────────────────────────────────── */}
			{loading && <KeysTableSkeleton />}

			{/* ── Empty state ────────────────────────────────────────── */}
			{!loading && keys.length === 0 && !error && (
				<div className="flex h-48 items-center justify-center">
					<p className={T.mutedSm}>No API keys found. Create one to get started.</p>
				</div>
			)}

			{/* ── Keys table ─────────────────────────────────────────── */}
			{!loading && keys.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className={T.sectionHeading}>
							API Keys ({filteredKeys.length}
							{filteredKeys.length !== keys.length ? ` of ${keys.length}` : ''})
						</CardTitle>
					</CardHeader>
					<CardContent className="p-0">
						{filteredKeys.length === 0 ? (
							<div className="flex h-32 items-center justify-center">
								<p className={T.mutedSm}>No keys match the current filters.</p>
							</div>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className="w-8">
											<input
												type="checkbox"
												checked={filteredKeys.length > 0 && selectedIds.size === filteredKeys.length}
												onChange={toggleSelectAll}
												className="rounded border-border"
											/>
										</TableHead>
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} onClick={() => toggleSort('name')}>
											<span className="flex items-center gap-1">
												Name <SortIcon field="name" />
											</span>
										</TableHead>
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} onClick={() => toggleSort('id')}>
											<span className="flex items-center gap-1">
												ID <SortIcon field="id" />
											</span>
										</TableHead>
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} onClick={() => toggleSort('zone_id')}>
											<span className="flex items-center gap-1">
												Zone <SortIcon field="zone_id" />
											</span>
										</TableHead>
										<TableHead className={T.sectionLabel}>Status</TableHead>
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} onClick={() => toggleSort('created_at')}>
											<span className="flex items-center gap-1">
												Created <SortIcon field="created_at" />
											</span>
										</TableHead>
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} onClick={() => toggleSort('expires_at')}>
											<span className="flex items-center gap-1">
												Expires <SortIcon field="expires_at" />
											</span>
										</TableHead>
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} onClick={() => toggleSort('created_by')}>
											<span className="flex items-center gap-1">
												Created By <SortIcon field="created_by" />
											</span>
										</TableHead>
										<TableHead className={cn(T.sectionLabel, 'text-right')}>Actions</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{filteredKeys.map((k) => (
										<TableRow key={k.id} className={selectedIds.has(k.id) ? 'bg-lv-purple/5' : undefined}>
											<TableCell className="w-8">
												<input
													type="checkbox"
													checked={selectedIds.has(k.id)}
													onChange={() => toggleSelect(k.id)}
													className="rounded border-border"
												/>
											</TableCell>
											<TableCell className={T.tableRowName}>{k.name}</TableCell>
											<TableCell>
												<code className={T.tableCellMono} title={k.id}>
													{truncateId(k.id)}
												</code>
											</TableCell>
											<TableCell>
												{k.zone_id ? (
													<code className={T.tableCellMono} title={k.zone_id}>
														{truncateId(k.zone_id, 8)}
													</code>
												) : (
													<span className={T.muted}>Any</span>
												)}
											</TableCell>
											<TableCell>
												{k.revoked ? (
													<Badge className="bg-lv-red/20 text-lv-red border-lv-red/30">Revoked</Badge>
												) : (
													<Badge className="bg-lv-green/20 text-lv-green border-lv-green/30">Active</Badge>
												)}
											</TableCell>
											<TableCell className={T.tableCell}>{formatDate(k.created_at)}</TableCell>
											<TableCell className={T.tableCell}>
												{k.expires_at ? formatDate(k.expires_at) : <span className={T.muted}>Never</span>}
											</TableCell>
											<TableCell className={T.tableCell}>{k.created_by ?? <span className={T.muted}>—</span>}</TableCell>
											<TableCell className="text-right space-x-1">
												{!k.revoked && (
													<Button
														size="xs"
														variant="ghost"
														className="text-lv-red hover:text-lv-red-bright hover:bg-lv-red/10"
														onClick={() => handleRevoke(k.id)}
														disabled={revokingId === k.id}
													>
														{revokingId === k.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
														Revoke
													</Button>
												)}
												{!!k.revoked && (
													<Button
														size="xs"
														variant="ghost"
														className="text-muted-foreground hover:text-lv-red hover:bg-lv-red/10"
														onClick={() => handleDelete(k.id)}
														disabled={deletingId === k.id}
													>
														{deletingId === k.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
														Delete
													</Button>
												)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>
			)}
		</div>
	);
}
