// ─── Policy document schema ─────────────────────────────────────────────────
// AWS IAM-inspired policy documents attached to API keys.
// The policy engine evaluates these against a RequestContext at authorization time.

/** Top-level policy document attached to an API key. */
export interface PolicyDocument {
	version: '2025-01-01';
	statements: Statement[];
}

/**
 * A single permission statement.
 * Evaluation order: deny-first. If any deny matches → denied. Then if any allow matches → allowed. Otherwise → denied.
 */
export interface Statement {
	effect: 'allow' | 'deny';
	/** Actions this statement permits/denies, e.g. ["purge:url", "purge:host"]. Wildcard suffix supported: "purge:*". */
	actions: string[];
	/** Resources this statement applies to, e.g. ["zone:abc123"]. Wildcard suffix supported: "zone:*". */
	resources: string[];
	/** Optional conditions — all must match (AND). Omit or empty array = no conditions. */
	conditions?: Condition[];
}

// ─── Conditions ─────────────────────────────────────────────────────────────

/** A condition is either a leaf (field comparison) or a compound (any/all/not). */
export type Condition = LeafCondition | CompoundCondition;

/** Leaf condition — compares a field in the request context against a value. */
export interface LeafCondition {
	field: string;
	operator: LeafOperator;
	value: ConditionValue;
}

/** Compound condition — logical combinator wrapping other conditions. */
export type CompoundCondition = AnyCondition | AllCondition | NotCondition;

export interface AnyCondition {
	/** OR — any child must match. */
	any: Condition[];
}

export interface AllCondition {
	/** AND — all children must match. */
	all: Condition[];
}

export interface NotCondition {
	/** Negation of a single condition. */
	not: Condition;
}

/** Supported leaf operators. */
export type LeafOperator =
	| 'eq'
	| 'ne'
	| 'contains'
	| 'not_contains'
	| 'starts_with'
	| 'ends_with'
	| 'matches'
	| 'not_matches'
	| 'in'
	| 'not_in'
	| 'wildcard'
	| 'exists'
	| 'not_exists'
	| 'lt'
	| 'gt'
	| 'lte'
	| 'gte';

/** Condition values — string for most operators, string[] for in/not_in, boolean for eq/ne. */
export type ConditionValue = string | string[] | boolean;

// ─── Request context ────────────────────────────────────────────────────────
// Built by each service handler from the incoming request.

export interface RequestContext {
	/** The action being performed, e.g. "purge:url", "r2:GetObject". */
	action: string;
	/** The resource being acted on, e.g. "zone:abc123", "bucket:my-assets". */
	resource: string;
	/** Service-specific fields for condition evaluation. */
	fields: Record<string, string | boolean>;
}

// ─── Validation ─────────────────────────────────────────────────────────────

/** Maximum regex pattern length in `matches`/`not_matches` conditions. */
export const MAX_REGEX_LENGTH = 256;

/** Current policy document version. */
export const POLICY_VERSION = '2025-01-01';

// ─── Type guards ────────────────────────────────────────────────────────────

export function isLeafCondition(c: Condition): c is LeafCondition {
	return 'field' in c && 'operator' in c && !('any' in c) && !('all' in c) && !('not' in c);
}

export function isAnyCondition(c: Condition): c is AnyCondition {
	return 'any' in c;
}

export function isAllCondition(c: Condition): c is AllCondition {
	return 'all' in c;
}

export function isNotCondition(c: Condition): c is NotCondition {
	return 'not' in c;
}
