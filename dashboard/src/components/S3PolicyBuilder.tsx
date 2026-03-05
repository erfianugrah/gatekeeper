import { useState, useCallback } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { PolicyDocument, Statement, LeafCondition } from "@/lib/api";
import { cn } from "@/lib/utils";
import { T } from "@/lib/typography";

// ─── Constants ──────────────────────────────────────────────────────

const S3_ACTIONS = [
	{ value: "s3:*", label: "All S3", description: "Full access to all S3 operations" },
	{ value: "s3:GetObject", label: "GetObject", description: "Read objects" },
	{ value: "s3:PutObject", label: "PutObject", description: "Write/upload objects" },
	{ value: "s3:DeleteObject", label: "DeleteObject", description: "Delete objects" },
	{ value: "s3:ListBucket", label: "ListBucket", description: "List objects in a bucket" },
	{ value: "s3:ListAllMyBuckets", label: "ListBuckets", description: "List all buckets" },
	{ value: "s3:CreateBucket", label: "CreateBucket", description: "Create buckets" },
	{ value: "s3:DeleteBucket", label: "DeleteBucket", description: "Delete buckets" },
	{ value: "s3:HeadBucket", label: "HeadBucket", description: "Check bucket exists" },
	{ value: "s3:GetBucketLocation", label: "GetBucketLocation", description: "Get bucket region" },
	{ value: "s3:GetBucketCors", label: "GetBucketCors", description: "Read CORS config" },
	{ value: "s3:PutBucketCors", label: "PutBucketCors", description: "Write CORS config" },
	{ value: "s3:DeleteBucketCors", label: "DeleteBucketCors", description: "Delete CORS config" },
	{ value: "s3:GetLifecycleConfiguration", label: "GetLifecycle", description: "Read lifecycle rules" },
	{ value: "s3:PutLifecycleConfiguration", label: "PutLifecycle", description: "Write lifecycle rules" },
	{ value: "s3:GetEncryptionConfiguration", label: "GetEncryption", description: "Read encryption config" },
	{ value: "s3:AbortMultipartUpload", label: "AbortMultipart", description: "Abort multipart uploads" },
	{ value: "s3:ListBucketMultipartUploads", label: "ListMultipart", description: "List multipart uploads" },
	{ value: "s3:ListMultipartUploadParts", label: "ListParts", description: "List upload parts" },
] as const;

const S3_CONDITION_FIELDS = [
	{ value: "bucket", label: "Bucket", hint: "e.g. my-bucket" },
	{ value: "key", label: "Key", hint: "e.g. images/photo.jpg" },
	{ value: "key.prefix", label: "Key Prefix", hint: "e.g. uploads/" },
	{ value: "key.filename", label: "Filename", hint: "e.g. photo.jpg" },
	{ value: "key.extension", label: "Extension", hint: "e.g. jpg" },
	{ value: "content_type", label: "Content-Type", hint: "e.g. image/jpeg" },
	{ value: "content_length", label: "Content-Length", hint: "e.g. 10485760" },
	{ value: "method", label: "HTTP Method", hint: "e.g. GET" },
	{ value: "source_bucket", label: "Source Bucket", hint: "For CopyObject" },
	{ value: "source_key", label: "Source Key", hint: "For CopyObject" },
	{ value: "list_prefix", label: "List Prefix", hint: "e.g. logs/" },
] as const;

const OPERATORS = [
	{ value: "eq", label: "equals" },
	{ value: "ne", label: "not equals" },
	{ value: "contains", label: "contains" },
	{ value: "not_contains", label: "not contains" },
	{ value: "starts_with", label: "starts with" },
	{ value: "ends_with", label: "ends with" },
	{ value: "wildcard", label: "wildcard (*)" },
	{ value: "matches", label: "regex" },
	{ value: "in", label: "in (comma-sep)" },
	{ value: "exists", label: "exists" },
	{ value: "not_exists", label: "not exists" },
] as const;

const NO_VALUE_OPERATORS = new Set(["exists", "not_exists"]);

// ─── Types ──────────────────────────────────────────────────────────

interface S3PolicyBuilderProps {
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
			<Select
				value={condition.field}
				onValueChange={(v) => onChange({ ...condition, field: v })}
			>
				<SelectTrigger className="w-[140px] text-xs font-data">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{S3_CONDITION_FIELDS.map((f) => (
						<SelectItem key={f.value} value={f.value} className="text-xs">
							{f.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			<Select
				value={condition.operator}
				onValueChange={(v) => onChange({ ...condition, operator: v })}
			>
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
					placeholder={S3_CONDITION_FIELDS.find((f) => f.value === condition.field)?.hint ?? "value"}
					value={
						Array.isArray(condition.value)
							? condition.value.join(", ")
							: String(condition.value ?? "")
					}
					onChange={(e) => {
						const raw = e.target.value;
						const value = condition.operator === "in"
							? raw.split(",").map((s) => s.trim())
							: raw;
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
		if (action === "s3:*") {
			onChange({
				...statement,
				actions: current.has("s3:*") ? [] : ["s3:*"],
			});
			return;
		}
		current.delete("s3:*");
		if (current.has(action)) {
			current.delete(action);
		} else {
			current.add(action);
		}
		onChange({ ...statement, actions: Array.from(current) });
	};

	const conditions = (statement.conditions ?? []).filter(
		(c): c is LeafCondition => "field" in c,
	);

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
			conditions: [...conditions, { field: "bucket", operator: "eq", value: "" }],
		});
	};

	const isWildcard = statement.actions.includes("s3:*");
	const resourceDisplay = statement.resources[0] === "*"
		? "all resources"
		: statement.resources[0];

	return (
		<div className="rounded-lg border border-border bg-card/50 p-3 space-y-3">
			{/* ── Statement header ──────────────────────────────── */}
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => setCollapsed(!collapsed)}
					className="text-muted-foreground hover:text-foreground"
				>
					{collapsed ? (
						<ChevronRight className="h-4 w-4" />
					) : (
						<ChevronDown className="h-4 w-4" />
					)}
				</button>
				<span className={T.sectionLabel}>Statement {index + 1}</span>
				<Badge className="bg-lv-green/20 text-lv-green border-lv-green/30 text-[10px]">
					ALLOW
				</Badge>
				{collapsed && (
					<span className="text-xs text-muted-foreground ml-2">
						{isWildcard ? "s3:*" : statement.actions.join(", ")} on {resourceDisplay}
						{conditions.length > 0 && ` (${conditions.length} condition${conditions.length > 1 ? "s" : ""})`}
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
							{S3_ACTIONS.map((a) => {
								const active = isWildcard
									? a.value === "s3:*"
									: statement.actions.includes(a.value);
								return (
									<button
										key={a.value}
										type="button"
										onClick={() => toggleAction(a.value)}
										className={cn(
											"rounded-md border px-2.5 py-1 text-xs font-data transition-colors",
											active
												? "border-lv-purple/50 bg-lv-purple/20 text-lv-purple"
												: "border-border text-muted-foreground hover:border-lv-purple/30 hover:text-foreground",
										)}
										title={a.description}
									>
										{a.label}
									</button>
								);
							})}
						</div>
					</div>

					{/* ── Resources ─────────────────────────────────── */}
					<div className="space-y-2">
						<Label className={T.formLabel}>Resource</Label>
						<Input
							placeholder="e.g. bucket:my-bucket, object:my-bucket/*, *"
							value={statement.resources[0] ?? "*"}
							onChange={(e) => onChange({ ...statement, resources: [e.target.value] })}
							className="text-xs font-data"
						/>
						<p className={cn(T.muted, "italic")}>
							Use <code className="text-lv-cyan">bucket:name</code> for bucket-level,{" "}
							<code className="text-lv-cyan">object:bucket/*</code> for objects, or{" "}
							<code className="text-lv-cyan">*</code> for everything.
						</p>
					</div>

					{/* ── Conditions ────────────────────────────────── */}
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<Label className={T.formLabel}>
								Conditions {conditions.length > 0 && `(${conditions.length})`}
							</Label>
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
						{conditions.length === 0 && (
							<p className={cn(T.muted, "italic")}>
								No conditions — all matching actions are allowed.
							</p>
						)}
						{conditions.map((c, i) => (
							<ConditionRow
								key={i}
								condition={c}
								onChange={(updated) => updateCondition(i, updated)}
								onRemove={() => removeCondition(i)}
							/>
						))}
					</div>
				</>
			)}
		</div>
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
					effect: "allow",
					actions: ["s3:*"],
					resources: ["*"],
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
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="text-xs"
					onClick={addStatement}
				>
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
					{showJson ? "Hide" : "Show"} JSON
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
