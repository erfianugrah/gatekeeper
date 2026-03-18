import { CredentialManager } from './credential-manager';
import { queryAll } from './sql';
import { MS_PER_DAY } from './constants';
import { generateHexId } from './crypto';
import { evaluatePolicy } from './policy-engine';

import type { ApiKey, CachedKey, CreateKeyRequest, AuthResult, PurgeBody } from './types';
import { POLICY_VERSION } from './policy-types';
import type { PolicyDocument, RequestContext } from './policy-types';

/** Key prefix for all keys. */
const KEY_PREFIX = 'gw_';

export class IamManager extends CredentialManager<ApiKey, CachedKey> {
	/** Create tables if they don't exist. Call inside blockConcurrencyWhile. */
	initTables(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS api_keys (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				zone_id TEXT,
				created_at INTEGER NOT NULL,
				expires_at INTEGER,
				revoked INTEGER NOT NULL DEFAULT 0,
				bulk_rate REAL,
				bulk_bucket REAL,
				single_rate REAL,
				single_bucket REAL,
				policy TEXT NOT NULL,
				created_by TEXT
			);
		`);

		// Migration: old schema had zone_id NOT NULL — migrate data safely.
		const info = queryAll<{ notnull: number }>(this.sql, `SELECT "notnull" FROM pragma_table_info('api_keys') WHERE name = 'zone_id'`);
		if (info.length > 0 && info[0].notnull === 1) {
			console.log(JSON.stringify({ migration: 'api_keys', action: 'zone_id_nullable', ts: new Date().toISOString() }));
			this.sql.exec(`ALTER TABLE api_keys RENAME TO api_keys_old`);
			this.sql.exec(`
				CREATE TABLE api_keys (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					zone_id TEXT,
					created_at INTEGER NOT NULL,
					expires_at INTEGER,
					revoked INTEGER NOT NULL DEFAULT 0,
					bulk_rate REAL,
					bulk_bucket REAL,
					single_rate REAL,
					single_bucket REAL,
					policy TEXT NOT NULL,
					created_by TEXT
				);
			`);
			this.sql.exec(`INSERT INTO api_keys SELECT * FROM api_keys_old`);
			this.sql.exec(`DROP TABLE api_keys_old`);
		}

		// Migration: add upstream_token_id column for key-to-upstream-token binding.
		const cols = queryAll<{ name: string }>(this.sql, `PRAGMA table_info('api_keys')`);
		if (!cols.some((c) => c.name === 'upstream_token_id')) {
			console.log(JSON.stringify({ migration: 'api_keys', action: 'add_column_upstream_token_id', ts: new Date().toISOString() }));
			this.sql.exec(`ALTER TABLE api_keys ADD COLUMN upstream_token_id TEXT`);
		}
	}

	// ─── Key creation ───────────────────────────────────────────────────

	/** Create a key with a policy document. */
	createKey(req: CreateKeyRequest): { key: ApiKey } {
		const id = this.generateKeyId();
		const now = Date.now();
		const expiresAt = req.expires_in_days ? now + req.expires_in_days * MS_PER_DAY : null;

		const policyJson = JSON.stringify(req.policy);

		const rl = req.rate_limit;
		const upstreamTokenId = req.upstream_token_id || null;
		this.sql.exec(
			`INSERT INTO api_keys (id, name, zone_id, created_at, expires_at, revoked, bulk_rate, bulk_bucket, single_rate, single_bucket, policy, created_by, upstream_token_id)
			 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			req.name,
			req.zone_id ?? null,
			now,
			expiresAt,
			rl?.bulk_rate ?? null,
			rl?.bulk_bucket ?? null,
			rl?.single_rate ?? null,
			rl?.single_bucket ?? null,
			policyJson,
			req.created_by ?? null,
			upstreamTokenId,
		);

		const key: ApiKey = {
			id,
			name: req.name,
			zone_id: req.zone_id ?? null,
			created_at: now,
			expires_at: expiresAt,
			revoked: 0,
			policy: policyJson,
			created_by: req.created_by ?? null,
			bulk_rate: rl?.bulk_rate ?? null,
			bulk_bucket: rl?.bulk_bucket ?? null,
			single_rate: rl?.single_rate ?? null,
			single_bucket: rl?.single_bucket ?? null,
			upstream_token_id: upstreamTokenId,
		};

		return { key };
	}

	/**
	 * Atomically rotate a key: create a new key with inherited config, then revoke the old one.
	 * Optional overrides let the caller change name or expiry on the new key.
	 */
	rotateKey(id: string, overrides?: { name?: string; expires_in_days?: number }): { oldKey: ApiKey; newKey: ApiKey } | null {
		const existing = this.getKey(id);
		if (!existing) return null;

		const oldKey = existing.key;

		// Cannot rotate a key that is already revoked or expired
		if (oldKey.revoked) return null;
		if (oldKey.expires_at && oldKey.expires_at < Date.now()) return null;

		// Parse the existing policy back into a PolicyDocument
		let policy: PolicyDocument;
		try {
			policy = JSON.parse(oldKey.policy) as PolicyDocument;
		} catch {
			return null;
		}

		// Build the create request, inheriting all config from the old key
		const req: CreateKeyRequest = {
			name: overrides?.name ?? `${oldKey.name} (rotated)`,
			zone_id: oldKey.zone_id ?? undefined,
			policy,
			created_by: oldKey.created_by ?? undefined,
			expires_in_days: overrides?.expires_in_days,
			rate_limit:
				oldKey.bulk_rate !== null || oldKey.single_rate !== null
					? {
							bulk_rate: oldKey.bulk_rate ?? undefined,
							bulk_bucket: oldKey.bulk_bucket ?? undefined,
							single_rate: oldKey.single_rate ?? undefined,
							single_bucket: oldKey.single_bucket ?? undefined,
						}
					: undefined,
			upstream_token_id: oldKey.upstream_token_id ?? null!,
		};

		const { key: newKey } = this.createKey(req);
		this.revokeKey(id);

		console.log(
			JSON.stringify({
				breadcrumb: 'iam-rotate-key',
				oldKeyId: id,
				newKeyId: newKey.id,
			}),
		);

		return { oldKey: { ...oldKey, revoked: 1 }, newKey };
	}

	/**
	 * Update mutable fields on an existing key.
	 * Supports: name, expires_at (extend only), rate limits.
	 * Policy changes are NOT allowed — create a new key for that.
	 */
	updateKey(
		id: string,
		updates: {
			name?: string;
			expires_at?: number | null;
			bulk_rate?: number | null;
			bulk_bucket?: number | null;
			single_rate?: number | null;
			single_bucket?: number | null;
		},
	): { key: ApiKey } | null {
		const existing = this.getKey(id);
		if (!existing) return null;

		const key = existing.key;

		// Cannot update revoked or expired keys
		if (key.revoked) return null;
		if (key.expires_at !== null && key.expires_at <= Date.now()) return null;

		const sets: string[] = [];
		const params: unknown[] = [];

		if (updates.name !== undefined) {
			sets.push('name = ?');
			params.push(updates.name);
		}

		if (updates.expires_at !== undefined) {
			// Enforce extend-only: new expiry must be later than current (or null to remove expiry)
			if (updates.expires_at !== null && key.expires_at !== null && updates.expires_at <= key.expires_at) {
				throw new Error('expires_at can only be extended, not shortened');
			}
			sets.push('expires_at = ?');
			params.push(updates.expires_at);
		}

		if (updates.bulk_rate !== undefined) {
			sets.push('bulk_rate = ?');
			params.push(updates.bulk_rate);
		}
		if (updates.bulk_bucket !== undefined) {
			sets.push('bulk_bucket = ?');
			params.push(updates.bulk_bucket);
		}
		if (updates.single_rate !== undefined) {
			sets.push('single_rate = ?');
			params.push(updates.single_rate);
		}
		if (updates.single_bucket !== undefined) {
			sets.push('single_bucket = ?');
			params.push(updates.single_bucket);
		}

		if (sets.length === 0) return existing;

		params.push(id);
		this.sql.exec(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`, ...params);
		this.cache.delete(id);

		console.log(
			JSON.stringify({
				breadcrumb: 'iam-update-key',
				keyId: id,
				updatedFields: Object.keys(updates).filter((k) => (updates as Record<string, unknown>)[k] !== undefined),
			}),
		);

		return this.getKey(id);
	}

	// ─── Key queries ────────────────────────────────────────────────────

	/** List keys. zoneId filters by zone. Optional status filter. */
	listKeys(zoneId?: string, filter?: 'active' | 'revoked'): ApiKey[] {
		const conditions: string[] = [];
		const params: unknown[] = [];

		if (zoneId) {
			conditions.push('zone_id = ?');
			params.push(zoneId);
		}

		if (filter === 'active') {
			conditions.push('revoked = 0');
			conditions.push('(expires_at IS NULL OR expires_at > ?)');
			params.push(Date.now());
		} else if (filter === 'revoked') {
			conditions.push('revoked = 1');
		}

		const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
		return queryAll<ApiKey>(this.sql, `SELECT * FROM api_keys${where} ORDER BY created_at DESC`, ...params);
	}

	/** Count active (non-revoked) keys bound to a given upstream token. */
	countKeysByUpstreamToken(upstreamTokenId: string): number {
		const rows = queryAll<{ cnt: number }>(
			this.sql,
			'SELECT COUNT(*) as cnt FROM api_keys WHERE upstream_token_id = ? AND revoked = 0',
			upstreamTokenId,
		);
		return rows.length > 0 ? rows[0].cnt : 0;
	}

	/** Get a single key. */
	getKey(id: string): { key: ApiKey } | null {
		const rows = queryAll<ApiKey>(this.sql, 'SELECT * FROM api_keys WHERE id = ?', id);
		if (rows.length === 0) return null;
		return { key: rows[0] };
	}

	/** Soft-revoke a key. */
	revokeKey(id: string): boolean {
		return this.revokeById(id);
	}

	/** Permanently delete a key. Returns true if the row existed and was removed. */
	deleteKey(id: string): boolean {
		return this.deleteById(id);
	}

	/** Revoke all non-revoked keys that have expired. Returns the count of revoked keys. */
	revokeExpired(): number {
		const now = Date.now();
		const result = this.sql.exec('UPDATE api_keys SET revoked = 1 WHERE revoked = 0 AND expires_at IS NOT NULL AND expires_at <= ?', now);
		if (result.rowsWritten > 0) {
			this.cache.clear();
		}
		return result.rowsWritten;
	}

	// ─── Authorization ──────────────────────────────────────────────────

	/** Evaluate the key's policy against request contexts. */
	authorize(keyId: string, zoneId: string, contexts: RequestContext[]): AuthResult {
		// Zone-scoping check is IamManager-specific — must happen before generic auth
		const cached = this.getCachedOrLoad(keyId);
		if (!cached) {
			console.log(JSON.stringify({ breadcrumb: 'iam-authorize-not-found', keyId }));
			return { authorized: false, error: 'Invalid API key' };
		}

		const key = cached.key;

		if (key.revoked) {
			console.log(JSON.stringify({ breadcrumb: 'iam-authorize-revoked', keyId }));
			return { authorized: false, error: 'API key has been revoked' };
		}

		if (key.expires_at && key.expires_at < Date.now()) {
			console.log(JSON.stringify({ breadcrumb: 'iam-authorize-expired', keyId, expiresAt: key.expires_at }));
			return { authorized: false, error: 'API key has expired' };
		}

		// If the key is scoped to a specific zone, enforce it
		if (key.zone_id && key.zone_id !== zoneId) {
			console.log(JSON.stringify({ breadcrumb: 'iam-authorize-zone-mismatch', keyId, keyZone: key.zone_id, requestZone: zoneId }));
			return { authorized: false, error: 'API key is not authorized for this zone' };
		}

		if (!evaluatePolicy(cached.resolvedPolicy, contexts)) {
			const denied: string[] = [];
			for (const ctx of contexts) {
				if (!evaluatePolicy(cached.resolvedPolicy, [ctx])) {
					denied.push(formatDeniedContext(ctx));
				}
			}
			console.log(JSON.stringify({ breadcrumb: 'iam-authorize-policy-denied', keyId, zoneId, denied }));
			return {
				authorized: false,
				error: `Key does not have scope for: ${denied.join(', ')}`,
				denied,
			};
		}

		console.log(JSON.stringify({ breadcrumb: 'iam-authorize-ok', keyId, zoneId, actions: contexts.map((c) => c.action) }));
		return { authorized: true, keyName: key.name, upstreamTokenId: key.upstream_token_id ?? undefined };
	}

	/**
	 * Convenience: authorize from a PurgeBody (converts to RequestContext[] internally).
	 * Optional requestFields are merged into every context (e.g. client_ip, client_country).
	 */
	authorizeFromBody(keyId: string, zoneId: string, body: PurgeBody, requestFields?: Record<string, string>): AuthResult {
		const contexts = purgeBodyToContexts(body, zoneId, requestFields);
		return this.authorize(keyId, zoneId, contexts);
	}

	// ─── Protected overrides ────────────────────────────────────────────

	protected revokeById(id: string): boolean {
		const result = this.sql.exec('UPDATE api_keys SET revoked = 1 WHERE id = ? AND revoked = 0', id);
		this.cache.delete(id);
		return result.rowsWritten > 0;
	}

	protected deleteById(id: string): boolean {
		const result = this.sql.exec('DELETE FROM api_keys WHERE id = ?', id);
		this.cache.delete(id);
		return result.rowsWritten > 0;
	}

	protected getById(id: string): { entity: ApiKey } | null {
		const result = this.getKey(id);
		return result ? { entity: result.key } : null;
	}

	protected loadFromSql(id: string): ApiKey | null {
		const rows = queryAll<ApiKey>(this.sql, 'SELECT * FROM api_keys WHERE id = ?', id);
		return rows.length > 0 ? rows[0] : null;
	}

	protected getEntityFromCache(cached: CachedKey): ApiKey {
		return cached.key;
	}

	protected buildCacheEntry(entity: ApiKey, resolvedPolicy: PolicyDocument, cachedAt: number): CachedKey {
		return { key: entity, resolvedPolicy, cachedAt };
	}

	protected invalidCredentialMessage(): string {
		return 'Invalid API key';
	}
	protected revokedMessage(): string {
		return 'API key has been revoked';
	}
	protected expiredMessage(): string {
		return 'API key has expired';
	}
	protected deniedMessage(denied: string[]): string {
		return `Key does not have scope for: ${denied.join(', ')}`;
	}

	private generateKeyId(): string {
		return generateHexId(KEY_PREFIX, 16);
	}
}

/**
 * Format a denied RequestContext into a human-readable string.
 */
function formatDeniedContext(ctx: RequestContext): string {
	switch (ctx.action) {
		case 'purge:url':
			return typeof ctx.fields.url === 'string' ? ctx.fields.url : 'unknown-url';
		case 'purge:host':
			return `host:${ctx.fields.host ?? 'unknown'}`;
		case 'purge:tag':
			return `tag:${ctx.fields.tag ?? 'unknown'}`;
		case 'purge:prefix':
			return `prefix:${ctx.fields.prefix ?? 'unknown'}`;
		case 'purge:everything':
			return 'purge_everything';
		default:
			return `${ctx.action}:${ctx.resource}`;
	}
}

// ─── Purge body → RequestContext conversion ─────────────────────────────────

export function purgeBodyToContexts(body: PurgeBody, zoneId: string, requestFields?: Record<string, string>): RequestContext[] {
	const resource = `zone:${zoneId}`;
	const contexts: RequestContext[] = [];
	const extra: Record<string, string> = requestFields ?? {};

	if (body.purge_everything) {
		contexts.push({
			action: 'purge:everything',
			resource,
			fields: { ...extra, purge_everything: true },
		});
		return contexts;
	}

	if (body.files) {
		for (const file of body.files) {
			const url = typeof file === 'string' ? file : file.url;
			const headers = typeof file === 'object' && file.headers ? file.headers : {};

			const fields: Record<string, string | boolean> = { ...extra, url };

			try {
				const parsed = new URL(url);
				fields.host = parsed.hostname;
				fields['url.path'] = parsed.pathname;
				if (parsed.search) {
					fields['url.query'] = parsed.search.slice(1);
					for (const [k, v] of parsed.searchParams) {
						fields[`url.query.${k}`] = v;
					}
				}
			} catch {
				// Invalid URL — still include raw url field
			}

			for (const [name, value] of Object.entries(headers)) {
				fields[`header.${name}`] = value;
			}

			contexts.push({ action: 'purge:url', resource, fields });
		}
	}

	if (body.hosts) {
		for (const host of body.hosts) {
			contexts.push({ action: 'purge:host', resource, fields: { ...extra, host } });
		}
	}

	if (body.tags) {
		for (const tag of body.tags) {
			contexts.push({ action: 'purge:tag', resource, fields: { ...extra, tag } });
		}
	}

	if (body.prefixes) {
		for (const prefix of body.prefixes) {
			contexts.push({ action: 'purge:prefix', resource, fields: { ...extra, prefix } });
		}
	}

	return contexts;
}
