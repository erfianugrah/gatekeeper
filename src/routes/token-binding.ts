/**
 * Token binding validation for key/credential creation.
 *
 * Enforces the core invariant: every API key must be bound to exactly one
 * upstream token, and the key's policy (actions + resources) must be
 * compatible with that token's scope.
 *
 * Rules:
 *   - Zone-scoped token  -> only purge:* and dns:* actions; resources must be zone:<id>
 *   - Account-scoped token -> only d1:*, kv:*, workers:*, queues:*, vectorize:*, hyperdrive:* actions;
 *                             resources must be account:<id> or account:<id>/...
 *   - No resources: ["*"] — always force explicit scoping
 */

import type { Gatekeeper } from '../durable-object';
import type { PolicyDocument } from '../policy-types';
import type { UpstreamToken, UpstreamTokenScopeType } from '../upstream-tokens';

// ─── Action prefix sets by token scope ──────────────────────────────────────

const ZONE_ACTION_PREFIXES = ['purge:', 'dns:'];
const ACCOUNT_ACTION_PREFIXES = ['d1:', 'kv:', 'workers:', 'queues:', 'vectorize:', 'hyperdrive:'];
const SUPABASE_ACTION_PREFIXES = ['supabase:'];

// ─── Public validation entry point ──────────────────────────────────────────

export interface TokenBindingResult {
	valid: boolean;
	errors: string[];
}

/**
 * Validate that a policy's actions and resources are compatible with the
 * upstream token it's being bound to.
 *
 * Returns { valid: true, errors: [] } on success, or { valid: false, errors: [...] }
 * with human-readable error messages on failure.
 */
export async function validateTokenBinding(
	stub: DurableObjectStub<Gatekeeper>,
	upstreamTokenId: string,
	policy: PolicyDocument,
): Promise<TokenBindingResult> {
	const errors: string[] = [];

	// 1. Resolve the upstream token metadata
	const tokenResult = await stub.getUpstreamToken(upstreamTokenId);
	if (!tokenResult) {
		return { valid: false, errors: [`Upstream token '${upstreamTokenId}' not found`] };
	}

	const token = tokenResult.token;
	const scopeType = token.scope_type; // 'zone' | 'account'
	const scopeIds = token.zone_ids.split(',').map((s) => s.trim());

	// 2. Validate each statement's actions and resources
	for (let i = 0; i < policy.statements.length; i++) {
		const stmt = policy.statements[i];
		const prefix = `statements[${i}]`;

		// 2a. Validate actions match token scope type
		validateActions(stmt.actions, scopeType, prefix, errors);

		// 2b. Reject bare wildcard resources
		for (const resource of stmt.resources) {
			if (resource === '*') {
				errors.push(`${prefix}.resources: wildcard '*' is not allowed — use explicit scoping (e.g. 'zone:<id>' or 'account:<id>')`);
			}
		}

		// 2c. Validate resources match token scope
		validateResources(stmt.resources, scopeType, scopeIds, prefix, errors);
	}

	return { valid: errors.length === 0, errors };
}

// ─── Action validation ──────────────────────────────────────────────────────

const SCOPE_LABELS: Record<UpstreamTokenScopeType, string> = {
	zone: 'zone-scoped',
	account: 'account-scoped',
	supabase: 'supabase',
	supabase_metrics: 'supabase-metrics',
};

function allowedActionPrefixes(scopeType: UpstreamTokenScopeType): string[] {
	switch (scopeType) {
		case 'zone':
			return ZONE_ACTION_PREFIXES;
		case 'account':
			return ACCOUNT_ACTION_PREFIXES;
		case 'supabase':
		case 'supabase_metrics':
			return SUPABASE_ACTION_PREFIXES;
	}
}

function validateActions(actions: string[], scopeType: UpstreamTokenScopeType, prefix: string, errors: string[]): void {
	const allowedPrefixes = allowedActionPrefixes(scopeType);
	const scopeLabel = SCOPE_LABELS[scopeType];

	for (const action of actions) {
		const matchesScope = allowedPrefixes.some((p) => action.startsWith(p));
		if (!matchesScope) {
			errors.push(
				`${prefix}.actions: '${action}' is not valid for a ${scopeLabel} token (allowed prefixes: ${allowedPrefixes.join(', ')})`,
			);
		}
	}
}

// ─── Resource validation ────────────────────────────────────────────────────

function validateResources(
	resources: string[],
	scopeType: UpstreamTokenScopeType,
	scopeIds: string[],
	prefix: string,
	errors: string[],
): void {
	switch (scopeType) {
		case 'zone':
			validateZoneResources(resources, scopeIds, prefix, errors);
			return;
		case 'account':
			validateAccountResources(resources, scopeIds, prefix, errors);
			return;
		case 'supabase':
		case 'supabase_metrics':
			validateSupabaseResources(resources, scopeIds, prefix, errors);
			return;
	}
}

/**
 * Supabase-scoped token: resources must be project:<ref>, org:<slug>, branch:<id>, or supabase:account.
 * For project:<ref> resources, the ref must be covered by the token's stored refs (zone_ids) unless
 * the token is wildcard (zone_ids: ["*"]).
 */
function validateSupabaseResources(resources: string[], scopeIds: string[], prefix: string, errors: string[]): void {
	const isWildcard = scopeIds.length === 1 && scopeIds[0] === '*';
	const allowedPrefixes = ['project:', 'org:', 'branch:'];

	for (const resource of resources) {
		if (resource === '*') continue; // already reported above
		if (resource === 'supabase:account') {
			// Account-wide endpoints (list ALL projects/orgs) are broader than project:* — so, like
			// project:*, they may only be granted on a token that covers all projects. Otherwise a
			// token declared for specific refs could mint a key that enumerates the whole account.
			if (!isWildcard) {
				errors.push(
					`${prefix}.resources: 'supabase:account' is only allowed when the upstream token covers all projects (zone_ids: ["*"])`,
				);
			}
			continue;
		}

		const matchedPrefix = allowedPrefixes.find((p) => resource.startsWith(p));
		if (!matchedPrefix) {
			errors.push(
				`${prefix}.resources: '${resource}' must be 'project:<ref>', 'org:<slug>', 'branch:<id>', or 'supabase:account' for a Supabase token`,
			);
			continue;
		}

		// Only project:<ref> is constrained by the token's ref coverage.
		if (matchedPrefix === 'project:') {
			const ref = resource.slice('project:'.length);
			if (ref === '*') {
				if (!isWildcard) {
					errors.push(`${prefix}.resources: 'project:*' is only allowed when the upstream token covers all projects (zone_ids: ["*"])`);
				}
				continue;
			}
			if (!isWildcard && !scopeIds.includes(ref)) {
				errors.push(`${prefix}.resources: project '${ref}' is not covered by the upstream token (allowed: ${scopeIds.join(', ')})`);
			}
		}
	}
}

/**
 * Zone-scoped token: resources must be zone:<id>.
 * If token has specific zone_ids, the resource zone ID must be in that set.
 * If token has "*", any zone:<hex32> is fine.
 */
function validateZoneResources(resources: string[], scopeIds: string[], prefix: string, errors: string[]): void {
	const isWildcard = scopeIds.length === 1 && scopeIds[0] === '*';

	for (const resource of resources) {
		if (resource === '*') continue; // Already reported above

		if (!resource.startsWith('zone:')) {
			errors.push(`${prefix}.resources: '${resource}' must start with 'zone:' for a zone-scoped token`);
			continue;
		}

		const zoneId = resource.slice('zone:'.length);

		// zone:* is allowed when token has wildcard scope
		if (zoneId === '*') {
			if (!isWildcard) {
				errors.push(`${prefix}.resources: 'zone:*' is only allowed when the upstream token covers all zones (zone_ids: ["*"])`);
			}
			continue;
		}

		// Specific zone ID must be in the token's zone_ids (or token is wildcard)
		if (!isWildcard && !scopeIds.includes(zoneId)) {
			errors.push(`${prefix}.resources: zone '${zoneId}' is not covered by the upstream token (allowed: ${scopeIds.join(', ')})`);
		}
	}
}

/**
 * Account-scoped token: resources must be account:<id> or account:<id>/service/instance.
 * The account ID in the resource must match the token's account ID (stored in zone_ids).
 */
function validateAccountResources(resources: string[], scopeIds: string[], prefix: string, errors: string[]): void {
	// For account-scoped tokens, zone_ids stores the account ID
	const accountId = scopeIds[0];

	for (const resource of resources) {
		if (resource === '*') continue; // Already reported above

		if (!resource.startsWith('account:')) {
			errors.push(`${prefix}.resources: '${resource}' must start with 'account:' for an account-scoped token`);
			continue;
		}

		const rest = resource.slice('account:'.length);
		// rest is either <account-id> or <account-id>/service/instance
		const resourceAccountId = rest.split('/')[0];

		if (resourceAccountId === '*') {
			// account:* — only allowed if this is truly a wildcard token scope (unlikely for account tokens, but be consistent)
			if (accountId !== '*') {
				errors.push(`${prefix}.resources: 'account:*' is only allowed when the upstream token covers all accounts`);
			}
			continue;
		}

		if (resourceAccountId !== accountId) {
			errors.push(`${prefix}.resources: account '${resourceAccountId}' does not match the upstream token's account '${accountId}'`);
		}
	}
}
