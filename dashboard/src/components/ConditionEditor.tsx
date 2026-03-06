import { useState, useRef, useCallback } from 'react';
import { Plus, Trash2, X, GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Condition, LeafCondition, AnyCondition, AllCondition, NotCondition } from '@/lib/api';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────────

export interface FieldOption {
	value: string;
	label: string;
	hint: string;
}

export interface OperatorOption {
	value: string;
	label: string;
}

export interface ConditionEditorProps {
	conditions: Condition[];
	onChange: (conditions: Condition[]) => void;
	fields: readonly FieldOption[];
	operators: readonly OperatorOption[];
	defaultField: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const NO_VALUE_OPERATORS = new Set(['exists', 'not_exists']);
const ARRAY_OPERATORS = new Set(['in', 'not_in']);

type GroupType = 'all' | 'any' | 'not';

// ─── Type guards ────────────────────────────────────────────────────

function isLeaf(c: Condition): c is LeafCondition {
	return 'field' in c && 'operator' in c;
}

function isAny(c: Condition): c is AnyCondition {
	return 'any' in c;
}

function isAll(c: Condition): c is AllCondition {
	return 'all' in c;
}

function isNot(c: Condition): c is NotCondition {
	return 'not' in c;
}

// ─── Pills Input ────────────────────────────────────────────────────
// For in/not_in operators — renders values as removable pills.

interface PillsInputProps {
	values: string[];
	onChange: (values: string[]) => void;
	placeholder?: string;
}

function PillsInput({ values, onChange, placeholder }: PillsInputProps) {
	const [input, setInput] = useState('');
	const inputRef = useRef<HTMLInputElement>(null);

	const addValue = useCallback(
		(raw: string) => {
			const trimmed = raw.trim();
			if (trimmed && !values.includes(trimmed)) {
				onChange([...values, trimmed]);
			}
		},
		[values, onChange],
	);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			addValue(input);
			setInput('');
		} else if (e.key === 'Backspace' && input === '' && values.length > 0) {
			onChange(values.slice(0, -1));
		}
	};

	const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
		e.preventDefault();
		const pasted = e.clipboardData.getData('text');
		const items = pasted
			.split(/[,\n\r]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		const unique = [...new Set([...values, ...items])];
		onChange(unique);
		setInput('');
	};

	const removeValue = (index: number) => {
		onChange(values.filter((_, i) => i !== index));
	};

	return (
		<div
			className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 min-h-[36px] cursor-text"
			onClick={() => inputRef.current?.focus()}
		>
			{values.map((v, i) => (
				<Badge
					key={`${v}-${i}`}
					variant="secondary"
					className="gap-0.5 px-1.5 py-0 text-[11px] font-data bg-lv-purple/15 text-lv-purple border-lv-purple/25 hover:bg-lv-purple/25"
				>
					{v}
					<button
						type="button"
						className="ml-0.5 hover:text-lv-red transition-colors"
						onClick={(e) => {
							e.stopPropagation();
							removeValue(i);
						}}
					>
						<X className="h-2.5 w-2.5" />
					</button>
				</Badge>
			))}
			<input
				ref={inputRef}
				type="text"
				value={input}
				onChange={(e) => setInput(e.target.value)}
				onKeyDown={handleKeyDown}
				onPaste={handlePaste}
				onBlur={() => {
					if (input.trim()) {
						addValue(input);
						setInput('');
					}
				}}
				placeholder={values.length === 0 ? (placeholder ?? 'Type and press Enter') : ''}
				className="flex-1 min-w-[80px] bg-transparent text-xs font-data outline-none placeholder:text-muted-foreground"
			/>
		</div>
	);
}

// ─── Leaf Condition Row ─────────────────────────────────────────────

interface LeafRowProps {
	condition: LeafCondition;
	onChange: (c: LeafCondition) => void;
	onRemove: () => void;
	fields: readonly FieldOption[];
	operators: readonly OperatorOption[];
}

function LeafRow({ condition, onChange, onRemove, fields, operators }: LeafRowProps) {
	const isArray = ARRAY_OPERATORS.has(condition.operator);
	const noValue = NO_VALUE_OPERATORS.has(condition.operator);

	return (
		<div className="space-y-1.5">
			<div className="flex items-start gap-2">
				<Select value={condition.field} onValueChange={(v) => onChange({ ...condition, field: v })}>
					<SelectTrigger className="w-[130px] text-xs font-data">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{fields.map((f) => (
							<SelectItem key={f.value} value={f.value} className="text-xs">
								{f.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<Select
					value={condition.operator}
					onValueChange={(v) => {
						// Reset value when switching to/from array operators
						const wasArray = ARRAY_OPERATORS.has(condition.operator);
						const nowArray = ARRAY_OPERATORS.has(v);
						const nowNoValue = NO_VALUE_OPERATORS.has(v);
						let value = condition.value;
						if (nowNoValue) {
							value = '';
						} else if (wasArray && !nowArray) {
							value = Array.isArray(condition.value) ? (condition.value[0] ?? '') : condition.value;
						} else if (!wasArray && nowArray) {
							value = typeof condition.value === 'string' && condition.value ? [condition.value] : [];
						}
						onChange({ ...condition, operator: v, value });
					}}
				>
					<SelectTrigger className="w-[140px] text-xs font-data">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{operators.map((op) => (
							<SelectItem key={op.value} value={op.value} className="text-xs">
								{op.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				{!noValue && !isArray && (
					<Input
						placeholder={fields.find((f) => f.value === condition.field)?.hint ?? 'value'}
						value={typeof condition.value === 'string' ? condition.value : String(condition.value ?? '')}
						onChange={(e) => onChange({ ...condition, value: e.target.value })}
						className="flex-1 text-xs font-data"
					/>
				)}

				{!noValue && isArray && <div className="flex-1" />}

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

			{/* Pills row for in/not_in */}
			{isArray && !noValue && (
				<div className="ml-0 pl-0">
					<PillsInput
						values={Array.isArray(condition.value) ? condition.value : []}
						onChange={(vals) => onChange({ ...condition, value: vals })}
						placeholder={fields.find((f) => f.value === condition.field)?.hint ?? 'Type value, press Enter'}
					/>
				</div>
			)}
		</div>
	);
}

// ─── Condition Group ────────────────────────────────────────────────
// Recursive component for any/all/not compound conditions.

interface ConditionNodeProps {
	condition: Condition;
	onChange: (c: Condition) => void;
	onRemove: () => void;
	fields: readonly FieldOption[];
	operators: readonly OperatorOption[];
	defaultField: string;
	depth: number;
}

function ConditionNode({ condition, onChange, onRemove, fields, operators, defaultField, depth }: ConditionNodeProps) {
	if (isLeaf(condition)) {
		return <LeafRow condition={condition} onChange={onChange} onRemove={onRemove} fields={fields} operators={operators} />;
	}

	// Determine group type and children
	let groupType: GroupType;
	let children: Condition[];

	if (isAny(condition)) {
		groupType = 'any';
		children = condition.any;
	} else if (isAll(condition)) {
		groupType = 'all';
		children = condition.all;
	} else if (isNot(condition)) {
		groupType = 'not';
		children = [condition.not];
	} else {
		return null;
	}

	const updateChildren = (newChildren: Condition[]) => {
		if (groupType === 'any') onChange({ any: newChildren });
		else if (groupType === 'all') onChange({ all: newChildren });
		else if (groupType === 'not' && newChildren.length > 0) onChange({ not: newChildren[0] });
	};

	const switchGroupType = (newType: GroupType) => {
		if (newType === groupType) return;
		if (newType === 'not') {
			// NOT wraps a single condition — take first child
			onChange({ not: children[0] ?? { field: defaultField, operator: 'eq', value: '' } });
		} else if (newType === 'any') {
			onChange({ any: children.length > 0 ? children : [{ field: defaultField, operator: 'eq', value: '' }] });
		} else {
			onChange({ all: children.length > 0 ? children : [{ field: defaultField, operator: 'eq', value: '' }] });
		}
	};

	const addChild = () => {
		const newChild: LeafCondition = { field: defaultField, operator: 'eq', value: '' };
		if (groupType === 'not') {
			// NOT can only have one child — wrap current in ALL with new sibling
			onChange({ all: [condition, newChild] });
		} else {
			updateChildren([...children, newChild]);
		}
	};

	const removeChild = (index: number) => {
		const next = children.filter((_, i) => i !== index);
		if (next.length === 0) {
			onRemove();
		} else {
			updateChildren(next);
		}
	};

	const updateChild = (index: number, c: Condition) => {
		const next = [...children];
		next[index] = c;
		updateChildren(next);
	};

	const groupLabel = groupType === 'any' ? 'Match ANY (OR)' : groupType === 'all' ? 'Match ALL (AND)' : 'NOT';
	const groupColor = groupType === 'any' ? 'lv-yellow' : groupType === 'all' ? 'lv-cyan' : 'lv-red';
	const borderColor = groupType === 'any' ? 'border-lv-yellow/30' : groupType === 'all' ? 'border-lv-cyan/30' : 'border-lv-red/30';
	const bgColor = groupType === 'any' ? 'bg-lv-yellow/5' : groupType === 'all' ? 'bg-lv-cyan/5' : 'bg-lv-red/5';

	return (
		<div className={cn('rounded-md border pl-3 pr-2 py-2 space-y-2', borderColor, bgColor)}>
			{/* Group header */}
			<div className="flex items-center gap-2">
				<GitBranch className={cn('h-3 w-3', `text-${groupColor}`)} />
				<Select value={groupType} onValueChange={(v) => switchGroupType(v as GroupType)}>
					<SelectTrigger className={cn('w-[150px] h-7 text-[11px] font-medium', `text-${groupColor}`)}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all" className="text-xs">
							Match ALL (AND)
						</SelectItem>
						<SelectItem value="any" className="text-xs">
							Match ANY (OR)
						</SelectItem>
						<SelectItem value="not" className="text-xs">
							NOT
						</SelectItem>
					</SelectContent>
				</Select>
				<span className="text-[10px] text-muted-foreground">
					{groupType === 'any' ? 'at least one must match' : groupType === 'all' ? 'every condition must match' : 'inverts the result'}
				</span>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="ml-auto h-6 w-6 text-muted-foreground hover:text-lv-red"
					onClick={onRemove}
				>
					<Trash2 className="h-3 w-3" />
				</Button>
			</div>

			{/* Children */}
			<div className="space-y-2">
				{children.map((child, i) => (
					<ConditionNode
						key={i}
						condition={child}
						onChange={(c) => updateChild(i, c)}
						onRemove={() => removeChild(i)}
						fields={fields}
						operators={operators}
						defaultField={defaultField}
						depth={depth + 1}
					/>
				))}
			</div>

			{/* Add child (not for NOT which only holds one) */}
			{groupType !== 'not' && (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-6 text-[11px] text-muted-foreground hover:text-foreground"
					onClick={addChild}
				>
					<Plus className="h-3 w-3 mr-1" />
					Add condition
				</Button>
			)}
		</div>
	);
}

// ─── Main ConditionEditor ───────────────────────────────────────────
// Top-level: manages a flat list of conditions (the statement.conditions array).
// Each item can be a leaf or a compound group.

export function ConditionEditor({ conditions, onChange, fields, operators, defaultField }: ConditionEditorProps) {
	const addLeaf = () => {
		onChange([...conditions, { field: defaultField, operator: 'eq', value: '' }]);
	};

	const addGroup = (type: GroupType) => {
		const child: LeafCondition = { field: defaultField, operator: 'eq', value: '' };
		if (type === 'any') onChange([...conditions, { any: [child] }]);
		else if (type === 'all') onChange([...conditions, { all: [child] }]);
		else onChange([...conditions, { not: child }]);
	};

	const updateCondition = (index: number, c: Condition) => {
		const next = [...conditions];
		next[index] = c;
		onChange(next);
	};

	const removeCondition = (index: number) => {
		onChange(conditions.filter((_, i) => i !== index));
	};

	return (
		<div className="space-y-2">
			{conditions.length === 0 && <p className="text-xs text-muted-foreground italic">No conditions — all matching actions are allowed.</p>}

			{conditions.map((c, i) => (
				<ConditionNode
					key={i}
					condition={c}
					onChange={(updated) => updateCondition(i, updated)}
					onRemove={() => removeCondition(i)}
					fields={fields}
					operators={operators}
					defaultField={defaultField}
					depth={0}
				/>
			))}

			{/* Add buttons */}
			<div className="flex items-center gap-1.5">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-6 text-xs text-muted-foreground hover:text-foreground"
					onClick={addLeaf}
				>
					<Plus className="h-3 w-3 mr-1" />
					Condition
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-6 text-xs text-muted-foreground hover:text-foreground"
					onClick={() => addGroup('all')}
				>
					<GitBranch className="h-3 w-3 mr-1" />
					AND group
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-6 text-xs text-muted-foreground hover:text-foreground"
					onClick={() => addGroup('any')}
				>
					<GitBranch className="h-3 w-3 mr-1" />
					OR group
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-6 text-xs text-muted-foreground hover:text-foreground"
					onClick={() => addGroup('not')}
				>
					<GitBranch className="h-3 w-3 mr-1" />
					NOT
				</Button>
			</div>
		</div>
	);
}

// ─── Statement Summary ──────────────────────────────────────────────
// Human-readable one-liner describing what a statement does.

export function summarizeStatement(
	statement: { effect: string; actions: string[]; resources: string[]; conditions?: Condition[] },
	actionPrefix: string,
): string {
	const { actions, resources, conditions } = statement;

	// Actions
	let actionStr: string;
	if (actions.length === 0) {
		actionStr = 'nothing';
	} else if (actions.includes(`${actionPrefix}:*`)) {
		actionStr = `all ${actionPrefix} operations`;
	} else {
		actionStr = actions.map((a) => a.replace(`${actionPrefix}:`, '')).join(', ');
	}

	// Resources
	let resourceStr: string;
	if (resources.length === 0 || (resources.length === 1 && resources[0] === '*')) {
		resourceStr = '';
	} else {
		resourceStr = ` on ${resources.join(', ')}`;
	}

	// Conditions
	let condStr = '';
	if (conditions && conditions.length > 0) {
		const parts = conditions.map(summarizeCondition);
		condStr = ` where ${parts.join(' AND ')}`;
	}

	const effectLabel = statement.effect === 'deny' ? 'Deny' : 'Allow';
	return `${effectLabel} ${actionStr}${resourceStr}${condStr}`;
}

function summarizeCondition(c: Condition): string {
	if (isLeaf(c)) {
		const op = c.operator;
		if (op === 'exists') return `${c.field} exists`;
		if (op === 'not_exists') return `${c.field} not exists`;
		if (op === 'in' || op === 'not_in') {
			const vals = Array.isArray(c.value) ? c.value : [String(c.value)];
			const label = op === 'in' ? 'in' : 'not in';
			return `${c.field} ${label} [${vals.slice(0, 3).join(', ')}${vals.length > 3 ? ', ...' : ''}]`;
		}
		const opLabel: Record<string, string> = {
			eq: '=',
			ne: '!=',
			contains: 'contains',
			not_contains: '!contains',
			starts_with: 'starts with',
			ends_with: 'ends with',
			wildcard: 'matches',
			matches: '~',
			not_matches: '!~',
			lt: '<',
			gt: '>',
			lte: '<=',
			gte: '>=',
		};
		return `${c.field} ${opLabel[op] ?? op} "${c.value}"`;
	}
	if (isAny(c)) {
		return `(${c.any.map(summarizeCondition).join(' OR ')})`;
	}
	if (isAll(c)) {
		return `(${c.all.map(summarizeCondition).join(' AND ')})`;
	}
	if (isNot(c)) {
		return `NOT ${summarizeCondition(c.not)}`;
	}
	return '?';
}
