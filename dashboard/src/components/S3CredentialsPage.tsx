import { useState, useCallback, useEffect } from 'react';
import { Plus, ShieldOff, Trash2, Loader2, Copy, Check } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { S3PolicyBuilder } from '@/components/S3PolicyBuilder';
import {
	listS3Credentials,
	createS3Credential,
	revokeS3Credential,
	deleteS3Credential,
	bulkRevokeS3Credentials,
	bulkDeleteS3Credentials,
} from '@/lib/api';
import type { S3Credential, PolicyDocument } from '@/lib/api';
import { cn } from '@/lib/utils';
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

function makeDefaultS3Policy(): PolicyDocument {
	return {
		version: '2025-01-01',
		statements: [
			{
				effect: 'allow',
				actions: ['s3:*'],
				resources: ['*'],
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
	const [policy, setPolicy] = useState<PolicyDocument>(makeDefaultS3Policy);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleCreate = async () => {
		setError(null);
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
				policy,
				expires_in_days: expiresInDays ? Number(expiresInDays) : undefined,
			});
			onCreated(result.credential.access_key_id, result.credential.secret_access_key);
			setOpen(false);
			setName('');
			setExpiresInDays('');
			setPolicy(makeDefaultS3Policy());
		} catch (e: any) {
			setError(e.message ?? 'Failed to create credential');
		} finally {
			setCreating(false);
		}
	};

	const handleOpenChange = (next: boolean) => {
		if (next) setPolicy(makeDefaultS3Policy());
		setOpen(next);
		setError(null);
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
					<DialogDescription>Create a new S3-compatible credential for accessing R2 buckets through the gateway.</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
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

					<div className="space-y-2">
						<Label className={T.formLabel}>Policy</Label>
						<S3PolicyBuilder value={policy} onChange={setPolicy} />
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

interface SecretBannerProps {
	accessKeyId: string;
	secretAccessKey: string;
	onDismiss: () => void;
}

function SecretBanner({ accessKeyId, secretAccessKey, onDismiss }: SecretBannerProps) {
	const [copiedField, setCopiedField] = useState<string | null>(null);

	const handleCopy = async (value: string, field: string) => {
		await navigator.clipboard.writeText(value);
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
	const [expanded, setExpanded] = useState(false);

	let parsed: PolicyDocument | null = null;
	try {
		parsed = JSON.parse(policyJson);
	} catch {
		// fall through
	}

	if (!parsed) return <span className={T.muted}>Invalid policy</span>;

	const summary = parsed.statements
		.map((s) => {
			const actions = s.actions.length > 2 ? `${s.actions.slice(0, 2).join(', ')}...` : s.actions.join(', ');
			return `${actions} on ${s.resources[0]}`;
		})
		.join('; ');

	return (
		<div>
			<button type="button" onClick={() => setExpanded(!expanded)} className="text-xs text-lv-cyan hover:underline font-data">
				{expanded ? 'Hide' : summary}
			</button>
			{expanded && (
				<pre className="mt-1 rounded border border-border bg-background/50 p-2 text-[10px] font-data text-muted-foreground overflow-x-auto max-h-32 overflow-y-auto">
					{JSON.stringify(parsed, null, 2)}
				</pre>
			)}
		</div>
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
			<Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as 'all' | 'active' | 'revoked')}>
				<TabsList>
					<TabsTrigger value="all">All ({credentials.length})</TabsTrigger>
					<TabsTrigger value="active">Active ({activeCount})</TabsTrigger>
					<TabsTrigger value="revoked">Revoked ({revokedCount})</TabsTrigger>
				</TabsList>
			</Tabs>

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
						<CardTitle className={T.sectionHeading}>Credentials ({credentials.length})</CardTitle>
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
										/>
									</TableHead>
									<TableHead className={T.sectionLabel}>Name</TableHead>
									<TableHead className={T.sectionLabel}>Access Key ID</TableHead>
									<TableHead className={T.sectionLabel}>Status</TableHead>
									<TableHead className={T.sectionLabel}>Created</TableHead>
									<TableHead className={T.sectionLabel}>Expires</TableHead>
									<TableHead className={T.sectionLabel}>Created By</TableHead>
									<TableHead className={T.sectionLabel}>Policy</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')}>Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{credentials.map((c) => (
									<TableRow key={c.access_key_id} className={selectedIds.has(c.access_key_id) ? 'bg-lv-purple/5' : undefined}>
										<TableCell className="w-8">
											<input
												type="checkbox"
												checked={selectedIds.has(c.access_key_id)}
												onChange={() => toggleSelect(c.access_key_id)}
												className="rounded border-border"
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
										<TableCell className="max-w-xs">
											<PolicyPreview policyJson={c.policy} />
										</TableCell>
										<TableCell className="text-right space-x-1">
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
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
