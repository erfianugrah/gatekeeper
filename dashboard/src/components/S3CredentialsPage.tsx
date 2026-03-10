import { useState, useCallback, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { Plus, ShieldOff, Trash2, Loader2, Copy, Check, ChevronRight, ChevronsDownUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

import { S3PolicyBuilder } from '@/components/S3PolicyBuilder';
import { JsonHighlight } from '@/components/JsonHighlight';
import { summarizeStatement } from '@/components/ConditionEditor';
import { usePagination } from '@/hooks/use-pagination';
import { TablePagination } from '@/components/TablePagination';
import {
	listS3Credentials,
	createS3Credential,
	revokeS3Credential,
	deleteS3Credential,
	bulkRevokeS3Credentials,
	bulkDeleteS3Credentials,
	listUpstreamR2,
	POLICY_VERSION,
} from '@/lib/api';
import type { S3Credential, PolicyDocument, UpstreamR2 } from '@/lib/api';
import { cn, copyToClipboard } from '@/lib/utils';
import { T } from '@/lib/typography';

// ─── Helpers ────────────────────────────────────────────────────────

function truncateId(id: string, len = 16): string {
	return id.length > len ? `${id.slice(0, len)}...` : id;
}

function formatDate(epoch: number): string {
	return new Date(epoch).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

function makeDefaultS3Policy(endpoint?: UpstreamR2): PolicyDocument {
	// Build resources from endpoint bucket scope
	let resources: string[];
	if (endpoint) {
		const buckets = endpoint.bucket_names.split(',').map((s) => s.trim());
		if (buckets.length === 1 && buckets[0] === '*') {
			resources = ['account:*', 'bucket:*', 'object:*'];
		} else {
			resources = ['account:*', ...buckets.map((b) => `bucket:${b}`), ...buckets.map((b) => `object:${b}/*`)];
		}
	} else {
		resources = ['account:*', 'bucket:*', 'object:*'];
	}

	return {
		version: POLICY_VERSION,
		statements: [
			{
				_id: crypto.randomUUID(),
				effect: 'allow',
				actions: ['s3:*'],
				resources,
			},
		],
	};
}

// ─── Create Credential Dialog ───────────────────────────────────────

interface CreateCredentialDialogProps {
	onCreated: (accessKeyId: string, secretAccessKey: string) => void;
}

function CreateCredentialDialog({ onCreated }: CreateCredentialDialogProps) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState('');
	const [expiresInDays, setExpiresInDays] = useState('');
	const [selectedEndpointId, setSelectedEndpointId] = useState('');
	const [endpoints, setEndpoints] = useState<UpstreamR2[]>([]);
	const [endpointsLoading, setEndpointsLoading] = useState(false);
	const [policy, setPolicy] = useState<PolicyDocument>(() => makeDefaultS3Policy());
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const selectedEndpoint = useMemo(() => endpoints.find((e) => e.id === selectedEndpointId), [endpoints, selectedEndpointId]);

	// Fetch R2 endpoints when dialog opens
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setEndpointsLoading(true);
		listUpstreamR2()
			.then((data) => {
				if (cancelled) return;
				setEndpoints(data);
			})
			.catch(() => {
				if (cancelled) return;
				setEndpoints([]);
			})
			.finally(() => {
				if (!cancelled) setEndpointsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	// When endpoint changes, reset policy with bucket-scoped resources
	const handleEndpointChange = (endpointId: string) => {
		setSelectedEndpointId(endpointId);
		const ep = endpoints.find((e) => e.id === endpointId);
		if (ep) {
			setPolicy(makeDefaultS3Policy(ep));
		}
	};

	const handleCreate = async () => {
		setError(null);
		if (!selectedEndpointId) {
			setError('Select an R2 endpoint');
			return;
		}
		if (policy.statements.length === 0) {
			setError('Policy must have at least one statement');
			return;
		}
		if (policy.statements.some((s) => s.actions.length === 0)) {
			setError('Each statement must have at least one action');
			return;
		}

		setCreating(true);
		try {
			const result = await createS3Credential({
				name,
				upstream_token_id: selectedEndpointId,
				policy,
				expires_in_days: expiresInDays ? Number(expiresInDays) : undefined,
			});
			onCreated(result.credential.access_key_id, result.credential.secret_access_key);
			setOpen(false);
			setName('');
			setExpiresInDays('');
			setSelectedEndpointId('');
			setPolicy(makeDefaultS3Policy());
		} catch (e: any) {
			setError(e.message ?? 'Failed to create credential');
		} finally {
			setCreating(false);
		}
	};

	const handleOpenChange = (next: boolean) => {
		if (next) {
			setPolicy(makeDefaultS3Policy());
			setSelectedEndpointId('');
			setError(null);
		}
		setOpen(next);
		setError(null);
	};

	/** Format endpoint label for the dropdown. */
	const endpointLabel = (ep: UpstreamR2) => {
		const buckets = ep.bucket_names === '*' ? 'all buckets' : ep.bucket_names;
		return `${ep.name} (${buckets})`;
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button size="sm">
					<Plus className="h-4 w-4" />
					Create Credential
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-2xl xl:max-w-4xl 2xl:max-w-5xl max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Create S3 Credential</DialogTitle>
					<DialogDescription>Select an R2 endpoint to bind this credential to, then configure permissions.</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					{/* Step 1: R2 Endpoint */}
					<div className="space-y-2">
						<Label className={T.formLabel}>R2 Endpoint</Label>
						{endpointsLoading ? (
							<Skeleton className="h-9 w-full" />
						) : endpoints.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								No R2 endpoints found. Create one in the{' '}
								<a href="/dashboard/upstream-r2" className="text-lv-blue hover:underline">
									Upstream R2
								</a>{' '}
								page first.
							</p>
						) : (
							<>
								<Select value={selectedEndpointId} onValueChange={handleEndpointChange}>
									<SelectTrigger className="text-xs font-data">
										<SelectValue placeholder="Select R2 endpoint..." />
									</SelectTrigger>
									<SelectContent>
										{endpoints.map((ep) => (
											<SelectItem key={ep.id} value={ep.id} className="text-xs font-data">
												{endpointLabel(ep)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								{selectedEndpoint && (
									<p className="text-[11px] font-data text-muted-foreground">
										<Badge className="text-[9px] px-1 py-0 mr-1.5 bg-lv-blue/20 text-lv-blue border-lv-blue/30">R2</Badge>
										{selectedEndpoint.bucket_names === '*' ? 'All buckets' : `Buckets: ${selectedEndpoint.bucket_names}`}
										{' — '}
										<code className="text-lv-cyan">{selectedEndpoint.endpoint}</code>
										{' — '}
										<code className="text-lv-purple">{selectedEndpoint.access_key_preview}</code>
									</p>
								)}
							</>
						)}
					</div>

					{/* Step 2: Name */}
					<div className="space-y-2">
						<Label className={T.formLabel}>Name</Label>
						<Input placeholder="e.g. rclone-backup, cdn-writer" value={name} onChange={(e) => setName(e.target.value)} />
					</div>

					<div className="space-y-2">
						<Label className={T.formLabel}>Expires In (days)</Label>
						<Input
							type="number"
							placeholder="Leave empty for no expiry"
							value={expiresInDays}
							onChange={(e) => setExpiresInDays(e.target.value)}
							min={1}
						/>
					</div>

					{/* Step 3: Policy (only shown after endpoint selected) */}
					{selectedEndpointId && (
						<div className="space-y-2">
							<Label className={T.formLabel}>Policy</Label>
							<S3PolicyBuilder value={policy} onChange={setPolicy} />
						</div>
					)}

					{error && <p className="text-sm text-lv-red">{error}</p>}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button onClick={handleCreate} disabled={creating || !name.trim() || !selectedEndpointId}>
						{creating && <Loader2 className="h-4 w-4 animate-spin" />}
						Create
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ─── Secret Banner ──────────────────────────────────────────────────

interface SecretBannerProps {
	accessKeyId: string;
	secretAccessKey: string;
	onDismiss: () => void;
}

function SecretBanner({ accessKeyId, secretAccessKey, onDismiss }: SecretBannerProps) {
	const [copiedField, setCopiedField] = useState<string | null>(null);

	const handleCopy = async (value: string, field: string) => {
		await copyToClipboard(value);
		setCopiedField(field);
		setTimeout(() => setCopiedField(null), 2000);
	};

	return (
		<div className="rounded-lg border border-lv-green/30 bg-lv-green/10 px-4 py-3 space-y-3">
			<p className="text-sm font-medium text-lv-green">Credential created! Copy both keys now — the secret will not be shown again.</p>

			<div className="space-y-2">
				<div className="space-y-1">
					<span className={T.formLabel}>Access Key ID</span>
					<div className="flex items-center gap-2">
						<code className="flex-1 break-all rounded bg-lovelace-800 px-3 py-1.5 font-data text-xs text-foreground">{accessKeyId}</code>
						<Button size="sm" variant="outline" onClick={() => handleCopy(accessKeyId, 'akid')}>
							{copiedField === 'akid' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
							{copiedField === 'akid' ? 'Copied!' : 'Copy'}
						</Button>
					</div>
				</div>

				<div className="space-y-1">
					<span className={T.formLabel}>Secret Access Key</span>
					<div className="flex items-center gap-2">
						<code className="flex-1 break-all rounded bg-lovelace-800 px-3 py-1.5 font-data text-xs text-foreground">
							{secretAccessKey}
						</code>
						<Button size="sm" variant="outline" onClick={() => handleCopy(secretAccessKey, 'sak')}>
							{copiedField === 'sak' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
							{copiedField === 'sak' ? 'Copied!' : 'Copy'}
						</Button>
					</div>
				</div>
			</div>

			<div className="flex justify-end">
				<Button size="sm" variant="ghost" onClick={onDismiss}>
					Dismiss
				</Button>
			</div>
		</div>
	);
}

// ─── Loading Skeleton ───────────────────────────────────────────────

function CredentialsTableSkeleton() {
	return (
		<div className="space-y-2">
			{Array.from({ length: 5 }).map((_, i) => (
				<Skeleton key={i} className="h-10 w-full" />
			))}
		</div>
	);
}

// ─── Policy Preview ─────────────────────────────────────────────────

function PolicyPreview({ policyJson }: { policyJson: string }) {
	const [showJson, setShowJson] = useState(false);

	let parsed: PolicyDocument | null = null;
	try {
		parsed = JSON.parse(policyJson);
	} catch {
		// fall through
	}

	if (!parsed) return <span className={T.muted}>Invalid policy</span>;

	return (
		<div className="space-y-1">
			{parsed.statements.map((s, i) => {
				const prefix = s.actions.some((a: string) => a.startsWith('s3:'))
					? 's3'
					: s.actions.some((a: string) => a.startsWith('purge:'))
						? 'purge'
						: 'admin';
				const summary = summarizeStatement(s, prefix);
				return (
					<div key={i} className="flex items-start gap-1.5">
						<Badge
							className={cn(
								'shrink-0 text-[9px] px-1.5 py-0',
								s.effect === 'deny' ? 'bg-lv-red/20 text-lv-red border-lv-red/30' : 'bg-lv-green/20 text-lv-green border-lv-green/30',
							)}
						>
							{s.effect === 'deny' ? 'DENY' : 'ALLOW'}
						</Badge>
						<span className="text-[11px] font-data text-muted-foreground leading-tight">{summary.replace(/^(Allow|Deny)\s/, '')}</span>
					</div>
				);
			})}
			<button
				type="button"
				onClick={() => setShowJson(!showJson)}
				className="text-[10px] text-lv-blue/60 hover:text-lv-blue hover:underline font-data"
			>
				{showJson ? 'Hide JSON' : 'Show JSON'}
			</button>
			{showJson && (
				<pre className="rounded border border-border bg-background/50 p-2 text-[10px] font-data text-muted-foreground overflow-x-auto max-h-32 overflow-y-auto">
					{JSON.stringify(parsed, null, 2)}
				</pre>
			)}
		</div>
	);
}

// ─── Detail helpers ─────────────────────────────────────────────────

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

function DetailField({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="contents">
			<span className="text-[11px] font-data text-muted-foreground/70 select-none">{label}</span>
			<span className="text-[11px] font-data break-all select-all">{children}</span>
		</div>
	);
}

// ─── Credential Detail Row ──────────────────────────────────────────

function CredentialDetailRow({ credential, colSpan }: { credential: S3Credential; colSpan: number }) {
	const [showJson, setShowJson] = useState(false);
	let parsedPolicy: PolicyDocument | null = null;
	try {
		parsedPolicy = typeof credential.policy === 'string' ? JSON.parse(credential.policy) : credential.policy;
	} catch {
		/* invalid JSON */
	}

	return (
		<TableRow className="bg-muted/30 hover:bg-muted/40 border-b border-border/50">
			<TableCell colSpan={colSpan} className="px-6 py-3">
				<div className="space-y-4 max-w-4xl">
					{/* ── Credential metadata ──────────────────────── */}
					<div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
						<DetailField label="access_key_id">
							<span className="text-lv-cyan">{credential.access_key_id}</span>
						</DetailField>
						<DetailField label="name">
							<span className="text-foreground">{credential.name}</span>
						</DetailField>
						<DetailField label="status">
							{credential.revoked ? (
								<span className="text-lv-red font-semibold">Revoked</span>
							) : (
								<span className="text-lv-green font-semibold">Active</span>
							)}
						</DetailField>
						<DetailField label="created_at">
							<span className="text-lv-blue">{formatTimestamp(credential.created_at)}</span>
						</DetailField>
						<DetailField label="expires_at">
							{credential.expires_at ? (
								<span className="text-lv-blue">{formatTimestamp(credential.expires_at)}</span>
							) : (
								<span className="italic text-muted-foreground/40">never</span>
							)}
						</DetailField>
						<DetailField label="created_by">
							{credential.created_by ? (
								<span className="text-lv-cyan">{credential.created_by}</span>
							) : (
								<span className="italic text-muted-foreground/40">null</span>
							)}
						</DetailField>
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
								{parsedPolicy.statements.map((stmt, i) => {
									const prefix = stmt.actions.some((a: string) => a.startsWith('s3:'))
										? 's3'
										: stmt.actions.some((a: string) => a.startsWith('purge:'))
											? 'purge'
											: 'admin';
									const summary = summarizeStatement(stmt, prefix);
									return (
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
														<span className="text-[11px] font-data text-lv-peach">{summary.replace(/^(Allow|Deny)\s/, '')}</span>
													</>
												)}
											</div>
										</div>
									);
								})}
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

// ─── S3 Credentials Page ────────────────────────────────────────────

export function S3CredentialsPage() {
	const [credentials, setCredentials] = useState<S3Credential[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [newCred, setNewCred] = useState<{ accessKeyId: string; secretAccessKey: string } | null>(null);
	const [revokingId, setRevokingId] = useState<string | null>(null);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [bulkLoading, setBulkLoading] = useState(false);
	const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'revoked'>('all');
	const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

	const toggleExpanded = (id: string) => {
		setExpandedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const fetchCredentials = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const filter = statusFilter === 'all' ? undefined : statusFilter;
			const data = await listS3Credentials(filter);
			setCredentials(data);
		} catch (e: any) {
			setError(e.message ?? 'Failed to load credentials');
			setCredentials([]);
		} finally {
			setLoading(false);
		}
	}, [statusFilter]);

	useEffect(() => {
		fetchCredentials();
	}, [fetchCredentials]);

	const handleRevoke = async (accessKeyId: string) => {
		if (!confirm(`Revoke credential ${truncateId(accessKeyId)}? This cannot be undone.`)) return;
		setRevokingId(accessKeyId);
		try {
			await revokeS3Credential(accessKeyId);
			await fetchCredentials();
		} catch (e: any) {
			setError(e.message ?? 'Failed to revoke credential');
		} finally {
			setRevokingId(null);
		}
	};

	const handleDelete = async (accessKeyId: string) => {
		if (
			!confirm(
				`Permanently delete credential ${truncateId(accessKeyId)}? The row will be removed from the database. Analytics are preserved.`,
			)
		)
			return;
		setDeletingId(accessKeyId);
		try {
			await deleteS3Credential(accessKeyId);
			await fetchCredentials();
		} catch (e: any) {
			setError(e.message ?? 'Failed to delete credential');
		} finally {
			setDeletingId(null);
		}
	};

	const handleCreated = (accessKeyId: string, secretAccessKey: string) => {
		setNewCred({ accessKeyId, secretAccessKey });
		fetchCredentials();
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
		if (selectedIds.size === credentials.length) {
			setSelectedIds(new Set());
		} else {
			setSelectedIds(new Set(credentials.map((c) => c.access_key_id)));
		}
	};

	const handleBulkRevoke = async () => {
		const ids = [...selectedIds];
		const activeIds = ids.filter((id) => credentials.find((c) => c.access_key_id === id && !c.revoked));
		if (activeIds.length === 0) return;
		if (!confirm(`Bulk revoke ${activeIds.length} credential${activeIds.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
		setBulkLoading(true);
		try {
			await bulkRevokeS3Credentials(activeIds);
			setSelectedIds(new Set());
			await fetchCredentials();
		} catch (e: any) {
			setError(e.message ?? 'Bulk revoke failed');
		} finally {
			setBulkLoading(false);
		}
	};

	const handleBulkDelete = async () => {
		const ids = [...selectedIds];
		const revokedIds = ids.filter((id) => credentials.find((c) => c.access_key_id === id && c.revoked));
		if (revokedIds.length === 0) return;
		if (!confirm(`Permanently delete ${revokedIds.length} credential${revokedIds.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
		setBulkLoading(true);
		try {
			await bulkDeleteS3Credentials(revokedIds);
			setSelectedIds(new Set());
			await fetchCredentials();
		} catch (e: any) {
			setError(e.message ?? 'Bulk delete failed');
		} finally {
			setBulkLoading(false);
		}
	};

	const selectedActiveCount = [...selectedIds].filter((id) => credentials.find((c) => c.access_key_id === id && !c.revoked)).length;
	const selectedRevokedCount = [...selectedIds].filter((id) => credentials.find((c) => c.access_key_id === id && c.revoked)).length;

	const activeCount = credentials.filter((c) => !c.revoked).length;
	const revokedCount = credentials.filter((c) => c.revoked).length;

	const { pageItems, page, pageSize, totalItems, totalPages, pageSizeOptions, setPage, setPageSize } = usePagination(credentials);

	return (
		<div className="space-y-6">
			{/* ── Header row ──────────────────────────────────────── */}
			<div className="flex items-center justify-between">
				<div>
					<h2 className={T.pageTitle}>S3 Credentials</h2>
					<p className={T.pageDescription}>Manage S3-compatible credentials for R2 bucket access through the gateway.</p>
				</div>
				<CreateCredentialDialog onCreated={handleCreated} />
			</div>

			{/* ── Bulk actions bar ────────────────────────────────── */}
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

			{/* ── Secret banner ──────────────────────────────────── */}
			{newCred && (
				<SecretBanner accessKeyId={newCred.accessKeyId} secretAccessKey={newCred.secretAccessKey} onDismiss={() => setNewCred(null)} />
			)}

			{/* ── Error ──────────────────────────────────────────── */}
			{error && <div className="rounded-lg border border-lv-red/30 bg-lv-red/10 px-4 py-3 text-sm text-lv-red">{error}</div>}

			{/* ── Filter tabs ────────────────────────────────────── */}
			<div className="flex flex-wrap items-center gap-3">
				<div className="flex rounded-md border border-border">
					{(['all', 'active', 'revoked'] as const).map((t) => {
						const count = t === 'all' ? credentials.length : t === 'active' ? activeCount : revokedCount;
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
			</div>

			{/* ── Loading ────────────────────────────────────────── */}
			{loading && <CredentialsTableSkeleton />}

			{/* ── Empty state ────────────────────────────────────── */}
			{!loading && credentials.length === 0 && !error && (
				<div className="flex h-48 items-center justify-center">
					<p className={T.mutedSm}>No S3 credentials found. Create one to get started.</p>
				</div>
			)}

			{/* ── Credentials table ──────────────────────────────── */}
			{!loading && credentials.length > 0 && (
				<Card>
					<CardHeader>
						<div className="flex items-center justify-between">
							<CardTitle className={T.sectionHeading}>Credentials ({credentials.length})</CardTitle>
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
									<TableHead className="w-8">
										<input
											type="checkbox"
											checked={credentials.length > 0 && selectedIds.size === credentials.length}
											onChange={toggleSelectAll}
											className="rounded border-border"
											aria-label="Select all"
										/>
									</TableHead>
									<TableHead className="w-6 px-2" />
									<TableHead className={T.sectionLabel}>Name</TableHead>
									<TableHead className={T.sectionLabel}>Access Key ID</TableHead>
									<TableHead className={T.sectionLabel}>Status</TableHead>
									<TableHead className={T.sectionLabel}>Created</TableHead>
									<TableHead className={T.sectionLabel}>Expires</TableHead>
									<TableHead className={T.sectionLabel}>Created By</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')}>Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{pageItems.map((c) => {
									const isExpanded = expandedIds.has(c.access_key_id);
									return (
										<>
											<TableRow
												key={c.access_key_id}
												className={cn(
													'cursor-pointer select-none',
													selectedIds.has(c.access_key_id) && 'bg-lv-purple/5',
													isExpanded && 'bg-muted/30',
												)}
												onClick={() => toggleExpanded(c.access_key_id)}
											>
												<TableCell className="w-8" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
													<input
														type="checkbox"
														checked={selectedIds.has(c.access_key_id)}
														onChange={() => toggleSelect(c.access_key_id)}
														className="rounded border-border"
														aria-label="Select row"
													/>
												</TableCell>
												<TableCell className="w-6 px-2">
													<ChevronRight
														className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform duration-150', isExpanded && 'rotate-90')}
													/>
												</TableCell>
												<TableCell className={T.tableRowName}>{c.name}</TableCell>
												<TableCell>
													<code className={T.tableCellMono} title={c.access_key_id}>
														{truncateId(c.access_key_id)}
													</code>
												</TableCell>
												<TableCell>
													{c.revoked ? (
														<Badge className="bg-lv-red/20 text-lv-red border-lv-red/30">Revoked</Badge>
													) : (
														<Badge className="bg-lv-green/20 text-lv-green border-lv-green/30">Active</Badge>
													)}
												</TableCell>
												<TableCell className={T.tableCell}>{formatDate(c.created_at)}</TableCell>
												<TableCell className={T.tableCell}>
													{c.expires_at ? formatDate(c.expires_at) : <span className={T.muted}>Never</span>}
												</TableCell>
												<TableCell className={T.tableCell}>{c.created_by ?? <span className={T.muted}>--</span>}</TableCell>
												<TableCell className="text-right space-x-1" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
													{!c.revoked && (
														<Button
															size="xs"
															variant="ghost"
															className="text-lv-red hover:text-lv-red-bright hover:bg-lv-red/10"
															onClick={() => handleRevoke(c.access_key_id)}
															disabled={revokingId === c.access_key_id}
														>
															{revokingId === c.access_key_id ? (
																<Loader2 className="h-3.5 w-3.5 animate-spin" />
															) : (
																<ShieldOff className="h-3.5 w-3.5" />
															)}
															Revoke
														</Button>
													)}
													{!!c.revoked && (
														<Button
															size="xs"
															variant="ghost"
															className="text-muted-foreground hover:text-lv-red hover:bg-lv-red/10"
															onClick={() => handleDelete(c.access_key_id)}
															disabled={deletingId === c.access_key_id}
														>
															{deletingId === c.access_key_id ? (
																<Loader2 className="h-3.5 w-3.5 animate-spin" />
															) : (
																<Trash2 className="h-3.5 w-3.5" />
															)}
															Delete
														</Button>
													)}
												</TableCell>
											</TableRow>
											{isExpanded && <CredentialDetailRow key={`${c.access_key_id}-detail`} credential={c} colSpan={9} />}
										</>
									);
								})}
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
							noun="credentials"
						/>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
