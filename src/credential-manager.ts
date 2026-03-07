/**
 * Generic base class for credential managers (API keys, S3 credentials).
 *
 * Both IamManager and S3CredentialManager share identical patterns for:
 * - In-memory cache with TTL
 * - Bulk revoke / delete / inspect operations
 * - Authorization flow (cache → check revoked → check expired → evaluate policy)
 *
 * This base class captures those patterns. Subclasses provide:
 * - Table schema and SQL queries
 * - Entity-specific fields (zone_id, secret_access_key, etc.)
 * - Key generation
 */

import { evaluatePolicy } from './policy-engine';
import { DEFAULT_CACHE_TTL_MS } from './constants';
import { POLICY_VERSION } from './policy-types';
import type { PolicyDocument, RequestContext } from './policy-types';
import type { AuthResult, BulkItemResult, BulkResult, BulkInspectItem, BulkDryRunResult } from './types';

// ─── Base entity interface ──────────────────────────────────────────────────

/** Minimum fields every managed credential must have. */
export interface BaseCredential {
	/** Revoked flag (0 = active, 1 = revoked). */
	revoked: number;
	/** Epoch ms when the credential expires, or null for no expiry. */
	expires_at: number | null;
	/** JSON-serialized PolicyDocument. */
	policy: string;
}

/** Minimum cache entry fields required by the base class. */
export interface CachedEntry {
	resolvedPolicy: PolicyDocument;
	cachedAt: number;
}

// ─── Abstract base class ────────────────────────────────────────────────────

export abstract class CredentialManager<T extends BaseCredential, TCached extends CachedEntry> {
	protected sql: SqlStorage;
	protected cache: Map<string, TCached> = new Map();
	protected cacheTtlMs: number;

	constructor(sql: SqlStorage, cacheTtlMs: number = DEFAULT_CACHE_TTL_MS) {
		this.sql = sql;
		this.cacheTtlMs = cacheTtlMs;
	}

	/** Create tables if they don't exist. Call inside blockConcurrencyWhile. */
	abstract initTables(): void;

	// ─── Revoke / delete ────────────────────────────────────────────

	/** Soft-revoke a credential by primary key. */
	protected abstract revokeById(id: string): boolean;

	/** Permanently delete a credential by primary key. */
	protected abstract deleteById(id: string): boolean;

	/** Get a single credential by primary key (wrapped in { entity } or similar). */
	protected abstract getById(id: string): { entity: T } | null;

	// ─── Bulk operations ────────────────────────────────────────────

	/** Bulk soft-revoke. Returns per-item status. */
	bulkRevoke(ids: string[]): BulkResult {
		const results: BulkItemResult[] = [];
		for (const id of ids) {
			const existing = this.getById(id);
			if (!existing) {
				results.push({ id, status: 'not_found' });
			} else if (existing.entity.revoked) {
				results.push({ id, status: 'already_revoked' });
			} else {
				this.revokeById(id);
				results.push({ id, status: 'revoked' });
			}
		}
		return { processed: results.length, results };
	}

	/** Bulk hard-delete. Returns per-item status. */
	bulkDelete(ids: string[]): BulkResult {
		const results: BulkItemResult[] = [];
		for (const id of ids) {
			const deleted = this.deleteById(id);
			results.push({ id, status: deleted ? 'deleted' : 'not_found' });
		}
		return { processed: results.length, results };
	}

	/** Inspect credentials without modifying — for dry-run preview. */
	bulkInspect(ids: string[], wouldBecome: string): BulkDryRunResult {
		const items: BulkInspectItem[] = [];
		for (const id of ids) {
			const existing = this.getById(id);
			if (!existing) {
				items.push({ id, current_status: 'not_found', would_become: 'not_found' });
			} else {
				const entity = existing.entity;
				let currentStatus: BulkInspectItem['current_status'];
				if (entity.revoked) {
					currentStatus = 'revoked';
				} else if (entity.expires_at && entity.expires_at < Date.now()) {
					currentStatus = 'expired';
				} else {
					currentStatus = 'active';
				}
				items.push({ id, current_status: currentStatus, would_become: wouldBecome });
			}
		}
		return { dry_run: true, would_process: items.length, items };
	}

	// ─── Authorization ──────────────────────────────────────────────

	/** Extract the base entity from a cached entry. */
	protected abstract getEntityFromCache(cached: TCached): T;

	/**
	 * Authorize a request against the credential's policy.
	 * Subclasses may override to add entity-specific checks (e.g. zone scoping).
	 */
	protected authorizeWithContexts(id: string, contexts: RequestContext[], formatDenied?: (ctx: RequestContext) => string): AuthResult {
		const cached = this.getCachedOrLoad(id);
		if (!cached) {
			return { authorized: false, error: this.invalidCredentialMessage() };
		}

		const entity = this.getEntityFromCache(cached);
		const { resolvedPolicy } = cached;

		if (entity.revoked) {
			return { authorized: false, error: this.revokedMessage() };
		}

		if (entity.expires_at && entity.expires_at < Date.now()) {
			return { authorized: false, error: this.expiredMessage() };
		}

		if (!evaluatePolicy(resolvedPolicy, contexts)) {
			const denied: string[] = [];
			const formatter = formatDenied ?? ((ctx: RequestContext) => `${ctx.action} on ${ctx.resource}`);
			for (const ctx of contexts) {
				if (!evaluatePolicy(resolvedPolicy, [ctx])) {
					denied.push(formatter(ctx));
				}
			}
			return {
				authorized: false,
				error: this.deniedMessage(denied),
				denied,
			};
		}

		return { authorized: true };
	}

	/** Human-readable error when credential is not found. */
	protected abstract invalidCredentialMessage(): string;
	/** Human-readable error when credential is revoked. */
	protected abstract revokedMessage(): string;
	/** Human-readable error when credential has expired. */
	protected abstract expiredMessage(): string;
	/** Human-readable error when policy denies the request. */
	protected abstract deniedMessage(denied: string[]): string;

	// ─── Cache ──────────────────────────────────────────────────────

	/**
	 * Look up a credential by ID, returning the cached version if fresh,
	 * or loading from SQL and caching it.
	 */
	protected getCachedOrLoad(id: string): TCached | null {
		const cached = this.cache.get(id);
		if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
			return cached;
		}

		const loaded = this.loadFromSql(id);
		if (!loaded) {
			this.cache.delete(id);
			return null;
		}

		let resolvedPolicy: PolicyDocument;
		try {
			resolvedPolicy = JSON.parse(loaded.policy) as PolicyDocument;
		} catch {
			// Corrupt policy JSON — deny everything
			resolvedPolicy = { version: POLICY_VERSION, statements: [] };
		}

		const entry = this.buildCacheEntry(loaded, resolvedPolicy, Date.now());
		this.cache.set(id, entry);
		return entry;
	}

	/** Load the full entity from SQL by primary key. Returns null if not found. */
	protected abstract loadFromSql(id: string): T | null;

	/** Build a typed cache entry from the loaded entity, parsed policy, and timestamp. */
	protected abstract buildCacheEntry(entity: T, resolvedPolicy: PolicyDocument, cachedAt: number): TCached;
}
