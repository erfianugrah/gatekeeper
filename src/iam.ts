import type {
	ApiKey,
	KeyScope,
	CachedKey,
	CreateKeyRequest,
	CreateKeyRequestV2,
	AuthResult,
	PurgeBody,
	ScopeType,
} from './types';
import type { PolicyDocument, RequestContext } from './policy-types';
import { evaluatePolicy, migrateV1Scopes } from './policy-engine';

/**
 * IAM key management backed by DO SQLite storage.
 * Supports both v1 (scopes) and v2 (policy documents) key formats.
 */
/** Type-safe helper to avoid repetitive `as unknown as T[]` on every query. */
function queryAll<T>(sql: SqlStorage, query: string, ...params: unknown[]): T[] {
	return sql.exec(query, ...params).toArray() as unknown as T[];
}

/** Key prefix for new keys. Old pgw_ prefix still accepted. */
const KEY_PREFIX = 'gw_';

export class IamManager {
	private sql: SqlStorage;
	private cache: Map<string, CachedKey> = new Map();
	private cacheTtlMs: number;

	constructor(sql: SqlStorage, cacheTtlMs: number = 60_000) {
		this.sql = sql;
		this.cacheTtlMs = cacheTtlMs;
	}

	/** Create tables if they don't exist. Call inside blockConcurrencyWhile. */
	initTables(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS api_keys (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				zone_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER,
				revoked INTEGER NOT NULL DEFAULT 0,
				bulk_rate REAL,
				bulk_bucket REAL,
				single_rate REAL,
				single_bucket REAL
			);
		`);
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS key_scopes (
				key_id TEXT NOT NULL REFERENCES api_keys(id),
				scope_type TEXT NOT NULL,
				scope_value TEXT NOT NULL,
				PRIMARY KEY (key_id, scope_type, scope_value)
			);
		`);

		// Migration: add rate limit columns if table already existed without them
		try {
			this.sql.exec('SELECT bulk_rate FROM api_keys LIMIT 0');
		} catch {
			this.sql.exec('ALTER TABLE api_keys ADD COLUMN bulk_rate REAL');
			this.sql.exec('ALTER TABLE api_keys ADD COLUMN bulk_bucket REAL');
			this.sql.exec('ALTER TABLE api_keys ADD COLUMN single_rate REAL');
			this.sql.exec('ALTER TABLE api_keys ADD COLUMN single_bucket REAL');
		}

		// Migration: add policy and created_by columns
		try {
			this.sql.exec('SELECT policy FROM api_keys LIMIT 0');
		} catch {
			this.sql.exec('ALTER TABLE api_keys ADD COLUMN policy TEXT');
			this.sql.exec('ALTER TABLE api_keys ADD COLUMN created_by TEXT');
		}
	}

	// ─── Key creation ───────────────────────────────────────────────────

	/**
	 * Create a key with v1 scopes (backward compatible).
	 * Auto-generates a v2 policy document from the scopes and stores both.
	 */
	createKey(req: CreateKeyRequest): { key: ApiKey; scopes: KeyScope[] } {
		const id = this.generateKeyId();
		const now = Date.now();
		const expiresAt = req.expires_in_days
			? now + req.expires_in_days * 86400_000
			: null;

		// Auto-migrate scopes to a policy document
		const policy = migrateV1Scopes(req.scopes, req.zone_id);
		const policyJson = JSON.stringify(policy);

		const rl = req.rate_limit;
		this.sql.exec(
			`INSERT INTO api_keys (id, name, zone_id, created_at, expires_at, revoked, bulk_rate, bulk_bucket, single_rate, single_bucket, policy, created_by)
			 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL)`,
			id,
			req.name,
			req.zone_id,
			now,
			expiresAt,
			rl?.bulk_rate ?? null,
			rl?.bulk_bucket ?? null,
			rl?.single_rate ?? null,
			rl?.single_bucket ?? null,
			policyJson,
		);

		const scopes: KeyScope[] = [];
		for (const s of req.scopes) {
			this.sql.exec(
				`INSERT INTO key_scopes (key_id, scope_type, scope_value)
				 VALUES (?, ?, ?)`,
				id,
				s.scope_type,
				s.scope_value,
			);
			scopes.push({ key_id: id, scope_type: s.scope_type as ScopeType, scope_value: s.scope_value });
		}

		const key: ApiKey = {
			id,
			name: req.name,
			zone_id: req.zone_id,
			created_at: now,
			expires_at: expiresAt,
			revoked: 0,
			policy: policyJson,
			created_by: null,
			bulk_rate: rl?.bulk_rate ?? null,
			bulk_bucket: rl?.bulk_bucket ?? null,
			single_rate: rl?.single_rate ?? null,
			single_bucket: rl?.single_bucket ?? null,
		};

		return { key, scopes };
	}

	/**
	 * Create a key with a v2 policy document.
	 * Scopes are not stored — only the policy column is used.
	 */
	createKeyV2(req: CreateKeyRequestV2): { key: ApiKey } {
		const id = this.generateKeyId();
		const now = Date.now();
		const expiresAt = req.expires_in_days
			? now + req.expires_in_days * 86400_000
			: null;

		const policyJson = JSON.stringify(req.policy);

		const rl = req.rate_limit;
		this.sql.exec(
			`INSERT INTO api_keys (id, name, zone_id, created_at, expires_at, revoked, bulk_rate, bulk_bucket, single_rate, single_bucket, policy, created_by)
			 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
			id,
			req.name,
			req.zone_id,
			now,
			expiresAt,
			rl?.bulk_rate ?? null,
			rl?.bulk_bucket ?? null,
			rl?.single_rate ?? null,
			rl?.single_bucket ?? null,
			policyJson,
			req.created_by ?? null,
		);

		const key: ApiKey = {
			id,
			name: req.name,
			zone_id: req.zone_id,
			created_at: now,
			expires_at: expiresAt,
			revoked: 0,
			policy: policyJson,
			created_by: req.created_by ?? null,
			bulk_rate: rl?.bulk_rate ?? null,
			bulk_bucket: rl?.bulk_bucket ?? null,
			single_rate: rl?.single_rate ?? null,
			single_bucket: rl?.single_bucket ?? null,
		};

		return { key };
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

	/** Get a single key with its scopes (for backward compat in API responses). */
	getKey(id: string): { key: ApiKey; scopes: KeyScope[] } | null {
		const rows = queryAll<ApiKey>(this.sql, 'SELECT * FROM api_keys WHERE id = ?', id);
		if (rows.length === 0) return null;

		const scopes = queryAll<KeyScope>(this.sql, 'SELECT * FROM key_scopes WHERE key_id = ?', id);

		return { key: rows[0], scopes };
	}

	/** Soft-revoke a key. */
	revokeKey(id: string): boolean {
		const result = this.sql.exec(
			'UPDATE api_keys SET revoked = 1 WHERE id = ? AND revoked = 0',
			id,
		);
		this.cache.delete(id);
		return result.rowsWritten > 0;
	}

	// ─── Authorization ──────────────────────────────────────────────────

	/**
	 * v2 authorization: evaluate the key's policy against request contexts.
	 * This is the primary authorization path going forward.
	 */
	authorizeV2(keyId: string, zoneId: string, contexts: RequestContext[]): AuthResult {
		const cached = this.getCachedOrLoad(keyId);
		if (!cached) {
			return { authorized: false, error: 'Invalid API key' };
		}

		const { key, resolvedPolicy } = cached;

		if (key.revoked) {
			return { authorized: false, error: 'API key has been revoked' };
		}

		if (key.expires_at && key.expires_at < Date.now()) {
			return { authorized: false, error: 'API key has expired' };
		}

		if (key.zone_id !== zoneId) {
			return { authorized: false, error: 'API key is not authorized for this zone' };
		}

		if (!evaluatePolicy(resolvedPolicy, contexts)) {
			// Find which contexts were denied — format for backward-compatible error messages
			const denied: string[] = [];
			for (const ctx of contexts) {
				if (!evaluatePolicy(resolvedPolicy, [ctx])) {
					denied.push(formatDeniedContext(ctx));
				}
			}
			return {
				authorized: false,
				error: `Key does not have scope for: ${denied.join(', ')}`,
				denied,
			};
		}

		return { authorized: true };
	}

	/**
	 * v1 authorization (backward compatible).
	 * Delegates to v2 by converting the purge body to request contexts.
	 */
	authorize(keyId: string, zoneId: string, body: PurgeBody): AuthResult {
		const contexts = purgeBodyToContexts(body, zoneId);
		return this.authorizeV2(keyId, zoneId, contexts);
	}

	// ─── Private helpers ────────────────────────────────────────────────

	private getCachedOrLoad(keyId: string): CachedKey | null {
		const cached = this.cache.get(keyId);
		if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
			return cached;
		}

		const loaded = this.getKey(keyId);
		if (!loaded) {
			this.cache.delete(keyId);
			return null;
		}

		// Resolve policy: prefer stored policy, fall back to migrating v1 scopes
		let resolvedPolicy: PolicyDocument;
		if (loaded.key.policy) {
			try {
				resolvedPolicy = JSON.parse(loaded.key.policy) as PolicyDocument;
			} catch {
				// Corrupt policy JSON — fall back to v1 scopes
				resolvedPolicy = migrateV1Scopes(loaded.scopes, loaded.key.zone_id);
			}
		} else {
			// No policy stored — migrate from v1 scopes
			resolvedPolicy = migrateV1Scopes(loaded.scopes, loaded.key.zone_id);
		}

		const entry: CachedKey = {
			key: loaded.key,
			scopes: loaded.scopes,
			resolvedPolicy,
			cachedAt: Date.now(),
		};
		this.cache.set(keyId, entry);
		return entry;
	}

	private generateKeyId(): string {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		const hex = Array.from(bytes)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		return `${KEY_PREFIX}${hex}`;
	}
}

/**
 * Format a denied RequestContext into a human-readable string.
 * Backward compatible with v1 denied format:
 *   purge:url → the URL string
 *   purge:host → "host:<hostname>"
 *   purge:tag → "tag:<tag>"
 *   purge:prefix → "prefix:<prefix>"
 *   purge:everything → "purge_everything"
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
// Converts a v1 PurgeBody into v2 RequestContext[] for policy evaluation.

export function purgeBodyToContexts(body: PurgeBody, zoneId: string): RequestContext[] {
	const resource = `zone:${zoneId}`;
	const contexts: RequestContext[] = [];

	if (body.purge_everything) {
		contexts.push({
			action: 'purge:everything',
			resource,
			fields: { purge_everything: true },
		});
		return contexts;
	}

	if (body.files) {
		for (const file of body.files) {
			const url = typeof file === 'string' ? file : file.url;
			const headers = typeof file === 'object' && file.headers ? file.headers : {};

			const fields: Record<string, string | boolean> = { url };

			// Parse URL components for condition evaluation
			try {
				const parsed = new URL(url);
				fields.host = parsed.hostname;
				fields['url.path'] = parsed.pathname;
				if (parsed.search) {
					fields['url.query'] = parsed.search.slice(1); // remove leading ?
					for (const [k, v] of parsed.searchParams) {
						fields[`url.query.${k}`] = v;
					}
				}
			} catch {
				// Invalid URL — still include raw url field
			}

			// Include headers as header.<name> fields
			for (const [name, value] of Object.entries(headers)) {
				fields[`header.${name}`] = value;
			}

			contexts.push({ action: 'purge:url', resource, fields });
		}
	}

	if (body.hosts) {
		for (const host of body.hosts) {
			contexts.push({
				action: 'purge:host',
				resource,
				fields: { host },
			});
		}
	}

	if (body.tags) {
		for (const tag of body.tags) {
			contexts.push({
				action: 'purge:tag',
				resource,
				fields: { tag },
			});
		}
	}

	if (body.prefixes) {
		for (const prefix of body.prefixes) {
			contexts.push({
				action: 'purge:prefix',
				resource,
				fields: { prefix },
			});
		}
	}

	return contexts;
}
