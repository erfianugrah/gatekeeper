import type { PolicyDocument, Statement, Condition, LeafCondition, RequestContext, ConditionValue } from './policy-types';
import { isLeafCondition, isAnyCondition, isAllCondition, isNotCondition, MAX_REGEX_LENGTH, POLICY_VERSION } from './policy-types';

// ─── Policy evaluation ──────────────────────────────────────────────────────

/**
 * Evaluate a policy document against one or more request contexts.
 * Returns true if ALL contexts are allowed by the policy.
 * Each context must be allowed by at least one statement.
 */
export function evaluatePolicy(policy: PolicyDocument, contexts: RequestContext[]): boolean {
	for (const ctx of contexts) {
		if (!evaluatePolicyForContext(policy, ctx)) {
			return false;
		}
	}
	return true;
}

/**
 * Evaluate a policy against a single request context.
 * Deny-first: if any deny statement matches → denied.
 * Then if any allow statement matches → allowed.
 * Otherwise → denied (implicit deny).
 */
function evaluatePolicyForContext(policy: PolicyDocument, ctx: RequestContext): boolean {
	let allowed = false;
	for (const stmt of policy.statements) {
		if (matchesStatement(stmt, ctx)) {
			if (stmt.effect === 'deny') return false;
			allowed = true;
		}
	}
	return allowed;
}

/**
 * Check if a statement's action, resource, and conditions all match a request context.
 * Does NOT check effect — caller must handle allow/deny logic.
 */
function matchesStatement(stmt: Statement, ctx: RequestContext): boolean {
	if (!matchesAction(stmt.actions, ctx.action)) return false;
	if (!matchesResource(stmt.resources, ctx.resource)) return false;
	if (stmt.conditions && stmt.conditions.length > 0) {
		// Conditions within a statement are AND'd
		for (const cond of stmt.conditions) {
			if (!evaluateCondition(cond, ctx.fields)) return false;
		}
	}
	return true;
}

// ─── Action matching ────────────────────────────────────────────────────────

/**
 * Check if the requested action matches any of the statement's action patterns.
 * Supports exact match and wildcard suffix (e.g., "purge:*" matches "purge:url").
 */
function matchesAction(patterns: string[], action: string): boolean {
	for (const pattern of patterns) {
		if (pattern === '*' || pattern === action) return true;
		if (pattern.endsWith(':*')) {
			const prefix = pattern.slice(0, -1); // "purge:" from "purge:*"
			if (action.startsWith(prefix)) return true;
		}
	}
	return false;
}

// ─── Resource matching ──────────────────────────────────────────────────────

/**
 * Check if the targeted resource matches any of the statement's resource patterns.
 * Supports exact match and wildcard patterns:
 * - "*" matches everything
 * - "zone:*" matches any zone
 * - "bucket:prod-*" matches "bucket:prod-images"
 */
function matchesResource(patterns: string[], resource: string): boolean {
	for (const pattern of patterns) {
		if (pattern === '*' || pattern === resource) return true;
		if (pattern.endsWith('*')) {
			const prefix = pattern.slice(0, -1);
			if (resource.startsWith(prefix)) return true;
		}
	}
	return false;
}

// ─── Condition evaluation ───────────────────────────────────────────────────

/** Maximum nesting depth for compound conditions (any/all/not). */
const MAX_CONDITION_DEPTH = 20;

/**
 * Evaluate a condition (leaf or compound) against request fields.
 */
function evaluateCondition(cond: Condition, fields: Record<string, string | boolean>, depth = 0): boolean {
	if (depth > MAX_CONDITION_DEPTH) {
		console.log(JSON.stringify({ breadcrumb: 'policy-condition-depth-exceeded', depth }));
		return false;
	}
	if (isLeafCondition(cond)) return evaluateLeaf(cond, fields);
	if (isAnyCondition(cond)) return cond.any.some((c) => evaluateCondition(c, fields, depth + 1));
	if (isAllCondition(cond)) return cond.all.every((c) => evaluateCondition(c, fields, depth + 1));
	if (isNotCondition(cond)) return !evaluateCondition(cond.not, fields, depth + 1);
	return false;
}

/**
 * Evaluate a leaf condition against request fields.
 */
function evaluateLeaf(cond: LeafCondition, fields: Record<string, string | boolean>): boolean {
	const fieldValue = fields[cond.field];

	// exists/not_exists don't need a field value
	if (cond.operator === 'exists') return fieldValue !== undefined && fieldValue !== null;
	if (cond.operator === 'not_exists') return fieldValue === undefined || fieldValue === null;

	// For all other operators, if the field doesn't exist, the condition fails
	if (fieldValue === undefined || fieldValue === null) return false;

	switch (cond.operator) {
		case 'eq':
			return fieldValue === cond.value;
		case 'ne':
			return fieldValue !== cond.value;
		case 'contains':
			return typeof fieldValue === 'string' && typeof cond.value === 'string' && fieldValue.includes(cond.value);
		case 'not_contains':
			return typeof fieldValue === 'string' && typeof cond.value === 'string' && !fieldValue.includes(cond.value);
		case 'starts_with':
			return typeof fieldValue === 'string' && typeof cond.value === 'string' && fieldValue.startsWith(cond.value);
		case 'ends_with':
			return typeof fieldValue === 'string' && typeof cond.value === 'string' && fieldValue.endsWith(cond.value);
		case 'matches':
			return evalRegex(fieldValue, cond.value, false);
		case 'not_matches':
			return evalRegex(fieldValue, cond.value, true);
		case 'in':
			return Array.isArray(cond.value) && cond.value.includes(String(fieldValue));
		case 'not_in':
			return Array.isArray(cond.value) && !cond.value.includes(String(fieldValue));
		case 'wildcard':
			return typeof fieldValue === 'string' && typeof cond.value === 'string' && evalWildcard(fieldValue, cond.value);
		case 'lt':
			return evalNumeric(fieldValue, cond.value, (a, b) => a < b);
		case 'gt':
			return evalNumeric(fieldValue, cond.value, (a, b) => a > b);
		case 'lte':
			return evalNumeric(fieldValue, cond.value, (a, b) => a <= b);
		case 'gte':
			return evalNumeric(fieldValue, cond.value, (a, b) => a >= b);
		default:
			return false;
	}
}

/**
 * Evaluate a numeric comparison. Coerces both sides to numbers.
 * Returns false if either side is NaN (safe default: deny).
 */
function evalNumeric(fieldValue: string | boolean, condValue: ConditionValue, cmp: (a: number, b: number) => boolean): boolean {
	const a = Number(fieldValue);
	const b = Number(condValue);
	if (Number.isNaN(a) || Number.isNaN(b)) return false;
	return cmp(a, b);
}

/**
 * Evaluate a regex match. Returns the match result, optionally negated.
 */
function evalRegex(fieldValue: string | boolean, pattern: ConditionValue, negate: boolean): boolean {
	if (typeof fieldValue !== 'string' || typeof pattern !== 'string') return false;
	try {
		const re = new RegExp(pattern);
		const result = re.test(fieldValue);
		return negate ? !result : result;
	} catch {
		// Invalid regex — condition fails (should have been caught at validation time)
		console.log(JSON.stringify({ breadcrumb: 'policy-invalid-regex', pattern }));
		return false;
	}
}

/**
 * Glob-style wildcard matching. `*` matches any sequence of characters.
 * Case-insensitive — all wildcard comparisons ignore case by design.
 * This affects action, resource, and condition value matching.
 */
function evalWildcard(value: string, pattern: string): boolean {
	// Convert glob to regex: escape all regex chars except *, then replace * with .*
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
	try {
		return new RegExp(`^${escaped}$`, 'i').test(value);
	} catch {
		return false;
	}
}

// ─── Policy validation ──────────────────────────────────────────────────────
// Validate a policy document at key creation time — catch errors early.

/** Validation error with path to the problematic element. */
export interface PolicyValidationError {
	path: string;
	message: string;
}

/**
 * Validate a policy document. Returns an array of errors (empty = valid).
 * Call this at key creation time, not at request time.
 */
export function validatePolicy(policy: unknown): PolicyValidationError[] {
	const errors: PolicyValidationError[] = [];

	if (!policy || typeof policy !== 'object') {
		errors.push({ path: '', message: 'Policy must be a non-null object' });
		return errors;
	}

	const doc = policy as Record<string, unknown>;

	if (doc.version !== POLICY_VERSION) {
		errors.push({ path: 'version', message: `version must be "${POLICY_VERSION}"` });
	}

	if (!Array.isArray(doc.statements) || doc.statements.length === 0) {
		errors.push({ path: 'statements', message: 'statements must be a non-empty array' });
		return errors;
	}

	for (let i = 0; i < doc.statements.length; i++) {
		validateStatement(doc.statements[i], `statements[${i}]`, errors);
	}

	return errors;
}

function validateStatement(stmt: unknown, path: string, errors: PolicyValidationError[]): void {
	if (!stmt || typeof stmt !== 'object') {
		errors.push({ path, message: 'Statement must be a non-null object' });
		return;
	}

	const s = stmt as Record<string, unknown>;

	if (s.effect !== 'allow' && s.effect !== 'deny') {
		errors.push({ path: `${path}.effect`, message: 'effect must be "allow" or "deny"' });
	}

	if (!Array.isArray(s.actions) || s.actions.length === 0) {
		errors.push({ path: `${path}.actions`, message: 'actions must be a non-empty string array' });
	} else {
		for (let i = 0; i < s.actions.length; i++) {
			if (typeof s.actions[i] !== 'string' || s.actions[i].length === 0) {
				errors.push({ path: `${path}.actions[${i}]`, message: 'Each action must be a non-empty string' });
			}
		}
	}

	if (!Array.isArray(s.resources) || s.resources.length === 0) {
		errors.push({ path: `${path}.resources`, message: 'resources must be a non-empty string array' });
	} else {
		for (let i = 0; i < s.resources.length; i++) {
			if (typeof s.resources[i] !== 'string' || s.resources[i].length === 0) {
				errors.push({ path: `${path}.resources[${i}]`, message: 'Each resource must be a non-empty string' });
			}
		}
	}

	if (s.conditions !== undefined) {
		if (!Array.isArray(s.conditions)) {
			errors.push({ path: `${path}.conditions`, message: 'conditions must be an array' });
		} else {
			for (let i = 0; i < s.conditions.length; i++) {
				validateCondition(s.conditions[i], `${path}.conditions[${i}]`, errors);
			}
		}
	}
}

const VALID_OPERATORS = new Set<string>([
	'eq',
	'ne',
	'contains',
	'not_contains',
	'starts_with',
	'ends_with',
	'matches',
	'not_matches',
	'in',
	'not_in',
	'wildcard',
	'exists',
	'not_exists',
	'lt',
	'gt',
	'lte',
	'gte',
]);

/** Patterns known to cause catastrophic backtracking. */
const DANGEROUS_REGEX = /(\([^)]*[+*][^)]*\))[+*]|\(\?[<=!]/;

/**
 * Additional ReDoS heuristics — catch nested quantifiers and overlapping alternations
 * that DANGEROUS_REGEX misses.
 */
const NESTED_QUANTIFIER = /[+*?]\{?\d*,?\d*\}?\s*[+*?]/;

/** Probe string for runtime ReDoS detection — crafted to trigger backtracking. */
const REDOS_PROBE = 'a'.repeat(32) + '!';

/** Max time (ms) for a regex probe test. Patterns exceeding this are rejected. */
const REGEX_PROBE_TIMEOUT_MS = 5;

/**
 * Test a regex pattern against an adversarial input to detect slow backtracking at validation time.
 * Returns true if the pattern is safe (fast), false if it exceeds the time budget.
 */
function probeRegex(pattern: string): boolean {
	try {
		const re = new RegExp(pattern);
		const start = performance.now();
		re.test(REDOS_PROBE);
		return performance.now() - start < REGEX_PROBE_TIMEOUT_MS;
	} catch {
		return false;
	}
}

function validateCondition(cond: unknown, path: string, errors: PolicyValidationError[], depth = 0): void {
	if (depth > MAX_CONDITION_DEPTH) {
		errors.push({ path, message: `Condition nesting exceeds maximum depth of ${MAX_CONDITION_DEPTH}` });
		return;
	}

	if (!cond || typeof cond !== 'object') {
		errors.push({ path, message: 'Condition must be a non-null object' });
		return;
	}

	const c = cond as Record<string, unknown>;

	// Compound conditions
	if ('any' in c) {
		if (!Array.isArray(c.any) || c.any.length === 0) {
			errors.push({ path: `${path}.any`, message: 'any must be a non-empty array' });
		} else {
			for (let i = 0; i < c.any.length; i++) {
				validateCondition(c.any[i], `${path}.any[${i}]`, errors, depth + 1);
			}
		}
		return;
	}

	if ('all' in c) {
		if (!Array.isArray(c.all) || c.all.length === 0) {
			errors.push({ path: `${path}.all`, message: 'all must be a non-empty array' });
		} else {
			for (let i = 0; i < c.all.length; i++) {
				validateCondition(c.all[i], `${path}.all[${i}]`, errors, depth + 1);
			}
		}
		return;
	}

	if ('not' in c) {
		if (!c.not || typeof c.not !== 'object') {
			errors.push({ path: `${path}.not`, message: 'not must be a non-null condition object' });
		} else {
			validateCondition(c.not, `${path}.not`, errors, depth + 1);
		}
		return;
	}

	// Leaf condition
	if (typeof c.field !== 'string' || c.field.length === 0) {
		errors.push({ path: `${path}.field`, message: 'field must be a non-empty string' });
	}

	if (typeof c.operator !== 'string' || !VALID_OPERATORS.has(c.operator)) {
		errors.push({ path: `${path}.operator`, message: `operator must be one of: ${[...VALID_OPERATORS].join(', ')}` });
	}

	// Validate value based on operator
	const op = c.operator as string;

	if (op === 'exists' || op === 'not_exists') {
		// No value needed for exists/not_exists
		return;
	}

	if (op === 'in' || op === 'not_in') {
		if (!Array.isArray(c.value) || c.value.length === 0) {
			errors.push({ path: `${path}.value`, message: `${op} requires a non-empty string array value` });
		} else {
			for (let i = 0; i < c.value.length; i++) {
				if (typeof c.value[i] !== 'string') {
					errors.push({ path: `${path}.value[${i}]`, message: 'Each value in the array must be a string' });
				}
			}
		}
		return;
	}

	if (op === 'eq' || op === 'ne') {
		if (typeof c.value !== 'string' && typeof c.value !== 'boolean') {
			errors.push({ path: `${path}.value`, message: `${op} requires a string or boolean value` });
		}
		return;
	}

	if (op === 'lt' || op === 'gt' || op === 'lte' || op === 'gte') {
		if (typeof c.value !== 'string' || Number.isNaN(Number(c.value))) {
			errors.push({ path: `${path}.value`, message: `${op} requires a numeric string value (e.g. "100")` });
		}
		return;
	}

	// String operators
	if (typeof c.value !== 'string') {
		errors.push({ path: `${path}.value`, message: `${op} requires a string value` });
		return;
	}

	// Regex-specific validation
	if (op === 'matches' || op === 'not_matches') {
		const pattern = c.value as string;
		if (pattern.length > MAX_REGEX_LENGTH) {
			errors.push({ path: `${path}.value`, message: `Regex pattern exceeds max length of ${MAX_REGEX_LENGTH} characters` });
			return; // Skip further checks — already too long
		}
		if (DANGEROUS_REGEX.test(pattern)) {
			errors.push({ path: `${path}.value`, message: 'Regex pattern contains potentially catastrophic backtracking constructs' });
			return;
		}
		if (NESTED_QUANTIFIER.test(pattern)) {
			errors.push({ path: `${path}.value`, message: 'Regex pattern contains nested quantifiers that may cause excessive backtracking' });
			return;
		}
		try {
			new RegExp(pattern);
		} catch (e: any) {
			errors.push({ path: `${path}.value`, message: `Invalid regex: ${e.message}` });
			return;
		}
		// Runtime probe — catch patterns that bypass static checks
		if (!probeRegex(pattern)) {
			errors.push({ path: `${path}.value`, message: 'Regex pattern is too slow — possible ReDoS' });
		}
	}
}
