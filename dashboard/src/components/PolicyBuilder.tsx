import { useState, useCallback } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { PolicyDocument, Statement, LeafCondition } from '@/lib/api';
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

const CONDITION_FIELDS = [
	{ value: 'host', label: 'Host', hint: 'e.g. example.com' },
	{ value: 'tag', label: 'Tag', hint: 'e.g. static-v2' },
	{ value: 'prefix', label: 'Prefix', hint: 'e.g. example.com/assets/' },
	{ value: 'url', label: 'URL', hint: 'e.g. https://example.com/page' },
	{ value: 'url.path', label: 'URL Path', hint: 'e.g. /api/v1/' },
	{ value: 'purge_everything', label: 'Purge Everything', hint: 'true/false' },
] as const;

const OPERATORS = [
	{ value: 'eq', label: 'equals' },
	{ value: 'ne', label: 'not equals' },
	{ value: 'contains', label: 'contains' },
	{ value: 'not_contains', label: 'not contains' },
	{ value: 'starts_with', label: 'starts with' },
	{ value: 'ends_with', label: 'ends with' },
	{ value: 'wildcard', label: 'wildcard (*)' },
	{ value: 'matches', label: 'regex' },
	{ value: 'in', label: 'in (comma-sep)' },
	{ value: 'exists', label: 'exists' },
	{ value: 'not_exists', label: 'not exists' },
] as const;

const NO_VALUE_OPERATORS = new Set(['exists', 'not_exists']);

// ─── Types ──────────────────────────────────────────────────────────

interface PolicyBuilderProps {
	value: PolicyDocument;
	onChange: (policy: PolicyDocument) => void;
}

// ─── Condition Row ──────────────────────────────────────────────────

interface ConditionRowProps {
	condition: LeafCondition;
	onChange: (c: LeafCondition) => void;
	onRemove: () => void;
}

function ConditionRow({ condition, onChange, onRemove }: ConditionRowProps) {
	return (
		<div className="flex items-start gap-2">
			<Select value={condition.field} onValueChange={(v) => onChange({ ...condition, field: v })}>
				<SelectTrigger className="w-[130px] text-xs font-data">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{CONDITION_FIELDS.map((f) => (
						<SelectItem key={f.value} value={f.value} className="text-xs">
							{f.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			<Select value={condition.operator} onValueChange={(v) => onChange({ ...condition, operator: v })}>
				<SelectTrigger className="w-[140px] text-xs font-data">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{OPERATORS.map((op) => (
						<SelectItem key={op.value} value={op.value} className="text-xs">
							{op.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			{!NO_VALUE_OPERATORS.has(condition.operator) && (
				<Input
					placeholder={CONDITION_FIELDS.find((f) => f.value === condition.field)?.hint ?? 'value'}
					value={Array.isArray(condition.value) ? condition.value.join(', ') : String(condition.value ?? '')}
					onChange={(e) => {
						const raw = e.target.value;
						const value = condition.operator === 'in' ? raw.split(',').map((s) => s.trim()) : raw;
						onChange({ ...condition, value });
					}}
					className="flex-1 text-xs font-data"
				/>
			)}

			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="h-9 w-9 shrink-0 text-muted-foreground hover:text-lv-red"
				onClick={onRemove}
			>
				<Trash2 className="h-3.5 w-3.5" />
			</Button>
		</div>
	);
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
		if (action === 'purge:*') {
			// Toggle all — if wildcard is set, clear it; otherwise set only wildcard
			onChange({
				...statement,
				actions: current.has('purge:*') ? [] : ['purge:*'],
			});
			return;
		}
		// Remove wildcard if selecting individual actions
		current.delete('purge:*');
		if (current.has(action)) {
			current.delete(action);
		} else {
			current.add(action);
		}
		onChange({ ...statement, actions: Array.from(current) });
	};

	const conditions = (statement.conditions ?? []).filter((c): c is LeafCondition => 'field' in c);

	const updateCondition = (i: number, c: LeafCondition) => {
		const next = [...conditions];
		next[i] = c;
		onChange({ ...statement, conditions: next });
	};

	const removeCondition = (i: number) => {
		const next = conditions.filter((_, idx) => idx !== i);
		onChange({
			...statement,
			conditions: next.length > 0 ? next : undefined,
		});
	};

	const addCondition = () => {
		onChange({
			...statement,
			conditions: [...conditions, { field: 'host', operator: 'eq', value: '' }],
		});
	};

	const isWildcard = statement.actions.includes('purge:*');

	return (
		<div className="rounded-lg border border-border bg-card/50 p-3 space-y-3">
			{/* ── Statement header ──────────────────────────────── */}
			<div className="flex items-center gap-2">
				<button type="button" onClick={() => setCollapsed(!collapsed)} className="text-muted-foreground hover:text-foreground">
					{collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
				</button>
				<span className={T.sectionLabel}>Statement {index + 1}</span>
				<Badge className="bg-lv-green/20 text-lv-green border-lv-green/30 text-[10px]">ALLOW</Badge>
				{collapsed && (
					<span className="text-xs text-muted-foreground ml-2">
						{isWildcard ? 'purge:*' : statement.actions.join(', ')}
						{conditions.length > 0 && ` (${conditions.length} condition${conditions.length > 1 ? 's' : ''})`}
					</span>
				)}
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

			{!collapsed && (
				<>
					{/* ── Actions ───────────────────────────────────── */}
					<div className="space-y-2">
						<Label className={T.formLabel}>Actions</Label>
						<div className="flex flex-wrap gap-1.5">
							{PURGE_ACTIONS.map((a) => {
								const active = isWildcard ? a.value === 'purge:*' : statement.actions.includes(a.value);
								return (
									<button
										key={a.value}
										type="button"
										onClick={() => toggleAction(a.value)}
										className={cn(
											'rounded-md border px-2.5 py-1 text-xs font-data transition-colors',
											active
												? 'border-lv-purple/50 bg-lv-purple/20 text-lv-purple'
												: 'border-border text-muted-foreground hover:border-lv-purple/30 hover:text-foreground',
										)}
										title={a.description}
									>
										{a.label}
									</button>
								);
							})}
						</div>
					</div>

					{/* ── Conditions ────────────────────────────────── */}
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<Label className={T.formLabel}>Conditions {conditions.length > 0 && `(${conditions.length})`}</Label>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-6 text-xs text-muted-foreground hover:text-foreground"
								onClick={addCondition}
							>
								<Plus className="h-3 w-3 mr-1" />
								Add
							</Button>
						</div>
						{conditions.length === 0 && <p className={cn(T.muted, 'italic')}>No conditions — all matching actions are allowed.</p>}
						{conditions.map((c, i) => (
							<ConditionRow key={i} condition={c} onChange={(updated) => updateCondition(i, updated)} onRemove={() => removeCondition(i)} />
						))}
					</div>
				</>
			)}
		</div>
	);
}

// ─── Policy Builder ─────────────────────────────────────────────────

export function PolicyBuilder({ value, onChange }: PolicyBuilderProps) {
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
					actions: ['purge:*'],
					resources: ['*'],
				},
			],
		});
	}, [value, onChange]);

	return (
		<div className="space-y-3">
			{/* ── Statements ─────────────────────────────────────── */}
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

			{/* ── Add / Preview buttons ──────────────────────────── */}
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

			{/* ── JSON Preview ───────────────────────────────────── */}
			{showJson && (
				<pre className="rounded-md border border-border bg-background/50 p-3 text-[11px] font-data text-muted-foreground overflow-x-auto max-h-48 overflow-y-auto">
					{JSON.stringify(value, null, 2)}
				</pre>
			)}
		</div>
	);
}
