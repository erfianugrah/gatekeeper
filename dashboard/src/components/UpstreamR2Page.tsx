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
import { listUpstreamR2, createUpstreamR2, revokeUpstreamR2 } from '@/lib/api';
import type { UpstreamR2 } from '@/lib/api';
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

function formatBuckets(bucketNames: string): string {
	if (bucketNames === '*') return 'All buckets';
	const names = bucketNames.split(',');
	if (names.length <= 2) return names.join(', ');
	return `${names[0]}, ${names[1]} +${names.length - 2} more`;
}

// ─── Create R2 Endpoint Dialog ──────────────────────────────────────

interface CreateEndpointDialogProps {
	onCreated: () => void;
}

function CreateEndpointDialog({ onCreated }: CreateEndpointDialogProps) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState('');
	const [accessKeyId, setAccessKeyId] = useState('');
	const [secretAccessKey, setSecretAccessKey] = useState('');
	const [endpoint, setEndpoint] = useState('');
	const [bucketNamesInput, setBucketNamesInput] = useState('*');
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

		setCreating(true);
		try {
			await createUpstreamR2({
				name: name.trim(),
				access_key_id: accessKeyId.trim(),
				secret_access_key: secretAccessKey.trim(),
				endpoint: endpoint.trim(),
				bucket_names: bucketNames,
			});
			onCreated();
			setOpen(false);
			setName('');
			setAccessKeyId('');
			setSecretAccessKey('');
			setEndpoint('');
			setBucketNamesInput('*');
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
					<DialogDescription>Register an R2 endpoint with credentials for proxying S3-compatible requests.</DialogDescription>
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
	const [revokingId, setRevokingId] = useState<string | null>(null);
	const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'revoked'>('all');
	const [copiedId, setCopiedId] = useState<string | null>(null);

	const fetchEndpoints = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const filter = statusFilter === 'all' ? undefined : statusFilter;
			const data = await listUpstreamR2(filter);
			setEndpoints(data);
		} catch (e: any) {
			setError(e.message ?? 'Failed to load R2 endpoints');
			setEndpoints([]);
		} finally {
			setLoading(false);
		}
	}, [statusFilter]);

	useEffect(() => {
		fetchEndpoints();
	}, [fetchEndpoints]);

	const handleRevoke = async (id: string) => {
		if (!confirm(`Revoke R2 endpoint ${truncateId(id)}? This cannot be undone.`)) return;
		setRevokingId(id);
		try {
			await revokeUpstreamR2(id);
			await fetchEndpoints();
		} catch (e: any) {
			setError(e.message ?? 'Failed to revoke endpoint');
		} finally {
			setRevokingId(null);
		}
	};

	const handleCopyId = async (id: string) => {
		await navigator.clipboard.writeText(id);
		setCopiedId(id);
		setTimeout(() => setCopiedId(null), 2000);
	};

	const activeCount = endpoints.filter((e) => !e.revoked).length;
	const revokedCount = endpoints.filter((e) => e.revoked).length;

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
				<CreateEndpointDialog onCreated={fetchEndpoints} />
			</div>

			{/* ── Error ──────────────────────────────────────────── */}
			{error && <div className="rounded-lg border border-lv-red/30 bg-lv-red/10 px-4 py-3 text-sm text-lv-red">{error}</div>}

			{/* ── Filter tabs ────────────────────────────────────── */}
			<Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as 'all' | 'active' | 'revoked')}>
				<TabsList>
					<TabsTrigger value="all">All ({endpoints.length})</TabsTrigger>
					<TabsTrigger value="active">Active ({activeCount})</TabsTrigger>
					<TabsTrigger value="revoked">Revoked ({revokedCount})</TabsTrigger>
				</TabsList>
			</Tabs>

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
									<TableHead className={T.sectionLabel}>Name</TableHead>
									<TableHead className={T.sectionLabel}>ID</TableHead>
									<TableHead className={T.sectionLabel}>Endpoint</TableHead>
									<TableHead className={T.sectionLabel}>Key</TableHead>
									<TableHead className={T.sectionLabel}>Buckets</TableHead>
									<TableHead className={T.sectionLabel}>Status</TableHead>
									<TableHead className={T.sectionLabel}>Created</TableHead>
									<TableHead className={T.sectionLabel}>Created By</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')}>Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{endpoints.map((ep) => (
									<TableRow key={ep.id}>
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
										<TableCell>
											{ep.revoked ? (
												<Badge className="bg-lv-red/20 text-lv-red border-lv-red/30">Revoked</Badge>
											) : (
												<Badge className="bg-lv-green/20 text-lv-green border-lv-green/30">Active</Badge>
											)}
										</TableCell>
										<TableCell className={T.tableCell}>{formatDate(ep.created_at)}</TableCell>
										<TableCell className={T.tableCell}>{ep.created_by ?? <span className={T.muted}>--</span>}</TableCell>
										<TableCell className="text-right">
											{!ep.revoked && (
												<Button
													size="xs"
													variant="ghost"
													className="text-lv-red hover:text-lv-red-bright hover:bg-lv-red/10"
													onClick={() => handleRevoke(ep.id)}
													disabled={revokingId === ep.id}
												>
													{revokingId === ep.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
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
