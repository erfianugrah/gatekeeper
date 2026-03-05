import { useState, useCallback, useEffect } from 'react';
import { Plus, ShieldOff, Loader2, Copy, Check } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { listUpstreamTokens, createUpstreamToken, revokeUpstreamToken } from '@/lib/api';
import type { UpstreamToken } from '@/lib/api';
import { cn } from '@/lib/utils';
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

function formatZoneIds(zoneIds: string): string {
	if (zoneIds === '*') return 'All zones';
	const ids = zoneIds.split(',');
	if (ids.length === 1) return ids[0];
	return `${ids.length} zones`;
}

// ─── Create Token Dialog ────────────────────────────────────────────

interface CreateTokenDialogProps {
	onCreated: () => void;
}

function CreateTokenDialog({ onCreated }: CreateTokenDialogProps) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState('');
	const [token, setToken] = useState('');
	const [zoneIdsInput, setZoneIdsInput] = useState('*');
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

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

		const zoneIds =
			zoneIdsInput.trim() === '*'
				? ['*']
				: zoneIdsInput
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean);

		if (zoneIds.length === 0) {
			setError('At least one zone ID is required (or * for all)');
			return;
		}

		setCreating(true);
		try {
			await createUpstreamToken({ name: name.trim(), token: token.trim(), zone_ids: zoneIds });
			onCreated();
			setOpen(false);
			setName('');
			setToken('');
			setZoneIdsInput('*');
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
						Register a Cloudflare API token for cache purge operations. The token is stored encrypted in the Durable Object.
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
						<Label className={T.formLabel}>Zone IDs</Label>
						<Input
							placeholder="* for all zones, or comma-separated zone IDs"
							value={zoneIdsInput}
							onChange={(e) => setZoneIdsInput(e.target.value)}
						/>
						<p className={T.muted}>
							Use <code className="text-[10px] font-data">*</code> for all zones, or provide specific zone IDs separated by commas.
						</p>
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
	const [revokingId, setRevokingId] = useState<string | null>(null);
	const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'revoked'>('all');
	const [copiedId, setCopiedId] = useState<string | null>(null);

	const fetchTokens = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const filter = statusFilter === 'all' ? undefined : statusFilter;
			const data = await listUpstreamTokens(filter);
			setTokens(data);
		} catch (e: any) {
			setError(e.message ?? 'Failed to load upstream tokens');
			setTokens([]);
		} finally {
			setLoading(false);
		}
	}, [statusFilter]);

	useEffect(() => {
		fetchTokens();
	}, [fetchTokens]);

	const handleRevoke = async (id: string) => {
		if (!confirm(`Revoke upstream token ${truncateId(id)}? This cannot be undone.`)) return;
		setRevokingId(id);
		try {
			await revokeUpstreamToken(id);
			await fetchTokens();
		} catch (e: any) {
			setError(e.message ?? 'Failed to revoke token');
		} finally {
			setRevokingId(null);
		}
	};

	const handleCopyId = async (id: string) => {
		await navigator.clipboard.writeText(id);
		setCopiedId(id);
		setTimeout(() => setCopiedId(null), 2000);
	};

	const activeCount = tokens.filter((t) => !t.revoked).length;
	const revokedCount = tokens.filter((t) => t.revoked).length;

	return (
		<div className="space-y-6">
			{/* ── Header row ──────────────────────────────────────── */}
			<div className="flex items-center justify-between">
				<div>
					<h2 className={T.pageTitle}>Upstream Tokens</h2>
					<p className={T.pageDescription}>
						Cloudflare API tokens used for cache purge operations. Each token can be scoped to specific zones.
					</p>
				</div>
				<CreateTokenDialog onCreated={fetchTokens} />
			</div>

			{/* ── Error ──────────────────────────────────────────── */}
			{error && <div className="rounded-lg border border-lv-red/30 bg-lv-red/10 px-4 py-3 text-sm text-lv-red">{error}</div>}

			{/* ── Filter tabs ────────────────────────────────────── */}
			<Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as 'all' | 'active' | 'revoked')}>
				<TabsList>
					<TabsTrigger value="all">All ({tokens.length})</TabsTrigger>
					<TabsTrigger value="active">Active ({activeCount})</TabsTrigger>
					<TabsTrigger value="revoked">Revoked ({revokedCount})</TabsTrigger>
				</TabsList>
			</Tabs>

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
									<TableHead className={T.sectionLabel}>Name</TableHead>
									<TableHead className={T.sectionLabel}>ID</TableHead>
									<TableHead className={T.sectionLabel}>Token</TableHead>
									<TableHead className={T.sectionLabel}>Zones</TableHead>
									<TableHead className={T.sectionLabel}>Status</TableHead>
									<TableHead className={T.sectionLabel}>Created</TableHead>
									<TableHead className={T.sectionLabel}>Created By</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')}>Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{tokens.map((t) => (
									<TableRow key={t.id}>
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
											<span title={t.zone_ids}>{formatZoneIds(t.zone_ids)}</span>
										</TableCell>
										<TableCell>
											{t.revoked ? (
												<Badge className="bg-lv-red/20 text-lv-red border-lv-red/30">Revoked</Badge>
											) : (
												<Badge className="bg-lv-green/20 text-lv-green border-lv-green/30">Active</Badge>
											)}
										</TableCell>
										<TableCell className={T.tableCell}>{formatDate(t.created_at)}</TableCell>
										<TableCell className={T.tableCell}>{t.created_by ?? <span className={T.muted}>--</span>}</TableCell>
										<TableCell className="text-right">
											{!t.revoked && (
												<Button
													size="xs"
													variant="ghost"
													className="text-lv-red hover:text-lv-red-bright hover:bg-lv-red/10"
													onClick={() => handleRevoke(t.id)}
													disabled={revokingId === t.id}
												>
													{revokingId === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
													Revoke
												</Button>
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
