import { queryAll } from '../sql';
import { DEFAULT_CACHE_TTL_MS } from '../constants';
import { generateHexId, makePreview } from '../crypto';
import type { BulkResult, BulkItemResult, BulkDryRunResult, BulkInspectItem } from '../types';

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

	constructor(sql: SqlStorage, cacheTtlMs: number = DEFAULT_CACHE_TTL_MS) {
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
				created_by TEXT
			);
		`);

		// Migration: remove vestigial "revoked" column from old schema.
		const cols = queryAll<{ name: string }>(this.sql, `PRAGMA table_info('upstream_r2')`);
		if (cols.some((c) => c.name === 'revoked')) {
			console.log(JSON.stringify({ migration: 'upstream_r2', action: 'drop_column_revoked', ts: new Date().toISOString() }));
			this.sql.exec(`ALTER TABLE upstream_r2 DROP COLUMN revoked`);
		}
	}

	// ─── CRUD ───────────────────────────────────────────────────────────

	/** Register a new upstream R2 endpoint. */
	createEndpoint(req: CreateUpstreamR2Request): { endpoint: UpstreamR2 } {
		const id = this.generateId();
		const now = Date.now();
		const bucketNamesStr = req.bucket_names.join(',');
		const preview = makePreview(req.access_key_id);

		this.sql.exec(
			`INSERT INTO upstream_r2 (id, name, access_key_id, secret_access_key, access_key_preview, endpoint, bucket_names, created_at, created_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			},
		};
	}

	/** List all upstream R2 endpoints (never includes secrets). */
	listEndpoints(): UpstreamR2[] {
		return queryAll<UpstreamR2>(
			this.sql,
			'SELECT id, name, bucket_names, access_key_preview, endpoint, created_at, created_by FROM upstream_r2 ORDER BY created_at DESC',
		);
	}

	/** Get a single upstream R2 endpoint by ID (never includes secrets). */
	getEndpoint(id: string): { endpoint: UpstreamR2 } | null {
		const rows = queryAll<UpstreamR2>(
			this.sql,
			'SELECT id, name, bucket_names, access_key_preview, endpoint, created_at, created_by FROM upstream_r2 WHERE id = ?',
			id,
		);
		if (rows.length === 0) return null;
		return { endpoint: rows[0] };
	}

	/** Permanently delete an upstream R2 endpoint. Returns true if the row existed and was removed. */
	deleteEndpoint(id: string): boolean {
		const result = this.sql.exec('DELETE FROM upstream_r2 WHERE id = ?', id);
		if (result.rowsWritten > 0) {
			this.invalidateCache();
		}
		return result.rowsWritten > 0;
	}

	// ─── Bulk operations ────────────────────────────────────────────────

	/** Bulk hard-delete endpoints. Returns per-item status. */
	bulkDelete(ids: string[]): BulkResult {
		const results: BulkItemResult[] = [];
		for (const id of ids) {
			const deleted = this.deleteEndpoint(id);
			results.push({ id, status: deleted ? 'deleted' : 'not_found' });
		}
		return { processed: results.length, results };
	}

	/** Inspect endpoints without modifying — for dry-run preview. */
	bulkInspect(ids: string[], wouldBecome: string): BulkDryRunResult {
		const items: BulkInspectItem[] = [];
		for (const id of ids) {
			const existing = this.getEndpoint(id);
			if (!existing) {
				items.push({ id, current_status: 'not_found', would_become: 'not_found' });
			} else {
				items.push({ id, current_status: 'active', would_become: wouldBecome });
			}
		}
		return { dry_run: true, would_process: items.length, items };
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
			console.log(JSON.stringify({ breadcrumb: 'upstream-r2-cache-hit', bucket }));
			return cached.creds;
		}

		const rows = queryAll<UpstreamR2Row>(this.sql, 'SELECT * FROM upstream_r2 ORDER BY created_at DESC');

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
				console.log(JSON.stringify({ breadcrumb: 'upstream-r2-exact-match', bucket, endpointId: row.id }));
				return creds;
			}
			if (buckets.includes('*') && !wildcardCreds) {
				wildcardCreds = creds;
			}
		}

		if (wildcardCreds) {
			this.resolveCache.set(bucket, { creds: wildcardCreds, cachedAt: Date.now() });
			console.log(JSON.stringify({ breadcrumb: 'upstream-r2-wildcard-match', bucket }));
			return wildcardCreds;
		}

		console.log(JSON.stringify({ breadcrumb: 'upstream-r2-not-found', bucket, totalEndpoints: rows.length }));
		return null;
	}

	/**
	 * Resolve R2 credentials for a ListBuckets request (no specific bucket).
	 * Returns the first active wildcard endpoint, or the first active endpoint.
	 */
	resolveForListBuckets(): R2Credentials | null {
		const rows = queryAll<UpstreamR2Row>(this.sql, 'SELECT * FROM upstream_r2 ORDER BY created_at DESC');
		if (rows.length === 0) {
			console.log(JSON.stringify({ breadcrumb: 'upstream-r2-list-buckets-none' }));
			return null;
		}

		// Prefer wildcard (newest first, consistent with resolveForBucket)
		for (const row of rows) {
			if (row.bucket_names.split(',').includes('*')) {
				console.log(JSON.stringify({ breadcrumb: 'upstream-r2-list-buckets-wildcard', endpointId: row.id }));
				return { accessKeyId: row.access_key_id, secretAccessKey: row.secret_access_key, endpoint: row.endpoint };
			}
		}
		// Fallback to newest registered
		const row = rows[0];
		console.log(JSON.stringify({ breadcrumb: 'upstream-r2-list-buckets-fallback', endpointId: row.id }));
		return { accessKeyId: row.access_key_id, secretAccessKey: row.secret_access_key, endpoint: row.endpoint };
	}

	// ─── Private helpers ────────────────────────────────────────────────

	private invalidateCache(): void {
		this.resolveCache.clear();
	}

	private generateId(): string {
		return generateHexId(ID_PREFIX, 12);
	}
}
