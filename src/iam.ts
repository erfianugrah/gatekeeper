import { evaluatePolicy } from './policy-engine';
import { queryAll } from './crypto';
import type { ApiKey, CachedKey, CreateKeyRequest, AuthResult, PurgeBody } from './types';
import type { PolicyDocument, RequestContext } from './policy-types';

/** Key prefix for all keys. */
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
	}

	// ─── Key creation ───────────────────────────────────────────────────

	/** Create a key with a policy document. */
	createKey(req: CreateKeyRequest): { key: ApiKey } {
		const id = this.generateKeyId();
		const now = Date.now();
		const expiresAt = req.expires_in_days ? now + req.expires_in_days * 86400_000 : null;

		const policyJson = JSON.stringify(req.policy);

		const rl = req.rate_limit;
		this.sql.exec(
			`INSERT INTO api_keys (id, name, zone_id, created_at, expires_at, revoked, bulk_rate, bulk_bucket, single_rate, single_bucket, policy, created_by)
			 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
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

	/** Get a single key. */
	getKey(id: string): { key: ApiKey } | null {
		const rows = queryAll<ApiKey>(this.sql, 'SELECT * FROM api_keys WHERE id = ?', id);
		if (rows.length === 0) return null;
		return { key: rows[0] };
	}

	/** Soft-revoke a key. */
	revokeKey(id: string): boolean {
		const result = this.sql.exec('UPDATE api_keys SET revoked = 1 WHERE id = ? AND revoked = 0', id);
		this.cache.delete(id);
		return result.rowsWritten > 0;
	}

	// ─── Authorization ──────────────────────────────────────────────────

	/** Evaluate the key's policy against request contexts. */
	authorize(keyId: string, zoneId: string, contexts: RequestContext[]): AuthResult {
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

		// If the key is scoped to a specific zone, enforce it
		if (key.zone_id && key.zone_id !== zoneId) {
			return { authorized: false, error: 'API key is not authorized for this zone' };
		}

		if (!evaluatePolicy(resolvedPolicy, contexts)) {
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
	 * Convenience: authorize from a PurgeBody (converts to RequestContext[] internally).
	 */
	authorizeFromBody(keyId: string, zoneId: string, body: PurgeBody): AuthResult {
		const contexts = purgeBodyToContexts(body, zoneId);
		return this.authorize(keyId, zoneId, contexts);
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

		let resolvedPolicy: PolicyDocument;
		try {
			resolvedPolicy = JSON.parse(loaded.key.policy) as PolicyDocument;
		} catch {
			// Corrupt policy JSON — deny everything
			resolvedPolicy = { version: '2025-01-01', statements: [] };
		}

		const entry: CachedKey = {
			key: loaded.key,
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
			contexts.push({ action: 'purge:host', resource, fields: { host } });
		}
	}

	if (body.tags) {
		for (const tag of body.tags) {
			contexts.push({ action: 'purge:tag', resource, fields: { tag } });
		}
	}

	if (body.prefixes) {
		for (const prefix of body.prefixes) {
			contexts.push({ action: 'purge:prefix', resource, fields: { prefix } });
		}
	}

	return contexts;
}
