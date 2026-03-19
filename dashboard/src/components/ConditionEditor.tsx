import { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, Trash2, X, GitBranch, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { Condition, LeafCondition, AnyCondition, AllCondition, NotCondition } from '@/lib/api';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────────

export interface FieldOption {
	value: string;
	label: string;
	hint: string;
	/** Which action prefixes this field applies to (e.g. ['purge']). Omit for universal fields. */
	appliesTo?: string[];
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
	/** Currently selected action prefixes — used to highlight inapplicable conditions. */
	activeActionPrefixes?: string[];
}

// ─── Constants ──────────────────────────────────────────────────────

const NO_VALUE_OPERATORS = new Set(['exists', 'not_exists']);
const ARRAY_OPERATORS = new Set(['in', 'not_in']);

/** Ensure a condition has a stable _id for React keys. */
function ensureConditionId<T extends Condition>(c: T): T {
	return c._id ? c : { ...c, _id: crypto.randomUUID() };
}

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

// ─── Applicability check ────────────────────────────────────────────

/** Check if a field is applicable given the active action prefixes. */
function isFieldApplicable(field: string, fields: readonly FieldOption[], activePrefixes?: string[]): boolean {
	if (!activePrefixes || activePrefixes.length === 0) return true;
	const def = fields.find((f) => f.value === field);
	if (!def || !def.appliesTo) return true; // universal field
	return def.appliesTo.some((p) => activePrefixes.includes(p));
}

// ─── Pills Input ────────────────────────────────────────────────────

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
	/** Whether this field is applicable to the current actions. */
	applicable: boolean;
}

function LeafRow({ condition, onChange, onRemove, fields, operators, applicable }: LeafRowProps) {
	const isArray = ARRAY_OPERATORS.has(condition.operator);
	const noValue = NO_VALUE_OPERATORS.has(condition.operator);
	const fieldDef = fields.find((f) => f.value === condition.field);

	return (
		<div className={cn('space-y-1.5', !applicable && 'opacity-60')}>
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
						placeholder={fieldDef?.hint ?? 'value'}
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

			{/* Inapplicable warning */}
			{!applicable && fieldDef && (
				<p className="text-[10px] text-lv-peach flex items-center gap-1">
					<Info className="h-3 w-3" />
					<span>
						<strong>{fieldDef.label}</strong> only applies to {fieldDef.appliesTo?.join(', ') ?? 'specific'} actions. This condition will
						fail for other action types.
					</span>
				</p>
			)}

			{/* Pills row for in/not_in */}
			{isArray && !noValue && (
				<div className="ml-0 pl-0">
					<PillsInput
						values={Array.isArray(condition.value) ? condition.value : []}
						onChange={(vals) => onChange({ ...condition, value: vals })}
						placeholder={fieldDef?.hint ?? 'Type value, press Enter'}
					/>
				</div>
			)}
		</div>
	);
}

// ─── Condition Group ────────────────────────────────────────────────

interface ConditionNodeProps {
	condition: Condition;
	onChange: (c: Condition) => void;
	onRemove: () => void;
	fields: readonly FieldOption[];
	operators: readonly OperatorOption[];
	defaultField: string;
	depth: number;
	activeActionPrefixes?: string[];
}

function ConditionNode({
	condition,
	onChange,
	onRemove,
	fields,
	operators,
	defaultField,
	depth,
	activeActionPrefixes,
}: ConditionNodeProps) {
	if (isLeaf(condition)) {
		const applicable = isFieldApplicable(condition.field, fields, activeActionPrefixes);
		return (
			<LeafRow
				condition={condition}
				onChange={onChange}
				onRemove={onRemove}
				fields={fields}
				operators={operators}
				applicable={applicable}
			/>
		);
	}

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
		const fallback: LeafCondition = { _id: crypto.randomUUID(), field: defaultField, operator: 'eq', value: '' };
		if (newType === 'not') {
			onChange({ _id: condition._id, not: children[0] ?? fallback });
		} else if (newType === 'any') {
			onChange({ _id: condition._id, any: children.length > 0 ? children : [fallback] });
		} else {
			onChange({ _id: condition._id, all: children.length > 0 ? children : [fallback] });
		}
	};

	const addChild = () => {
		const newChild: LeafCondition = { _id: crypto.randomUUID(), field: defaultField, operator: 'eq', value: '' };
		if (groupType === 'not') {
			onChange({ _id: crypto.randomUUID(), all: [condition, newChild] });
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
	const borderColor = groupType === 'any' ? 'border-lv-yellow/30' : groupType === 'all' ? 'border-lv-cyan/30' : 'border-lv-red/30';
	const bgColor = groupType === 'any' ? 'bg-lv-yellow/5' : groupType === 'all' ? 'bg-lv-cyan/5' : 'bg-lv-red/5';
	const labelColor = groupType === 'any' ? 'text-lv-yellow' : groupType === 'all' ? 'text-lv-cyan' : 'text-lv-red';

	return (
		<div className={cn('rounded-md border pl-3 pr-2 py-2 space-y-2', borderColor, bgColor)}>
			{/* Group header */}
			<div className="flex items-center gap-2">
				<GitBranch className={cn('h-3 w-3', labelColor)} />
				<Select value={groupType} onValueChange={(v) => switchGroupType(v as GroupType)}>
					<SelectTrigger className={cn('w-[150px] h-7 text-[11px] font-medium', labelColor)}>
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
				{children.map((rawChild, i) => {
					const child = ensureConditionId(rawChild);
					if (child !== rawChild) children[i] = child;
					return (
						<ConditionNode
							key={child._id}
							condition={child}
							onChange={(c) => updateChild(i, c)}
							onRemove={() => removeChild(i)}
							fields={fields}
							operators={operators}
							defaultField={defaultField}
							depth={depth + 1}
							activeActionPrefixes={activeActionPrefixes}
						/>
					);
				})}
			</div>

			{/* Add child */}
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

export function ConditionEditor({ conditions, onChange, fields, operators, defaultField, activeActionPrefixes }: ConditionEditorProps) {
	const [showGroupMenu, setShowGroupMenu] = useState(false);
	const groupMenuRef = useRef<HTMLDivElement>(null);

	// Close group menu on outside click — uses ref containment check.
	useEffect(() => {
		if (!showGroupMenu) return;
		const handleClick = (e: MouseEvent) => {
			if (groupMenuRef.current && !groupMenuRef.current.contains(e.target as Node)) {
				setShowGroupMenu(false);
			}
		};
		document.addEventListener('click', handleClick);
		return () => document.removeEventListener('click', handleClick);
	}, [showGroupMenu]);

	const addLeaf = () => {
		onChange([...conditions, { _id: crypto.randomUUID(), field: defaultField, operator: 'eq', value: '' }]);
	};

	const addGroup = (type: GroupType) => {
		const child: LeafCondition = { _id: crypto.randomUUID(), field: defaultField, operator: 'eq', value: '' };
		if (type === 'any') onChange([...conditions, { _id: crypto.randomUUID(), any: [child] }]);
		else if (type === 'all') onChange([...conditions, { _id: crypto.randomUUID(), all: [child] }]);
		else onChange([...conditions, { _id: crypto.randomUUID(), not: child }]);
		setShowGroupMenu(false);
	};

	const updateCondition = (index: number, c: Condition) => {
		const next = [...conditions];
		next[index] = c;
		onChange(next);
	};

	const removeCondition = (index: number) => {
		onChange(conditions.filter((_, i) => i !== index));
	};

	/** Detect if top-level is a single OR group wrapping leaf conditions. */
	const isSingleOrGroup = conditions.length === 1 && isAny(conditions[0]);
	/** The effective join mode for the separator toggle. */
	const joinMode: 'and' | 'or' = isSingleOrGroup ? 'or' : 'and';
	/** The conditions to render — either the flat array or the OR group's children. */
	const displayConditions = isSingleOrGroup ? (conditions[0] as AnyCondition).any : conditions;

	/** Toggle between AND (flat) and OR (wrap in any group). */
	const toggleJoin = () => {
		if (joinMode === 'and') {
			// Wrap all flat conditions into an OR group
			onChange([{ _id: crypto.randomUUID(), any: [...conditions] }]);
		} else {
			// Unwrap: pull children out of the single OR group
			const children = (conditions[0] as AnyCondition).any;
			onChange([...children]);
		}
	};

	/** When inside OR mode, updates go to the any group's children. */
	const updateDisplayCondition = (index: number, c: Condition) => {
		if (isSingleOrGroup) {
			const next = [...(conditions[0] as AnyCondition).any];
			next[index] = c;
			onChange([{ ...conditions[0], any: next }]);
		} else {
			updateCondition(index, c);
		}
	};

	const removeDisplayCondition = (index: number) => {
		if (isSingleOrGroup) {
			const next = (conditions[0] as AnyCondition).any.filter((_: Condition, i: number) => i !== index);
			if (next.length === 0) {
				onChange([]);
			} else if (next.length === 1) {
				// Unwrap single remaining child back to flat
				onChange([next[0]]);
			} else {
				onChange([{ ...conditions[0], any: next }]);
			}
		} else {
			removeCondition(index);
		}
	};

	const addDisplayLeaf = () => {
		const leaf: LeafCondition = { _id: crypto.randomUUID(), field: defaultField, operator: 'eq', value: '' };
		if (isSingleOrGroup) {
			const next = [...(conditions[0] as AnyCondition).any, leaf];
			onChange([{ ...conditions[0], any: next }]);
		} else {
			addLeaf();
		}
	};

	return (
		<div className="space-y-2">
			{conditions.length === 0 && (
				<p className="text-xs text-muted-foreground italic">No conditions -- all matching actions are allowed.</p>
			)}

			{displayConditions.map((rawC, i) => {
				const c = ensureConditionId(rawC);
				if (c !== rawC) displayConditions[i] = c;
				return (
					<div key={c._id}>
						{/* AND/OR separator toggle between conditions */}
						{i > 0 && (
							<div className="flex items-center gap-2 py-1">
								<div className="flex-1 border-t border-border" />
								<button
									type="button"
									onClick={toggleJoin}
									className={cn(
										'text-[10px] font-semibold uppercase tracking-widest transition-colors rounded px-2 py-0.5',
										'hover:bg-muted/50 cursor-pointer',
										joinMode === 'and' ? 'text-lv-cyan' : 'text-lv-yellow',
									)}
									title={joinMode === 'and' ? 'Click to switch to OR (any match)' : 'Click to switch to AND (all match)'}
								>
									{joinMode === 'and' ? 'AND' : 'OR'}
								</button>
								<div className="flex-1 border-t border-border" />
							</div>
						)}
						<ConditionNode
							condition={c}
							onChange={(updated) => updateDisplayCondition(i, updated)}
							onRemove={() => removeDisplayCondition(i)}
							fields={fields}
							operators={operators}
							defaultField={defaultField}
							depth={0}
							activeActionPrefixes={activeActionPrefixes}
						/>
					</div>
				);
			})}

			{/* Add buttons -- simplified */}
			<div className="flex items-center gap-1.5 relative">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-7 text-xs text-muted-foreground hover:text-foreground"
					onClick={addDisplayLeaf}
				>
					<Plus className="h-3 w-3 mr-1" />
					Add condition
				</Button>

				<div className="relative" ref={groupMenuRef}>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 text-xs text-muted-foreground hover:text-foreground"
						onClick={() => setShowGroupMenu(!showGroupMenu)}
					>
						<GitBranch className="h-3 w-3 mr-1" />
						Add group
					</Button>
					{showGroupMenu && (
						<div
							data-testid="group-menu"
							className="absolute left-0 top-full z-50 mt-1 rounded-md border border-border bg-card shadow-lg py-1 w-44"
						>
							<button
								type="button"
								data-testid="group-option-or"
								className="w-full px-3 py-1.5 text-left text-xs hover:bg-muted/50 flex items-center gap-2"
								onClick={() => addGroup('any')}
							>
								<span className="font-medium text-lv-yellow">OR group</span>
								<span className="text-muted-foreground">at least one</span>
							</button>
							<button
								type="button"
								data-testid="group-option-and"
								className="w-full px-3 py-1.5 text-left text-xs hover:bg-muted/50 flex items-center gap-2"
								onClick={() => addGroup('all')}
							>
								<span className="font-medium text-lv-cyan">AND group</span>
								<span className="text-muted-foreground">every one</span>
							</button>
							<button
								type="button"
								data-testid="group-option-not"
								className="w-full px-3 py-1.5 text-left text-xs hover:bg-muted/50 flex items-center gap-2"
								onClick={() => addGroup('not')}
							>
								<span className="font-medium text-lv-red">NOT</span>
								<span className="text-muted-foreground">invert</span>
							</button>
						</div>
					)}
				</div>

				{conditions.length === 0 && (
					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger asChild>
								<Info className="h-3.5 w-3.5 text-muted-foreground/50 cursor-help" />
							</TooltipTrigger>
							<TooltipContent side="right" className="max-w-xs text-xs">
								<p>
									Conditions narrow when a statement applies. Multiple conditions are AND'd together. Use an OR group if you need any-of
									matching.
								</p>
								<p className="mt-1 text-muted-foreground">
									Some conditions only apply to specific action types (e.g. <strong>host</strong> applies to purge URL/host actions, not tag
									purges).
								</p>
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				)}
			</div>
		</div>
	);
}

// ─── Statement Summary ──────────────────────────────────────────────

export function summarizeStatement(
	statement: { effect: string; actions: string[]; resources: string[]; conditions?: Condition[] },
	actionPrefix: string,
): string {
	const { actions, resources, conditions } = statement;

	let actionStr: string;
	if (actions.length === 0) {
		actionStr = 'nothing';
	} else if (actions.includes(`${actionPrefix}:*`)) {
		actionStr = `all ${actionPrefix} operations`;
	} else {
		actionStr = actions.map((a) => a.replace(`${actionPrefix}:`, '')).join(', ');
	}

	let resourceStr: string;
	if (resources.length === 0 || (resources.length === 1 && resources[0] === '*')) {
		resourceStr = '';
	} else {
		resourceStr = ` on ${resources.join(', ')}`;
	}

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
