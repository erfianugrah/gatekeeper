import { useState, useCallback } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Eye, EyeOff, Upload, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ConditionEditor, summarizeStatement } from '@/components/ConditionEditor';
import type { FieldOption, OperatorOption } from '@/components/ConditionEditor';
import type { PolicyDocument, Statement, Condition } from '@/lib/api';
import { cn } from '@/lib/utils';
import { T } from '@/lib/typography';

// ─── Constants ──────────────────────────────────────────────────────

const S3_ACTIONS = [
	{ value: 's3:*', label: 'All S3', description: 'Full access to all S3 operations' },
	{ value: 's3:GetObject', label: 'GetObject', description: 'Read objects' },
	{ value: 's3:PutObject', label: 'PutObject', description: 'Write/upload objects' },
	{ value: 's3:DeleteObject', label: 'DeleteObject', description: 'Delete objects' },
	{ value: 's3:ListBucket', label: 'ListBucket', description: 'List objects in a bucket' },
	{ value: 's3:ListAllMyBuckets', label: 'ListBuckets', description: 'List all buckets' },
	{ value: 's3:CreateBucket', label: 'CreateBucket', description: 'Create buckets' },
	{ value: 's3:DeleteBucket', label: 'DeleteBucket', description: 'Delete buckets' },
	{ value: 's3:HeadBucket', label: 'HeadBucket', description: 'Check bucket exists' },
	{ value: 's3:GetBucketLocation', label: 'GetBucketLocation', description: 'Get bucket region' },
	{ value: 's3:GetBucketCors', label: 'GetBucketCors', description: 'Read CORS config' },
	{ value: 's3:PutBucketCors', label: 'PutBucketCors', description: 'Write CORS config' },
	{ value: 's3:DeleteBucketCors', label: 'DeleteBucketCors', description: 'Delete CORS config' },
	{ value: 's3:GetLifecycleConfiguration', label: 'GetLifecycle', description: 'Read lifecycle rules' },
	{ value: 's3:PutLifecycleConfiguration', label: 'PutLifecycle', description: 'Write lifecycle rules' },
	{ value: 's3:GetEncryptionConfiguration', label: 'GetEncryption', description: 'Read encryption config' },
	{ value: 's3:AbortMultipartUpload', label: 'AbortMultipart', description: 'Abort multipart uploads' },
	{ value: 's3:ListBucketMultipartUploads', label: 'ListMultipart', description: 'List multipart uploads' },
	{ value: 's3:ListMultipartUploadParts', label: 'ListParts', description: 'List upload parts' },
] as const;

const S3_CONDITION_FIELDS: readonly FieldOption[] = [
	{ value: 'bucket', label: 'Bucket', hint: 'e.g. my-bucket' },
	{ value: 'key', label: 'Key', hint: 'e.g. images/photo.jpg' },
	{ value: 'key.prefix', label: 'Key Prefix', hint: 'e.g. uploads/' },
	{ value: 'key.filename', label: 'Filename', hint: 'e.g. photo.jpg' },
	{ value: 'key.extension', label: 'Extension', hint: 'e.g. jpg' },
	{ value: 'content_type', label: 'Content-Type', hint: 'e.g. image/jpeg' },
	{ value: 'content_length', label: 'Content-Length', hint: 'e.g. 10485760' },
	{ value: 'method', label: 'HTTP Method', hint: 'e.g. GET' },
	{ value: 'source_bucket', label: 'Source Bucket', hint: 'For CopyObject' },
	{ value: 'source_key', label: 'Source Key', hint: 'For CopyObject' },
	{ value: 'list_prefix', label: 'List Prefix', hint: 'e.g. logs/' },
] as const;

const OPERATORS: readonly OperatorOption[] = [
	{ value: 'eq', label: 'equals' },
	{ value: 'ne', label: 'not equals' },
	{ value: 'contains', label: 'contains' },
	{ value: 'not_contains', label: 'not contains' },
	{ value: 'starts_with', label: 'starts with' },
	{ value: 'ends_with', label: 'ends with' },
	{ value: 'wildcard', label: 'wildcard (*)' },
	{ value: 'matches', label: 'regex' },
	{ value: 'in', label: 'in (list)' },
	{ value: 'not_in', label: 'not in (list)' },
	{ value: 'exists', label: 'exists' },
	{ value: 'not_exists', label: 'not exists' },
] as const;

// ─── Types ──────────────────────────────────────────────────────────

interface S3PolicyBuilderProps {
	value: PolicyDocument;
	onChange: (policy: PolicyDocument) => void;
}

// ─── Statement Editor ───────────────────────────────────────────────

interface StatementEditorProps {
	index: number;
	statement: Statement;
	onChange: (s: Statement) => void;
	onRemove: () => void;
	canRemove: boolean;
}

function StatementEditor({ index, statement, onChange, onRemove, canRemove }: StatementEditorProps) {
	const [collapsed, setCollapsed] = useState(false);

	const toggleAction = (action: string) => {
		const current = new Set(statement.actions);
		if (action === 's3:*') {
			onChange({
				...statement,
				actions: current.has('s3:*') ? [] : ['s3:*'],
			});
			return;
		}
		current.delete('s3:*');
		if (current.has(action)) {
			current.delete(action);
		} else {
			current.add(action);
		}
		onChange({ ...statement, actions: Array.from(current) });
	};

	const conditions: Condition[] = statement.conditions ?? [];
	const isWildcard = statement.actions.includes('s3:*');
	const summary = summarizeStatement(statement, 's3');

	return (
		<div className="rounded-lg border border-border bg-card/50 p-3 space-y-3">
			{/* ── Statement header ──────────────────────────────── */}
			<div className="flex items-center gap-2">
				<button type="button" onClick={() => setCollapsed(!collapsed)} className="text-muted-foreground hover:text-foreground">
					{collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
				</button>
				<span className={T.sectionLabel}>Statement {index + 1}</span>
				<Badge className="bg-lv-green/20 text-lv-green border-lv-green/30 text-[10px]">ALLOW</Badge>
				{canRemove && (
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="ml-auto h-7 w-7 text-muted-foreground hover:text-lv-red"
						onClick={onRemove}
					>
						<Trash2 className="h-3.5 w-3.5" />
					</Button>
				)}
			</div>

			{/* ── Human-readable summary (always visible) ─────── */}
			<p className="text-xs text-muted-foreground bg-background/50 rounded-md px-2.5 py-1.5 border border-border/50 font-data">{summary}</p>

			{!collapsed && (
				<>
					{/* ── Actions ───────────────────────────────────── */}
					<div className="space-y-2">
						<Label className={T.formLabel}>Actions</Label>
						<TooltipProvider delayDuration={200}>
							<div className="flex flex-wrap gap-1.5">
								{S3_ACTIONS.map((a) => {
									const active = isWildcard ? a.value === 's3:*' : statement.actions.includes(a.value);
									return (
										<Tooltip key={a.value}>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={() => toggleAction(a.value)}
													className={cn(
														'rounded-md border px-2.5 py-1 text-xs font-data transition-colors',
														active
															? 'border-lv-purple/50 bg-lv-purple/20 text-lv-purple'
															: 'border-border text-muted-foreground hover:border-lv-purple/30 hover:text-foreground',
													)}
												>
													{a.label}
												</button>
											</TooltipTrigger>
											<TooltipContent side="top">
												<p className="text-xs">
													<code className="text-lv-cyan">{a.value}</code> — {a.description}
												</p>
											</TooltipContent>
										</Tooltip>
									);
								})}
							</div>
						</TooltipProvider>
					</div>

					{/* ── Resources ─────────────────────────────────── */}
					<div className="space-y-2">
						<Label className={T.formLabel}>Resources</Label>
						<Input
							placeholder="e.g. bucket:my-bucket, object:my-bucket/*, *"
							value={statement.resources.join(', ')}
							onChange={(e) => {
								const raw = e.target.value;
								const resources = raw
									.split(',')
									.map((s) => s.trim())
									.filter(Boolean);
								onChange({ ...statement, resources: resources.length > 0 ? resources : ['*'] });
							}}
							className="text-xs font-data"
						/>
						<p className={cn(T.muted, 'italic')}>
							Use <code className="text-lv-cyan">bucket:name</code> for bucket-level, <code className="text-lv-cyan">object:bucket/*</code>{' '}
							for objects, or <code className="text-lv-cyan">*</code> for everything.
						</p>
					</div>

					{/* ── Conditions ────────────────────────────────── */}
					<div className="space-y-2">
						<Label className={T.formLabel}>Conditions {conditions.length > 0 && `(${conditions.length})`}</Label>
						<ConditionEditor
							conditions={conditions}
							onChange={(next) => onChange({ ...statement, conditions: next.length > 0 ? next : undefined })}
							fields={S3_CONDITION_FIELDS}
							operators={OPERATORS}
							defaultField="bucket"
						/>
					</div>
				</>
			)}
		</div>
	);
}

// ─── AWS IAM Policy Converter ───────────────────────────────────────

interface AwsStatement {
	Sid?: string;
	Effect: string;
	Action: string | string[];
	Resource: string | string[];
	Condition?: Record<string, Record<string, string>>;
}

interface AwsPolicy {
	Version?: string;
	Statement: AwsStatement[];
}

interface ConvertResult {
	policy: PolicyDocument;
	warnings: string[];
	skipped: string[];
}

function convertAwsPolicy(aws: AwsPolicy): ConvertResult {
	const warnings: string[] = [];
	const skipped: string[] = [];
	const statements: Statement[] = [];

	for (const stmt of aws.Statement) {
		const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
		const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];

		if (stmt.Effect !== 'Allow') {
			skipped.push(`${stmt.Sid ?? 'Statement'}: Deny statements not supported (only Allow)`);
			continue;
		}

		const s3Actions = actions.filter((a) => a.startsWith('s3:'));
		const nonS3Actions = actions.filter((a) => !a.startsWith('s3:'));

		if (s3Actions.length === 0) {
			skipped.push(
				`${stmt.Sid ?? 'Statement'}: No S3 actions (${nonS3Actions.slice(0, 3).join(', ')}${nonS3Actions.length > 3 ? '...' : ''})`,
			);
			continue;
		}

		if (nonS3Actions.length > 0) {
			warnings.push(`${stmt.Sid ?? 'Statement'}: Dropped non-S3 actions: ${nonS3Actions.join(', ')}`);
		}

		const converted = convertResources(resources, warnings, stmt.Sid);

		if (converted.length === 0) {
			statements.push({ effect: 'allow', actions: s3Actions, resources: ['*'] });
		} else {
			statements.push({ effect: 'allow', actions: s3Actions, resources: converted });
		}

		if (stmt.Condition) {
			warnings.push(`${stmt.Sid ?? 'Statement'}: AWS Conditions dropped — translate manually if needed`);
		}
	}

	if (statements.length === 0) {
		statements.push({ effect: 'allow', actions: ['s3:GetObject'], resources: ['*'] });
		warnings.push('No S3 statements found — added a placeholder');
	}

	return { policy: { version: '2025-01-01', statements }, warnings, skipped };
}

function convertResources(resources: string[], warnings: string[], sid?: string): string[] {
	const result: string[] = [];

	for (const resource of resources) {
		if (resource === '*') return [];

		const arnMatch = resource.match(/^arn:aws:s3:::(.+)$/);
		if (!arnMatch) {
			warnings.push(`${sid ?? 'Statement'}: Unrecognized resource format: ${resource}`);
			continue;
		}

		const path = arnMatch[1];
		const slashIndex = path.indexOf('/');
		if (slashIndex === -1) {
			const bucketName = path.replace(/\*+$/, '');
			if (path.includes('*') || path.includes('?')) {
				result.push(`bucket:${path}`);
				result.push(`object:${path}/*`);
				warnings.push(`${sid ?? 'Statement'}: Wildcard bucket "${path}" — use conditions for finer control`);
			} else {
				result.push(`bucket:${bucketName}`);
			}
		} else {
			const bucket = path.slice(0, slashIndex);
			const keyPattern = path.slice(slashIndex + 1);

			if (bucket.includes('*') || bucket.includes('?')) {
				result.push(`object:${bucket}/${keyPattern}`);
				warnings.push(`${sid ?? 'Statement'}: Wildcard bucket in object resource "${path}" — verify manually`);
			} else {
				result.push(`object:${bucket}/${keyPattern}`);
			}
		}
	}

	return result;
}

// ─── Import Dialog ──────────────────────────────────────────────────

interface ImportDialogProps {
	onImport: (policy: PolicyDocument) => void;
}

function ImportAwsDialog({ onImport }: ImportDialogProps) {
	const [open, setOpen] = useState(false);
	const [input, setInput] = useState('');
	const [result, setResult] = useState<ConvertResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	const handleParse = () => {
		setError(null);
		setResult(null);
		try {
			const parsed = JSON.parse(input.trim());
			if (!parsed.Statement || !Array.isArray(parsed.Statement)) {
				setError('Invalid AWS IAM policy: missing Statement array');
				return;
			}
			const converted = convertAwsPolicy(parsed);
			setResult(converted);
		} catch {
			setError('Invalid JSON — paste a valid AWS IAM policy document');
		}
	};

	const handleImport = () => {
		if (result) {
			onImport(result.policy);
			setOpen(false);
			setInput('');
			setResult(null);
			setError(null);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button type="button" variant="outline" size="sm" className="text-xs">
					<Upload className="h-3 w-3 mr-1" />
					Import from AWS
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Import AWS IAM Policy</DialogTitle>
					<DialogDescription>
						Paste an AWS IAM policy JSON. S3 statements will be converted to Gatekeeper format. Non-S3 actions (IAM, STS, Kinesis, etc.)
						will be skipped.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<textarea
						className="w-full h-48 rounded-md border border-border bg-background p-3 text-xs font-data resize-y focus:outline-none focus:ring-1 focus:ring-ring"
						placeholder='{"Version": "2012-10-17", "Statement": [...]}'
						value={input}
						onChange={(e) => {
							setInput(e.target.value);
							setResult(null);
							setError(null);
						}}
					/>

					{error && <div className="rounded-md border border-lv-red/30 bg-lv-red/10 p-3 text-xs text-lv-red">{error}</div>}

					{result && (
						<div className="space-y-3">
							<div className="rounded-md border border-lv-green/30 bg-lv-green/10 p-3">
								<p className="text-xs font-medium text-lv-green">
									Converted {result.policy.statements.length} statement{result.policy.statements.length !== 1 ? 's' : ''}
								</p>
							</div>

							{result.warnings.length > 0 && (
								<div className="rounded-md border border-lv-yellow/30 bg-lv-yellow/10 p-3 space-y-1">
									<div className="flex items-center gap-1.5 text-xs font-medium text-lv-yellow">
										<AlertTriangle className="h-3 w-3" />
										Warnings
									</div>
									{result.warnings.map((w, i) => (
										<p key={i} className="text-xs text-lv-yellow/80 pl-4.5">
											{w}
										</p>
									))}
								</div>
							)}

							{result.skipped.length > 0 && (
								<div className="rounded-md border border-border bg-muted/30 p-3 space-y-1">
									<p className="text-xs font-medium text-muted-foreground">Skipped</p>
									{result.skipped.map((s, i) => (
										<p key={i} className="text-xs text-muted-foreground pl-4.5">
											{s}
										</p>
									))}
								</div>
							)}

							<div className="space-y-1.5">
								<p className={T.formLabel}>Preview</p>
								<pre className="rounded-md border border-border bg-background/50 p-3 text-[11px] font-data text-muted-foreground overflow-x-auto max-h-48 overflow-y-auto">
									{JSON.stringify(result.policy, null, 2)}
								</pre>
							</div>
						</div>
					)}
				</div>

				<DialogFooter className="gap-2">
					{!result ? (
						<Button type="button" onClick={handleParse} disabled={!input.trim()}>
							Convert
						</Button>
					) : (
						<Button type="button" onClick={handleImport}>
							Import {result.policy.statements.length} Statement{result.policy.statements.length !== 1 ? 's' : ''}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ─── S3 Policy Builder ──────────────────────────────────────────────

export function S3PolicyBuilder({ value, onChange }: S3PolicyBuilderProps) {
	const [showJson, setShowJson] = useState(false);

	const updateStatement = useCallback(
		(index: number, stmt: Statement) => {
			const next = [...value.statements];
			next[index] = stmt;
			onChange({ ...value, statements: next });
		},
		[value, onChange],
	);

	const removeStatement = useCallback(
		(index: number) => {
			onChange({
				...value,
				statements: value.statements.filter((_, i) => i !== index),
			});
		},
		[value, onChange],
	);

	const addStatement = useCallback(() => {
		onChange({
			...value,
			statements: [
				...value.statements,
				{
					effect: 'allow',
					actions: ['s3:*'],
					resources: ['*'],
				},
			],
		});
	}, [value, onChange]);

	return (
		<div className="space-y-3">
			{value.statements.map((stmt, i) => (
				<StatementEditor
					key={i}
					index={i}
					statement={stmt}
					onChange={(s) => updateStatement(i, s)}
					onRemove={() => removeStatement(i)}
					canRemove={value.statements.length > 1}
				/>
			))}

			<div className="flex items-center gap-2">
				<Button type="button" variant="outline" size="sm" className="text-xs" onClick={addStatement}>
					<Plus className="h-3 w-3 mr-1" />
					Add Statement
				</Button>
				<ImportAwsDialog onImport={onChange} />
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="ml-auto text-xs text-muted-foreground"
					onClick={() => setShowJson(!showJson)}
				>
					{showJson ? <EyeOff className="h-3 w-3 mr-1" /> : <Eye className="h-3 w-3 mr-1" />}
					{showJson ? 'Hide' : 'Show'} JSON
				</Button>
			</div>

			{showJson && (
				<pre className="rounded-md border border-border bg-background/50 p-3 text-[11px] font-data text-muted-foreground overflow-x-auto max-h-48 overflow-y-auto">
					{JSON.stringify(value, null, 2)}
				</pre>
			)}
		</div>
	);
}
