import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, ShieldOff, Trash2, Loader2, Search, ArrowUpDown, ArrowUp, ArrowDown, ChevronRight, ChevronsDownUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { PolicyBuilder } from '@/components/PolicyBuilder';
import { JsonHighlight } from '@/components/JsonHighlight';
import { usePagination } from '@/hooks/use-pagination';
import { TablePagination } from '@/components/TablePagination';
import { listKeys, createKey, revokeKey, deleteKey, bulkRevokeKeys, bulkDeleteKeys, listUpstreamTokens, POLICY_VERSION } from '@/lib/api';
import type { ApiKey, PolicyDocument, UpstreamToken } from '@/lib/api';
import { cn, copyToClipboard } from '@/lib/utils';
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

function makeDefaultPolicy(scopeType?: 'zone' | 'account'): PolicyDocument {
	const defaultAction = scopeType === 'account' ? 'd1:*' : 'purge:*';
	return {
		version: POLICY_VERSION,
		statements: [
			{
				_id: crypto.randomUUID(),
				effect: 'allow',
				actions: [defaultAction],
				resources: [],
			},
		],
	};
}

/** Build a resource hint from token scope. */
function buildResourceHint(token: UpstreamToken): string {
	if (token.scope_type === 'zone') {
		const ids = token.zone_ids.split(',').map((s) => s.trim());
		if (ids.length === 1 && ids[0] === '*') return 'zone:* (all zones)';
		if (ids.length === 1) return `zone:${ids[0]}`;
		return ids.map((id) => `zone:${id}`).join(', ');
	}
	// Account-scoped
	return `account:${token.zone_ids}`;
}

/** Build default resources from token scope. */
function buildDefaultResources(token: UpstreamToken): string[] {
	if (token.scope_type === 'zone') {
		const ids = token.zone_ids.split(',').map((s) => s.trim());
		if (ids.length === 1 && ids[0] === '*') return ['zone:*'];
		return ids.map((id) => `zone:${id}`);
	}
	return [`account:${token.zone_ids}`];
}

function CreateKeyDialog({ onCreated }: CreateKeyDialogProps) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState('');
	const [expiresInDays, setExpiresInDays] = useState('');
	const [selectedTokenId, setSelectedTokenId] = useState('');
	const [tokens, setTokens] = useState<UpstreamToken[]>([]);
	const [tokensLoading, setTokensLoading] = useState(false);
	const [policy, setPolicy] = useState<PolicyDocument>(() => makeDefaultPolicy());
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const selectedToken = useMemo(() => tokens.find((t) => t.id === selectedTokenId), [tokens, selectedTokenId]);
	const scopeType = selectedToken?.scope_type;
	const resourceHint = selectedToken ? buildResourceHint(selectedToken) : undefined;

	// Group tokens by scope_type for the dropdown
	const zoneTokens = useMemo(() => tokens.filter((t) => t.scope_type === 'zone'), [tokens]);
	const accountTokens = useMemo(() => tokens.filter((t) => t.scope_type === 'account'), [tokens]);

	// Fetch tokens when dialog opens
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setTokensLoading(true);
		listUpstreamTokens()
			.then((data) => {
				if (cancelled) return;
				setTokens(data);
			})
			.catch(() => {
				if (cancelled) return;
				setTokens([]);
			})
			.finally(() => {
				if (!cancelled) setTokensLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	// When token changes, reset policy to match scope
	const handleTokenChange = (tokenId: string) => {
		setSelectedTokenId(tokenId);
		const token = tokens.find((t) => t.id === tokenId);
		if (token) {
			const newPolicy = makeDefaultPolicy(token.scope_type);
			// Pre-fill resources from token scope
			newPolicy.statements[0].resources = buildDefaultResources(token);
			setPolicy(newPolicy);
		}
	};

	const handleCreate = async () => {
		setError(null);
		if (!selectedTokenId) {
			setError('Select an upstream token');
			return;
		}
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
			const result = await createKey({
				name,
				upstream_token_id: selectedTokenId,
				policy,
				expires_in_days: expiresInDays ? Number(expiresInDays) : undefined,
			});
			onCreated(result.key.id);
			setOpen(false);
			setName('');
			setExpiresInDays('');
			setSelectedTokenId('');
			setPolicy(makeDefaultPolicy());
		} catch (e: any) {
			setError(e.message ?? 'Failed to create key');
		} finally {
			setCreating(false);
		}
	};

	const handleOpenChange = (next: boolean) => {
		if (next) {
			setPolicy(makeDefaultPolicy());
			setSelectedTokenId('');
			setError(null);
		}
		setOpen(next);
		setError(null);
	};

	/** Format token label for the dropdown. */
	const tokenLabel = (t: UpstreamToken) => {
		const scopeInfo = t.scope_type === 'zone' ? `zones: ${t.zone_ids}` : `account: ${t.zone_ids}`;
		return `${t.name} (${scopeInfo})`;
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
					<DialogDescription>Select an upstream token to determine the key's scope, then configure permissions.</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					{/* Step 1: Upstream Token */}
					<div className="space-y-2">
						<Label className={T.formLabel}>Upstream Token</Label>
						{tokensLoading ? (
							<Skeleton className="h-9 w-full" />
						) : tokens.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								No upstream tokens found. Create one in the{' '}
								<a href="/dashboard/upstream-tokens" className="text-lv-blue hover:underline">
									Upstream Tokens
								</a>{' '}
								page first.
							</p>
						) : (
							<>
								<Select value={selectedTokenId} onValueChange={handleTokenChange}>
									<SelectTrigger className="text-xs font-data">
										<SelectValue placeholder="Select upstream token..." />
									</SelectTrigger>
									<SelectContent>
										{zoneTokens.length > 0 && (
											<SelectGroup>
												<SelectLabel className="text-[10px] text-muted-foreground/60">Zone-scoped (Purge, DNS)</SelectLabel>
												{zoneTokens.map((t) => (
													<SelectItem key={t.id} value={t.id} className="text-xs font-data">
														{tokenLabel(t)}
													</SelectItem>
												))}
											</SelectGroup>
										)}
										{accountTokens.length > 0 && (
											<SelectGroup>
												<SelectLabel className="text-[10px] text-muted-foreground/60">
													Account-scoped (D1, KV, Workers, Queues, Vectorize, Hyperdrive)
												</SelectLabel>
												{accountTokens.map((t) => (
													<SelectItem key={t.id} value={t.id} className="text-xs font-data">
														{tokenLabel(t)}
													</SelectItem>
												))}
											</SelectGroup>
										)}
									</SelectContent>
								</Select>
								{selectedToken && (
									<p className="text-[11px] font-data text-muted-foreground">
										<Badge
											className={cn(
												'text-[9px] px-1 py-0 mr-1.5',
												scopeType === 'zone'
													? 'bg-lv-blue/20 text-lv-blue border-lv-blue/30'
													: 'bg-lv-peach/20 text-lv-peach border-lv-peach/30',
											)}
										>
											{scopeType}
										</Badge>
										{scopeType === 'zone' ? 'Purge and DNS actions' : 'D1, KV, Workers, Queues, Vectorize, Hyperdrive actions'}
										{' — '}
										<code className="text-lv-cyan">{selectedToken.token_preview}</code>
									</p>
								)}
							</>
						)}
					</div>

					{/* Step 2: Key Name */}
					<div className="space-y-2">
						<Label className={T.formLabel}>Key Name</Label>
						<Input placeholder="e.g. deploy-bot" value={name} onChange={(e: any) => setName(e.target.value)} />
					</div>

					<div className="space-y-2">
						<Label className={T.formLabel}>Expires In (days)</Label>
						<Input
							type="number"
							placeholder="Leave empty for no expiry"
							value={expiresInDays}
							onChange={(e: any) => setExpiresInDays(e.target.value)}
							min={1}
						/>
					</div>

					{/* Step 3: Policy (only shown after token selected) */}
					{selectedTokenId && (
						<div className="space-y-2">
							<Label className={T.formLabel}>Policy</Label>
							<PolicyBuilder value={policy} onChange={setPolicy} tokenScopeType={scopeType} resourceHint={resourceHint} />
						</div>
					)}

					{error && <p className="text-sm text-lv-red">{error}</p>}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button onClick={handleCreate} disabled={creating || !name.trim() || !selectedTokenId}>
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
		await copyToClipboard(secret);
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

// ─── Policy Detail Row (expanded) ───────────────────────────────────

function formatCondition(c: any): string {
	if ('any' in c) return `any(${c.any.map(formatCondition).join(', ')})`;
	if ('all' in c) return `all(${c.all.map(formatCondition).join(', ')})`;
	if ('not' in c) return `not(${formatCondition(c.not)})`;
	const val = Array.isArray(c.value) ? c.value.join(', ') : String(c.value);
	return `${c.field} ${c.operator} ${val}`;
}

function formatTimestamp(epoch: number): string {
	return new Date(epoch).toLocaleString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	});
}

/** Label + value pair used in the detail grid. */
function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="contents">
			<span className="text-[11px] font-data text-muted-foreground/70 select-none">{label}</span>
			<span className="text-[11px] font-data break-all select-all">{children}</span>
		</div>
	);
}

function KeyDetailRow({ apiKey, colSpan }: { apiKey: ApiKey; colSpan: number }) {
	const [showJson, setShowJson] = useState(false);
	let parsedPolicy: PolicyDocument | null = null;
	try {
		parsedPolicy = typeof apiKey.policy === 'string' ? JSON.parse(apiKey.policy) : apiKey.policy;
	} catch {
		/* invalid JSON */
	}

	return (
		<TableRow className="bg-muted/30 hover:bg-muted/40 border-b border-border/50">
			<TableCell colSpan={colSpan} className="px-6 py-3">
				<div className="space-y-4 max-w-4xl">
					{/* ── Key metadata ──────────────────────────────── */}
					<div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
						<DetailField label="id">
							<span className="text-lv-cyan">{apiKey.id}</span>
						</DetailField>
						<DetailField label="name">
							<span className="text-foreground">{apiKey.name}</span>
						</DetailField>
						<DetailField label="zone_id">
							{apiKey.zone_id ? (
								<span className="text-lv-cyan">{apiKey.zone_id}</span>
							) : (
								<span className="italic text-muted-foreground/40">any</span>
							)}
						</DetailField>
						<DetailField label="status">
							{apiKey.revoked ? (
								<span className="text-lv-red font-semibold">Revoked</span>
							) : (
								<span className="text-lv-green font-semibold">Active</span>
							)}
						</DetailField>
						<DetailField label="created_at">
							<span className="text-lv-blue">{formatTimestamp(apiKey.created_at)}</span>
						</DetailField>
						<DetailField label="expires_at">
							{apiKey.expires_at ? (
								<span className="text-lv-blue">{formatTimestamp(apiKey.expires_at)}</span>
							) : (
								<span className="italic text-muted-foreground/40">never</span>
							)}
						</DetailField>
						<DetailField label="created_by">
							{apiKey.created_by ? (
								<span className="text-lv-cyan">{apiKey.created_by}</span>
							) : (
								<span className="italic text-muted-foreground/40">null</span>
							)}
						</DetailField>
					</div>

					{/* ── Rate limits ──────────────────────────────── */}
					<div>
						<span className="text-[11px] font-data text-muted-foreground/50 block mb-1">Rate Limits</span>
						<div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
							<DetailField label="single_rate">
								{apiKey.single_rate != null ? (
									<span className="text-lv-purple">
										{apiKey.single_rate} <span className="text-muted-foreground">req/s</span>
									</span>
								) : (
									<span className="italic text-muted-foreground/40">default</span>
								)}
							</DetailField>
							<DetailField label="single_bucket">
								{apiKey.single_bucket != null ? (
									<span className="text-lv-purple">{apiKey.single_bucket}</span>
								) : (
									<span className="italic text-muted-foreground/40">default</span>
								)}
							</DetailField>
							<DetailField label="bulk_rate">
								{apiKey.bulk_rate != null ? (
									<span className="text-lv-purple">
										{apiKey.bulk_rate} <span className="text-muted-foreground">req/s</span>
									</span>
								) : (
									<span className="italic text-muted-foreground/40">default</span>
								)}
							</DetailField>
							<DetailField label="bulk_bucket">
								{apiKey.bulk_bucket != null ? (
									<span className="text-lv-purple">{apiKey.bulk_bucket}</span>
								) : (
									<span className="italic text-muted-foreground/40">default</span>
								)}
							</DetailField>
						</div>
					</div>

					{/* ── Policy ───────────────────────────────────── */}
					<div>
						<div className="flex items-center gap-2 mb-2">
							<span className="text-[11px] font-data text-muted-foreground/50">Policy</span>
							{parsedPolicy && <span className="text-[11px] font-data text-muted-foreground/40">v{parsedPolicy.version}</span>}
						</div>
						{!parsedPolicy || !parsedPolicy.statements || parsedPolicy.statements.length === 0 ? (
							<span className="text-[11px] font-data text-muted-foreground/70 italic">No policy data</span>
						) : (
							<div className="space-y-2">
								{parsedPolicy.statements.map((stmt, i) => (
									<div key={stmt._id ?? i} className="rounded border border-border/50 bg-background/50 px-3 py-2 space-y-1.5">
										<div className="flex items-center gap-2">
											<Badge
												className={cn(
													'text-[10px] px-1.5 py-0',
													stmt.effect === 'allow'
														? 'bg-lv-green/20 text-lv-green border-lv-green/30'
														: 'bg-lv-red/20 text-lv-red border-lv-red/30',
												)}
											>
												{stmt.effect.toUpperCase()}
											</Badge>
											<span className="text-[11px] font-data text-muted-foreground/50">Statement {i + 1}</span>
										</div>
										<div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
											<span className="text-[11px] font-data text-muted-foreground/70">actions</span>
											<span className="text-[11px] font-data text-lv-cyan">{stmt.actions.join(', ')}</span>
											<span className="text-[11px] font-data text-muted-foreground/70">resources</span>
											<span className="text-[11px] font-data text-lv-purple">{stmt.resources.join(', ')}</span>
											{stmt.conditions && stmt.conditions.length > 0 && (
												<>
													<span className="text-[11px] font-data text-muted-foreground/70">conditions</span>
													<span className="text-[11px] font-data text-lv-peach">{stmt.conditions.map(formatCondition).join(' AND ')}</span>
												</>
											)}
										</div>
									</div>
								))}
								<button
									type="button"
									onClick={() => setShowJson(!showJson)}
									className="text-[10px] text-lv-blue/60 hover:text-lv-blue hover:underline font-data"
								>
									{showJson ? 'Hide JSON' : 'Show JSON'}
								</button>
								{showJson && <JsonHighlight data={parsedPolicy} />}
							</div>
						)}
					</div>
				</div>
			</TableCell>
		</TableRow>
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
	const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

	const toggleExpanded = (id: string) => {
		setExpandedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

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

	const { pageItems, page, pageSize, totalItems, totalPages, pageSizeOptions, setPage, setPageSize } = usePagination(filteredKeys);

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
						<div className="flex items-center justify-between">
							<CardTitle className={T.sectionHeading}>
								API Keys ({filteredKeys.length}
								{filteredKeys.length !== keys.length ? ` of ${keys.length}` : ''})
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
												aria-label="Select all"
											/>
										</TableHead>
										<TableHead className="w-6 px-2" />
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} {...sortableProps('name')}>
											<span className="flex items-center gap-1">
												Name <SortIcon field="name" />
											</span>
										</TableHead>
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} {...sortableProps('id')}>
											<span className="flex items-center gap-1">
												ID <SortIcon field="id" />
											</span>
										</TableHead>
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} {...sortableProps('zone_id')}>
											<span className="flex items-center gap-1">
												Zone <SortIcon field="zone_id" />
											</span>
										</TableHead>
										<TableHead className={T.sectionLabel}>Status</TableHead>
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} {...sortableProps('created_at')}>
											<span className="flex items-center gap-1">
												Created <SortIcon field="created_at" />
											</span>
										</TableHead>
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} {...sortableProps('expires_at')}>
											<span className="flex items-center gap-1">
												Expires <SortIcon field="expires_at" />
											</span>
										</TableHead>
										<TableHead className={cn(T.sectionLabel, 'cursor-pointer select-none')} {...sortableProps('created_by')}>
											<span className="flex items-center gap-1">
												Created By <SortIcon field="created_by" />
											</span>
										</TableHead>
										<TableHead className={cn(T.sectionLabel, 'text-right')}>Actions</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{pageItems.map((k) => {
										const isExpanded = expandedIds.has(k.id);
										return (
											<>
												<TableRow
													key={k.id}
													className={cn(
														'cursor-pointer select-none',
														selectedIds.has(k.id) && 'bg-lv-purple/5',
														isExpanded && 'bg-muted/30',
													)}
													onClick={() => toggleExpanded(k.id)}
												>
													<TableCell className="w-8" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
														<input
															type="checkbox"
															checked={selectedIds.has(k.id)}
															onChange={() => toggleSelect(k.id)}
															className="rounded border-border"
															aria-label="Select row"
														/>
													</TableCell>
													<TableCell className="w-6 px-2">
														<ChevronRight
															className={cn(
																'h-3.5 w-3.5 text-muted-foreground transition-transform duration-150',
																isExpanded && 'rotate-90',
															)}
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
													<TableCell className="text-right space-x-1" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
														{!k.revoked && (
															<Button
																size="xs"
																variant="ghost"
																className="text-lv-red hover:text-lv-red-bright hover:bg-lv-red/10"
																onClick={() => handleRevoke(k.id)}
																disabled={revokingId === k.id}
															>
																{revokingId === k.id ? (
																	<Loader2 className="h-3.5 w-3.5 animate-spin" />
																) : (
																	<ShieldOff className="h-3.5 w-3.5" />
																)}
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
																{deletingId === k.id ? (
																	<Loader2 className="h-3.5 w-3.5 animate-spin" />
																) : (
																	<Trash2 className="h-3.5 w-3.5" />
																)}
																Delete
															</Button>
														)}
													</TableCell>
												</TableRow>
												{isExpanded && <KeyDetailRow key={`${k.id}-detail`} apiKey={k} colSpan={10} />}
											</>
										);
									})}
								</TableBody>
							</Table>
						)}
						<TablePagination
							page={page}
							totalPages={totalPages}
							totalItems={totalItems}
							pageSize={pageSize}
							pageSizeOptions={pageSizeOptions}
							onPageChange={setPage}
							onPageSizeChange={setPageSize}
							noun="keys"
						/>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
