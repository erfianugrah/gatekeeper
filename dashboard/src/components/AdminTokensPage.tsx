import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, Copy, Check, AlertTriangle, KeyRound } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { cn, copyToClipboard } from '@/lib/utils';
import { T } from '@/lib/typography';
import { listAdminTokens, createAdminToken, revokeAdminToken } from '@/lib/api';
import type { AdminToken, AdminRole, CreatedAdminToken } from '@/lib/api';

// ─── Helpers ─────────────────────────────────────────────────────────

const ROLES: AdminRole[] = ['admin', 'operator', 'viewer'];

function fmtDate(ms: number | null): string {
	if (!ms) return 'Never';
	return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function roleTone(role: AdminRole): string {
	if (role === 'admin') return 'text-lv-red';
	if (role === 'operator') return 'text-lv-purple';
	return 'text-muted-foreground';
}

// ─── Create dialog ───────────────────────────────────────────────────

function CreateTokenDialog({ onCreated }: { onCreated: () => void }) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState('');
	const [role, setRole] = useState<AdminRole>('admin');
	const [expiry, setExpiry] = useState<string>('never');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<CreatedAdminToken | null>(null);
	const [copied, setCopied] = useState(false);

	const reset = () => {
		setName('');
		setRole('admin');
		setExpiry('never');
		setError(null);
		setCreated(null);
		setCopied(false);
	};

	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		if (!next) {
			// Refresh the list when the dialog closes after a successful create.
			if (created) onCreated();
			reset();
		}
	};

	const handleCreate = async () => {
		if (!name.trim()) {
			setError('Token name is required');
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const req = {
				name: name.trim(),
				role,
				...(expiry !== 'never' ? { expires_in_days: Number(expiry) } : {}),
			};
			const result = await createAdminToken(req);
			setCreated(result);
		} catch (e: any) {
			setError(e.message ?? 'Failed to create token');
		} finally {
			setSubmitting(false);
		}
	};

	const handleCopy = async () => {
		if (!created) return;
		await copyToClipboard(created.token);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>
				<Button size="sm">
					<Plus className="mr-1.5 h-4 w-4" />
					Create Token
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Create admin token</DialogTitle>
					<DialogDescription>
						A named, revocable credential for the admin API (CLI / automation). Use it as the <code>X-Admin-Key</code> header or an{' '}
						<code>Authorization: Bearer</code> token. The value is shown once.
					</DialogDescription>
				</DialogHeader>

				{created ? (
					<div className="space-y-3">
						<div className="flex items-start gap-2 rounded-md border border-lv-green/30 bg-lv-green/10 p-3">
							<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-lv-green" />
							<p className="text-sm font-medium text-lv-green">Copy this token now. It will not be shown again.</p>
						</div>
						<div className="flex items-center gap-2">
							<code className="flex-1 truncate rounded bg-muted px-2 py-1.5 font-data text-xs">{created.token}</code>
							<Button size="sm" variant="outline" onClick={handleCopy}>
								{copied ? <Check className="h-4 w-4 text-lv-green" /> : <Copy className="h-4 w-4" />}
							</Button>
						</div>
						<dl className="grid grid-cols-2 gap-y-1 text-xs">
							<dt className="text-muted-foreground">Role</dt>
							<dd className={cn('font-medium', roleTone(created.role))}>{created.role}</dd>
							<dt className="text-muted-foreground">Expires</dt>
							<dd className="font-data">{fmtDate(created.expires_at)}</dd>
						</dl>
						<DialogFooter>
							<Button size="sm" onClick={() => handleOpenChange(false)}>
								Done
							</Button>
						</DialogFooter>
					</div>
				) : (
					<div className="space-y-4">
						<div className="space-y-1.5">
							<Label htmlFor="tok-name" className={T.formLabel}>
								Name
							</Label>
							<Input
								id="tok-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="e.g. ci-pipeline, staging-smoke"
								maxLength={100}
							/>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1.5">
								<Label className={T.formLabel}>Role</Label>
								<Select value={role} onValueChange={(v) => setRole(v as AdminRole)}>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{ROLES.map((r) => (
											<SelectItem key={r} value={r}>
												{r}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1.5">
								<Label className={T.formLabel}>Expires</Label>
								<Select value={expiry} onValueChange={setExpiry}>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="never">Never</SelectItem>
										<SelectItem value="7">7 days</SelectItem>
										<SelectItem value="30">30 days</SelectItem>
										<SelectItem value="90">90 days</SelectItem>
										<SelectItem value="365">365 days</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</div>
						{error && <p className="text-xs text-lv-red">{error}</p>}
						<DialogFooter>
							<Button size="sm" variant="outline" onClick={() => handleOpenChange(false)}>
								Cancel
							</Button>
							<Button size="sm" onClick={handleCreate} disabled={submitting}>
								{submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
								Create
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

// ─── Page ────────────────────────────────────────────────────────────

export function AdminTokensPage() {
	const [tokens, setTokens] = useState<AdminToken[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [revoking, setRevoking] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setTokens(await listAdminTokens());
		} catch (e: any) {
			setError(e.message ?? 'Failed to load tokens');
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const handleRevoke = async (id: string) => {
		if (!confirm('Revoke this token? Any client using it will immediately lose access.')) return;
		setRevoking(id);
		try {
			await revokeAdminToken(id);
			await load();
		} catch (e: any) {
			setError(e.message ?? 'Failed to revoke token');
		} finally {
			setRevoking(null);
		}
	};

	const activeCount = tokens.filter((t) => !t.revoked).length;

	return (
		<div className="space-y-6">
			<div className="flex items-start justify-between">
				<div>
					<h1 className={T.pageTitle}>Admin Tokens</h1>
					<p className={T.pageDescription}>
						Named, revocable API tokens for the admin plane (CLI / automation). The bootstrap <code>ADMIN_KEY</code> secret and SSO
						login are unaffected.
					</p>
				</div>
				<CreateTokenDialog onCreated={load} />
			</div>

			<Card>
				<CardHeader className="flex flex-row items-center justify-between">
					<CardTitle className={T.cardTitle}>
						<KeyRound className="mr-1.5 inline h-4 w-4" />
						Tokens ({activeCount} active)
					</CardTitle>
				</CardHeader>
				<CardContent className="p-0">
					{error && <p className="px-4 py-3 text-xs text-lv-red">{error}</p>}
					{loading ? (
						<p className="px-4 py-6 text-center text-xs text-muted-foreground">Loading...</p>
					) : tokens.length === 0 ? (
						<p className="px-4 py-6 text-center text-xs text-muted-foreground">
							No admin tokens yet. Create one to authenticate the CLI or automation without the shared key.
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className={T.sectionLabel}>Name</TableHead>
									<TableHead className={T.sectionLabel}>Token</TableHead>
									<TableHead className={T.sectionLabel}>Role</TableHead>
									<TableHead className={T.sectionLabel}>Status</TableHead>
									<TableHead className={T.sectionLabel}>Created</TableHead>
									<TableHead className={T.sectionLabel}>Expires</TableHead>
									<TableHead className={T.sectionLabel}>Last used</TableHead>
									<TableHead className={cn(T.sectionLabel, 'text-right')}>Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{tokens.map((t) => (
									<TableRow key={t.id}>
										<TableCell className={T.tableRowName}>{t.name}</TableCell>
										<TableCell className={T.tableCellMono}>{t.token_preview}</TableCell>
										<TableCell className={cn('text-xs font-medium', roleTone(t.role))}>{t.role}</TableCell>
										<TableCell>
											{t.revoked ? (
												<Badge variant="outline" className="text-muted-foreground">
													Revoked
												</Badge>
											) : (
												<Badge variant="outline" className="text-lv-green">
													Active
												</Badge>
											)}
										</TableCell>
										<TableCell className={T.tableCell}>{fmtDate(t.created_at)}</TableCell>
										<TableCell className={T.tableCell}>{fmtDate(t.expires_at)}</TableCell>
										<TableCell className={T.tableCell}>{fmtDate(t.last_used_at)}</TableCell>
										<TableCell className="text-right">
											{!t.revoked && (
												<Button
													size="sm"
													variant="ghost"
													className="text-lv-red hover:text-lv-red"
													onClick={() => handleRevoke(t.id)}
													disabled={revoking === t.id}
												>
													{revoking === t.id ? (
														<Loader2 className="h-4 w-4 animate-spin" />
													) : (
														<Trash2 className="mr-1 h-4 w-4" />
													)}
													Revoke
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
		</div>
	);
}
