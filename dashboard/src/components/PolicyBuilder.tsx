import { useState, useCallback } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

import { ConditionEditor, summarizeStatement } from '@/components/ConditionEditor';
import type { FieldOption, OperatorOption } from '@/components/ConditionEditor';
import type { PolicyDocument, Statement, Condition } from '@/lib/api';
import { cn } from '@/lib/utils';
import { T } from '@/lib/typography';

// ─── Constants ──────────────────────────────────────────────────────

const PURGE_ACTIONS = [
	{ value: 'purge:*', label: 'All Purge', description: 'All purge types' },
	{ value: 'purge:url', label: 'URL', description: 'Purge by URL (files)' },
	{ value: 'purge:host', label: 'Host', description: 'Purge by hostname' },
	{ value: 'purge:tag', label: 'Tag', description: 'Purge by cache tag' },
	{ value: 'purge:prefix', label: 'Prefix', description: 'Purge by URL prefix' },
	{ value: 'purge:everything', label: 'Everything', description: 'Purge all' },
] as const;

const DNS_ACTIONS = [
	{ value: 'dns:*', label: 'All DNS', description: 'All DNS operations' },
	{ value: 'dns:create', label: 'Create', description: 'Create DNS records' },
	{ value: 'dns:read', label: 'Read', description: 'Get or list DNS records' },
	{ value: 'dns:update', label: 'Update', description: 'Edit or overwrite DNS records' },
	{ value: 'dns:delete', label: 'Delete', description: 'Delete DNS records' },
	{ value: 'dns:batch', label: 'Batch', description: 'Batch create/update/delete' },
	{ value: 'dns:export', label: 'Export', description: 'Export BIND zone file' },
	{ value: 'dns:import', label: 'Import', description: 'Import BIND zone file' },
] as const;

const ALL_ACTIONS = [...PURGE_ACTIONS, ...DNS_ACTIONS] as const;

const CONDITION_FIELDS: readonly FieldOption[] = [
	// Purge fields
	{ value: 'host', label: 'Host', hint: 'e.g. example.com' },
	{ value: 'tag', label: 'Tag', hint: 'e.g. static-v2' },
	{ value: 'prefix', label: 'Prefix', hint: 'e.g. example.com/assets/' },
	{ value: 'url', label: 'URL', hint: 'e.g. https://example.com/page' },
	{ value: 'url.path', label: 'URL Path', hint: 'e.g. /api/v1/' },
	{ value: 'purge_everything', label: 'Purge Everything', hint: 'true/false' },
	// DNS fields
	{ value: 'dns.name', label: 'DNS Name', hint: 'e.g. _acme-challenge.example.com' },
	{ value: 'dns.type', label: 'DNS Type', hint: 'e.g. A, AAAA, CNAME, TXT' },
	{ value: 'dns.content', label: 'DNS Content', hint: 'e.g. 1.2.3.4' },
	{ value: 'dns.proxied', label: 'DNS Proxied', hint: 'true/false' },
	{ value: 'dns.ttl', label: 'DNS TTL', hint: 'e.g. 300' },
	{ value: 'dns.comment', label: 'DNS Comment', hint: 'e.g. managed by cert-manager' },
	// Request-level fields
	{ value: 'client_ip', label: 'Client IP', hint: 'e.g. 203.0.113.42' },
	{ value: 'client_country', label: 'Country', hint: 'e.g. US, DE, SG' },
	{ value: 'client_asn', label: 'ASN', hint: 'e.g. 13335' },
	{ value: 'time.hour', label: 'Hour (UTC)', hint: '0-23' },
	{ value: 'time.day_of_week', label: 'Day of Week', hint: '0=Sun, 6=Sat' },
	{ value: 'time.iso', label: 'Time (ISO)', hint: 'e.g. 2025-01-01T...' },
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
	{ value: 'lt', label: '< (less than)' },
	{ value: 'gt', label: '> (greater than)' },
	{ value: 'lte', label: '<= (less or equal)' },
	{ value: 'gte', label: '>= (greater or equal)' },
] as const;

// ─── Types ──────────────────────────────────────────────────────────

interface PolicyBuilderProps {
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
		const isWildcardAction = action === 'purge:*' || action === 'dns:*';
		const actionPrefix = action.split(':')[0] + ':';
		if (isWildcardAction) {
			// Toggle wildcard: if already set, remove all actions with that prefix; otherwise set only the wildcard
			const otherActions = Array.from(current).filter((a) => !a.startsWith(actionPrefix));
			if (current.has(action)) {
				onChange({ ...statement, actions: otherActions });
			} else {
				onChange({ ...statement, actions: [...otherActions, action] });
			}
			return;
		}
		// Remove same-prefix wildcard when toggling a specific action
		current.delete(actionPrefix + '*');
		if (current.has(action)) {
			current.delete(action);
		} else {
			current.add(action);
		}
		onChange({ ...statement, actions: Array.from(current) });
	};

	const conditions: Condition[] = statement.conditions ?? [];
	const hasPurgeWildcard = statement.actions.includes('purge:*');
	const hasDnsWildcard = statement.actions.includes('dns:*');
	const hasDnsActions = statement.actions.some((a) => a.startsWith('dns:'));
	const hasPurgeActions = statement.actions.some((a) => a.startsWith('purge:'));
	const domain = hasDnsActions && !hasPurgeActions ? 'dns' : hasPurgeActions && !hasDnsActions ? 'purge' : 'purge';
	const summary = summarizeStatement(statement, domain);

	return (
		<div className="rounded-lg border border-border bg-card/50 p-3 space-y-3">
			{/* ── Statement header ──────────────────────────────── */}
			<div className="flex items-center gap-2">
				<button type="button" onClick={() => setCollapsed(!collapsed)} className="text-muted-foreground hover:text-foreground">
					{collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
				</button>
				<span className={T.sectionLabel}>Statement {index + 1}</span>
				<Select value={statement.effect} onValueChange={(v) => onChange({ ...statement, effect: v as 'allow' | 'deny' })}>
					<SelectTrigger
						className={cn(
							'w-[90px] h-6 text-[10px] font-semibold border',
							statement.effect === 'deny' ? 'bg-lv-red/20 text-lv-red border-lv-red/30' : 'bg-lv-green/20 text-lv-green border-lv-green/30',
						)}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="allow" className="text-xs text-lv-green">
							ALLOW
						</SelectItem>
						<SelectItem value="deny" className="text-xs text-lv-red">
							DENY
						</SelectItem>
					</SelectContent>
				</Select>
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
								{ALL_ACTIONS.map((a) => {
									const isPurge = a.value.startsWith('purge:');
									const wildcardActive = isPurge ? hasPurgeWildcard : hasDnsWildcard;
									const active = wildcardActive ? a.value === (isPurge ? 'purge:*' : 'dns:*') : statement.actions.includes(a.value);
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
							placeholder="e.g. zone:abc123, zone:*, *"
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
							Use <code className="text-lv-cyan">zone:id</code> for a specific zone, or <code className="text-lv-cyan">*</code> for all
							zones.
						</p>
					</div>

					{/* ── Conditions ────────────────────────────────── */}
					<div className="space-y-2">
						<Label className={T.formLabel}>Conditions {conditions.length > 0 && `(${conditions.length})`}</Label>
						<ConditionEditor
							conditions={conditions}
							onChange={(next) => onChange({ ...statement, conditions: next.length > 0 ? next : undefined })}
							fields={CONDITION_FIELDS}
							operators={OPERATORS}
							defaultField="host"
						/>
					</div>
				</>
			)}
		</div>
	);
}

// ─── Policy Builder ─────────────────────────────────────────────────

export function PolicyBuilder({ value, onChange }: PolicyBuilderProps) {
	const [showJson, setShowJson] = useState(false);

	const ensureId = (stmt: Statement): Statement => (stmt._id ? stmt : { ...stmt, _id: crypto.randomUUID() });

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
					_id: crypto.randomUUID(),
					effect: 'allow',
					actions: ['purge:*'],
					resources: ['*'],
				},
			],
		});
	}, [value, onChange]);

	return (
		<div className="space-y-3">
			{value.statements.map((rawStmt, i) => {
				const stmt = ensureId(rawStmt);
				if (stmt !== rawStmt) {
					// Backfill _id on first render without triggering extra re-render
					value.statements[i] = stmt;
				}
				return (
					<StatementEditor
						key={stmt._id}
						index={i}
						statement={stmt}
						onChange={(s) => updateStatement(i, s)}
						onRemove={() => removeStatement(i)}
						canRemove={value.statements.length > 1}
					/>
				);
			})}

			<div className="flex items-center gap-2">
				<Button type="button" variant="outline" size="sm" className="text-xs" onClick={addStatement}>
					<Plus className="h-3 w-3 mr-1" />
					Add Statement
				</Button>
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
