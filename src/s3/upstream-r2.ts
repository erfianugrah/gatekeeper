import { queryAll } from '../crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UpstreamR2 {
	id: string;
	name: string;
	/** Comma-separated bucket names, or "*" for all buckets. */
	bucket_names: string;
	access_key_preview: string;
	endpoint: string;
	created_at: number;
	created_by: string | null;
	revoked: number;
}

/** Full row including secrets — never expose via API. */
interface UpstreamR2Row extends UpstreamR2 {
	access_key_id: string;
	secret_access_key: string;
}

export interface CreateUpstreamR2Request {
	name: string;
	access_key_id: string;
	secret_access_key: string;
	endpoint: string;
	/** Bucket names this endpoint serves, or ["*"] for all. */
	bucket_names: string[];
	created_by?: string;
}

/** Resolved R2 credentials for signing. */
export interface R2Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	endpoint: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ID_PREFIX = 'upr2_';

// ─── Manager ────────────────────────────────────────────────────────────────

export class UpstreamR2Manager {
	private sql: SqlStorage;
	/** bucket -> credentials cache. Invalidated on write. */
	private resolveCache = new Map<string, { creds: R2Credentials; cachedAt: number }>();
	private cacheTtlMs: number;

	constructor(sql: SqlStorage, cacheTtlMs: number = 60_000) {
		this.sql = sql;
		this.cacheTtlMs = cacheTtlMs;
	}

	/** Create tables if they don't exist. Call inside blockConcurrencyWhile. */
	initTables(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS upstream_r2 (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				access_key_id TEXT NOT NULL,
				secret_access_key TEXT NOT NULL,
				access_key_preview TEXT NOT NULL,
				endpoint TEXT NOT NULL,
				bucket_names TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				created_by TEXT,
				revoked INTEGER NOT NULL DEFAULT 0
			);
		`);
	}

	// ─── CRUD ───────────────────────────────────────────────────────────

	/** Register a new upstream R2 endpoint. */
	createEndpoint(req: CreateUpstreamR2Request): { endpoint: UpstreamR2 } {
		const id = this.generateId();
		const now = Date.now();
		const bucketNamesStr = req.bucket_names.join(',');
		const preview = makePreview(req.access_key_id);

		this.sql.exec(
			`INSERT INTO upstream_r2 (id, name, access_key_id, secret_access_key, access_key_preview, endpoint, bucket_names, created_at, created_by, revoked)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
			id,
			req.name,
			req.access_key_id,
			req.secret_access_key,
			preview,
			req.endpoint,
			bucketNamesStr,
			now,
			req.created_by ?? null,
		);

		this.invalidateCache();

		return {
			endpoint: {
				id,
				name: req.name,
				bucket_names: bucketNamesStr,
				access_key_preview: preview,
				endpoint: req.endpoint,
				created_at: now,
				created_by: req.created_by ?? null,
				revoked: 0,
			},
		};
	}

	/** List all upstream R2 endpoints (never includes secrets). */
	listEndpoints(filter?: 'active' | 'revoked'): UpstreamR2[] {
		const conditions: string[] = [];
		const params: unknown[] = [];

		if (filter === 'active') {
			conditions.push('revoked = 0');
		} else if (filter === 'revoked') {
			conditions.push('revoked = 1');
		}

		const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
		return queryAll<UpstreamR2>(
			this.sql,
			`SELECT id, name, bucket_names, access_key_preview, endpoint, created_at, created_by, revoked FROM upstream_r2${where} ORDER BY created_at DESC`,
			...params,
		);
	}

	/** Get a single upstream R2 endpoint by ID (never includes secrets). */
	getEndpoint(id: string): { endpoint: UpstreamR2 } | null {
		const rows = queryAll<UpstreamR2>(
			this.sql,
			'SELECT id, name, bucket_names, access_key_preview, endpoint, created_at, created_by, revoked FROM upstream_r2 WHERE id = ?',
			id,
		);
		if (rows.length === 0) return null;
		return { endpoint: rows[0] };
	}

	/** Soft-revoke an upstream R2 endpoint. */
	revokeEndpoint(id: string): boolean {
		const result = this.sql.exec('UPDATE upstream_r2 SET revoked = 1 WHERE id = ? AND revoked = 0', id);
		if (result.rowsWritten > 0) {
			this.invalidateCache();
		}
		return result.rowsWritten > 0;
	}

	// ─── Resolution ─────────────────────────────────────────────────────

	/**
	 * Resolve the upstream R2 credentials for a given bucket name.
	 * Returns credentials if a matching active endpoint is found, null otherwise.
	 * Prefers exact bucket match over wildcard.
	 */
	resolveForBucket(bucket: string): R2Credentials | null {
		const cached = this.resolveCache.get(bucket);
		if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
			return cached.creds;
		}

		const rows = queryAll<UpstreamR2Row>(this.sql, 'SELECT * FROM upstream_r2 WHERE revoked = 0 ORDER BY created_at DESC');

		let wildcardCreds: R2Credentials | null = null;

		for (const row of rows) {
			const buckets = row.bucket_names.split(',');
			const creds: R2Credentials = {
				accessKeyId: row.access_key_id,
				secretAccessKey: row.secret_access_key,
				endpoint: row.endpoint,
			};
			if (buckets.includes(bucket)) {
				this.resolveCache.set(bucket, { creds, cachedAt: Date.now() });
				return creds;
			}
			if (buckets.includes('*') && !wildcardCreds) {
				wildcardCreds = creds;
			}
		}

		if (wildcardCreds) {
			this.resolveCache.set(bucket, { creds: wildcardCreds, cachedAt: Date.now() });
			return wildcardCreds;
		}

		return null;
	}

	/**
	 * Resolve R2 credentials for a ListBuckets request (no specific bucket).
	 * Returns the first active wildcard endpoint, or the first active endpoint.
	 */
	resolveForListBuckets(): R2Credentials | null {
		const rows = queryAll<UpstreamR2Row>(this.sql, 'SELECT * FROM upstream_r2 WHERE revoked = 0 ORDER BY created_at ASC');
		if (rows.length === 0) return null;

		// Prefer wildcard
		for (const row of rows) {
			if (row.bucket_names.split(',').includes('*')) {
				return { accessKeyId: row.access_key_id, secretAccessKey: row.secret_access_key, endpoint: row.endpoint };
			}
		}
		// Fallback to first registered
		const row = rows[0];
		return { accessKeyId: row.access_key_id, secretAccessKey: row.secret_access_key, endpoint: row.endpoint };
	}

	// ─── Private helpers ────────────────────────────────────────────────

	private invalidateCache(): void {
		this.resolveCache.clear();
	}

	private generateId(): string {
		const bytes = new Uint8Array(12);
		crypto.getRandomValues(bytes);
		const hex = Array.from(bytes)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		return `${ID_PREFIX}${hex}`;
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a preview string: first 4 + "..." + last 4 chars. */
function makePreview(key: string): string {
	if (key.length <= 10) return '****';
	return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
